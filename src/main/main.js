'use strict';

/**
 * Teager DSH Launcher 主进程入口。
 * 职责：窗口与托盘、关闭行为（最小化 / 退出）、dsh 检测 → 自动安装 → 启动、内嵌 Web UI 的安全与交互、
 * 控制台命令、IPC、退出时清理所有子进程。
 * @module main
 */

const path = require('node:path');
const fs = require('node:fs');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, session, clipboard,
} = require('electron');
const { ConfigStore, DEFAULTS } = require('./config');
const { LogHub } = require('./log-hub');
const { locateDsh, getDshVersion, resolveDshHome, resolveInstallTarget } = require('./locator');
const { Installer, STEPS, validateDir } = require('./installer');
const { DshService } = require('./dsh-service');
const { CommandRunner } = require('./command-runner');
const { hubStatus, installHub, addPlugin, runLogged } = require('./plugin-hub');
const { resolvePluginSpec, saveUploadedTarball } = require('./plugin-install');
const {
  registryUrl, normalizeRegistryUrl, REGISTRY_NAMES, listDrives, suggestInstallRoot, probeAllRegistries, resolveRegistryUrl,
} = require('./system');
const { toolEnv, toolDirs, validateToolPath, detectCandidates } = require('./tools');
const {
  fetchVersions, compareSemver, syncProfileAfterUpdate, DSH_PKG,
} = require('./dsh-update');
const { IS_WIN, IS_MAC, primeShellPath, killTree, whichAll } = require('./proc-util');

/** 内嵌 dsh 页面使用的持久化会话分区（登录态、界面偏好在重启后保留）。 */
const DSH_PARTITION = 'persist:dsh';

/** 资源目录（图标等）。 */
const ASSETS = path.join(__dirname, '..', 'assets');

/** 是否以隐藏方式启动（开机自启时只驻留托盘并在后台预热 dsh）。 */
const START_HIDDEN = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

/**
 * 应用初始化（仅在获得单实例锁后执行）。
 */
