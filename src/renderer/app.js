'use strict';

/* Teager DSH Launcher 界面逻辑（无框架，DOM 批量更新以保证性能） */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/** 控制台 DOM 中保留的最大行数，超出后成批移除最旧的行。 */
const MAX_LINES = 3000;

/** 日志来源的中文标签。 */
const SRC_LABEL = { dsh: '服务', cmd: '命令', sys: '系统', install: '安装' };

/** 服务状态的中文说明。 */
const SVC_TEXT = { stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', crashed: '异常退出' };

/** 判断一行日志是否为真正的错误（stderr 中有大量非错误输出，例如 Node 的 ExperimentalWarning）。 */
const BAD_RE = /\b(error|errors|exception|fatal|failed|ERR!)\b|错误|失败|异常退出/i;

const ui = {
  state: null,
  config: {},
  platform: 'win32',
  view: 'ui',
  webSrc: '',
  webReady: false,
  webRetries: 0,
  errCount: 0,
  cmdBusy: false,
  history: JSON.parse(localStorage.getItem('cmdHistory') || '[]'),
  histIdx: -1,
  pending: [],
  flushQueued: false,
  atBottom: true,
  lastBootLog: '',
  lastInstallLog: '',
  tick: null,
  lastPhase: '',
  drives: [],
  workTouched: false,
  pluginBusy: false,
  /** @type {File|null} 待上传的插件压缩包 */
  pluginTarball: null,
};

const webview = $('#dsh');
const output = $('#output');

// ───────────────────────────── 初始化 ─────────────────────────────

(async function init() {
  const data = await window.hd.init();
  ui.config = data.config;
  ui.platform = data.platform;
  ui.cmdBusy = data.cmdBusy;
  document.body.classList.add(`plat-${data.platform}`);
  $('#cmd-prompt').textContent = data.platform === 'win32' ? 'PS>' : '$';
  enqueueLogs(data.logs);
  render(data.state);
  renderQuickCommands();
  setBusy(ui.cmdBusy);

  window.hd.onState(render);
  window.hd.onLogs(enqueueLogs);
  window.hd.onInstallProgress(renderInstallProgress);
  // 更新 dsh 期间的实时进度文字（只更新两处文本，避免频繁重绘整个界面）
  window.hd.onUpdateProgress((text) => {
    $('#boot-log').textContent = text;
    $('#ver-progress-text').textContent = text;
  });
  window.hd.onAskClose(() => openModal('#modal-close'));
  window.hd.onCmdBusy(setBusy);
  window.hd.onToggleConsole(() => switchView(ui.view === 'ui' ? 'console' : 'ui'));
})();

// ───────────────────────────── 状态渲染 ─────────────────────────────

/**
 * 根据主进程推送的整体状态刷新界面。
 * @param {object} st 状态
 */
function render(st) {
  ui.state = st;
  const svc = st.service;
  const key = st.phase === 'service' ? svc.state : st.phase;
  const text = {
    detecting: '检测中', 'install-setup': '待安装', installing: '安装中', 'install-failed': '安装失败', hub: '安装插件市场', updating: '更新中',
  }[st.phase] || SVC_TEXT[svc.state];
  $('#status').dataset.s = key;
  $('#status-text').textContent = text;
  $('#status-meta').textContent = svc.state === 'running' && svc.port ? `:${svc.port}` : '';

  $('#btn-restart').disabled = !(st.phase === 'service' && st.dsh.path && svc.state !== 'stopping');
  $('#btn-browser').disabled = !svc.url;

  // 服务就绪后加载（或在重启后重新加载）带 token 的地址
  if (svc.state === 'running' && svc.url && svc.url !== ui.webSrc) {
    ui.webSrc = svc.url;
    ui.webReady = false;
    ui.webRetries = 0;
    webview.src = svc.url;
  }
  if (svc.state !== 'running') ui.webReady = false;

  const setup = st.phase === 'install-setup';
  const installing = st.phase === 'installing' || st.phase === 'install-failed';
  $('#setup').classList.toggle('hidden', !setup);
  $('#install').classList.toggle('hidden', !installing);
  $('#boot').classList.toggle('hidden', setup || installing || (svc.state === 'running' && ui.webReady));
  $('#banner-plugins').classList.toggle('hidden', !st.pluginsChanged || !ui.webReady);

  if (setup) renderSetup(st.setup, ui.lastPhase !== 'install-setup');
  else if (installing) renderInstall(st.install, st.phase === 'install-failed');
  else renderBoot(st);
  ui.lastPhase = st.phase;
  // 版本管理弹窗打开时，同步更新进度 / 结果
  if (!$('#modal-versions').classList.contains('hidden')) renderUpdate(st);
  renderInfo(st);
  manageTicker(svc.state === 'starting' || svc.state === 'running');
}

/**
 * 渲染启动 / 异常屏。
 * @param {object} st 状态
 */
function renderBoot(st) {
  const svc = st.service;
  const icon = $('#boot-icon');
  const steps = { detect: 'pending', hub: st.hub?.status || 'pending', start: 'pending', load: 'pending' };
  const detail = { detect: '', hub: st.hub?.detail || '', start: '', load: '' };
  let title = '正在检测 DeepSeek Harness';
  let sub = '正在查找本机的 dsh 安装位置…';
  let iconCls = '';
  let iconHtml = '<span class="spinner"></span>';
  let actions = [];
  let progress = true;
  let tail = '';

  if (st.phase === 'detecting') {
    steps.detect = 'active';
  } else {
    steps.detect = 'done';
    detail.detect = `${st.dsh.path}${st.dsh.source ? `（${st.dsh.source}）` : ''}`;
    if (st.phase === 'updating') {
      title = '正在更新 DeepSeek Harness';
      sub = `目标版本 v${st.update.version}，完成后会自动重新启动服务，请不要关闭程序…`;
      steps.start = 'active';
      detail.start = '更新期间服务已停止';
    } else if (st.phase === 'hub') {
      title = '正在安装 DSH Plugin Hub';
      sub = '当前 profile 未安装插件市场，正在自动安装（使用所选 npm 源）…';
    } else if (svc.state === 'starting') {
      title = '正在启动 DSH 服务';
      sub = 'dsh 首次加载插件需要一些时间，请稍候…';
      steps.start = 'active';
      detail.start = elapsedText(svc.startedAt);
    } else if (svc.state === 'running') {
      title = '正在加载界面';
      sub = 'DSH 服务已就绪，正在打开 Web 界面…';
      steps.start = 'done';
      detail.start = `端口 ${svc.port}`;
      steps.load = 'active';
    } else if (svc.state === 'stopping') {
      title = '正在停止 DSH 服务';
      sub = '正在结束 dsh 进程树…';
    } else if (svc.state === 'crashed') {
      title = 'DSH 服务意外退出';
      sub = `退出码：${svc.exitCode ?? '未知'}。可查看下方错误信息或控制台完整日志。`;
      iconCls = 'red';
      iconHtml = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>';
      steps.start = 'error';
      progress = false;
      tail = (svc.tail || []).join('\n');
      actions = [['重新启动', 'btn-orange', 'restart'], ['查看控制台', 'btn-ghost', 'show-console'], ['重新检测', 'btn-ghost', 'redetect']];
    } else {
      title = 'DSH 服务已停止';
      sub = '点击下方按钮重新启动服务。';
      iconCls = 'gray';
      iconHtml = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
      progress = false;
      actions = [['启动服务', 'btn-green', 'start'], ['查看控制台', 'btn-ghost', 'show-console']];
    }
  }

  icon.className = `boot-icon ${iconCls}`;
  if (icon.dataset.html !== iconHtml) {
    icon.innerHTML = iconHtml;
    icon.dataset.html = iconHtml;
  }
  $('#boot-title').textContent = title;
  $('#boot-sub').textContent = sub;
  for (const li of $$('#boot-steps li')) {
    li.className = steps[li.dataset.k];
    $('small', li).textContent = detail[li.dataset.k];
  }
  $('#boot-progress').classList.toggle('hidden', !progress);
  $('#boot-tail').classList.toggle('hidden', !tail);
  $('#boot-tail').textContent = tail;
  $('#boot-log').textContent = progress ? (st.phase === 'updating' ? st.update.text : ui.lastBootLog) : '';
  setActions('#boot-actions', actions);
}

/**
 * 渲染安装屏。
 * @param {object} ins 安装状态
 * @param {boolean} failed 是否安装失败
 */
function renderInstall(ins, failed) {
  const icon = $('#install-icon');
  if (failed) {
    icon.className = 'boot-icon red';
    icon.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>';
    $('#install-title').textContent = ins.error === '安装已取消' ? '安装已取消' : '安装未完成';
    $('#install-sub').textContent = ins.error === '安装已取消' ? '你可以重新开始安装，或手动指定已安装的 dsh。' : `原因：${ins.error}`;
  } else {
    icon.className = 'boot-icon purple';
    if (!icon.querySelector('.spinner')) icon.innerHTML = '<span class="spinner"></span>';
    $('#install-title').textContent = '正在自动安装 DeepSeek Harness';
    $('#install-sub').textContent = '未在本机找到 dsh，将根据你的系统环境自动安装（关闭程序会同时终止安装）。';
  }
  $('#sys-grid').innerHTML = sysItems(ins.system).map(([k, v, c]) => `<div class="sys-item ${c}"><label>${k}</label><b>${esc(v)}</b></div>`).join('');
  $('#install-steps').innerHTML = ins.steps
    .map((s) => `<li class="${s.status}"><i></i><div><b>${s.title}</b><small>${esc(s.detail || '')}</small></div></li>`)
    .join('');
  $('#install-progress').classList.toggle('hidden', failed);
  renderInstallProgress(ins.progress);
  setActions('#install-actions', failed
    ? [['重新安装', 'btn-purple', 'install'], ['更改安装位置', 'btn-ghost', 'setup-again'], ['手动指定 dsh 路径', 'btn-ghost', 'pick-dsh'], ['查看控制台', 'btn-ghost', 'show-console']]
    : [['取消安装', 'btn-red', 'install-cancel'], ['查看控制台', 'btn-ghost', 'show-console']]);
}

// ───────────────────────────── 安装位置选择 ─────────────────────────────

/**
 * 拼接路径（按平台分隔符）。
 * @param {string} a 父目录
 * @param {string} b 子目录名
 * @returns {string} 完整路径
 */
function joinPath(a, b) {
  const sep = ui.platform === 'win32' ? '\\' : '/';
  return `${String(a).replace(/[\\/]+$/, '')}${sep}${b}`;
}

/**
 * 渲染安装位置选择屏。
 * @param {{installRoot: string, workDir: string, drives: object[]}} s 选择状态
 * @param {boolean} fresh 是否刚进入该步骤（仅此时用推荐值填充输入框，避免覆盖用户正在编辑的内容）
 */
function renderSetup(s, fresh) {
  if (fresh) {
    $('#setup-root').value = s.installRoot;
    $('#setup-work').value = s.workDir;
    ui.workTouched = false;
    $('#setup-error').classList.add('hidden');
  }
  ui.drives = s.drives || [];
  renderDrives();
  renderLayoutPreview();
}

/** 渲染磁盘卡片（剩余空间不足 5GB 标红），并高亮当前目录所在的磁盘。 */
function renderDrives() {
  const root = $('#setup-root').value.toLowerCase();
  const gb = (n) => (n / 1073741824).toFixed(1);
  $('#drive-grid').innerHTML = ui.drives.map((d, i) => {
    const active = root.startsWith(d.root.toLowerCase());
    const used = Math.round((1 - d.free / d.total) * 100);
    const low = d.free < 5 * 1073741824;
    return `<button type="button" class="drive${active ? ' active' : ''}" data-drive="${i}">
      <b>${esc(d.label)}</b>${d.system ? '<em>系统盘</em>' : ''}
      <div class="bar"><span class="${low ? 'low' : ''}" style="width:${used}%"></span></div>
      <small>可用 ${gb(d.free)} GB / 共 ${gb(d.total)} GB</small>
    </button>`;
  }).join('');
}

/** 预览安装目录下将生成的子目录。 */
function renderLayoutPreview() {
  const r = $('#setup-root').value.trim() || '…';
  const items = [['bin', '启动脚本'], ['node', 'Node.js（需要时）'], ['npm-global', 'dsh 与 pnpm'], ['home', 'DSH 数据'],
    ['npm-cache', 'npm 缓存'], ['pnpm-store', 'pnpm 缓存'], ['cache / config / data', '工具缓存与配置'], ['tmp', '临时文件']];
  $('#layout-preview').innerHTML = items.map(([n, d]) => `<div title="${esc(joinPath(r, n))}"><code>${esc(n)}</code> ${d}</div>`).join('');
}

$('#drive-grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-drive]');
  if (!b) return;
  const d = ui.drives[Number(b.dataset.drive)];
  const root = d.system && ui.platform !== 'win32' ? joinPath(d.root, '.deepseek-harness') : joinPath(d.root, 'DeepSeekHarness');
  $('#setup-root').value = root;
  if (!ui.workTouched) $('#setup-work').value = joinPath(root, 'workspace');
  renderDrives();
  renderLayoutPreview();
});
$('#setup-root').addEventListener('input', () => {
  if (!ui.workTouched) $('#setup-work').value = joinPath($('#setup-root').value.trim(), 'workspace');
  renderDrives();
  renderLayoutPreview();
});
$('#setup-work').addEventListener('input', () => {
  ui.workTouched = true;
});

