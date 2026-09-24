# FlatNas 待办 · Windows 桌面小插件

贴在桌面上的待办小卡片（类似敬业签），**与 FlatNas 的「待办事项」组件双向同步**。
无边框 + 背景透明 + 可调透明度/配色/字号，常驻托盘，不占用任务栏。

```
┌───────────────────────────────┐
│ ● 待办            3 / 7   📌 ⚙ ✕ │   ← 拖动这里移动窗口
├───────────────────────────────┤
│ ☐ 买牛奶                   ✕ │
│ ☑ 交水电费                 ✕ │   ← 勾选/删除立即同步到 NAS
│ ☐ 给车做保养                ✕ │
├───────────────────────────────┤
│ [ 添加待办，回车确认…     ] ＋ │
└───────────────────────────────┘
   背景透明度、颜色、字号都能调；窗口外完全透明
```

---

## 功能

**与 FlatNas 同步**

- 数据直接对接 FlatNas 后端的 `/api/widgets/:id`，和网页端是**同一份待办**
- 勾选、删除、新增、编辑文字，改动**立即**上传；无改动时按设定间隔拉取
- **本地优先**：有未上传的改动时，远端数据不会覆盖本地（不会出现"刚删掉的又冒出来"）
- 离线也能用：改动留在本地并退避重试，恢复网络后自动补传
- 服务端 409（版本冲突）自动带服务端版本重试一次

**窗口外观**

- 无边框、**背景透明**（窗口外完全透明，只有中间那张卡片）
- 背景不透明度滑杆（15% ~ 100%，文字始终不透明保证可读）
- 背景色 / 文字色 / 强调色自定义
- 字号可调（10 ~ 28px）、窗口宽高可调、位置和大小自动记忆

**行为**

- 置顶显示、隐藏任务栏图标（只留托盘）
- **鼠标穿透**（点击透到下层窗口），快捷键 `Ctrl+Alt+L` 随时切换
- 双击文字就地编辑；可开关"显示已完成""删除前确认"
- 托盘菜单：显示/隐藏、立即同步、置顶、穿透、设置、开机自启、退出
- 单实例运行；关窗口不退出（缩到托盘）

**安全**

- 网络请求和 JWT 全部在**主进程**，渲染进程关闭 Node 集成、开启上下文隔离，
  只通过 preload 白名单 API 通信，页面里拿不到 token
- 密码用 Windows DPAPI（Electron `safeStorage`）加密后存本地，不落明文
- 渲染页面有 CSP，禁止远程脚本

---

## 运行（开发模式）

需要 Node.js 18+ 和 Windows。

```bash
cd flatnas-desktop
npm install
npm start
```

第一次启动窗口是空的，点右上角 **⚙** 打开设置：

1. **服务器地址**：填 FlatNas 的访问地址，例如 `http://192.168.1.10:23000`
2. **用户名 / 密码**：FlatNas 的登录账号（默认 `admin` / `admin`）
3. 点 **测试连接** → 会自动列出所有「待办」组件
4. 在 **待办组件** 下拉里选中要关联的那个
5. 点 **保存并同步** → 立刻开始同步

---

## 打包成 exe

```bash
npm run dist        # 生成 NSIS 安装包 + 免安装 portable 版
npm run pack        # 只生成免安装目录（调试用）
```

产物在 `dist/`：

- `FlatNas待办 Setup x.y.z.exe` —— 安装包（可改安装目录、建桌面快捷方式）
- `FlatNas待办 x.y.z.exe` —— 免安装单文件版

给应用换图标：替换 `assets/icon.png`（256×256）；想重新生成默认图标跑
`node tools/make-icons.js`（无需任何三方库）。

---

## 配置项

