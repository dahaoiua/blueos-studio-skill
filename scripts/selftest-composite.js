#!/usr/bin/env node
// selftest-composite.js —— `shot --shell` 合成器的自检（不依赖 Studio 在线）
//
// 判据：**合成图里"显示屏开口"这一块不能有透明像素**。
//   外壳素材的显示屏开口有两种形态：圆表是"黑屏占位盘 + 一圈透明缝"，方表/平板
//   是中心直接开孔。若合成时屏幕没盖满开口，输出图上就会在开口里留下透明细边 ——
//   在任意背景上看就是"屏幕和边框没贴合"。
//
// 怎么定位"开口"：外壳里与图像外边界**不连通**的透明区域才是设备内部；其中离图像
//   中心最近的那一块就是显示屏开口（外壳自己的其它镂空，比如表带缝、支架孔，离中心
//   远得多，不会被算进来）。然后在合成图里数这块区域还剩多少透明像素。
//
// 用法: node scripts/selftest-composite.js [--keep]
//   退出码 0 = 全通过；1 = 有设备不合格。

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const mod = require('./blueos-ws.js');

// Studio 预览器 client 目录下的原生分辨率表（来自 index-*.js 里 Kw(e,t) 的 n 表）
const NATIVE = {
  'watch-round': { w: 466, h: 466 },
  'watch-square': { w: 390, h: 450 },
  phone: { w: 430, h: 932 },
  foldable: { w: 677, h: 763 },
  tablet: { w: 1032, h: 688 },
  multi: { w: 1032, h: 860 },
  tv: { w: 1920, h: 1080 },
  car: { w: 1920, h: 1080 },
};

const CUT = 200;   // alpha < 200 视为"没被不透明像素覆盖"
const keep = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'blueos-selftest-'));
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function ps(script) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'pipe' });
}

function makeFrame(file, W, H) {
  ps(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$b=New-Object System.Drawing.Bitmap(${W},${H})
$g=[System.Drawing.Graphics]::FromImage($b)
$g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(255,20,30,70))
$cx=${W}/2.0; $cy=${H}/2.0
for($i=1;$i -le 8;$i++){
  $rr=[single](${Math.min(W, H)}/2.0*$i/9.0)
  $col=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,(30+$i*25),(200-$i*20),90))
  $g.FillEllipse($col,[single]($cx-$rr),[single]($cy-$rr),[single]($rr*2),[single]($rr*2))
}
$pen=New-Object System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::FromArgb(255,240,40,40)),([single]2)
$rw=[single](${W}*0.497); $rh=[single](${H}*0.497)
$g.DrawEllipse($pen,[single]($cx-$rw),[single]($cy-$rh),[single]($rw*2),[single]($rh*2))
$b.Save(${q(file)},[System.Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose(); $b.Dispose()
`);
}

// 导出 alpha 掩码（true = alpha < CUT）
function alphaMask(png, tag) {
  const raw = path.join(TMP, 'a-' + tag + '.bin');
  ps(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$b=[System.Drawing.Bitmap]::FromFile(${q(png)})
$W=$b.Width; $H=$b.Height
$rect=New-Object System.Drawing.Rectangle(0,0,$W,$H)
$bd=$b.LockBits($rect,[System.Drawing.Imaging.ImageLockMode]::ReadOnly,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$len=$bd.Stride*$H
$buf=New-Object byte[] $len
[System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0,$buf,0,$len)
$b.UnlockBits($bd); $b.Dispose()
[System.IO.File]::WriteAllBytes(${q(raw)},$buf)
[System.IO.File]::WriteAllText(${q(raw + '.meta')},($W.ToString()+' '+$H.ToString()+' '+$bd.Stride.ToString()))
`);
  const [W, H, stride] = fs.readFileSync(raw + '.meta', 'utf8').trim().split(/\s+/).map(Number);
  const buf = fs.readFileSync(raw);
  const trans = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { const row = y * stride; for (let x = 0; x < W; x++) if (buf[row + x * 4 + 3] < CUT) trans[y * W + x] = 1; }
  return { W, H, trans };
}

function flood(m, seeds, testFn) {
  const { W, H, trans } = m;
  const seen = new Uint8Array(W * H);
  const stack = [];
  for (const s of seeds) if (s >= 0 && trans[s] && !seen[s] && (!testFn || testFn(s))) { seen[s] = 1; stack.push(s); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W, y = (i - x) / W;
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
    for (const j of nb) if (j >= 0 && trans[j] && !seen[j] && (!testFn || testFn(j))) { seen[j] = 1; stack.push(j); }
  }
  return seen;
}

// 取 shell 里「离中心最近的那一块内部透明区」= 显示屏开口
function openingMask(shell) {
  const { W, H, trans } = shell;
  const border = [];
  for (let x = 0; x < W; x++) { border.push(x); border.push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { border.push(y * W); border.push(y * W + W - 1); }
  const outside = flood(shell, border, null);
  const interior = (i) => trans[i] && !outside[i];
  // 离中心最近的内部透明像素
  const cx = W / 2, cy = H / 2;
  let best = -1, bestD = Infinity;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (interior(i)) { const d = (x - cx) ** 2 + (y - cy) ** 2; if (d < bestD) { bestD = d; best = i; } }
  }
  if (best < 0) return null;
  return flood(shell, [best], interior);
}

let failed = 0, tested = 0;
console.log('tmp: ' + TMP);
for (const dev of Object.keys(NATIVE)) {
  const shellName = mod.SHELL_FILE[dev];
  if (!shellName) continue;
  const shellFile = path.join(mod.SHELL_DIR, shellName);
  if (!fs.existsSync(shellFile)) { console.log('- ' + dev + '  (无外壳素材，跳过)'); continue; }
  const frame = path.join(TMP, 'frame-' + dev + '.jpg');
  const out = path.join(TMP, 'out-' + dev + '.png');
  makeFrame(frame, NATIVE[dev].w, NATIVE[dev].h);
  mod.compositeShell(frame, dev, out, null);

  const shell = alphaMask(shellFile, 'shell-' + dev);
  const comp = alphaMask(out, 'comp-' + dev);
  tested++;
  const op = openingMask(shell);
  if (!op) { console.log('SKIP  ' + dev.padEnd(13) + ' 外壳没有"内部开口"（全不透明）—— 不可能出现缝'); continue; }
  let holes = 0, minX = shell.W, minY = shell.H, maxX = -1, maxY = -1, opCount = 0;
  for (let i = 0; i < op.length; i++) if (op[i]) { opCount++; if (comp.trans[i]) { holes++; const x = i % shell.W, y = (i - (i % shell.W)) / shell.W; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
  if (holes === 0) console.log('PASS  ' + dev.padEnd(13) + ' 开口 ' + opCount + ' px 全被屏幕盖住');
  else { failed++; console.log('FAIL  ' + dev.padEnd(13) + ' 开口里有 ' + holes + '/' + opCount + ' px 仍是透明（' + minX + ',' + minY + ' - ' + maxX + ',' + maxY + '）'); }
}
if (!keep) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} }
console.log('\n' + (failed ? '有 ' + failed + ' 个设备不合格' : '全部通过'));
process.exit(failed ? 1 : 0);
