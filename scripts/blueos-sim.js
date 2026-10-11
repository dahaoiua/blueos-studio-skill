#!/usr/bin/env node
// BlueOS 模拟器进程管理与运行状态查询（零依赖）
//
// 模拟器的启动参数（从 Studio 渲染进程代码挖出，并由 Studio 自带 CLI 的 --status
// 输出校准过）：
//   watch.exe -port <ws端口> -device <设备> -package <包名> -app <项目>/build
//             -compilePath "" -compileQuery "" -defaultAppDataPath <APPDATA>/BlueOSStudio
//             -width <w> -height <h> -appUpdateMethod 0 -type app
//             -intrpkPackage "" -moduleName ""
// 末尾四个空参数 Studio 自己也会传，缺了可能导致行为差异，故一并保留。
//
// 模拟器是 WS 客户端，会主动连到 Studio 的 8000 端口（路径 /simulator）。
//
// 用法：
//   node blueos-sim.js status [--json] [--port <WS端口>]  # 各窗口的模拟器/工程/端口
//   node blueos-sim.js sim-args [--json] [--port <WS端口>] # 只输出某个模拟器的启动参数
//   node blueos-sim.js open <项目目录> [--here]           # 让 Studio 打开该工程（默认新窗口）
//   node blueos-sim.js start [选项]        # 启动模拟器（默认后台常驻）
//   node blueos-sim.js stop                # 结束模拟器
// 选项（start）：
//   --project <项目根目录>   默认当前目录
//   --device  <设备>         默认 watch-square
//   --size    <WxH>          默认 390x450
//   --port    <端口>         默认 8000
//   --studio  <Studio 目录>  默认 E:\BlueOSStudio
// 选项（open）：
//   --here                   复用最后一个活动窗口（默认新开窗口，不打断已打开的工程）
//   --timeout <秒>           等待上限，默认 120（Studio 没在运行时要先等它冷启动，且新工程首次打开较慢）
//   --studio  <Studio 目录>  默认 E:\BlueOSStudio
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function opt(name, def) { const i = process.argv.indexOf('--' + name); return i === -1 ? def : process.argv[i + 1]; }
function flag(name) { return process.argv.includes('--' + name); }

/* ------------------------- Studio 安装目录定位 ------------------------- */
// 注意：System32 是原生程序、MSYS 的 /e/... 不行，这里一律用 Node 的 path 拼接。
const SIM_REL = ['resources', 'app', 'extensions', 'blueos-previewer', 'simulator', 'win', 'watch.exe'];
const CLI_REL = ['resources', 'app', 'out', 'cli.js'];

function findStudio(need) {
  const cands = [opt('studio'), process.env.BLUEOS_STUDIO, 'E:\\BlueOSStudio', 'D:\\BlueOSStudio', 'C:\\BlueOSStudio'];
  for (const c of cands) {
    if (c && need.every(rel => fs.existsSync(path.join(c, ...rel)))) return c;
  }
  return null;
}

function studioDir() {
  const s = findStudio([SIM_REL]);
  if (!s) throw new Error('找不到 BlueOS Studio 安装目录（缺 ' + SIM_REL.join('/') + '），用 --studio <目录> 指定');
  return s;
}

function simulatorExe(studio) { return path.join(studio, ...SIM_REL); }

/* --------------------------- Studio 自带 CLI --------------------------- */
// Studio 是 VSCode 二次开发，安装目录 bin/ 下有 blue-os-studio.cmd，内容为
//   set ELECTRON_RUN_AS_NODE=1
//   "BlueOS Studio.exe" "resources/app/out/cli.js" %*
// 这里直接以 Node 模式调 cli.js（绕过 .cmd，避免 Windows 下的 shell 引号问题）。
//
// 唯一有分量的用途是 `--status`：它给出 Studio 自己拉起模拟器时的**真实命令行**，
// 比读 manifest.json 猜设备与包名可靠。
// 注意：需要「连接运行实例」的调用（--status）会在 %APPDATA%\BlueOS Studio\logs\
// 下新建一个只含 cli.log 的空会话目录 —— 这是 Studio 固有行为，不连接实例的命令不会。
function cliTarget() {
  const s = findStudio([CLI_REL]);
  if (!s) return null;
  const exe = path.join(s, 'BlueOS Studio.exe');
  if (!fs.existsSync(exe)) return null;
  return { exe, cli: path.join(s, ...CLI_REL) };
}

