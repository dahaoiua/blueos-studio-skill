# 更新日志

本文件记录本项目的重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **外壳素材收录入仓库**：6 张设备外观 PNG 放入 `assets/shell/`，不再依赖 Studio 的
  安装路径；逐文件解析，缺失时回退 Studio 安装目录。另附 `assets/shell/README.md`
  说明素材来源与许可。
- **修复圆表素材的屏幕开口**：`assets/shell/watch-round.png` 的开口改为透明
  （原文件为不透明占位盘，单独查看时呈黑屏）。合成结果与修改前一致。
- **圆表合成分支改按机型判定**：不再依据素材中心的透明度判断，避免素材开口透明后
  被误判为开孔结构。
- **带手表外壳的截图**：`shot` 新增 `--shell`（别名 `--bezel`）—— 把模拟器裸帧套进
  设备外观（表盘／表圈／表带），输出带外壳的 PNG「整机照」；`--bg <#rrggbb|white|black>`
  给透明处填底色（默认四角透明）。外壳素材见 `assets/shell/`。
  屏幕在外壳里的矩形按预览器的两张常量表推得：
  `屏幕矩形 = (R / S) × 外壳原始尺寸`，且居中。
  分两种情形自动处理：外壳开口透明（方表圆角方孔）→ 屏幕从孔中透出；
  圆表 → 屏幕画底层、外壳开口盖顶层。零依赖（`System.Drawing`）。
- **卡片（widget）与应用形态**：`blueos-ws.js` 新增三个命令，用 8001 的 HTTP 预览接口
  驱动「应用 ↔ 快捷卡片」的切换与预览。
  - `widgets [--json]` —— 列出工程的卡片：名称、标准卡（`type: js`）/ 轻卡（`type: lite`）、
    描述、尺寸、组件、数据源 `providerUri`，并显示当前应用形态与可切形态。
  - `app-mode <app|widget>` —— 切换应用形态。
  - `widget [卡片名]` —— 切到卡片形态并选中卡片；不给名字则取该工程唯一那张。
  实现为三步：`POST /api/set_device` 带 `appMode` + `widgetModuleName` 改状态 →
  等状态落定 → 发 `previewToSimulator/reload`（带 `compileOptions`）让模拟器重载，
  否则状态变了而画面纹丝不动。`probe` 的输出也新增了「应用形态 / 卡片」一行。
- `blueos-sim.js` 新增 `open <项目目录>` —— 让 Studio 打开指定工程，模拟器随之
  重建并加载它。模拟器的设备、分辨率、包名与产物目录**全部由 Studio 该窗口的
  工作区决定**（每工作区的设备选择存在该工程的 `.ide/settings.json`），
  所以这是「换项目 / 换目录」的唯一入口：改配置文件或单独重启模拟器都无效。
  **默认新开窗口**（`--new-window`），原工程继续运行、互不打扰；`--here` 才复用
  当前窗口（会顶掉窗口里原有的工程）；`--timeout <秒>` 控制等待上限（默认 60）。
  实现绕过自带 CLI，直接以 App 模式拉起 `BlueOS Studio.exe`、等待其退出，
  再轮询确认目标工程已被打开且其模拟器已拉起，最后打印新窗口的 WS 端口。
- **多窗口支持**：Studio 可多开，每个窗口各带一个模拟器、各自独立的工作区与
  设备选择；每个窗口占一对连续端口，从 8000 起每多开一个窗口 +2
  （窗口 1 = 8000/8001，窗口 2 = 8002/8003，窗口 3 = 8004/8005 ……）。
  `blueos-ws.js` 的所有命令新增 `--port <WS端口>`，据此把操作定向到指定窗口；
  `blueos-sim.js` 的 `status` / `sim-args` 亦支持 `--port`，`status` 多开时按窗口
  分别列出各自的模拟器（PID／设备／端口／包名／产物／客户端数）。
- `blueos-sim.js` 新增 `status [--json]` 与 `sim-args [--json]`：
  从 Studio 自带 CLI 的 `--status` 输出中取出**模拟器真实启动参数**
  （exe 路径／设备／分辨率／包名／端口／产物目录），并列出进程树与工作区统计。
  这比读 `manifest.json` 推断设备与包名可靠。Studio 未运行时回退为进程扫描。
- `scripts/blueos-build.js` —— 构建与打包，自动定位 `blueos-debugger` 扩展自带的
  Node 运行时与 `blueos-pack`，支持 `build` / `release` / `watch` /
  `init-ndk` / `init-native-app`，构建后列出 `build/` 与 `dist/` 下的 rpk 产物；
  工程路径含中文或空格时给出提示（官方要求禁止）。