/**
 * 更新安装进度条。
 * @param {{percent:number, text:string}} p 进度
 */
function renderInstallProgress(p) {
  if (!p) return;
  const bar = $('#install-progress');
  bar.classList.toggle('indeterminate', p.percent < 0);
  $('span', bar).style.width = p.percent >= 0 ? `${p.percent}%` : '';
  $('#install-log').textContent = p.text || ui.lastInstallLog;
}

/**
 * 生成系统检测卡片数据。
 * @param {object|null} s 系统信息
 * @returns {Array<[string, string, string]>} [标题, 值, 样式]
 */
function sysItems(s) {
  if (!s) return [['系统环境', '检测中…', 'info']];
  const gb = (n) => (n / 1073741824).toFixed(1);
  const lat = (v) => {
    if (v === undefined) return ['未使用', 'info'];
    return Number.isFinite(v) ? [`${v} ms`, v < 1500 ? 'ok' : 'warn'] : ['不可达', 'bad'];
  };
  const [nj, njc] = lat(s.latency?.npmjs);
  const [nm, nmc] = lat(s.latency?.npmmirror);
  return [
    ['操作系统', s.os, 'info'],
    ['CPU 架构', s.arch, 'info'],
    ['内存（可用 / 总计）', `${gb(s.memFree)} / ${gb(s.memTotal)} GB`, 'info'],
    ['磁盘剩余', s.diskFree >= 0 ? `${gb(s.diskFree)} GB` : '未知', s.diskFree < 0 || s.diskFree > 2147483648 ? 'ok' : 'warn'],
    ['Node.js', s.nodeOk ? `v${s.node}` : s.node ? `v${s.node}（过低，将安装便携版）` : '未安装（将安装便携版）', s.nodeOk ? 'ok' : s.node ? 'warn' : 'bad'],
    ['npm', s.npm ? `v${s.npm}` : s.nodeOk ? '未找到' : '随 Node.js 安装', s.npm ? 'ok' : 'warn'],
    ['pnpm（插件管理）', s.pnpm ? `v${s.pnpm}` : '未安装（将自动安装）', s.pnpm ? 'ok' : 'warn'],
    ['Git（GitHub 插件）', s.git ? `v${s.git}` : '未安装（建议安装）', s.git ? 'ok' : 'warn'],
    ['npm 官方源', nj, njc],
    ['国内镜像源', nm, nmc],
  ];
}

