# blueos-studio-skill

> BlueOS Studio（蓝河 Studio）与手表模拟器的命令行驱动工具集

在 Windows 上以命令行驱动运行中的 **BlueOS Studio** 与 **手表模拟器**，
完成新建工程、截屏、交互注入、设备切换、应用形态与卡片切换、错误检查、UI 巡检、
日志读取与构建打包，无需在 IDE 界面中操作。

本仓库同时是一个 **Agent Skill**：
根目录的 `SKILL.md` 即技能定义，可供支持 skill 机制的 Agent 直接加载。

---

## 特性

- **新建工程** —— 直接用 Studio 安装目录里随版本分发的 8 套官方模板（含表盘模板）
  生成工程，不必手点 IDE 的「新建工程」向导；应用名、包名、首选设备一次设定，
  依赖自动安装。**这一步不需要 Studio 在运行。**
- **原生分辨率截屏** —— 从 Studio 内部 WebSocket 通道获取模拟器推送的渲染帧，
  非屏幕抓取。不受窗口遮挡、最小化、锁屏影响，无需计算窗口坐标或裁切。
- **带手表外壳的截图** —— `shot --shell` 把裸帧套进设备外壳 PNG，输出带表壳／表圈的
  「整机照」（`--bg` 可填底色，默认四角透明）。素材见 `assets/shell/`。
  改完可跑 `scripts/selftest-composite.js` 离线自检。
- **零依赖** —— 六个脚本均为 CommonJS，不需要 `npm install`，Node.js ≥ 18 可直接运行。
  内置最小 WebSocket 客户端与最小 zip 解压实现，未使用任何第三方库。
- **完整的模拟器控制** —— 触摸（点击／滑动）、表冠旋转、按键、返回／首页、
  应用重启、设备与分辨率切换、页面跳转（push / replace）。
- **卡片（widget）预览** —— 列出工程里的卡片（标准卡 / 轻卡、尺寸、数据源），
  在「应用」与「快捷卡片」两种形态之间切换，并直接截走某张卡片的渲染结果。
  这是蓝河手表上「表盘左滑看到的一屏一卡」，与整屏应用是两套渲染。
- **批量逐页截图** —— 按 `.autorun` 配置自动逐页导航并各截一张图。
- **错误检查** —— 直接获取编译错误（含文件、行列号与代码帧）与模拟器实时运行时错误。
- **UI 元素树巡检** —— 经 CDP 通道取页面节点树（类名与事件绑定），断言组件是否渲染。
- **日志读取** —— 直接读取模拟器内应用的 stdout 与 Studio 渲染进程日志，
  并可过滤错误行。
- **运行时诊断** —— 查询完整进程树、模拟器真实启动参数
  （exe 路径／设备／分辨率／包名／端口／产物目录）与工作区统计。
- **命令行构建** —— 通过 Studio 内置的 `blueos-pack` 编译器执行 debug / release 构建，
  无需打开 IDE；构建结束后直接列出 rpk 产物。

---

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows |
| 运行时 | Node.js ≥ 18 |
| 目标环境 | BlueOS Studio 处于运行状态；目标工程已编译；模拟器已启动（新建工程不需要） |
| 辅助程序 | `powershell.exe`、`netstat`、`tasklist`（系统自带）；可选 `pnpm` / `npm`（新建工程时装依赖用） |
| Studio 组件 | Studio 自带 CLI、构建工具 `blueos-pack`、内置工程模板 |

---

## 安装

```bash
git clone https://github.com/dahaoiua/blueos-studio-skill.git blueos-studio-skill
```

脚本不依赖所在位置，可通过绝对路径调用。

以 **Agent Skill** 方式使用时，将仓库置于所用工具的 skill 目录中，
并保持根目录直接包含 `SKILL.md`、`scripts/` 与 `assets/`。

---

## 快速开始

