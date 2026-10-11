---
name: blueos-studio
description: 在 Windows 上以命令行驱动运行中的 BlueOS Studio（蓝河 Studio）与手表模拟器，提供原生截图、触摸/表冠/按键注入、设备与分辨率切换、页面跳转、应用形态与卡片（widget）预览、编译/运行错误检查、UI 元素树巡检、Mock 注入、日志读取，以及进程诊断与命令行构建打包；还能用 Studio 内置模板直接从命令行新建工程（无需打开 IDE 的「新建工程」向导）。适用于：新建 BlueOS 工程/表盘工程、截取模拟器画面、检查页面渲染效果、注入交互事件（点击／滑动／旋转表冠）、切换设备尺寸、在「应用」与「快捷卡片」之间切换并预览某张卡片、按 .autorun.json 批量逐页截图、获取编译错误与运行时报错、检查页面组件是否渲染、查阅运行日志、查询模拟器真实启动参数、脱离 IDE 执行 debug/release 构建。画面数据取自 Studio 内部 WebSocket 通道，无需抓屏，无外部依赖。
agent_created: true
---

# BlueOS Studio / 模拟器 命令行驱动

## 概述

BlueOS Studio（蓝河 Studio）是 vivo 手表应用平台的集成开发环境。本 skill 通过
Studio 内部已有的 WebSocket 通道与运行中的模拟器通信，并调用 Studio 自带的
命令行与构建工具，在命令行下完成
**新建工程、截屏、交互注入、设备切换、应用形态与卡片切换、错误检查、UI 巡检、
日志查看与构建打包**，无需在 IDE 界面中操作。

「新建工程」用的是 Studio 安装目录里随版本分发的那 8 套官方模板（含表盘模板），
因此新建出来的工程与手点「新建工程」向导得到的完全一致 —— 只是省掉了点界面。

画面数据取自模拟器推送的 **base64 JPEG 帧**，因此所获图像为**模拟器原生分辨率**，
不经过屏幕抓取，不受窗口遮挡、最小化或锁屏影响。

所有脚本为 CommonJS，**零 npm 依赖**，Node.js ≥ 18 可直接运行：

```bash
NODE="<node 可执行文件>"          # 任意 Node ≥ 18
SK="<本仓库>/scripts"
```

---

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows |
| 运行时 | Node.js ≥ 18（无外部依赖） |
| 目标环境 | BlueOS Studio 处于运行状态；目标工程已编译；模拟器已启动（**仅新建工程不需要** —— 那一步是纯文件操作，Studio 关着也能用） |
| 辅助程序 | `powershell.exe`（仅用于 JPEG → PNG 容器转换）、`netstat` 与 `tasklist`（端口及进程探测） |
| Studio 组件 | Studio 自带 CLI（`bin/blue-os-studio.cmd`，`blueos-sim.js` 用它取模拟器真实启动参数）与构建工具 `blueos-pack`（位于 `blueos-debugger` 扩展） |

---

## 安装

```bash
git clone <本仓库地址> blueos-studio-skill
```

脚本不依赖所在位置，可通过绝对路径调用。

以 **Agent Skill** 方式使用时，将仓库置于所用工具的 skill 目录中，
并保持根目录直接包含 `SKILL.md`、`scripts/` 与 `assets/`。

---

## 快速开始

```bash
# 0) 新建工程（用 Studio 内置模板，不必打开「新建工程」向导）—— Studio 关着也行
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

# 3b) 点击会触发页面跳转/动画时：等画面静止（或固定等一段）再截，
#     否则可能截到过渡帧。也可以直接把等待挂在操作上。
node "$SK/blueos-ws.js" shot diag.png --settle 400      # 等到连续 400ms 画面不变
node "$SK/blueos-ws.js" tap 195 225 --delay 800 && node "$SK/blueos-ws.js" shot diag.png

# 3c) 卡片（widget）：先看这个工程有哪些卡片，再切过去截图
node "$SK/blueos-ws.js" widgets
node "$SK/blueos-ws.js" widget widgets/weather
node "$SK/blueos-ws.js" shot card.png --settle 2000
node "$SK/blueos-ws.js" app-mode app                    # 切回应用

# 3d) 带手表外壳的截图（「整机照」）：把裸帧套进 Studio 预览器自带的表盘/表圈素材
node "$SK/blueos-ws.js" device watch-round             # 换设备（分辨率随之变，约 5-8s）
node "$SK/blueos-ws.js" shot watch.png --settle 700 --shell
node "$SK/blueos-ws.js" shot watch.png --shell --bg "#1b1b1f"   # 给透明处填底色（默认透明）

# 4) 查询 Studio 与模拟器的运行状态（配置、进程、产物目录）
node "$SK/blueos-sim.js" status

# 5) 命令行构建（工程根目录下执行）
node "$SK/blueos-build.js" build --debug --device-type watch-square
```

执行前提：BlueOS Studio 已启动、模拟器已运行、目标应用已启动。
若 Studio 未运行，`probe` 将输出 `8001 无响应`；若模拟器未运行，
`shot` 将输出 `未收到画面帧`。

---

## 工作原理

Studio 基于 Electron 构建，其渲染进程内运行一个 WebSocket 服务（默认端口 8000），
服务按 **URL 路径**为客户端分配角色。模拟器进程 `watch.exe` 本身是 WebSocket
客户端，反向连接至该端口，路径为 `/simulator`。

```
                        ┌───────────────────────────────┐
   watch.exe ──/simulator──▶│  Studio 渲染进程 :8000  (WS)  │◀── /client ── 本工具
                        └───────────────────────────────┘
   本工具(探活) ──────8001─────▶ 扩展宿主 :8001 (预览 HTTP, 无鉴权)
```

### 端口与角色

Studio **可多开**（多个窗口并存，每个窗口各自拉起一个模拟器）。
**每个窗口占一对连续端口**，从 8000 起每多一个窗口 +2：

| 窗口 | WebSocket 服务 | HTTP 预览服务 |
| --- | --- | --- |
| 第 1 个 | **8000** | **8001** |
| 第 2 个 | **8002** | **8003** |
| 第 3 个 | **8004** | **8005** |
| 第 4 个 | 8006 | 8007 |

| 端口 | 服务 | 说明 |
| --- | --- | --- |
| 8000 / 8002 / 8004… | WebSocket 服务（该窗口的渲染进程） | 按路径分配角色，见下表 |
| 8001 / 8003 / 8005… | HTTP 预览服务（扩展宿主，**无鉴权**） | 窗口元信息与**切换应用形态/卡片**，见下表 |
| 4096 | 带鉴权的服务（blueos-devtools） | 本工具不使用 |
| 9222 | 预览器调试端口 | **仅在预览面板开启 devtools 时存在**，不可依赖 |

**本工具默认只作用于第一个窗口（8000）**；要操作其它窗口，加 `--port <WS端口>`，
例如 `blueos-ws.js shot b.png --port 8002`。脚本会自己去 `<端口>+1` 取该窗口的元信息，
不会拿到别的窗口的设备与分辨率。

### 8001 HTTP 预览服务的接口

无鉴权、纯 HTTP。本工具的 `probe` / `widgets` / `app-mode` / `widget` 走的就是这几个：

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| `/api/project_info` | GET | 窗口元信息：设备、`sizeMap`、`deviceTypeList`、分辨率可选项、主题、语言、版本，以及**应用形态与卡片清单**（`appMode` / `appModeOptions` / `widgetModuleName` / `projectInfo.widgets` / `widgetModuleNameList` / `hasPages` / `hasWidgets` / `otherSetting`） |
| `/api/set_device` | POST | **切换设备 / 形态 / 卡片**。body：`{device, size, appMode, widgetModuleName, otherSetting}` |
| `/api/set_size` | POST | 只换分辨率 |
| `/api/set_app_update_method` | POST | 应用更新策略（0 = 仅刷新页面，1 = 重启应用） |
| `/api/switch_widget` | POST | 名义上「切换卡片」。⚠️ **单独调用是静默无效的**（返回 success，状态纹丝不动），别依赖它 |
| `/api/get_target_options` | GET | 目标选项列表（多数工程返回空数组） |

WebSocket 角色路径：

