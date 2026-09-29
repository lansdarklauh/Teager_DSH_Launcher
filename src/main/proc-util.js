'use strict';

/**
 * 进程与环境相关的通用工具（Windows / macOS 双平台）：刷新 PATH、跨编码解码输出、按行切分、
 * 结束进程树、执行并捕获输出等。
 * @module proc-util
 */

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');

/** 是否为 Windows 平台。 */
const IS_WIN = process.platform === 'win32';

/** 是否为 macOS 平台。 */
const IS_MAC = process.platform === 'darwin';

/** UTF-8 严格解码器（遇到非法字节抛错，用于判断是否需要回退到 GBK）。 */
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

/** 回退解码器：中文 Windows 控制台默认代码页 936（GBK）；其他平台仍用 UTF-8。 */
let FALLBACK_DECODER;
try {
  FALLBACK_DECODER = new TextDecoder(IS_WIN ? 'gbk' : 'utf-8');
} catch {
  FALLBACK_DECODER = new TextDecoder('utf-8');
}

/**
 * 将一段字节解码为字符串：优先按 UTF-8 严格解码，失败时回退（Windows 下为 GBK）。
 * @param {Buffer} buf 待解码的字节
 * @returns {string} 解码后的文本
 */
function decodeBytes(buf) {
  if (!buf || buf.length === 0) return '';
  try {
    return UTF8_FATAL.decode(buf);
  } catch {
    return FALLBACK_DECODER.decode(buf);
  }
}

/**
 * 按行切分的流式解码器：缓存未结束的半行，保证多字节字符不会被截断后乱码。
 */
class LineDecoder {
  /**
   * @param {(line: string) => void} onLine 每解码出一整行时的回调
   */
  constructor(onLine) {
    /** @type {(line: string) => void} 行回调 */
    this.onLine = onLine;
    /** @type {Buffer} 尚未遇到换行符的残留字节 */
    this.pending = Buffer.alloc(0);
  }

  /**
   * 写入一段新数据，内部按 \n 切分后逐行回调。
   * @param {Buffer} chunk 子进程输出的原始字节
   */
  push(chunk) {
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let idx;
    while ((idx = buf.indexOf(0x0a)) !== -1) {
      const lineBuf = buf.subarray(0, idx);
      buf = buf.subarray(idx + 1);
      this.onLine(decodeBytes(lineBuf).replace(/\r$/, ''));
    }
    // 残留过长（例如进度条不换行）时也强制输出，避免界面长时间无响应
    if (buf.length > 8192) {
      this.onLine(decodeBytes(buf));
      buf = Buffer.alloc(0);
    }
    this.pending = Buffer.from(buf);
  }

  /** 流结束时输出剩余的半行。 */
  flush() {
    if (this.pending.length) {
      this.onLine(decodeBytes(this.pending).replace(/\r$/, ''));
      this.pending = Buffer.alloc(0);
    }
  }
}

/**
 * （仅 Windows）从注册表读取一个环境变量的持久化值，用于获取本程序启动之后才写入的 PATH。
 * @param {string} key 注册表键路径
 * @param {string} name 值名称
 * @returns {string} 读取到的值，失败时返回空字符串
 */