```bash
# 设定脚本目录
SK="<本仓库>/scripts"

# 0) 新建工程（Studio 关着也能用）
node "$SK/blueos-create.js" templates
node "$SK/blueos-create.js" create "E:/AI/myapp" --template hello-blueos \
     --pkg com.example.myapp --app-name 我的应用     # 默认自动装依赖
node "$SK/blueos-sim.js" open "E:/AI/myapp"           # 让 Studio 打开（新窗口）

# 1) 环境体检：端口、当前设备与分辨率、模拟器连接状态
node "$SK/blueos-ws.js" probe

# 2) 截屏（输出原生分辨率 PNG）
node "$SK/blueos-ws.js" shot out.png

# 3) 注入交互后再次截屏
node "$SK/blueos-ws.js" tap 195 225
node "$SK/blueos-ws.js" crown 3
node "$SK/blueos-ws.js" push /pages/Diagnostics
node "$SK/blueos-ws.js" shot diag.png
# 点击会触发跳转/动画时，等画面静止再截（否则可能截到过渡帧）：
node "$SK/blueos-ws.js" shot diag.png --settle 400

# 3b) 卡片（widget）：列出工程里的卡片、切过去、截图、切回
node "$SK/blueos-ws.js" widgets
node "$SK/blueos-ws.js" widget widgets/weather
node "$SK/blueos-ws.js" shot card.png --settle 2000
node "$SK/blueos-ws.js" app-mode app

# 3c) 带手表外壳的截图（「整机照」）
node "$SK/blueos-ws.js" device watch-round        # 换设备（模拟器重启重编译，约 5-8s）
node "$SK/blueos-ws.js" shot watch.png --settle 700 --shell
node "$SK/blueos-ws.js" shot watch.png --shell --bg "#1b1b1f"

# 4) 查询 Studio 与模拟器的运行状态
node "$SK/blueos-sim.js" status

# 5) 切换工程（换项目 / 换目录；默认新开一个窗口，原工程继续运行）
node "$SK/blueos-sim.js" open "E:/path/to/another-project"
#   → 新窗口的 WS 端口若为 8002，之后操作该窗口加 --port 8002
node "$SK/blueos-ws.js" shot other.png --port 8002

# 6) 命令行构建（在工程根目录执行）
node "$SK/blueos-build.js" build --debug --device-type watch-square
```

`probe` 的正常输出示例：

```
== BlueOS Studio 体检 ==
  Studio 预览服务 : 在线 (127.0.0.1:8001)
  WS 端口         : 8000
  当前设备        : watch-square  (390x450)
  可选设备        : watch-round, watch-square*
  应用形态        : app   卡片: widgets/weather
  主题/语言       : dark / zh
  版本            : 2.2.1
  可换分辨率      : 390*450, 432*514
  8000 已连接方   : 1 个（预览器 + 模拟器）
```

---

## 命令速查

### `blueos-create.js` —— 新建工程

| 命令 | 说明 |
| --- | --- |
| `templates [--json]` | 列出 Studio 内置模板（名称、标题、支持的设备、样式、体积） |
| `create <目标目录> [选项]` | 按模板生成工程 |

选项：`--template <名称>`（默认 `hello-blueos`）、`--device <值>`、`--name <工程名>`、
`--app-name <应用名>`、`--pkg <包名>`（默认 `com.example.demo`）、`--no-install`（默认会装依赖）、
`--open`（创建完直接让 Studio 打开）、`--studio <目录>`、`--json`。

> 目标目录**必须不存在或为空** —— 脚本不会覆盖任何已有内容。
> 8 套模板里 6 套是 Tailwind，不装依赖就构建必然失败，所以默认自动 `pnpm install`（退回 `npm`）。

### `blueos-ws.js` —— 设备控制与截图

