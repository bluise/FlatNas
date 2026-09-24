# FlatNas 待办 · Windows 桌面小插件

贴在桌面上的待办小卡片（类似敬业签），**与 FlatNas 的「待办事项」组件双向同步**。
无边框 + 背景透明 + 可调透明度/配色/字号，常驻托盘，不占任务栏。

> **体积**：安装包约 **5 MB**（Electron 版是 88 MB）。
> 用 [Tauri 2](https://tauri.app/) 外壳 + Windows 自带的 WebView2，因此不需要打包 Chromium。

```
┌───────────────────────────────┐
│ ● 待办            3 / 7  📌 ⚙ ✕ │   ← 拖动这里移动窗口
├───────────────────────────────┤
│ ☐ 买牛奶                    ✕ │
│ ☑ 交水电费                  ✕ │   ← 勾选/删除立即同步到 NAS
│ ☐ 给车做保养                 ✕ │
├───────────────────────────────┤
│ [ 添加待办，回车确认…    ] ＋ │
└───────────────────────────────┘
   卡片外完全透明；透明度/配色/字号都能调
```

---

## 架构（为什么这么小）

| 层 | 技术 | 职责 |
|---|---|---|
| 外壳 | **Rust + Tauri 2** | 无边框透明窗口、托盘、全局快捷键、开机自启、配置落盘、带鉴权的 HTTP 通道 |
| 界面 | 原生 HTML/CSS/JS（无框架、无打包器） | 卡片 UI、设置窗口 |
| 同步逻辑 | `src/lib/*.js` | 协议、乐观锁重试、本地优先策略（有 node:test 单测） |

两点设计取舍：

- **HTTP 走 Rust**（`ureq`）：既没有跨域问题，token 也不进网页层；前端只是把 `fetch` 适配到一条 Tauri 命令上。
- **业务逻辑留在 JS**：这部分是之前修 bug 的重点，留在 JS 里可以继续用 `node --test` 覆盖（20 个用例），
  改成 Rust 反而增大风险。Rust 侧只有配置模块有单测（7 个用例）。

---

## 功能

**与 FlatNas 同步**

- 直接对接 `/api/widgets/:id`，和网页端是**同一份待办**
- 勾选、删除、新增、编辑文字：本地即时生效 + 后台同步
- **本地优先**：有未上传的改动时，远端不会覆盖本地（不会"刚删掉的又冒出来"）
- 离线可用：改动留在本地并退避重试，恢复后自动补传
- 服务端 409（版本冲突）自动带 `currentVersion` 重试一次
- token 过期（30 天）时，勾了「记住密码」会静默重登

**窗口外观**

- 无边框、**背景透明**（窗口外完全透明），背景不透明度 15%~100%，文字始终不透明保证可读
- 背景色 / 文字色 / 强调色、字号 10~28px、窗口宽高，位置大小自动记忆

**行为**

- 置顶显示、隐藏任务栏图标、**鼠标穿透**（`Ctrl+Alt+L` 切换）
- 双击文字就地编辑；可开关「显示已完成」「删除前确认」
- 托盘菜单：显示/隐藏、立即同步、设置、切换开机自启、退出
- 关窗只隐藏（托盘常驻）

---

## 开发运行

需要 Node 22+ 与 **Rust 1.77+**；Windows 上还需要
[WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win10/11 一般已自带）。

```bash
cd desktop
npm install
npm run dev                    # 开发模式
npm test                       # 前端逻辑单测（20 个）
cd src-tauri && cargo test     # Rust 配置模块单测（7 个）
```

## 打包 exe

```bash
cd desktop
npm run build      # 产物在 src-tauri/target/release/bundle/nsis/
```

也可以到 GitHub Actions 手动触发：
[Build Desktop Widget (Windows)](https://github.com/bluise/FlatNas/actions/workflows/desktop-build.yml)
—— 产物在该次运行的 Artifacts 里；打 `desktop-*` tag 会自动构建并挂到 Release。

---

## 首次使用

启动后点右上角 **⚙**：

1. **服务器地址**：如 `http://192.168.1.10:23000`
2. **用户名 / 密码**：FlatNas 登录账号（默认 `admin` / `admin`）
3. 勾选 **记住密码**（否则关掉应用后需要重新登录）
4. 点 **测试连接** → 自动列出所有待办组件
5. 选中要关联的待办组件 → **保存并同步**

---

## 配置项

存放在 `%APPDATA%\icu.flatnas.desktop\config.json`：

| 键 | 默认 | 说明 |
|---|---|---|
| `base_url` | 空 | FlatNas 地址 |
| `username` / `password` / `remember_password` | `admin` / 空 / `false` | 账号；不勾「记住密码」时密码不落盘 |
| `token` | 空 | 登录后缓存的 JWT（30 天） |
| `widget_id` | 空 | 关联的待办组件 id |
| `interval_ms` | `10000` | 无改动时的拉取间隔（最小 3000） |
| `opacity` | `0.85` | 背景不透明度 0.15~1 |
| `card_color` / `text_color` / `accent_color` | `#111827` / `#f9fafb` / `#3b82f6` | 配色 |
| `font_size` | `14` | 字号 px |
| `width` / `height` / `x` / `y` | `320` / `440` / 自动 | 窗口几何（自动记忆） |
| `always_on_top` / `skip_taskbar` / `click_through` | `true` / `true` / `false` | 窗口行为 |
| `show_done` / `confirm_delete` | `true` / `false` | 列表行为 |

---

## 接口对接说明

| 用途 | 接口 |
|---|---|
| 登录拿 token | `POST /api/login` → `{ token, username }` |
| 取全局数据版本 | `GET /api/version` → `{ version }` |
| 读待办 | `GET /api/widgets/:id`（需 `Authorization`） |
| 写待办 | `PUT /api/widgets/:id`，body `{ data, enable, version }` |
| 列出待办组件 | `GET /api/data` → `widgets[]` 里 `type === 'todo'` |

两个踩过的坑：

- `PUT` 必须带全局 `version` 做乐观锁；不匹配返回 409 并给出 `currentVersion`，客户端用该值重试一次。
- **不要发 `widgetVersion`**：后端只在字段存在时校验它，而 `GET /api/widgets/:id` 不返回该字段，
  发一个过期值会永远 409。

---

## 排错

| 现象 | 处理 |
|---|---|
| 窗口空白 / 未配置 | 点 ⚙ 填地址并选待办组件 |
| 连接失败 | 确认能 ping 通 NAS、端口是不是 `23000` |
| 一直「离线」 | 地址或密码变了；用设置里的「测试连接」看具体报错 |
| 点了没反应 | 可能开了鼠标穿透，按 `Ctrl+Alt+L` 或从托盘菜单关掉 |
| 托盘没图标 | 少见；不影响主窗口使用 |
| 开机自启无效 | 需要打包后的程序；`npm run dev` 模式不注册 |

---

## 目录结构

```
desktop/
├── src/                      前端（Tauri frontendDist，纯静态）
│   ├── index.html/css/js       小插件主界面
│   ├── settings.html/css/js    设置窗口
│   ├── bridge.js               Tauri 桥接：fetch 适配 / 配置 / 窗口
│   └── lib/
│       ├── flatnas-client.js    HTTP 协议层（登录、读写、409 重试）
│       └── todo-sync.js         同步引擎（本地优先、退避重试）
├── src-tauri/                Rust 外壳
│   ├── src/main.rs             窗口 / 托盘 / 快捷键 / 命令
│   ├── src/config.rs           配置读写 + 单测
│   ├── tauri.conf.json         窗口与打包配置
│   ├── capabilities/           权限白名单
│   └── icons/                  图标（可用 tools 重新生成）
├── test/                     node:test 单测
└── tools/make-icons.mjs      零依赖生成 png/ico
```

## 许可

AGPL-3.0（与 FlatNas 主项目一致）。