配置存在 `%APPDATA%/FlatNas待办/config.json`（Windows），键名与含义：

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | 空 | FlatNas 地址，如 `http://192.168.1.10:23000` |
| `username` / `password` | `admin` / 空 | 登录账号；密码加密存储 |
| `widgetId` | 空 | 关联的待办组件 id（设置里选） |
| `intervalMs` | `10000` | 无改动时的拉取间隔（毫秒，最小 3000） |
| `opacity` | `0.85` | 卡片背景不透明度 0.15~1 |
| `cardColor` / `textColor` / `accentColor` | `#111827` / `#f9fafb` / `#3b82f6` | 配色 |
| `fontSize` | `14` | 字号 px |
| `width` / `height` / `x` / `y` | `320` / `440` / null | 窗口尺寸与位置（自动记忆） |
| `alwaysOnTop` | `true` | 置顶 |
| `skipTaskbar` | `true` | 隐藏任务栏图标 |
| `clickThrough` | `false` | 鼠标穿透 |
| `showDone` | `true` | 显示已完成项 |
| `confirmDelete` | `false` | 删除前确认 |
| `launchAtLogin` | `false` | 开机自启 |

---

## 接口对接说明

插件用的是 FlatNas 后端已有接口，没有对服务端做任何特殊要求：

| 用途 | 接口 |
|---|---|
| 登录拿 token | `POST /api/login` → `{ token, username }`（有效期 30 天） |
| 取全局数据版本 | `GET /api/version` → `{ version }` |
| 读待办数据 | `GET /api/widgets/:id`（需 `Authorization`） |
| 写待办数据 | `PUT /api/widgets/:id`，body `{ data, enable, version }` |
| 列出待办组件 | `GET /api/data` → `widgets[]` 里 `type === 'todo'` |

两个实现细节（都是踩过坑的）：

- `PUT` 必须带全局 `version` 做乐观锁；不匹配返回 409 并给出 `currentVersion`，
  插件会用该值重试一次。
- **不要发 `widgetVersion` 字段**：后端只在字段存在时才校验它，而
  `GET /api/widgets/:id` 并不返回该字段，发一个过期值反而会永远 409。

---

## 自检 / 排错

```bash
npm test            # 26 个单测：API 客户端、同步引擎、配置读写
```

无头环境（CI）可以跑一次自检，确认窗口、preload 桥、渲染进程都正常：

```bash
# Windows
set FLATNAS_SMOKE_MS=1 && npm start
# Linux/macOS（需要 xvfb）
xvfb-run -a env FLATNAS_SMOKE_MS=1 FLATNAS_NO_TRANSPARENT=1 npx electron . --no-sandbox
```

看到 `[SMOKE] SMOKE_OK` 即通过，进程会自动退出。

**常见问题**

| 现象 | 处理 |
|---|---|
| 窗口空白/未配置 | 点 ⚙ 填地址并选待办组件 |
| 连接失败 | 确认能 ping 通 NAS，端口是不是 `23000`（Docker 映射端口） |
| 一直"离线" | 地址或密码变了；点设置里的「测试连接」看具体报错 |
| 勾选后网页端没变 | 看左上角圆点：蓝=同步中，橙=离线（改动已保留），红=出错 |
| 点了没反应 | 可能开了**鼠标穿透**，按 `Ctrl+Alt+L` 或从托盘菜单关掉 |
| 托盘没图标 | 部分 Linux 桌面无系统托盘宿主，不影响主窗口 |
| 开机自启无效 | 打包版才有意义；开发模式（`npm start`）不会注册 |

---

## 目录结构

```
flatnas-desktop/
├── main.js                    Electron 主进程：窗口/托盘/IPC/同步装配
├── preload.js                 contextBridge 白名单 API
├── src/
│   ├── flatnas-client.js      HTTP 客户端（登录/读/写/409 重试）
│   ├── todo-sync.js           同步引擎（本地优先、退避重试、乱序保护）
│   └── config.js              配置读写（密码加解密由外部注入）
├── renderer/
│   ├── index.html/css/js       小插件主界面
│   └── settings.html/css/js    设置窗口
├── assets/                    icon.png / tray.png（可用 tools 重新生成）
├── tools/make-icons.js        零依赖生成图标
└── test/                      node:test 单测
```

## 许可

AGPL-3.0（与 FlatNas 主项目一致）。