- `blueos-ws.js` 新命令：
  - `errors` —— 经 `/error-inspector` 获取编译错误（文件、行列号、代码帧）与模拟器实时运行时错误；`getCurrentErrors` 会触发一次重新构建。
  - `dom` —— 经 `/cdp` 抓取 UI 元素树（节点类名与事件绑定）；注意该通道不提供几何信息（`querySelectorAll` / `getBoxModel` / `Runtime.evaluate` 均不受支持）。
  - `mock get` / `mock set` —— 经 `/cdp` 读写模拟器 Mock 数据。
  - `gc` —— `MultiMemory.gc` + `HeapProfiler.collectGarbage`。
  - `replace-page` —— 替换当前页（`previewToSimulator/replacePage`，与 `push` 不同，不改变页面栈深度）。
- `pages` 支持按设备分目录的配置路径（`.autorun/<device>/autorun.json`，兼容根目录旧路径）。
- `SKILL.md` 增加「官方文档参考」章节，收录命令行、编译构建、打包、自动化测试、
  模拟调试、内存分析与日志各页的官方地址，并说明 Studio 自带 CLI 的两点要点
  （`ELECTRON_RUN_AS_NODE=1`、实际文件名 `blue-os-studio.cmd`）。

- `shot` 新增截图时机控制：`--delay <ms>`（先等固定时长再截）、
  `--settle <ms>`（等到画面连续 N ms 无新帧再截，自动等静止）、
  `--repaint`（显式请求一次重绘，默认不发）。默认行为改为**取「最新」一帧**
  且不打扰应用 —— 便于「先点击、再截图」时拿到终态画面。
- 交互命令（`tap` / `swipe` / `push` / `replace-page` / `crown` / `key` /
  `back` / `home` / `reload` / `device` / `size`）新增 `--delay <ms>`：
  注入后额外等待再返回（不填默认 500ms，`--delay 0` 立即返回）。
- **新增 `scripts/blueos-create.js` —— 命令行新建工程（脚手架）**，
  等价于手点 IDE 的「新建工程」向导，但**不需要 Studio 在运行**（纯文件操作）。
  - 模板取自 Studio 安装目录
    （`resources/app/out/vs/quickapp/code/electron-browser/create/media/projects/`），
    即随 IDE 版本分发的那 8 套官方模板（hello-blueos / sample / watchface /
    example / tasklist / stock-quotations / weather / countdown-day）。
    `templates` 子命令列出名称、标题、支持的设备、样式与体积。
  - `create <目标目录>` 逐条复刻向导的改写规则（规则读自主程序 `createMain.js`）：
    解压 `<模板>.zip` → `src/manifest.json` 写入 `name` / `package` 并把
    `--device` 指定的设备挪到 `deviceTypeList` 首位 → `package.json` 写入工程名。
  - 解压为**零依赖手写实现**（Node 自带 `zlib.inflateRawSync`），不依赖 Python 或
    PowerShell `Expand-Archive`；与 Python `zipfile` 解出的 20 个文件逐字节一致。
    同时跳过 `__MACOSX/`、`.DS_Store`、`._*` 等 macOS 打包残留
    （`tasklist.zip` 里就有，Studio 自己的向导会把这些垃圾一并解出）。
  - 依赖**默认自动安装**（`pnpm` 优先，退回 `npm`）：8 套模板里 6 套是 Tailwind，
    `postcss.config.js` 需要 `tailwindcss`，不装依赖构建必然失败；`sample` /
    `watchface` 无依赖会自动跳过。`--no-install` 可关闭。
  - 安全护栏：目标目录必须不存在或为空（绝不覆盖）；解压拒绝 `..` 与绝对路径
    （zip-slip）；工程名／包名／模板名均在动磁盘之前校验；路径含中文或空格时警告。
- `blueos-build.js` 新增 `--timeout <秒>`：`build` / `release` 默认 900 秒超时
  （`watch` 为常驻监听，不设超时）。

### 变更

- `blueos-sim.js` 的 `status` 恢复输出 **Studio 工作区与版本**
  （并入 `blueos-cli.js` 时曾丢失 Workspace Stats），便于直接看出
  「Studio 现在开着哪个工程」。
- 补充「切换工程」相关文档，并记录两个失效路径：
  `blue-os-studio.cmd --reuse-window <目录>` 在本安装下静默无效；
  `blue://file/<路径>/` 协议虽已注册，但 Electron 不接受 `--open-url`，同样不可用。