| 路径 | 使用者 | 是否可占用 |
| --- | --- | --- |
| `/client` | 预览器 | ✅ 本工具使用此路径 |
| `/simulator` | **模拟器专用** | ❌ 外部占用将导致真实模拟器断开（表现为模拟器异常退出，日志中出现 `[ErrExit] simulator encountered an exception and exited`） |
| `/cdp` | devtools 面板 | ✅ 本工具用于 UI 元素树 / Mock / GC（见下文） |
| `/error-inspector` | 错误面板 | ✅ 本工具用于编译/运行错误检查（见下文） |

> **注意：仅连接 `/client`。** 占用 `/simulator` 会使真实模拟器立即断开，
> 现象容易被误判为模拟器崩溃。

### 事件类型

| 事件 | 方向 | 用途 |
| --- | --- | --- |
| `previewToSimulator` | 本工具 → 模拟器 | **所有输入注入、尺寸与形态切换**（`on`/`off` 控制帧流） |
| `simulatorToPreview` | 模拟器 → 本工具 | `updateUI` 消息携带**画面帧**（base64 JPEG） |
| `previewToServer` | 本工具 → Studio 渲染进程 | 触发 autorun 引擎（`startRun` / `startRecord`） |
| `serverToPreview` | Studio 渲染进程 → 本工具 | 预览器控制指令（`updateDevice` / `changeSize` / `capturePage` / `startRecording` / `stopRecording` / `checkRenderEmpty` / `drawMarkerForCursor` 等，面向预览面板） |
| `cdpToPreview` | Studio → 预览面板 | 只用于 `Overlay.setInspectMode`（元素检查模式） |
| `shotdown` | 模拟器 → 本工具 | 模拟器关闭通知 |

### 截图机制

模拟器通过 `simulatorToPreview/updateUI` 推送渲染结果，`payload.params` 为
base64 编码的 JPEG，其尺寸即模拟器原生分辨率（watch-square 为 390×450）。

**已知行为：模拟器仅在画面发生变化时推送帧，但发送一次 `previewToSimulator/on`
打开帧流后，当前画面会随之推来一帧**，因此脚本默认**不**主动请求重绘，直接取
「最新到达的那一帧」。

> ⚠️ **不要用 `previewToSimulator/size` 来「逼一次重绘」。** 它本意是把当前尺寸重复
> 设置一遍（名义上幂等），但实测有的应用会把它当成 resize 事件而**重置页面栈回到首页**。
> 于是「点击 → 截图」会截到应用被自己踢回首页的那次重置动画 —— 看起来就像
> 「截图时页面还在跳转」。脚本默认不发 `size`；仅当一帧都收不到时才兜底发一次，
> 并打印提示。确需强制重绘时用 `--repaint`（自担风险）。

**取帧策略：取「最新」一帧，不取「最大」一帧。** 页面跳转/动画期间会出现字节数
很小（约 1 KB）的空白过渡帧，而中间某帧也可能比终态更大；按大小挑帧会挑中非终态
画面。要等画面稳定，用 `--settle`（等到连续 N ms 无新帧）或 `--delay`（固定等待）。

PNG 输出由 `powershell.exe` 调用 `System.Drawing` 完成容器转换，不进行重采样。

### 带外壳截图（`shot --shell`）

Studio 预览面板本身就是把「裸屏幕画布」叠在「设备外观图」上显示的。素材已随仓库自带：

```
assets/shell/watch-round.png    565x897   圆表
assets/shell/watch-square.png   446x799   方表
assets/shell/phone.png / foldable.png / tablet.png / tv.png
```

找不到自带素材时回退本地 `<Studio>/resources/app/extensions/blueos-previewer/client/`。

屏幕在外壳里的位置由预览器 `client/assets/index-*.js` 里两张常量表决定：

```
N = 设备原生分辨率    R = 屏幕显示尺寸    S = 外壳显示尺寸
屏幕矩形 = (R.w / S.w, R.h / S.h) × 外壳素材原始尺寸，且居中
（方表验证：245/300×446 = 364.2、283/510×799 = 443.2，与外壳透明孔实测 364x443 吻合）
```

⚠️ **公式矩形只是基准，不等于素材里的真实开口**。实测两者差 0.4%~1.6%
（方表 0.999、平板 1.004、折叠 1.016）；圆表的结构更复杂：中心那块"黑屏占位盘"
（不透明）外面还有一圈**透明缝**，再外面才是表圈。**只按公式半径（244/300×宽 ≈ 229.8）
裁圆，屏幕就会停在缝中间**，缝的其余部分留成透明 —— 在任意背景上即表现为一条亮细环，
即所谓「屏幕与边框未贴合」。

所以 `--shell` 现在会**先量外壳、再裁**（由外壳中心像素是否透明自动分派）：

- **外壳中心透明**（方表/平板/折叠：直接开孔）→ 逐角度量出开口相对中心的最大 x/y 半宽，
  把公式矩形按**统一比例**放大到刚好盖住整个开口（+2px 余量）→ 先画屏幕、再叠外壳；
- **外壳中心不透明**（圆表：黑表面 + 透明缝 + 表圈）→ 沿 720 条射线逐角度量出「缝外侧、
  表圈开始不透明 (alpha≥250)」的半径，连成多边形把屏幕铺到表圈内沿（再越过 2px，让渐隐带
  压在不透明的表圈上而不是落进那条透明缝）→ 先画外壳、再叠屏幕。
  开口**不是正圆**（实测半径 230.5~234，极差 3.5px），所以不能套正圆公式；
  射线扫描的步长量化会让相邻角度间抖动 ±0.125px，连成多边形后边缘会带约 0.3px 毛刺
  —— 所以对半径数组再做一次**环向 7 点滑动平均**（实测把边缘二阶差分 RMS 从 0.28 降到 0.15，
  光滑圆弧的理论值约 0.004）。

两种做法都**不改变屏幕自身的宽高比**（圆表是统一放大约 3%，方表/平板/折叠 0~1.7%），
并且保证开口里一个透明像素都不剩。

### 圆表 --shell：边框抠洞盖顶层（不要自己画圆）

GDI+ 的 `SetClip` 恒为硬边，自己剪出来的圆必是台阶（实测旧做法 141/141 行边缘亚像素
位置全落在整数上）。现在很简单：**屏幕画底层**（开口外沿 +2 硬裁剪，锯齿被表圈盖住）、
**外壳占位盘抠成透明后整张盖顶层** —— 可见边缘就是素材 PNG 自带的 AA 渐变带，
指标到顶（RMS 0.083，比超采样 0.146 还好）。抠洞边界取"开口半径 -1"，落在 alpha=0 的
  透明缝里，抖动不可见；半透明 AA 像素保持不变。
以下做法已否决：4× 超采样（可以实现，但肉眼仍可见波纹）、TextureBrush（rect 为源图取用区，
TileFlip 会镜像漏入路径）、边框盖顶但不对中心抠洞（中心为不透明占位盘，会遮盖屏幕）。

输出是外壳素材的原始分辨率 PNG，四角透明（`--bg` 可填底色）。
有素材的设备：`watch-round` / `watch-square` / `phone` / `foldable` / `tablet` / `tv`；
`car` / `multi` 没有素材，会自动保留裸帧并打印告警，不会报错。

> 修改这段合成逻辑后，应执行一次离线自检（无需 Studio 在线）。判据：**开口内不得残留透明像素**
> —— 先在外壳上找出「与图像外边界不连通的、离中心最近的那块透明区」= 显示屏开口，
> 再数合成图在该区域内还剩多少透明像素。已验证它能抓住修好前的旧图（3133/8186 仍透明）。
>
> ```bash
> node "$SK/selftest-composite.js"      # 退出码 0 = 全部设备开口都被盖满
> ```
>
> ⚠️ 自检只查"有没有剩透明像素"，**查不出锯齿**（锯齿是几何问题、不是透明度问题）。
> 改过抗锯齿相关代码后，另用「边缘亚像素位置有多少行落在整数像素上」自查：
> 理想值应当是 0，若接近全部行数就说明又退回硬裁剪了。

> 另有一条可复用的路径：`serverToPreview/capturePage` 会让预览面板自身
> `canvas.toDataURL('image/png')` 后经 `fs.writeFile` **直接把 PNG 写入指定的
> `pagePath`**。但那张画布是**原生分辨率的裸屏幕**（不含外壳），与 `shot` 拿到的帧同源。

---

## 脚本一：`blueos-ws.js`