/**
 * 刷新控制台顶部信息卡片。
 * @param {object} st 状态
 */
function renderInfo(st) {
  const svc = st.service;
  $('#i-state').textContent = `${$('#status-text').textContent}${svc.pid ? `（PID ${svc.pid}）` : ''}`;
  $('#i-uptime').textContent = svc.state === 'running' ? `已运行 ${elapsedText(svc.startedAt)}` : svc.state === 'starting' ? `启动中 ${elapsedText(svc.startedAt)}` : '—';
  $('#i-url').textContent = svc.url ? svc.url.replace(/\?token=.*/, '') : '—';
  $('#i-path').textContent = st.dsh.path || '未找到';
  $('#i-path').title = st.dsh.path || '';
  $('#i-source').textContent = st.dsh.source || '—';
  $('#i-version').textContent = st.dsh.version ? `v${st.dsh.version}` : st.dsh.path ? '读取中…' : '—';
  $('#i-home').textContent = svc.dshHome || '—';
  $('#i-home').title = svc.dshHome || '';
}

/** 启动 / 运行阶段每秒刷新耗时显示（只在需要时开启定时器）。 */
function manageTicker(on) {
  if (on && !ui.tick) ui.tick = setInterval(() => ui.state && (renderInfo(ui.state), ui.state.service.state === 'starting' && renderBoot(ui.state)), 1000);
  if (!on && ui.tick) {
    clearInterval(ui.tick);
    ui.tick = null;
  }
}

/**
 * 把毫秒时间戳转换为“x 分 y 秒”形式的已用时长。
 * @param {number} since 起始时间戳
 * @returns {string} 时长文本
 */
