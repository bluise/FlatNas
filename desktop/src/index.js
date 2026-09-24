/**
 * 小插件主界面逻辑。
 *
 * 与 Electron 版的区别：同步引擎直接跑在这个页面里（不再经由主进程转发命令），
 * 所以勾选/删除是本地即时生效 + 后台同步，操作更跟手。
 */

import { FlatNasClient } from './lib/flatnas-client.js';
import { TodoSync } from './lib/todo-sync.js';
import { bridge, bridgeFetch } from './bridge.js';

const el = (id) => document.getElementById(id);

const ui = {
  list: el('list'),
  empty: el('empty'),
  emptyHint: el('empty-hint'),
  counter: el('counter'),
  statusDot: el('status-dot'),
  input: el('new-todo'),
  add: el('btn-add'),
  pin: el('btn-pin'),
  settings: el('btn-settings'),
  hide: el('btn-hide'),
  notify: el('notify'),
};

const STATUS_TEXT = {
  idle: '已同步',
  syncing: '同步中…',
  offline: '离线：改动已保存在本地，恢复后自动同步',
  error: '同步出错',
  unconfigured: '未配置：点 ⚙ 填写服务器地址并选择待办组件',
};

let config = {};
let lastStatus = 'unconfigured';
let editingId = null;

const client = new FlatNasClient({ fetchImpl: bridgeFetch });
const sync = new TodoSync({
  client,
  getWidgetId: () => config.widget_id || '',
  intervalMs: config.interval_ms || 10000,
  onUpdate: () => render(),
  onStatus: ({ status }) => {
    lastStatus = status;
    renderStatus();
  },
});

sync.onAuthError = async () => {
  // token 过期（30 天）：有保存密码就自动重登，否则提示用户
  if (config.remember_password && config.password) {
    try {
      const res = await client.login(config.username, config.password);
      await bridge.saveConfig({ token: res.token });
      config = await bridge.loadConfig();
    } catch {
      /* 留给下次同步重试 */
    }
  }
};

// ---------------------------------------------------------------- 样式

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return `rgba(17, 24, 39, ${alpha})`;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const num = parseInt(h, 16);
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

function applyTheme() {
  const alpha = Number.isFinite(config.opacity) ? config.opacity : 0.85;
  const style = document.documentElement.style;
  style.setProperty('--card-bg', hexToRgba(config.card_color, alpha));
  style.setProperty('--text-color', config.text_color || '#f9fafb');
  style.setProperty('--accent', config.accent_color || '#3b82f6');
  style.setProperty('--font-size', `${config.font_size || 14}px`);
  ui.pin.classList.toggle('active', Boolean(config.always_on_top));
}

function renderStatus() {
  const configured = Boolean(config.base_url && config.widget_id);
  const dot = !configured
    ? ''
    : lastStatus === 'idle'
      ? 'ok'
      : lastStatus === 'syncing'
        ? 'syncing'
        : lastStatus === 'offline'
          ? 'offline'
          : 'error';
  ui.statusDot.className = `dot ${dot}`;
  ui.statusDot.title = STATUS_TEXT[lastStatus] || lastStatus;

  const dirty = sync.dirty;
  const show = !configured || lastStatus === 'offline' || lastStatus === 'error' || dirty;
  ui.notify.hidden = !show;
  if (show) {
    let text = STATUS_TEXT[lastStatus] || '';
    if (dirty && (lastStatus === 'offline' || lastStatus === 'error')) {
      text = `${text}（${sync.items.length} 条未被覆盖）`;
    }
    ui.notify.textContent = text;
    ui.notify.classList.toggle('error', lastStatus === 'error');
  }
}

// ---------------------------------------------------------------- 列表