主要工具，提供设备控制与截图的全部命令。

```bash
node "$SK/blueos-ws.js" <命令> [参数]
node "$SK/blueos-ws.js" <命令> [参数] --port 8002   # 多开时操作第 2 个窗口
```

所有命令都接受 `--port <WS端口>` 来指定目标窗口（默认 8000）。

| 命令 | 说明 |
| --- | --- |
| `probe` | 环境体检：端口、当前设备与分辨率、可选设备、该端口已连接方数量、Studio 版本 |
| `shot <out.png>` | 截图。默认取「最新」一帧且**不打扰应用**（即时返回）；`--delay <ms>` 先等固定时长再截，`--settle <ms>` 等到画面连续 N ms 无变化再截，`--timeout 8000` 调整等待上限，`--repaint` 强制请求一次重绘（有副作用，见「截图机制」）。输出为 `.png` 时自动转换为 PNG，为 `.jpg` 时直接写入 JPEG。**`--shell`（别名 `--bezel`）**：把裸帧套进当前设备的外壳（表盘/表圈，取自 Studio 预览器自带素材），输出带外壳的 PNG「整机照」；可配 `--bg <#rrggbb\|white\|black>` 给透明处填底色（默认透明，四角为透明） |
| `watch [秒]` | 打印消息流，用于协议调试（`updateUI` 仅显示字节数；会自动打开帧流） |
| `tap <x> <y>` | 点击（成对发送 mousedown 与 mouseup）；`--delay <ms>` 表示注入后额外等待再返回（默认 500，`--delay 0` 立即返回） |
| `swipe <x1> <y1> <x2> <y2> [ms]` | 滑动，默认 300 ms，插值为 12 步；同样支持 `--delay <ms>` |
| `key <keyCode> [pressType]` | 按键，`pressType` 默认 1 |
| `crown <delta>` | 表冠旋转，**正值为顺时针**；低速时 `delta` 的绝对值通常为 1 |
| `back` / `home` | 返回上一页 / 返回首页 |
| `reload` | 重启应用（软刷新，不重新安装包） |
| `size <w> <h>` | 切换分辨率。⚠️ 名义上幂等，但**可能重置应用页面栈**（见「截图机制」），别拿它当重绘开关 |
| `device <type>` | 切换设备（`watch-round` / `watch-square` / `phone` …），分辨率随之变。走四步：`POST /api/set_device` → 等状态 → WS `switchDevice` + `size` → `reload`。**模拟器会退出重启并重编译，耗时约 5-8s**；`--timeout <秒>` 调整等待（默认 30） |
| `widgets [--json]` | 列出当前工程的**卡片**：名称、标准卡/轻卡、名称描述、尺寸、组件、数据源；并显示当前应用形态与可切形态 |
| `app-mode <app\|widget>` | 切换**应用形态**（应用 ↔ 快捷卡片）。`--timeout <秒>` 调整状态确认等待（默认 25） |
| `widget [卡片名]` | 切到卡片形态并选中该卡片；**不给名字** = 该工程唯一那张 |
| `push <pagePath> [query]` | 页面跳转（router push，入栈） |
| `replace-page <path> [query]` | 替换当前页（不改变页面栈深度，与 `push` 不同） |
| `run` / `stop-run` | 执行 / 停止 `.autorun` 脚本（交由 Studio 内置 autorun 引擎） |
| `rec` / `stop-rec` | 开始 / 停止**录制脚本**：把期间注入的点击按 delay 记入 `.autorun/<device>/autorun.json`，可用 `run` 回放 |
| `pages <outDir>` | 按 `.autorun` 配置逐页导航并逐页截图，每页一张，不依赖预览面板状态 |
| `errors [--json]` | 编译/运行错误检查（`/error-inspector`，带文件、行列号与代码帧） |
| `dom [out.json] [--json]` | 经 `/cdp` 抓取 UI 元素树（节点类名与事件绑定，无几何信息） |
| `mock get` / `mock set <json>` | 经 `/cdp` 读写 Mock 数据 |
| `gc` | 触发垃圾回收（`MultiMemory.gc` + `HeapProfiler.collectGarbage`） |

协议映射（便于在其他环境中复用）：

```js
tap   → previewToSimulator/mouseEvent {type:'mousedown'|'mouseup', x, y, timestamp}
swipe → 同上，插值发送 mousemove 后发送 mouseup
crown → previewToSimulator/crownEvent {delta, velocity, duration:80, timestamp}
key   → previewToSimulator/keyEvent  {keyCode, pressType, repeatCount:1, timeStamp}
size  → previewToSimulator/size      {width, height}
device→ POST /api/set_device {device, size, appMode, widgetModuleName, otherSetting}
        → previewToSimulator/switchDevice {device, width, height}
        → previewToSimulator/size {width, height}
        → previewToSimulator/reload {device, compileOptions:{defineOptions:{OTHER_VARIABLES}}}
          （只 POST 或只发 switchDevice 都不生效：状态/画面必有一边不动）
shot  → previewToSimulator/on 收帧；--shell 时用 System.Drawing 把帧贴进设备外壳素材
back  → previewToSimulator/back   {}      home   → /backToHome {}
reload→ previewToSimulator/reload {}      push   → /push {pagePath, pageQuery}
replacePage → previewToSimulator/replacePage {pagePath, pageQuery}
widgets → GET  /api/project_info           （读 projectInfo.widgets 与 appMode）
app-mode/widget → POST /api/set_device {device, size, appMode, widgetModuleName, otherSetting}
                  然后 previewToSimulator/reload {device, compileOptions:{defineOptions:{OTHER_VARIABLES}}}（顺序不能换）
run/rec → previewToServer/startRun | stopRun | startRecord | stopRecord
errors  → /error-inspector 裸消息 {id, method:'getCurrentErrors'|'getErrors', params:{}}
dom/mock/gc → /cdp 裸消息 {id, method, params}（CDP 风格，见下文方法表）
```

### 录制脚本（`rec` / `stop-rec`）与 autorun 配置

`rec` 录制的是**交互脚本而非视频**：开始后，所有经 `previewToSimulator/mouseEvent`
注入的点击会按时间差（`delay` 毫秒）记入脚本；`stop-rec` 时落盘并触发 Studio 打开该文件。

脚本路径为**按设备分目录**（由 `.ide/settings.json` 的 `blueos-previewer.device` 决定）：

```
<项目根>/.autorun/<device>/autorun.json     ← 新版（rec 默认写入此处）
<项目根>/.autorun/autorun.json              ← 兼容旧版，`pages` 两者都会尝试
```

格式：

```json
{ "list": [ { "pageRouterEvent": "push", "pagePath": "/pages/Index",
              "pageParams": "", "events": [ { "delay": 5908 } ] } ],
  "capture": true, "size": { "width": 390, "height": 450 } }
```

- `events[0].delay` 为进入页面后的等待时长，用于等待动画或异步数据完成后截图
- `pages` 自行执行 `push`、等待 `delay`，再**等画面静止**（连续 `--settle` ms 无新帧，
  默认 600ms）后取最新一帧，**不依赖预览面板是否打开**；不主动发 `size`（原因见「截图机制」）
- 生成方式：`rec` → 注入操作（`tap`/`swipe` 均可） → `stop-rec`

> **注意：** `run` 命令使用 Studio 内置 autorun 引擎，该引擎依赖**预览 webview 存活**
> （其 `capturePage` 需将图像写入 `.autorun/result/screenshots/`，父目录不存在或
> 预览面板未打开时不会落盘，且无报错）。如需稳定的批量截图，应使用 `pages`，
> 该命令不经过 `capturePage`，直接采集模拟器原生帧。

### 卡片（widget）与应用形态

蓝河应用有三种形态：应用 / 表盘 / **快捷卡片**（代码里叫 `widget`）。
卡片就是「不用进应用就能看信息」的那一屏 —— 用户在**表盘界面左滑**看到的一屏一卡。
工程里它是 `src/widgets/<名字>/` 一个独立目录（含自己的 `assets/`，官方要求卡片的
非代码资源必须放在卡片目录下），在 `manifest.json` 的 `router.widgets` 里声明，
并**单独打包成 `<包名>_widgets.<卡片名>.rpk`**。

