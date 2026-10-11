#!/usr/bin/env node
// BlueOS Studio / 模拟器 控制工具（零依赖）
//
// 原理：BlueOS Studio 渲染进程里跑着一个 WebSocket 服务（默认 8000 端口），
// 按 URL 路径给客户端分角色：
//     /client    预览器   —— 我们接这里；能收到 simulatorToPreview 广播（含画面帧）
//     /simulator 模拟器   —— watch.exe 专用，外部不要占用（会挤掉真模拟器！）
//     /cdp, /error-inspector  其它角色
// 事件四类：previewToServer / serverToPreview / previewToSimulator / simulatorToPreview
//
// Studio 可多开，每个窗口占**一对连续端口**：WS 在 <base>，其 HTTP API 在 <base>+1。
//   window1 = 8000 / 8001      window2 = 8002 / 8003      window3 = 8004 / 8005 …
// 默认只作用于第一个窗口；要操作其它窗口加 `--port <WS端口>`（如 --port 8002）。
//
// 用法：node blueos-ws.js <命令> [参数]
//   --port <WS端口>                指定目标窗口（默认 8000）；–api 可覆盖其 API 端口
//   --delay <ms>                   交互命令：注入后额外等待再返回（页面跳转/动画需要时间时用）
//   probe                          体检：端口 / 模拟器 / 预览器 / 当前工程与设备
//   shot <out.png> [--delay <ms>] [--settle <ms>] [--timeout 8000] [--repaint] [--shell [--bg <色>]]
//                                  原生截图（模拟器帧，原生分辨率，不抓屏不裁切）
//                                  默认取「最新」一帧（即时返回），且不打扰应用；
//                                  --delay 先等 N ms 再截（让页面跳转/动画走完）；
//                                  --settle 等到画面连续 N ms 无新帧再截（自动等静止）；
//                                  --repaint 主动请求重绘（默认不发：有的应用会把
//                                  重绘当成 resize 而重置页面栈，导致点完截图截错页）；
//                                  --shell（别名 --bezel）把裸帧套进当前设备的外壳
//                                  （表盘/表圈，取自 Studio 预览器自带素材），输出带外壳的
//                                  PNG「整机照」；--bg <#rrggbb|white|black> 给透明处填底色
//                                  （默认透明）
//   watch [秒数]                   打印消息流（调试用，updateUI 只显示长度）
//   tap <x> <y>                    点击
//   swipe <x1> <y1> <x2> <y2> [ms] 滑动
//   key <keyCode> [pressType]      按键（pressType 默认 1）
//   crown <delta>                  表冠旋转（正=顺时针）
//   back | home                    返回 / 回首页
//   reload                         重启应用
//   size <w> <h>                   切换分辨率
//   device <type>                  切换设备（watch-round / watch-square / phone ...），分辨率随之变
//                                  （= POST /api/set_device + WS switchDevice/size/reload 四步；
//                                   模拟器会重启并重编译，耗时约 5-8s）
//   run | stop-run                 执行 / 停止 .autorun.json
//   rec | stop-rec                 开始 / 停止录制脚本（把注入的点击录成 autorun 脚本）
//   pages <outDir>                 按 .autorun.json 逐页导航并原生截图
//   replace-page <path> [query]    替换当前页（不走页面栈，与 push 不同）
//   widgets [--json]               列出当前工程的卡片（名称/类型/尺寸/数据源）
//   app-mode <app|widget>          切换应用形态（应用 / 卡片）
//   widget [卡片名]                切到卡片形态并选中卡片；不给名字 = 该工程唯一那张
//   errors [--json]                取编译/运行错误（/error-inspector，带文件行列与代码帧）
//   dom [out.json] [--json]        经 /cdp 抓 UI 元素树（结构/类名/事件绑定，无几何信息）
//   mock get | mock set <json>     经 /cdp 读写 Mock 数据
//   gc                             触发垃圾回收（MultiMemory.gc + HeapProfiler）
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/* ------------------------------ 基础工具 ------------------------------ */
function opt(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? def : process.argv[i + 1];
}
function flag(name) { return process.argv.includes('--' + name); }

// PowerShell 单引号字面量：内部不插值，单引号自身写成两个。
// 不要用 JSON.stringify 拼 PS 命令 —— 那是双引号，PS 会展开 $() 和 $var，
// 文件名里塞个 $(...) 就能执行任意命令（本工具的路径来自 argv）。
function psq(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 等「第一帧」到达（供即时截图用），最多等 cap ms
async function waitFirstFrame(frames, cap) {
  const t0 = Date.now();
  while (!frames.length && Date.now() - t0 < cap) await sleep(40);
  return frames.length > 0;
}

// 等「画面静止」：连续 quiet ms 没有新帧即返回 true；超过 timeout ms 返回 false。
// 用于「点击后页面还在跳转/播动画」的场景 —— 帧停下来的那一刻就是终态画面。
async function waitQuiet(getCount, timeout, quiet) {
  const t0 = Date.now();
  let last = getCount(), lastChange = Date.now();
  while (Date.now() - t0 < timeout) {
    await sleep(60);
    const n = getCount();
    if (n !== last) { last = n; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= quiet) return true;
  }
  return false;
}

function httpGet(port, p, method = 'GET', body = null) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: p, method, timeout: 5000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, resp => {
      let b = ''; resp.on('data', d => b += d);
      resp.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res({ raw: b }); } });
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

// 最小 WebSocket 客户端（0x1 文本帧 + 分片重组 + ping/pong）
function wsConnect(port, p, onMessage) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port, path: p,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
        Origin: 'http://127.0.0.1:' + port,
      },
    });
    req.on('upgrade', (resp, socket) => {
      const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (resp.headers['sec-websocket-accept'] !== acc) return reject(new Error('WebSocket 握手失败'));
      const c = { socket, buf: Buffer.alloc(0) };
      socket.on('data', d => { c.buf = Buffer.concat([c.buf, d]); c._drain(); });
      socket.on('close', () => c.onclose && c.onclose());
      socket.on('error', () => {});
      c._frame = (op, data) => {
        const q = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        const mask = crypto.randomBytes(4);
        let hdr;
        if (q.length < 126) hdr = Buffer.from([0x80 | op, 0x80 | q.length]);
        else if (q.length < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | op; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(q.length, 2); }
        else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | op; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(q.length), 2); }
        const m = Buffer.alloc(q.length);
        for (let i = 0; i < q.length; i++) m[i] = q[i] ^ mask[i % 4];
        socket.write(Buffer.concat([hdr, mask, m]));
      };
      let frag = [];
      c._drain = () => {
        for (;;) {
          const b = c.buf; if (b.length < 2) return;
          const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f;
          let len = b[1] & 0x7f, off = 2;
          if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
          if (b.length < off + len) return;
          const pl = b.slice(off, off + len); c.buf = b.slice(off + len);
          if (op === 0x0) { frag.push(pl); if (fin) { const f = Buffer.concat(frag); frag = []; onMessage && onMessage(f.toString('utf8')); } }
          else if (op === 0x1) { if (fin) onMessage && onMessage(pl.toString('utf8')); else frag = [pl]; }
          else if (op === 0x8) { socket.end(); return; }
          else if (op === 0x9) c._frame(0xA, pl);   // ping -> pong
        }
      };
      c.sendMsg = (event, payload) => c._frame(0x1, JSON.stringify({ event, payload }));
      // /cdp 与 /error-inspector 用裸 JSON-RPC 风格消息（无 event 包裹）
      c.sendRaw = obj => c._frame(0x1, JSON.stringify(obj));
      c.close = () => { try { c._frame(0x8, Buffer.alloc(0)); } catch (e) {} socket.end(); };
      resolve(c);
    });
    req.on('error', reject);
    req.end();
  });
}

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