function elapsedText(since) {
  if (!since) return '';
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

/**
 * 渲染一组操作按钮。
 * @param {string} sel 容器选择器
 * @param {Array<[string, string, string]>} list [文字, 样式, 动作]
 */
function setActions(sel, list) {
  const html = list.map(([t, c, a]) => `<button class="btn ${c}" data-act="${a}">${t}</button>`).join('');
  const el = $(sel);
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
}

// ───────────────────────────── webview ─────────────────────────────

/** 标记内嵌页面已可见（did-finish-load 或 dom-ready 兜底，二者先到者生效）。 */
function markWebReady() {
  if (!ui.webSrc || ui.webReady || !/^https?:/.test(webview.getURL())) return;
  ui.webReady = true;
  if (ui.state) render(ui.state);
}
webview.addEventListener('did-finish-load', markWebReady);
// 个别插件资源加载缓慢时 did-finish-load 会迟迟不来，DOM 就绪 3 秒后也视为可用，避免一直停在加载屏
webview.addEventListener('dom-ready', () => setTimeout(markWebReady, 3000));
webview.addEventListener('did-fail-load', (e) => {
  // -3 为主动中止（例如页面内跳转），不视为失败
  if (!e.isMainFrame || e.errorCode === -3 || !ui.webSrc) return;
  if (ui.webRetries++ < 8) setTimeout(() => webview.loadURL(ui.webSrc).catch(() => {}), 1200);
});

// ───────────────────────────── 控制台日志 ─────────────────────────────

/**
 * 接收一批日志，合并到下一帧统一写入 DOM。
 * @param {object[]} batch 日志条目
 */
function enqueueLogs(batch) {
  for (const e of batch) {
    ui.pending.push(e);
    if (e.src === 'install') {
      ui.lastInstallLog = e.text;
      if (ui.pluginBusy) {
        const log = $('#plugin-log');
        log.textContent = e.text;
        log.classList.remove('hidden');
      }
    } else if (e.src === 'dsh' || e.src === 'sys') ui.lastBootLog = e.text;
  }
  if (!ui.flushQueued) {
    ui.flushQueued = true;
    requestAnimationFrame(flushLogs);
  }
}

/** 把待写入的日志一次性追加到控制台（DocumentFragment + 批量裁剪）。 */
function flushLogs() {
  ui.flushQueued = false;
  const list = ui.pending;
  ui.pending = [];
  if (!list.length) return;
  const frag = document.createDocumentFragment();
  let bad = 0;
  for (const e of list.slice(-MAX_LINES)) {
    let lvl = e.level;
    if ((lvl === 'err' || lvl === 'out') && BAD_RE.test(e.text)) lvl = 'bad';
    if (lvl === 'bad') bad += 1;
    const div = document.createElement('div');
    div.className = `line s-${e.src} l-${lvl}`;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = e.t;
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = SRC_LABEL[e.src] || e.src;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = e.text;
    div.append(t, s, x);
    frag.appendChild(div);
  }
  output.appendChild(frag);
  const extra = output.childElementCount - MAX_LINES;
  if (extra > 300) {
    const range = document.createRange();
    range.setStartBefore(output.firstChild);
    range.setEndAfter(output.children[extra - 1]);
    range.deleteContents();
  }
  if (bad && ui.view !== 'console') {
    ui.errCount += bad;
    const b = $('#err-badge');
    b.textContent = ui.errCount > 99 ? '99+' : String(ui.errCount);
    b.classList.remove('hidden');
  }
  if ($('#autoscroll').checked && ui.atBottom) output.scrollTop = output.scrollHeight;
  if (ui.state && !$('#boot').classList.contains('hidden')) $('#boot-log').textContent = ui.lastBootLog;
  if (ui.state?.phase === 'installing' && ui.state.install.progress.percent < 0) $('#install-log').textContent = ui.lastInstallLog;
}

output.addEventListener('scroll', () => {
  ui.atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
  $('#to-bottom').classList.toggle('hidden', ui.atBottom);
}, { passive: true });
$('#to-bottom').addEventListener('click', () => {
  output.scrollTop = output.scrollHeight;
});

$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  $$('#filters .chip').forEach((c) => c.classList.toggle('active', c === b));
  output.className = `output f-${b.dataset.f}`;
  output.scrollTop = output.scrollHeight;
});

// ───────────────────────────── 命令 ─────────────────────────────

/** 根据当前 profile 渲染快捷命令。 */
function renderQuickCommands() {
  const p = ui.config.profile || 'web';
  const cmds = ['dsh --version', `dsh plugin --profile ${p} list`, `dsh plugin --profile ${p} add `, `dsh plugin --profile ${p} remove `, `dsh --profile ${p} --dump-config`, 'dsh --help'];
  $('#cmd-quick').innerHTML = cmds.map((c) => `<button type="button" data-cmd="${esc(c)}">${esc(c.trim())}${c.endsWith(' ') ? ' …' : ''}</button>`).join('');
}

$('#cmd-quick').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cmd]');
  if (!b) return;
  const cmd = b.dataset.cmd;
  const input = $('#cmd-input');
  // 以空格结尾的命令需要补充参数（例如插件名），只填入输入框
  if (cmd.endsWith(' ') || ui.cmdBusy) {
    input.value = cmd;
    input.focus();
  } else {
    runCommand(cmd);
  }
});

$('#cmd-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#cmd-input');
  const text = input.value;
  if (ui.cmdBusy) {
    window.hd.sendInput(text);
    input.value = '';
    return;
  }
  if (!text.trim()) return;
  runCommand(text);
  input.value = '';
});

/**
 * 执行一条命令并记录到历史。
 * @param {string} text 命令
 */
function runCommand(text) {
  ui.history = [text, ...ui.history.filter((h) => h !== text)].slice(0, 50);
  localStorage.setItem('cmdHistory', JSON.stringify(ui.history));
  ui.histIdx = -1;
  ui.atBottom = true;
  window.hd.runCommand(text);
}

