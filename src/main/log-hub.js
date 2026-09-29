'use strict';

/**
 * 日志中心：统一收集 dsh 服务、控制台命令、安装器与系统日志。
 * 性能要点：固定容量环形缓冲、按时间窗口批量推送给界面、异步追加写入日志文件。
 * @module log-hub
 */

const fs = require('node:fs');
const path = require('node:path');
const { localTime } = require('./proc-util');

/** 匹配 ANSI 转义序列（颜色、光标控制等），界面上不需要这些控制字符。 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/**
 * 日志中心类。
 */
class LogHub {
  /**
   * @param {string} logDir 日志文件目录
   * @param {(batch: object[]) => void} flushFn 批量推送给界面的回调
   * @param {number} [capacity] 内存中保留的最大条数
   */
  constructor(logDir, flushFn, capacity = 4000) {
    /** @type {string} 日志文件目录 */
    this.logDir = logDir;
    /** @type {(batch: object[]) => void} 推送回调 */
    this.flushFn = flushFn;
    /** @type {number} 环形缓冲容量 */
    this.capacity = capacity;
    /** @type {object[]} 环形缓冲区 */
    this.ring = [];
    /** @type {object[]} 待推送的增量 */
    this.pending = [];
    /** @type {NodeJS.Timeout|null} 批量推送定时器 */
    this.timer = null;
    /** @type {number} 自增日志 ID */
    this.seq = 0;
    /** @type {fs.WriteStream|null} 当前日志文件写入流 */
    this.stream = null;
    /** @type {string} 当前日志文件对应的日期（按本地日期切分文件） */
    this.streamDate = '';
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {
      /* 目录创建失败时仅保留内存日志 */
    }
  }

  /**
   * 追加一条日志。
   * @param {'dsh'|'cmd'|'sys'|'install'} src 来源：服务 / 控制台命令 / 系统 / 安装
   * @param {'out'|'err'|'info'|'warn'|'ok'} level 级别
   * @param {string} text 文本
   */
  add(src, level, text) {
    const clean = String(text).replace(ANSI_RE, '');
    const now = new Date();
    const entry = { id: ++this.seq, t: localTime(now), src, level, text: clean };
    this.ring.push(entry);
    // 超出 25% 余量时才整体裁剪一次，摊还后每条日志的开销为 O(1)
    if (this.ring.length > this.capacity * 1.25) this.ring.splice(0, this.ring.length - this.capacity);
    this.pending.push(entry);
    this.writeFile(now, entry);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 80);
  }

  /** 立即把待推送的增量发给界面。 */
  flush() {
    this.timer = null;
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    try {
      this.flushFn(batch);
    } catch {
      /* 窗口可能已销毁 */
    }
  }

  /**
   * 追加写入按本地日期切分的日志文件。
   * @param {Date} now 当前时间
   * @param {{t:string, src:string, level:string, text:string}} entry 日志条目
   */
  writeFile(now, entry) {
    const p = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    try {
      if (date !== this.streamDate || !this.stream) {
        if (this.stream) this.stream.end();
        this.stream = fs.createWriteStream(path.join(this.logDir, `harness-${date}.log`), { flags: 'a' });
        this.stream.on('error', () => {
          this.stream = null;
        });
        this.streamDate = date;
      }
      this.stream.write(`${entry.t} [${entry.src}/${entry.level}] ${entry.text}\n`);
    } catch {
      /* 写文件失败不影响界面日志 */
    }
  }

  /**
   * 获取内存中的全部历史日志（界面刷新或重新打开时恢复用）。
   * @returns {object[]} 日志条目
   */
  history() {
    return this.ring.slice(-this.capacity);
  }

  /** 清空内存中的日志（不删除日志文件）。 */
  clear() {
    this.ring = [];
    this.pending = [];
  }

  /** 关闭文件写入流。 */
  close() {
    this.flush();
    if (this.stream) this.stream.end();
    this.stream = null;
  }
}

module.exports = { LogHub };
