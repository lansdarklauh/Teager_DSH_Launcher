'use strict';

/**
 * dsh 版本管理：从所选 npm 源远程拉取版本列表，并把 dsh 更新（或回退）到指定版本。
 * @module dsh-update
 */

const fs = require('node:fs');
const path = require('node:path');
const { runLogged } = require('./plugin-hub');

/** dsh 的 npm 包名。 */
const DSH_PKG = '@deepseek-ai/dsh';

/**
 * 解析 semver 版本号（含预发布标识）。
 * @param {string} v 版本号，如 0.1.7-rc.2
 * @returns {{nums: number[], pre: Array<string|number>}|null} 解析结果
 */
function parseSemver(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.').map((x) => (/^\d+$/.test(x) ? +x : x)) : [] };
}

/**
 * 比较两个版本号（遵循 semver 规则：有预发布标识的版本小于同号正式版，标识按段比较）。
 * @param {string} a 版本 A
 * @param {string} b 版本 B
 * @returns {number} a>b 为正，a<b 为负，相等为 0
 */
function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return String(a).localeCompare(String(b));
  for (let i = 0; i < 3; i += 1) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * 从 npm 源拉取 dsh 的全部版本。使用精简元数据（Accept: install-v1），只包含版本与 dist-tags，体积小、速度快。
 * @param {string} registry npm 源地址
 * @returns {Promise<{tags: Record<string,string>, versions: Array<{version: string, tags: string[]}>}>} 版本列表（从新到旧）
 */
async function fetchVersions(registry) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25000);
  try {
    const res = await fetch(`${registry}/${DSH_PKG.replace('/', '%2F')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    const tags = doc['dist-tags'] || {};
    const versions = Object.keys(doc.versions || {})
      .filter((v) => parseSemver(v))
      .sort((a, b) => compareSemver(b, a))
      .map((version) => ({ version, tags: Object.keys(tags).filter((t) => tags[t] === version) }));
    if (!versions.length) throw new Error('源中没有找到 dsh 的版本信息');
    return { tags, versions };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? '请求超时' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

/** 沙箱插件包名：较新的 dsh 自带，较旧的 dsh 需要 profile 自行安装同版本。 */
const SANDBOX_PKG = '@deepseek-ai/dsh-sandbox-local';

/**
 * 读取 JSON 文件，失败返回 null。
 * @param {string} file 文件路径
 * @returns {any} 解析结果
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 更新 / 回退 dsh 之后同步 profile：
 * 部分旧版本的 dsh 不自带 dsh-sandbox-local，需要 profile 里装有与 dsh 同版本的该包，否则服务无法启动
 * （新版本自带该包，此时不需要任何处理）。缺失或版本不符时，用 `dsh plugin add` 补装对应版本。
 * @param {{
 *   dshPath: string, dshHome: string, profile: string, version: string, pkgDir: string, registry: string,
 *   env: NodeJS.ProcessEnv, cwd: string, log: (level: string, text: string) => void,
 *   onChild: (child: import('node:child_process').ChildProcess|null) => void
 * }} o 参数
 * @returns {Promise<string>} 说明文字（无需处理时为空字符串）
 */
async function syncProfileAfterUpdate(o) {
  // dsh 包自带该插件：直接使用自带的，profile 中的旧副本不受影响
  if (fs.existsSync(path.join(o.pkgDir, 'node_modules', ...SANDBOX_PKG.split('/'), 'package.json'))) return '';
  const profileDir = path.join(o.dshHome, 'profiles', o.profile);
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) return '';
  const cur = readJson(path.join(profileDir, 'node_modules', ...SANDBOX_PKG.split('/'), 'package.json'))?.version;
  if (cur === o.version) return '';
  o.log('info', `此版本的 dsh 不自带沙箱插件，同步 profile「${o.profile}」的 ${SANDBOX_PKG}@${o.version}（当前：${cur || '未安装'}）`);
  const r = await runLogged(o.dshPath, ['plugin', '--profile', o.profile, 'add', `${SANDBOX_PKG}@${o.version}`, '--registry', o.registry], o.env, o.cwd, o.log, o.onChild);
  if (r.code !== 0) throw new Error(`同步 profile 依赖失败（退出码 ${r.code}）`);
  return `已同步 profile 的 ${SANDBOX_PKG}@${o.version}`;
}

module.exports = { DSH_PKG, fetchVersions, compareSemver, parseSemver, syncProfileAfterUpdate };