function readRegistryValue(key, name) {
  if (!IS_WIN) return '';
  try {
    const r = spawnSync('reg.exe', ['query', key, '/v', name], { windowsHide: true, timeout: 5000 });
    if (r.status !== 0) return '';
    const text = decodeBytes(r.stdout);
    const m = text.match(new RegExp(`\\s${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)`, 'i'));
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * 展开字符串中的 %VAR% 形式环境变量引用（Windows 注册表 PATH 常见）。
 * @param {string} value 原始字符串
 * @param {NodeJS.ProcessEnv} env 用于展开的环境变量表
 * @returns {string} 展开后的字符串
 */
function expandEnvRefs(value, env) {
  return value.replace(/%([^%]+)%/g, (all, name) => {
    const hit = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return hit ? env[hit] : all;
  });
}

/**
 * 在环境变量表中不区分大小写地查找 PATH 的真实键名（Windows 上可能是 Path）。
 * @param {NodeJS.ProcessEnv} env 环境变量表
 * @returns {string} PATH 的键名
 */
function pathKeyOf(env) {
  return Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
}

/** （仅 macOS）登录 shell 的 PATH 缓存：从 Dock/Finder 启动的应用拿不到终端里配置的 PATH。 */
let macShellPathCache = null;

/** （仅 Windows）注册表中持久化的系统 + 用户 PATH 缓存。 */
let winPersistedPathCache = null;

/**
 * （仅 macOS）读取用户登录 shell 的 PATH，从而能找到 Homebrew / nvm / volta 安装的 node 与 dsh。
 * 结果会缓存，避免每次都启动 shell 带来的开销。
 * @param {boolean} [refresh] 是否强制刷新缓存（安装完成后需要刷新）
 * @returns {string} PATH 字符串
 */
function macLoginShellPath(refresh = false) {
  if (!IS_MAC) return '';
  if (macShellPathCache !== null && !refresh) return macShellPathCache;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const r = spawnSync(shell, ['-ilc', 'printf "__HD_PATH__%s__HD_END__" "$PATH"'], { timeout: 8000, encoding: 'utf8' });
    const m = (r.stdout || '').match(/__HD_PATH__(.*)__HD_END__/s);
    macShellPathCache = m ? m[1] : '';
  } catch {
    macShellPathCache = '';
  }
  return macShellPathCache;
}

/**
 * （仅 macOS）异步预取登录 shell 的 PATH 并写入缓存，避免首次 buildEnv 时同步启动 shell 阻塞主进程。
 * Windows 上直接返回。
 * @returns {Promise<void>} 预取完成
 */
function primeShellPath() {
  if (!IS_MAC || macShellPathCache !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    let out = '';
    let child;
    try {
      child = spawn(shell, ['-ilc', 'printf "__HD_PATH__%s__HD_END__" "$PATH"'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      macShellPathCache = '';
      resolve();
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('close', () => {
      clearTimeout(timer);
      const m = out.match(/__HD_PATH__(.*)__HD_END__/s);
      macShellPathCache = m ? m[1] : '';
      resolve();
    });
    child.on('error', () => {
      clearTimeout(timer);
      macShellPathCache = '';
      resolve();
    });
  });
}

/**
 * （仅 macOS）列出 nvm 已安装各版本 node 的 bin 目录（版本号从高到低）。
 * @returns {string[]} bin 目录
 */
function nvmBinDirs() {
  const base = path.join(process.env.NVM_DIR || path.join(os.homedir(), '.nvm'), 'versions', 'node');
  try {
    return fs
      .readdirSync(base)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => path.join(base, v, 'bin'));
  } catch {
    return [];
  }
}

/**
 * 当前平台上常见但可能不在 GUI 进程 PATH 中的可执行目录。
 * @returns {string[]} 目录列表
 */
function platformExtraDirs() {
  if (!IS_MAC) return [];
  const home = os.homedir();
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.volta', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'bin'),
    ...nvmBinDirs(),
  ];
}

/**
 * 构造一份“刷新后”的环境变量：合并持久化 PATH（Windows 注册表 / macOS 登录 shell）、当前进程 PATH
 * 以及常见目录，并按需前置额外目录。这样即使 dsh / Node.js 是在本程序启动之后才安装的，也能被找到。
 * @param {string[]} [extraDirs] 需要前置到 PATH 的目录
 * @param {Record<string,string>} [extraEnv] 额外覆盖的环境变量
 * @param {boolean} [refresh] 是否刷新 macOS 登录 shell PATH 缓存
 * @returns {NodeJS.ProcessEnv} 新的环境变量表
 */
function buildEnv(extraDirs = [], extraEnv = {}, refresh = false) {
  const env = { ...process.env };
  const key = pathKeyOf(env);
  const sep = path.delimiter;
  let persisted = [];
  if (IS_WIN) {
    // 注册表读取会同步启动 reg.exe，结果缓存起来，只在安装完成等需要时刷新
    if (winPersistedPathCache === null || refresh) {
      const machine = readRegistryValue('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path');
      const user = readRegistryValue('HKCU\\Environment', 'Path');
      winPersistedPathCache = [...expandEnvRefs(machine, env).split(sep), ...expandEnvRefs(user, env).split(sep)];
    }
    persisted = winPersistedPathCache;
  } else if (IS_MAC) {
    persisted = macLoginShellPath(refresh).split(sep);
  }
  const parts = [...extraDirs, ...(env[key] || '').split(sep), ...persisted, ...platformExtraDirs()];
  const seen = new Set();
  const merged = [];
  for (const p of parts) {
    const t = (p || '').trim();
    if (!t) continue;
    const norm = IS_WIN ? t.replace(/[\\/]+$/, '').toLowerCase() : t.replace(/\/+$/, '');
    if (seen.has(norm)) continue;
    seen.add(norm);
    merged.push(t);
  }
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  env[key] = merged.join(sep);
  return { ...env, ...extraEnv };
}

/**
 * 在给定 PATH 中查找命令（纯 JS 扫描目录，不额外启动 where/which 进程，速度更快）。
 * @param {string} name 命令名（不带扩展名）
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @returns {string[]} 按 PATH 顺序排列的所有命中路径
 */
function whichAll(name, env) {
  const dirs = (env[pathKeyOf(env)] || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat'] : [''];
  const hits = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (isExecutable(p)) hits.push(p);
    }
  }
  return hits;
}

/**
 * 判断文件是否存在且可执行（Windows 只判断是否为文件）。
 * @param {string} p 文件路径
 * @returns {boolean} 是否可执行
 */
