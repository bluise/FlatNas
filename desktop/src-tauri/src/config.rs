//! 配置读写：存在系统配置目录下的 config.json。
//!
//! 只做「读取 / 校正 / 保存」，不含任何 UI 或网络逻辑，方便用 `cargo test` 直接测。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    // 连接
    pub base_url: String,
    pub username: String,
    /// 登录后缓存的 JWT（30 天有效）
    pub token: String,
    /// 仅当用户勾选「记住密码」时才写入
    pub password: String,
    pub remember_password: bool,
    pub widget_id: String,
    pub interval_ms: u64,

    // 窗口外观
    pub always_on_top: bool,
    pub skip_taskbar: bool,
    pub click_through: bool,
    pub opacity: f64,
    pub card_color: String,
    pub text_color: String,
    pub accent_color: String,
    pub font_size: f64,
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,

    // 行为
    pub launch_at_login: bool,
    pub show_done: bool,
    pub confirm_delete: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            username: "admin".into(),
            token: String::new(),
            password: String::new(),
            remember_password: false,
            widget_id: String::new(),
            interval_ms: 10_000,
            always_on_top: true,
            skip_taskbar: true,
            click_through: false,
            opacity: 0.85,
            card_color: "#111827".into(),
            text_color: "#f9fafb".into(),
            accent_color: "#3b82f6".into(),
            font_size: 14.0,
            width: 320.0,
            height: 440.0,
            x: None,
            y: None,
            launch_at_login: false,
            show_done: true,
            confirm_delete: false,
        }
    }
}

fn clamp(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

impl AppConfig {
    /// 校正越界/非法值，保证 UI 拿到的一定是可用配置。
    pub fn sanitize(mut self) -> Self {
        self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
        if self.username.trim().is_empty() {
            self.username = "admin".into();
        }
        if !self.remember_password {
            self.password.clear();
        }
        self.interval_ms = self.interval_ms.clamp(3_000, 3_600_000);
        self.opacity = clamp(self.opacity, 0.15, 1.0, 0.85);
        self.font_size = clamp(self.font_size, 10.0, 28.0, 14.0);
        self.width = clamp(self.width, 220.0, 1200.0, 320.0);
        self.height = clamp(self.height, 180.0, 1600.0, 440.0);
        self.x = self.x.filter(|v| v.is_finite());
        self.y = self.y.filter(|v| v.is_finite());
        self
    }

    pub fn config_path(dir: &Path) -> PathBuf {
        dir.join("config.json")
    }

    /// 读取配置；文件不存在或损坏时回落到默认值。
    pub fn load(dir: &Path) -> Self {
        let path = Self::config_path(dir);
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<AppConfig>(&text)
                .unwrap_or_default()
                .sanitize(),
            Err(_) => AppConfig::default().sanitize(),
        }
    }

    /// 原子写入（临时文件 + rename）。
    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let path = Self::config_path(dir);
        let tmp = dir.join("config.json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self).unwrap_or_default())?;
        std::fs::rename(&tmp, &path)
    }

    /// 用 JSON patch 合并字段（只覆盖出现过的键）。
    pub fn apply_patch(&mut self, patch: &serde_json::Value) {
        let serde_json::Value::Object(map) = patch else {
            return;
        };
        let mut base = serde_json::to_value(&*self).unwrap_or_default();
        if let serde_json::Value::Object(ref mut base_map) = base {
            for (k, v) in map {
                if base_map.contains_key(k) {
                    base_map.insert(k.clone(), v.clone());
                }
            }
        }
        if let Ok(next) = serde_json::from_value::<AppConfig>(base) {
            *self = next.sanitize();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flatnas-cfg-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn defaults_are_sane() {
        let cfg = AppConfig::default().sanitize();
        assert_eq!(cfg.base_url, "");
        assert_eq!(cfg.username, "admin");
        assert_eq!(cfg.interval_ms, 10_000);
        assert!(cfg.always_on_top);
        assert!(cfg.skip_taskbar);
        assert!(!cfg.click_through);
    }

    #[test]
    fn out_of_range_values_are_clamped() {
        let cfg = AppConfig {
            opacity: 9.0,
            font_size: 999.0,
            interval_ms: 1,
            width: 5.0,
            height: 99999.0,
            ..Default::default()
        }
        .sanitize();
        assert_eq!(cfg.opacity, 1.0);
        assert_eq!(cfg.font_size, 28.0);
        assert_eq!(cfg.interval_ms, 3_000);
        assert_eq!(cfg.width, 220.0);
        assert_eq!(cfg.height, 1600.0);
    }

    #[test]
    fn trailing_slash_and_blank_username_fixed() {
        let cfg = AppConfig {
            base_url: "  http://nas:23000/  ".into(),
            username: "   ".into(),
            ..Default::default()
        }
        .sanitize();
        assert_eq!(cfg.base_url, "http://nas:23000");
        assert_eq!(cfg.username, "admin");
    }

    #[test]
    fn password_dropped_when_not_remembered() {
        let cfg = AppConfig {
            password: "secret".into(),
            remember_password: false,
            ..Default::default()
        }
        .sanitize();
        assert_eq!(cfg.password, "");
    }

    #[test]
    fn save_then_load_roundtrip() {
        let dir = temp_dir("roundtrip");
        let cfg = AppConfig {
            base_url: "http://nas:23000".into(),
            widget_id: "w8".into(),
            opacity: 0.42,
            remember_password: true,
            password: "pw".into(),
            ..Default::default()
        }
        .sanitize();
        cfg.save(&dir).expect("save");
        let back = AppConfig::load(&dir);
        assert_eq!(back.base_url, "http://nas:23000");
        assert_eq!(back.widget_id, "w8");
        assert_eq!(back.opacity, 0.42);
        assert_eq!(back.password, "pw");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_file_falls_back_to_defaults() {
        let dir = temp_dir("broken");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(AppConfig::config_path(&dir), "{ 不是 json").unwrap();
        let cfg = AppConfig::load(&dir);
        assert_eq!(cfg.username, "admin");
        assert_eq!(cfg.opacity, 0.85);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn patch_only_overrides_present_keys() {
        let mut cfg = AppConfig {
            base_url: "http://a:1".into(),
            font_size: 16.0,
            ..Default::default()
        }
        .sanitize();
        cfg.apply_patch(&serde_json::json!({ "font_size": 20.0, "不存在的键": 1 }));
        assert_eq!(cfg.font_size, 20.0);
        assert_eq!(cfg.base_url, "http://a:1", "未出现的键保持不变");
    }
}
