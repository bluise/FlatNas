'use strict';

/* FlatNas 待办 · 小插件渲染逻辑
   网络与 token 都在主进程，这里只通过 window.flatnas 这组 IPC 操作。 */

const api = window.flatnas;

const el = {
  card: document.getElementById('card'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  emptyHint: document.getElementById('empty-hint'),
  counter: document.getElementById('counter'),
  statusDot: document.getElementById('status-dot'),
  input: document.getElementById('new-todo'),
  add: document.getElementById('btn-add'),
  pin: document.getElementById('btn-pin'),
  settings: document.getElementById('btn-settings'),
  hide: document.getElementById('btn-hide'),
  notify: document.getElementById('notify'),
};

let state = { items: [], meta: {}, config: {}, connection: {} };
let editingId = null;
const STATUS_TEXT = {
  idle: '已同步',
  syncing: '同步中…',
  offline: '离线：改动已保存在本地，恢复后自动同步',
  error: '同步出错',
  unconfigured: '未配置：点 ⚙ 填写服务器地址并选择待办组件',
};

/** #rrggbb -> rgba(r,g,b,a) */
function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return `rgba(17, 24, 39, ${alpha})`;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const num = parseInt(h, 16);
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

function applyTheme() {
  const cfg = state.config || {};
  const alpha = Number.isFinite(cfg.opacity) ? cfg.opacity : 0.85;
  const style = document.documentElement.style;
  style.setProperty('--card-bg', hexToRgba(cfg.cardColor, alpha));
  style.setProperty('--text-color', cfg.textColor || '#f9fafb');
  style.setProperty('--accent', cfg.accentColor || '#3b82f6');
  style.setProperty('--font-size', `${cfg.fontSize || 14}px`);
  el.pin.classList.toggle('active', Boolean(cfg.alwaysOnTop));
}

function applyStatus() {
  const status = (state.meta && state.meta.status) || 'unconfigured';
  const configured = state.connection && state.connection.configured;
  const dotClass =
    !configured || status === 'unconfigured'
      ? ''
      : status === 'idle'
        ? 'ok'
        : status === 'syncing'
          ? 'syncing'
          : status === 'offline'
            ? 'offline'
            : 'error';
  el.statusDot.className = `dot ${dotClass}`;
  el.statusDot.title = STATUS_TEXT[status] || status;

  const dirty = state.meta && state.meta.dirty;
  const showNotify = !configured || status === 'offline' || status === 'error' || dirty;
  el.notify.hidden = !showNotify;
  if (showNotify) {
    let text = STATUS_TEXT[status] || '';
    if (dirty && (status === 'offline' || status === 'error')) {
      text = `${text}（${state.items.length} 条未被覆盖）`;
    }
    el.notify.textContent = text;
    el.notify.classList.toggle('error', status === 'error');
  }
}

function renderList() {
  const cfg = state.config || {};
  const showDone = cfg.showDone !== false;
  const items = (state.items || []).filter((i) => showDone || !i.done);

  el.list.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `item${item.done ? ' done' : ''}`;
    row.dataset.id = item.id;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.done;
    cb.addEventListener('change', () => api.toggle(item.id, cb.checked));

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
      if (cfg.confirmDelete && !window.confirm(`删除「${item.text}」？`)) return;
      api.remove(item.id);
    });

    row.append(cb, text, del);
    el.list.appendChild(row);
  }

  const all = state.items || [];
  const done = all.filter((i) => i.done).length;
  el.counter.textContent = `${all.length - done} / ${all.length}`;

  const nothingToShow = items.length === 0;
  el.empty.hidden = !nothingToShow;
  el.list.hidden = nothingToShow;
  if (nothingToShow) {
    el.emptyHint.textContent =
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
    if (save && value && value !== item.text) api.updateText(item.id, value);
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
  applyStatus();
}

function addCurrent() {
  const value = el.input.value.trim();
  if (!value) return;
  api.add(value);
  el.input.value = '';
}

el.add.addEventListener('click', addCurrent);
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addCurrent();
});

el.settings.addEventListener('click', () => api.openSettings());
el.hide.addEventListener('click', () => api.hideWindow());
el.pin.addEventListener('click', () => {
  api.setConfig({ alwaysOnTop: !(state.config && state.config.alwaysOnTop) });
});

// 阻止透明区域拖拽时的默认行为（保留 header 的拖动）
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

api.onState((payload) => {
  state = payload;
  render();
});

void api.getState().then((payload) => {
  state = payload;
  render();
});