function isExecutable(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (IS_WIN) return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 为 cmd.exe /c 构造一条安全的命令行（带空格或特殊字符的参数加引号）。
 * @param {string} file 可执行文件或脚本路径
 * @param {string[]} args 参数列表
 * @returns {string} 拼接后的命令行
 */
function quoteCmdLine(file, args) {
  const q = (s) => (/[\s&()^|<>"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
  return [q(file), ...args.map(q)].join(' ');
}

/**
 * 启动一个可执行文件或脚本。
 * - Windows：.cmd/.bat 及裸命令名通过 cmd.exe 转发（规避 Node 对 .cmd 直接 spawn 的限制）；
 * - macOS：以独立进程组（detached）启动，便于结束时连同所有子进程一起结束。
 * @param {string} file 可执行文件路径或命令名
 * @param {string[]} args 参数
 * @param {import('node:child_process').SpawnOptions} opts spawn 选项
 * @returns {import('node:child_process').ChildProcess} 子进程
 */
function spawnAny(file, args, opts = {}) {
  if (!IS_WIN) {
    return spawn(file, args, { ...opts, detached: true });
  }
  const ext = path.extname(file).toLowerCase();
  const base = { windowsHide: true, ...opts };
  if (ext === '.cmd' || ext === '.bat' || !path.isAbsolute(file)) {
    const line = quoteCmdLine(file, args);
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      ...base,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(file, args, base);
}

/**
 * 执行一个命令并捕获其全部输出。
 * @param {string} file 可执行文件或命令名
 * @param {string[]} args 参数
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, timeout?: number}} [opts] 选项；timeout 为毫秒
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, error?: Error}>} 执行结果
 */
function runCapture(file, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnAny(file, args, { env: opts.env || process.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error });
      return;
    }
    const out = [];
    const err = [];
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish({ code: null, stdout: decodeBytes(Buffer.concat(out)), stderr: decodeBytes(Buffer.concat(err)), error: new Error('timeout') });
    }, opts.timeout || 20000);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (error) => finish({ code: null, stdout: '', stderr: '', error }));
    child.on('close', (code) => finish({ code, stdout: decodeBytes(Buffer.concat(out)), stderr: decodeBytes(Buffer.concat(err)) }));
  });
}

/**
 * 判断指定 PID 的进程是否仍存活。
 * @param {number} pid 进程 PID
 * @returns {boolean} 是否存活
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * 结束整个进程树。
 * - Windows：child.kill 只会结束 cmd.exe，node 子进程会残留，因此必须用 taskkill /T /F；
 * - macOS：先向整个进程组发送 SIGTERM 让 dsh 有机会优雅退出，超时后再 SIGKILL。
 * @param {number|undefined} pid 根进程 PID
 * @param {number} [graceMs] macOS 下等待优雅退出的毫秒数
 * @returns {Promise<void>} 结束完成
 */
function killTree(pid, graceMs = 4000) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve();
      return;
    }
    if (IS_WIN) {
      try {
        const p = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        p.on('close', () => resolve());
        p.on('error', () => resolve());
      } catch {
        resolve();
      }
      return;
    }
    const signalGroup = (sig) => {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          process.kill(pid, sig);
        } catch {
          /* 进程已退出 */
        }
      }
    };
    signalGroup('SIGTERM');
    const started = Date.now();
    const timer = setInterval(() => {
      if (!isAlive(pid)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > graceMs) {
        clearInterval(timer);
        signalGroup('SIGKILL');
        resolve();
      }
    }, 150);
  });
}

/**
 * 同步结束进程树（仅在程序即将退出、无法再等待异步回调时使用）。
 * @param {number|undefined} pid 根进程 PID
 */
function killTreeSync(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* 忽略：进程可能已退出 */
  }
}

/**
 * 检测本机 127.0.0.1 上某端口是否空闲。
 * @param {number} port 端口号
 * @returns {Promise<boolean>} 空闲返回 true
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * 判断文件是否存在且为普通文件。
 * @param {string} p 文件路径
 * @returns {boolean} 是否存在
 */
function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 判断目录是否可写（通过创建并删除一个临时文件测试）。
 * @param {string} dir 目录路径
 * @returns {boolean} 是否可写
 */
function isDirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.hd-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * 格式化本地时间（非 UTC）。
 * @param {Date} [d] 时间，默认当前时间
 * @param {boolean} [withDate] 是否包含日期
 * @returns {string} 形如 2026-09-28 14:03:05 的字符串
 */
function localTime(d = new Date(), withDate = false) {
  const p = (n) => String(n).padStart(2, '0');
  const t = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return withDate ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${t}` : t;
}

module.exports = {
  IS_WIN,
  IS_MAC,
  decodeBytes,
  LineDecoder,
  buildEnv,
  primeShellPath,
  pathKeyOf,
  whichAll,
  isExecutable,
  spawnAny,
  runCapture,
  killTree,
  killTreeSync,
  isAlive,
  isPortFree,
  fileExists,
  isDirWritable,
  localTime,
};