$('#cmd-input').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (!ui.history.length) return;
  e.preventDefault();
  ui.histIdx = Math.max(-1, Math.min(ui.history.length - 1, ui.histIdx + (e.key === 'ArrowUp' ? 1 : -1)));
  e.target.value = ui.histIdx < 0 ? '' : ui.history[ui.histIdx];
});

$('#cmd-stop').addEventListener('click', () => window.hd.stopCommand());

/**
 * 切换命令运行中状态。
 * @param {boolean} busy 是否有命令在运行
 */
function setBusy(busy) {
  ui.cmdBusy = busy;
  $('#cmd-form').classList.toggle('busy', busy);
  $('#cmd-stop').classList.toggle('hidden', !busy);
  $('#cmd-run').textContent = busy ? '发送' : '运行';
  $('#cmd-input').placeholder = busy
    ? '命令运行中：输入内容后回车会发送给该命令（例如 y 确认），点击“停止”可强制结束'
    : '输入命令后回车执行，例如：dsh plugin --profile web add <插件名>（↑↓ 切换历史）';
}

// ───────────────────────────── 视图切换 ─────────────────────────────

/**
 * 切换“界面 / 控制台”视图。
 * @param {'ui'|'console'} v 视图
 */
function switchView(v) {
  ui.view = v;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('#view-ui').classList.toggle('active', v === 'ui');
  $('#view-console').classList.toggle('active', v === 'console');
  if (v === 'console') {
    ui.errCount = 0;
    $('#err-badge').classList.add('hidden');
    if ($('#autoscroll').checked) {
      output.scrollTop = output.scrollHeight;
      ui.atBottom = true;
    }
    $('#cmd-input').focus();
  }
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) switchView(b.dataset.view);
});

document.addEventListener('keydown', (e) => {
  const mod = ui.platform === 'darwin' ? e.metaKey : e.ctrlKey;
  if (mod && e.key === '`') {
    e.preventDefault();
    switchView(ui.view === 'ui' ? 'console' : 'ui');
  } else if (e.key === 'Escape') {
    $$('.modal:not(.hidden)').forEach((m) => {
      if (m.id === 'modal-plugin' && ui.pluginBusy) return;
      m.classList.add('hidden');
    });
  }
});

// ───────────────────────────── 通用动作 ─────────────────────────────

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.preventDefault();
  const act = el.dataset.act;
  switch (act) {
    case 'restart':
      window.hd.restart();
      break;
    case 'start':
      window.hd.start();
      break;
    case 'redetect':
      if (el.closest('#settings-form') && !(await saveSettings(false))) break;
      closeModal('#modal-settings');
      window.hd.redetect();
      break;
    case 'detect-tools':
      detectTools(el);
      break;
    case 'probe-registry':
      probeRegistry(el);
      break;
    case 'open-versions':
      closeModal('#modal-settings');
      openVersions();
      break;
    case 'versions-close':
      closeModal('#modal-versions');
      if (ui.state?.update?.status !== 'running') window.hd.dismissUpdate();
      break;
    case 'ver-refresh':
      loadVersions();
      break;
    case 'ver-install':
      installVersion();
      break;
    case 'show-console':
      switchView('console');
      break;
    case 'install':
      window.hd.installStart();
      break;
    case 'install-cancel':
      window.hd.installCancel();
      break;
    case 'setup-again':
      window.hd.installSetup();
      break;
    case 'setup-pick-root':
    case 'setup-pick-work': {
      const isRoot = act === 'setup-pick-root';
      const dir = await window.hd.pickDir(isRoot ? '选择安装与缓存目录' : '选择工作空间目录');
      if (!dir) break;
      if (isRoot) {
        $('#setup-root').value = dir;
        if (!ui.workTouched) $('#setup-work').value = joinPath(dir, 'workspace');
        renderDrives();
        renderLayoutPreview();
      } else {
        $('#setup-work').value = dir;
        ui.workTouched = true;
      }
      break;
    }
    case 'setup-begin': {
      const err = $('#setup-error');
      el.disabled = true;
      const r = await window.hd.installBegin({ installRoot: $('#setup-root').value, workDir: $('#setup-work').value });
      el.disabled = false;
      err.textContent = r?.error || '';
      err.classList.toggle('hidden', !r?.error);
      if (r?.ok) ui.config = { ...ui.config, installRoot: $('#setup-root').value, workDir: $('#setup-work').value };
      break;
    }
    case 'pick-dsh': {
      const f = await window.hd.pickFile('dsh');
      if (f) {
        const r = await window.hd.saveConfig({ dshPath: f });
        if (r.error) {
          toast(r.error, 'err');
          break;
        }
        ui.config = r.config;
        window.hd.redetect();
      }
      break;
    }
    case 'dismiss-plugins':
      window.hd.dismissPlugins();
      break;
    case 'open-plugin':
      openPluginModal();
      break;
    case 'plugin-pick-dir': {
      const dir = await window.hd.pickDir('选择插件目录');
      if (dir) $('#plugin-link').value = dir;
      break;
    }
    case 'plugin-cancel':
      if (ui.pluginBusy) window.hd.cancelPluginInstall();
      else closeModal('#modal-plugin');
      break;
    case 'open-browser':
      if (ui.state?.service.url) window.hd.openExternal(ui.state.service.url);
      break;
    case 'open-dsh-dir':
      window.hd.openPath('dsh');
      break;
    case 'open-home':
      window.hd.openPath('home');
      break;
    case 'open-logs':
      window.hd.openPath('logs');
      break;
    case 'clear-logs':
      output.textContent = '';
      window.hd.clearLogs();
      break;
    case 'copy-logs': {
      const text = $$('.line', output).filter((l) => l.offsetParent !== null).map((l) => l.textContent).join('\n');
      await navigator.clipboard.writeText(text);
      toast('已复制当前筛选的日志', 'ok');
      break;
    }
    case 'close-cancel':
      closeModal('#modal-close');
      break;
    case 'settings-cancel':
      closeModal('#modal-settings');
      break;
    default:
      break;
  }
});