function renderList() {
  const showDone = config.show_done !== false;
  const items = sync.items.filter((i) => showDone || !i.done);

  ui.list.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `item${item.done ? ' done' : ''}`;
    row.dataset.id = item.id;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.done;
    cb.addEventListener('change', () => sync.toggle(item.id, cb.checked));

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = item.text;
    text.title = '双击可编辑';
    text.addEventListener('dblclick', () => startEdit(row, item));

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = '删除';
    del.addEventListener('click', () => {
      if (config.confirm_delete && !window.confirm(`删除「${item.text}」？`)) return;
      sync.remove(item.id);
    });

    row.append(cb, text, del);
    ui.list.appendChild(row);
  }

  const all = sync.items;
  const done = all.filter((i) => i.done).length;
  ui.counter.textContent = `${all.length - done} / ${all.length}`;

  const nothing = items.length === 0;
  ui.empty.hidden = !nothing;
  ui.list.hidden = nothing;
  if (nothing) {
    ui.emptyHint.textContent =
      all.length > 0 ? '已完成项已隐藏（可在设置里打开）' : '在下面输入框添加，回车即可';
  }
}

function startEdit(row, item) {
  if (editingId) return;
  editingId = item.id;
  const textEl = row.querySelector('.text');
  const input = document.createElement('input');
  input.className = 'edit-input';
  input.value = item.text;

  const commit = (save) => {
    editingId = null;
    const value = input.value.trim();
    if (save && value && value !== item.text) sync.updateText(item.id, value);
    else render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));

  textEl.replaceWith(input);
  input.focus();
  input.select();
}

function render() {
  applyTheme();
  renderList();
  renderStatus();
}

// ---------------------------------------------------------------- 交互

function addCurrent() {
  const value = ui.input.value.trim();
  if (!value) return;
  sync.add(value);
  ui.input.value = '';
}

ui.add.addEventListener('click', addCurrent);
ui.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addCurrent();
});
ui.settings.addEventListener('click', () => bridge.openSettings());
ui.hide.addEventListener('click', () => bridge.hideWindow());
ui.pin.addEventListener('click', () => bridge.saveConfig({ always_on_top: !config.always_on_top }));

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// 托盘 / 全局快捷键
void bridge.onSyncNow(() => void sync.syncOnce(true));
void bridge.onToggleClickThrough(async () => {
  const next = await bridge.saveConfig({ click_through: !config.click_through });
  config = next;
});
void bridge.onConfigChanged((next) => {
  const wasReady = Boolean(config.base_url && config.widget_id && config.token);
  const widgetChanged = next.widget_id !== config.widget_id;
  const intervalChanged = next.interval_ms !== config.interval_ms;
  config = next;
  if (intervalChanged) sync.setIntervalMs(config.interval_ms);
  render();

  const isReady = Boolean(config.base_url && config.widget_id && config.token);
  if (isReady && (!wasReady || widgetChanged)) {
    // 设置窗口刚把地址/组件/token 配好：立刻接上并同步一次
    client.setBaseUrl(config.base_url);
    client.setToken(config.token, config.username);
    sync.start();
    void sync.syncOnce(true);
  }
});

// ---------------------------------------------------------------- 启动

async function start() {
  config = await bridge.loadConfig();
  applyTheme();
  renderList();
  renderStatus();

  if (!config.base_url || !config.widget_id) {
    lastStatus = 'unconfigured';
    renderStatus();
    return;
  }

  client.setBaseUrl(config.base_url);
  if (config.token) {
    client.setToken(config.token, config.username);
    sync.start();
    return;
  }
  if (config.remember_password && config.password) {
    try {
      const res = await client.login(config.username, config.password);
      await bridge.saveConfig({ token: res.token });
      config = await bridge.loadConfig();
      client.setBaseUrl(config.base_url);
      client.setToken(config.token, config.username);
      sync.start();
    } catch (e) {
      lastStatus = 'error';
      ui.notify.hidden = false;
      ui.notify.textContent = `登录失败：${e.message}`;
      ui.notify.classList.add('error');
    }
    return;
  }
  lastStatus = 'unconfigured';
  ui.notify.hidden = false;
  ui.notify.textContent = '未登录：点 ⚙ 填写密码并保存';
}

void start();
