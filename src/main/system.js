'use strict';

/**
 * 系统环境检测：操作系统、真实 CPU 架构、内存、磁盘、Node.js / npm / pnpm / Git 版本以及 npm 源连通性。
 * @module system
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runCapture, IS_MAC } = require('./proc-util');

/**
 * 获取可读的操作系统名称与版本。
 * @returns {string} 例如 “Windows 10.0.19045” 或 “macOS 15.1”
 */
function osName() {
  if (IS_MAC) {
    try {
      const r = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 3000 });
      return `macOS ${String(r.stdout).trim()}`;
    } catch {
      return `macOS (Darwin ${os.release()})`;
    }
  }
  return `Windows ${os.release()}`;
}

/** 预设的 npm 源（另有 custom：用户自定义地址；auto：测速择优 / 沿用用户 .npmrc）。 */
const REGISTRIES = {
  npmmirror: 'https://registry.npmmirror.com',
  npmjs: 'https://registry.npmjs.org',
  tencent: 'https://mirrors.cloud.tencent.com/npm',
  huawei: 'https://repo.huaweicloud.com/repository/npm',
};

/** 预设源的中文名称。 */
const REGISTRY_NAMES = {
  npmmirror: '淘宝 npmmirror（国内推荐）',
  npmjs: 'npm 官方',
  tencent: '腾讯云',
  huawei: '华为云',
  custom: '自定义',
  auto: '自动测速 / 沿用 .npmrc',
};

/** Node.js 二进制下载地址：仅选择 npm 官方源时使用 nodejs.org，其余一律用国内镜像。 */
const NODE_DIST = {
  official: 'https://nodejs.org/dist',
  mirror: 'https://npmmirror.com/mirrors/node',
};

/**
 * 规范化用户输入的自定义源地址：仅接受 http(s)，去掉末尾斜杠。
 * @param {string} url 用户输入
 * @returns {string} 规范化后的地址；不合法时为空字符串
 */
function normalizeRegistryUrl(url) {
  const s = String(url || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+/i.test(s) ? s : '';
}

/**
 * 根据源偏好得到 npm 源地址。
 * @param {string} pref 源偏好（预设名 / custom / auto）
 * @param {string} custom 自定义源地址
 * @returns {string} 源地址；auto 或无效时为空字符串
 */
function registryUrl(pref, custom) {
  if (pref === 'custom') return normalizeRegistryUrl(custom);
  return REGISTRIES[pref] || '';
}

/**
 * 根据 npm 源得到 Node.js 二进制下载地址。
 * @param {string} pref 最终选定的源偏好
 * @returns {string} 下载根地址
 */
function nodeDistFor(pref) {
  return pref === 'npmjs' ? NODE_DIST.official : NODE_DIST.mirror;
}

/**
 * 获取真实的 CPU 架构。
 * x64 程序在 ARM64 Windows 仿真、或在 Apple 芯片的 Rosetta 下运行时，process.arch 仍为 x64，需要额外判断。
 * @returns {'x64'|'arm64'|'ia32'} 架构
 */
function realArch() {
  if (IS_MAC) {
    if (os.arch() === 'arm64') return 'arm64';
    try {
      const r = spawnSync('sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8', timeout: 3000 });
      if (String(r.stdout).trim() === '1') return 'arm64';
    } catch {
      /* 旧系统无此键，按 x64 处理 */
    }
    return 'x64';
  }
  const a = (process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || os.arch()).toLowerCase();
  if (a.includes('arm64') || a === 'arm64') return 'arm64';
  if (a.includes('amd64') || a === 'x64') return 'x64';
  if (a === 'x86' || a === 'ia32') return 'ia32';
  return os.arch() === 'arm64' ? 'arm64' : 'x64';
}

/**
 * 解析 vX.Y.Z 形式的版本号。
 * @param {string} text 包含版本号的文本
 * @returns {{major:number, minor:number, patch:number, raw:string} | null} 版本对象
 */
function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], raw: `${m[1]}.${m[2]}.${m[3]}` };
}

/**
 * 判断 Node.js 版本是否满足 dsh 的运行要求。
 * dsh 依赖 node:sqlite 与 import.meta.main：需要 22.18+（22 系列）或 24.2+；23.x 不支持。
 * @param {{major:number, minor:number}|null} v 版本
 * @returns {boolean} 是否满足
 */