function runCli(args) {
  const t = cliTarget();
  if (!t) throw new Error('找不到 Studio 自带 CLI（' + CLI_REL.join('/') + '），用 --studio <目录> 指定');
  const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' });
  const r = spawnSync(t.exe, [t.cli].concat(args), { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

// 解析 --status 输出。形如：
//   Version:          BlueOS Studio 2.2.1 (b713bb4e…, 2026-09-02T14:19:34.147Z)
//   CPU %	Mem MB	   PID	Process
//       0	   117	  6104	blue-os-studio main
//       0	    64	 38284	     e:\...\watch.exe -port 8000 -device watch-square ...
function parseStatus(text) {
  const out = {
    version: '', commit: '', buildTime: '', os: '', cpus: '', memory: '',
    processes: [], simulator: null, simulators: [], windows: [], workspace: '',
  };
  const lines = text.split(/\r?\n/);

  const verLine = (text.match(/^Version:.*$/m) || '')[0] || '';
  const mVer = /^Version:\s+(.+?)\s*\(([0-9a-f]{7,}),\s*(.+?)\)\s*$/.exec(verLine);
  if (mVer) {
    out.version = mVer[1].replace(/^\D*/, '');   // "BlueOS Studio 2.2.1" → "2.2.1"
    out.commit = mVer[2];
    out.buildTime = mVer[3];
  }
  const grab = (label) => {
    const m = new RegExp('^' + label + ':\\s*(.*)$', 'm').exec(text);
    return m ? m[1].trim() : '';
  };
  out.os = grab('OS Version');
  out.cpus = grab('CPUs');
  out.memory = grab('Memory \\(System\\)');

  let inTable = false, inWorkspace = false;
  for (const line of lines) {
    if (/^CPU %\t/.test(line)) { inTable = true; continue; }
    if (/^Workspace Stats:/.test(line)) { inTable = false; inWorkspace = true; continue; }
    if (inTable) {
      // 各列以 tab 分隔；最后一列是带缩进的「进程名 + 参数」
      const parts = line.split(/\t+/);
      if (parts.length < 4) continue;
      const cpu = Number(parts[0]), mem = Number(parts[1]), pid = Number(parts[2]);
      if (!Number.isFinite(pid)) continue;
      let rest = parts.slice(3).join('\t');
      const depth = ((rest.length - rest.replace(/^\s+/, '').length) / 3) | 0;
      rest = rest.trim();
      // 进程名可能是带空格的引号路径（"E:\...\BlueOS Studio.exe" xxx）
      const mq = /^"([^"]+)"\s*(.*)$/.exec(rest);
      const name = mq ? mq[1] : rest.split(/\s+/)[0];
      const args = mq ? mq[2] : rest.slice(name.length).trim();
      out.processes.push({ cpu, memMB: mem, pid, depth, name, args });
    } else if (inWorkspace) {
      if (/^\s*$/.test(line)) inWorkspace = false; else out.workspace += line + '\n';
    }
  }

  // 逐行扫进程表：Studio 多开时每个窗口各带一个 watch.exe。
  // 注意 window 行的解析结果 name='window'、args='[1] (标题)'，所以要用拼起来的整行判断。
  let curWin = null;
  for (const p of out.processes) {
    const fullLine = p.args ? p.name + ' ' + p.args : p.name;
    const mw = /^window \[(\d+)\]/.exec(fullLine);
    if (mw) {
      const mt = /^window \[\d+\]\s*\((.*)\)\s*$/.exec(fullLine);
      curWin = { index: Number(mw[1]), pid: p.pid, title: mt ? mt[1] : '' };
      out.windows.push(curWin);
      continue;
    }
    if (!/watch\.exe/i.test(p.name)) continue;
    const a = {};
    const re = /(-[a-zA-Z]+)\s+("[^"]*"|\S*)/g;
    let m;
    while ((m = re.exec(p.args)) !== null) a[m[1]] = m[2].replace(/^"|"$/g, '');
    out.simulators.push({
      pid: p.pid,
      window: curWin ? curWin.index : null,
      windowTitle: curWin ? curWin.title : '',
      exe: p.name,
      raw: p.args,
      args: a,
      port: Number(a['-port'] || 0),
      device: a['-device'] || '',
      size: (a['-width'] && a['-height']) ? a['-width'] + 'x' + a['-height'] : '',
      package: a['-package'] || '',
      appDir: a['-app'] || '',
      defaultAppDataPath: a['-defaultAppDataPath'] || '',
      type: a['-type'] || '',
    });
  }
  out.simulator = out.simulators[0] || null;
  return out;
}

// 窗口标题形如 "package.json - watch - BlueOS Studio"，中间段就是工程目录名
function windowFolder(title) {
  const parts = String(title || '').split(' - ');
  return parts.length >= 3 ? parts[parts.length - 2] : '';
}

function fetchStatus() {
  const r = runCli(['--status']);
  const text = r.stdout + r.stderr;
  if (!/^Version:/m.test(text)) {
    throw new Error('拿不到 --status 输出（Studio 未运行？）。原始输出：\n' + text.trim().slice(0, 400));
  }
  return parseStatus(text);
}

// 当前已打开的全部工程目录名（Studio 多开时会有多个）
function folderNames(ws) {
  return [...String(ws || '').matchAll(/Folder \(([^)]*)\)/g)].map(m => m[1]);
}