// 定位「哪一个窗口」。Studio 多开时每个窗口占一对连续端口：
//   80 00 → WS，8001 → 它的 HTTP API；下一个窗口就是 8002 / 8003。
// 不给 --port 时按老行为从 8001 探测第一个窗口；给了就直奔 <port>+1 取元信息，
// 免得拿到另一个窗口的设备与分辨率（截图会因此错位）。
async function learnContext() {
  const wsPort = Number(opt('port', 0)) || null;
  const apiPort = Number(opt('api', 0)) || (wsPort ? wsPort + 1 : 8001);
  let meta = null;
  try { meta = await httpGet(apiPort, '/api/project_info'); } catch (e) {}
  const port = wsPort || meta?.data?.port || 8000;
  let size = { width: 390, height: 450 }, device = 'watch-square';
  if (meta?.data) {
    device = meta.data.currentType || device;
    const s = meta.data.sizeMap?.[device];
    if (s) size = { width: s.width, height: s.height };
  }
  return { port, apiPort, meta, size, device };
}

/* ------------------------------ 命令实现 ------------------------------ */
async function cmdProbe() {
  const ctx = await learnContext();
  console.log('== BlueOS Studio 体检 ==');
  if (ctx.meta) {
    const d = ctx.meta.data;
    console.log('  Studio 预览服务 : 在线 (127.0.0.1:' + ctx.apiPort + ')');
    console.log('  WS 端口         : ' + ctx.port + (ctx.port === 8000 ? '（第一个窗口）' : ''));
    console.log('  当前设备        : ' + d.currentType + '  (' + ctx.size.width + 'x' + ctx.size.height + ')');
    console.log('  可选设备        : ' + (d.deviceTypeList || []).map(x => x.type + (x.isActive ? '*' : '')).join(', '));
    const wl = d.projectInfo?.widgetModuleNameList || [];
    console.log('  应用形态' + ' '.repeat(8) + ': ' + d.appMode +
      (d.widgetModuleName ? '  →  ' + d.widgetModuleName : '') +
      '   ' + (wl.length ? '卡片: ' + wl.join(', ') : '无卡片'));
    console.log('  主题/语言       : ' + d.theme + ' / ' + d.currentProjectLanguage);
    console.log('  版本            : ' + d.productVersion);
    console.log('  可换分辨率      : ' + ((d.sizeSetting?.[d.currentType]?.list) || []).map(s => s.label).join(', '));
  } else {
    console.log('  Studio 预览服务 : 离线（' + ctx.apiPort + ' 无响应）');
  }
  // 数一下该端口上的连接（一条连接在 netstat 里出现两行，只数本地端口那一行）
  let established = 0;
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    for (const l of out.split(/\r?\n/)) {
      const p = l.trim().split(/\s+/);
      if (p.length < 4 || !/^TCP/i.test(p[0]) || p[3] !== 'ESTABLISHED') continue;
      if (Number((p[1].match(/:(\d+)$/) || [])[1]) === ctx.port) established++;
    }
  } catch (e) {}
  console.log('  ' + ctx.port + ' 已连接方   : ' + established + ' 个（预览器 + 模拟器）');
  return ctx;
}

/* ---------------------- 卡片（widget / 应用形态） ----------------------
 * 卡片 = 蓝河的第三种应用形态，用户在表盘界面左滑看到的一屏一卡。
 * 清单、当前形态都来自 8001 的 /api/project_info，不用连 WS 就能查。
 * 切形态靠 POST /api/set_device（带 appMode + widgetModuleName）。
 */
const WIDGET_KIND = { js: '标准卡', lite: '轻卡' };

function readWidgets(meta) {
  const pi = meta?.data?.projectInfo || {};
  const map = pi.widgets || {};
  return (pi.widgetModuleNameList || []).map(name => {
    const w = map[name] || {};
    return {
      name,
      type: w.type || '',
      title: w.name || '',
      description: w.description || '',
      component: w.component || '',
      sizes: w.sizes || [],
      providerUri: w.providerUri || '',
      providerPackage: w.providerPackage || '',
    };
  });
}

function requireMeta(ctx) {
  if (!ctx.meta) throw new Error('Studio 预览服务无响应（127.0.0.1:' + ctx.apiPort + '）。Studio 未启动？');
  return ctx.meta.data;
}

async function cmdWidgets() {
  const ctx = await learnContext();
  const d = requireMeta(ctx);
  const list = readWidgets(ctx.meta);
  if (flag('json')) {
    console.log(JSON.stringify({
      appMode: d.appMode,
      widgetModuleName: d.widgetModuleName,
      appModeOptions: d.appModeOptions || [],
      hasPages: !!d.projectInfo?.hasPages,
      hasWidgets: !!d.projectInfo?.hasWidgets,
      widgets: list,
    }, null, 2));
    return;
  }
  console.log('== 卡片（widget）==');
  console.log('  当前形态   : ' + d.appMode + (d.widgetModuleName ? '  →  ' + d.widgetModuleName : '') +
    '     可切: ' + (d.appModeOptions || []).join(' / '));
  console.log('  工程内容   : ' + (d.projectInfo?.hasPages ? '有页面' : '无页面') +
    (d.projectInfo?.hasWidgets ? ' + 有卡片' : ' + 无卡片'));
  if (!list.length) { console.log('  （该工程没有卡片模块）'); return; }
  console.log('  卡片数     : ' + list.length);
  for (const w of list) {
    console.log('');
    console.log('  ● ' + w.name + '   [' + (WIDGET_KIND[w.type] || w.type || '?') + ']' + (w.title ? '  ' + w.title : ''));
    if (w.description) console.log('      描述   : ' + w.description);
    if (w.sizes.length) console.log('      尺寸   : ' + w.sizes.join(', '));
    if (w.component) console.log('      组件   : ' + w.component);
    if (w.providerUri) console.log('      数据源 : ' + w.providerUri + (w.providerPackage ? '   (来自包 ' + w.providerPackage + ')' : ''));
  }
}

// 切完不是同步生效的（Studio 可能还在重编译），轮询 /api/project_info 直到状态符合预期。
// ⚠️ 起手必须先静置一会儿：宿主改状态是异步的，而紧跟 POST 的一次 GET 会让它把状态按
// 「尚未重绘的预览器」回写，等于把刚改的形态吃掉 —— 现象是接口返回 success、状态却
// 几十秒纹丝不动（切回 app 反而「看起来成功」，因为目标值本来就等于被回写的旧值）。
async function waitProjectState(apiPort, want, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  await sleep(900);
  for (;;) {
    try { const m = await httpGet(apiPort, '/api/project_info'); if (m?.data) last = m.data; } catch (e) {}
    if (last && Object.entries(want).every(([k, v]) => last[k] === v)) return last;
    if (Date.now() - t0 >= timeoutMs) return last;
    await sleep(700);
  }
}

