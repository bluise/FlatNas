/**
 * Tauri 桥接层。
 *
 * 只做三件事：
 *  1. 把 fetch 适配到 Rust 的 http_request 命令（因此没有跨域问题，token 也不进网页）
 *  2. 配置读写
 *  3. 窗口 / 托盘触发的动作
 *
 * 业务逻辑（协议、乐观锁重试、同步策略）都在 lib/ 里，用 node:test 单独测。
 */

const tauri = window.__TAURI__;
if (!tauri) {
  throw new Error('未检测到 Tauri 运行时（__TAURI__ 缺失）');
}
const invoke = tauri.core.invoke;
const listen = tauri.event.listen;

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function' && typeof headers.entries === 'function') {
    for (const [k, v] of headers.entries()) out[k] = v;
    return out;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}

/**
 * 与 fetch 兼容的最小实现，供 FlatNasClient 注入使用。
 * 非 2xx 也会正常返回（带 status），让上层按状态码分类：401 失效 / 409 版本冲突。
 */
export async function bridgeFetch(input, init = {}) {
  const request = invoke('http_request', {
    method: init.method || 'GET',
    url: String(input),
    headers: normalizeHeaders(init.headers),
    body: init.body === undefined || init.body === null ? null : String(init.body),
  }).then((res) => ({
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    statusText: '',
    text: async () => res.body,
  }));

  const signal = init.signal;
  if (!signal) return request;
  if (signal.aborted) throw abortError();
  return Promise.race([
    request,
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    }),
  ]);
}

export const bridge = {
  // 配置
  loadConfig: () => invoke('load_config'),
  saveConfig: (patch) => invoke('save_config', { patch }),
  setAutostart: (enabled) => invoke('set_autostart', { enabled }),

  // 窗口
  openSettings: () => invoke('open_settings'),
  hideWindow: () => invoke('hide_window'),
  toggleWindow: () => invoke('toggle_window'),
  quitApp: () => invoke('quit_app'),
  openExternal: (url) => invoke('open_external', { url }),

  // 主进程/托盘事件
  onConfigChanged: (handler) => listen('config-changed', (event) => handler(event.payload)),
  onSyncNow: (handler) => listen('sync-now', () => handler()),
  onToggleClickThrough: (handler) => listen('toggle-click-through', () => handler()),
  onAutostartChanged: (handler) => listen('autostart-changed', (event) => handler(event.payload)),
};
