'use strict';

/* FlatNas 待办 · 设置窗口 */

const api = window.flatnas;
const $ = (id) => document.getElementById(id);

const fields = {
  baseUrl: $('baseUrl'),
  username: $('username'),
  password: $('password'),
  widgetId: $('widgetId'),
  intervalSec: $('intervalSec'),
  opacity: $('opacity'),
  cardColor: $('cardColor'),
  textColor: $('textColor'),
  accentColor: $('accentColor'),
  fontSize: $('fontSize'),
  width: $('width'),
  height: $('height'),
  alwaysOnTop: $('alwaysOnTop'),
  skipTaskbar: $('skipTaskbar'),
  showDone: $('showDone'),
  confirmDelete: $('confirmDelete'),
  launchAtLogin: $('launchAtLogin'),
  clickThrough: $('clickThrough'),
};

let current = {};
let widgetOptions = [];

function fillForm(cfg, appVersion) {
  current = cfg;
  fields.baseUrl.value = cfg.baseUrl || '';
  fields.username.value = cfg.username || '';
  fields.password.value = '';
  fields.password.placeholder = cfg.hasPassword ? '已保存（留空表示不修改）' : '请输入密码';
  fields.intervalSec.value = Math.round((cfg.intervalMs || 10000) / 1000);
  fields.opacity.value = cfg.opacity ?? 0.85;
  fields.cardColor.value = cfg.cardColor || '#111827';
  fields.textColor.value = cfg.textColor || '#f9fafb';
  fields.accentColor.value = cfg.accentColor || '#3b82f6';
  fields.fontSize.value = cfg.fontSize || 14;
  fields.width.value = cfg.width || 320;
  fields.height.value = cfg.height || 440;
  fields.alwaysOnTop.checked = Boolean(cfg.alwaysOnTop);
  fields.skipTaskbar.checked = Boolean(cfg.skipTaskbar);
  fields.showDone.checked = cfg.showDone !== false;
  fields.confirmDelete.checked = Boolean(cfg.confirmDelete);
  fields.launchAtLogin.checked = Boolean(cfg.launchAtLogin);
  fields.clickThrough.checked = Boolean(cfg.clickThrough);
  $('opacity-val').textContent = `${Math.round((cfg.opacity ?? 0.85) * 100)}%`;
  $('fontsize-val').textContent = `${cfg.fontSize || 14}px`;
  if (appVersion) $('app-version').textContent = appVersion;
  renderWidgetOptions(cfg.widgetId || '');
}

function renderWidgetOptions(selected) {
  const select = fields.widgetId;
  select.innerHTML = '';
  const seen = new Set();

  if (!widgetOptions.length) {
    const opt = document.createElement('option');
    opt.value = selected || '';
    opt.textContent = selected ? `${selected}（点「测试连接」刷新列表）` : '（先测试连接以加载列表）';
    select.appendChild(opt);
    if (selected) seen.add(selected);
  } else {
    for (const w of widgetOptions) {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = `${w.id}${w.title ? ` · ${w.title}` : ''}${w.enable ? '' : '（已禁用）'}`;
      select.appendChild(opt);
      seen.add(w.id);
    }
    if (selected && !seen.has(selected)) {
      const opt = document.createElement('option');
      opt.value = selected;
      opt.textContent = `${selected}（当前，可能已不存在）`;
      select.appendChild(opt);
    }
    if (!selected && widgetOptions.length === 1) select.value = widgetOptions[0].id;
  }
}