// 重载后画面会先变成空白过渡帧（约 1KB）再重绘。这里连一次 /client 等「真画面」出来
// 且稳定下来再返回 —— 否则调用方紧接着 shot 会截到那张空白帧。
async function waitRedraw(port, timeoutMs) {
  const frames = [];
  let c = null;
  try {
    c = await wsConnect(port, '/client', txt => {
      let msg; try { msg = JSON.parse(txt); } catch (e) { return; }
      if (msg.event !== 'simulatorToPreview' || msg.payload?.method !== 'updateUI') return;
      const buf = Buffer.from(msg.payload.params || '', 'base64');
      if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return;
      frames.push(buf.length);
    });
    c.sendMsg('previewToSimulator', { method: 'on' });
    const t0 = Date.now();
    let seen = 0, lastChange = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(120);
      if (frames.length !== seen) { seen = frames.length; lastChange = Date.now(); }
      const last = frames.length ? frames[frames.length - 1] : 0;
      if (last > 3000 && Date.now() - lastChange >= 600) return true;
    }
    return false;
  } catch (e) {
    return false;
  } finally {
    if (c) c.close();
  }
}


// 切换应用形态 / 选中卡片（三步，顺序不能换）：
//   ① POST /api/set_device 带上 appMode + widgetModuleName —— 这才是真正改状态的动作；
//   ② 等状态落定（起手静置后再轮询，见 waitProjectState 的注释）；
//   ③ 再发 previewToSimulator/reload 让模拟器重载 —— 否则状态变了、画面纹丝不动。
// ⚠️ /api/switch_widget 单独调是「静默无效」的：返回 success，但 appMode 与
// widgetModuleName 纹丝不动，所以本命令不发它。
async function cmdSwitchMode(want) {
  const ctx = await learnContext();
  const d = requireMeta(ctx);
  const list = readWidgets(ctx.meta);

  const appMode = want.appMode || d.appMode;
  const options = d.appModeOptions || ['app'];
  if (!options.includes(appMode)) {
    throw new Error('该工程不支持形态「' + appMode + '」，可选: ' + options.join(' / '));
  }
  // 切回 app 时必须把 widgetModuleName 清空，别把上一张卡片名一起带过去 ——
  // 否则宿主会认为仍是卡片形态，状态切不干净。
  let widgetModuleName = want.widgetModuleName !== undefined ? want.widgetModuleName : (d.widgetModuleName || '');
  if (appMode === 'app') widgetModuleName = '';
  else if (!widgetModuleName) widgetModuleName = list[0]?.name || '';
  if (appMode === 'widget' && !widgetModuleName) throw new Error('该工程没有卡片模块，切不到卡片形态');
  if (widgetModuleName && !list.some(w => w.name === widgetModuleName)) {
    throw new Error('没有这张卡片: ' + widgetModuleName + '\n  可用: ' + (list.map(w => w.name).join(', ') || '(无)'));
  }

  const device = d.currentType;
  const size = d.sizeMap?.[device] || ctx.size;
  const otherSetting = d.otherSetting || '';
  const timeout = Math.max(3, Number(opt('timeout', 0)) || 25) * 1000;

  // 形态与卡片都由这一条 set_device 带过去。
  const r1 = await httpGet(ctx.apiPort, '/api/set_device', 'POST', { device, size, appMode, widgetModuleName, otherSetting });
  if (r1 && r1.code !== undefined && r1.code !== 0) throw new Error('/api/set_device 失败: ' + JSON.stringify(r1));
  // 不要在这里再补一条 /api/switch_widget：单独调它是**静默无效**的
  // （返回 success，appMode / widgetModuleName 纹丝不动），帮不上忙。

  const target = { appMode };
  if (appMode === 'widget') target.widgetModuleName = widgetModuleName;
  const got = await waitProjectState(ctx.apiPort, target, timeout);
  const ok = !!got && Object.entries(target).every(([k, v]) => got[k] === v);
  if (!ok) {
    console.log('[warn] ' + timeout + 'ms 内未确认切换完成（Studio 可能仍在重编译）。当前: ' +
      (got ? got.appMode + (got.widgetModuleName ? '  →  ' + got.widgetModuleName : '') : '读取失败'));
    console.log('       可稍后用 `blueos-ws.js widgets` 复核，或加 --timeout 再等久些');
    return;
  }

  // 状态生效 ≠ 画面跟着变。实测：只发 set_device 时 project_info 已经是 widget，
  // 模拟器却仍然在渲染应用，截出来的还是上一屏。必须再让模拟器重载一次
  // —— 与 IDE 的做法一致（它切形态时也会发这条带 compileOptions 的 reload）。
  // 顺序很关键：必须在状态**确认之后**发，先发会把刚切好的形态顶回去。
  await withClient(async (c) => {
    c.sendMsg('previewToSimulator', {
      method: 'reload',
      params: { device, compileOptions: { defineOptions: { OTHER_VARIABLES: otherSetting } } },
    });
    await sleep(400);
  });
  // 给模拟器一点重载时间：等到「真画面」出现且稳定再返回，调用方紧接着 shot 才不会截到空白帧。
  const redrawn = await waitRedraw(ctx.port, Math.min(timeout, 15000));
  if (!redrawn) console.log('[info] 未等到画面稳定，紧接着截图可能拿到过渡帧；可稍等再 shot');

  console.log('[OK] 应用形态: ' + appMode + (appMode === 'widget' ? '   卡片: ' + widgetModuleName : ''));
  if (appMode === 'widget') {
    const w = list.find(x => x.name === widgetModuleName) || {};
    console.log('     ' + (WIDGET_KIND[w.type] || w.type || '') + (w.title ? '  ' + w.title : '') +
      (w.sizes?.length ? '   尺寸 ' + w.sizes.join('/') : ''));
    console.log('     提示: 卡片渲染在宿主容器里，不是整屏；截图建议加 --settle 等画面落定');
  }
}

// 切换设备（分辨率随之变）。与 app-mode 同样的三步 + 一条 WS 指令：
//   ① POST /api/set_device 带 device + size（size 取自 sizeMap）—— 改 Studio 侧状态；
//   ② 等状态落定（currentType == device）；
//   ③ WS 依次发 switchDevice + size —— **这一步才真正让模拟器换分辨率**。
//      实测：只 POST set_device + reload，Studio 状态已是 watch-round、模拟器帧却仍是
//      390x450；补上 switchDevice+size 后，模拟器会退出并重启（事件流里有
//      「模拟器异常退出-0-null」+ 重新编译），接着帧就变成 466x466 了。
//      只发 WS switchDevice（不 POST）同样不行：状态与画面都不动。
//   ④ 再发 reload 确保新设备的目标已编译（首次切到该设备要重编译，约 3s）。
async function cmdSetDevice(device) {
  if (!device) throw new Error('用法: blueos-ws.js device <watch-round|watch-square|phone|foldable|tablet|tv|car|multi>');
  const ctx = await learnContext();
  const d = requireMeta(ctx);
  const sm = d.sizeMap?.[device];
  if (!sm) throw new Error('未知设备: ' + device + '\n  可用: ' + Object.keys(d.sizeMap || {}).join(', '));
  if (d.currentType === device) { console.log('[info] 已是 ' + device + '，无需切换'); return; }

  const appMode = d.appMode || 'app';
  const widgetModuleName = appMode === 'widget' ? (d.widgetModuleName || '') : '';
  const otherSetting = d.otherSetting || '';
  const timeout = Math.max(4, Number(opt('timeout', 0)) || 30) * 1000;

  const r1 = await httpGet(ctx.apiPort, '/api/set_device', 'POST', { device, size: sm, appMode, widgetModuleName, otherSetting });
  if (r1 && r1.code !== undefined && r1.code !== 0) throw new Error('/api/set_device 失败: ' + JSON.stringify(r1));

  const got = await waitProjectState(ctx.apiPort, { currentType: device }, timeout);
  if (!(got && got.currentType === device)) {
    console.log('[warn] ' + timeout + 'ms 内未确认切到 ' + device + '（Studio 可能仍在重编译）。当前: ' +
      (got ? got.currentType : '读取失败'));
  }

  await withClient(async (c) => {
    c.sendMsg('previewToSimulator', { method: 'switchDevice', params: { device, width: sm.width, height: sm.height } });
    await sleep(1200);
    c.sendMsg('previewToSimulator', { method: 'size', params: { width: sm.width, height: sm.height } });
    await sleep(1200);
    c.sendMsg('previewToSimulator', {
      method: 'reload',
      params: { device, compileOptions: { defineOptions: { OTHER_VARIABLES: otherSetting } } },
    });
    await sleep(400);
  });
  const redrawn = await waitRedraw(ctx.port, Math.min(timeout, 20000));
  console.log('[OK] 设备: ' + device + '  ' + sm.width + 'x' + sm.height);
  if (!redrawn) console.log('[info] 未等到画面稳定，紧接着截图可能拿到过渡帧；可稍等再 shot');
}

