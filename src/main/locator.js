'use strict';

/**
 * 动态定位本机的 DeepSeek Harness（dsh）可执行入口（Windows / macOS）。
 * 不写死任何安装目录：依次检查手动指定路径、PATH、上次检测结果、npm 全局前缀以及常见安装位置。
 * @module locator
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { IS_WIN, IS_MAC, buildEnv, runCapture, isExecutable, whichAll } = require('./proc-util');

/** Windows 下可直接启动的入口扩展名，按优先级排序（.ps1 与无扩展名 sh 脚本不作为入口）。 */
const WIN_EXTS = ['.exe', '.cmd', '.bat'];

/**
 * 在一个目录中寻找 dsh 入口文件。
 * @param {string} dir 目录
 * @returns {string} 找到的完整路径，找不到时返回空字符串
 */
function findInDir(dir) {
  if (!dir) return '';
  const names = IS_WIN ? WIN_EXTS.map((e) => `dsh${e}`) : ['dsh'];
  for (const n of names) {
    const p = path.join(dir, n);
    if (isExecutable(p)) return p;
  }
  return '';
}

/**
 * 获取 npm 全局可执行文件目录（Windows 为前缀目录本身，macOS 为 前缀/bin）。
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @returns {Promise<string>} 目录，失败时为空字符串
 */
async function npmGlobalBinDir(env) {
  const r = await runCapture('npm', ['prefix', '-g'], { env, timeout: 15000 });
  if (r.code !== 0) return '';
  const prefix = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';
  if (!prefix) return '';
  return IS_WIN ? prefix : path.join(prefix, 'bin');
}

/**
 * 列出某目录下匹配前缀的子目录（用于枚举 Python 各版本目录等）。
 * @param {string} base 父目录
 * @param {(name: string) => string} map 子目录名 → 目标路径
 * @returns {string[]} 目标路径
 */
function listSub(base, map) {
  try {
    return fs.readdirSync(base).map(map);
  } catch {
    return [];
  }
}

/**
 * 枚举本机存在的盘符根目录（仅 Windows，用于检查 X:\dsh 这类自定义安装位置）。
 * @returns {string[]} 形如 C:\ 的根目录列表
 */
function listDriveRoots() {
  const roots = [];
  for (let c = 67; c <= 90; c += 1) {
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      if (fs.existsSync(root)) roots.push(root);
    } catch {
      /* 忽略不可访问的盘符 */
    }
  }
  return roots;
}

/**
 * 常见安装位置列表（与本机特定目录结构无关）。
 * @param {string} installRoot 本程序自动安装时使用的根目录
 * @returns {string[]} 待检查的目录
 */
