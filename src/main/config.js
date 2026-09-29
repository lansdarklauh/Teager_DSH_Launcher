'use strict';

/**
 * 用户设置的读写（保存在 Electron userData 目录下的 settings.json）。
 * @module config
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** dsh Web 服务的默认端口（设置中端口留空时使用）。 */
const DEFAULT_PORT = 3080;

/**
 * 计算实际使用的端口：留空 → 默认端口；0 → 系统随机分配；其余为用户指定端口。
 * @param {number|string} port 设置中的端口值
 * @returns {number} 传给 dsh 的端口
 */
function effectivePort(port) {
  if (port === '' || port === null || port === undefined) return DEFAULT_PORT;
  const n = Number(port);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_PORT;
}

/**
 * 默认设置项。
 * @type {{
 *   dshPath: string, nodePath: string, pnpmPath: string, workDir: string, profile: string, port: number|'', extraArgs: string,
 *   closeAction: 'ask'|'minimize'|'quit', pluginChange: 'prompt'|'auto'|'ignore',
 *   registry: string, registryCustom: string, checkPluginHub: boolean, installRoot: string,
 *   launchAtLogin: boolean, lastDetectedPath: string
 * }}
 */
const DEFAULTS = {
  /** 手动指定的 dsh 可执行文件路径；为空表示自动检测 */
  dshPath: '',
  /** dsh 启动时所在的目录（即默认工作区） */
  workDir: os.homedir(),
  /** 启动的 profile 名称 */
  profile: 'web',
  /** Node.js 路径（可执行文件或所在目录）；为空表示使用 PATH 中的 node */
  nodePath: '',
  /** pnpm 路径（可执行文件或所在目录）；为空表示使用 PATH 中的 pnpm */
  pnpmPath: '',
  /** Web 服务端口；为空表示使用默认端口（3080），0 表示由系统随机分配 */
  port: '',
  /** 追加给 Web 应用的额外启动参数 */
  extraArgs: '',
  /** 关闭窗口时的行为：每次询问 / 最小化到托盘 / 退出程序 */
  closeAction: 'ask',
  /** 检测到插件变更时的行为：提示重启 / 自动重启 / 不处理 */
  pluginChange: 'prompt',
  /** 下载镜像源：npmmirror / npmjs / tencent / huawei / custom / auto。用于安装与更新 dsh、Plugin Hub、插件，并注入 dsh 服务与控制台命令的环境 */
  registry: 'npmmirror',
  /** 自定义 npm 源地址（registry 为 custom 时生效） */
  registryCustom: '',
  /** 启动前检查 DSH Plugin Hub（插件市场）是否已安装，未安装则自动安装 */
  checkPluginHub: true,
  /** 自动安装时（本机无可用 Node.js）的安装根目录 */
  installRoot:
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DeepSeekHarness')
      : path.join(os.homedir(), '.deepseek-harness'),
  /** 开机后自动在后台（托盘）启动并预热 dsh */
  launchAtLogin: false,
  /** 上一次自动检测到的 dsh 路径（用于加速下次启动） */
  lastDetectedPath: '',
  /** 设置文件格式版本（用于默认值变更时的迁移） */
  settingsVersion: 3,
};

/**
 * 设置存储类：负责加载、合并默认值与持久化。
 */
class ConfigStore {
  /**
   * @param {string} dir 设置文件所在目录（通常为 app.getPath('userData')）
   */
  constructor(dir) {
    /** @type {string} 设置文件完整路径 */
    this.file = path.join(dir, 'settings.json');
    /** @type {typeof DEFAULTS} 当前生效的设置 */
    this.data = { ...DEFAULTS };
    this.load();
  }

  /** 从磁盘加载设置，文件损坏时回退为默认值。 */
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // v1 → v2：旧版默认 npm 源为 auto 且会随其他设置一起写入文件，这里迁移为新的默认值（国内镜像）
      const ver = raw.settingsVersion || 1;
      const migrate = ver < 3;
      if (ver < 2 && (!raw.registry || raw.registry === 'auto')) raw.registry = 'npmmirror';
      // v2 → v3：端口留空表示默认；旧版把默认端口 3080 显式写进了文件，这里还原为“留空”
      if (ver < 3) {
        if (raw.port === 3080) raw.port = '';
        raw.settingsVersion = 3;
      }
      this.data = { ...DEFAULTS, ...raw };
      if (migrate) this.save({});
    } catch {
      this.data = { ...DEFAULTS };
    }
    return this.data;
  }

  /**
   * 合并并保存部分设置。
   * @param {Partial<typeof DEFAULTS>} patch 需要更新的字段
   * @returns {typeof DEFAULTS} 保存后的完整设置
   */
  save(patch) {
    const next = { ...this.data, ...patch };
    // 端口：留空保持为空（使用默认端口）；否则必须是 0~65535 的整数，非法值回退为空
    const raw = String(next.port ?? '').trim();
    const port = Number(raw);
    next.port = raw !== '' && Number.isInteger(port) && port >= 0 && port <= 65535 ? port : '';
    next.profile = String(next.profile || '').trim() || DEFAULTS.profile;
    this.data = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    return this.data;
  }

  /**
   * 读取单个设置项。
   * @param {keyof typeof DEFAULTS} key 键名
   * @returns {any} 值
   */
  get(key) {
    return this.data[key];
  }
}

module.exports = { ConfigStore, DEFAULTS, DEFAULT_PORT, effectivePort };
