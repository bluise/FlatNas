//! FlatNas 待办 · Windows 桌面小插件（Tauri 2 外壳）
//!
//! 设计：Rust 只做「没法在网页里做的部分」—— 无边框透明窗口、托盘、全局快捷键、
//! 开机自启、配置落盘，以及一个带鉴权头的 HTTP 通道（走 Rust 就没有跨域问题）。
//! 待办的业务逻辑（协议、乐观锁重试、同步策略）全部留在前端 JS 里，
//! 那部分有 node:test 单测覆盖，改动风险更低。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;

use config::AppConfig;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

const MAIN_WINDOW: &str = "main";
const SETTINGS_WINDOW: &str = "settings";

struct Ctx {
    config: Mutex<AppConfig>,
    config_dir: PathBuf,
}

// ---------------------------------------------------------------- HTTP 通道

#[derive(Serialize)]
struct HttpResp {
    status: u16,
    body: String,
}

fn do_http(
    method: &str,
    url: &str,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<HttpResp, String> {
    let request = match method.to_ascii_uppercase().as_str() {
        "POST" => ureq::post(url),
        "PUT" => ureq::put(url),
        "DELETE" => ureq::delete(url),
        _ => ureq::get(url),
    };
    let mut request = request.timeout(std::time::Duration::from_secs(15));
    for (key, value) in headers {
        request = request.set(&key, &value);
    }
    let result = match body {
        Some(text) => request.send_string(&text),
        None => request.call(),
    };
    match result {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.into_string().unwrap_or_default();
            Ok(HttpResp { status, body })
        }
        // 4xx/5xx 也用 Ok 返回，交给前端按状态码分类（401 失效 / 409 版本冲突）
        Err(ureq::Error::Status(status, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Ok(HttpResp { status, body })
        }
        Err(e) => Err(format!("网络请求失败: {e}")),
    }
}

/// 前端把 fetch 适配到这条命令上，因此 token 与跨域问题都不进网页层。
#[tauri::command]
async fn http_request(
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<HttpResp, String> {
    tauri::async_runtime::spawn_blocking(move || do_http(&method, &url, headers, body))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- 配置

#[tauri::command]
fn load_config(ctx: tauri::State<'_, Ctx>) -> AppConfig {
    ctx.config.lock().unwrap().clone()
}

#[tauri::command]
fn save_config(
    app: AppHandle,
    ctx: tauri::State<'_, Ctx>,
    patch: serde_json::Value,
) -> Result<AppConfig, String> {
    let next = {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.apply_patch(&patch);
        cfg.save(&ctx.config_dir).map_err(|e| e.to_string())?;
        cfg.clone()
    };
    apply_window_flags(&app, &next);
    let _ = app.emit("config-changed", &next);
    Ok(next)
}

// ---------------------------------------------------------------- 窗口

fn apply_window_flags(app: &AppHandle, cfg: &AppConfig) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        let _ = win.set_always_on_top(cfg.always_on_top);
        let _ = win.set_skip_taskbar(cfg.skip_taskbar);
        let _ = win.set_ignore_cursor_events(cfg.click_through);
    }
}

/// 保存主窗口的位置与尺寸，供下次启动还原。
fn persist_bounds(app: &AppHandle) {
    let Some(ctx) = app.try_state::<Ctx>() else { return };
    let Some(win) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let (Ok(size), Ok(pos)) = (win.inner_size(), win.outer_position()) else {
        return;
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    let mut cfg = ctx.config.lock().unwrap();
    cfg.width = (size.width as f64 / scale).round();
    cfg.height = (size.height as f64 / scale).round();
    cfg.x = Some(pos.x as f64 / scale);
    cfg.y = Some(pos.y as f64 / scale);
    let _ = cfg.save(&ctx.config_dir);
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        let _ = win.hide();
    }
}

#[tauri::command]
fn toggle_window(app: AppHandle) {
    toggle_main_window(&app);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn open_external(url: String) {
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = open_in_browser(&url);
    }
}

fn open_in_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(url).spawn()?;
    }
    Ok(())
}

fn open_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(SETTINGS_WINDOW) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App("settings.html".into()))
        .title("FlatNas 待办 · 设置")
        .inner_size(520.0, 720.0)
        .min_inner_size(460.0, 560.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    open_settings_window(&app)
}

// ---------------------------------------------------------------- 开机自启

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- 入口

/// 把前端 JS 需要的窗口/托盘动作都收敛到 Rust 命令里，
/// 网页层只拿到「调用命令」这一种能力，不做系统级操作。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit("toggle-click-through", ());
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            http_request,
            load_config,
            save_config,
            hide_window,
            toggle_window,
            quit_app,
            open_external,
            open_settings,
            set_autostart,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // 配置目录：%APPDATA%/icu.flatnas.desktop（失败则退回当前目录）
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let cfg = AppConfig::load(&config_dir);
            app.manage(Ctx {
                config: Mutex::new(cfg.clone()),
                config_dir,
            });

            // 还原窗口位置/尺寸并应用窗口标志
            if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
                let _ = win.set_size(tauri::LogicalSize::new(cfg.width, cfg.height));
                if let (Some(x), Some(y)) = (cfg.x, cfg.y) {
                    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
                }
            }
            apply_window_flags(&handle, &cfg);

            // 关窗只隐藏，托盘常驻；移动/缩放时记住位置
            if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
                let handle_for_events = handle.clone();
                win.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        if let Some(w) = handle_for_events.get_webview_window(MAIN_WINDOW) {
                            let _ = w.hide();
                        }
                    }
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                        persist_bounds(&handle_for_events);
                    }
                    _ => {}
                });
            }

            // 托盘
            let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
            let sync_now = MenuItem::with_id(app, "sync", "立即同步", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
            let autostart = MenuItem::with_id(app, "autostart", "切换开机自启", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[&toggle, &sync_now, &sep1, &settings, &autostart, &sep2, &quit],
            )?;

            let tray = TrayIconBuilder::with_id("flatnas-tray")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .tooltip("FlatNas 待办")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_main_window(app),
                    "sync" => {
                        let _ = app.emit("sync-now", ());
                    }
                    "settings" => {
                        let _ = open_settings_window(app);
                    }
                    "autostart" => {
                        use tauri_plugin_autostart::ManagerExt;
                        let manager = app.autolaunch();
                        let enabled = manager.is_enabled().unwrap_or(false);
                        let _ = if enabled { manager.disable() } else { manager.enable() };
                        let _ = app.emit("autostart-changed", !enabled);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app);
            // 某些 Linux 桌面没有系统托盘宿主，建成失败不该拖垮整个应用
            match tray {
                Ok(tray) => {
                    let _ = tray;
                }
                Err(e) => eprintln!("创建托盘失败（不影响主窗口）: {e}"),
            }

            // 全局快捷键：Ctrl+Alt+L 切换鼠标穿透
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyL);
            let _ = app.global_shortcut().register(shortcut);

            // 开机自启状态同步给前端
            {
                use tauri_plugin_autostart::ManagerExt;
                let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                let _ = handle.emit("autostart-changed", enabled);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 FlatNas 待办失败");
}

fn main() {
    run();
}
