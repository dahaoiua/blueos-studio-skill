#!/usr/bin/env node
// BlueOS 工程脚手架（零依赖）—— 用 Studio 内置模板创建新工程，不必手点「新建工程」向导。
//
// 内置模板来自 Studio 安装目录（不在本仓库里，随 Studio 版本更新）：
//   <Studio>/resources/app/out/vs/quickapp/code/electron-browser/create/media/projects/<模板>/<模板>.zip
// 每套模板旁边有一个 manifest.json 描述它（标题、支持的设备类型、版本）。
//
// 向导（Studio 的「新建工程」）实际只做四件事，本脚本逐条复刻：
//   1. 把 <模板>.zip 解压到 <目标目录>
//   2. 改 src/manifest.json：name = 应用名，package = 包名；
//      若 deviceTypeList 里有选中的设备，把它挪到数组首位
//   3. 改 package.json：name = 工程名
//   4. 让 Studio 打开该目录
// 本脚本做 1~3，第 4 步交给 blueos-sim.js open（或用 --open 一步到位）。
//
// 注意：本命令**不需要 Studio 正在运行**（纯文件操作）。
//
// 用法：
//   node blueos-create.js templates [--studio <目录>] [--json]
//   node blueos-create.js create <目标目录> [选项]
//
// create 选项：
//   --template <名称>   模板名（默认 hello-blueos），用 templates 子命令查看
//   --device   <值>     首选设备（watch / phone / multi / watch-square …），
//                       须在该模板支持的设备里，否则只提示不生效
//   --name     <名称>   工程名（默认取目标目录的目录名）→ package.json 的 name
//   --app-name <名称>   应用显示名（默认同 --name）→ src/manifest.json 的 name
//   --pkg      <包名>   应用包名（默认 com.example.demo）→ src/manifest.json 的 package
//   --install           解压后装依赖（**默认就会装**，见下）—— 可显式指定包管理器路径无关
//   --no-install        跳过装依赖
//   --open              创建完立刻让 Studio 打开（等价于 blueos-sim.js open <目标目录>）
//   --timeout <秒>      配合 --open：等 Studio 把工程打开的上限（默认 60）
//   --studio  <目录>    Studio 安装目录，默认自动探测
//   --json              以 JSON 输出结果
//
// 关于依赖：8 套模板里有 6 套是 Tailwind（postcss.config.js 里 require('tailwindcss')），
// **不装依赖直接构建会失败**（blueos-pack 报 `Cannot find module 'tailwindcss'`）。
// 所以只要 package.json 里有依赖就默认自动安装（pnpm 优先，退回 npm）；纯 CSS 的
// sample / watchface 没有依赖，会自动跳过。安装需要联网。
//
// 安全：只写 <目标目录>（且要求它不存在或为空，绝不覆盖已有内容）；
//       解压时拒绝 .. 与绝对路径（zip-slip），跳过 __MACOSX/ 与 ._* 垃圾条目。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

function opt(name, def) { const i = process.argv.indexOf('--' + name); return i === -1 ? def : process.argv[i + 1]; }
function flag(name) { return process.argv.includes('--' + name); }

/* --------------------------- Studio 与模板定位 --------------------------- */
const CREATE_REL = ['resources', 'app', 'out', 'vs', 'quickapp', 'code', 'electron-browser', 'create'];

function findStudio() {
  const cands = [opt('studio'), process.env.BLUEOS_STUDIO, 'E:\\BlueOSStudio', 'D:\\BlueOSStudio', 'C:\\BlueOSStudio'];
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, ...CREATE_REL, 'media', 'projects'))) return c;
  }
  return null;
}

function templatesDir() {
  const s = findStudio();
  if (!s) throw new Error('找不到 Studio 的内置模板目录（' + CREATE_REL.join('/') + '/media/projects），用 --studio <目录> 指定');
  return path.join(s, ...CREATE_REL, 'media', 'projects');
}

// 每套模板旁边有 manifest.json 描述它。字段可能缺失，一律容错。
function listTemplates() {
  const dir = templatesDir();
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const d = path.join(dir, name);
    if (!fs.statSync(d).isDirectory()) continue;
    const metaPath = path.join(d, 'manifest.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { meta = {}; }
    const zip = path.join(d, meta.file || name + '.zip');
    if (!fs.existsSync(zip)) continue;
    out.push({
      name,
      title: meta.title || {},
      info: meta.information || {},
      devices: Array.isArray(meta.deviceTypeList) ? meta.deviceTypeList : [],
      appMode: meta.appMode || '',
      version: meta.version || '',
      zip,
      zipSize: fs.statSync(zip).size,
    });
  }
  return out;
}