function collect(patch = {}) {
  const password = fields.password.value;
  const out = {
    baseUrl: fields.baseUrl.value.trim(),
    username: fields.username.value.trim() || 'admin',
    widgetId: fields.widgetId.value,
    intervalMs: Math.max(3, Number(fields.intervalSec.value) || 10) * 1000,
    opacity: Number(fields.opacity.value),
    cardColor: fields.cardColor.value,
    textColor: fields.textColor.value,
    accentColor: fields.accentColor.value,
    fontSize: Number(fields.fontSize.value),
    width: Number(fields.width.value),
    height: Number(fields.height.value),
    alwaysOnTop: fields.alwaysOnTop.checked,
    skipTaskbar: fields.skipTaskbar.checked,
    showDone: fields.showDone.checked,
    confirmDelete: fields.confirmDelete.checked,
    launchAtLogin: fields.launchAtLogin.checked,
    clickThrough: fields.clickThrough.checked,
    ...patch,
  };
  if (password) out.password = password; // 留空表示不修改已保存的密码
  return out;
}

function setResult(text, ok) {
  const el = $('test-result');
  el.textContent = text;
  el.className = `result ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`;
}

$('btn-test').addEventListener('click', async () => {
  setResult('测试中…');
  $('btn-test').disabled = true;
  try {
    const res = await api.testConnection({
      baseUrl: fields.baseUrl.value.trim(),
      username: fields.username.value.trim() || 'admin',
      password: fields.password.value || undefined,
    });
    if (res.ok) {
      widgetOptions = res.todos || [];
      renderWidgetOptions(fields.widgetId.value);
      setResult(`连接成功 · 找到 ${widgetOptions.length} 个待办组件 · 数据版本 ${res.version}`, true);
    } else {
      setResult(`连接失败：${res.error}`, false);
    }
  } finally {
    $('btn-test').disabled = false;
  }
});

$('btn-save').addEventListener('click', async () => {
  const patch = collect();
  if (!patch.baseUrl) {
    setResult('请先填写服务器地址', false);
    return;
  }
  if (!patch.widgetId) {
    setResult('请先选择待办组件（可点「测试连接」加载列表）', false);
    return;
  }
  setResult('保存中…');
  await api.setConfig(patch);
  const res = await api.saveConnection(patch);
  // 密码保存后清空输入框
  fields.password.value = '';
  if (res && res.ok) {
    widgetOptions = [];
    setResult('已保存并开始同步', true);
    await refresh();
  } else {
    setResult(`已保存，但同步失败：${(res && res.error) || '未知错误'}`, false);
  }
});

// 外观类改动即时生效（不需要点保存）
const liveIds = ['opacity', 'cardColor', 'textColor', 'accentColor', 'fontSize', 'width', 'height'];
for (const id of liveIds) {
  fields[id].addEventListener('input', () => {
    $('opacity-val').textContent = `${Math.round(Number(fields.opacity.value) * 100)}%`;
    $('fontsize-val').textContent = `${fields.fontSize.value}px`;
    void api.setConfig(collect({ password: undefined }));
  });
}

const liveChecks = ['alwaysOnTop', 'skipTaskbar', 'showDone', 'confirmDelete', 'clickThrough'];
for (const id of liveChecks) {
  fields[id].addEventListener('change', () => {
    void api.setConfig(collect({ password: undefined }));
  });
}

fields.launchAtLogin.addEventListener('change', () => {
  void api.setConfig({ launchAtLogin: fields.launchAtLogin.checked });
});

$('btn-sync').addEventListener('click', async () => {
  setResult('同步中…');
  const res = await api.syncNow();
  setResult(
    res.status === 'idle' ? '同步完成' : `同步状态：${res.status}${res.error ? ` · ${res.error}` : ''}`,
    res.status === 'idle',
  );
});

$('btn-close').addEventListener('click', () => window.close());
$('btn-repo').addEventListener('click', () => api.openExternal('https://github.com/bluise/FlatNas'));

async function refresh() {
  const st = await api.getState();
  fillForm(st.config || {}, st.appVersion);
}

api.onState((payload) => {
  // 主进程推送时只刷新"非输入中"的字段，避免打断正在编辑的输入框
  if (document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) {
    if (payload.appVersion) $('app-version').textContent = payload.appVersion;
    return;
  }
  fillForm(payload.config || {}, payload.appVersion);
});

void refresh();
