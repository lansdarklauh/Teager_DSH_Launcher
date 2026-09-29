'use strict';

/**
 * 手动安装插件：把四种来源整理成 `dsh plugin add` 能接受的 pnpm 包说明。
 * - npm：已发布的包名，可带版本
 * - link：本机插件目录，安装后仍指向原目录
 * - tarball：上传的 .tgz / .tar.gz 压缩包（先写入临时文件再安装）
 * - git：Git 仓库地址（安装时本机需要有 Git）
 * @module plugin-install
 */

const fs = require('node:fs');
const path = require('node:path');

/** 支持的来源。 */
const PLUGIN_KINDS = ['npm', 'link', 'tarball', 'git'];

/** npm 包名，可选 @版本 / dist-tag；也允许 @scope/name。 */
const NPM_SPEC_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[^\s@]+)?$/i;

/** pnpm 可识别的 Git 包说明。 */
const GIT_SPEC_RE = /^(?:https?:\/\/\S+|git\+https?:\/\/\S+|git\+ssh:\/\/\S+|ssh:\/\/\S+|git:\/\/\S+|git@[^\s:]+:[^\s]+\/[^\s]+|(?:github|gitlab|bitbucket):[^\s/]+\/[^\s]+)$/i;

/**
 * 把用户输入整理成 pnpm 包说明。
 * @param {string} kind 来源：npm / link / tarball / git
 * @param {string} value 包名、目录、压缩包路径或仓库地址
 * @returns {{spec?: string, error?: string}} 成功时含 spec，失败时含中文原因
 */
function resolvePluginSpec(kind, value) {
  const raw = String(value || '').trim().replace(/^["']|["']$/g, '');
  if (!PLUGIN_KINDS.includes(kind)) return { error: '不支持的插件来源' };
  if (kind === 'npm') return resolveNpm(raw);
  if (kind === 'link') return resolveLink(raw);
  if (kind === 'tarball') return resolveTarball(raw);
  return resolveGit(raw);
}

/**
 * 校验 npm 包名。
 * @param {string} raw 用户输入
 * @returns {{spec?: string, error?: string}} 包说明或错误
 */
function resolveNpm(raw) {
  if (!raw) return { error: '请填写插件包名' };
  // 作用域包名只有一个斜杠（@scope/name）。反斜杠、盘符和协议前缀属于另外三种来源。
  if (/^(?:link:|file:|https?:|git\+|git@|(?:github|gitlab|bitbucket):)/i.test(raw) || /\\/.test(raw) || /^[a-z]:/i.test(raw)) {
    return { error: '这不是 npm 包名。本地目录、压缩包和 Git 仓库请切换对应的来源' };
  }
  if (!NPM_SPEC_RE.test(raw)) return { error: '包名格式不正确，例如 my-plugin 或 my-plugin@1.2.3' };
  return { spec: raw };
}

/**
 * 校验本机插件目录，并生成 link: 说明。
 * @param {string} raw 目录路径
 * @returns {{spec?: string, error?: string}} 包说明或错误
 */
function resolveLink(raw) {
  if (!raw) return { error: '请选择插件目录' };
  const abs = path.resolve(raw);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { error: `插件目录不存在：${abs}` };
  }
  if (!st.isDirectory()) return { error: '请选择插件所在的目录' };
  const manifestPath = path.join(abs, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { error: '该目录没有可用的 package.json，不是 dsh 插件包' };
  }
  if (!manifest || typeof manifest !== 'object' || !manifest.name) return { error: 'package.json 中缺少包名 name' };
  if (!manifest.dsh) return { error: 'package.json 中没有 dsh 字段，这不是 dsh 插件' };
  return { spec: `link:${toPosixPath(abs)}` };
}

/**
 * 把界面上传的压缩包写入临时目录，供后续 `dsh plugin add` 使用。
 * @param {string} dir 临时目录
 * @param {string} fileName 原始文件名
 * @param {Buffer|ArrayBuffer|Uint8Array} data 文件内容
 * @returns {{path?: string, error?: string}} 临时文件路径或错误
 */
function saveUploadedTarball(dir, fileName, data) {
  const base = path.basename(String(fileName || ''));
  if (!/\.(tgz|tar\.gz)$/i.test(base)) return { error: '请上传 .tgz 或 .tar.gz 文件' };
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (!buf.length) return { error: '上传的压缩包是空文件' };
  if (buf.length > 200 * 1024 * 1024) return { error: '压缩包超过 200MB，无法上传' };
  const safe = base.replace(/[^\w.\-@()+]/g, '_');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${Date.now()}-${safe}`);
  fs.writeFileSync(dest, buf);
  return { path: dest };
}

/**
 * 校验已落盘的插件压缩包。
 * @param {string} raw 临时文件路径
 * @returns {{spec?: string, error?: string}} 包说明或错误
 */
function resolveTarball(raw) {
  if (!raw) return { error: '请上传插件压缩包' };
  const abs = path.resolve(raw);
  const base = path.basename(abs).toLowerCase();
  if (!base.endsWith('.tgz') && !base.endsWith('.tar.gz')) return { error: '压缩包需要是 .tgz 或 .tar.gz' };
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { error: `压缩包不存在：${abs}` };
  }
  if (!st.isFile()) return { error: '请上传 .tgz 或 .tar.gz 文件' };
  return { spec: toPosixPath(abs) };
}

/**
 * 校验 Git 仓库地址。
 * @param {string} raw 仓库地址
 * @returns {{spec?: string, error?: string}} 包说明或错误
 */
function resolveGit(raw) {
  if (!raw) return { error: '请填写 Git 仓库地址' };
  if (!GIT_SPEC_RE.test(raw)) {
    return { error: '仓库地址格式不正确，例如 https://github.com/org/repo.git、git@github.com:org/repo.git 或 github:org/repo' };
  }
  return { spec: raw };
}

/**
 * 转成 pnpm 包说明里更稳妥的路径（保留盘符，反斜杠改为正斜杠）。
 * @param {string} abs 绝对路径
 * @returns {string} 正斜杠路径
 */
function toPosixPath(abs) {
  return abs.replace(/\\/g, '/');
}

module.exports = { PLUGIN_KINDS, resolvePluginSpec, saveUploadedTarball };