// 模拟器的 -app 指向 <工程>/build，用它把模拟器与工程对应起来
function samePath(appDir, projectDir) {
  const norm = p => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
  return norm(appDir) === norm(path.join(projectDir, 'build'));
}

/* ------------------------------ 进程与端口 ------------------------------ */
// 列出模拟器相关进程 PID（watch.exe / cross.exe）
function listSimPids() {
  const out = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const pids = [];
  for (const line of String(out.stdout || '').split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (!m) continue;
    if (/^(watch|cross)\.exe$/i.test(m[1])) pids.push({ name: m[1], pid: Number(m[2]) });
  }
  return pids;
}

// 模拟器的 -app 指向 <工程>/build，从它反推工程目录名（比解析标题可靠）
function simProject(s) {
  return path.basename(path.dirname(String(s.appDir || '')));
}

// 「哪个进程在监听哪个端口」：窗口渲染进程就是它那个 WS 端口的持有者，
// 用它把模拟器与窗口可靠地配对（比"看进程表里谁在谁下面"稳）。
function listenersByPid() {
  const map = {};
  try {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
    for (const l of out.split(/\r?\n/)) {
      const p = l.trim().split(/\s+/);
      if (p.length < 5 || !/^TCP/i.test(p[0]) || !/LISTENING/i.test(p[3])) continue;
      const port = Number((p[1].match(/:(\d+)$/) || [])[1]);
      const pid = Number(p[4]);
      if (!port || !pid) continue;
      if (map[pid] === undefined || port < map[pid]) map[pid] = port;
    }
  } catch (e) {}
  return map;
}

// 连到本机 <port> 的已建立连接数（= 客户端数：预览器 + 模拟器）。
// 只数「本地端口是 <port> 且状态 ESTABLISHED」的行 —— 一条连接在 netstat 里会出现
// 两行（本机两端各一行），除以 2 在计数为奇数时会算出小数，不可靠。
function countEstablished(port) {
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  let n = 0;
  for (const line of String(out.stdout || '').split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 4 || !/^TCP/i.test(p[0])) continue;
    if (p[3] !== 'ESTABLISHED') continue;
    const localPort = (p[1].match(/:(\d+)$/) || [])[1];
    if (Number(localPort) === port) n++;
  }
  return n;
}

