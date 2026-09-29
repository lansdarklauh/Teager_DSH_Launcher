'use strict';

/**
 * Node.js / pnpm / dsh 等工具路径的配置解析与本地候选检测。
 * - 设置中的路径可以是可执行文件，也可以是其所在目录；为空则使用默认（PATH 自动查找）；
 * - “获取路径”会扫描本机，列出候选项作为输入框的自动补全选项。
 * @module tools
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { IS_WIN, buildEnv, whichAll, isExecutable, runCapture } = require('./proc-util');
const { dshCandidates } = require('./locator');
const { registryEnv } = require('./system');

/**
 * 把用户配置的工具路径转换为需要加入 PATH 的目录。
 * @param {string} p 设置中的路径（文件或目录）
 * @returns {string} 目录；路径为空或不存在时返回空字符串
 */
function toolDir(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  try {
    const st = fs.statSync(s);
    return st.isDirectory() ? s : path.dirname(s);
  } catch {
    return '';
  }
}

/**
 * 校验配置的工具路径：为空视为使用默认；填写了则必须存在，并且目录里确实有对应的可执行文件。
 * @param {string} p 设置中的路径
 * @param {'node'|'pnpm'} name 工具名
 * @param {string} label 界面上的名称（用于提示）
 * @returns {string} 错误信息；合法时为空字符串
 */
function validateToolPath(p, name, label) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (!fs.existsSync(s)) return `${label}路径不存在：${s}`;
  const dir = toolDir(s);
  const hit = (IS_WIN ? ['.exe', '.cmd', '.bat'] : ['']).some((e) => isExecutable(path.join(dir, name + e)));
  return hit ? '' : `${label}路径下没有找到 ${name} 可执行文件：${dir}`;
}

/**
 * 当前设置中需要前置到 PATH 的工具目录（Node.js、pnpm）。
 * @param {{nodePath?: string, pnpmPath?: string}} cfg 设置
 * @returns {string[]} 目录列表（去重）
 */
function toolDirs(cfg) {
  return [...new Set([toolDir(cfg.nodePath), toolDir(cfg.pnpmPath)].filter(Boolean))];
}

/**
 * 本程序在安装目录下补装的工具目录（例如 pnpm）：存在时加入 PATH。
 * @param {string} installRoot 安装根目录
 * @returns {string[]} 已存在的目录
 */
function fallbackBinDirs(installRoot) {
  if (!installRoot) return [];
  const dir = path.join(installRoot, 'npm-global', IS_WIN ? '' : 'bin');
  return fs.existsSync(dir) ? [dir] : [];
}

/**
 * 构造运行 dsh / 控制台命令 / 安装更新时使用的环境变量：
 * 用户配置的 Node.js、pnpm 目录 + 补装目录前置到 PATH，并注入所选 npm 源。
 * @param {object} cfg 设置
 * @param {string[]} [extraDirs] 额外前置目录（如 dsh 所在目录）
 * @param {Record<string,string>} [extraEnv] 额外环境变量
 * @returns {NodeJS.ProcessEnv} 环境变量
 */
function toolEnv(cfg, extraDirs = [], extraEnv = {}) {
  return buildEnv([...extraDirs, ...toolDirs(cfg), ...fallbackBinDirs(cfg.installRoot)], { ...registryEnv(cfg.registry, cfg.registryCustom), ...extraEnv });
}

/**
 * 去重（Windows 下不区分大小写）并保留原有顺序。
 * @param {string[]} list 路径列表
 * @returns {string[]} 去重结果
 */