$('#btn-restart').addEventListener('click', () => {
  window.hd.restart();
  toast('正在重新启动 DSH…');
});
$('#btn-browser').addEventListener('click', () => ui.state?.service.url && window.hd.openExternal(ui.state.service.url));
$('#btn-settings').addEventListener('click', openSettings);

// ───────────────────────────── 手动安装插件 ─────────────────────────────

$('#plugin-kinds').addEventListener('change', (e) => {
  if (e.target.name !== 'pluginKind') return;
  showPluginKind(e.target.value);
});

const pluginUpload = $('#plugin-upload');
pluginUpload.addEventListener('click', (e) => {
  // 程序化打开文件框时，点击事件会冒泡回来，避免再次触发
  if (e.target === $('#plugin-tarball-file') || ui.pluginBusy) return;
  $('#plugin-tarball-file').click();
});
pluginUpload.addEventListener('dragover', (e) => {
  e.preventDefault();
  pluginUpload.classList.add('drag');
});
pluginUpload.addEventListener('dragleave', () => pluginUpload.classList.remove('drag'));
pluginUpload.addEventListener('drop', (e) => {
  e.preventDefault();
  pluginUpload.classList.remove('drag');
  if (!ui.pluginBusy) setPluginTarball(e.dataTransfer?.files?.[0]);
});
$('#plugin-tarball-file').addEventListener('change', (e) => {
  setPluginTarball(e.target.files?.[0]);
  e.target.value = '';
});

/**
 * 记录待上传的压缩包，并在区域内显示文件名。
 * @param {File|null|undefined} file 选择或拖入的文件
 */
function setPluginTarball(file) {
  const err = $('#plugin-error');
  if (!file) {
    ui.pluginTarball = null;
    $('#plugin-upload-text').textContent = '点击或拖入压缩包';
    pluginUpload.classList.remove('has-file');
    return;
  }
  if (!/\.(tgz|tar\.gz)$/i.test(file.name || '')) {
    err.textContent = '请上传 .tgz 或 .tar.gz 文件';
    err.classList.remove('hidden');
    return;
  }
  err.classList.add('hidden');
  ui.pluginTarball = file;
  const size = file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  $('#plugin-upload-text').textContent = `${file.name}（${size}）`;
  pluginUpload.classList.add('has-file');
}

$('#plugin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (ui.pluginBusy) return;
  const kind = $('#plugin-form').querySelector('input[name="pluginKind"]:checked')?.value || 'npm';
  const err = $('#plugin-error');
  err.classList.add('hidden');
  let payload = { kind, value: $(`#plugin-${kind}`)?.value || '' };
  if (kind === 'tarball') {
    if (!ui.pluginTarball) {
      err.textContent = '请上传插件压缩包';
      err.classList.remove('hidden');
      return;
    }
    payload = { kind, fileName: ui.pluginTarball.name, data: new Uint8Array(await ui.pluginTarball.arrayBuffer()) };
  }
  $('#plugin-log').textContent = '';
  setPluginBusy(true);
  const r = await window.hd.installPlugin(payload);
  setPluginBusy(false);
  if (r?.cancelled) {
    closeModal('#modal-plugin');
    return;
  }
  if (r?.ok) {
    if (kind === 'tarball') setPluginTarball(null);
    closeModal('#modal-plugin');
    toast('插件已安装，重启 DSH 后生效', 'ok', { label: '立即重启', fn: () => window.hd.restart() }, 8000);
    return;
  }
  err.textContent = r?.error || '安装失败';
  err.classList.remove('hidden');
  if ($('#modal-plugin').classList.contains('hidden')) toast(err.textContent, 'err', null, 5000);
});

/** 打开手动安装插件弹窗。 */
function openPluginModal() {
  $('#plugin-profile').textContent = ui.config.profile || 'web';
  $('#plugin-error').classList.add('hidden');
  if (!ui.pluginBusy) {
    $('#plugin-log').classList.add('hidden');
    $('#plugin-progress').classList.add('hidden');
  }
  const kind = $('#plugin-form').querySelector('input[name="pluginKind"]:checked')?.value || 'npm';
  showPluginKind(kind);
  openModal('#modal-plugin');
}

/**
 * 切换插件来源对应的输入区。
 * @param {string} kind npm / link / tarball / git
 */
function showPluginKind(kind) {
  $$('[data-kind-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.kindPanel !== kind));
}

/**
 * 切换安装进行中的界面状态。
 * @param {boolean} busy 是否正在安装
 */
function setPluginBusy(busy) {
  ui.pluginBusy = busy;
  $('#plugin-fields').disabled = busy;
  $('#plugin-submit').disabled = busy;
  $('#plugin-submit').textContent = busy ? '安装中…' : '安装';
  $('#plugin-progress').classList.toggle('hidden', !busy);
}

$$('#modal-close [data-close]').forEach((b) => b.addEventListener('click', () => {
  closeModal('#modal-close');
  window.hd.closeChoice(b.dataset.close, $('#close-remember').checked);
}));

// ───────────────────────────── 设置 ─────────────────────────────

/** 打开设置弹窗并填充当前值。 */
function openSettings() {
  const f = $('#settings-form');
  const c = ui.config;
  for (const k of ['dshPath', 'nodePath', 'pnpmPath', 'workDir', 'profile', 'port', 'extraArgs', 'installRoot', 'registryCustom']) f.elements[k].value = c[k] ?? '';
  for (const k of ['closeAction', 'pluginChange']) {
    const r = f.querySelector(`input[name="${k}"][value="${c[k]}"]`);
    if (r) r.checked = true;
  }
  f.elements.registry.value = c.registry || 'npmmirror';
  syncRegistryRow();
  $('#registry-speed').classList.add('hidden');
  $('#settings-error').classList.add('hidden');
  $('#set-version').textContent = ui.state?.dsh.version ? `v${ui.state.dsh.version}` : '未知';
  f.elements.launchAtLogin.checked = !!c.launchAtLogin;
  f.elements.checkPluginHub.checked = c.checkPluginHub !== false;
  openModal('#modal-settings');
}

/** 选择“自定义”镜像源时才显示地址输入框。 */
function syncRegistryRow() {
  const f = $('#settings-form');
  $('#registry-custom-row').classList.toggle('hidden', f.elements.registry.value !== 'custom');
}
$('#settings-form').elements.registry.addEventListener('change', syncRegistryRow);

$('#settings-form').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pick]');
  if (!b) return;
  const input = b.parentElement.querySelector('input');
  const v = b.dataset.pick === 'file' ? await window.hd.pickFile(b.dataset.kind) : await window.hd.pickDir('选择目录');
  if (v) input.value = v;
});