function nodeSatisfies(v) {
  if (!v) return false;
  if (v.major === 22) return v.minor >= 18;
  if (v.major === 24) return v.minor >= 2;
  return v.major > 24;
}

/**
 * 测量访问某个 URL 的耗时。
 * @param {string} url 地址
 * @param {number} timeout 超时毫秒
 * @returns {Promise<number>} 耗时（毫秒），失败返回 Infinity
 */
async function measure(url, timeout = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    await res.arrayBuffer();
    return res.ok ? Date.now() - t0 : Infinity;
  } catch {
    return Infinity;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 测试 npm 源的连通性与延迟：偏好为 auto 时只测官方与国内镜像用于择优，否则只测所选源（省去无用的网络等待）。
 * @param {string} pref 源偏好
 * @param {string} [custom] 自定义源地址
 * @returns {Promise<Record<string, number>>} 源名称 → 延迟毫秒
 */
async function probeRegistries(pref = 'npmmirror', custom = '') {
  const targets = pref === 'auto'
    ? [['npmjs', REGISTRIES.npmjs], ['npmmirror', REGISTRIES.npmmirror]]
    : [[pref, registryUrl(pref, custom) || REGISTRIES.npmmirror]];
  const entries = await Promise.all(targets.map(async ([k, url]) => [k, await measure(`${url}/@deepseek-ai%2Fdsh/latest`)]));
  return Object.fromEntries(entries);
}

/**
 * 设置页“测速”：并发测试所有预设源与自定义源。
 * @param {string} custom 自定义源地址
 * @returns {Promise<Record<string, number>>} 源名称 → 延迟毫秒（不可达为 null，便于 IPC 序列化）
 */
async function probeAllRegistries(custom = '') {
  const targets = Object.entries(REGISTRIES);
  const c = normalizeRegistryUrl(custom);
  if (c) targets.push(['custom', c]);
  const entries = await Promise.all(targets.map(async ([k, url]) => {
    const ms = await measure(`${url}/@deepseek-ai%2Fdsh/latest`);
    return [k, Number.isFinite(ms) ? ms : null];
  }));
  return Object.fromEntries(entries);
}

/**
 * 根据源偏好生成注入子进程的环境变量（npm 与 pnpm 都读取 npm_config_registry）。
 * 偏好为 auto 时不注入，沿用用户自己的 .npmrc 配置。
 * @param {string} pref 源偏好
 * @param {string} [custom] 自定义源地址
 * @returns {Record<string, string>} 环境变量
 */
function registryEnv(pref, custom = '') {
  const url = registryUrl(pref, custom);
  return url ? { npm_config_registry: url } : {};
}

/**
 * 解析实际用于“查询 / 下载”的 npm 源地址：预设与自定义直接返回；auto 时读取用户 npm 配置，失败回退国内镜像。
 * @param {string} pref 源偏好
 * @param {string} custom 自定义源地址
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @returns {Promise<string>} 源地址
 */
async function resolveRegistryUrl(pref, custom, env) {
  const url = registryUrl(pref, custom);
  if (url) return url;
  const r = await runCapture('npm', ['config', 'get', 'registry'], { env, timeout: 15000 });
  const line = r.code === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() : '';
  return normalizeRegistryUrl(line) || REGISTRIES.npmmirror;
}

/**
 * 获取某个命令输出的版本号。
 * @param {string} cmd 命令
 * @param {string[]} args 参数
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @returns {Promise<string>} 版本号，未安装时为空字符串
 */
async function cmdVersion(cmd, args, env) {
  const r = await runCapture(cmd, args, { env, timeout: 15000 });
  if (r.code !== 0) return '';
  const v = parseVersion(r.stdout);
  return v ? v.raw : '';
}

/**
 * 获取目录所在磁盘的剩余空间（向上寻找已存在的父目录）。
 * @param {string} dir 目录
 * @returns {number} 剩余字节数，失败返回 -1
 */
function freeDiskBytes(dir) {
  let p = dir;
  while (p && !fs.existsSync(p)) {
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  try {
    const s = fs.statfsSync(p);
    return s.bavail * s.bsize;
  } catch {
    return -1;
  }
}

/**
 * 列出可用于安装的磁盘 / 卷及其空间（只做 statfs，毫秒级）。
 * Windows 枚举盘符；macOS 为系统盘（用户主目录所在卷）与 /Volumes 下的外接卷。
 * @returns {Array<{root: string, label: string, free: number, total: number, system: boolean}>} 磁盘列表
 */
function listDrives() {
  const out = [];
  const add = (root, label, system) => {
    try {
      const s = fs.statfsSync(root);
      const total = s.blocks * s.bsize;
      if (total > 0) out.push({ root, label, free: s.bavail * s.bsize, total, system });
    } catch {
      /* 光驱、断开的网络盘等不可用卷直接跳过 */
    }
  };
  if (process.platform === 'win32') {
    const sys = (process.env.SystemDrive || 'C:').toUpperCase();
    for (let c = 67; c <= 90; c += 1) {
      const letter = `${String.fromCharCode(c)}:`;
      if (fs.existsSync(`${letter}\\`)) add(`${letter}\\`, letter, letter === sys);
    }
  } else {
    add(os.homedir(), '系统盘（用户目录）', true);
    try {
      for (const v of fs.readdirSync('/Volumes')) {
        const p = path.join('/Volumes', v);
        if (fs.realpathSync(p) !== '/') add(p, v, false);
      }
    } catch {
      /* 无 /Volumes */
    }
  }
  return out;
}

/**
 * 推荐的安装根目录：优先选择剩余空间最大且大于 10GB 的非系统盘，否则使用系统默认位置。
 * @param {string} fallback 默认位置
 * @returns {string} 推荐目录
 */
function suggestInstallRoot(fallback) {
  const best = listDrives()
    .filter((d) => !d.system && d.free > 10 * 1024 ** 3)
    .sort((a, b) => b.free - a.free)[0];
  return best ? path.join(best.root, 'DeepSeekHarness') : fallback;
}

/**
 * 汇总系统环境信息。
 * @param {NodeJS.ProcessEnv} env 刷新后的环境变量
 * @param {string} installRoot 安装根目录（用于检查磁盘空间）
 * @param {string} [registryPref] npm 源偏好
 * @param {string} [registryCustom] 自定义源地址
 * @returns {Promise<object>} 系统信息
 */
async function probeSystem(env, installRoot, registryPref = 'npmmirror', registryCustom = '') {
  const [nodeV, npmV, pnpmV, gitV, latency] = await Promise.all([
    cmdVersion('node', ['-v'], env),
    cmdVersion('npm', ['-v'], env),
    cmdVersion('pnpm', ['-v'], env),
    cmdVersion('git', ['--version'], env),
    probeRegistries(registryPref, registryCustom),
  ]);
  const node = parseVersion(nodeV);
  const cpus = os.cpus();
  return {
    os: osName(),
    platform: process.platform,
    arch: realArch(),
    cpu: cpus[0] ? `${cpus[0].model.trim()} × ${cpus.length}` : '未知',
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    diskFree: freeDiskBytes(installRoot),
    node: nodeV,
    nodeOk: nodeSatisfies(node),
    npm: npmV,
    pnpm: pnpmV,
    git: gitV,
    latency,
  };
}

/**
 * 根据设置与测速结果选择 npm 源。
 * @param {string} pref 用户偏好
 * @param {Record<string, number>} latency 测速结果
 * @returns {string} 最终使用的源（预设名或 custom）
 */
function pickRegistry(pref, latency) {
  if (pref !== 'auto') return pref;
  const a = latency?.npmjs ?? Infinity;
  const b = latency?.npmmirror ?? Infinity;
  // 两者都不可达或持平时优先国内镜像
  return a < b ? 'npmjs' : 'npmmirror';
}

module.exports = {
  probeSystem, listDrives, suggestInstallRoot, pickRegistry, registryEnv, registryUrl, normalizeRegistryUrl, nodeDistFor,
  probeAllRegistries, resolveRegistryUrl, parseVersion, nodeSatisfies, realArch, REGISTRIES, REGISTRY_NAMES, NODE_DIST,
};