/* ---------------------- 带表壳截图（套用预览器的设备外壳） ----------------------
 * Studio 预览面板本身就是把「裸屏幕画布」叠在「设备外观图」上显示的：
 *   client/watch-round.png (565x897) 圆表、client/watch-square.png (446x799) 方表，
 *   另有 phone/foldable/tablet/tv/car 等外壳。
 * 屏幕相对外壳的尺寸由预览器里的两张常量表决定（从 client/index-*.js 反查得到）：
 *   N = 设备原生分辨率；R = 屏幕显示尺寸；S = 外壳显示尺寸
 *   → 屏幕在外壳素材里的实际矩形 = R / S × 外壳原始尺寸，且**居中**。
 *     （用方表验证：245/300×446=364.2、283/510×799=443.2，与外壳透明孔的实测
 *       364x443 完全吻合，说明模型正确。）
 * 于是自己就能把裸帧贴进外壳：
 *   · 外壳中心透明（方表，是个圆角方孔）→ 先画屏幕、再叠外壳，孔自然遮罩；
 *   · 外壳中心不透明（圆表，黑表面）    → 屏幕画底层、外壳抠洞盖顶层。
 * 素材：优先用随仓库自带的 assets/shell/（不装 Studio 也能出图），缺失时回退本地 Studio 目录。
 */
