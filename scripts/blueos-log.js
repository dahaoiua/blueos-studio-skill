#!/usr/bin/env node
// 读取 BlueOS Studio / 模拟器日志（零依赖）
//
// 日志位置：%APPDATA%\BlueOS Studio\logs\<启动时间戳>\window<N>\
//   output_<时间戳>\project.log   ← 模拟器里应用的 stdout（含 [Error]/[ErrExit]/JSError）
//   renderer.log                  ← Studio 渲染进程（含扩展报错）
// 注意：模拟器退出会在 project.log 里留一行 [ErrExit] simulator encountered an exception and exited
//
// 用法：
//   node blueos-log.js tail   [--n 40]    应用日志尾部
//   node blueos-log.js errors [--n 30]    只看错误行（应用 + 模拟器退出）
//   node blueos-log.js renderer [--n 30]  Studio 渲染进程日志尾部
//   node blueos-log.js files              列出实际日志文件路径
const fs = require('fs');
const path = require('path');

function opt(name, def) { const i = process.argv.indexOf('--' + name); return i === -1 ? def : process.argv[i + 1]; }
const logsRoot = path.join(process.env.APPDATA || '', 'BlueOS Studio', 'logs');

/* 每个 <启动时间戳> 目录是一次 Studio 会话。注意：Studio 自带 CLI 每调用一次
 * 会连接运行实例的命令（如 --status）也会新建一个目录，但里面只有 cli.log、
 * 没有 window* 子目录 —— 这类目录必须排除，否则"取最新目录"会选中它，
 * 结果所有日志都显示为"无"。 */
function isSession(dir) {
  try { return fs.readdirSync(dir).some(n => /^window\d+$/.test(n)); } catch (e) { return false; }
}

// 在所有会话目录里找 最新写入 的 project.log / renderer.log
// 另外：不能按 window 目录 mtime 选，它不随日志写入更新；要按日志文件本身的 mtime
function locate() {
  if (!fs.existsSync(logsRoot)) return null;
  const all = fs.readdirSync(logsRoot)
    .map(n => ({ n, p: path.join(logsRoot, n) }))
    .filter(x => { try { return fs.statSync(x.p).isDirectory(); } catch (e) { return false; } });
  const sessions = all.filter(x => isSession(x.p));

  let project = null, renderer = null, pt = 0, rt = 0, projectStamp = null;
  for (const s of sessions) {
    const wins = fs.readdirSync(s.p).filter(n => /^window\d+$/.test(n)).map(n => path.join(s.p, n));
    for (const w of wins) {
      let names; try { names = fs.readdirSync(w); } catch (e) { continue; }
      for (const n of names) {
        const p = path.join(w, n);
        let st; try { st = fs.statSync(p); } catch (e) { continue; }
        if (st.isDirectory() && /^output_/.test(n)) {
          const f = path.join(p, 'project.log');
          if (fs.existsSync(f)) {
            const t = fs.statSync(f).mtimeMs;
            if (t > pt) { pt = t; project = f; projectStamp = s.p; }
          }
        } else if (n === 'renderer.log' && st.isFile()) {
          if (st.mtimeMs > rt) { rt = st.mtimeMs; renderer = p; }
        }
      }
    }
  }
  // stamp 用于展示：优先取最新 project.log 所在会话，退而取最新会话目录
  const byDirMtime = sessions.slice().sort((a, b) => fs.statSync(b.p).mtimeMs - fs.statSync(a.p).mtimeMs);
  const stamp = projectStamp || (byDirMtime[0] && byDirMtime[0].p) || (all[0] && all[0].p) || null;
  return {
    stamp,
    project,
    renderer,
    sessions: sessions.length,
    skipped: all.length - sessions.length,
  };
}

function tail(file, n) {
  const txt = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  return txt.slice(-n).join('\n');
}

// 过滤最近 sinceMin 分钟内的行（行首形如 [10-06 20:45:26] 或 2026-10-05 20:34:05.123）
function recent(text, sinceMin) {
  if (!sinceMin) return text.split(/\r?\n/);
  const now = new Date();
  const cutoff = new Date(now.getTime() - sinceMin * 60000);
  const rows = [];
  for (const l of text.split(/\r?\n/)) {
    let m = /^\[(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/.exec(l);
    let d = null;
    if (m) d = new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4], +m[5]);
    else {
      m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(l);
      if (m) d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }
    if (!d || d >= cutoff) rows.push(l);   // 没时间戳的行（多行堆栈）一律保留
  }
  return rows;
}

const loc = locate();
if (!loc) { console.error('[ERR] 找不到日志目录：' + logsRoot); process.exit(1); }
const cmd = process.argv[2] || 'tail';
const n = Number(opt('n', cmd === 'tail' ? 40 : 30));
const since = Number(opt('since', 0));

if (cmd === 'files') {
  console.log('日志根目录 : ' + loc.stamp);
  console.log('应用日志   : ' + (loc.project || '(无)'));
  console.log('渲染日志   : ' + (loc.renderer || '(无)'));
  if (loc.skipped) {
    console.log('（已跳过 ' + loc.skipped + ' 个无 window 子目录的会话目录：' +
      'Studio 自带 CLI 每次连接运行实例都会新建一个只含 cli.log 的空目录）');
  }
} else if (cmd === 'tail') {
  if (!loc.project) { console.error('[ERR] 没有 project.log（Studio 还没启动过模拟器）'); process.exit(1); }
  console.log('== ' + loc.project + ' ==');
  console.log(tail(loc.project, n).replace(/\r/g, ''));
} else if (cmd === 'errors') {
  const rows = [];
  if (loc.project) {
    for (const l of recent(fs.readFileSync(loc.project, 'utf8'), since)) {
      if (/\[(Error|ERROR|ErrExit|FATAL)\]|JSError|Exception|Unhandled/i.test(l)) rows.push('[app] ' + l.trim());
    }
  }
  if (loc.renderer) {
    for (const l of recent(fs.readFileSync(loc.renderer, 'utf8'), since)) {
      if (/\[error\]/i.test(l)) rows.push('[studio] ' + l.trim());
    }
  }
  if (!rows.length) { console.log('没有错误记录 ✓'); process.exit(0); }
  console.log(rows.slice(-n).join('\n'));
} else if (cmd === 'renderer') {
  if (!loc.renderer) { console.error('[ERR] 没有 renderer.log'); process.exit(1); }
  console.log('== ' + loc.renderer + ' ==');
  console.log(recent(fs.readFileSync(loc.renderer, 'utf8'), since).slice(-n).join('\n').replace(/\r/g, ''));
} else {
  console.log('用法: node blueos-log.js tail|errors|renderer|files [--n 30] [--since 分钟]');
}