```bash
node "$SK/blueos-ws.js" widgets                      # 这个工程有哪些卡片、当前是什么形态
node "$SK/blueos-ws.js" app-mode widget              # 切到卡片形态
node "$SK/blueos-ws.js" widget widgets/weather       # 切到指定卡片（不给名字 = 唯一那张）
node "$SK/blueos-ws.js" shot card.png --settle 2000  # 截卡片
node "$SK/blueos-ws.js" app-mode app                 # 切回应用
```

预览器上「形态」是个下拉，取值来自 `appModeOptions`（通常 `["app","widget"]`）；
切到 widget 后再选具体哪张卡片，对应 `/api/set_device` 的 `appMode` 与 `widgetModuleName`。

**两种卡片**，看 `router.widgets` 里的 `type`（`widgets` 命令会直接标出来）：

| type | 叫法 | 数据从哪来 |
| --- | --- | --- |
| `js` | 标准卡 | 卡片自己的 `index.ux` 里算 |
| `lite` | 轻卡 | 由 `providerUri` 指向的 **widgetProvider** 喂数据（跑在应用里的那段代码，见 `src/widgetProvider/index.js` 的 `onWidgetCreate` / `onWidgetUpdate` / `onWidgetEvent` / `onWidgetDestroy`），系统按 `refreshDuration` 定时回源 |

**两处要点**（`app-mode` / `widget` 已代为处理；手工构造请求时需注意）：

1. **只改状态，画面不会跟着变。** `POST /api/set_device` 只改状态 ——
   `.ide/settings.json` 与 `/api/project_info` 立刻就是新值，但模拟器仍在渲染上一屏。
   必须**再发一条 `previewToSimulator/reload`（带 `compileOptions`）**让它重载。
   重载后画面会先变成空白过渡帧再重绘，本命令会等到真画面稳定后才返回。
2. **顺序不能换，POST 之后也不要立刻读 `/api/project_info`。** 宿主改状态是异步的，
   紧跟 POST 的一次 GET 会让它按「尚未重绘的预览器」把状态回写，等于把刚切的形态吃掉
   —— 现象是接口返回 success、状态几十秒纹丝不动（切回 `app` 反而**看起来**成功，
   因为目标值恰好等于被回写的旧值）。因此本命令的轮询会先静置约 1 秒再开始。

> `/api/switch_widget` **单独调用是静默无效的**（返回 `{"code":0,"message":"success"}`，
> 但 `appMode` 与 `widgetModuleName` 纹丝不动）。切卡片用 `set_device` 带
> `widgetModuleName` 一次带过去即可。

> **卡片不是整屏画面。** 卡片渲染在宿主容器里 —— 例如 2x1 栅格是一个圆角胶囊，
> 上方有卡片名、下方还有宿主的调试条。判读截图时别按整屏页面去看。
> 另外卡片的 `deviceTypeList` **只支持 `watch` 或 `phone`**（tv / car / 手环都不支持），
> `sizes` 写法如 `"2x2"` 中间不能有空格，可用 `FULL` / `AUTO` 与数值组合
> （`"FULLx4"` / `"1xFULL"` / `"4xAUTO"`）。

---

## 错误检查与 CDP 通道

### `errors` —— `/error-inspector`

连接 8000 端口的 `/error-inspector` 路径，发送 `{id, method, params}` 裸消息：

| 方法 | 行为 |
| --- | --- |
| `getCurrentErrors` | 触发一次**重新构建**（内部约 20 s 超时），返回当前编译错误与运行时错误 |
| `getErrors` | 返回累计的错误记录 |

返回体形如 `{compileErrors: ["[ERROR] <文件>: <信息> (行:列)\n<代码帧>"], runtimeErrors: [...]}`，
文本中含 ANSI 颜色码（脚本已自动剥离）。`--json` 输出原始结构。

- 这是**获取编译错误最直接的途径**：无需解析日志，直接得到文件、行列与代码帧。
- 运行时错误来自模拟器实时上报（如 `BleFeature ... nullptr`、SVG 解析失败等）。
- 注意：调用 `getCurrentErrors` 会触发构建，其副作用与 `blueos-pack build` 一致
  （清空产物目录、可能重启模拟器）。

### `dom` / `mock` / `gc` —— `/cdp`

`/cdp` 是 Studio 转发给模拟器的 **CDP（Chrome DevTools Protocol）通道**，
消息格式为 `{id, method, params}` → `{id, result}`。

实测可用的方法：

| 域 | 方法 | 说明 |
| --- | --- | --- |
| DOM | `DOM.getDocument` | 取文档根；子节点以 `DOM.setChildNodes` 事件异步推送 |
| CSS | `CSS.getMatchedStylesForNode` | 取节点命中的 CSS 规则 |
| Mock | `Mock.getMock` / `Mock.setMock` | 读写模拟器 Mock 数据 |
| SystemStorage | `getStorageList` / `get` / `set` / `delete` / `clear` | 应用 storage |
| MultiMemory | `startRecord` / `stopRecord` / `gc` | 内存录制与回收 |
| HeapProfiler | `takeHeapSnapshot` / `collectGarbage` | 堆快照与 GC |
| Overlay | `setInspectMode` / `inspectModeCanceled` | 元素检查模式 |

实测**不支持**的方法（返回空 `{}`）：`DOM.querySelectorAll`、`DOM.getBoxModel`、
`Runtime.evaluate`。因此该通道**无法获得元素几何信息**，不能用于按元素定位点击；
定位仍须依赖坐标（配合 `shot` 截图人工/视觉判读）。

`dom` 命令的典型输出（每个节点带类名与事件绑定，可用于断言组件是否渲染）：

```
#6 <div> .ap-wheel.col-center  events:{ "touchmove": "onWheelMove", ... }
  #7 <div> .ap-wheel-bar.bg-gray-500.rounded-full
```

> 断开 `/cdp` 连接时，消息流中会出现 `Devtools WS 断开-1006` 的 `gtagTrackEvent`，
> 属正常现象，可忽略。

---

## 脚本二：`blueos-sim.js`

模拟器进程管理与运行状态查询。

```bash
node "$SK/blueos-sim.js" status [--json]

# 模拟器（Studio 权威信息）:
#   PID      : 37644
#   exe      : <Studio>\...\blueos-previewer\simulator\win\watch.exe
#   设备     : watch-square  390x450
#   包名     : com.kyrin.airpointer
#   端口     : 8000
#   产物目录 : <工程根>\build
# 8000 客户端数: 1 个（预览器 + 模拟器）
# Studio 预览: 在线，当前设备 watch-square

node "$SK/blueos-sim.js" sim-args [--json]      # 只输出上面那组参数（便于脚本消费）
node "$SK/blueos-sim.js" open <项目目录>        # 让 Studio 切到该工程（模拟器随之重建）
node "$SK/blueos-sim.js" start [--project <项目根>] [--device watch-square] \
                               [--size 390x450] [--port 8000] [--studio <Studio目录>]
node "$SK/blueos-sim.js" stop
```

### `status` 与 `sim-args` 的信息来源

设备、分辨率、包名、端口与 exe 路径取自 Studio 自带 CLI 的 `--status` 输出 ——
那是 Studio 拉起模拟器时的**真实命令行**，比读 `manifest.json` 推断可靠
（见下文「Studio 自带 CLI」）。Studio 未运行时回退为进程扫描结果，
此时只能给出 PID，拿不到设备与包名。

### `start` 的启动参数

复刻 Studio 自身用的形式：

```
watch.exe -port <ws端口> -device <设备> -package <包名> -app <项目>/build
          -compilePath "" -compileQuery ""
          -defaultAppDataPath <APPDATA>/BlueOSStudio
          -width <w> -height <h> -appUpdateMethod 0 -type app
          -intrpkPackage "" -moduleName ""
```

`<包名>` 自动从 `build/<device>/manifest.json` 的 `package` 字段读取。
**执行前须存在构建产物**（可通过 Studio 编译，或使用下文的 `blueos-build.js`），
否则命令将明确报错。

Studio 安装目录的探测顺序：`--studio` 参数 → 环境变量 `BLUEOS_STUDIO` →
`E:\BlueOSStudio` → `D:\BlueOSStudio` → `C:\BlueOSStudio`。

### 切换工程 / 多开窗口（`open`）—— 换项目 / 换目录