- 文档记录 Studio 会**强制把模拟器拉回当前工作区**：手动 `stop` 后为另一个工程
  `start` 模拟器，数秒内即被替换回当前工作区对应的模拟器。
- 文档明确 `rec` 的语义：录制的是**交互脚本**（注入的 mouseEvent 按 delay 记入
  `.autorun/<device>/autorun.json`，可由 `run` 回放），并非视频录制；
  视频仅出现在 autorun 截图流程（预览器 webview 的 MediaRecorder）中。
- `blueos-sim.js`：
  - `start` 的启动参数补齐 Studio 自身会传的 `-compilePath` / `-compileQuery` /
    `-intrpkPackage` / `-moduleName` 四个空参数。
  - 连接统计修正为「本地端口为该端口且状态为 ESTABLISHED」的行数
    （即客户端数），不再用两行折半而得出小数。
- 构建相关文档补全 `release` 子命令、`--other-variables` 等完整参数、
  `dist/<device>/<debug|release>/` 产物路径、`build.config.js` 配置与路径限制。

### 移除

- 移除独立脚本 `blueos-cli.js`（Studio 自带 CLI 的封装）。经核算，其 194 行中
  只有解析 `--status` 的约 67 行有实质价值，且**唯一的消费方就是 `blueos-sim.js`**；
  其余为薄转发与打印排版，另有一份与 `blueos-sim.js`、`blueos-build.js`
  重复的 Studio 目录探测。该解析逻辑已并入 `blueos-sim.js`，能力不减，文件数 5 → 4。
  `version` / `open` / `extensions` 等纯转发命令改为在文档中给出一行
  `blue-os-studio.cmd` 调用即可。

### 修复

- **修复圆表 `shot --shell` 屏幕边缘锯齿**：改为屏幕画底层（开口外沿 +2 裁剪，硬边被
  表圈覆盖）、外壳开口盖顶层，可见边缘即素材自带的抗锯齿带（边缘二阶差分 RMS 由 0.563 降至 0.083）。
- **开口轮廓加环向 7 点滑动平均**：消除射线扫描的步长量化抖动（RMS 0.28 → 0.15），
  扫描步长由 0.5px 改为 0.25px。开口为非正圆（半径极差 3.5px），仍按射线命中点连多边形。
- **修复圆表 `shot --shell` 屏幕与表圈之间的透明细环**：原先按公式半径裁圆，正好落在
  外壳的透明缝中间。现改为逐角度量取屏幕开口半径，屏幕铺到表圈内沿。
- **修复开孔类设备（方表/平板/折叠等）屏幕未盖满开口**：现逐角度量取开口最大 x/y 半宽，
  按统一比例放大至刚好覆盖（+2px 余量），不改变屏幕宽高比。
- **新增离线自检 `scripts/selftest-composite.js`**：校验各设备显示屏开口内无残留透明像素，
  退出码非 0 表示合成有漏缝。
- **修复 `device` 切换设备不生效**：原先只发 WS `switchDevice`（`previewToSimulator`）时，
  Studio 的 `project_info.currentType` 与模拟器画面均不变（帧仍为旧分辨率）；
  只 POST `/api/set_device` 同样不够 —— 状态变了画面也不跟着变。现改为四步：
  `POST /api/set_device`（带 `device` + `size`）→ 等状态落定（`currentType`）→
  WS `switchDevice` + `size` → `reload`。模拟器会退出重启并重编译目标设备
  （事件流里能看到「模拟器异常退出」+ 编译耗时），整段约 5-8s。
- **修复 `blueos-sim.js open` 在 Studio 未运行时会把它拉起来又杀掉的问题。**
  原实现用 `spawnSync(exe, [...])` 并等它退出（带 60s 超时）：Studio 已在运行时，
  这个 exe 只是「转发参数给现有实例」的短命进程，1~3 秒就退，没问题；
  但 **Studio 没在运行时，这个 exe 就是 Studio 本体**，会一直活着 —— 于是超时后
  `spawnSync` 把它 SIGTERM 掉，表现为 `[ERR] 拉起 Studio 失败：... ETIMEDOUT`
  且刚出现的 Studio 窗口随即消失。现改为 **detached 分离启动、不等它**，
  成功与否一律由既有的轮询逻辑判定；`--timeout` 默认由 60 提到 **120**
  （冷启动还要先等 IDE 起来），并在冷启动时明确提示。
