/**
 * 设置窗口逻辑。
 * 连接测试直接用 FlatNasClient 跑一遍真实登录 + 拉取组件列表，
 * 确认地址账号没问题再保存。
 */

import { FlatNasClient } from './lib/flatnas-client.js';
import { bridge, bridgeFetch } from './bridge.js';

const $ = (id) => document.getElementById(id);

const fields = {
  baseUrl: $('baseUrl'),
  username: $('username'),
  password: $('password'),
  rememberPassword: $('rememberPassword'),
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

let config = {};
let widgetOptions = [];

function fill(cfg) {
  config = cfg;
  fields.baseUrl.value = cfg.base_url || '';
  fields.username.value = cfg.username || 'admin';
  fields.password.value = cfg.password || '';
  fields.password.placeholder = cfg.password ? '已保存，留空表示不修改' : '请输入密码';
  fields.rememberPassword.checked = Boolean(cfg.remember_password);
  fields.intervalSec.value = Math.round((cfg.interval_ms || 10000) / 1000);
  fields.opacity.value = cfg.opacity ?? 0.85;
  fields.cardColor.value = cfg.card_color || '#111827';
  fields.textColor.value = cfg.text_color || '#f9fafb';
  fields.accentColor.value = cfg.accent_color || '#3b82f6';
  fields.fontSize.value = cfg.font_size || 14;
  fields.width.value = Math.round(cfg.width || 320);
  fields.height.value = Math.round(cfg.height || 440);
  fields.alwaysOnTop.checked = Boolean(cfg.always_on_top);
  fields.skipTaskbar.checked = Boolean(cfg.skip_taskbar);
  fields.showDone.checked = cfg.show_done !== false;
  fields.confirmDelete.checked = Boolean(cfg.confirm_delete);
  fields.clickThrough.checked = Boolean(cfg.click_through);
  $('opacity-val').textContent = `${Math.round((cfg.opacity ?? 0.85) * 100)}%`;
  $('fontsize-val').textContent = `${Math.round(cfg.font_size || 14)}px`;
  $('remember-hint').textContent = cfg.token ? '已登录（token 已保存）' : '尚未登录';
  renderWidgetOptions(cfg.widget_id || '');
}

function renderWidgetOptions(selected) {
  const select = fields.widgetId;
  select.innerHTML = '';
  const seen = new Set();
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
  if (!widgetOptions.length && !selected) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（先点「测试连接」加载列表）';
    select.appendChild(opt);
  }
  if (selected) select.value = selected;
  else if (widgetOptions.length === 1) select.value = widgetOptions[0].id;
}

function collect(patch = {}) {
  const password = fields.password.value;
  return {
    base_url: fields.baseUrl.value.trim(),
    username: fields.username.value.trim() || 'admin',
    remember_password: fields.rememberPassword.checked,
    widget_id: fields.widgetId.value,
    interval_ms: Math.max(3, Number(fields.intervalSec.value) || 10) * 1000,
    opacity: Number(fields.opacity.value),
    card_color: fields.cardColor.value,
    text_color: fields.textColor.value,
    accent_color: fields.accentColor.value,
    font_size: Number(fields.fontSize.value),
    width: Number(fields.width.value),
    height: Number(fields.height.value),
    always_on_top: fields.alwaysOnTop.checked,
    skip_taskbar: fields.skipTaskbar.checked,
    click_through: fields.clickThrough.checked,
    show_done: fields.showDone.checked,
    confirm_delete: fields.confirmDelete.checked,
    ...(password ? { password } : {}),
    ...patch,
  };
}

/** 收集那些「即时生效」的字段（不含密码/地址，避免半填状态写进配置） */
function collectLive() {
  return {
    opacity: Number(fields.opacity.value),
    card_color: fields.cardColor.value,
    text_color: fields.textColor.value,
    accent_color: fields.accentColor.value,
    font_size: Number(fields.fontSize.value),
    width: Number(fields.width.value),
    height: Number(fields.height.value),
    always_on_top: fields.alwaysOnTop.checked,
    skip_taskbar: fields.skipTaskbar.checked,
    click_through: fields.clickThrough.checked,
    show_done: fields.showDone.checked,
    confirm_delete: fields.confirmDelete.checked,
  };
}