/* ------------------------------- zip 解压 ------------------------------- */
// Node 没有内置解压，但 zlib 是内置的 —— 手写一个只认「中央目录 + deflate/stored」的
// 最小解压器，比依赖 PowerShell Expand-Archive（慢、且本机 stdout 有怪癖）或 Python（不保证装了）稳。
function unzip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);

  // EOCD 在文件末尾（注释最长 65535），从后往前找签名
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD 记录');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) throw new Error('暂不支持 zip64（文件过大）');

  let p = cdOff, files = 0, skipped = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏 @ ' + p);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + cmtLen;

    // macOS 打包残留，导出的工程不该带它们
    const base = name.split('/').pop();
    if (name.startsWith('__MACOSX/') || name === '.DS_Store' || base.startsWith('._')) { skipped++; continue; }
    // zip-slip 防护
    if (/^([a-zA-Z]:|[\\/])/.test(name) || name.split(/[\\/]/).includes('..')) {
      throw new Error('zip 内含不安全路径，已中止：' + name);
    }

    if (name.endsWith('/')) { fs.mkdirSync(path.join(destDir, name), { recursive: true }); continue; }

    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('zip 本地文件头损坏：' + name);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = raw;                          // stored
    else if (method === 8) data = zlib.inflateRawSync(raw); // deflate
    else throw new Error('zip 用了不支持的压缩方式 ' + method + '：' + name);

    const out = path.join(destDir, name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    files++;
  }
  return { files, skipped };
}

/* -------------------------------- 命令 -------------------------------- */
function cmdTemplates() {
  const tpls = listTemplates();
  const dir = templatesDir();
  if (flag('json')) { console.log(JSON.stringify({ dir, templates: tpls.map(t => ({ name: t.name, title: t.title, info: t.info, devices: t.devices, version: t.version, zipSize: t.zipSize })) }, null, 2)); return; }
  console.log('模板目录: ' + dir);
  console.log('');
  const w = Math.max(...tpls.map(t => t.name.length));
  for (const t of tpls) {
    const zh = (t.title && t.title.chinese) || '';
    const en = (t.title && t.title.english) || '';
    console.log('  ' + t.name.padEnd(w) + '  ' + zh + (en ? ' / ' + en : ''));
    console.log('  ' + ' '.repeat(w) + '  设备 ' + (t.devices.join(' / ') || '(未声明)') +
      '   样式 ' + ((t.info && t.info.chinese) || '-') + '   ' + (t.zipSize / 1024).toFixed(0) + ' KB');
  }
  console.log('');
  console.log('用法: node blueos-create.js create <目标目录> --template ' + (tpls[0] ? tpls[0].name : '<名称>'));
}

