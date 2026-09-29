'use strict';

/**
 * DSH Plugin Hub（社区插件市场，npm 包名 dsh-plugin）的检测与安装。
 * 检测只读取 profile 的 package.json 与 node_modules 中的包清单（毫秒级，不影响启动速度）；
 * 缺失时按官方方式执行 `dsh plugin --profile <profile> add dsh-plugin`，缺少 pnpm 时先补装 pnpm 11。
 * `addPlugin` 也供手动安装插件使用，参数是已经整理好的 pnpm 包说明。
 * @module plugin-hub
 */

const fs = require('node:fs');
const path = require('node:path');
const { IS_WIN, spawnAny, LineDecoder, isDirWritable, whichAll } = require('./proc-util');

/** DSH Plugin Hub 的 npm 包名。 */
const HUB_PKG = 'dsh-plugin';

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
 * 检测指定 profile 是否已安装 DSH Plugin Hub。
 * 需同时满足：profile 依赖中声明了 dsh-plugin，且 node_modules 中确实存在该包（避免依赖声明了但安装被中断）。
 * @param {string} dshHome DSH_HOME 目录
 * @param {string} profile profile 名称
 * @returns {{installed: boolean, version: string, profileDir: string}} 检测结果
 */
function hubStatus(dshHome, profile) {
  const profileDir = path.join(dshHome, 'profiles', profile);
  const manifest = readJson(path.join(profileDir, 'package.json'));
  const declared = !!manifest?.dependencies?.[HUB_PKG];
  const pkg = readJson(path.join(profileDir, 'node_modules', HUB_PKG, 'package.json'));
  return { installed: declared && !!pkg, version: pkg?.version || '', profileDir };
}

/**
 * 运行一个命令并把输出逐行写入日志。
 * @param {string} file 命令
 * @param {string[]} args 参数
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @param {string} cwd 工作目录
 * @param {(level: string, text: string) => void} log 日志回调
 * @param {(child: import('node:child_process').ChildProcess|null) => void} onChild 子进程登记回调（用于退出时结束）
 * @returns {Promise<{code: number|null, output: string}>} 退出码与合并输出
 */
function runLogged(file, args, env, cwd, log, onChild) {
  return new Promise((resolve) => {
    log('info', `> ${path.basename(file)} ${args.join(' ')}`);
    let child;
    try {
      child = spawnAny(file, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, output: e.message });
      return;
    }
    onChild(child);
    const lines = [];
    const onLine = (line) => {
      if (!line.trim()) return;
      lines.push(line);
      log('out', line);
    };
    const out = new LineDecoder(onLine);
    const err = new LineDecoder(onLine);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => lines.push(e.message));
    child.on('close', (code) => {
      out.flush();
      err.flush();
      onChild(null);
      resolve({ code, output: lines.join('\n') });
    });
  });
}

/**
 * 用 `dsh plugin add` 安装一个插件。
 * @param {{
 *   dshPath: string, profile: string, spec: string, registry: string, installRoot: string, cwd: string,
 *   env: NodeJS.ProcessEnv, log: (level: string, text: string) => void,
 *   onChild: (child: import('node:child_process').ChildProcess|null) => void,
 *   isCancelled: () => boolean
 * }} o 安装参数；spec 为 pnpm 包说明（包名、link:目录、压缩包路径或 Git 地址）；registry 为空表示沿用用户自己的 npm 配置
 * @returns {Promise<string[]>} 为补装 pnpm 新增、需要加入 PATH 的目录（无则为空数组）
 */
async function addPlugin(o) {
  const regArgs = o.registry ? ['--registry', o.registry] : [];
  const addArgs = ['plugin', '--profile', o.profile, 'add', o.spec, ...regArgs];
  let r = await runLogged(o.dshPath, addArgs, o.env, o.cwd, o.log, o.onChild);
  if (o.isCancelled()) throw new Error('已取消');
  const extraDirs = [];

  // dsh plugin 依赖 pnpm；找不到时先补装 pnpm 11 再重试。
  // 不同 dsh 版本的表现不同：旧版退出码 127 并提示 pnpm not found，新版经 shell 调用时由系统报“不是内部或外部命令”，
  // 因此同时结合 PATH 中是否存在 pnpm 来判断（自定义包装脚本可能自带 pnpm 目录，所以只在失败后才判断）。
  const pnpmMissing = r.code === 127
    || /pnpm not found|'pnpm'|pnpm: (command )?not found|不是内部或外部命令/i.test(r.output)
    || whichAll('pnpm', o.env).length === 0;
  if (r.code !== 0 && pnpmMissing) {
    o.log('warn', '未找到 pnpm，先安装 pnpm 11（dsh 插件管理依赖 pnpm）…');
    const prefix = path.join(o.installRoot, 'npm-global');
    if (!isDirWritable(prefix)) throw new Error(`pnpm 安装目录不可写：${prefix}`);
    const p = await runLogged('npm', ['install', '-g', 'pnpm@11', '--prefix', prefix, ...regArgs, '--no-fund', '--no-audit'], o.env, o.cwd, o.log, o.onChild);
    if (o.isCancelled()) throw new Error('已取消');
    if (p.code !== 0) throw new Error(`pnpm 安装失败（退出码 ${p.code}）`);
    const bin = IS_WIN ? prefix : path.join(prefix, 'bin');
    extraDirs.push(bin);
    const env = { ...o.env };
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    env[key] = `${bin}${path.delimiter}${env[key] || ''}`;
    r = await runLogged(o.dshPath, addArgs, env, o.cwd, o.log, o.onChild);
    if (o.isCancelled()) throw new Error('已取消');
  }
  if (r.code !== 0) {
    const last = r.output.split('\n').filter(Boolean).pop() || '';
    const shown = String(o.spec || '').length > 120 ? `${o.spec.slice(0, 120)}…` : o.spec;
    throw new Error(`dsh plugin add ${shown} 失败（退出码 ${r.code}）${last ? `：${last.slice(0, 160)}` : ''}`);
  }
  return extraDirs;
}

/**
 * 安装 DSH Plugin Hub（社区插件市场）。
 * @param {Parameters<typeof addPlugin>[0]} o 安装参数（无需传入 spec）
 * @returns {Promise<string[]>} 为补装 pnpm 新增、需要加入 PATH 的目录
 */
function installHub(o) {
  return addPlugin({ ...o, spec: `${HUB_PKG}@latest` });
}

module.exports = { HUB_PKG, hubStatus, installHub, addPlugin, runLogged };
