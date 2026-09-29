'use strict';

/**
 * DeepSeek Harness 自动安装器（Windows / macOS）。
 * 流程：检测系统环境 → 准备 Node.js（本机版本不满足时下载对应平台/架构的便携版）→ npm 安装 dsh 与 pnpm
 *      → 写入用户 PATH → 验证。整个过程可随时取消（取消时会结束正在运行的下载与安装进程）。
 * @module installer
 */

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const {
  IS_WIN, buildEnv, spawnAny, runCapture, killTree, LineDecoder, isDirWritable, isExecutable,
} = require('./proc-util');
const {
  probeSystem, pickRegistry, parseVersion, nodeSatisfies, REGISTRIES, registryUrl, nodeDistFor,
} = require('./system');
const { findInDir, getDshVersion } = require('./locator');

/** 安装步骤定义（界面按此顺序展示）。 */
const STEPS = [
  { id: 'system', title: '检测系统环境' },
  { id: 'node', title: '准备 Node.js 运行时' },
  { id: 'dsh', title: '安装 DeepSeek Harness' },
  { id: 'path', title: '生成启动脚本并配置环境变量' },
  { id: 'verify', title: '验证安装结果' },
];

/** 用户主动取消安装时抛出的错误。 */
class CancelledError extends Error {
  constructor() {
    super('安装已取消');
    this.cancelled = true;
  }
}

/**
 * 安装器类。事件：
 * - step  ({id, status: 'active'|'done'|'skip'|'error', detail})
 * - system (系统信息对象)
 * - progress ({percent, text})
 */
class Installer extends EventEmitter {
  /**
   * @param {{installRoot: string, registry: string, registryCustom?: string, extraDirs?: string[]}} opts 安装选项；extraDirs 为用户配置的 Node.js / pnpm 目录
   * @param {(level: string, text: string) => void} log 日志回调
   */
  constructor(opts, log) {
    super();
    /** @type {{installRoot: string, registry: string, registryCustom?: string, extraDirs?: string[]}} 安装选项 */
    this.opts = opts;
    /** @type {(level: string, text: string) => void} 日志回调 */
    this.log = log;
    /** @type {boolean} 是否已被取消 */
    this.cancelled = false;
    /** @type {boolean} 是否正在运行 */
    this.running = false;
    /** @type {import('node:child_process').ChildProcess|null} 当前正在运行的子进程 */
    this.child = null;
    /** @type {AbortController|null} 当前下载的中止控制器 */
    this.abort = null;
  }

  /** 若已取消则抛出 CancelledError，用于在各步骤之间快速中断。 */
  checkCancel() {
    if (this.cancelled) throw new CancelledError();
  }

  /**
   * 更新步骤状态。
   * @param {string} id 步骤 ID
   * @param {'active'|'done'|'skip'|'error'} status 状态
   * @param {string} [detail] 说明文字
   */
  step(id, status, detail = '') {
    this.emit('step', { id, status, detail });
  }