模拟器的**设备、分辨率、包名与产物目录全部跟着 Studio 该窗口的工作区走**
（每个工作区的设备选择存在该工程的 `.ide/settings.json` 里）。因此：

- 改 `.ide/settings.json` 无效；只重启模拟器也无效 —— 它加载的仍是 Studio 该窗口当前打开的工程。
- 要换工程，只能**让 Studio 打开目标目录**，本命令就是这一步的封装。

**Studio 可以多开**（每个窗口各自带一个模拟器，互不打扰），因此 `open` 默认就是
**新开一个窗口**打开目标工程，**原有工程继续运行**：

```bash
node "$SK/blueos-sim.js" open "E:/AI/AirPointer/hidtest"
# [open] 目标工程 : E:\AI\AirPointer\hidtest
#        方式     : 新开窗口（原工程不受影响）
# [OK] 新窗口已打开工程「hidtest」
#      窗口 WS  : 8002   （其预览 API 为 8003）
#      模拟器 : PID 28904  设备 watch-round 466x466  包名 com.kyrin.hidtest
#      产物   : e:\AI\AirPointer\hidtest\build
#      提示   : 操作该窗口请加 --port 8002
```

- **默认新开窗口**（`--new-window`）：原工程保持运行，目标工程开在新窗口里。
- `--here` 才复用当前窗口（`--reuse-window`，会**顶掉**当前窗口里的工程）。
- 若目标工程已被某个窗口打开，则跳过打开、直接打印该窗口信息（不重复开）。
- 全程不需要手点 Studio 界面。`--timeout <秒>` 控制等待上限（默认 **120**；目标工程
  从未被 Studio 打开过会明显偏慢，Studio 本来还没运行还要先等 IDE 冷启动）。
- **Studio 未运行时同样可用**：会一并把 Studio 拉起，并在输出中注明
  `Studio : 原未运行，本次为冷启动`。

> ⚠️ **由命令冷启动的 Studio，可能活不过命令本身。** 在受限执行环境
> （沙箱／自动化）里，命令结束时它的整个进程树都可能被回收。
> **现象**：`open` 报成功、紧接着 `status` 也看得到窗口与模拟器，但过一会儿 Studio 没了；
> 同一台机器上手动启动的 Studio 不受影响。
> **怎么办**：先手动启动 Studio，再运行本命令。

**多开后的端口规律**：每个窗口占一对连续端口，从 8000 起每多一个窗口 +2
（窗口 1 = 8000/8001，窗口 2 = 8002/8003，窗口 3 = 8004/8005 ……）。
`open` 会打印新窗口的 WS 端口；之后所有 `blueos-ws.js` 命令都可加 `--port <WS端口>`
定向到对应窗口，`blueos-sim.js status --port <WS端口>` 只列出该窗口。

**为什么不直接用 `blue-os-studio.cmd`：** 那条路会**静默失效** ——
退出码 0、无任何输出、工作区纹丝不动。原因有两条，都很隐蔽：

1. `blue-os-studio.cmd` 把 `ELECTRON_RUN_AS_NODE=1` 传下去，而 `cli.js` 在 Windows 上是
   **spawn 出真正的 Studio 实例后立刻自己退出**。被 spawn 的实例还在启动就被回收，
   参数根本没转发出去。给它加 `--verbose`（父进程会等子进程）就正常 —— 但会刷一屏 main 日志。
2. 直接调 `"BlueOS Studio.exe" --new-window <目录>`（或 `--reuse-window`）时，
   **必须删除**（而不是设成空或 `0`）继承来的 `ELECTRON_RUN_AS_NODE`。
   该变量只要"存在"即可生效，设成 `0` 同样会让 exe 以 Node 模式运行，
   于是任何 Studio 参数都变成 `bad option: --xxx` 并以退出码 9 结束。

本命令因此绕过 `cli.js`：直接用 Node 起 `BlueOS Studio.exe`（App 模式）、删掉该环境变量、
并**等待它自行退出**（实例转发完参数就退，约 1~3 秒），随后轮询确认目标工程
已被打开、且其模拟器已拉起。

> 附带发现：`blue://file/<路径>/` 这套 URL 协议虽已在系统注册，但本安装的 Electron
> 不接受 `--open-url`（报 `bad option: --open-url`），此路不通。

### 已观测行为

- 执行 `stop` 结束进程后，Studio **不会**自动将其拉起（`status` 显示"未运行"，
  8000 客户端数归零），因此重启是可控的。
- `start` 以分离进程方式常驻，约 3~8 秒后完成与 8000 端口的连接。
- **模拟器进程的 PID 会自行变化。** Studio 在需要时会重建模拟器进程
  （已确认的场景：构建产物变化；未执行任何命令的间隔内也曾观察到 PID 变化）。
  因此**不要用 PID 判断进程身份或"是否还是同一个模拟器"**，
  应以 8000 客户端数与进程是否仍在为准。
- **Studio 会强制把模拟器拉回当前工作区。** 若手动 `stop` 掉模拟器、再用 `start` 指向
  另一个工程，Studio 会在数秒内按当前工作区把它重建回来（实测：手动为 `hidtest` 起的
  模拟器立刻被替换成 `watch` 的）。这从反面印证了「换工程必须换 Studio 工作区」。
  多窗口时，这条只在**各自窗口内**成立 —— 各窗口有独立工作区，互不干扰。
- **Studio 支持多开。** 每个窗口各占一对连续端口（8000/8001、8002/8003 ……），
  各自带一个模拟器、各自独立的工作区与设备选择。因此「打开新工程」不必关掉原工程，
  `blueos-sim.js open` 默认即新开窗口。

### Studio 自带 CLI（`status` 的底层）

Studio 安装目录 `bin/` 下有自带命令行工具（官方文档中称为 `blue`，
实际文件名为 `blue-os-studio.cmd`），它是 VSCode 派生而来的标准 CLI。实现为：

```
set ELECTRON_RUN_AS_NODE=1
"BlueOS Studio.exe" "resources/app/out/cli.js" %*
```

两点值得知道：

- **必须带 `ELECTRON_RUN_AS_NODE=1`**，否则它会尝试打开一个窗口而不是执行命令。
- 官方文档里的命令名是 `blue`，**实际可执行文件名是 `blue-os-studio.cmd`**。

本 skill 只用它最有价值的一项：`--status`（即上面 `status` / `sim-args` 的数据源）。
其余命令可直接调用，无需经过本仓库的脚本：

```bash
BLUE="<Studio>/bin/blue-os-studio.cmd"
"$BLUE" --version                              # 版本 / 提交号 / 架构
"$BLUE" --list-extensions --show-versions      # 已安装扩展（不含 Studio 内置扩展）
"$BLUE" --help                                 # 全部选项
```

> **`--reuse-window <目录>` 在本安装下会静默失效**（见上文「切换工程」），
> 换工程请用 `blueos-sim.js open`。

