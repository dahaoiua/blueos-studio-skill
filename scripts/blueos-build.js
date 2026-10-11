#!/usr/bin/env node
// BlueOS 应用构建（零依赖）
//
// Studio 的构建系统叫 BlueOS Toolkit，命令行入口是 blueos-pack，
// 藏在 blueos-debugger 扩展里：它自带一份 node.exe，工程不要用自己的 node 跑，
// 版本不对会出错。本脚本负责定位这两个路径并把参数转发过去。
//
// 用法：
//   node blueos-build.js build   [选项]     # debug 构建（默认）
//   node blueos-build.js release [选项]     # release 构建，产物带签名
//   node blueos-build.js watch   [选项]     # 监听模式（持续编译）
//   node blueos-build.js --json ...
//
// 常用选项（与 blueos-pack 一致，原样透传）：
//   --device-type <设备>       如 watch-square / watch-round
//   --debug                    debug 构建（release 子命令下可用来反向指定）
//   --install                  构建完成后自动把 rpk 装到设备上
//   --other-variables "k1=v1&k2=v2"
//                              注入自定义变量（NODE_ENV 等，见官方「打包设置」）
//   --assets-include <模式>    指定要打包的资源目录
//   --dpi <dpi>                设备像素密度
//   --compile-page <页面路径>  只编译指定页面
//   -f, --force                禁用缓存（改了配置不生效时用）
//   --rpk-path <路径>          产物子目录（build 默认 dev，release 默认 prod）
//
// 其它：
//   --project <目录>           工程根目录，默认当前目录
//   --studio  <目录>           Studio 安装目录，默认自动探测
//   --timeout <秒>             构建超时，默认 900（watch 子命令忽略此项）
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function opt(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? def : process.argv[i + 1];
}

function findStudio() {
  const cands = [opt('studio'), process.env.BLUEOS_STUDIO, 'E:\\BlueOSStudio', 'D:\\BlueOSStudio', 'C:\\BlueOSStudio'];
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'resources', 'app', 'extensions', 'blueos-debugger'))) return c;
  }
  throw new Error('找不到 BlueOS Studio 安装目录，用 --studio <目录> 指定');
}

function toolchain() {
  const studio = findStudio();
  const ext = path.join(studio, 'resources', 'app', 'extensions', 'blueos-debugger');
  const node = path.join(ext, 'media', 'node', 'node.exe');
  // 两个入口（jax / bot）指向同一实现，优先用 bin/index.js
  const cands = [
    path.join(ext, 'node_modules', 'blueos-pack', 'bin', 'index.js'),
    path.join(ext, 'node_modules', 'blueos-pack', 'dist', 'index.cjs'),
  ];
  const cli = cands.find(p => fs.existsSync(p));
  if (!fs.existsSync(node)) throw new Error('找不到内置 node：' + node);
  if (!cli) throw new Error('找不到 blueos-pack，试过：\n  ' + cands.join('\n  '));
  return { node, cli };
}

const SUBCOMMANDS = new Set(['build', 'release', 'watch', 'init-ndk', 'init-native-app']);
const OWN_OPTS = new Set(['--project', '--studio', '--json', '--timeout']);

const cmd = process.argv[2];
if (!cmd || !SUBCOMMANDS.has(cmd)) {
  console.error('用法: node blueos-build.js <build|release|watch> [blueos-pack 选项...]');
  console.error('      node blueos-build.js <子命令> --help   查看全部选项');
  process.exit(1);
}