  /**
   * 执行完整安装流程。
   * @returns {Promise<{dshPath: string, version: string}>} 安装得到的 dsh 入口与版本
   */
  async run() {
    this.running = true;
    this.cancelled = false;
    const root = this.opts.installRoot;
    let current = 'system';
    try {
      // 1. 系统环境
      this.step('system', 'active', '正在检测操作系统、架构、Node.js 与网络…');
      const extra = this.opts.extraDirs || [];
      const sys = await probeSystem(buildEnv(extra, {}, true), root, this.opts.registry, this.opts.registryCustom);
      this.emit('system', sys);
      const registry = pickRegistry(this.opts.registry, sys.latency);
      // 最终使用的源地址（自定义地址无效时回退国内镜像）
      const regUrl = registryUrl(registry, this.opts.registryCustom) || REGISTRIES.npmmirror;
      this.log('info', `系统：${sys.os} / ${sys.arch}，Node.js：${sys.node || '未安装'}，npm 源：${regUrl}`);
      if (sys.diskFree >= 0 && sys.diskFree < 1024 * 1024 * 1024) {
        this.log('warn', `安装目录所在磁盘剩余空间不足 1GB（${(sys.diskFree / 1024 / 1024).toFixed(0)}MB），安装可能失败`);
      }
      if (!sys.git) this.log('warn', '未检测到 Git：安装来自 GitHub 的 dsh 插件时需要 Git，建议稍后安装');
      this.step('system', 'done', `${sys.os} · ${sys.arch}`);
      this.checkCancel();

      // 2. Node.js
      current = 'node';
      let nodeBin = '';
      if (sys.nodeOk) {
        this.step('node', 'skip', `使用本机 Node.js v${sys.node}`);
      } else {
        const why = sys.node ? `本机 Node.js v${sys.node} 版本过低（需要 22.18+ 或 24.2+）` : '本机未安装 Node.js';
        this.log('info', `${why}，将下载便携版 Node.js 到 ${root}（不影响系统已有环境）`);
        this.step('node', 'active', why);
        nodeBin = await this.installPortableNode(root, sys.arch, registry);
        this.step('node', 'done', '便携版 Node.js 已就绪');
      }
      this.checkCancel();

      // 3. dsh + pnpm：全部安装到用户选择的目录，npm 下载缓存与临时文件也放在该目录，不占用系统盘
      current = 'dsh';
      this.step('dsh', 'active', '正在通过 npm 安装 @deepseek-ai/dsh 与 pnpm（首次安装需几分钟）…');
      const L = layoutOf(root);
      for (const d of [L.bin, L.npmGlobal, L.npmCache, L.pnpmStore, L.home, L.cache, L.config, L.data, L.tmp]) {
        fs.mkdirSync(d, { recursive: true });
      }
      const env = buildEnv(nodeBin ? [nodeBin] : extra, {
        npm_config_update_notifier: 'false',
        npm_config_cache: L.npmCache,
        TEMP: L.tmp,
        TMP: L.tmp,
        TMPDIR: L.tmp,
      });
      const npm = nodeBin ? path.join(nodeBin, IS_WIN ? 'npm.cmd' : 'npm') : 'npm';
      // 固定 pnpm 11：12.x 的 postinstall 会重新生成平台 shim，在 Windows + npm 下会内存溢出导致安装失败
      await this.runStep(npm, [
        'install', '-g', '@deepseek-ai/dsh@latest', 'pnpm@11', '--prefix', L.npmGlobal, '--cache', L.npmCache,
        '--registry', regUrl, '--no-fund', '--no-audit', '--loglevel', 'http',
      ], env);
      const innerDsh = findInDir(L.npmGlobalBin);
      if (!innerDsh) throw new Error(`npm 安装完成，但在 ${L.npmGlobalBin} 中未找到 dsh 入口`);
      this.step('dsh', 'done', innerDsh);
      this.checkCancel();

      // 4. 启动脚本 + PATH：包装脚本把 DSH 数据、npm/pnpm 缓存、临时目录都指向安装目录
      current = 'path';
      this.step('path', 'active', '正在生成启动脚本并配置环境变量…');
      const dshPath = writeWrapper(L, innerDsh, nodeBin);
      this.log('ok', `已生成启动脚本：${dshPath}（DSH 数据目录：${L.home}）`);
      const added = await this.ensureUserPath(L.bin);
      this.step('path', 'done', added ? `启动脚本 ${dshPath}，已加入用户 PATH` : `启动脚本 ${dshPath}`);
      this.checkCancel();

      // 5. 验证
      current = 'verify';
      this.step('verify', 'active', '正在运行 dsh --version…');
      const version = await getDshVersion(dshPath, buildEnv([L.bin], {}, true));
      if (!version) throw new Error('dsh --version 未返回版本号，安装可能不完整');
      this.step('verify', 'done', `DeepSeek Harness v${version}`);
      this.log('ok', `安装完成：${dshPath}（v${version}）`);
      return { dshPath, version };
    } catch (e) {
      if (e.cancelled || this.cancelled) {
        this.step(current, 'error', '已取消');
        throw new CancelledError();
      }
      this.step(current, 'error', e.message);
      throw e;
    } finally {
      this.running = false;
      this.child = null;
      this.abort = null;
    }
  }