function cmdCreate() {
  const target = path.resolve(process.argv[3] || opt('project', ''));
  if (!process.argv[3] && !opt('project', '')) {
    throw new Error('用法: node blueos-create.js create <目标目录> [--template <名称>] [--device <值>] [--name <名称>] [--app-name <名称>] [--pkg <包名>]');
  }

  const tplName = opt('template', 'hello-blueos');
  const tpls = listTemplates();
  const tpl = tpls.find(t => t.name === tplName);
  if (!tpl) throw new Error('没有模板「' + tplName + '」，可选：' + tpls.map(t => t.name).join(', '));

  const projectName = opt('name', path.basename(target));
  const appName = opt('app-name', projectName);
  const pkgName = opt('pkg', 'com.example.demo');
  const device = opt('device', '');

  // 先把参数验完再动磁盘 —— 否则校验失败会留下一个半成品目录
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(projectName)) {
    throw new Error('工程名「' + projectName + '」不符合 npm 包名规则（小写字母/数字/._-，且不以 . _ 开头）；用 --name 换一个');
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(pkgName)) {
    throw new Error('包名「' + pkgName + '」不像合法的反向域名（如 com.example.demo）；用 --pkg 换一个');
  }

  // 目标目录：不存在则建；存在必须是空目录（绝不覆盖已有内容）
  if (fs.existsSync(target)) {
    const ents = fs.readdirSync(target).filter(n => n !== '.git');
    if (ents.length) throw new Error('目标目录已存在且非空，为安全起见不覆盖：' + target + '\n      换一个目录名，或先自行清空');
    console.log('[info] 目标目录已存在但是空的，继续');
  } else {
    fs.mkdirSync(target, { recursive: true });
  }

  // 官方要求：工程路径不能含中文或空格（否则构建工具失败）
  if (/[^\x00-\x7F]/.test(target)) console.log('[warn] 工程路径含非 ASCII 字符，官方要求避免，构建可能失败');
  if (/\s/.test(target)) console.log('[warn] 工程路径含空格，官方要求避免，构建可能失败');

  console.log('[create] 模板     : ' + tplName + '  (' + ((tpl.title && tpl.title.chinese) || '') + ')');
  console.log('         目标目录 : ' + target);
  console.log('         工程名   : ' + projectName + '   应用名 ' + appName + '   包名 ' + pkgName);

  const r = unzip(tpl.zip, target);
  console.log('[OK] 已解压 ' + r.files + ' 个文件' + (r.skipped ? '（跳过 ' + r.skipped + ' 个 macOS 垃圾条目）' : ''));

  // 改 src/manifest.json —— 与 Studio 向导同一套规则
  const mfPath = path.join(target, 'src', 'manifest.json');
  let mfDevices = [];
  if (fs.existsSync(mfPath)) {
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    mf.name = appName;
    mf.package = pkgName;
    if (Array.isArray(mf.deviceTypeList)) {
      mfDevices = mf.deviceTypeList.slice();
      if (device) {
        const at = mf.deviceTypeList.indexOf(device);
        if (at < 0) console.log('[warn] 该模板不支持设备「' + device + '」（支持：' + mfDevices.join(' / ') + '），未调整');
        else if (at > 0) { mf.deviceTypeList.splice(at, 1); mf.deviceTypeList.unshift(device); }
      }
    }
    fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2) + '\n');
    console.log('[OK] src/manifest.json  : name=' + appName + '  package=' + pkgName +
      (device && mfDevices[0] === device ? '  deviceTypeList[0]=' + device : ''));
  } else {
    console.log('[warn] 模板里没有 src/manifest.json，未改写');
  }

  // 改 package.json
  const pjPath = path.join(target, 'package.json');
  let needDeps = [];
  if (fs.existsSync(pjPath)) {
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    pj.name = projectName;
    fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n');
    needDeps = Object.keys(Object.assign({}, pj.dependencies, pj.devDependencies));
    console.log('[OK] package.json       : name=' + projectName);
  } else {
    console.log('[warn] 模板里没有 package.json，未改写');
  }

  // 装依赖：默认装（不装的话 Tailwind 模板构建必失败），--no-install 才跳过
  let installCmd = '';
  if (flag('no-install')) {
    if (needDeps.length) console.log('[skip] 按 --no-install 跳过装依赖（该模板有 ' + needDeps.length + ' 个依赖，构建前需自行安装）');
  } else if (!needDeps.length) {
    console.log('[skip] 该模板没有依赖，无需安装');
  } else {
    // Windows 上 pnpm/npm 实际是 pnpm.cmd / npm.cmd，spawnSync 直接起不带扩展名的名字
    // 会 ENOENT —— 必须过 shell（与下面真正执行 install 时保持一致）。
    const has = c => { try { return spawnSync(c, ['-v'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0; } catch (e) { return false; } };
    const pm = has('pnpm') ? 'pnpm' : (has('npm') ? 'npm' : '');
    if (!pm) console.log('[warn] 没找到 pnpm / npm，跳过安装；构建前请自行安装依赖');
    else {
      installCmd = pm + ' install';
      console.log('[install] ' + installCmd + '  （' + needDeps.length + ' 个依赖，首次约 30~60 秒）');
      const ri = spawnSync(pm, ['install'], { cwd: target, stdio: 'inherit', shell: process.platform === 'win32' });
      const ok = ri.status === 0 && fs.existsSync(path.join(target, 'node_modules'));
      console.log(ok ? '[OK] 依赖安装完成' : '[warn] 依赖安装未成功（退出码 ' + ri.status + '），构建前请在工程里手动执行 ' + installCmd);
      if (!ok) installCmd += '  (未完成)';
    }
  }

  // 顶层结构，便于确认
  const top = fs.readdirSync(target).filter(n => n !== 'node_modules').sort();
  console.log('');
  console.log('工程结构: ' + top.join('  '));

  const result = {
    ok: true, target, template: tplName, projectName, appName, package: pkgName,
    device: device || (mfDevices[0] || ''), devices: mfDevices, files: r.files, install: installCmd,
  };

  // 可选：立刻让 Studio 打开它
  if (flag('open')) {
    const sim = path.join(__dirname, 'blueos-sim.js');
    const args = [sim, 'open', target];
    if (opt('studio', '')) args.push('--studio', opt('studio'));
    if (opt('timeout', '')) args.push('--timeout', opt('timeout'));   // 透传给 open 的等待上限
    console.log('');
    console.log('[open] 交给 blueos-sim.js open（新窗口）…');
    const ro = spawnSync(process.execPath, args, { stdio: 'inherit' });
    result.opened = ro.status === 0;
    if (ro.status !== 0) console.log('[warn] 打开工程失败，可稍后手动执行: node blueos-sim.js open "' + target + '"');
  } else {
    console.log('');
    console.log('下一步:');
    console.log('  让 Studio 打开它（新窗口，不打断已开的工程）:');
    console.log('    node blueos-sim.js open "' + target + '"');
    console.log('  构建:');
    console.log('    node blueos-build.js build --debug --device-type watch-square --project "' + target + '"');
  }

  if (flag('json')) console.log(JSON.stringify(result, null, 2));
}

/* -------------------------------- 入口 -------------------------------- */
try {
  const cmd = process.argv[2];
  if (cmd === 'templates') cmdTemplates();
  else if (cmd === 'create') cmdCreate();
  else {
    console.log('用法:');
    console.log('  node blueos-create.js templates [--studio <目录>] [--json]');
    console.log('  node blueos-create.js create <目标目录> [--template <名称>] [--device <值>]');
    console.log('                                       [--name <工程名>] [--app-name <应用名>]');
    console.log('                                       [--pkg <包名>] [--no-install] [--open] [--json]');
    console.log('  （默认自动安装依赖；--open 创建完直接让 Studio 打开，可配 --timeout <秒>）');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) { console.error('[ERR] ' + e.message); process.exit(1); }
