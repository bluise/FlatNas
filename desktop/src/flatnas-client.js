'use strict';

/**
 * FlatNas HTTP 客户端。
 *
 * 只做网络与协议这一层，不碰窗口/UI，方便用 node:test 直接测。
 * 对接的后端接口（都在 FlatNas 后端里）：
 *   POST /api/login            -> { success, token, username }
 *   GET  /api/version          -> { version }                （全局版本号，乐观锁用）
 *   GET  /api/widgets/:id      -> { success, data }          （需要 Authorization）
 *   PUT  /api/widgets/:id      -> { success, version }        （需要 Authorization）
 *   GET  /api/data             -> { widgets: [...] }          （列出待办组件用）
 */

class FlatNasError extends Error {
  constructor(message, { status = 0, body = null, kind = 'http' } = {}) {
    super(message);
    this.name = 'FlatNasError';
    this.status = status;
    this.body = body;
    this.kind = kind; // http | timeout | network | auth | conflict
  }
}

function normalizeBaseUrl(raw) {
  let base = String(raw || '').trim();
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
  return base.replace(/\/+$/, '');
}

class FlatNasClient {
  constructor({ baseUrl = '', fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.token = '';
    this.username = '';
    /** 最近一次已知的全局数据版本号，PUT 时用作乐观锁 */
    this.version = 0;
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.version = 0;
  }

  setToken(token, username = '') {
    this.token = String(token || '');
    if (username) this.username = username;
  }

  get isConfigured() {
    return Boolean(this.baseUrl && this.token);
  }

  async request(pathname, { method = 'GET', body, auth = true, timeoutMs } = {}) {
    if (!this.baseUrl) {
      throw new FlatNasError('未配置服务器地址', { kind: 'config' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;

    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
      throw new FlatNasError(aborted ? '请求超时' : `网络不可达：${e && e.message}`, {
        kind: aborted ? 'timeout' : 'network',
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!res.ok) {
      const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 409 ? 'conflict' : 'http';
      const message =
        (parsed && (parsed.error || parsed.message)) || `HTTP ${res.status} ${res.statusText || ''}`.trim();
      throw new FlatNasError(message, { status: res.status, body: parsed, kind });
    }
    return parsed;
  }

  /** 登录并缓存 token。 */
  async login(username, password) {
    const data = await this.request('/api/login', {
      method: 'POST',
      auth: false,
      body: { username: String(username || ''), password: String(password || '') },
    });
    if (!data || !data.token) {
      throw new FlatNasError('登录响应缺少 token', { kind: 'http', body: data });
    }
    this.setToken(data.token, data.username || username);
    return { token: this.token, username: this.username };
  }

  /** 取全局数据版本号（乐观锁用）。 */
  async fetchVersion() {
    const data = await this.request('/api/version', { timeoutMs: 8000 });
    const v = data && Number(data.version);
    this.version = Number.isFinite(v) ? v : 0;
    return this.version;
  }

  /** 列出所有组件，供设置页选择"待办组件"。 */
  async listWidgets() {
    const data = await this.request('/api/data');
    const widgets = (data && Array.isArray(data.widgets) ? data.widgets : []).map((w) => ({
      id: String(w && w.id ? w.id : ''),
      type: String((w && w.type) || ''),
      enable: Boolean(w && w.enable),
      title: (w && w.data && (w.data.title || w.data.name)) || '',
    }));
    return widgets.filter((w) => w.id);
  }

  async fetchWidgetData(widgetId) {
    const data = await this.request(`/api/widgets/${encodeURIComponent(widgetId)}`, { timeoutMs: 8000 });
    return data ? data.data : null;
  }

  /**
   * 保存单个组件的 data。
   *
   * 后端要求带上全局 version 做乐观锁，不匹配会返回 409 并给出 currentVersion；
   * 这里遇到 409 就带着服务端的版本重试一次（与网页端行为一致）。
   * 注意：不发送 widgetVersion —— 后端只在字段存在时才校验它，
   * 而 GET /api/widgets/:id 并不返回该字段，发一个过期的值反而会一直 409。
   */
  async saveWidgetData(widgetId, data, { enable = true, retries = 1 } = {}) {
    let attempt = 0;
    let version = this.version || 0;
    for (;;) {
      try {
        const res = await this.request(`/api/widgets/${encodeURIComponent(widgetId)}`, {
          method: 'PUT',
          body: { data, enable, version },
        });
        const next = res && Number(res.version);
        if (Number.isFinite(next)) this.version = next;
        return res;
      } catch (e) {
        const isConflict = e instanceof FlatNasError && e.kind === 'conflict';
        if (!isConflict || attempt >= retries) throw e;
        const serverVersion = e.body && Number(e.body.currentVersion);
        if (!Number.isFinite(serverVersion)) throw e;
        version = serverVersion;
        this.version = serverVersion;
        attempt += 1;
      }
    }
  }
}

module.exports = { FlatNasClient, FlatNasError, normalizeBaseUrl };