| 命令 | 说明 |
| --- | --- |
| `probe` | 环境体检 |
| `shot <out.png>` | 截屏（原生分辨率）。默认取「最新」一帧且不打扰应用；`--delay <ms>` 先等固定时长，`--settle <ms>` 等到画面静止，`--repaint` 强制重绘（有副作用）；`--shell`（别名 `--bezel`）套上当前设备的外壳输出带表盘／表圈的 PNG，`--bg <色>` 填底色（默认透明） |
| `watch [秒]` | 打印 WebSocket 消息流，用于协议调试 |
| `tap <x> <y>` | 点击；`--delay <ms>` 注入后额外等待再返回 |
| `swipe <x1> <y1> <x2> <y2> [ms]` | 滑动 |
| `key <keyCode> [pressType]` | 按键 |
| `crown <delta>` | 表冠旋转（正值为顺时针） |
| `back` / `home` | 返回上一页 / 返回首页 |
| `reload` | 重启应用（软刷新） |
| `size <w> <h>` | 切换分辨率 |
| `device <type>` | 切换设备（分辨率随之变；模拟器会重启重编译，约 5-8s） |
| `widgets [--json]` | 列出工程里的卡片（标准卡/轻卡、尺寸、组件、数据源）与当前应用形态 |
| `app-mode <app\|widget>` | 切换应用形态（应用 ↔ 快捷卡片）；`--timeout <秒>` 调整状态确认等待 |
| `widget [卡片名]` | 切到卡片形态并选中该卡片（不给名字 = 唯一那张） |
| `push <pagePath> [query]` | 页面跳转（router push） |
| `replace-page <path> [query]` | 替换当前页（不改页面栈深度） |
| `run` / `stop-run` | 执行 / 停止 `.autorun` 脚本 |
| `rec` / `stop-rec` | 录制脚本（把注入的点击记入 `.autorun/<device>/autorun.json`，可回放） |
| `pages <outDir>` | 按 `.autorun` 配置逐页导航并逐页截图 |
| `errors [--json]` | 编译/运行错误检查（含文件行列与代码帧） |
| `dom [out.json] [--json]` | UI 元素树巡检（类名与事件绑定，无几何信息） |
| `mock get` / `mock set <json>` | 读写模拟器 Mock 数据 |
| `gc` | 触发垃圾回收 |

> **多窗口**：Studio 可多开，每个窗口占一对连续端口（8000/8001、8002/8003 ……）。
> 以上所有命令默认作用于第一个窗口，加 `--port <WS端口>`（如 `--port 8002`）
> 可定向到指定窗口。
>
> **交互后要等界面稳定**：`tap` / `swipe` / `push` / `crown` / `key` 等交互命令都支持
> `--delay <ms>` —— 注入后额外等待再返回（不填默认 500ms，`--delay 0` 立即返回）。
> 截图侧对应用 `--delay`（固定等待）或 `--settle`（等到画面静止）。

### `blueos-sim.js` —— 模拟器进程管理与状态

| 命令 | 说明 |
| --- | --- |
| `status [--json] [--port <WS端口>]` | 进程树与连接状态；设备／分辨率／包名／端口取自 Studio 的权威信息；多开时按窗口分别列出 |
| `sim-args [--json] [--port <WS端口>]` | 只输出模拟器的 exe 路径与启动参数（便于脚本消费） |
| `open <项目目录> [--here] [--timeout <秒>]` | 让 Studio 打开该工程；**默认新开窗口**（原工程继续运行），`--here` 才复用当前窗口。Studio 没在运行时会一并将其拉起（`--timeout` 默认 120） |
| `start` | 启动模拟器（后台常驻） |
| `stop` | 结束模拟器进程 |

### `blueos-log.js` —— 日志读取

| 命令 | 说明 |
| --- | --- |
| `tail [--n 40]` | 应用 stdout 末尾 |
| `errors [--n 30] [--since 分钟]` | 仅错误行 |
| `renderer [--n 30]` | Studio 渲染进程日志 |
| `files` | 输出实际日志文件路径 |

### `blueos-build.js` —— 构建与打包