> **副作用：** 凡需要「连接运行实例」的调用（`--status` 即属此类）都会在
> `%APPDATA%\BlueOS Studio\logs\` 下**新建一个只含 `cli.log` 的会话目录**。
> 这是 Studio 的固有行为（直接调用 `blue-os-studio.cmd --status` 同样如此），
> `--version` 一类不连接实例的命令不会产生。这类目录没有 `window<N>` 子目录，
> `blueos-log.js` 会自动跳过。
>
> **`--status` 不是取模拟器命令行的唯一途径** —— PowerShell 的
> `Get-CimInstance Win32_Process -Filter "Name='watch.exe'"` 能拿到逐字相同的命令行。
> `--status` 的独有内容是**已标好角色的进程树**（extensionHost / window / gpu-process）
> 与**工作区统计**（各类型文件计数）。


---

## 脚本三：`blueos-log.js`

日志读取。

```bash
node "$SK/blueos-log.js" tail     [--n 40]                 # 应用 stdout 末尾
node "$SK/blueos-log.js" errors   [--n 30] [--since 分钟]  # 仅错误行
node "$SK/blueos-log.js" renderer [--n 30]                 # Studio 渲染进程日志
node "$SK/blueos-log.js" files                             # 输出实际日志文件路径
```

日志目录：`%APPDATA%\BlueOS Studio\logs\<启动时间戳>\window<N>\`

| 文件 | 内容 |
| --- | --- |
| `output_<时间戳>/project.log` | 模拟器中应用的 stdout，含 `[Error]` / `[ErrExit]` / `JSError` |
| `renderer.log` | Studio 渲染进程日志，含扩展报错（如 `privilege-api.vivo.xyz ENOTFOUND`，属无影响的网络噪声） |

> **注意：**
> - 日志定位**不按目录 mtime**，而是扫描全部会话目录、取 `project.log` / `renderer.log`
>   **文件本身 mtime** 最新者。`window<N>` 目录的 mtime 不随日志写入更新，
>   以它为依据会选中旧窗口的日志。
> - 只含 `cli.log`、没有 `window<N>` 子目录的会话目录会被跳过
>   （它们由 Studio 自带 CLI 连接运行实例时产生，见上文「Studio 自带 CLI」）。
>   `files` 子命令会在跳过时给出数量提示。

---

## 脚本四：`blueos-build.js` —— 构建与打包

Studio 的构建系统为 BlueOS Toolkit，命令行入口是 `blueos-pack`（位于
`blueos-debugger` 扩展内，`jax` 与 `bot` 两个入口指向同一实现），
**须用扩展自带的 Node 运行时驱动**。本脚本负责定位这两个路径并转发参数。

```bash
cd <项目根>
node "$SK/blueos-build.js" build   --debug --device-type watch-square
node "$SK/blueos-build.js" release --device-type watch-square
node "$SK/blueos-build.js" watch
node "$SK/blueos-build.js" build --help      # 查看 blueos-pack 全部选项
```

| 子命令 | 说明 |
| --- | --- |
| `build` | 开发构建，`--rpk-path` 默认 `dev` |
| `release` | 发布构建，产物带签名，`--rpk-path` 默认 `prod` |
| `watch` | 监听模式，持续编译 |
| `init-ndk` / `init-native-app` | 初始化原生工程 |

常用选项（原样透传）：

| 选项 | 说明 |
| --- | --- |
| `--device-type <设备>` | 如 `watch-square` / `watch-round` |
| `--other-variables "k1=v1&k2=v2"` | 注入自定义变量（`NODE_ENV` 等），对应 IDE「打包设置」中的「其他变量」 |
| `--assets-include <模式>` | 指定要打包的资源目录 |
| `--dpi <dpi>` / `--compile-page <页面路径>` | 像素密度 / 只编译指定页面 |
| `--install` | 构建完成后自动安装 rpk |
| `-f, --force` | 禁用缓存（修改配置后不生效时使用） |
| `--enable-snapshot [值]`、`--jerry`、`--cjb` | 快照与中间产物生成 |

产物位置：

```
dist/<device>/<debug|release>/<包名>.<类型>.<版本>.rpk     ← 对外产物（release 带签名）
build/<device>/                                            ← Studio 增量编译与模拟器读取的位置
```

构建完成后脚本会列出 `build/` 与 `dist/` 下的 rpk 及其大小。
**每次构建版本号会自动递增。**

`build.config.js`（可选，置于工程根目录）用于个性化构建：

```js
module.exports = {
  assetsInclude: ['assets', 'assets-watch', 'assets-watch-round'], // 数组形式：靠后者优先级更高
  css: { postcss: './postcss.config.js' },
  resolve: { alias: { '@': './src', '~': './src' } },
}
```

`assetsInclude` 支持字符串、数组与函数三种形式；函数形式可读取 IDE 传入的
「其他变量」做条件化资源引入。

> **注意：**
> - **工程路径中不能含中文或空格**（官方文档明确要求），否则构建工具会失败。
>   脚本检测到时会给出提示。
> - 不要与 Studio 的实时编译同时操作同一工程。Studio 会依据 `.ide/settings.json`
>   中 `blueos-previewer.device` 所选的设备自动重编译；在外部手动构建其他设备时，
>   双方会各自写入 `build/`，可能相互覆盖。
> - 构建首先会清空输出目录，Studio 的监视器检测到产物变化后**可能重启模拟器**，
>   表现为 `watch.exe` 的 PID 变化、应用回到首页。因此构建后不要立即判断页面状态，
>   先用 `blueos-sim.js status` 确认 8000 端口客户端数恢复，再执行 `shot`。
>   该过程同时会重置此前通过 `pages` / `tap` 产生的页面状态。
>   （实测耗时约 10 秒；模拟器是否重启并不固定，以 `status` 实际输出为准。）

### 构建结果判定

`blueos-pack` 有时**内部已经失败却仍以退出码 0 结束**，只看退出码会得到「构建成功」的假象。
因此脚本在 `build` / `release` 之后会**反查产物** —— `build/<设备>/manifest.json`
是否存在（`--device-type` 没给时，则看 `build/` 下有没有任何设备目录带该文件）。
没有就报 `[ERR] ... 本次构建实际未成功` 并以退出码 1 结束。

它还存在**报错后不退出**的缺陷，会把调用方永久挂住。`build` / `release` 默认 900 秒超时
（`--timeout <秒>` 可调；`watch` 是常驻监听，不设超时），超时会打印中止原因。

> ⚠️ **在受限文件系统／沙箱里重建已有工程可能失败**：构建前要清空输出目录，
> 而 `build/` 下文件数 ≥ 50 会触发批量删除保护
> （输出里出现 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`）。
> 全新工程（`build/` 为空）不受影响。详见文末「常见问题」。

---

## 脚本五：`blueos-create.js` —— 新建工程（脚手架）

用 Studio **安装目录里随版本分发的那 8 套官方模板**建工程，等价于手点 IDE 的
「新建工程」向导，只是不用点界面。**不需要 Studio 正在运行**（纯文件操作）。

```bash
# 看有哪些模板
node "$SK/blueos-create.js" templates

# 建一个手表工程（默认自动装依赖）
node "$SK/blueos-create.js" create "E:/AI/myapp" --template hello-blueos \
     --pkg com.example.myapp --app-name 我的应用

# 建表盘工程，并立刻让 Studio 打开它
node "$SK/blueos-create.js" create "E:/AI/myface" --template watchface \
     --device watch --open
```

| 子命令 | 说明 |
| --- | --- |
| `templates` | 列出内置模板：名称、中英文标题、支持的设备、样式（Tailwind/Normal CSS）、体积 |
| `create <目标目录>` | 按模板生成工程，并改写应用名与包名 |

`create` 选项：

| 选项 | 说明 |
| --- | --- |
| `--template <名称>` | 模板名，默认 `hello-blueos` |
| `--device <值>` | 首选设备（`watch` / `watch-square` / `phone` / `multi` / `foldable`）。**只能重排、不能新增** —— 与向导一致：值必须已在该模板 `deviceTypeList` 里，否则只提示不生效 |
| `--name <名称>` | 工程名（默认取目标目录的目录名）→ 写入 `package.json` 的 `name`。须符合 npm 包名规则 |
| `--app-name <名称>` | 应用显示名（默认同 `--name`）→ 写入 `src/manifest.json` 的 `name` |
| `--pkg <包名>` | 应用包名（默认 `com.example.demo`）→ 写入 `src/manifest.json` 的 `package` |
| `--no-install` | 跳过装依赖（默认会装，见下） |
| `--open` | 创建完直接调用 `blueos-sim.js open`（新窗口打开） |
| `--studio <目录>` | Studio 安装目录，默认自动探测 |

### 模板从哪来

```
<Studio>/resources/app/out/vs/quickapp/code/electron-browser/create/media/projects/
    <模板名>/<模板名>.zip        ← 工程本体
    <模板名>/manifest.json       ← 模板元信息（标题、支持的设备、版本）
```

实测本安装（Studio 2.2.1）自带 8 套：

| 模板 | 中文名 | 设备 | 样式 |
| --- | --- | --- | --- |
| `hello-blueos` | 你好，蓝河 | watch / phone | Tailwind |
| `sample` | 示例应用 | watch / phone | Normal CSS（**无依赖**） |
| `watchface` | 手表表盘模版 | watch | **无依赖** |
| `example` | 入门示例 | multi / phone / foldable | Tailwind |
| `tasklist` | 任务列表 | watch / phone | Tailwind |
| `stock-quotations` | 股票行情 | watch | Tailwind |
| `weather` | 天气 | watch | Tailwind |
| `countdown-day` | 倒数日应用 | phone | Tailwind |

> 模板随 Studio 版本更新，以 `templates` 子命令的实际输出为准。

### 改写规则（与 IDE 向导一致）

