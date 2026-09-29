'use strict';

/**
 * 控制台命令执行器：在与 dsh 服务相同的环境（PATH、工作目录）下执行用户输入的命令，
 * 例如 `dsh plugin --profile web add <插件>`。支持向正在运行的命令发送输入与强制停止。
 * Windows 使用 PowerShell（与用户平时在 PowerShell 中输入 dsh 命令的习惯一致），macOS 使用用户默认 shell。
 * @module command-runner
 */

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { IS_WIN, killTree, LineDecoder } = require('./proc-util');

/**
 * 命令执行器类。事件：line (level, text)、busy (boolean)。
 */
class CommandRunner extends EventEmitter {
  constructor() {
    super();
    /** @type {import('node:child_process').ChildProcess|null} 正在运行的命令进程 */
    this.child = null;
    /** @type {string} 正在运行的命令文本 */
    this.command = '';
  }

  /** @returns {boolean} 是否有命令正在运行 */
  get busy() {
    return !!this.child;
  }

  /**
   * 执行一条命令。
   * @param {string} line 命令文本
   * @param {string} cwd 工作目录
   * @param {NodeJS.ProcessEnv} env 环境变量
   * @returns {boolean} 是否成功启动（已有命令在运行时返回 false）
   */
  run(line, cwd, env) {
    if (this.child) return false;
    let child;
    if (IS_WIN) {
      // 使用 -EncodedCommand（UTF-16LE Base64）传递命令，彻底规避引号转义问题，并强制 UTF-8 输出
      // 以 -EncodedCommand 启动且输出被重定向时，PowerShell 会把错误流序列化为 CLIXML（界面上是一堆 XML）。
      // 这里把错误记录还原为纯文本并直接写入 stderr，同时保留原生命令的退出码。
      const script = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;'
        + "$ProgressPreference='SilentlyContinue';"
        + `& {\n${line}\n} 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { [Console]::Error.WriteLine($_.ToString()) } else { $_ } };`
        + 'exit $LASTEXITCODE';
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      child = spawn(process.env.SHELL || '/bin/zsh', ['-c', line], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    this.child = child;
    this.command = line;
    this.emit('busy', true);
    const started = Date.now();
    const out = new LineDecoder((t) => this.emit('line', 'out', t));
    const err = new LineDecoder((t) => this.emit('line', 'err', t));
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.stdin.on('error', () => {});
    child.on('error', (e) => this.emit('line', 'err', `命令启动失败：${e.message}`));
    child.on('close', (code) => {
      out.flush();
      err.flush();
      this.child = null;
      this.command = '';
      const sec = ((Date.now() - started) / 1000).toFixed(1);
      this.emit('line', code === 0 ? 'ok' : 'warn', `命令结束，退出码 ${code ?? '已终止'}，耗时 ${sec} 秒`);
      this.emit('busy', false);
    });
    return true;
  }

  /**
   * 向正在运行的命令写入一行输入（用于回答交互式提问，例如 y/n 确认）。
   * @param {string} text 输入内容
   */
  write(text) {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${text}\n`);
  }

  /** 强制停止正在运行的命令（连同其子进程）。 */
  async stop() {
    if (this.child?.pid) await killTree(this.child.pid, 1500);
  }
}

module.exports = { CommandRunner };