| 命令 | 说明 |
| --- | --- |
| `build [选项]` | 开发构建 |
| `release [选项]` | 发布构建（产物带签名） |
| `watch [选项]` | 监听模式，持续编译 |
| `init-ndk` / `init-native-app` | 初始化原生工程 |

常用选项：`--device-type`、`--other-variables "k1=v1&k2=v2"`、`--assets-include`、
`--dpi`、`--compile-page`、`--install`、`-f/--force`、`--enable-snapshot`、`--timeout <秒>`。

> 构建结束后会**反查产物**（`build/<设备>/manifest.json`）来判定成败 ——
> `blueos-pack` 有时内部报错却仍以退出码 0 退出，只看退出码会得到假成功。
> 另外它具有报错后不退出的缺陷，`build` / `release` 默认 900 秒超时兜底。

---

## 工作原理

Studio 基于 Electron 构建，其渲染进程内运行一个 WebSocket 服务（默认端口 8000），
按 **URL 路径**为客户端分配角色。模拟器进程 `watch.exe` 本身是 WebSocket 客户端，
反向连接至该端口，路径为 `/simulator`。
**Studio 多开时**，第二个窗口的 WS 服务为 8002、第三个为 8004，依次 +2
（预览 HTTP API 则分别为 8001 / 8003 / 8005 ……），各窗口互不干扰。

本工具连接 `/client` 路径，从模拟器推送的 `simulatorToPreview/updateUI` 消息中
取得 base64 JPEG 画面帧；错误检查与 UI 巡检分别使用 `/error-inspector` 与 `/cdp` 路径。

> **关键约束：`/simulator` 路径为模拟器专用，外部不可占用**，
> 否则真实模拟器会立即断开。

完整协议说明、输入事件映射、`/simulator` 与 `/client` 的角色划分、
以及已知行为与限制，详见 [`SKILL.md`](./SKILL.md)。

---

## 目录结构

```
.
├── SKILL.md                    # Skill 定义与完整文档（Agent 入口）
├── README.md                   # 本文件
├── CHANGELOG.md
├── LICENSE
├── assets/shell/               # 设备外壳素材（截图 --shell 用）
└── scripts/
    ├── blueos-ws.js            # 设备控制与截图（主要工具）
    ├── blueos-sim.js           # 模拟器进程管理与状态
    ├── blueos-log.js           # 日志读取
    ├── blueos-build.js         # 构建与打包
    ├── blueos-create.js        # 新建工程（用 Studio 内置模板）
    └── selftest-composite.js   # 离线自检：shot --shell 的开口裁剪是否漏缝
```

---

## 已验证环境

| 项目 | 版本 |
| --- | --- |
| BlueOS Studio | 2.2.1 |
| 设备类型 | `watch-square`（390×450）、`watch-round`（466×466） |
| Node.js | 22.x、24.x |
| `blueos-pack` | 1.0.12-beta.13 |

已验证可用的命令：`probe`、`shot`、`shot --shell`（6 机型）、
`device`（watch-square ↔ watch-round 往返，分辨率与画面均跟随）、`tap`、`crown`、`reload`、
`push`、`replace-page`、`rec`+`stop-rec` 录制回放闭环、`pages`、`errors`、`dom`、
`mock`、`gc`、`widgets`、`app-mode`、`widget`、`blueos-sim` 的 `status` / `sim-args` /
`start` / `stop` / `open`、`blueos-ws` 的 `--port` 多窗口定向、`blueos-log` 的全部子命令、
`blueos-build` 的 `build`、`blueos-create` 的 `templates` / `create`（8 套模板均可直接构建出 rpk）。

---

## 常见问题

见 [`SKILL.md` 的「常见问题」章节](./SKILL.md#常见问题)。

---

## 许可证

代码采用 MIT 许可证，详见 [`LICENSE`](./LICENSE)。

`assets/shell/` 下的设备外壳素材取自 vivo BlueOS Studio，版权归 vivo 所有，
不在 MIT 许可范围内，详见 [`assets/shell/README.md`](./assets/shell/README.md)。