function projectInfo() {
  return new Promise((res, rej) => {
    require('http').get({ host: '127.0.0.1', port: 8001, path: '/api/project_info', timeout: 3000 }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

/* -------------------------------- 命令 -------------------------------- */
async function cmdStatus() {
  const only = Number(opt('port', 0)) || null;   // 只显示某个窗口（按它的 WS 端口）
  const pids = listSimPids();
  let full = null;
  try { full = fetchStatus(); } catch (e) { full = null; }
  const allSims = full ? full.simulators : [];
  const sims = allSims.filter(s => !only || s.port === only);
  const wins = full ? full.windows : [];
  let preview = null;
  try { const p = await projectInfo(); preview = p.data || p; } catch (e) { preview = null; }

  if (flag('json')) {
    console.log(JSON.stringify({
      studio: full ? { version: full.version, commit: full.commit, workspace: full.workspace.trim() } : null,
      windows: wins, simulators: sims, simulator: sims[0] || null,
      processes: pids, preview,
    }, null, 2));
    return;
  }

  if (sims.length) {
    const portByPid = listenersByPid();
    const winList = wins.map(w => Object.assign({}, w, { port: portByPid[w.pid] || null }));
    console.log('Studio 窗口 → 模拟器 :');
    for (const s of sims) {
      const onScan = pids.some(p => p.pid === s.pid);
      const win = winList.find(w => w.port === s.port) || null;
      const label = simProject(s) || windowFolder(s.windowTitle) || '(未知工程)';
      console.log('  window [' + (win ? win.index : (s.window == null ? '?' : s.window)) + ']  ' + label);
      console.log('      PID ' + s.pid + (onScan ? '' : '  ⚠ 进程扫描里没有，可能正在重建') +
        '   设备 ' + s.device + ' ' + s.size + '   WS 端口 ' + s.port);
      console.log('      包名 ' + s.package);
      console.log('      产物 ' + s.appDir);
      console.log('      客户端数 ' + countEstablished(s.port) + ' 个（预览器 + 模拟器）');
    }
    if (sims.length > 1) {
      console.log('');
      console.log('多开提示: 每个窗口占一对连续端口，WS 在 ' + sims.map(s => s.port).join(' / ') +
        '，各自的 HTTP API 在 +1。');
      console.log('          操作指定窗口加 --port <WS端口>，例如：');
      console.log('          node blueos-ws.js shot a.png --port ' + sims[1].port);
    }
  } else if (only) {
    console.log('没有 WS 端口为 ' + only + ' 的模拟器（当前：' +
      (allSims.map(s => s.port).join(', ') || '无') + '）');
  } else {
    console.log('模拟器进程 : ' + (pids.length ? pids.map(p => p.name + '#' + p.pid).join(', ') : '未运行'));
    console.log('  （Studio 未运行或未拉起模拟器，以上为进程扫描结果）');
  }

  if (wins.length) {
    console.log('Studio 窗口数: ' + wins.length + (wins.length > 1 ? '（多开）' : '') + '   ' +
      wins.map(w => '[' + w.index + '] ' + (windowFolder(w.title) || w.title)).join('   '));
  }
  console.log('Studio 预览: ' + (preview
    ? '在线（8001，第一个窗口），当前设备 ' + preview.currentType
    : '离线（8001 无响应）'));
}

function cmdSimArgs() {
  const only = Number(opt('port', 0)) || null;   // 多开时用它选窗口
  let full = null;
  try { full = fetchStatus(); } catch (e) { full = null; }
  const sims = full ? full.simulators : [];
  const auth = only ? sims.find(s => s.port === only) : sims[0];
  if (!auth) {
    console.error('[ERR] 拿不到模拟器信息' + (only
      ? '（没有 WS 端口 ' + only + ' 的模拟器；当前 ' + (sims.map(s => s.port).join(', ') || '无') + '）'
      : '（Studio 未运行，或模拟器未启动）'));
    process.exit(1);
  }
  if (flag('json')) { console.log(JSON.stringify(auth, null, 2)); return; }
  console.log('exe=' + auth.exe);
  console.log('pid=' + auth.pid);
  console.log('device=' + auth.device);
  console.log('size=' + auth.size);
  console.log('package=' + auth.package);
  console.log('port=' + auth.port);
  console.log('app=' + auth.appDir);
}

function start() {
  const studio = studioDir();
  const exe = simulatorExe(studio);
  const project = path.resolve(opt('project', process.cwd()));
  const device = opt('device', 'watch-square');
  const [w, h] = String(opt('size', '390x450')).split('x').map(Number);
  const port = opt('port', 8000);

  const manifest = path.join(project, 'build', device, 'manifest.json');
  if (!fs.existsSync(manifest)) throw new Error('找不到构建产物：' + manifest + '（先在 Studio 里编译一次，或用 blueos-build.js 构建）');
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')).package;
  if (!pkg) throw new Error('manifest.json 里没有 package 字段');

  const appData = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'), 'BlueOSStudio');
  // 参数与 Studio 自己拉起的完全一致（含末尾四个空参数）
  const args = [
    '-port', String(port), '-device', device, '-package', pkg,
    '-app', path.join(project, 'build'),
    '-compilePath', '', '-compileQuery', '',
    '-defaultAppDataPath', appData,
    '-width', String(w), '-height', String(h),
    '-appUpdateMethod', '0', '-type', 'app',
    '-intrpkPackage', '', '-moduleName', '',
  ];
  console.log('[start] ' + exe);
  console.log('        ' + args.join(' '));
  const child = spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
  child.unref();
  console.log('[OK] 模拟器已启动 PID ' + child.pid + '（包名 ' + pkg + '，设备 ' + device + ' ' + w + 'x' + h + '）');
  console.log('     等 3~8 秒后可用 blueos-ws.js probe / shot 验证');
}

function stop() {
  const pids = listSimPids();
  if (!pids.length) { console.log('没有在运行的模拟器进程'); return; }
  for (const p of pids) {
    spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    console.log('[OK] 已结束 ' + p.name + '#' + p.pid);
  }
}

/* ---------------------------- 切换工程（换目录） ---------------------------- */
// 模拟器的设备、包名、产物目录都跟着 **Studio 当前工作区** 走（每工作区配置在
// .ide/settings.json），所以「换工程」没法靠改文件或重开模拟器解决 —— 必须让 Studio
// 打开目标目录。本命令就是干这个的。
//
// 为什么不用 bin/blue-os-studio.cmd（踩过，两处坑）：
//   1. 它把 ELECTRON_RUN_AS_NODE=1 传下去，而 cli.js 在 Windows 上是 spawn 出真正的
//      Studio 实例后**立刻自己退出**。被 spawn 的实例还在启动就被回收，参数没转发出去，
//      表现为「静默无效、退出码 0」。给它加 --verbose（父进程会等子进程）就正常 —— 但
//      会刷一屏 main 日志。
//   2. 因此这里绕过 cli.js：直接用 Node 起 "BlueOS Studio.exe"（App 模式），并**等它退出**
//      （实例转发完参数就会自己退，约 1~3 秒）。
// 关键细节：必须 delete 掉继承来的 ELECTRON_RUN_AS_NODE。本机 shell 环境里它通常已是 1
// （宿主是 Electron 应用），不删的话 exe 会以 Node 模式运行，任何 Studio 参数都会变成
// `bad option: --xxx` 并退出码 9。注意设成 "0" 也算「已定义」，一样会踩坑 —— 只能删。
async function cmdOpen() {
  const studio = studioDir();
  const exe = path.join(studio, 'BlueOS Studio.exe');
  if (!fs.existsSync(exe)) throw new Error('找不到 ' + exe + '（用 --studio <目录> 指定）');

  const target = path.resolve(process.argv[3] || opt('project', process.cwd()));
  if (!fs.existsSync(target)) throw new Error('目录不存在：' + target);
  if (!fs.existsSync(path.join(target, 'src', 'manifest.json')) && !fs.existsSync(path.join(target, 'build'))) {
    console.log('[warn] ' + target + ' 下既没有 src/manifest.json 也没有 build/，可能不是 BlueOS 工程');
  }
  if (/[^\x00-\x7F]/.test(target) || /\s/.test(target)) {
    console.log('[warn] 工程路径含中文或空格，Studio 官方要求避免，构建可能失败');
  }

  // 默认新开窗口：不打断已在跑的工程（Studio 可多开，每个窗口各带一个模拟器）。
  // --here 才复用最后一个活动窗口（会顶掉那个窗口原来的工程）。
  const reuse = flag('here');
  const winFlag = reuse ? '--reuse-window' : '--new-window';

  const wasRunning = (() => { try { fetchStatus(); return true; } catch (e) { return false; } })();
  const before = [...new Set(folderNames(readWorkspace()))];
  console.log('[open] 目标工程 : ' + target);
  console.log('       方式     : ' + (reuse ? '复用当前窗口（原工程会被替换）' : '新开窗口（原工程保持运行）'));
  if (!wasRunning) console.log('       Studio   : 原未运行，本次为冷启动（要多等一会儿 IDE 起来）');
  if (before.length) console.log('       已打开   : ' + before.join(', '));

  const want = path.basename(target).toLowerCase();
  if (before.some(f => f.toLowerCase() === want)) {
    let s0 = null;
    try { s0 = (fetchStatus().simulators || []).find(s => samePath(s.appDir, target)) || null; } catch (e) {}
    console.log('[skip] 该工程已经打开，未重复操作');
    if (s0) console.log('       模拟器 : WS 端口 ' + s0.port + '  PID ' + s0.pid + '  包名 ' + s0.package);
    return;
  }

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;            // 只能删，不能设成 "0"
  // ⚠️ 不要用 spawnSync 等它退出。
  //   Studio 已在运行时：这个 exe 只是「把参数转发给现有实例」的短命进程，1~3 秒就退；
  //   Studio 没在运行时：这个 exe 就是 **Studio 本体**，会一直活着。
  // 早先版本用 spawnSync + timeout 等它，冷启动时会在超时后把 Studio 杀掉
  // （实测：报 `spawnSync ... ETIMEDOUT`，且刚拉起的 Studio 随即消失）。
  // 改为分离启动、不等它，成功与否一律由下面的轮询判定。
  const child = spawn(exe, [winFlag, target], { env, detached: true, stdio: 'ignore' });
  child.on('error', e => console.log('[warn] 拉起 Studio 出错：' + e.message));
  child.unref();

  // 等目标工程出现（多开时其它窗口的 Folder 也在列表里，只判断有没有它），
  // 再等它的模拟器起来，顺便拿到 WS 端口。
  // 新窗口首次打开一个"从没被 Studio 打开过"的工程时，预览器要更久才拉模拟器
  // （实测 15~30 秒）；若 Studio 本来就没在运行，还要先等 IDE 自己冷启动，
  // 所以默认给到 120 秒，别过早放弃。
  const deadline = Date.now() + Number(opt('timeout', 120)) * 1000;
  let seen = false, sim = null, matchedAt = 0, full = null;
  while (Date.now() < deadline) {
    full = null;
    try { full = fetchStatus(); } catch (e) { full = null; }
    if (full) {
      seen = folderNames(full.workspace).some(f => f.toLowerCase() === want);
      sim = (full.simulators || []).find(s => samePath(s.appDir, target)) || null;
    }
    if (seen) {
      matchedAt = matchedAt || Date.now();
      if (sim) break;                                  // 模拟器也按新工程重建好了
      if (Date.now() - matchedAt > 30000) break;       // 工程已打开，模拟器还没起来就别再等
    }
    await new Promise(res => setTimeout(res, 2000));
  }

  if (!seen) {
    console.error('[ERR] 等超时（' + Number(opt('timeout', 120)) + 's），没看到工程「' + want + '」被打开');
    console.error('      可能原因：① Studio 刚冷启动，再多给点时间（--timeout 180）');
    console.error('      ② 环境变量 ELECTRON_RUN_AS_NODE 没删干净（设成 "0" 也算没删）');
    process.exit(1);
  }
  console.log('[OK] 工程「' + want + '」已打开' + (reuse ? '（复用当前窗口）' : '（新窗口）'));
  if (sim) {
    console.log('     模拟器 : WS 端口 ' + sim.port + '  PID ' + sim.pid +
      '  设备 ' + sim.device + ' ' + sim.size + '  包名 ' + sim.package);
    console.log('     产物   : ' + sim.appDir);
    const others = (full && full.simulators ? full.simulators : []).filter(s => s.pid !== sim.pid);
    if (others.length) {
      console.log('     其它工程仍在跑: ' +
        others.map(s => (simProject(s) || '?') + ' @' + s.port).join('，'));
    }
    console.log('     操作这个工程要带端口，例如: blueos-ws.js shot out.png --port ' + sim.port);
  } else {
    console.log('     （模拟器还没起来。新工程首次打开可能要等 30 秒以上，');
    console.log('       稍后跑 status 复核；或在 Studio 里点一下预览面板催一下）');
  }

  if (!wasRunning) {
    console.log('');
    console.log('     注：Studio 是本次由本命令冷启动的。在受限执行环境（沙箱／自动化）里，');
    console.log('         子进程可能随命令结束被一并回收，Studio 窗口会跟着消失。');
    console.log('         遇到这种情况，先手动启动 Studio，再运行本命令即可。');
  }
}

function readWorkspace() {
  try { return fetchStatus().workspace; } catch (e) { return ''; }
}

/* -------------------------------- 入口 -------------------------------- */
(async () => {
  const cmd = process.argv[2];
  try {
    if (cmd === 'status') await cmdStatus();
    else if (cmd === 'sim-args') cmdSimArgs();
    else if (cmd === 'open') await cmdOpen();
    else if (cmd === 'start') start();
    else if (cmd === 'stop') stop();
    else console.log('用法: node blueos-sim.js status [--json] [--port <WS端口>] | sim-args [--json] [--port] | open <项目目录> [--here] | start | stop\n' +
      '      start 选项: [--project <目录>] [--device <设备>] [--size WxH] [--port 8000] [--studio <目录>]\n' +
      '      open  选项: [--here] [--timeout <秒>] [--studio <目录>]');
  } catch (e) { console.error('[ERR] ' + e.message); process.exit(1); }
})();