function wellKnownDirs(installRoot) {
  const home = os.homedir();
  if (IS_WIN) {
    const la = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const ad = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const dirs = [
      path.join(installRoot, 'bin'),
      path.join(installRoot, 'node'),
      path.join(installRoot, 'npm-global'),
      path.join(ad, 'npm'),
      path.join(la, 'pnpm'),
      process.env.PNPM_HOME || '',
      process.env.NVM_SYMLINK || '',
      path.join(la, 'Volta', 'bin'),
      path.join(home, 'scoop', 'shims'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
      path.join(home, '.dsh', 'bin'),
      ...listSub(path.join(ad, 'Python'), (n) => path.join(ad, 'Python', n, 'Scripts')),
      ...listSub(path.join(la, 'Programs', 'Python'), (n) => path.join(la, 'Programs', 'Python', n, 'Scripts')),
    ];
    // 形如 D:\dsh\bin 这类按盘符根目录自定义的安装方式
    for (const root of listDriveRoots()) {
      for (const sub of ['dsh\\bin', 'dsh', 'dsh\\npm-global', 'dsh\\node', 'DeepSeekHarness\\bin', 'DeepSeekHarness\\node', 'DeepSeekHarness\\npm-global']) {
        dirs.push(path.join(root, sub));
      }
    }
    return dirs.filter(Boolean);
  }
  const dirs = [
    path.join(installRoot, 'bin'),
    path.join(installRoot, 'node', 'bin'),
    path.join(installRoot, 'npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.dsh', 'bin'),
    path.join(home, 'dsh', 'bin'),
    ...listSub(path.join(home, '.nvm', 'versions', 'node'), (n) => path.join(home, '.nvm', 'versions', 'node', n, 'bin')),
    ...listSub(path.join(home, 'Library', 'Python'), (n) => path.join(home, 'Library', 'Python', n, 'bin')),
    ...listSub('/Library/Frameworks/Python.framework/Versions', (n) => `/Library/Frameworks/Python.framework/Versions/${n}/bin`),
  ];
  return dirs;
}

/**
 * 列出本机所有可能的 dsh 入口（PATH 中全部命中 + 上次检测结果 + 各常见安装位置），用于设置页的自动补全。
 * @param {string} installRoot 本程序安装根目录
 * @param {string} lastPath 上次检测到的路径
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @returns {string[]} 去重后的入口路径
 */
function dshCandidates(installRoot, lastPath, env) {
  const list = [...whichAll('dsh', env), lastPath && isExecutable(lastPath) ? lastPath : '', ...wellKnownDirs(installRoot).map(findInDir)];
  const seen = new Set();
  return list.filter((p) => {
    if (!p) return false;
    const k = IS_WIN ? p.toLowerCase() : p;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 定位 dsh 入口。
 * @param {{manualPath?: string, lastPath?: string, installRoot: string, refresh?: boolean}} opts 定位选项
 * @param {(msg: string) => void} [log] 过程日志回调
 * @returns {Promise<{path: string, source: string} | null>} 定位结果；未安装时返回 null
 */
async function locateDsh(opts, log = () => {}) {
  if (opts.manualPath) {
    if (isExecutable(opts.manualPath)) {
      log(`使用手动指定的 dsh：${opts.manualPath}`);
      return { path: opts.manualPath, source: '手动指定' };
    }
    log(`手动指定的 dsh 路径不存在，改为自动检测：${opts.manualPath}`);
  }

  const env = buildEnv([], {}, opts.refresh);
  const onPath = whichAll('dsh', env);
  if (onPath.length) {
    log(`在 PATH 中找到 dsh：${onPath[0]}`);
    return { path: onPath[0], source: 'PATH 环境变量' };
  }

  if (opts.lastPath && isExecutable(opts.lastPath)) {
    log(`使用上次检测到的 dsh：${opts.lastPath}`);
    return { path: opts.lastPath, source: '上次检测结果' };
  }

  // 先扫常见目录（纯文件检查，毫秒级），再启动 npm 查询全局目录（秒级）
  for (const dir of wellKnownDirs(opts.installRoot)) {
    const hit = findInDir(dir);
    if (hit) {
      log(`在常见安装位置找到 dsh：${hit}`);
      return { path: hit, source: '常见安装位置' };
    }
  }

  const binDir = await npmGlobalBinDir(env);
  const hit = findInDir(binDir);
  if (hit) {
    log(`在 npm 全局目录中找到 dsh：${hit}`);
    return { path: hit, source: 'npm 全局目录' };
  }
  log('未在本机找到 DeepSeek Harness（dsh）');
  return null;
}

/**
 * 推断 dsh 使用的 DSH_HOME：优先解析自定义包装脚本中的 DSH_HOME 赋值（Windows 的 set、macOS 的 export），
 * 其次读环境变量，最后为默认的 ~/.dsh。
 * @param {string} dshPath dsh 入口路径
 * @returns {string} DSH_HOME 目录
 */
function resolveDshHome(dshPath) {
  try {
    const st = fs.statSync(dshPath);
    // 只解析小体积的文本脚本，避免误读二进制
    if (st.size < 64 * 1024 && !/\.exe$/i.test(dshPath)) {
      const text = fs.readFileSync(dshPath, 'utf8');
      const m = IS_WIN
        ? text.match(/set\s+"?DSH_HOME=([^"\r\n]+)"?/i)
        : text.match(/(?:export\s+)?DSH_HOME=["']?([^"'\r\n]+)["']?/);
      if (m) {
        return m[1]
          .trim()
          .replace(/%([^%]+)%/g, (all, n) => process.env[n] ?? all)
          .replace(/^\$HOME|^~/, os.homedir());
      }
    }
  } catch {
    /* 读取失败时继续使用后续规则 */
  }
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) return process.env.DSH_HOME.trim();
  return path.join(os.homedir(), '.dsh');
}

/**
 * 运行 `dsh --version` 获取版本号。
 * @param {string} dshPath dsh 入口路径
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @returns {Promise<string>} 版本号，失败时为空字符串
 */
async function getDshVersion(dshPath, env) {
  const r = await runCapture(dshPath, ['--version'], { env, timeout: 90000 });
  const m = `${r.stdout}\n${r.stderr}`.match(/\b\d+\.\d+\.\d+(?:-[\w.]+)?\b/);
  return m ? m[0] : '';
}

/** 解析启动脚本时允许读取的环境变量（其余如 npm 生成的 SET dp0 / PATHEXT 等一律忽略）。 */
const LAUNCHER_ENV_KEYS = /^(DSH_HOME|npm_config_\w+|pnpm_config_\w+|PNPM_\w+|XDG_\w+|TEMP|TMP|TMPDIR|PATH)$/i;

/**
 * 解析 dsh 启动脚本（包装脚本）：提取其中设置的环境变量、PATH 目录以及被调用的下一级入口。
 * 例如 `set "NPM_CONFIG_PREFIX=D:\dsh\npm-global"` 与 `call "D:\dsh\npm-global\dsh.cmd" %*`。
 * @param {string} file 启动脚本路径
 * @returns {{env: Record<string,string>, pathDirs: string[], inner: string}} 解析结果；非文本脚本返回空结果
 */
function parseLauncher(file) {
  const res = { env: {}, pathDirs: [], inner: '' };
  try {
    if (fs.statSync(file).size > 64 * 1024 || /\.exe$/i.test(file)) return res;
    const expand = (s) => s
      .replace(/%([^%]+)%/g, (all, n) => process.env[n] ?? all)
      .replace(/\$\{?(\w+)\}?/g, (all, n) => process.env[n] ?? all)
      .replace(/^~/, os.homedir());
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      const m = IS_WIN
        ? line.match(/^set\s+"?([A-Za-z_]\w*)=(.*?)"?$/i)
        : line.match(/^(?:export\s+)?([A-Za-z_]\w*)=["']?(.*?)["']?$/);
      if (m && LAUNCHER_ENV_KEYS.test(m[1])) {
        if (m[1].toLowerCase() === 'path') {
          // PATH 里引用自身（%PATH% / $PATH）的部分丢弃，只保留脚本新增的目录
          res.pathDirs.push(...m[2].split(path.delimiter).filter((d) => d && !/%PATH%|\$PATH|\$\{PATH\}/i.test(d)).map(expand));
        } else {
          res.env[m[1]] = expand(m[2]);
        }
        continue;
      }
      const c = IS_WIN ? line.match(/^call\s+"([^"]+)"/i) : line.match(/^exec\s+"([^"]+)"/);
      if (c) res.inner = expand(c[1]);
    }
  } catch {
    /* 读取失败按无法解析处理 */
  }
  return res;
}

/**
 * 确定 dsh 的 npm 全局安装位置，以及更新时应沿用的环境（缓存目录、临时目录、PATH 等）。
 * 顺着启动脚本一路找到 npm 生成的入口，再据此反推出 npm 全局前缀；无法确定（例如不是 npm 安装）时返回 null。
 * @param {string} dshPath 设置或检测得到的 dsh 入口
 * @returns {{prefix: string, pkgDir: string, env: Record<string,string>, pathDirs: string[]}|null} 安装目标（pkgDir 为 dsh 包目录）
 */
function resolveInstallTarget(dshPath) {
  let cur = parseLauncher(dshPath);
  let shim = dshPath;
  const env = { ...cur.env };
  const pathDirs = [...cur.pathDirs];
  for (let depth = 0; cur.inner && depth < 3; depth += 1) {
    shim = cur.inner;
    cur = parseLauncher(shim);
    Object.assign(env, cur.env);
    pathDirs.push(...cur.pathDirs);
  }
  let pkgDir = '';
  if (IS_WIN) {
    // Windows：npm 的 dsh.cmd 与 node_modules 位于同一个前缀目录
    const p = path.join(path.dirname(shim), 'node_modules', '@deepseek-ai', 'dsh');
    if (fs.existsSync(path.join(p, 'package.json'))) pkgDir = p;
  } else {
    // macOS：bin/dsh 是指向 lib/node_modules/@deepseek-ai/dsh/lib/bin.js 的符号链接
    try {
      let d = path.dirname(fs.realpathSync(shim));
      for (let i = 0; i < 8 && !pkgDir; i += 1, d = path.dirname(d)) {
        const pj = path.join(d, 'package.json');
        if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === '@deepseek-ai/dsh') pkgDir = d;
      }
    } catch {
      /* 无法解析符号链接 */
    }
  }
  if (!pkgDir) return null;
  const nodeModules = path.dirname(path.dirname(pkgDir));
  const prefix = IS_WIN ? path.dirname(nodeModules) : path.dirname(path.dirname(nodeModules));
  return { prefix, pkgDir, env, pathDirs };
}

module.exports = {
  locateDsh, resolveDshHome, getDshVersion, npmGlobalBinDir, findInDir, dshCandidates, parseLauncher, resolveInstallTarget, IS_MAC,
};