/**
 * 用检测结果填充某个输入框的自动补全候选项（datalist）。
 * @param {string} id datalist 的 ID
 * @param {Array<{path: string, label: string}>} items 候选项
 */
function fillDatalist(id, items) {
  $(`#${id}`).innerHTML = items.map((it) => `<option value="${esc(it.path)}" label="${esc(it.label)}"></option>`).join('');
}

/**
 * “获取路径”：扫描本机的 node / pnpm / dsh，填充三个输入框的自动补全候选项，并展开当前输入框的候选列表。
 * @param {HTMLElement} btn 被点击的按钮
 */
async function detectTools(btn) {
  const field = $('#settings-form').elements[btn.dataset.field];
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '扫描中…';
  try {
    const r = await window.hd.detectTools();
    fillDatalist('dl-node', r.node);
    fillDatalist('dl-pnpm', r.pnpm);
    fillDatalist('dl-dsh', r.dsh);
    const list = { nodePath: r.node, pnpmPath: r.pnpm, dshPath: r.dsh }[btn.dataset.field] || [];
    if (list.length) {
      toast(`找到 ${list.length} 个候选项，点击输入框即可选择`, 'ok');
      // 清空后展开列表：datalist 只会展示与当前输入匹配的项，输入框里已有内容时先临时清空
      const keep = field.value;
      field.value = '';
      field.focus();
      try {
        field.showPicker();
      } catch {
        /* 旧内核不支持 showPicker，用户点击输入框即可 */
      }
      field.addEventListener('blur', () => { if (!field.value) field.value = keep; }, { once: true });
    } else {
      toast('本机没有找到可用的候选项，可以点击“浏览”手动选择', 'warn');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** 镜像源测速：并发测试所有预设源与自定义源，展示各自延迟并标出最快的。 */
async function probeRegistry(btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '测速中…';
  const line = $('#registry-speed');
  try {
    const r = await window.hd.probeRegistries($('#settings-form').elements.registryCustom.value);
    const names = { npmmirror: '淘宝', tencent: '腾讯云', huawei: '华为云', npmjs: '官方', custom: '自定义' };
    const ok = Object.entries(r).filter(([, ms]) => ms !== null).sort((a, b) => a[1] - b[1]);
    const best = ok[0]?.[0];
    line.innerHTML = Object.keys(r).map((k) => {
      if (r[k] === null) return `<s>${names[k]} 不可达</s>`;
      return k === best ? `<b>${names[k]} ${r[k]}ms（最快）</b>` : `${names[k]} ${r[k]}ms`;
    }).join(' · ');
    line.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveSettings(true);
});

/**
 * 保存设置。
 * @param {boolean} notify 是否提示（以及在需要时提供“立即重启”）
 */
async function saveSettings(notify) {
  const f = $('#settings-form');
  const patch = {
    dshPath: f.elements.dshPath.value.trim(),
    nodePath: f.elements.nodePath.value.trim(),
    pnpmPath: f.elements.pnpmPath.value.trim(),
    workDir: f.elements.workDir.value.trim(),
    profile: f.elements.profile.value.trim(),
    port: f.elements.port.value.trim(),
    extraArgs: f.elements.extraArgs.value.trim(),
    installRoot: f.elements.installRoot.value.trim(),
    closeAction: f.querySelector('input[name="closeAction"]:checked')?.value || 'ask',
    pluginChange: f.querySelector('input[name="pluginChange"]:checked')?.value || 'prompt',
    registry: f.elements.registry.value,
    registryCustom: f.elements.registryCustom.value.trim(),
    launchAtLogin: f.elements.launchAtLogin.checked,
    checkPluginHub: f.elements.checkPluginHub.checked,
  };
  const r = await window.hd.saveConfig(patch);
  const err = $('#settings-error');
  err.textContent = r.error || '';
  err.classList.toggle('hidden', !r.error);
  if (r.error) return false;
  ui.config = r.config;
  renderQuickCommands();
  if (!notify) return true;
  closeModal('#modal-settings');
  if (r.needRestart && ui.state?.phase === 'service') {
    const names = {
      port: '监听端口', nodePath: 'Node.js 路径', pnpmPath: 'pnpm 路径', dshPath: 'dsh 路径', registry: '镜像源', registryCustom: '镜像源',
      workDir: '工作目录', profile: 'Profile', extraArgs: '启动参数',
    };
    const what = [...new Set(r.changed.map((k) => names[k]))].join('、');
    toast(`${what}已修改，需要重启 DSH 才能生效`, 'warn', { label: '立即重启', fn: () => window.hd.applyRestart() }, 10000);
  } else {
    toast('设置已保存', 'ok');
  }
  return true;
}

// ───────────────────────────── DSH 版本管理 ─────────────────────────────

/** 版本管理弹窗的数据：远程版本列表、当前选中的版本。 */
ui.ver = { data: null, selected: '', loading: false };

/** 打开版本管理弹窗并拉取远程版本列表。 */
function openVersions() {
  $('#ver-ok').classList.add('hidden');
  $('#ver-error').classList.add('hidden');
  openModal('#modal-versions');
  renderUpdate(ui.state);
  loadVersions();
}

/** 从所选镜像源远程拉取版本列表。 */
async function loadVersions() {
  if (ui.ver.loading) return;
  ui.ver.loading = true;
  $('#ver-list').innerHTML = '<p class="ver-empty">正在获取版本列表…</p>';
  $('#ver-error').classList.add('hidden');
  const r = await window.hd.getVersions();
  ui.ver.loading = false;
  if (r.error) {
    ui.ver.data = null;
    $('#ver-list').innerHTML = '<p class="ver-empty">未能获取版本列表</p>';
    $('#ver-error').textContent = `${r.error}（可在设置中更换镜像源后重试）`;
    $('#ver-error').classList.remove('hidden');
    renderVersionsMeta();
    return;
  }
  ui.ver.data = r;
  // 默认选中比当前更新的最新版本
  ui.ver.selected = r.hasUpdate ? r.latest : '';
  renderVersions();
}

/** 渲染版本列表（alpha 版本默认隐藏，当前版本与带标签的版本始终显示）。 */
function renderVersions() {
  const d = ui.ver.data;
  if (!d) return;
  const showAlpha = $('#ver-alpha').checked;
  const rows = d.versions.filter((v) => showAlpha || !/-alpha/.test(v.version) || v.rel === 0 || v.tags.some((t) => t !== 'alpha'));
  $('#ver-list').innerHTML = rows.map((v) => {
    const tags = [
      v.rel === 0 ? '<span class="tag current">当前</span>' : '',
      ...v.tags.map((t) => `<span class="tag ${['latest', 'next', 'alpha'].includes(t) ? t : 'next'}">${esc(t)}</span>`),
      v.rel === 1 ? '<span class="tag up">较新</span>' : '',
    ].join(' ');
    const hint = v.rel === -1 ? '回退' : v.rel === 1 ? '升级' : '';
    return `<button type="button" class="ver-row${v.version === ui.ver.selected ? ' selected' : ''}" data-ver="${esc(v.version)}">
      <b>v${esc(v.version)}</b>${tags}<span class="sp"></span><small>${hint}</small></button>`;
  }).join('') || '<p class="ver-empty">没有可显示的版本</p>';
  renderVersionsMeta();
}

/** 刷新版本弹窗顶部的摘要与“安装”按钮状态。 */
function renderVersionsMeta() {
  const d = ui.ver.data;
  const cur = ui.state?.dsh.version;
  $('#ver-current').textContent = cur ? `v${cur}` : '读取中…';
  $('#ver-latest').textContent = d ? `v${d.latest}` : '—';
  $('#ver-hint').textContent = !d ? '' : d.hasUpdate ? '有新版本可用' : cur ? '已是最新' : '';
  $('#ver-registry').textContent = d?.registry || '—';
  const running = ui.state?.update?.status === 'running';
  const btn = $('#ver-install');
  const sel = ui.ver.selected;
  const row = d?.versions.find((v) => v.version === sel);
  btn.disabled = !sel || running || row?.rel === 0;
  btn.textContent = running ? '更新中…' : !sel ? '安装选中版本' : row?.rel === -1 ? `回退到 v${sel}` : `更新到 v${sel}`;
}

$('#ver-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ver]');
  if (!b || ui.state?.update?.status === 'running') return;
  ui.ver.selected = b.dataset.ver;
  renderVersions();
});
$('#ver-alpha').addEventListener('change', renderVersions);

/** 安装选中的版本（回退到较旧版本前需要二次确认）。 */
async function installVersion() {
  const sel = ui.ver.selected;
  const row = ui.ver.data?.versions.find((v) => v.version === sel);
  if (!sel) return;
  if (row?.rel === -1 && !confirm(`将回退到较旧的 v${sel}，可能与已安装的插件不兼容。确定继续吗？`)) return;
  $('#ver-error').classList.add('hidden');
  $('#ver-ok').classList.add('hidden');
  const r = await window.hd.updateDsh(sel);
  if (r.error) {
    $('#ver-error').textContent = r.error;
    $('#ver-error').classList.remove('hidden');
  }
}

/**
 * 根据主进程推送的更新状态刷新版本弹窗中的进度 / 结果。
 * @param {object} st 整体状态
 */
function renderUpdate(st) {
  const u = st?.update;
  if (!u) return;
  const running = u.status === 'running';
  if (running) ui.ver.doneHandled = false;
  $('#ver-progress').classList.toggle('hidden', !running);
  if (running) $('#ver-progress-text').textContent = u.text || '';
  const ok = $('#ver-ok');
  const er = $('#ver-error');
  if (u.status === 'done') {
    ok.textContent = `${u.message}，DSH 正在重新启动`;
    ok.classList.remove('hidden');
    er.classList.add('hidden');
    if (!ui.ver.doneHandled) {
      // 更新成功后当前版本已变化，只重新拉取一次以刷新“当前 / 较新”标记
      ui.ver.doneHandled = true;
      ui.ver.data = null;
      loadVersions();
    }
  } else if (u.status === 'error') {
    er.textContent = `更新失败：${u.message}。DSH 已尝试用原版本重新启动。`;
    er.classList.remove('hidden');
    ok.classList.add('hidden');
  }
  renderVersionsMeta();
}

// ───────────────────────────── 工具 ─────────────────────────────

/** @param {string} sel 弹窗选择器 */
function openModal(sel) {
  $(sel).classList.remove('hidden');
}

/** @param {string} sel 弹窗选择器 */
function closeModal(sel) {
  $(sel).classList.add('hidden');
}

/**
 * 显示一条提示。
 * @param {string} text 文本
 * @param {'info'|'ok'|'warn'|'err'} [type] 类型
 * @param {{label: string, fn: () => void}} [action] 可选操作按钮
 * @param {number} [ms] 显示时长
 */
function toast(text, type = 'info', action = null, ms = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${esc(text)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn btn-orange btn-sm';
    b.textContent = action.label;
    b.onclick = () => {
      action.fn();
      el.remove();
    };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/**
 * HTML 转义。
 * @param {string} s 文本
 * @returns {string} 转义后的文本
 */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