- **修复 `blueos-build.js` 的「假成功」**：`blueos-pack` 有时内部已经失败却仍以
  退出码 0 结束 —— 例如 `postcss.config.js` 中 `require` 不到 `tailwindcss`（依赖未安装）时，
  它打出 `[ERROR] ... BError ...` 与一串 `UnhandledPromiseRejection` 后正常退出，
  于是脚本照样打印 `[OK] 构建完成`，而 `build/` 下什么都没产出。
  现改为在 `build` / `release` 之后**反查产物**（`build/<设备>/manifest.json` 是否存在）
  来判定成败，没有就报 `[ERR] ... 本次构建实际未成功` 并以退出码 1 结束。
  同时补上超时护栏：blueos-pack 报错后**可能不退出**（清理输出目录被文件系统的批量删除
  保护拦下时抛 `BError`，进程却一直活着），会让调用方永久挂住。
- 修复 `blueos-create.js` 在 Windows 上探测不到包管理器的问题：`pnpm` / `npm` 实际是
  `.cmd`，Node 直接 `spawnSync('pnpm')` 会 `ENOENT`，必须过 shell 调用。
- 修复「点击后截图，截到的却是跳转中的画面（甚至首页）」。两个叠加的成因：
  1. **截图时主动发送的 `previewToSimulator/size`（原意是"逼一次重绘"）会被部分应用
     当成 resize 事件，把页面栈重置回首页** —— 于是「点击 → 截图」实际截到的是应用
     被自己踢回首页的重置动画。改为默认**不发** `size`：发送 `previewToSimulator/on`
     打开帧流时模拟器本就会推来当前画面的一帧；仅当一帧都收不到时才兜底发一次。
     （以 AirPointer 为例：发送重绘请求会截到首页，不发送则截到目标页）。
  2. **取帧策略从「字节数最大」改为「最新到达」**。跳转动画期间会出现约 1KB 的空白
     过渡帧，而某个中间帧也可能比终态更大，按大小挑帧会挑中非终态画面。
  同时 `pages` 也改为「不主动重绘 + 等画面静止」，`watch` 会自动打开帧流（此前不发
  `on`，收不到任何帧，容易误判成"没画面"）。
- 定位并绕开 Studio 自带 CLI 在 Windows 上的**静默失效**
  （`blue-os-studio.cmd --reuse-window <目录>` 退出码 0、无输出、工作区不变）：
  其一是 `cli.js` 在 spawn 出真正的 Studio 实例后**立即自己退出**，
  实例还在启动就被回收，参数没有转发出去（加 `--verbose` 让父进程等待即恢复正常，
  但会刷一屏 main 日志）；其二，直接调 `"BlueOS Studio.exe" --new-window <目录>`
  （或 `--reuse-window`）时必须**删除**
  继承来的 `ELECTRON_RUN_AS_NODE`（而不是置空或置 `0` —— 只要"存在"即生效），
  否则 exe 会以 Node 模式运行，任何 Studio 参数都表现为
  `bad option: --xxx` 并以退出码 9 结束。
- `blueos-log.js` 改为扫描全部会话目录、取日志文件自身 mtime 最新者，
  并跳过只含 `cli.log`、没有 `window<N>` 子目录的目录。
  此前按目录 mtime 取"最新会话"，会被 Studio 自带 CLI 新建的空目录带偏，
  导致所有日志都显示为"(无)"。

## [0.1.0] - 2026-10-06

### 新增

- 首个版本发布。
- `scripts/blueos-ws.js` —— 设备控制与截图工具，提供以下命令：
  `probe`、`shot`、`watch`、`tap`、`swipe`、`key`、`crown`、`back`、`home`、
  `reload`、`size`、`device`、`push`、`run`、`stop-run`、`rec`、`stop-rec`、`pages`。
  内置最小 WebSocket 客户端实现，无第三方依赖。
- `scripts/blueos-sim.js` —— 模拟器进程管理（`status` / `start` / `stop`），
  复刻 Studio 自身的模拟器启动参数。
- `scripts/blueos-log.js` —— 日志读取（`tail` / `errors` / `renderer` / `files`）。
- `SKILL.md` —— 技能定义与完整文档，含 WebSocket 协议说明、
  输入事件映射与已知行为记录。
- `README.md` —— 项目说明与命令速查。

### 说明

- 截图能力基于 Studio 内部 WebSocket 通道获取模拟器推送的渲染帧，
  输出为模拟器原生分辨率，不经过屏幕抓取。
- 拼接 PowerShell 命令统一使用单引号字面量（`psq()`），
  避免双引号展开 `$(...)` 导致的命令注入。