  /**
   * 下载并解压便携版 Node.js（最新 LTS，且满足 dsh 版本要求、匹配当前平台与架构）。
   * @param {string} root 安装根目录
   * @param {'x64'|'arm64'|'ia32'} arch CPU 架构
   * @param {string} registry 最终选定的源（决定 Node.js 从官方还是国内镜像下载）
   * @returns {Promise<string>} node 可执行文件所在目录
   */
  async installPortableNode(root, arch, registry) {
    const dist = nodeDistFor(registry);
    const plat = IS_WIN ? 'win' : 'darwin';
    const a = arch === 'ia32' ? 'x86' : arch;
    const fileKey = IS_WIN ? `win-${a}-zip` : `osx-${a}-tar`;
    this.log('info', `获取 Node.js 版本列表：${dist}/index.json`);
    const list = await (await this.fetchChecked(`${dist}/index.json`)).json();
    const pick = list.find((r) => r.lts && r.files.includes(fileKey) && nodeSatisfies(parseVersion(r.version)));
    if (!pick) throw new Error(`没有找到适用于 ${plat}-${a} 的 Node.js LTS 版本`);
    const name = `node-${pick.version}-${plat}-${a}`;
    const archive = `${name}${IS_WIN ? '.zip' : '.tar.gz'}`;
    const dlDir = path.join(root, 'downloads');
    fs.mkdirSync(dlDir, { recursive: true });
    const file = path.join(dlDir, archive);
    this.log('info', `下载 Node.js ${pick.version}（${plat}-${a}）…`);
    await this.download(`${dist}/${pick.version}/${archive}`, file);
    this.checkCancel();

    this.emit('progress', { percent: -1, text: '正在解压 Node.js…' });
    const tmp = path.join(root, `.extract-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    // Windows 10 1803+ 自带的 tar.exe（bsdtar）可直接解压 zip，比 PowerShell Expand-Archive 快很多
    const tarExe = IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    await this.runStep(tarExe, [IS_WIN ? '-xf' : '-xzf', file, '-C', tmp], process.env, true);
    const nodeDir = path.join(root, 'node');
    fs.rmSync(nodeDir, { recursive: true, force: true });
    fs.renameSync(path.join(tmp, name), nodeDir);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(file, { force: true });
    const bin = IS_WIN ? nodeDir : path.join(nodeDir, 'bin');
    if (!isExecutable(path.join(bin, IS_WIN ? 'node.exe' : 'node'))) throw new Error('Node.js 解压后未找到 node 可执行文件');
    this.log('ok', `Node.js ${pick.version} 已安装到 ${nodeDir}`);
    return bin;
  }

  /**
   * 把目录加入用户级 PATH（持久化），使终端中也能直接使用 dsh。
   * Windows 写入 HKCU\Environment；macOS 追加到登录 shell 的配置文件。
   * @param {string} dir 要加入的目录
   * @returns {Promise<boolean>} 是否实际做了修改
   */
  async ensureUserPath(dir) {
    const env = buildEnv([], {}, true);
    const has = (env.PATH || env.Path || '').split(path.delimiter).some((p) => path.resolve(p) === path.resolve(dir));
    if (has) return false;
    if (IS_WIN) {
      // 使用 .NET API 读写用户 PATH，避免 setx 截断 1024 字符的问题
      const ps = `$d=${psQuote(dir)};$p=[Environment]::GetEnvironmentVariable('Path','User');`
        + `if(-not $p){$p=''};if(($p -split ';') -notcontains $d){[Environment]::SetEnvironmentVariable('Path',($p.TrimEnd(';')+';'+$d).TrimStart(';'),'User')}`;
      const r = await runCapture('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000 });
      if (r.code !== 0) {
        this.log('warn', `写入用户 PATH 失败（不影响本程序使用）：${r.stderr.trim()}`);
        return false;
      }
    } else {
      const shell = path.basename(process.env.SHELL || '/bin/zsh');
      const rc = path.join(os.homedir(), shell === 'bash' ? '.bash_profile' : '.zprofile');
      const line = `\n# Teager DSH Launcher\nexport PATH="${dir}:$PATH"\n`;
      try {
        const cur = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
        if (!cur.includes(dir)) fs.appendFileSync(rc, line);
      } catch (e) {
        this.log('warn', `写入 ${rc} 失败（不影响本程序使用）：${e.message}`);
        return false;
      }
    }
    this.log('ok', `已将 ${dir} 加入用户 PATH（新打开的终端生效）`);
    return true;
  }