try {
  const { node, cli } = toolchain();
  const project = path.resolve(opt('project', process.cwd()));

  // 工程路径限制（官方文档）：路径里不能有中文或空格，否则构建工具会失败
  if (/[\u4e00-\u9fa5]/.test(project) || /\s/.test(project)) {
    console.error('[WARN] 工程路径含中文或空格，官方文档说明这会导致构建失败：' + project);
  }
  if (!fs.existsSync(path.join(project, 'src'))) {
    console.error('[WARN] ' + project + ' 下没有 src 目录，确认 --project 指向的是工程根目录');
  }

  // 转发参数：摘掉本脚本自己的选项，其余原样传给 blueos-pack
  const args = [cli];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (OWN_OPTS.has(a)) { if (a !== '--json') i++; continue; }
    args.push(a);
  }

  console.log('[build] ' + project);
  console.log('        ' + path.basename(node) + ' ' + cmd + ' ' + args.slice(2).join(' '));
  // 超时护栏：blueos-pack 内部报错时**可能不退出**（实测：clean output 被文件系统保护
  // 拦下后抛 BError + UnhandledPromiseRejection，进程却一直活着），spawnSync 会永久卡住。
  // watch 是常驻监听，不加超时。
  const tmo = /^\d+$/.test(String(opt('timeout', ''))) ? Number(opt('timeout')) : (cmd === 'watch' ? 0 : 900);
  const t0 = Date.now();
  const r = spawnSync(node, args, { cwd: project, stdio: 'inherit', timeout: tmo ? tmo * 1000 : undefined });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.error && r.error.code === 'ETIMEDOUT') {
    console.error('[ERR] 构建超过 ' + tmo + ' 秒仍未结束，已中止（' + sec + 's）。');
    console.error('      常见原因：blueos-pack 内部报错后没有退出（输出里通常有 BError / UnhandledPromiseRejection）。');
    console.error('      若看到 [safe-delete]...CONFIRM_REQUIRED：输出目录文件数超过 50，被沙箱的批量删除保护拦住了');
    console.error('      （清理 build/ 属于正常构建行为）。在沙箱外重跑，或先自行清空 build/ 再构建。');
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error('[ERR] 构建失败（exit ' + r.status + '，' + sec + 's）');
    process.exit(r.status === null ? 1 : r.status);
  }
  console.log('[OK] 构建完成（' + sec + 's）');

  // 反查产物 —— 不能只看退出码。
  // blueos-pack 有时内部抛错（实测：postcss.config.js 里 require 不到 tailwindcss，
  // 即依赖没装）却仍以退出码 0 退出，输出里只留一句 BError 与 errorCode。
  // 这种情况单看退出码会误判成成功，于是必须拿「有没有真写出 build/<设备>/manifest.json」
  // 当判据。只有 build / release 子命令适用（watch 是常驻监听，不产出成品）。
  if (cmd === 'build' || cmd === 'release') {
    const dev = opt('device-type', '');
    const buildRoot = path.join(project, 'build');
    const hasManifest = (p) => fs.existsSync(path.join(p, 'manifest.json'));
    let produced = false;
    if (fs.existsSync(buildRoot)) {
      produced = dev ? hasManifest(path.join(buildRoot, dev))
        : fs.readdirSync(buildRoot).some(d => { try { return hasManifest(path.join(buildRoot, d)); } catch (e) { return false; } });
    }
    if (!produced) {
      console.error('[ERR] blueos-pack 退出码为 0，但没有产出 build/' + (dev || '<设备>') + '/manifest.json —— 本次构建实际未成功。');
      console.error('      常见原因：① 依赖没装（Tailwind 模板需要 tailwindcss，可用 blueos-create.js 建工程或手动 ' +
        'pnpm install）② 工程路径含中文或空格 ③ blueos-pack 输出里通常有 BError/errorCode 字样，可重跑看完整输出。');
      process.exit(1);
    }
  }

  // 顺手报告产物，省得再去翻目录
  for (const d of ['build', 'dist']) {
    const dir = path.join(project, d);
    if (!fs.existsSync(dir)) continue;
    const found = [];
    const walk = (p, depth) => {
      if (depth > 3) return;
      let ents;
      try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const q = path.join(p, e.name);
        if (e.isDirectory()) walk(q, depth + 1);
        else if (/\.rpk$/i.test(e.name)) found.push(q + '  ' + fs.statSync(q).size + 'B');
      }
    };
    walk(dir, 0);
    if (found.length) {
      console.log('       ' + d + '/ 下的 rpk：');
      found.slice(0, 8).forEach(f => console.log('         ' + f));
      if (found.length > 8) console.log('         … 共 ' + found.length + ' 个');
    }
  }
} catch (e) {
  console.error('[ERR] ' + e.message);
  process.exit(1);
}