function uniquePaths(list) {
  const seen = new Set();
  return list.filter((p) => {
    const k = IS_WIN ? p.toLowerCase() : p;
    if (!p || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 读取某个可执行文件的版本号（用于在候选项里标注版本）。
 * @param {string} file 可执行文件
 * @param {string[]} args 参数
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @returns {Promise<string>} 版本号，失败为空字符串
 */
async function versionOf(file, args, env) {
  const r = await runCapture(file, args, { env, timeout: 15000 });
  const m = `${r.stdout}\n${r.stderr}`.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/);
  return r.code === 0 && m ? m[0] : '';
}

/**
 * 检测本机 node / pnpm / dsh 的候选路径。
 * 来源：PATH 中的所有命中、各版本管理器目录（nvm / volta / fnm / scoop 等）、本程序安装目录、dsh 所在目录。
 * @param {object} cfg 设置
 * @returns {Promise<{node: Array<{path: string, label: string}>, pnpm: Array<{path: string, label: string}>, dsh: Array<{path: string, label: string}>}>} 候选项
 */
async function detectCandidates(cfg) {
  const env = buildEnv([], {}, true);
  const home = os.homedir();
  const la = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const ad = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const root = cfg.installRoot;

  const dshList = dshCandidates(root, cfg.lastDetectedPath, env);
  const dshDirs = dshList.flatMap((p) => [path.dirname(p), path.join(path.dirname(p), '..', 'npm-global')]).map((p) => path.normalize(p));

  // Node.js：PATH 命中 + 常见目录（版本管理器、官方安装目录、本程序便携版、dsh 旁的便携版）
  const nodeDirs = IS_WIN
    ? [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'), path.join(la, 'Programs', 'nodejs'),
      process.env.NVM_SYMLINK || '', path.join(la, 'Volta', 'bin'), path.join(home, 'scoop', 'apps', 'nodejs', 'current'),
      path.join(root, 'node'), ...dshDirs,
    ]
    : [
      '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.volta', 'bin'), path.join(root, 'node', 'bin'),
      ...safeList(path.join(home, '.nvm', 'versions', 'node')).map((v) => path.join(home, '.nvm', 'versions', 'node', v, 'bin')),
    ];
  const nodeFiles = uniquePaths([
    ...whichAll('node', env),
    ...nodeDirs.map((d) => firstExec(d, 'node')).filter(Boolean),
  ]);

  // pnpm：PATH 命中 + PNPM_HOME + npm 全局目录 + 本程序补装目录 + dsh 旁的 npm-global
  const pnpmDirs = [
    process.env.PNPM_HOME || '', path.join(la, 'pnpm'), path.join(ad, 'npm'), path.join(home, 'Library', 'pnpm'),
    path.join(root, 'npm-global'), path.join(root, 'npm-global', 'bin'), ...dshDirs,
  ];
  const pnpmFiles = uniquePaths([
    ...whichAll('pnpm', env),
    ...pnpmDirs.map((d) => firstExec(d, 'pnpm')).filter(Boolean),
  ]);

  const label = async (file, args, prefix) => {
    const v = await versionOf(file, args, env);
    return { path: file, label: v ? `${prefix} v${v}` : prefix };
  };
  const [node, pnpm, dsh] = await Promise.all([
    Promise.all(nodeFiles.slice(0, 8).map((f) => label(f, ['-v'], 'Node.js'))),
    Promise.all(pnpmFiles.slice(0, 8).map((f) => label(f, ['-v'], 'pnpm'))),
    Promise.all(dshList.slice(0, 8).map((f) => label(f, ['--version'], 'dsh'))),
  ]);
  return { node, pnpm, dsh };
}

/**
 * 列出目录内容（失败返回空数组）。
 * @param {string} dir 目录
 * @returns {string[]} 子项名称
 */
function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 在目录中查找指定工具的可执行文件。
 * @param {string} dir 目录
 * @param {string} name 工具名
 * @returns {string} 完整路径，找不到为空字符串
 */
function firstExec(dir, name) {
  if (!dir) return '';
  for (const ext of IS_WIN ? ['.exe', '.cmd', '.bat'] : ['']) {
    const p = path.join(dir, name + ext);
    if (isExecutable(p)) return path.normalize(p);
  }
  return '';
}

module.exports = {
  toolDir, toolDirs, toolEnv, fallbackBinDirs, validateToolPath, detectCandidates,
};