  /**
   * 带状态码检查的 fetch（可被取消）。
   * @param {string} url 地址
   * @returns {Promise<Response>} 响应
   */
  async fetchChecked(url) {
    this.abort = new AbortController();
    const res = await fetch(url, { signal: this.abort.signal });
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）：${url}`);
    return res;
  }

  /**
   * 流式下载文件并上报进度（可被取消）。
   * @param {string} url 下载地址
   * @param {string} dest 保存路径
   */
  async download(url, dest) {
    const res = await this.fetchChecked(url);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(dest);
    let got = 0;
    let lastEmit = 0;
    try {
      for await (const chunk of res.body) {
        this.checkCancel();
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        const now = Date.now();
        if (now - lastEmit > 200) {
          lastEmit = now;
          const mb = (got / 1048576).toFixed(1);
          this.emit('progress', {
            percent: total ? Math.round((got / total) * 100) : -1,
            text: total ? `下载 Node.js：${mb} / ${(total / 1048576).toFixed(1)} MB` : `下载 Node.js：${mb} MB`,
          });
        }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    this.emit('progress', { percent: 100, text: '下载完成' });
  }

  /**
   * 运行一个安装子进程，实时输出日志；非零退出码视为失败。
   * @param {string} file 命令
   * @param {string[]} args 参数
   * @param {NodeJS.ProcessEnv} env 环境变量
   * @param {boolean} [quiet] 是否不输出子进程日志
   * @returns {Promise<void>} 成功时 resolve
   */
  runStep(file, args, env, quiet = false) {
    return new Promise((resolve, reject) => {
      this.checkCancel();
      this.log('info', `> ${path.basename(file)} ${args.join(' ')}`);
      const child = (IS_WIN && /tar\.exe$/i.test(file)) ? spawn(file, args, { windowsHide: true, env }) : spawnAny(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let lines = 0;
      const onLine = (level) => (line) => {
        if (!line.trim() || quiet) return;
        lines += 1;
        this.log(level, line);
        if (lines % 5 === 0) this.emit('progress', { percent: -1, text: line.slice(0, 120) });
      };
      const out = new LineDecoder(onLine('out'));
      const err = new LineDecoder(onLine('out'));
      child.stdout?.on('data', (d) => out.push(d));
      child.stderr?.on('data', (d) => err.push(d));
      child.on('error', (e) => reject(e));
      child.on('close', (code) => {
        out.flush();
        err.flush();
        this.child = null;
        if (this.cancelled) reject(new CancelledError());
        else if (code === 0) resolve();
        else reject(new Error(`${path.basename(file)} 退出码 ${code}，请在控制台查看详细输出`));
      });
    });
  }

  /** 取消安装：中止下载并结束正在运行的安装进程树。 */
  async cancel() {
    if (!this.running) return;
    this.cancelled = true;
    this.log('warn', '正在取消安装并结束安装进程…');
    try {
      this.abort?.abort();
    } catch {
      /* 忽略 */
    }
    if (this.child?.pid) await killTree(this.child.pid);
  }
}

/**
 * 安装目录的子目录布局：运行时、程序、缓存、数据、临时文件全部位于同一个根目录下。
 * @param {string} root 安装根目录
 * @returns {{root: string, bin: string, node: string, npmGlobal: string, npmGlobalBin: string, npmCache: string,
 *   pnpmStore: string, home: string, cache: string, config: string, data: string, tmp: string}} 各子目录
 */
function layoutOf(root) {
  const npmGlobal = path.join(root, 'npm-global');
  return {
    root,
    bin: path.join(root, 'bin'),
    node: path.join(root, 'node'),
    npmGlobal,
    npmGlobalBin: IS_WIN ? npmGlobal : path.join(npmGlobal, 'bin'),
    npmCache: path.join(root, 'npm-cache'),
    pnpmStore: path.join(root, 'pnpm-store'),
    home: path.join(root, 'home'),
    cache: path.join(root, 'cache'),
    config: path.join(root, 'config'),
    data: path.join(root, 'data'),
    tmp: path.join(root, 'tmp'),
  };
}

/**
 * 生成 dsh 包装启动脚本（与手工把 dsh 装到其他盘时的常见做法一致）：
 * 把 DSH_HOME、npm/pnpm 缓存与全局目录、XDG 目录和临时目录都指向安装目录，再调用真正的 dsh。
 * @param {ReturnType<typeof layoutOf>} L 目录布局
 * @param {string} innerDsh npm 安装得到的 dsh 入口
 * @param {string} nodeBin 便携 Node 的目录（使用系统 Node 时为空）
 * @returns {string} 包装脚本路径
 */
function writeWrapper(L, innerDsh, nodeBin) {
  if (IS_WIN) {
    const file = path.join(L.bin, 'dsh.cmd');
    const pathDirs = [L.npmGlobal, nodeBin].filter(Boolean).join(';');
    const lines = [
      '@echo off',
      'rem DeepSeek Harness launcher (generated by Teager DSH Launcher)',
      'setlocal',
      `set "DSH_HOME=${L.home}"`,
      `set "NPM_CONFIG_CACHE=${L.npmCache}"`,
      `set "NPM_CONFIG_PREFIX=${L.npmGlobal}"`,
      `set "NPM_CONFIG_STORE_DIR=${L.pnpmStore}"`,
      // pnpm 11 只读取 pnpm_config_* 环境变量，且其优先级高于用户全局 config.yaml，缺少时缓存会落回系统盘
      `set "PNPM_CONFIG_STORE_DIR=${L.pnpmStore}"`,
      `set "PNPM_CONFIG_CACHE_DIR=${path.join(L.cache, 'pnpm')}"`,
      `set "PNPM_CONFIG_STATE_DIR=${path.join(L.cache, 'pnpm-state')}"`,
      `set "PNPM_HOME=${L.npmGlobal}"`,
      `set "XDG_CACHE_HOME=${L.cache}"`,
      `set "XDG_CONFIG_HOME=${L.config}"`,
      `set "XDG_DATA_HOME=${L.data}"`,
      `set "TEMP=${L.tmp}"`,
      `set "TMP=${L.tmp}"`,
      `set "PATH=${pathDirs};%PATH%"`,
      `call "${innerDsh}" %*`,
      'exit /b %errorlevel%',
      '',
    ];
    // cmd.exe 按系统代码页解析批处理，脚本内容保持纯 ASCII（路径已由 validateDir 限制）
    fs.writeFileSync(file, lines.join('\r\n'), 'ascii');
    return file;
  }
  const file = path.join(L.bin, 'dsh');
  const pathDirs = [L.npmGlobalBin, nodeBin].filter(Boolean).join(':');
  const lines = [
    '#!/bin/sh',
    '# DeepSeek Harness 启动脚本（由 Teager DSH Launcher 生成）',
    `export DSH_HOME="${L.home}"`,
    `export npm_config_cache="${L.npmCache}"`,
    `export npm_config_prefix="${L.npmGlobal}"`,
    `export npm_config_store_dir="${L.pnpmStore}"`,
    `export pnpm_config_store_dir="${L.pnpmStore}"`,
    `export pnpm_config_cache_dir="${path.join(L.cache, 'pnpm')}"`,
    `export pnpm_config_state_dir="${path.join(L.cache, 'pnpm-state')}"`,
    `export PNPM_HOME="${L.npmGlobal}"`,
    `export XDG_CACHE_HOME="${L.cache}"`,
    `export XDG_CONFIG_HOME="${L.config}"`,
    `export XDG_DATA_HOME="${L.data}"`,
    `export TMPDIR="${L.tmp}"`,
    `export PATH="${pathDirs}:$PATH"`,
    `exec "${innerDsh}" "$@"`,
    '',
  ];
  fs.writeFileSync(file, lines.join('\n'), { encoding: 'utf8', mode: 0o755 });
  return file;
}

/**
 * 校验用户选择的安装目录 / 工作空间目录。
 * 限制为 ASCII 且不含 shell 特殊字符：批处理脚本与大量原生构建工具（node-gyp 等）在中文或特殊字符路径下会出错。
 * @param {string} dir 目录
 * @param {string} label 字段名称（用于提示）
 * @returns {string} 错误信息；合法时为空字符串
 */
function validateDir(dir, label) {
  const d = String(dir || '').trim();
  if (!d) return `请选择${label}`;
  if (!path.isAbsolute(d)) return `${label}必须是完整的绝对路径`;
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(d)) return `${label}请不要包含中文或其他非英文字符`;
  if (/[%!^&|<>"`$;]/.test(d)) return `${label}不能包含特殊字符 % ! ^ & | < > " \` $ ;`;
  if (!isDirWritable(d)) return `${label}无法创建或没有写入权限：${d}`;
  return '';
}

/**
 * 生成 PowerShell 单引号字符串字面量。
 * @param {string} s 原始字符串
 * @returns {string} 转义后的字面量
 */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

module.exports = { Installer, STEPS, layoutOf, validateDir };