function bootstrap() {
  /** @type {BrowserWindow|null} 主窗口 */
  let win = null;
  /** @type {Tray|null} 托盘图标 */
  let tray = null;
  /** @type {boolean} 是否正在退出（退出流程中不再拦截窗口关闭） */
  let quitting = false;
  /** @type {boolean} 退出清理是否已完成 */
  let cleaned = false;
  /** @type {Installer|null} 当前安装器 */
  let installer = null;
  /** @type {import('node:child_process').ChildProcess|null} 正在安装 Plugin Hub 的子进程（退出程序时需结束） */
  let hubChild = null;
  /** @type {import('node:child_process').ChildProcess|null} 正在更新 dsh 的 npm 子进程（退出程序时需结束） */
  let updateChild = null;
  /** @type {import('node:child_process').ChildProcess|null} 正在手动安装插件的子进程（退出或取消时需结束） */
  let pluginChild = null;
  /** 用户是否取消了当前的手动插件安装 */
  let pluginCancel = false;

  app.setAppUserModelId('com.teager.dsh-launcher');

  const userData = app.getPath('userData');
  const config = new ConfigStore(userData);
  const logDir = path.join(userData, 'logs');
  const hub = new LogHub(logDir, (batch) => send('logs', batch));
  const sysLog = (level, text) => hub.add('sys', level, text);
  const service = new DshService({
    getConfig: () => config.data,
    log: (level, text) => hub.add('dsh', level, text),
    pidFile: path.join(userData, 'dsh.pid'),
  });
  const runner = new CommandRunner();

  /** 发给界面的整体状态。 */
  const appState = {
    /**
     * detecting 检测中 | install-setup 选择安装位置 | installing 安装中 | install-failed 安装失败
     * | hub 安装 Plugin Hub | service 服务阶段
     */
    phase: 'detecting',
    /** 安装位置选择：安装根目录（含缓存与数据）、工作空间目录、可选磁盘列表 */
    setup: { installRoot: '', workDir: '', drives: [], platform: process.platform },
    dsh: { path: '', source: '', version: '' },
    /** DSH Plugin Hub 检查状态：pending / active / done / skip / error */
    hub: { status: 'pending', detail: '' },
    /** dsh 版本更新状态：idle / running / done / error */
    update: { status: 'idle', version: '', text: '', message: '' },
    install: freshInstallState(),
    service: service.snapshot(),
    pluginsChanged: false,
  };

  /**
   * 生成一份初始的安装状态。
   * @returns {object} 安装状态
   */
  function freshInstallState() {
    return { steps: STEPS.map((s) => ({ ...s, status: 'pending', detail: '' })), system: null, progress: { percent: -1, text: '' }, error: '' };
  }

  /**
   * 向界面发送消息（窗口不存在时忽略）。
   * @param {string} channel 通道
   * @param {any} payload 数据
   */
  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  /** 推送整体状态并同步托盘提示。 */
  function pushState() {
    appState.service = service.snapshot();
    send('state', appState);
    updateTray();
  }

  // ───────────────────────────── 窗口 ─────────────────────────────

  /** 创建主窗口。 */
  function createWindow() {
    win = new BrowserWindow({
      width: 1360,
      height: 880,
      minWidth: 960,
      minHeight: 620,
      show: false,
      title: 'Teager DSH Launcher',
      icon: path.join(ASSETS, 'icon.png'),
      backgroundColor: '#F5F7FB',
      titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
      ...(IS_WIN ? { titleBarOverlay: { color: '#FFFFFF', symbolColor: '#475569', height: 44 } } : {}),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
        spellcheck: false,
      },
    });
    Menu.setApplicationMenu(IS_MAC ? macMenu() : null);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.once('ready-to-show', () => {
      if (!START_HIDDEN) win.show();
    });

    // 拦截关闭：按设置最小化到托盘 / 退出 / 询问
    win.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      const action = config.get('closeAction');
      if (action === 'minimize') hideToTray();
      else if (action === 'quit') quitApp();
      else {
        showWindow();
        send('ask-close');
      }
    });

    // 内嵌 webview 的安全加固：禁止注入 preload / Node 能力，只允许加载本机回环地址
    win.webContents.on('will-attach-webview', (e, prefs, params) => {
      delete prefs.preload;
      prefs.nodeIntegration = false;
      prefs.contextIsolation = true;
      prefs.sandbox = true;
      if (params.src && !isLoopback(params.src) && params.src !== 'about:blank') e.preventDefault();
    });
  }

  /** 显示并聚焦主窗口。 */
  function showWindow() {
    if (!win || win.isDestroyed()) createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** 隐藏窗口到托盘（dsh 继续在后台运行）。 */
  function hideToTray() {
    if (!win) return;
    win.hide();
    if (IS_WIN && tray && !config.get('trayTipShown')) {
      tray.displayBalloon({ title: 'Teager DSH Launcher 仍在运行', content: '已最小化到系统托盘，双击托盘图标可恢复窗口。', iconType: 'info' });
      config.save({ trayTipShown: true });
    }
  }

  /**
   * macOS 应用菜单（保留复制粘贴等标准快捷键）。
   * @returns {Menu} 菜单
   */
  function macMenu() {
    return Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'about', label: '关于' }, { type: 'separator' }, { role: 'hide', label: '隐藏' }, { label: '退出', accelerator: 'Cmd+Q', click: () => quitApp() }] },
      { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
      { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { role: 'close', label: '关闭窗口' }] },
    ]);
  }

  // ───────────────────────────── 托盘 ─────────────────────────────

  /** 创建托盘图标与菜单。 */
  function createTray() {
    const img = IS_MAC
      ? nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'))
      : nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
    if (IS_MAC) img.setTemplateImage(true);
    tray = new Tray(img);
    tray.on('click', () => (IS_MAC ? tray.popUpContextMenu() : showWindow()));
    tray.on('double-click', () => showWindow());
    updateTray();
  }

  /** 根据服务状态刷新托盘提示与菜单。 */
  function updateTray() {
    if (!tray) return;
    const labels = { stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', crashed: '异常退出' };
    const phaseText = {
      installing: '安装中', 'install-failed': '安装失败', 'install-setup': '待选择安装位置', hub: '安装插件市场', detecting: '检测中', updating: '更新中',
    }[appState.phase] || labels[service.state];
    tray.setToolTip(`Teager DSH Launcher · ${phaseText}${service.port ? ` · 端口 ${service.port}` : ''}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `状态：${phaseText}`, enabled: false },
      { type: 'separator' },
      { label: '显示主界面', click: () => showWindow() },
      { label: '重新启动 DSH', enabled: !!appState.dsh.path && appState.phase === 'service', click: () => restartService() },
      { label: '在浏览器中打开', enabled: !!service.url, click: () => shell.openExternal(service.url) },
      { type: 'separator' },
      { label: '退出程序', click: () => quitApp() },
    ]));
  }

  // ───────────────────────────── dsh 生命周期 ─────────────────────────────

  /**
   * 检测 dsh：找到则启动服务，找不到则自动安装。
   * @param {boolean} [refresh] 是否刷新持久化 PATH 缓存（重新检测时使用）
   */
  async function detectAndStart(refresh = false) {
    appState.phase = 'detecting';
    appState.pluginsChanged = false;
    appState.hub = { status: 'pending', detail: '' };
    pushState();
    await service.cleanupOrphan();
    const cfg = config.data;
    const found = await locateDsh({ manualPath: cfg.dshPath, lastPath: cfg.lastDetectedPath, installRoot: cfg.installRoot, refresh }, (m) => sysLog('info', m));
    if (!found) {
      enterSetup();
      return;
    }
    useDsh(found.path, found.source);
    await ensurePluginHub(found.path);
    await service.start(found.path);
  }

  /**
   * 启动前检查 DSH Plugin Hub（插件市场），未安装则按官方方式自动安装。
   * 安装失败只提示警告，不阻塞 dsh 启动。
   * @param {string} dshPath dsh 入口
   */
  async function ensurePluginHub(dshPath) {
    const cfg = config.data;
    const profile = cfg.profile || 'web';
    if (!cfg.checkPluginHub) {
      appState.hub = { status: 'skip', detail: '已在设置中关闭检查' };
      pushState();
      return;
    }
    const dshHome = resolveDshHome(dshPath);
    const st = hubStatus(dshHome, profile);
    if (st.installed) {
      appState.hub = { status: 'done', detail: `已安装 v${st.version}` };
      pushState();
      return;
    }
    const log = (level, text) => hub.add('install', level, text);
    log('info', `profile「${profile}」未安装 DSH Plugin Hub，开始自动安装（${st.profileDir}）`);
    appState.phase = 'hub';
    appState.hub = { status: 'active', detail: '未安装，正在通过 dsh plugin 自动安装…' };
    pushState();
    try {
      const workDir = cfg.workDir && fs.existsSync(cfg.workDir) ? cfg.workDir : app.getPath('home');
      await installHub({
        dshPath,
        profile,
        registry: registryUrl(cfg.registry, cfg.registryCustom),
        installRoot: cfg.installRoot,
        cwd: workDir,
        env: toolEnv(cfg, [path.dirname(dshPath)]),
        log,
        onChild: (c) => {
          hubChild = c;
        },
        isCancelled: () => quitting,
      });
      const after = hubStatus(dshHome, profile);
      appState.hub = after.installed
        ? { status: 'done', detail: `已安装 v${after.version}` }
        : { status: 'error', detail: '安装命令已执行，但未检测到 dsh-plugin' };
      log(after.installed ? 'ok' : 'warn', after.installed ? `DSH Plugin Hub v${after.version} 安装完成` : '未检测到 dsh-plugin，请在控制台查看输出');
    } catch (e) {
      appState.hub = { status: 'error', detail: `${e.message}（已跳过，继续启动 DSH）` };
      log('err', `DSH Plugin Hub 安装失败：${e.message}，将继续启动 DSH`);
    }
    if (quitting) return;
    appState.phase = 'service';
    pushState();
  }

  /**
   * 按用户选择的来源手动安装插件（npm 包、本地目录、压缩包或 Git 仓库）。
   * @param {{kind?: string, value?: string, fileName?: string, data?: Buffer|ArrayBuffer|Uint8Array}} payload 来源与内容；压缩包为上传的文件名和内容
   * @returns {Promise<{ok: boolean, error?: string, cancelled?: boolean}>} 安装结果
   */
  async function installManualPlugin(payload) {
    if (!appState.dsh.path) return { ok: false, error: '尚未检测到 dsh，请先完成安装并启动' };
    if (pluginChild || hubChild || updateChild) return { ok: false, error: '已有安装或更新正在进行，请稍后再试' };
    if (runner.busy) return { ok: false, error: '控制台已有命令在运行，请等待其结束或点击“停止”' };
    const kind = payload?.kind;
    // 安装成功后保留上传文件：pnpm 会按 file: 路径引用它，删掉会导致以后重装失败。
    let uploaded = '';
    let keepUpload = false;
    let value = payload?.value;
    if (kind === 'tarball') {
      const saved = saveUploadedTarball(path.join(app.getPath('userData'), 'plugin-uploads'), payload?.fileName, payload?.data);
      if (saved.error) return { ok: false, error: saved.error };
      uploaded = saved.path;
      value = saved.path;
    }
    try {
      const resolved = resolvePluginSpec(kind, value);
      if (resolved.error) return { ok: false, error: resolved.error };
      const cfg = config.data;
      const env = toolEnv(cfg, [path.dirname(appState.dsh.path)]);
      if (kind === 'git' && whichAll('git', env).length === 0) {
        return { ok: false, error: '未检测到 Git。安装 Git 仓库插件需要先安装 Git' };
      }
      const profile = cfg.profile || 'web';
      const log = (level, text) => hub.add('install', level, text);
      pluginCancel = false;
      const shown = kind === 'tarball' ? `上传压缩包 ${path.basename(String(payload?.fileName || ''))}` : resolved.spec;
      log('info', `手动安装插件到 profile「${profile}」：${shown}`);
      const workDir = cfg.workDir && fs.existsSync(cfg.workDir) ? cfg.workDir : app.getPath('home');
      await addPlugin({
        dshPath: appState.dsh.path,
        profile,
        spec: resolved.spec,
        registry: registryUrl(cfg.registry, cfg.registryCustom),
        installRoot: cfg.installRoot,
        cwd: workDir,
        env,
        log,
        onChild: (c) => {
          pluginChild = c;
        },
        isCancelled: () => pluginCancel || quitting,
      });
      if (pluginCancel) return { ok: false, cancelled: true };
      keepUpload = true;
      log('ok', '插件安装完成，重启 DSH 后生效');
      return { ok: true };
    } catch (e) {
      if (pluginCancel || e.message === '已取消') return { ok: false, cancelled: true };
      const log = (level, text) => hub.add('install', level, text);
      log('err', `插件安装失败：${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      if (uploaded && !keepUpload) {
        try { fs.unlinkSync(uploaded); } catch { /* 失败时清理未使用的上传文件 */ }
      }
    }
  }

  /**
   * 更新 / 回退 dsh 到指定版本：停止服务 → 沿用 dsh 自身的 npm 全局前缀与缓存环境执行 npm install -g → 校验版本 → 重新启动。
   * 无论成败都会在结束时重新启动服务（更新失败时旧版本通常仍可用）。
   * @param {string} version 目标版本号
   */
  async function updateDsh(version) {
    const dshPath = appState.dsh.path;
    const cfg = config.data;
    const log = (level, text) => hub.add('install', level, text);
    const setText = (text) => {
      appState.update.text = text;
      send('update-progress', text);
    };
    appState.phase = 'updating';
    appState.update = { status: 'running', version, text: '正在停止 DSH 服务…', message: '' };
    pushState();
    try {
      // 已在 IPC 入口校验过安装位置，这里再次解析以拿到前缀与环境
      const target = resolveInstallTarget(dshPath);
      await service.stop();
      const baseEnv = toolEnv(cfg);
      const regUrl = await resolveRegistryUrl(cfg.registry, cfg.registryCustom, baseEnv);
      const binDir = IS_WIN ? target.prefix : path.join(target.prefix, 'bin');
      const env = toolEnv(cfg, [...target.pathDirs, binDir], { ...target.env, npm_config_registry: regUrl, npm_config_update_notifier: 'false' });
      log('info', `更新 dsh 到 v${version}（npm 前缀：${target.prefix}；源：${regUrl}）`);
      setText(`正在安装 ${DSH_PKG}@${version}…`);
      const cwd = cfg.workDir && fs.existsSync(cfg.workDir) ? cfg.workDir : app.getPath('home');
      const r = await runLogged('npm', [
        'install', '-g', `${DSH_PKG}@${version}`, '--prefix', target.prefix, '--registry', regUrl, '--no-fund', '--no-audit', '--loglevel', 'http',
      ], env, cwd, (level, text) => {
        log(level, text);
        setText(text.slice(0, 140));
      }, (c) => {
        updateChild = c;
      });
      if (quitting) return;
      if (r.code !== 0) throw new Error(`npm install 失败（退出码 ${r.code}），详情见控制台`);
      setText('正在验证版本…');
      const now = await getDshVersion(dshPath, env);
      if (!now) throw new Error('安装完成，但 dsh --version 没有返回版本号');
      appState.dsh.version = now;
      // 版本变化后同步 profile 依赖；失败只给出提示，仍会继续启动服务
      let note = '';
      try {
        setText('正在同步 profile 依赖…');
        await syncProfileAfterUpdate({
          dshPath, dshHome: resolveDshHome(dshPath), profile: cfg.profile || 'web', version: now, pkgDir: target.pkgDir, registry: regUrl, env, cwd,
          log: (level, text) => log(level, text), onChild: (c) => { updateChild = c; },
        });
      } catch (e) {
        note = `（profile 依赖同步失败：${e.message}）`;
        log('warn', `profile 依赖同步失败：${e.message}`);
      }
      appState.update = { status: 'done', version, text: '', message: `已更新到 v${now}${note}` };
      log('ok', `dsh 已更新到 v${now}`);
    } catch (e) {
      appState.update = { status: 'error', version, text: '', message: e.message };
      log('err', `更新 dsh 失败：${e.message}`);
    }
    updateChild = null;
    if (quitting) return;
    appState.phase = 'service';
    pushState();
    await service.start(dshPath);
  }

  /**
   * 记录当前使用的 dsh，并异步读取版本号（不阻塞服务启动）。
   * @param {string} dshPath dsh 入口
   * @param {string} source 来源说明
   * @param {string} [version] 已知的版本号
   */
  function useDsh(dshPath, source, version = '') {
    appState.dsh = { path: dshPath, source, version };
    appState.phase = 'service';
    if (config.get('lastDetectedPath') !== dshPath) config.save({ lastDetectedPath: dshPath });
    pushState();
    if (!version) {
      getDshVersion(dshPath, toolEnv(config.data, [path.dirname(dshPath)])).then((v) => {
        if (appState.dsh.path === dshPath && v) {
          appState.dsh.version = v;
          pushState();
        }
      });
    }
  }

  /**
   * 进入“选择安装位置”步骤：未安装 dsh 时由用户决定运行时、缓存、数据与工作空间放在哪个盘的哪个目录。
   * 默认值：用户曾设置过则沿用，否则推荐剩余空间最大的非系统盘。
   */
  function enterSetup() {
    const cfg = config.data;
    const installRoot = cfg.installRoot !== DEFAULTS.installRoot ? cfg.installRoot : suggestInstallRoot(DEFAULTS.installRoot);
    const workDir = cfg.workDir !== DEFAULTS.workDir ? cfg.workDir : path.join(installRoot, 'workspace');
    appState.phase = 'install-setup';
    appState.setup = { installRoot, workDir, drives: listDrives(), platform: process.platform };
    sysLog('info', '未安装 DeepSeek Harness，等待选择安装位置');
    pushState();
    showWindow();
  }

  /** 执行自动安装，成功后立即启动服务。 */
  async function runInstall() {
    if (installer?.running) return;
    appState.phase = 'installing';
    appState.install = freshInstallState();
    pushState();
    const cfg = config.data;
    installer = new Installer(
      { installRoot: cfg.installRoot, registry: cfg.registry, registryCustom: cfg.registryCustom, extraDirs: toolDirs(cfg) },
      (level, text) => hub.add('install', level, text),
    );
    installer.on('step', ({ id, status, detail }) => {
      const s = appState.install.steps.find((x) => x.id === id);
      if (s) Object.assign(s, { status, detail });
      pushState();
    });
    installer.on('system', (sys) => {
      appState.install.system = sys;
      pushState();
    });
    installer.on('progress', (p) => {
      appState.install.progress = p;
      send('install-progress', p);
    });
    try {
      const { dshPath, version } = await installer.run();
      useDsh(dshPath, '自动安装', version);
      await ensurePluginHub(dshPath);
      if (!quitting) await service.start(dshPath);
    } catch (e) {
      appState.phase = 'install-failed';
      appState.install.error = e.message;
      hub.add('install', 'err', `安装未完成：${e.message}`);
      pushState();
    }
  }

  /** 重启 dsh 服务。 */
  async function restartService() {
    if (!appState.dsh.path) return;
    appState.pluginsChanged = false;
    await service.restart(appState.dsh.path);
  }

  service.on('state', () => pushState());
  service.on('plugins-changed', () => {
    const mode = config.get('pluginChange');
    if (mode === 'auto') restartService();
    else if (mode === 'prompt') {
      appState.pluginsChanged = true;
      pushState();
    }
  });
  runner.on('line', (level, text) => hub.add('cmd', level, text));
  runner.on('busy', (busy) => send('cmd-busy', busy));

  // ───────────────────────────── 退出 ─────────────────────────────

  /** 退出程序：取消安装、停止命令与 dsh 服务（结束整个进程树）后再真正退出。 */
  async function quitApp() {
    if (quitting) return;
    quitting = true;
    sysLog('info', '正在退出，关闭 dsh 服务与所有子进程…');
    try {
      await Promise.race([
        Promise.all([installer?.cancel(), runner.stop(), service.stop(), hubChild ? killTree(hubChild.pid) : null,
          updateChild ? killTree(updateChild.pid) : null, pluginChild ? killTree(pluginChild.pid) : null]),
        new Promise((r) => setTimeout(r, 12000)),
      ]);
    } catch {
      /* 继续退出 */
    }
    service.killSync();
    cleaned = true;
    hub.close();
    tray?.destroy();
    app.exit(0);
  }

  app.on('before-quit', (e) => {
    if (!cleaned) {
      e.preventDefault();
      quitApp();
    }
  });
  // Windows 注销 / 关机时来不及走异步流程，直接同步结束进程树
  app.on('session-end', () => service.killSync());
  process.on('exit', () => service.killSync());

  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => {
    /* 由托盘常驻，不在窗口关闭时退出 */
  });

  // ───────────────────────────── 内嵌页面 ─────────────────────────────

  /**
   * 判断 URL 是否指向本机回环地址。
   * @param {string} url 地址
   * @returns {boolean} 是否回环
   */
  function isLoopback(url) {
    try {
      const u = new URL(url);
      return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && /^https?:$/.test(u.protocol);
    } catch {
      return false;
    }
  }

  /**
   * 判断 URL 是否与当前 dsh 服务同源。
   * @param {string} url 地址
   * @returns {boolean} 是否同源
   */
  function isDshOrigin(url) {
    try {
      return !!service.url && new URL(url).origin === new URL(service.url).origin;
    } catch {
      return false;
    }
  }

  /**
   * 以系统默认程序打开外部链接（仅允许 http/https/mailto）。
   * @param {string} url 地址
   */
  function openExternalSafe(url) {
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
  }

  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    // dsh 同源的弹出窗口（如弹出式侧栏）在应用内新窗口打开；其他链接交给系统浏览器
    contents.setWindowOpenHandler(({ url }) => {
      if (isDshOrigin(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            icon: path.join(ASSETS, 'icon.png'),
            webPreferences: { partition: DSH_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
          },
        };
      }
      openExternalSafe(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
      if (!isLoopback(url)) {
        e.preventDefault();
        openExternalSafe(url);
      }
    });
    contents.on('context-menu', (_ev, p) => buildContextMenu(contents, p).popup());
    contents.on('before-input-event', (ev, input) => {
      if (input.type !== 'keyDown') return;
      const mod = IS_MAC ? input.meta : input.control;
      if (input.key === 'F12' || (mod && input.shift && input.key.toLowerCase() === 'i')) {
        contents.toggleDevTools();
        ev.preventDefault();
      } else if (input.key === 'F5' || (mod && input.key.toLowerCase() === 'r')) {
        contents.reload();
        ev.preventDefault();
      } else if (mod && input.key === '`') {
        send('toggle-console');
        ev.preventDefault();
      }
    });
  });

  /**
   * 内嵌页面右键菜单（Electron 默认没有右键菜单，复制粘贴需要自行提供）。
   * @param {Electron.WebContents} contents 页面
   * @param {Electron.ContextMenuParams} p 右键参数
   * @returns {Menu} 菜单
   */
  function buildContextMenu(contents, p) {
    const items = [];
    if (p.linkURL) {
      items.push({ label: '在浏览器中打开链接', click: () => openExternalSafe(p.linkURL) });
      items.push({ label: '复制链接地址', click: () => clipboard.writeText(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) {
      items.push({ label: '撤销', role: 'undo', enabled: p.editFlags.canUndo });
      items.push({ label: '重做', role: 'redo', enabled: p.editFlags.canRedo });
      items.push({ type: 'separator' });
      items.push({ label: '剪切', role: 'cut', enabled: p.editFlags.canCut });
    }
    items.push({ label: '复制', role: 'copy', enabled: p.editFlags.canCopy });
    if (p.isEditable) items.push({ label: '粘贴', role: 'paste', enabled: p.editFlags.canPaste });
    items.push({ label: '全选', role: 'selectAll' });
    items.push({ type: 'separator' });
    items.push({ label: '刷新页面', accelerator: 'F5', click: () => contents.reload() });
    items.push({ label: '检查元素', accelerator: 'F12', click: () => contents.inspectElement(p.x, p.y) });
    return Menu.buildFromTemplate(items);
  }

  /** 为 dsh 会话分区配置权限：仅对本机回环地址放行常用权限（麦克风、剪贴板、通知、全屏）。 */
  function setupDshSession() {
    const ses = session.fromPartition(DSH_PARTITION);
    const allowed = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'pointerLock']);
    ses.setPermissionRequestHandler((wc, perm, cb) => cb(allowed.has(perm) && isLoopback(wc.getURL())));
    ses.setPermissionCheckHandler((_wc, perm, origin) => allowed.has(perm) && isLoopback(origin));
  }

  // ───────────────────────────── 开机自启 ─────────────────────────────

  /**
   * 应用“开机后台预启动”设置。
   * @param {boolean} enabled 是否开启
   */
  function applyLoginItem(enabled) {
    try {
      if (IS_MAC) {
        app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
      } else {
        // 便携版运行时 execPath 指向临时解压目录，需要使用原始 exe 路径
        const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
        const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
        app.setLoginItemSettings({ openAtLogin: enabled, path: exe, args });
      }
    } catch (e) {
      sysLog('warn', `设置开机启动失败：${e.message}`);
    }
  }

  // ───────────────────────────── IPC ─────────────────────────────

  ipcMain.handle('app:init', () => ({
    state: (appState.service = service.snapshot(), appState),
    logs: hub.history(),
    config: config.data,
    platform: process.platform,
    version: app.getVersion(),
    cmdBusy: runner.busy,
  }));
  ipcMain.handle('svc:restart', () => restartService());
  ipcMain.handle('svc:stop', () => service.stop());
  ipcMain.handle('svc:start', () => (appState.dsh.path ? service.start(appState.dsh.path) : detectAndStart(true)));
  ipcMain.handle('app:redetect', async () => {
    await service.stop();
    await detectAndStart(true);
  });
  ipcMain.handle('install:start', () => runInstall());
  ipcMain.handle('install:setup', () => enterSetup());
  ipcMain.handle('install:begin', (_e, { installRoot, workDir }) => {
    const root = path.resolve(String(installRoot || '').trim());
    const work = path.resolve(String(workDir || '').trim());
    const error = validateDir(root, '安装与缓存目录') || validateDir(work, '工作空间目录');
    if (error) return { error };
    config.save({ installRoot: root, workDir: work });
    sysLog('info', `安装位置：${root}；工作空间：${work}`);
    runInstall();
    return { ok: true };
  });
  ipcMain.handle('install:cancel', () => installer?.cancel());
  ipcMain.handle('cfg:save', async (_e, rawPatch) => {
    const patch = { ...(rawPatch || {}) };
    // 只校验本次提交的字段，校验失败时不保存任何内容
    if ('port' in patch) {
      patch.port = String(patch.port ?? '').trim();
      if (patch.port !== '' && !(/^\d+$/.test(patch.port) && Number(patch.port) <= 65535)) return { error: '监听端口必须是 0~65535 的整数（留空使用默认端口）' };
    }
    for (const [key, name, label] of [['nodePath', 'node', 'Node.js'], ['pnpmPath', 'pnpm', 'pnpm']]) {
      if (key in patch) {
        patch[key] = String(patch[key] || '').trim();
        const err = validateToolPath(patch[key], name, label);
        if (err) return { error: err };
      }
    }
    if ('dshPath' in patch) {
      patch.dshPath = String(patch.dshPath || '').trim();
      if (patch.dshPath && !fs.existsSync(patch.dshPath)) return { error: `dsh 路径不存在：${patch.dshPath}` };
    }
    if ('registry' in patch && !(patch.registry in REGISTRY_NAMES)) return { error: '未知的镜像源' };
    if ('registryCustom' in patch) {
      const raw = String(patch.registryCustom || '').trim();
      patch.registryCustom = normalizeRegistryUrl(raw);
      if (raw && !patch.registryCustom) return { error: '自定义镜像源地址必须以 http:// 或 https:// 开头' };
    }
    if ((patch.registry ?? config.get('registry')) === 'custom' && !(patch.registryCustom ?? config.get('registryCustom'))) {
      return { error: '已选择“自定义”镜像源，请填写镜像源地址' };
    }
    const before = { ...config.data };
    const next = config.save(patch);
    if (before.launchAtLogin !== next.launchAtLogin) applyLoginItem(!!next.launchAtLogin);
    // 这些设置会影响 dsh 服务进程的启动参数或环境变量，修改后需重启 dsh 才生效
    const keys = ['dshPath', 'nodePath', 'pnpmPath', 'workDir', 'profile', 'port', 'extraArgs', 'registry', 'registryCustom'];
    const changed = keys.filter((k) => String(before[k]) !== String(next[k]));
    return { config: next, needRestart: changed.length > 0, changed };
  });
  // 扫描本机的 node / pnpm / dsh，作为设置页输入框的自动补全选项
  ipcMain.handle('tools:detect', () => detectCandidates(config.data));
  // 设置页“测速”：并发测试所有预设源与自定义源
  ipcMain.handle('registry:probe', (_e, custom) => probeAllRegistries(custom));
  // 从所选镜像源远程拉取 dsh 版本列表
  ipcMain.handle('dsh:versions', async () => {
    const cfg = config.data;
    try {
      const url = await resolveRegistryUrl(cfg.registry, cfg.registryCustom, toolEnv(cfg));
      const r = await fetchVersions(url);
      const current = appState.dsh.version;
      const latest = r.tags.latest || r.versions[0].version;
      // rel：相对当前版本的关系（1 新于当前 / 0 当前 / -1 旧于当前）；当前版本未知时为 null
      const versions = r.versions.slice(0, 150).map((v) => ({ ...v, rel: current ? Math.sign(compareSemver(v.version, current)) : null }));
      return { ok: true, registry: url, current, latest, hasUpdate: !!current && compareSemver(latest, current) > 0, versions };
    } catch (e) {
      return { error: `获取版本列表失败：${e.message}` };
    }
  });
  // 更新 / 回退 dsh 到指定版本（立即返回，进度通过状态推送）
  ipcMain.handle('dsh:update', (_e, { version }) => {
    const v = String(version || '').trim();
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) return { error: '版本号格式不正确' };
    if (appState.phase !== 'service' || !appState.dsh.path) return { error: '当前状态无法更新，请等 DSH 启动完成后再试' };
    if (service.state === 'starting' || service.state === 'stopping') return { error: 'DSH 正在启动或停止，请稍后再试' };
    if (!resolveInstallTarget(appState.dsh.path)) {
      return { error: '无法确定 dsh 的安装位置（可能不是通过 npm 安装的），请在控制台用原来的方式手动更新' };
    }
    updateDsh(v);
    return { ok: true };
  });
  ipcMain.handle('dsh:update-dismiss', () => {
    appState.update = { status: 'idle', version: '', text: '', message: '' };
    pushState();
  });
  ipcMain.handle('cfg:apply-restart', async () => {
    const cfg = config.data;
    await service.stop();
    // dsh 路径变化时需要重新定位，其余设置直接重启即可
    if (cfg.dshPath && cfg.dshPath !== appState.dsh.path) await detectAndStart(true);
    else if (!cfg.dshPath && appState.dsh.source === '手动指定') await detectAndStart(true);
    else if (appState.dsh.path) await service.start(appState.dsh.path);
    else await detectAndStart(true);
  });
  ipcMain.handle('plugin:install', (_e, payload) => installManualPlugin(payload));
  ipcMain.handle('plugin:cancel', () => {
    pluginCancel = true;
    if (pluginChild?.pid) killTree(pluginChild.pid);
  });
  ipcMain.handle('dialog:pick-file', async (_e, kind = 'dsh') => {
    const name = { dsh: 'dsh', node: 'Node.js', pnpm: 'pnpm' }[kind] || kind;
    const r = await dialog.showOpenDialog(win, {
      title: `选择 ${name} 可执行文件`,
      properties: ['openFile'],
      filters: IS_WIN ? [{ name: `${name} 可执行文件`, extensions: ['cmd', 'exe', 'bat'] }, { name: '所有文件', extensions: ['*'] }] : [],
    });
    return r.canceled ? '' : r.filePaths[0];
  });
  ipcMain.handle('dialog:pick-dir', async (_e, title) => {
    const r = await dialog.showOpenDialog(win, { title: title || '选择目录', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? '' : r.filePaths[0];
  });
  ipcMain.handle('cmd:run', (_e, line) => {
    const text = String(line || '').trim();
    if (!text) return false;
    const dshDir = appState.dsh.path ? [path.dirname(appState.dsh.path)] : [];
    const cwd = service.workDir || config.get('workDir');
    hub.add('cmd', 'info', `${IS_WIN ? 'PS' : '$'} ${cwd}> ${text}`);
    const env = toolEnv(config.data, dshDir);
    const ok = runner.run(text, fs.existsSync(cwd) ? cwd : app.getPath('home'), env);
    if (!ok) hub.add('cmd', 'warn', '已有命令正在运行，请等待其结束或点击“停止”');
    return ok;
  });
  ipcMain.handle('cmd:input', (_e, text) => {
    hub.add('cmd', 'info', `← ${text}`);
    runner.write(String(text));
  });
  ipcMain.handle('cmd:stop', () => runner.stop());
  ipcMain.handle('logs:clear', () => hub.clear());
  ipcMain.handle('open:external', (_e, url) => openExternalSafe(String(url || '')));
  ipcMain.handle('open:path', (_e, which) => {
    const map = { logs: logDir, home: service.dshHome, work: service.workDir || config.get('workDir'), dsh: appState.dsh.path ? path.dirname(appState.dsh.path) : '' };
    if (map[which]) shell.openPath(map[which]);
  });
  ipcMain.handle('win:close-choice', (_e, { action, remember }) => {
    if (remember) config.save({ closeAction: action });
    if (action === 'quit') quitApp();
    else hideToTray();
  });
  ipcMain.handle('app:quit', () => quitApp());
  ipcMain.handle('plugins:dismiss', () => {
    appState.pluginsChanged = false;
    pushState();
  });

  // ───────────────────────────── 启动 ─────────────────────────────

  app.whenReady().then(() => {
    setupDshSession();
    createWindow();
    createTray();
    if (config.get('launchAtLogin')) applyLoginItem(true);
    sysLog('info', `Teager DSH Launcher v${app.getVersion()} 启动（${process.platform}-${process.arch}，Electron ${process.versions.electron}）`);
    primeShellPath()
      .then(() => detectAndStart())
      .catch((e) => sysLog('err', `启动流程异常：${e.stack || e.message}`));
  });
}
