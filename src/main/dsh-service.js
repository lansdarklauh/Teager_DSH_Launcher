'use strict';

/**
 * dsh Web 服务进程管理：启动 / 停止 / 重启、解析访问地址、端口冲突回退、残留进程清理、插件变更监测。
 * @module dsh-service
 */

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  IS_WIN, spawnAny, killTree, killTreeSync, isAlive, isPortFree, LineDecoder, runCapture,
} = require('./proc-util');
const { resolveDshHome } = require('./locator');
const { toolEnv } = require('./tools');
const { effectivePort } = require('./config');

/** 匹配 dsh web 启动完成时打印的带 token 访问地址。 */
const URL_RE = /dsh web:\s+(https?:\/\/[^\s)]+)/;

/**
 * 将一行参数文本按空白切分，支持双引号包裹含空格的参数。
 * @param {string} text 参数文本
 * @returns {string[]} 参数数组
 */
function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1] ?? m[2]);
  return out;
}

/**
 * dsh 服务类。事件：
 * - state (快照对象)：状态变化
 * - ready (url)：服务就绪
 * - plugins-changed ()：profile 插件依赖发生变化，需要重启生效
 */
class DshService extends EventEmitter {
  /**
   * @param {{getConfig: () => object, log: (level: string, text: string) => void, pidFile: string}} opts 构造参数
   */
  constructor(opts) {
    super();
    /** @type {() => object} 读取最新设置 */
    this.getConfig = opts.getConfig;
    /** @type {(level: string, text: string) => void} 日志回调 */
    this.log = opts.log;
    /** @type {string} 记录服务 PID 的文件（用于上次异常退出后的残留清理） */
    this.pidFile = opts.pidFile;
    /** @type {'stopped'|'starting'|'running'|'stopping'|'crashed'} 当前状态 */
    this.state = 'stopped';
    /** @type {import('node:child_process').ChildProcess|null} 服务子进程 */
    this.child = null;
    /** @type {string} 带 token 的访问地址 */
    this.url = '';
    /** @type {number} 实际监听端口 */
    this.port = 0;
    /** @type {string} 当前使用的 dsh 入口 */
    this.dshPath = '';
    /** @type {string} DSH_HOME 目录 */
    this.dshHome = '';
    /** @type {string} 启动目录（默认工作区） */
    this.workDir = '';
    /** @type {number} 启动时间戳 */
    this.startedAt = 0;
    /** @type {number|null} 最近一次退出码 */
    this.exitCode = null;
    /** @type {string[]} 最近的错误输出（崩溃时展示给用户） */
    this.tail = [];
    /** @type {boolean} 是否由用户主动停止 */
    this.stopping = false;
    /** @type {string} 插件依赖指纹，用于判断是否真的发生变化 */
    this.pluginPrint = '';
    /** @type {string} 正在监听的 profile package.json 路径 */
    this.watchedFile = '';
    /** @type {Promise<void>|null} 正在进行的停止操作 */
    this.stopPromise = null;
  }

  /**
   * 当前状态快照（发给界面展示）。
   * @returns {object} 快照
   */
  snapshot() {
    return {
      state: this.state,
      url: this.url,
      port: this.port,
      pid: this.child?.pid || 0,
      dshPath: this.dshPath,
      dshHome: this.dshHome,
      workDir: this.workDir,
      startedAt: this.startedAt,
      exitCode: this.exitCode,
      tail: this.tail.slice(-15),
    };
  }

  /**
   * 切换状态并通知界面。
   * @param {string} state 新状态
   */
  setState(state) {
    this.state = state;
    this.emit('state', this.snapshot());
  }