const SHELL_STUDIO_DIR = 'E:\\BlueOSStudio\\resources\\app\\extensions\\blueos-previewer\\client';
const SHELL_BUNDLED_DIR = path.join(__dirname, '..', 'assets', 'shell');
const SHELL_DIR = fs.existsSync(SHELL_BUNDLED_DIR) ? SHELL_BUNDLED_DIR : SHELL_STUDIO_DIR;
const SHELL_FILE = { 'watch-round': 'watch-round.png', 'watch-square': 'watch-square.png', phone: 'phone.png', foldable: 'foldable.png', tablet: 'tablet.png', tv: 'tv.png', car: 'car.png', multi: 'multi.png' };
// 逐文件解析：自带素材里没有的（如 car/multi）再回退 Studio 目录
function resolveShell(file) {
  for (const d of [SHELL_BUNDLED_DIR, SHELL_STUDIO_DIR]) {
    const p = path.join(d, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const DEV_SCREEN = { 'watch-round': { w: 244, h: 244 }, 'watch-square': { w: 245, h: 283 }, phone: { w: 219, h: 485 }, foldable: { w: 339, h: 382 }, tablet: { w: 516, h: 344 }, multi: { w: 600, h: 500 }, tv: { w: 418, h: 230 }, car: { w: 415, h: 260 } };
const DEV_SHELL_SIZE = { 'watch-round': { w: 300, h: 476 }, 'watch-square': { w: 300, h: 510 }, phone: { w: 240, h: 514 }, foldable: { w: 359, h: 406 }, tablet: { w: 550, h: 376 }, multi: { w: 608, h: 508 }, tv: { w: 450, h: 272 }, car: { w: 438, h: 283 } };
const ROUND_DEVICES = { 'watch-round': 1, watch: 1 };

// 用 System.Drawing 把裸帧合成进设备外壳，输出 PNG（零依赖）
function compositeShell(rawJpg, device, outPng, bg) {
  const file = SHELL_FILE[device];
  const shell = file && resolveShell(file);
  if (!shell) throw new Error('设备 ' + device + ' 没有外壳素材');
  const r = DEV_SCREEN[device], s = DEV_SHELL_SIZE[device];
  if (!r || !s) throw new Error('设备 ' + device + ' 缺少屏幕/外壳尺寸表');
  const named = { white: 'White', black: 'Black' }[String(bg || '').toLowerCase()];
  const clearLine = !bg ? '$g.Clear([System.Drawing.Color]::Transparent)'
    : '$g.Clear([System.Drawing.Color]::' + (named || 'Transparent') + ')';
  const hexLine = (!named && bg) ? '$g.Clear([System.Drawing.ColorTranslator]::FromHtml(' + psq(bg) + '))' : clearLine;
  // overlay 模式（外壳中心不透明）的裁剪分支要按机型二选一。先用 JS 把它拼成一段
  // PowerShell，再整体插进主脚本 —— 避免在模板字符串里再嵌一层反引号。
  const OVERLAY_ROUND = `
  # 圆表：外壳中心是不透明的"黑屏占位盘"，外面包一圈**完全透明**的缝（alpha=0，
  # 实测 r 227..230），再外面才是表圈；表圈内沿自带 1px 抗锯齿渐变（实测 r231
  # alpha≈178，再往外才 >=250 不透明）。开口不是正圆（实测半径极差 3.5px），
  # 所以逐角度量、连成多边形，不套正圆公式。
  #
  # 【方案：边框抠洞、盖在顶层】
  #   底层：背景 → 屏幕按「开口外沿 +2」硬裁剪画上 —— 硬边的锯齿反正藏进不透明表圈下面；
  #   顶层：把外壳的占位盘抠成透明，整张外壳盖在最上面。
  # 这样**可见的屏幕边缘就是外壳 PNG 自带的抗锯齿渐变带**，和 Studio 真机预览一致。
  # 曾经用 4× 超采样自己画抗锯齿圆：亚像素边缘指标只能做到 RMS 0.15（理想光滑弧
  # 约 0.004），肉眼看边缘仍有波浪感、甚至觉得"不圆" —— 自己画的圆永远不如原图边缘。
  # 抠洞边界取「开口半径 - 1」：边界正好落在那条 alpha=0 的透明缝里，缝里的像素
  # 抠不抠都看不见，而表圈自带的 AA 渐变像素在边界之外、原样保留 ——
  # 可见边缘逐位等于原图，抗锯齿质量不再取决于我们的算法。
  $cx=$sw/2.0; $cy=$sh/2.0; $R0=[math]::Min($aw,$ah)/2.0
  $N=720
  # 先逐角度量「缝外侧、表圈开始不透明(alpha>=250)」的真实开口半径
  $hits=[double[]]::New($N)
  for($k=0;$k -lt $N;$k++){
    $a=2*[math]::PI*$k/$N; $ca=[math]::Cos($a); $sa=[math]::Sin($a)
    $seen=$false; $hit=0.0; $r=$R0-12; if($r -lt 1){ $r=1 }
    while($r -le $R0+30){
      $x=[int][math]::Round($cx+$r*$ca); $y=[int][math]::Round($cy+$r*$sa)
      if($x -lt 0 -or $y -lt 0 -or $x -ge $sw -or $y -ge $sh){ break }
      $al=$shell.GetPixel($x,$y).A
      if($al -lt 250){ $seen=$true } elseif($seen){ $hit=$r; break }
      $r+=0.25
    }
    if($hit -le 0){ $hit=$R0 }
    $hits[$k]=$hit
  }
  # 环向 7 点滑动平均：射线扫描的步长量化会留下 ±0.125px 抖动。抠洞边界落在透明缝
  # 里所以抖动本身不可见，但平均后边界相对 AA 像素的位置更稳定，保险。
  $sm=[double[]]::New($N)
  $Rmax=0.0
  for($k=0;$k -lt $N;$k++){
    $acc=0.0
    for($j=-3;$j -le 3;$j++){ $acc+=$hits[(($k+$j+$N)%$N)] }
    $sm[$k]=$acc/7.0
    if($sm[$k] -gt $Rmax){ $Rmax=$sm[$k] }
  }
  $Rmax+=2.0
  function New-ApPath([double[]]$rad,[double]$off){
    $p=New-Object System.Drawing.Drawing2D.GraphicsPath
    $pts=New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
    for($k=0;$k -lt $N;$k++){
      $a=2*[math]::PI*$k/$N
      $pts.Add([System.Drawing.PointF]::new([single]($cx+($rad[$k]+$off)*[math]::Cos($a)),[single]($cy+($rad[$k]+$off)*[math]::Sin($a))))
    }
    $p.AddPolygon([System.Drawing.PointF[]]$pts.ToArray()); $p.CloseFigure()
    return $p
  }
  # —— 顶层外壳：抠掉占位盘（SetClip + Clear，边界在透明缝里）——
  $pIn=New-ApPath $sm -1.0
  $sg=[System.Drawing.Graphics]::FromImage($shell)
  $sg.SetClip($pIn)
  $sg.Clear([System.Drawing.Color]::Transparent)
  $sg.Dispose(); $pIn.Dispose()
  # —— 底层：屏幕硬裁剪到开口外沿 +2（锯齿藏在表圈下面），画进输出 ——
  $pOut=New-ApPath $sm 2.0
  $g.SetClip($pOut)
  $rx=[single]($cx-$Rmax); $ry=[single]($cy-$Rmax); $rw=[single]($Rmax*2.0)
  $g.DrawImage($screen,$rx,$ry,$rw,$rw)
  $g.ResetClip(); $pOut.Dispose()
  # —— 顶层：抠好洞的外壳盖上去 ——
  $g.DrawImage($shell,0,0,$sw,$sh)
  $mode=('overlay/ap ' + [int]$R0 + '->' + [int]$Rmax + ' punched')
  `;
  const OVERLAY_RECT = `
  # 圆角矩形（手机 / TV / 车机等中心不透明的机型）。同样不能用 SetClip —— 剪辑区是硬边，
  # 圆角会出现台阶；改为把「屏幕 + 圆角矩形裁剪」画进 4× 超采样中间层再缩回 1×。
  $rad=[single](0.16*[math]::Min($aw,$ah)); $d=[single](2*$rad)
  $SS=4
  $bx=[int][math]::Floor($ax)-2; $by=[int][math]::Floor($ay)-2
  $bw=[int][math]::Ceiling($aw)+4; $bh=[int][math]::Ceiling($ah)+4
  $X0=[single](($ax-$bx)*$SS); $Y0=[single](($ay-$by)*$SS)
  $W4=[single]($aw*$SS); $H4=[single]($ah*$SS); $d4=[single]($d*$SS)
  $p4=New-Object System.Drawing.Drawing2D.GraphicsPath
  $p4.AddArc($X0,$Y0,$d4,$d4,180,90)
  $p4.AddArc([single]($X0+$W4-$d4),$Y0,$d4,$d4,270,90)
  $p4.AddArc([single]($X0+$W4-$d4),[single]($Y0+$H4-$d4),$d4,$d4,0,90)
  $p4.AddArc($X0,[single]($Y0+$H4-$d4),$d4,$d4,90,90)
  $p4.CloseFigure()
  $lb=New-Object System.Drawing.Bitmap(($bw*$SS),($bh*$SS),[System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
  $lbg=[System.Drawing.Graphics]::FromImage($lb)
  $lbg.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $lbg.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $lbg.CompositingQuality=[System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $lbg.Clear([System.Drawing.Color]::Transparent)
  $lbg.SetClip($p4)
  $lbg.DrawImage($screen,$X0,$Y0,$W4,$H4)
  $lbg.ResetClip(); $lbg.Dispose()
  $g.DrawImage($lb,[System.Drawing.Rectangle]::new($bx,$by,$bw,$bh))
  $lb.Dispose()
  $mode=('overlay ss' + $SS)
  `;
  // 分支选择不能只看 centerAlpha：仓库自带的 watch-round 素材中心**已经抠好洞**了，
// 若按"中心透明"判成开孔结构，就会走矩形缩放分支 —— 圆表是圆开口，屏幕矩形
// 四角会露在表圈外面。所以圆表一律走 OVERLAY_ROUND（它本身就会按开口抠洞 + 圆裁剪，
// 对已抠好的素材是无害的空操作）。
const centerCond = ROUND_DEVICES[device] ? '$false' : '($centerAlpha -lt 10)';
const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$screen=[System.Drawing.Image]::FromFile(${psq(rawJpg)})
$shell=[System.Drawing.Bitmap]::FromFile(${psq(shell)})
$sw=$shell.Width; $sh=$shell.Height
$aw=${r.w}*$sw/${s.w}; $ah=${r.h}*$sh/${s.h}; $ax=($sw-$aw)/2; $ay=($sh-$ah)/2
$out=New-Object System.Drawing.Bitmap($sw,$sh,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g=[System.Drawing.Graphics]::FromImage($out)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality=[System.Drawing.Drawing2D.CompositingQuality]::HighQuality
${hexLine}
$centerAlpha=$shell.GetPixel([int]($sw/2),[int]($sh/2)).A
if(${centerCond}){
  # 中心透明 = 外壳是"开孔"结构（方表 / 平板 / 折叠 / 车机…）：屏幕从孔里透出来。
  # 这时屏幕矩形必须**完整盖住整个开口**，否则孔边就会留一条透明细边（"没贴合"）。
  # 按 r/s 表推出来的公式矩形跟真实开口其实有 0.4%~1.6% 的出入（实测：平板 1.004、
  # 折叠 1.016、方表 0.999），小孔边正好差那几个像素。这里逐角度量出开口相对中心的
  # 最大 x/y 半宽，把公式矩形按**统一比例**放大到刚好盖住它（+2px 余量）——
  # 统一比例 = 不改变屏幕本身的宽高比，只把画面整体放大一丁点。
  $cx=$sw/2.0; $cy=$sh/2.0
  $hx=0.0; $hy=0.0; $NN=720
  for($k=0;$k -lt $NN;$k++){
    $a=2*[math]::PI*$k/$NN; $ca=[math]::Cos($a); $sa=[math]::Sin($a)
    $rap=0.0; $r=1.0
    while($r -le [math]::Max($sw,$sh)/2.0){
      $x=[int][math]::Round($cx+$r*$ca); $y=[int][math]::Round($cy+$r*$sa)
      if($x -lt 0 -or $y -lt 0 -or $x -ge $sw -or $y -ge $sh){ break }
      if($shell.GetPixel($x,$y).A -ge 250){ $rap=$r; break }
      $r+=0.5
    }
    if($rap -gt 0){
      $px=[math]::Abs($rap*$ca); $py=[math]::Abs($rap*$sa)
      if($px -gt $hx){ $hx=$px }
      if($py -gt $hy){ $hy=$py }
    }
  }
  $f=1.0
  if($hx -gt 0 -and $hy -gt 0){
    $fx=($hx+2.0)/($aw/2.0); $fy=($hy+2.0)/($ah/2.0)
    $f=[math]::Max([math]::Max($fx,$fy),1.0)
    if($f -gt 1.5){ $f=1.5 }      # 量歪了也别把画面撑爆
  }
  $dhw=[single]($aw*$f/2.0); $dhh=[single]($ah*$f/2.0)
  $pd=New-Object System.Drawing.RectangleF -ArgumentList ([single]($cx-$dhw)),([single]($cy-$dhh)),([single]($dhw*2)),([single]($dhh*2))
  $g.DrawImage($screen,$pd); $g.DrawImage($shell,0,0,$sw,$sh)
  $mode=('hole/ap f=' + [math]::Round($f,3))
} else {
  $g.DrawImage($shell,0,0,$sw,$sh)
${ROUND_DEVICES[device] ? OVERLAY_ROUND : OVERLAY_RECT}
}
$out.Save(${psq(outPng)},[System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("$mode " + [int]$aw + "x" + [int]$ah)
$g.Dispose(); $out.Dispose(); $shell.Dispose(); $screen.Dispose()
`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { stdio: 'pipe' });
}

async function cmdShot(out) {
  if (!out) throw new Error('用法: blueos-ws.js shot <out.png> [--delay <ms>] [--settle <ms>] [--timeout 8000] [--repaint]');
  const ctx = await learnContext();
  const delay = Math.max(0, Number(opt('delay', 0)) || 0);
  const settle = Math.max(0, Number(opt('settle', 0)) || 0);
  const timeout = Math.max(500, Number(opt('timeout', 0)) || 8000);

  // 按到达顺序收集帧；最后一帧 = 最新画面。
  // 早先的版本取「字节数最大」的那帧，一旦页面在跳转/播动画，某个中间帧比终态还大，
  // 就会把跳转中的画面截下来 —— 所以这里改成取最新，静止与否交给 --delay/--settle 控制。
  const frames = [];
  const c = await wsConnect(ctx.port, '/client', txt => {
    let msg; try { msg = JSON.parse(txt); } catch (e) { return; }
    if (msg.event !== 'simulatorToPreview' || msg.payload?.method !== 'updateUI') return;
    const buf = Buffer.from(msg.payload.params || '', 'base64');
    if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return;   // 必须是 JPEG 帧
    frames.push(buf);
  });

  // ⚠️ 默认**不**主动请求重绘。发 size 本意是"逼一次重绘"，但实测有的应用
  // （AirPointer）会把它当成 resize 事件，把页面栈重置回首页 —— 于是「点完就截」
  // 截到的正是被自己踢出来的重置动画。发 on 之后模拟器本来就会推一帧当前画面，
  // 所以只有一帧都收不到时才退回重绘请求（--repaint 可强制）。
  await sleep(120);
  c.sendMsg('previewToSimulator', { method: 'on' });                     // 打开帧流
  let repainted = false;
  if (flag('repaint')) {
    await sleep(120);
    c.sendMsg('previewToSimulator', { method: 'size', params: ctx.size });
    repainted = true;
  } else if (!(await waitFirstFrame(frames, 1200))) {
    console.log('[info] 未收到自发帧，退回一次重绘请求（若应用因此跳回首页，请换一种方式触发画面）');
    c.sendMsg('previewToSimulator', { method: 'size', params: ctx.size });
    repainted = true;
  }

  let mode, quiet = true;
  if (settle > 0) {
    mode = 'settle ' + settle + 'ms';
    quiet = await waitQuiet(() => frames.length, timeout, settle);
  } else if (delay > 0) {
    mode = 'delay ' + delay + 'ms';
    await sleep(delay);
  } else {
    mode = '即时';
  }
  await sleep(delay > 0 || settle > 0 ? 100 : 60);   // 收尾：等在途的那一帧落地

  c.close();
  const best = frames.length ? frames[frames.length - 1] : null;
  if (!best) throw new Error('未收到画面帧。检查：① 模拟器在运行 ② 端口 ' + ctx.port + ' ③ 应用已启动');
  if (!quiet) console.log('[warn] 画面在 ' + timeout + 'ms 内一直在变，已取最新帧；可加大 --timeout');
  if (repainted) console.log('[info] 本次用了重绘请求（--repaint 或自动兜底）');
  const dim = jpegSize(best);
  const outAbs = path.resolve(out);
  const isPng = /\.png$/i.test(outAbs);
  const jpg = isPng ? outAbs.replace(/\.png$/i, '.jpg') : outAbs;
  fs.mkdirSync(path.dirname(jpg), { recursive: true });
  fs.writeFileSync(jpg, best);
  console.log('[OK] ' + jpg + '  ' + (dim ? dim.w + 'x' + dim.h + '  ' : '') + best.length + ' bytes（' + mode + '，' + frames.length + ' 帧取最新）');

  // --shell（别名 --bezel）：套上当前设备的外壳，输出 PNG（带表盘/表圈的「整机照」）
  if (flag('shell') || flag('bezel')) {
    const png = isPng ? outAbs : outAbs.replace(/\.(jpe?g|webp)$/i, '') + '.png';
    try {
      compositeShell(jpg, ctx.device, png, opt('bg', null));
      console.log('[OK] ' + png + '  ' + fs.statSync(png).size + ' bytes（带外壳 PNG，' + ctx.device + '）');
    } catch (e) {
      console.log('[warn] 合成外壳失败（设备 ' + ctx.device + '），已保留裸帧 ' + jpg + '：' + e.message);
    }
    return;
  }

  if (isPng) {
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Drawing;$i=[System.Drawing.Image]::FromFile(' + psq(jpg) + ');$i.Save(' + psq(outAbs) + ',[System.Drawing.Imaging.ImageFormat]::Png);$i.Dispose()'
      ], { stdio: 'pipe' });
      console.log('[OK] ' + outAbs + '  ' + fs.statSync(outAbs).size + ' bytes（PNG）');
    } catch (e) { console.log('[warn] PNG 转换失败，保留 JPEG：' + jpg); }
  }
}

// 所有输入注入都走 previewToSimulator（模拟器角色）
async function withClient(fn) {
  const ctx = await learnContext();
  const c = await wsConnect(ctx.port, '/client');
  await sleep(250);
  try { await fn(c, ctx); } finally { c.close(); }
}

const inputCmd = {
  tap: (a) => ['mouseEvent', { type: 'mousedown', x: +a[0], y: +a[1], timestamp: Date.now() }],
  crown: (a) => ['crownEvent', { delta: +a[0], velocity: +a[0], duration: 80, timestamp: Date.now() }],
  key: (a) => ['keyEvent', { keyCode: +a[0], pressType: a[1] !== undefined ? +a[1] : 1, repeatCount: 1, timeStamp: Date.now() }],
  size: (a) => ['size', { width: +a[0], height: +a[1] }],
  back: () => ['back', {}],
  home: () => ['backToHome', {}],
  reload: () => ['reload', {}],
  push: (a) => ['push', { pagePath: a[0], pageQuery: a[1] || '' }],
  __replace: (a) => ['replacePage', { pagePath: a[0], pageQuery: a[1] || '' }],
};

async function cmdInput(name, args) {
  // --delay <ms>：注入后额外等待再返回（页面跳转/动画需要时间时用）
  // 不填 = 默认 500ms；显式 --delay 0 = 立即返回（由调用方自己掌握节奏）
  const rawDelay = opt('delay', null);
  const tail = rawDelay === null ? 500 : Math.max(0, Number(rawDelay) || 0);
  const wait = tail > 0 ? tail : 400;
  await withClient(async (c, ctx) => {
    const tag = rawDelay === null ? '' : '  +延迟 ' + tail + 'ms';
    if (name === 'swipe') {
      const [x1, y1, x2, y2] = args.map(Number);
      const ms = Number(args[4] || 300), steps = 12;
      c.sendMsg('previewToSimulator', { method: 'mouseEvent', params: { type: 'mousedown', x: x1, y: y1, timestamp: Date.now() } });
      for (let i = 1; i <= steps; i++) {
        await sleep(ms / steps);
        c.sendMsg('previewToSimulator', {
          method: 'mouseEvent',
          params: { type: 'mousemove', x: Math.round(x1 + (x2 - x1) * i / steps), y: Math.round(y1 + (y2 - y1) * i / steps), timestamp: Date.now() },
        });
      }
      c.sendMsg('previewToSimulator', { method: 'mouseEvent', params: { type: 'mouseup', x: x2, y: y2, timestamp: Date.now() } });
      console.log('[OK] swipe (' + x1 + ',' + y1 + ') -> (' + x2 + ',' + y2 + ')  ' + ms + 'ms' + tag);
      await sleep(wait);
      return;
    }
    const build = inputCmd[name];
    if (!build) throw new Error('未知输入命令: ' + name);
    const [method, params] = build(args);
    c.sendMsg('previewToSimulator', { method, params });
    if (name === 'tap') {   // 点击要成对：down + up
      await sleep(60);
      c.sendMsg('previewToSimulator', { method: 'mouseEvent', params: { type: 'mouseup', x: +args[0], y: +args[1], timestamp: Date.now() } });
    }
    console.log('[OK] ' + method + ' ' + JSON.stringify(params) + tag);
    await sleep(wait);
  });
}

async function cmdAutorun(action) {
  await withClient(async (c) => {
    c.sendMsg('previewToServer', { method: action });
    console.log('[OK] previewToServer/' + action + '（Engine 侧接管）');
    await sleep(1200);
  });
}

// 逐页导航 + 原生截图（不依赖 Studio 预览面板是否打开）
async function cmdPages(outDir) {
  if (!outDir) throw new Error('用法: blueos-ws.js pages <outDir>');
  const ctx = await learnContext();
  // Studio 按设备分目录存录制脚本（.autorun/<device>/autorun.json），根目录文件是兼容旧版
  const candidates = [
    path.resolve('.autorun', ctx.device, 'autorun.json'),
    path.resolve('.autorun', 'autorun.json'),
  ];
  const cfgPath = candidates.find(p => fs.existsSync(p));
  if (!cfgPath) throw new Error('找不到 autorun 配置，试过：\n  ' + candidates.join('\n  '));
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  console.log('[info] 配置: ' + cfgPath);
  fs.mkdirSync(outDir, { recursive: true });
  console.log('[info] ' + (cfg.list || []).length + ' 个页面, 设备 ' + ctx.device + ' ' + ctx.size.width + 'x' + ctx.size.height);

  // 逐页截图默认等「画面连续 600ms 无新帧」再截，避免把跳转动画的中间帧截下来
  const settle = Math.max(200, Number(opt('settle', 0)) || 600);

  for (const item of (cfg.list || [])) {
    const name = String(item.pagePath || 'unknown').replace(/^\//, '').replace(/\//g, '.');
    const frames = [];
    const c = await wsConnect(ctx.port, '/client', txt => {
      let msg; try { msg = JSON.parse(txt); } catch (e) { return; }
      if (msg.event !== 'simulatorToPreview' || msg.payload?.method !== 'updateUI') return;
      const buf = Buffer.from(msg.payload.params || '', 'base64');
      if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return;
      frames.push(buf);
    });
    await sleep(300);
    const ev = (item.events || [])[0] || {};
    c.sendMsg('previewToSimulator', { method: 'on' });
    console.log('  → push ' + item.pagePath + (ev.delay ? '（等待 ' + ev.delay + 'ms）' : ''));
    const before = frames.length;
    c.sendMsg('previewToSimulator', { method: 'push', params: { pagePath: item.pagePath, pageQuery: item.pageParams || '' } });
    if (ev.delay) await sleep(Number(ev.delay));
    await sleep(200);
    // push 本身就会产生帧；只有一帧都没来时（个别页面被动渲染）才退回重绘请求
    if (frames.length === before) c.sendMsg('previewToSimulator', { method: 'size', params: ctx.size });
    await waitQuiet(() => frames.length, 8000, settle);                      // 等画面静止
    await sleep(100);
    c.close();
    const best = frames.length ? frames[frames.length - 1] : null;
    if (best) {
      const f = path.join(outDir, name + '.jpg');
      fs.writeFileSync(f, best);
      const dim = jpegSize(best);
      let png = null;
      try {
        const fp = path.join(outDir, name + '.png');
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          'Add-Type -AssemblyName System.Drawing;$i=[System.Drawing.Image]::FromFile(' + psq(f) + ');$i.Save(' + psq(fp) + ',[System.Drawing.Imaging.ImageFormat]::Png);$i.Dispose()'
        ], { stdio: 'pipe' });
        png = fp;
      } catch (e) {}
      console.log('     ✓ ' + (png || f) + '  ' + (dim ? dim.w + 'x' + dim.h : '') + '  ' + best.length + ' bytes');
    } else {
      console.log('     ✗ ' + item.pagePath + ' 未取到帧');
    }
    await sleep(600);
  }
}

async function cmdWatch(sec) {
  const ctx = await learnContext();
  const c = await wsConnect(ctx.port, '/client', txt => {
    let msg; try { msg = JSON.parse(txt); } catch (e) { return; }
    if (msg.event === 'simulatorToPreview' && msg.payload?.method === 'updateUI') {
      const n = Buffer.from(msg.payload.params || '', 'base64').length;
      console.log('[帧] updateUI ' + n + ' bytes');
      return;
    }
    console.log('[' + msg.event + '] ' + JSON.stringify(msg.payload).slice(0, 300));
  });
  // 模拟器只在被请求后才推帧；不打开帧流就一直是空的（调试时容易误判成"没画面"）。
  // 只发 on，不发 size —— 后者在个别应用里会重置页面栈，干扰被观察的行为。
  await sleep(150);
  c.sendMsg('previewToSimulator', { method: 'on' });
  console.log('[watch] 监听 ' + (sec || 15) + 's ...');
  await sleep((Number(sec) || 15) * 1000);
  c.close();
}

const ANSI = /\u001b\[[0-9;]*m/g;

// RPC：在任意路径的连接上发 {id,method,params}，等回对应 id 的响应
function rpc(c, sink, id, method, params, timeout = 10000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('RPC 超时: ' + method)), timeout);
    c.sendRaw({ id, method, params: params || {} });
    const wait = setInterval(() => {
      const i = sink.findIndex(m => m.id === id);
      if (i === -1) return;
      clearInterval(wait); clearTimeout(t);
      const m = sink.splice(i, 1)[0];
      m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result);
    }, 80);
  });
}

// ---------- /error-inspector：编译与运行错误 ----------
async function cmdErrors() {
  const ctx = await learnContext();
  const sink = [];
  const c = await wsConnect(ctx.port, '/error-inspector', txt => {
    try { sink.push(JSON.parse(txt)); } catch (e) {}
  });
  try {
    const cur = await rpc(c, sink, 1, 'getCurrentErrors', {});
    const all = await rpc(c, sink, 2, 'getErrors', {});
    const strip = s => String(s || '').replace(ANSI, '');
    if (flag('json')) {
      console.log(JSON.stringify({ current: cur, all }, null, 2));
      return;
    }
    const fmt = (label, r) => {
      const ce = (r && r.compileErrors) || [];
      const re = (r && r.runtimeErrors) || (r && r.errors) || [];
      console.log('== ' + label + ' ==');
      if (!ce.length && !re.length) { console.log('  无错误 ✓'); return; }
      for (const e of ce) console.log('  [编译] ' + strip(e).trim().split('\n').slice(0, 12).join('\n         '));
      for (const e of re) console.log('  [运行] ' + strip(typeof e === 'string' ? e : JSON.stringify(e)));
    };
    fmt('当前错误 (getCurrentErrors)', cur);
    fmt('历史错误 (getErrors)', all);
  } finally { c.close(); }
}

// ---------- /cdp：UI 元素树 / Mock / GC ----------
async function cmdDom(out) {
  const ctx = await learnContext();
  const events = [];
  const c = await wsConnect(ctx.port, '/cdp', txt => {
    try { events.push(JSON.parse(txt)); } catch (e) {}
  });
  try {
    await rpc(c, events, 1, 'DOM.getDocument', {});
    // 子节点以 DOM.setChildNodes 事件异步推送，等它流完
    await sleep(3000);
    const nodes = new Map();   // nodeId -> node
    const addNode = n => { nodes.set(n.nodeId, n); (n.children || []).forEach(addNode); };
    for (const m of events) {
      if (m.method === 'DOM.setChildNodes') (m.params.nodes || []).forEach(addNode);
      else if (m.method === 'DOM.documentUpdated') {} // 文档重载，树可能失效
    }
    const line = (n, depth) => {
      const attrs = n.attributes || [];
      const map = {};
      for (let i = 0; i + 1 < attrs.length; i += 2) map[attrs[i]] = attrs[i + 1];
      const ev = map.events ? '  events:' + map.events.replace(/\s+/g, ' ').slice(0, 120) : '';
      console.log('  ' + '  '.repeat(depth) + '#' + n.nodeId + ' <' + (n.nodeName || '').toLowerCase() + '>' +
        (map.class ? ' .' + map.class.split(/\s+/).join('.') : '') + ev);
      (n.children || []).forEach(ch => line(ch, depth + 1));
    };
    const roots = [...nodes.values()].filter(n => n.parentId === undefined || !nodes.has(n.parentId));
    if (flag('json')) {
      const dump = out || 'blueos-dom.json';
      fs.writeFileSync(dump, JSON.stringify({ roots, rawEvents: events }, null, 2));
      console.log('[OK] ' + dump + '（' + nodes.size + ' 节点，含原始事件流）');
    } else {
      console.log('== UI 元素树（' + nodes.size + ' 节点；/cdp 不提供几何信息）==');
      roots.forEach(n => line(n, 0));
      if (out) { fs.writeFileSync(out, JSON.stringify({ roots, rawEvents: events }, null, 2)); console.log('[OK] 原始数据已存 ' + out); }
    }
  } finally { c.close(); }
}

async function cmdMock(action, arg) {
  const ctx = await learnContext();
  const events = [];
  const c = await wsConnect(ctx.port, '/cdp', txt => {
    try { events.push(JSON.parse(txt)); } catch (e) {}
  });
  try {
    if (action === 'get') {
      const r = await rpc(c, events, 1, 'Mock.getMock', {});
      console.log(JSON.stringify(r, null, 2));
    } else if (action === 'set') {
      if (!arg) throw new Error('用法: mock set <JSON 字符串>');
      let params; try { params = JSON.parse(arg); } catch (e) { throw new Error('参数不是合法 JSON: ' + e.message); }
      await rpc(c, events, 1, 'Mock.setMock', params);
      console.log('[OK] Mock.setMock ' + arg);
    } else {
      throw new Error('用法: mock get | mock set <JSON>');
    }
  } finally { c.close(); }
}

async function cmdGc() {
  const ctx = await learnContext();
  const events = [];
  const c = await wsConnect(ctx.port, '/cdp', txt => {
    try { events.push(JSON.parse(txt)); } catch (e) {}
  });
  try {
    await rpc(c, events, 1, 'MultiMemory.gc', {});
    await rpc(c, events, 2, 'HeapProfiler.collectGarbage', {});
    console.log('[OK] MultiMemory.gc + HeapProfiler.collectGarbage');
  } finally { c.close(); }
}

/* ------------------------------ 入口 ------------------------------ */
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'probe': await cmdProbe(); break;
    case 'shot': await cmdShot(args[0]); break;
    case 'watch': await cmdWatch(args[0]); break;
    case 'push': case 'tap': case 'swipe': case 'key': case 'crown': case 'size': case 'back': case 'home': case 'reload':
      await cmdInput(cmd, args); break;
    case 'device': await cmdSetDevice(args[0]); break;
    case 'run': await cmdAutorun('startRun'); break;
    case 'stop-run': await cmdAutorun('stopRun'); break;
    case 'rec': await cmdAutorun('startRecord'); break;
    case 'stop-rec': await cmdAutorun('stopRecord'); break;
    case 'pages': await cmdPages(args[0]); break;
    case 'widgets': await cmdWidgets(); break;
    case 'app-mode':
      if (!args[0]) throw new Error('用法: app-mode <app|widget>');
      await cmdSwitchMode({ appMode: args[0] }); break;
    case 'widget': await cmdSwitchMode({ appMode: 'widget', widgetModuleName: args[0] }); break;
    case 'errors': await cmdErrors(); break;
    case 'dom': await cmdDom(args[0]); break;
    case 'mock': await cmdMock(args[0], args.slice(1).join(' ')); break;
    case 'gc': await cmdGc(); break;
    case 'replace-page':
      if (!args[0]) throw new Error('用法: replace-page <pagePath> [query]');
      await cmdInput('__replace', args); break;
    default:
      // 打印文件顶部的注释块作为用法说明（跳过第 1 行 shebang）
      const lines = fs.readFileSync(__filename, 'utf8').split('\n');
      const head = [];
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].startsWith('//')) break;
        head.push(lines[i].replace(/^\/\/ ?/, ''));
      }
      console.log(head.join('\n'));
      process.exit(cmd ? 2 : 0);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => { console.error('[ERR] ' + e.message); process.exit(1); });
}

// 导出给自检脚本用（直接 require 本文件不会跑 CLI）
module.exports = { compositeShell, SHELL_FILE, DEV_SCREEN, DEV_SHELL_SIZE, ROUND_DEVICES, SHELL_DIR, resolveShell };