1. 把 `<模板>.zip` 解压到目标目录；
2. 改 `src/manifest.json`：`name` = 应用名，`package` = 包名；若 `deviceTypeList` 里
   有 `--device` 指定的设备，把它挪到数组首位；
3. 改 `package.json`：`name` = 工程名（JSON 统一重排为 2 空格缩进，与向导一致）；
4. 让 Studio 打开该目录 —— 交给 `--open` 或 `blueos-sim.js open`。

解压为**零依赖手写实现**（Node 自带 `zlib.inflateRawSync`），不依赖 Python 或
PowerShell。会跳过 `__MACOSX/`、`.DS_Store`、`._*` 这类 macOS 打包残留
（部分模板里有，Studio 自带的向导会把它们一并解出来）。

### 依赖：默认就会装

8 套模板里 6 套是 Tailwind，`postcss.config.js` 里 `require('tailwindcss')`，
**不装依赖直接构建必然失败**。所以只要 `package.json` 里声明了依赖，
`create` 就会自动安装（`pnpm` 优先，退回 `npm`）；`sample` / `watchface` 无依赖，
自动跳过。安装需要联网，`--no-install` 可跳过。

### 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 报「目标目录已存在且非空」 | 设计如此。换目录名，或先自行清空（脚本不会删除任何已有内容） |
| `[warn] 该模板不支持设备 xxx` | 该值不在此模板的 `deviceTypeList` 里。向导同样只是不生效，不会新增设备 |
| 路径含中文或空格 | 只是警告。但官方要求工程路径不含中文与空格，否则构建工具会失败 |
| 装依赖很慢 / 失败 | 需要联网访问 npm registry。失败不影响工程文件，进目录手动 `pnpm install` 即可 |
| 建完能 `open` 但构建报错 | 先确认依赖装好了（`node_modules` 是否存在）；Tailwind 模板缺依赖必然编译失败 |

---

## 官方文档参考

| 主题 | 地址 |
| --- | --- |
| 命令行界面（Studio 自带 CLI） | https://studio.blueos.com.cn/helper/command-line/ |
| 编译构建（`build.config.js`、别名、资源包含、路径限制） | https://studio.blueos.com.cn/debug/compile/ |
| 应用打包（debug/release、证书、产物） | https://studio.blueos.com.cn/publish/package/ |
| 自动化测试（`autorun.json` 字段与测试报告） | https://studio.blueos.com.cn/test/autotest/ |
| 模拟调试（DevTools 各面板，对应本 skill 的 `/cdp` 通道） | https://studio.blueos.com.cn/debug/devtools/ |
| 内存分析（快照与泄漏判读） | https://studio.blueos.com.cn/debug/memory |
| 查阅日志（日志类型与导出） | https://studio.blueos.com.cn/debug/console/ |

---

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `shot` 报 `未收到画面帧` | ① 模拟器未运行 → 执行 `blueos-sim.js status` ② 应用未启动 ③ 端口非 8000 → 先执行 `probe` |
| 模拟器在运行但收到 0 帧 | 发 `previewToSimulator/on` 打开帧流后，当前画面会推来一帧。脚本已内置；若仍为 0 帧，才由脚本兜底发一次 `size` |
| **点击后截图截到「跳转中」的空白/半成品画面** | 通常是取帧时机太早，用 `--settle 400`（等画面静止）或 `--delay <ms>`（固定等待）；或让操作本身等：`tap 195 350 --delay 800` |
| **点击后截图，画面上却是首页** | 截图时发的 `size` 重绘请求把应用重置回了首页。脚本默认已不发送；手工构造 WS 消息时不应发送 `size` |
| **`shot` 输出全是空白/纯色** | 抓到了跳转动画的过渡帧（约 1 KB）。加 `--settle`，或改用 `tap/ push` 的 `--delay` 后再截 |
| **模拟器突然退出** | 检查是否连接了 `/simulator`，应仅连接 `/client` |
| `probe` 报 `8001 无响应` | Studio 未启动，或端口被占用 |
| `pages` 报找不到 `.autorun/autorun.json` | 先执行 `rec` → 完成操作 → 执行 `stop-rec` 生成，或按上文格式手写 |
| `run` 执行后 `.autorun/result/screenshots/` 为空 | 预览面板未打开或父目录不存在，改用 `pages` |
| 日志内容明显过期 | 不应以 `window<N>` 目录 mtime 为依据，应使用日志文件自身的 mtime |
| 日志显示"(无)"，但 Studio 确实在跑 | 最新会话目录可能只含 `cli.log`（CLI 连接实例时建的）。`blueos-log.js` 已跳过这类目录；若自行取"最新目录"需一并跳过 |
| `%APPDATA%\BlueOS Studio\logs` 下堆积很多空目录 | Studio 自带 CLI 每次 `--status` 都会新建一个。属固有行为，可手动清理 |
| 修改 `src/` 后模拟器无变化 | Studio 增量编译可能未触发。可用 `fs.utimesSync` 刷新被修改文件的 mtime 以触发重编译；或查看 `build/<device>/packageInfo.json` 的 `buildTime` 确认是否已重新构建 |
| 构建失败，但代码看起来没问题 | 检查工程路径是否含中文或空格（官方要求禁止） |
| 改了 `build.config.js` 或资源目录不生效 | 加 `-f/--force` 禁用缓存后重试 |
| `blueos-sim.js status` 报拿不到信息，只有 PID | Studio 未运行，回退到了进程扫描；`--status` 需要 Studio 已启动 |
| 构建后页面状态与预期不符 | 构建会清空输出目录并可能触发模拟器重启，先 `blueos-sim.js status` 确认已重连，再 `shot` |
| `blueos-build.js` 报 `没有产出 build/<设备>/manifest.json` | 构建实际失败了（blueos-pack 内部报错但退出码为 0）。最常见是**依赖没装**：Tailwind 模板需要 `tailwindcss`，进工程目录 `pnpm install` 即可；其次是路径含中文/空格 |
| 构建跑很久不结束 | blueos-pack 内部报错后**不退出**会导致调用方挂住。脚本已加 900 秒超时护栏（`--timeout` 可调）；超时会打印中止原因 |
| 构建输出出现 `[safe-delete]...CONFIRM_REQUIRED` | 输出目录文件数 ≥ 50，清空 `build/` 被文件系统的批量删除保护拦下。全新工程不会遇到；已建过的工程可先自行清空 `build/`，或在不受限的环境里构建 |
| 新建工程报「目标目录已存在且非空」 | 设计如此 —— 脚本绝不覆盖已有内容。换目录名或先自行清空 |
| `open` 报 `spawnSync ... ETIMEDOUT`，且 Studio 一闪就没 | 旧版缺陷：Studio 未运行时用 `spawnSync` + 超时等它退出，超时后把它杀了。现已改为分离启动、由轮询判成败 |
| 由 `open` 冷启动的 Studio 窗口，命令一结束就消失 | 受限执行环境（沙箱／自动化）会回收命令的整个进程树。先手动启动 Studio，再跑 `open` 即可 |
| `open` 等超时（默认 120s） | Studio 冷启动 + 目标工程首次打开都比较慢，可加大 `--timeout`（如 180） |
| `widget` / `app-mode` 报「未确认切换完成」 | 状态长时间不变，多为手工构造请求时在 POST 之后立刻读取 `/api/project_info`（会把状态回写掉）。本命令已内置静置，若仍失败可加 `--timeout 60` 再试 |
| `widget` 报成功，但截图还是上一屏 | 卡片源码刚改过、模拟器还在重编译；或 `build/<设备>/` 里还没有 `widgets/` 产物。等一会儿再 `shot`，必要时先让 Studio 编一次 |
| `widget` 报「该工程没有卡片模块」 | 这个工程确实没有 `src/widgets/`，或 `manifest.json` 的 `router.widgets` 没配。先跑 `widgets` 确认 |
| `widgets` 里 `type` 显示为空 | `manifest.json` 的 `router.widgets` 缺 `type`；标准卡填 `js`、轻卡填 `lite` |
| 切的卡片跟 `appMode` 对不上 | 卡片 `deviceTypeList` 只支持 `watch` / `phone`，且预览器形态与卡片是两个独立的字段（`appMode` + `widgetModuleName`），都要对上 |
| 卡片截图显示「未铺满」 | 设计如此 —— 卡片渲染在宿主容器里（2x1 是一个圆角胶囊），并非整屏 |
| `device` 报成功，但画面还是旧分辨率 | 只 POST `/api/set_device`（或只发 WS `switchDevice`）都不够：前者只改 Studio 状态、后者只改模拟器。四步都要发（本命令已内置）：POST set_device → 等状态 → WS `switchDevice` + `size` → `reload` |
| `device` 切换要等好几秒 | 正常。模拟器会退出重启并重编译目标设备（事件流里能看到「模拟器异常退出」），约 5-8s；`--timeout` 可加大 |
| `shot --shell` 说「没有外壳素材」 | 该设备没有对应 PNG（自带 `assets/shell/` 与 Studio 的 `client/` 里都没有，如 `car` / `multi`）。已保留裸帧并告警；换有素材的设备，或直接用裸帧 |
| `--shell` 图里屏幕外有一圈黑边 | 正常，那就是表圈 —— 外壳素材本身如此 |
| `--shell` 图里屏幕和表圈之间有一条**亮细环**（在深色/任意背景上看像"没贴合"） | 即上文「裁到透明缝」的问题，已修复：现在会按实测开口轮廓把屏幕铺到表圈。若又出现，跑 `node scripts/selftest-composite.js` 定位；退出码 1 表示某设备开口里还剩透明像素 |
| 圆表 `--shell` 图的屏幕比 Studio 预览面板里大一点点（约 3%） | 预期行为。Studio 面板是画在 229.8 半径上、后面垫着页面底色，所以它自己就带那条 2~3px 的缝；本工具选择把屏幕铺满到表圈，于是统一放大了约 3%。这是"屏幕真的贴住边框"而不是"留一圈底色" |
| `--shell` 图里屏幕边缘是**台阶/锯齿**（放大看是一格一格的硬边） | 抗锯齿被退回了硬裁剪（`SetClip` 剪出来的边永远是硬的）。当前实现是「边框抠洞盖顶层」：可见边缘 = 外壳 PNG 自带 AA 渐变带。判据：量屏幕边缘的亚像素位置，**若几乎所有行都精确落在整数像素上**就是锯齿回来了（修好后 ~3/110 行、RMS≈0.08，若明显更差说明抠洞边界或图层顺序被改坏） |