function setResult(text, ok) {
  const box = $('test-result');
  box.textContent = text;
  box.className = `result ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`;
}

// ---------------------------------------------------------------- 事件

$('btn-test').addEventListener('click', async () => {
  const baseUrl = fields.baseUrl.value.trim();
  if (!baseUrl) {
    setResult('请先填写服务器地址', false);
    return;
  }
  setResult('测试中…');
  $('btn-test').disabled = true;
  try {
    const probe = new FlatNasClient({ baseUrl, fetchImpl: bridgeFetch });
    await probe.login(fields.username.value.trim() || 'admin', fields.password.value || config.password || '');
    const widgets = await probe.listWidgets();
    widgetOptions = widgets.filter((w) => w.type === 'todo');
    renderWidgetOptions(fields.widgetId.value);
    const version = await probe.fetchVersion().catch(() => 0);
    setResult(`连接成功 · 找到 ${widgetOptions.length} 个待办组件 · 数据版本 ${version}`, true);
  } catch (e) {
    setResult(`连接失败：${e.message}`, false);
  } finally {
    $('btn-test').disabled = false;
  }
});

$('btn-save').addEventListener('click', async () => {
  const patch = collect();
  if (!patch.base_url) {
    setResult('请先填写服务器地址', false);
    return;
  }
  if (!patch.widget_id) {
    setResult('请先选择待办组件（可点「测试连接」加载列表）', false);
    return;
  }
  setResult('保存中…');
  await bridge.saveConfig(patch);

  // 立即登录一次，把 token 写进配置，主窗口才能马上开始同步
  const password = fields.password.value || config.password || '';
  if (patch.remember_password && password) {
    try {
      const probe = new FlatNasClient({ baseUrl: patch.base_url, fetchImpl: bridgeFetch });
      const res = await probe.login(patch.username, password);
      await bridge.saveConfig({ token: res.token, password, remember_password: true });
      fields.password.value = '';
      setResult('已保存并登录，开始同步', true);
    } catch (e) {
      setResult(`已保存，但登录失败：${e.message}`, false);
    }
  } else {
    setResult('已保存（未勾选记住密码，请在主界面手动登录一次）', true);
  }
  await refresh();
});

for (const id of ['opacity', 'cardColor', 'textColor', 'accentColor', 'fontSize', 'width', 'height']) {
  fields[id].addEventListener('input', () => {
    $('opacity-val').textContent = `${Math.round(Number(fields.opacity.value) * 100)}%`;
    $('fontsize-val').textContent = `${fields.fontSize.value}px`;
    void bridge.saveConfig(collectLive());
  });
}
for (const id of ['alwaysOnTop', 'skipTaskbar', 'showDone', 'confirmDelete', 'clickThrough']) {
  fields[id].addEventListener('change', () => void bridge.saveConfig(collectLive()));
}

fields.launchAtLogin.addEventListener('change', async () => {
  try {
    await bridge.setAutostart(fields.launchAtLogin.checked);
    await bridge.saveConfig({ launch_at_login: fields.launchAtLogin.checked });
  } catch (e) {
    setResult(`设置开机自启失败：${e.message}`, false);
    fields.launchAtLogin.checked = !fields.launchAtLogin.checked;
  }
});

$('btn-repo').addEventListener('click', () => bridge.openExternal('https://github.com/bluise/FlatNas'));
$('btn-close').addEventListener('click', () => window.close());

async function refresh() {
  fill(await bridge.loadConfig());
}

void bridge.onConfigChanged((next) => {
  // 正在输入时不打断
  const active = document.activeElement;
  if (active && ['INPUT', 'SELECT'].includes(active.tagName)) {
    config = next;
    return;
  }
  fill(next);
});

void refresh();
