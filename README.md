# FlatNas

[![GitHub](https://img.shields.io/badge/GitHub-FlatNas-181717?style=flat&logo=github&logoColor=white)](https://github.com/bluise/FlatNas)
[![Upstream](https://img.shields.io/badge/Upstream-Garry--QD%2FFlatNas-6e6e6e?style=flat&logo=github&logoColor=white)](https://github.com/Garry-QD/FlatNas)
[![Docker Image](https://img.shields.io/badge/Docker-bluise1%2Fflatnas-2496ED?style=flat&logo=docker&logoColor=white)](https://hub.docker.com/r/bluise1/flatnas)

> **关于本仓库**
> 这是 [Garry-QD/FlatNas](https://github.com/Garry-QD/FlatNas)（AGPL-3.0）的个人构建版本，版本号 `1.6.1`，
> 额外包含**待办事项与备忘录的数据一致性修复**（丢内容、"已删除的又冒出来" 等问题），详见 [修复说明](#本版修复内容)。
> 预构建镜像：`bluise1/flatnas:latest` / `bluise1/flatnas:1.6.1`（支持 amd64 / arm64 / armv7）。

FlatNas 是一个轻量级、高度可定制的个人导航页与仪表盘系统。它基于 Vue 3 与 Go(Gin) 构建，旨在为 NAS 用户、极客和开发者提供一个优雅的浏览器起始页。
交流QQ群:613835409
![debian/1.png](public/1.png)
![debian/7.png](public/7.png)
![debian/9.png](public/9.png)

### ✨ 功能概览

- **多端统一入口**: 把常用网站、内网服务和工具聚合在同一仪表盘。
- **文件与媒体能力**: 内置文件传输助手、音乐播放器和壁纸管理。
- **内外网智能切换**: 自动识别网络环境并路由到最佳地址。
- **本地数据可控**: 配置与数据存储在本地目录，迁移与备份更方便。
- **可视化组件生态**: 内置多种组件，支持自定义 CSS/JS 深度扩展。
- **资源内存占用极低**: NAS端占用100MB内存，访问端真实内存占用不到80兆。
- **支持docker管理**: 内置docker管理组件，支持查看、启动、停止、重启docker容器、升级镜像等。

### 🖥️ 仪表盘与布局

- **网格布局**: 自由拖拽布局，支持不同尺寸的组件。
- **分组管理**: 支持创建多个分组，分类管理应用和书签。
- **响应式设计**: 完美适配桌面端和移动端访问。
- **编辑模式**: 直观的所见即所得编辑体验，轻松添加、删除和重新排列组件。

### 🧩 丰富的小组件

FlatNas 内置了多种实用的小组件，满足日常需求：
![tools.png](public/tools.png)

- **文件传输助手**: 强大的跨设备传输工具。支持发送文本、文件与图片；支持断点续传、大文件上传；提供专属**图片**视图，自动归类并预览所有图片文件。
- **书签组件**: 快速访问常用网站，支持自定义图标。首次启动时会自动填充常用的 10 个网站（如 GitHub, Bilibili 等）。
- **时钟与天气**: 实时显示当前时间、日期及当地天气情况。
- **高德地图组件**: 支持添加高德地图组件，显示当前位置及地图导航。
- **待办事项 (Todo)**: 简单的任务管理，随时记录灵感和待办。
- **RSS 订阅**: 内置 RSS 阅读器，实时获取订阅源的最新内容。
- **热搜榜单**: 集成微博热搜、新闻热榜等，不错过即时热点。
- **计算器**: 随时可用的简易计算器。
- **音乐播放器**: 内置 MiniPlayer，支持播放服务器端的本地音乐文件。
- **Docker管理**: 内置docker管理组件，支持查看、启动、停止、重启docker容器、升级镜像等。
- **系统监控**: 内置系统监控组件，支持查看CPU、内存、磁盘、网络等系统信息。
- **iframe组件**: 支持嵌入外部网页，如视频、地图等。
- **自定义组件**: 支持添加自定义 HTML 组件，实现更多功能。
- **道理鱼组件**: 支持添加道理鱼音乐组件。
  ![高德天气.png](public/高德天气.png)

### 🎨 个性化定制

FlatNas 提供了丰富的自定义选项，并自建了60000个图标的图标库，满足不同用户的需求：
![icon.png](public/icon.png)

- **自定义组件**: 支持添加自定义 HTML 组件，实现更多功能。
- **自定义CSS**: 支持添加自定义 CSS 样式，实现更多定制化效果。
- **自定义JS**: 支持添加自定义 JS 脚本，实现更多功能。
- **自定义HTML**: 支持添加自定义 HTML 代码，实现更多定制化效果。
- **天气组件**: 支持添加天气组件，显示当前天气情况。
- **图标管理**: 内置图标库，支持上传自定义图片，并全面支持 **Hex 颜色代码** (如 `#ffffff`) 自定义图标背景色。
- **背景设置**: 支持自定义壁纸。
- **分组卡片背景**: 支持在分组设置中统一配置该组所有卡片的背景（图片、模糊、遮罩），实现风格统一的视觉效果。
- **访客统计**: 底部页脚显示网站总访问量、今日访问量及当前在线时长（需在设置中开启）。
- **数据安全**:
  - 本地存储配置 (`server/data/data.json`)，数据完全掌握在自己手中。
  - 简单的密码访问保护（默认密码：`admin`），保护隐私配置。
- **更新提醒**: 内置版本检测功能，自动检查 GitHub 最新 Release 版本，并在设置面板提示 Docker 更新。
  ![自定义脚本.png](public/自定义脚本.png)

## 🌐 代理配置

FlatNas 支持通过后端代理转发请求，以解决内网服务无法直接访问外网资源的问题，或实现简单的隐私保护。

### 启用方法

1. **设置环境变量**
   在 `docker-compose.yml` 或启动命令中添加 `PROXY_URL` 环境变量。

   ```yaml
   environment:
     - PROXY_URL=http://127.0.0.1:7890
     # 支持协议：http, https, socks5, socks5h
     # 格式：protocol://[user:pass@]host:port
   ```

2. **前端开启**
   当环境变量配置正确后，在卡片编辑或万能窗口配置中，会显示“代理”开关。开启后，该组件的所有请求将通过 FlatNas 后端服务器代为转发。

### 调试与排查

- **开关不显示**：请检查后端日志，确认 `PROXY_URL` 格式正确且已生效。访问 `/api/config/proxy-status` 可查看当前代理可用状态。
- **请求失败**：
  - 检查 `PROXY_URL` 指向的代理服务器是否可达。
  - 检查目标 URL 是否触发了 SSRF 防护规则（如禁止访问 localhost）。
  - 查看后端日志 `[Proxy Error]` 获取详细错误信息。

## 🌐 智能网络环境检测

FlatNas 后端集成了智能网络环境识别功能，能够根据用户的访问来源自动切换内外网访问策略，完美解决混合网络环境下的访问难题。

- **多维度识别**: 结合 **客户端 IP**、**访问域名** 和 **网络延迟** 三个维度，精准判断用户当前所处的网络环境（局域网/互联网）。
- **自动路由**: 当检测到用户处于局域网（LAN）时，系统会自动优先使用配置的 **内网地址 (LanUrl)**，实现高速直连；在公网环境则自动切换至 **外网地址**。
- **无感切换**: 用户无需手动干预，无论是在家（内网）还是外出（外网），点击同一个图标即可自动跳转至最佳地址。

### 复杂网络环境部署

如果你的环境包含：

- DDNS / 公网直连
- Nginx / 宝塔反代
- Cloudflare 代理或 Cloudflare Tunnel
- FRP / 其他内网穿透
- 子路径部署，如 `/flatnas/`
- 前后端分离部署

请参考专门说明：[复杂网络环境部署](https://github.com/bluise/FlatNas#复杂网络环境部署)

## 🖥️ 桌面小插件（Windows）

`desktop/` 目录下是一个 Windows 桌面待办小插件（Tauri 2 + 系统 WebView2），类似敬业签。
安装包仅约 **1.7 MB**（免安装单文件版约 4.3 MB）：

- 无边框 + **背景透明**（透明度/配色/字号可调）、置顶显示、托盘常驻、关窗不退
- **与本项目的「待办事项」组件双向同步**（同一份数据），支持离线改动、断网重试、冲突重试
- 鼠标穿透（`Ctrl+Alt+L`）、开机自启、隐藏任务栏图标

从 [Releases](https://github.com/bluise/FlatNas/releases) 下载 `FlatNas-Desktop-Setup.exe` 直接安装即可。

```bash
cd desktop
npm install
npm run dev      # 开发运行
npm run build    # 打包 exe（需要 Rust 1.77+）
```

也可以从 [Actions](https://github.com/bluise/FlatNas/actions/workflows/desktop-build.yml) 手动触发
Windows 构建，产物在运行页面的 Artifacts 里下载。

详见 [desktop/README.md](desktop/README.md)。

## 📦 安装与部署

### 1. Debian/Ubuntu，一键部署

适用于 Debian/Ubuntu，无需 Docker，脚本会自动下载最新 Release 并完成部署。

```bash
wget -O deploy_debian.sh https://raw.githubusercontent.com/bluise/FlatNas/main/deploy_debian.sh
chmod +x deploy_debian.sh
sudo ./deploy_debian.sh
```

#### Debian/Ubuntu 管理面板（管理脚本）

部署完成后，使用管理脚本进行常用运维操作（查看状态、修改端口、配置 HTTPS、查看日志、卸载）。

```bash
wget -O manage.sh https://raw.githubusercontent.com/bluise/FlatNas/main/manage.sh
chmod +x manage.sh
sudo ./manage.sh
```

菜单功能说明：

- 查看服务状态：查看前后端端口、HTTPS 状态与服务运行情况
- 修改端口配置：修改前端端口与后端端口并自动重启服务
- 配置 HTTPS：写入证书并更新 Nginx 配置
- 查看实时日志：跟随服务日志
- 重启所有服务：重启 Nginx 与 FlatNas 服务
- 卸载服务：彻底卸载 FlatNas、配置与日志

#### Debian/Ubuntu 卸载（命令行）

如果需要卸载，也可以直接运行部署脚本并选择卸载模式，或运行管理脚本并选择"卸载服务"。

```bash
sudo ./deploy_debian.sh uninstall
# 或
sudo ./manage.sh
```

### 2. 本地安装（Release 包）

适用于已能访问服务器的场景，上传 Release 包内容后直接运行。

1. 从 GitHub Releases 下载对应架构的 `flatnas-amd64.zip` 或 `flatnas-arm64.zip`
2. 上传到服务器并解压到任意目录（例如 `/opt/flatnas`）
3. 进入解压目录并启动服务

```bash
cd /opt/flatnas
chmod +x flatnas-server
./flatnas-server
```

访问地址：`http://<服务器IP>:3000`

### 3. Docker CLI 部署

```bash
docker run -d \
  -p 23000:3000 \
  -v $(pwd)/data:/app/server/data \
  -v $(pwd)/doc:/app/server/doc \
  -v $(pwd)/music:/app/server/music \
  -v $(pwd)/PC:/app/server/PC \
  -v $(pwd)/APP:/app/server/APP \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --name flatnas \
  bluise1/flatnas:latest
```

### 4. Docker Compose 部署

```bash
version: '3.8'

services:
  flatnas:
    image: bluise1/flatnas:latest
    container_name: flatnas
    restart: unless-stopped
    ports:
      - '23000:3000'
    environment:
      - HOST=0.0.0.0
      - PORT=3000
      # 如需让后端自己识别子路径，可启用：
      # - BASE_PATH=/flatnas
    volumes:
      - ./data:/app/server/data
      - ./doc:/app/server/doc
      - ./music:/app/server/music
      - ./PC:/app/server/PC
      - ./APP:/app/server/APP
      - /var/run/docker.sock:/var/run/docker.sock
```

## ⚙️ 配置说明

- **默认密码**: 系统初始密码为 `admin`，请登录后在设置中及时修改。
- **数据文件**: 所有配置（布局、组件、书签等）均存储在 `server/data/data.json` 中。
- **音乐文件**: 将 MP3 文件放入 `server/music` 目录，刷新页面后即可在播放器中看到。
- **Docker 自动升级镜像**:
  - 入口：设置 → Docker 管理 → 自动升级镜像(每2小时)。
  - 关闭时：后台不会进行任何镜像拉取或版本对比。
  - 开启时：每 2 小时对运行中的容器执行“拉取并对比镜像 ID”，发现新版本则自动重建容器。
  - 镜像清理：升级完成后自动清理旧镜像，默认每个镜像名保留 2 个版本（可配置 1–20）。
  - 磁盘保护：当 Docker 所在磁盘可用空间低于阈值时跳过本轮升级，默认阈值 5GB（可配置）。
  - 监控指标：镜像数量、磁盘使用率、自动升级日志中的 pulls/updates/pruned/error 计数。
  - 升级后验证：开启开关等待一个周期（或手动触发一次更新检测），确认日志中 pulls/updates 变化且镜像数量不持续增长。
  - 灰度验证（建议）：准备 2 个环境分别开启/关闭该开关，各运行 24 小时，对比以下数据以确认“开关状态=后台行为”且无镜像堆积：
    - 服务器日志：筛选 `[AutoUpdate]` 与 `[UpdateChecker]` 关键字，统计 pulls/updates/pruned/error 次数与频率。
    - Docker 镜像数量：对比 24 小时前后 `docker images -q | wc -l`（Linux）或 `docker images -q | Measure-Object -Line`（PowerShell）。
    - Docker 根目录磁盘：对比 24 小时前后磁盘可用空间（或使用 `docker info` + 系统磁盘监控）。

### 🎨 全局自定义 CSS

在 **设置** -> **自定义 CSS** 中，您可以编写全局生效的 CSS 样式。

**增强语法：**
FlatNas 支持以下自定义标签，自动转换为媒体查询，方便响应式适配：

- `<mobile>...</mobile>`: 仅在移动端生效 (`max-width: 768px`)
- `<desktop>...</desktop>`: 仅在桌面端生效 (`min-width: 769px`)
- `<dark>...</dark>`: 仅在深色模式下生效
- `<light>...</light>`: 仅在浅色模式下生效

**示例:**

```css
/* 全局修改滚动条样式 */
::-webkit-scrollbar {
  width: 6px;
}

/* 仅在移动端隐藏侧边栏 */
<mobile>
.sidebar { display: none; }
</mobile>
```

### ⚡ 全局自定义 JS

在 **设置** -> **自定义 JS** 中，您可以注入 JavaScript 代码以实现高级交互或逻辑增强。
_注意：启用此功能需要同意安全免责声明。_

**运行环境 (Runtime Context):**

代码将在沙箱环境中运行，并提供 `ctx` 对象用于与系统交互。支持直接编写代码或导出生命周期钩子。

**生命周期钩子 (推荐):**

```javascript
// @module
// 必须使用 export default 导出钩子对象
export default {
  /**
   * 初始化时调用
   * @param {object} ctx - 上下文对象
   */
  init(ctx) {
    console.log("Custom JS Initialized");
    // 示例：监听事件
    ctx.on("widget-click", (e) => {
      console.log("Widget clicked:", e.detail);
    });
  },

  /**
   * 更新时调用 (如配置变更)
   */
  update(ctx) {
    console.log("Custom JS Updated");
  },

  /**
   * 销毁时调用 (清理资源)
   */
  destroy(ctx) {
    console.log("Custom JS Destroyed");
    // 清理定时器、事件监听等
  },
};
```

## 🔧 本版修复内容

相对上游 `1.2.6`，本构建（`1.6.1`）修复了待办与备忘录「丢内容、已删除的又冒出来」等一系列数据一致性问题：

**待办事项**

- 勾选完成状态此前只改内存副本、从不落盘 → 已写回并持久化
- 切回标签页 / 恢复网络时的强制刷新会用服务端旧数据覆盖本地，导致「刚删掉的条目又冒出来」→ 有未落盘改动时禁止远端覆盖
- localStorage 备份会把别处已删除的旧数据推回服务端 → 改为仅在确实离线时兜底
- 保存失败后没有重试 → 增加指数退避重试
- 多设备同时修改时静默「本地覆盖云端」→ 改为弹出冲突选择（保留本地 / 使用云端）

**备忘录**

- IndexedDB 旧缓存会在打开页面时被自动推回服务端（复活已删除内容）→ 改为纯缓存，仅未同步的本地改动才优先
- 409 冲突时曾自动重试并覆盖云端 → 改为冲突提示，由用户选择
- 自动保存会因「加载缓存 / 应用远端数据」而回声写盘 → 改为仅保存用户真实编辑
- 版本历史无上限 → 限制为最近 30 条

**服务端**

- memo 改动不会让 `/api/data` 的缓存与 ETag 失效，其他端在缓存有效期内一直读到旧备忘 → 改用文件指纹，多副本部署同样有效
- `/api/widgets/batch`、`/api/widgets/:id` 未用 memo 文件对齐，会把旧备忘推给客户端 → 已对齐
- 保存接口「读-改-写」非原子，并发保存互相覆盖 → 进程内互斥 + 跨进程文件锁
- WebSocket 广播乱序时旧消息覆盖新状态 → 增加单调递增序号，客户端丢弃迟到消息
- `GET /api/widgets/:id` 缺少鉴权，多用户下会读到 admin 的数据 → 已加鉴权
- 重置数据后旧备忘会被重新填回 → 已一并清理

## 📜 开源协议

本项目采用 [GNU AGPLv3](LICENSE) 协议开源。

---

Enjoy your FlatNas! 🚀