---

## 安全说明

本仓库五个脚本的外部行为如下（全部源码可读，无 npm 依赖，无构建产物）：

| 项目 | 行为 |
| --- | --- |
| 网络 | 仅连接 `127.0.0.1`（8000 WebSocket 的 `/client`、`/cdp`、`/error-inspector` 三个角色路径，8001 HTTP），不访问任何外部主机。8001 上会 `GET /api/project_info`，切形态/卡片时 `POST /api/set_device`。**唯一例外**：`blueos-create.js` 默认执行 `pnpm install` / `npm install`，那一步会访问 npm registry（可用 `--no-install` 关掉） |
| 子进程 | `netstat -ano`、`tasklist`、`powershell -c Add-Type System.Drawing`（仅用于 JPEG → PNG 转换）。`blueos-sim.js` 另有 `watch.exe` 启动与 `taskkill /PID`（**PID 经进程名白名单过滤**，仅结束 `watch.exe` 与 `cross.exe`），以及以 Node 模式调用 Studio 自带的 `cli.js`（`BlueOS Studio.exe` 配 `ELECTRON_RUN_AS_NODE=1`，只传 `--status`）。`blueos-build.js` 以同样方式驱动 `blueos-pack`，参数由调用方给出。`blueos-create.js` 会调 `pnpm`/`npm -v` 探测包管理器，并按需执行 `install` |
| 文件 | 只读 `%APPDATA%\BlueOS Studio\logs`、`build/<device>/manifest.json`、`.autorun` 配置；只写入调用方指定的输出目录。`blueos-build.js` 会由 `blueos-pack` 写入工程的 `build/` 与 `dist/`。`blueos-create.js` 只写目标目录，且要求它**不存在或为空**（绝不覆盖已有内容）；解压时拒绝含 `..` 或绝对路径的条目（zip-slip 防护）。`app-mode` / `widget` 会让 **Studio 自己**改写工程的 `.ide/settings.json`（appMode / widgetModuleName），本工具不直接碰该文件 |
| 凭据 | 不读取、不传输 |

> 拼接 PowerShell 命令时须使用**单引号字面量**（脚本内的 `psq()` 函数）：
> PowerShell 的双引号会展开 `$(...)`，当文件名可控时构成任意命令执行。

> `blueos-sim.js` 会以 Node 模式调用 Studio 的 `cli.js`，但只传 `--status`；
> `blueos-build.js` 则把参数原样转发给 `blueos-pack`，因此**它的副作用取决于
> 调用方传入的参数** —— 不要把它当作只读工具使用。

---

## 适用范围

本 skill 的职责是**驱动运行中的 Studio 与模拟器**，包括新建工程、构建、输入注入、
应用形态与卡片切换、截图与日志读取。

对于 `.ux` 代码本身的问题（语法自检、`manifest.json` 配置、传感器 API 能力边界、
渲染能力限制），属于 BlueOS 应用开发范畴，不在本 skill 范围内。

---

## 真机调试（不属于本 skill，但别答错）

被问到「手表只有蓝牙，怎么调试真机」时，先纠正一个常见误解：**官方有真机调试，
只是接口不在手表上，在手机上。**

```
PC（BlueOS Studio + adb）──USB──▶ Android 手机（vivo健康 / 快应用调试器）──蓝牙──▶ 手表
```

- 官方文档实测要求：**装了 vivo 健康的 Android 手机 + 蓝河 Watch3 + USB 数据线
  + 开发机装 adb + 手机开 USB 调试**；Studio 右上角「USB 调试」推送 rpk。
- 首次会由 Studio 自动向手机安装「快应用调试器」与「快应用预览版」；拉不起来时把
  调试引擎切成手机内置引擎（vivo 为 `com.vivo.hybrid`）。
- **云真机**：`adb connect val-vclinner-rt-contest.vivo.com.cn:24129`，改代码即更新；
  ⚠️ 但**只用于预览包体，不具备 DevTools 调试能力**。
- 手表侧是 RTOS：**没有 adb / logcat / `/proc` / ptrace**。`adb logcat -s WatchLog:I`
  只是手机把转发来的手表日志打出来，不是手表的 logcat。
- 手表 **BLE 只有 `createGattServer`（无 client 端）→ 不能主动连出去**，
  连接必须由 PC / 手机发起。这条决定所有自研工具的方向。

想调官方没给的能力（截图、终端、文件探测），要么复刻 OrbitV 那套蓝牙私有协议，
要么走官方扩展程序 bridge（手机侧 Vue + `ov.server.*` 路由，手表 `http.request` 发起）。

### 官方调试链路能不能抓？—— 能，PC 那段是标准 CDP、不算逆向

被问「官方调试的协议能抓出来吗」时，答案是**能**，且要点是**别把它当秘密协议**：

- **PC↔手机 一段 = 标准 Chrome DevTools Protocol，跑在 WebSocket 上、走 `adb reverse` 端口转发。**
  实测调试服务器起在 **PC**（`http://127.0.0.1:8088`），手机用
  `adb -s <serial> reverse tcp:8088 tcp:8088` 反向连回，WS 路径 **`/debugProxy/native`**。
  → **adb 是官方留的正门**，不是绕过什么。
- 另有 HTTP 调试服务器（`hap server` / `npm run server`）实测默认端口 **`12306`**（用 IDE 时自动开）。
- ⚠️ **端口以本机 Studio 日志为准**（`%APPDATA%\BlueOS Studio\logs\<ts>\window<N>\renderer.log`），
  不同 IDE/版本可能不同。**先读日志拿精确拓扑，是最省事的第一步。**
- 抓法：不直通 8088，改成 `adb reverse tcp:8088 tcp:18088` 转发到自写代理 → 拿**明文 CDP**；
  或 **直接写 CDP 客户端连 `ws://127.0.0.1:8088/debugProxy/native`（能直接对话，不用抓包）**。
- ⚠️ **官方通道给不了截图/终端/文件探测**（那是 OrbitV 的私有能力）；手机↔手表那段**可能加密**；
  手机端与手表端 vivo 组件**替换不掉**。