  /**
   * 启动 dsh Web 服务。
   * @param {string} dshPath dsh 入口路径
   */
  async start(dshPath) {
    if (this.state === 'starting' || this.state === 'running') return;
    if (this.stopPromise) await this.stopPromise;
    const cfg = this.getConfig();
    this.dshPath = dshPath;
    this.dshHome = resolveDshHome(dshPath);
    this.workDir = cfg.workDir && fs.existsSync(cfg.workDir) ? cfg.workDir : os.homedir();
    this.url = '';
    this.exitCode = null;
    this.tail = [];
    this.stopping = false;
    this.setState('starting');

    // 端口留空使用默认端口；被占用时 resolvePort 会回退为随机端口
    const port = await this.resolvePort(effectivePort(cfg.port));
    const profile = cfg.profile || 'web';
    const args = [...(profile === 'web' ? ['web'] : ['--profile', profile]), '--no-open', '--port', String(port), ...splitArgs(cfg.extraArgs)];
    // 注入所选 npm 源（插件市场内安装插件时 pnpm 会读取），并带上用户配置的 Node.js / pnpm 目录
    const env = toolEnv(cfg, [path.dirname(dshPath)]);
    this.log('info', `启动：${dshPath} ${args.join(' ')}（工作目录：${this.workDir}）`);

    let child;
    try {
      child = spawnAny(dshPath, args, { cwd: this.workDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.log('err', `启动失败：${e.message}`);
      this.exitCode = -1;
      this.setState('crashed');
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    this.writePid(child.pid);
    this.emit('state', this.snapshot());

    const onLine = (level) => (line) => {
      if (!line.trim()) return;
      this.log(level, line);
      if (level === 'err' || /error|fail|错误|失败/i.test(line)) {
        this.tail.push(line);
        if (this.tail.length > 40) this.tail.splice(0, 20);
      }
      const m = !this.url && line.match(URL_RE);
      if (m) this.onReady(m[1], profile);
    };
    const out = new LineDecoder(onLine('out'));
    const err = new LineDecoder(onLine('err'));
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => this.log('err', `dsh 进程错误：${e.message}`));
    child.on('close', (code) => {
      out.flush();
      err.flush();
      if (this.child !== child) return;
      this.child = null;
      this.exitCode = code;
      this.unwatchPlugins();
      this.clearPid();
      if (this.stopping) {
        this.log('info', 'dsh 服务已停止');
        this.setState('stopped');
      } else {
        this.log('err', `dsh 服务意外退出（退出码 ${code}）`);
        this.setState('crashed');
      }
    });
  }

  /**
   * 服务打印出访问地址后进入运行状态。
   * @param {string} url 带 token 的访问地址
   * @param {string} profile profile 名称
   */
  onReady(url, profile) {
    this.url = url;
    try {
      this.port = Number(new URL(url).port) || 0;
    } catch {
      this.port = 0;
    }
    this.log('ok', `dsh 服务已就绪（端口 ${this.port}，启动耗时 ${((Date.now() - this.startedAt) / 1000).toFixed(1)} 秒）`);
    this.setState('running');
    this.emit('ready', url);
    this.watchPlugins(path.join(this.dshHome, 'profiles', profile, 'package.json'));
  }

  /**
   * 解析实际使用的端口：配置端口被占用时先短暂等待（重启场景下旧进程释放端口需要时间），仍被占用则让系统随机分配。
   * @param {number} wanted 配置的端口
   * @returns {Promise<number>} 实际端口（0 表示随机）
   */
  async resolvePort(wanted) {
    if (!wanted) return 0;
    for (let i = 0; i < 10; i += 1) {
      if (await isPortFree(wanted)) return wanted;
      await new Promise((r) => setTimeout(r, 300));
    }
    this.log('warn', `端口 ${wanted} 已被占用（可能在终端中另外启动了 dsh web），本次改用随机端口`);
    return 0;
  }

  /**
   * 停止服务并结束整个进程树。
   * @returns {Promise<void>} 停止完成
   */
  stop() {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) {
      if (this.state !== 'stopped') this.setState('stopped');
      return Promise.resolve();
    }
    this.stopping = true;
    this.setState('stopping');
    this.log('info', '正在停止 dsh 服务…');
    this.stopPromise = new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.stopPromise = null;
        resolve();
      };
      const timer = setTimeout(done, 10000);
      child.once('close', done);
      killTree(child.pid);
    });
    return this.stopPromise;
  }

  /**
   * 重启服务。
   * @param {string} dshPath dsh 入口路径
   */
  async restart(dshPath) {
    this.log('info', '重启 dsh 服务…');
    await this.stop();
    await this.start(dshPath || this.dshPath);
  }

  /** 程序退出时同步结束服务（此时已无法等待异步回调）。 */
  killSync() {
    if (this.child?.pid) {
      this.stopping = true;
      killTreeSync(this.child.pid);
      this.clearPid();
    }
  }

  /**
   * 记录服务 PID。
   * @param {number} pid 进程 PID
   */
  writePid(pid) {
    try {
      fs.writeFileSync(this.pidFile, JSON.stringify({ pid, dshPath: this.dshPath, at: Date.now() }));
    } catch {
      /* 忽略 */
    }
  }

  /** 删除 PID 记录文件。 */
  clearPid() {
    try {
      fs.rmSync(this.pidFile, { force: true });
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 清理上次异常退出（崩溃 / 强制结束）后残留的 dsh 进程。
   * 为避免误杀 PID 复用后的无关进程，会先核对进程命令行中包含 dsh。
   */
  async cleanupOrphan() {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(this.pidFile, 'utf8'));
    } catch {
      return;
    }
    this.clearPid();
    if (!rec?.pid || !isAlive(rec.pid)) return;
    const r = IS_WIN
      ? await runCapture('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(rec.pid)}').CommandLine`], { timeout: 15000 })
      : await runCapture('ps', ['-o', 'command=', '-p', String(rec.pid)], { timeout: 5000 });
    if (/dsh/i.test(r.stdout)) {
      this.log('warn', `发现上次残留的 dsh 进程（PID ${rec.pid}），正在清理…`);
      await killTree(rec.pid);
    }
  }

  /**
   * 计算 profile 插件依赖指纹（依赖列表 + bundles 列表）。
   * @param {string} file profile 的 package.json
   * @returns {string} 指纹
   */
  static pluginFingerprint(file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return JSON.stringify([j.dependencies || {}, j.dsh?.profile?.bundles || []]);
    } catch {
      return '';
    }
  }

  /**
   * 开始监听 profile 的 package.json：用户在界面插件中心或控制台安装 / 卸载插件后，提示重启生效。
   * 使用 2 秒一次的 stat 轮询（单文件开销极低，且比 fs.watch 在各平台上更可靠）。
   * @param {string} file profile 的 package.json
   */
  watchPlugins(file) {
    this.unwatchPlugins();
    this.watchedFile = file;
    this.pluginPrint = DshService.pluginFingerprint(file);
    fs.watchFile(file, { interval: 2000 }, () => {
      const next = DshService.pluginFingerprint(file);
      if (next && next !== this.pluginPrint) {
        this.pluginPrint = next;
        this.log('info', '检测到 profile 插件发生变化，重启 dsh 后生效');
        this.emit('plugins-changed');
      }
    });
  }

  /** 停止监听插件变化。 */
  unwatchPlugins() {
    if (this.watchedFile) fs.unwatchFile(this.watchedFile);
    this.watchedFile = '';
  }
}

module.exports = { DshService, splitArgs };
