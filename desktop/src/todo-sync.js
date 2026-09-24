'use strict';

/**
 * 待办同步引擎。
 *
 * 策略与网页端修复后的行为保持一致：
 *  - **本地有未落盘的改动时，远端数据不允许覆盖本地**（避免"刚删掉的条目又冒出来"）；
 *  - 需要读远端时会先把本地改动推上去；
 *  - 服务端返回空数组视为权威结果，不会用本地缓存回填；
 *  - 保存失败保留本地改动并退避重试，不会静默丢。
 */

const DEFAULT_INTERVAL_MS = 10000;
const SAVE_RETRY_BASE_MS = 2000;
const SAVE_RETRY_MAX_MS = 60000;

let idCounter = 0;

/** 生成唯一 id：不用 Date.now() 兜底，避免同一毫秒内多条撞号 */
function createId() {
  idCounter = (idCounter + 1) % 1e6;
  const rand = Math.random().toString(36).slice(2, 8);
  return `todo-${Date.now().toString(36)}-${idCounter.toString(36)}-${rand}`;
}

/** 归一化：补齐缺失 id、去重 id、统一字段类型 */
function canonicalizeItems(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    let id = typeof raw.id === 'string' && raw.id ? raw.id : createId();
    if (seen.has(id)) id = createId();
    seen.add(id);
    out.push({
      id,
      text: typeof raw.text === 'string' ? raw.text : '',
      done: Boolean(raw.done),
    });
  }
  return out;
}

const snapshot = (items) =>
  JSON.stringify(items.map((i) => ({ id: i.id, text: i.text, done: i.done })));

class TodoSync {
  /**
   * @param {object} opts
   * @param {import('./flatnas-client').FlatNasClient} opts.client
   * @param {() => string} opts.getWidgetId
   * @param {(items: Array, meta: object) => void} [opts.onUpdate]  列表变化时回调
   * @param {(status: object) => void} [opts.onStatus]              同步状态变化时回调
   * @param {number} [opts.intervalMs]
   */
  constructor({ client, getWidgetId, onUpdate, onStatus, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    this.client = client;
    this.getWidgetId = getWidgetId || (() => '');
    this.onUpdate = onUpdate || (() => {});
    this.onStatus = onStatus || (() => {});

    this.items = [];
    this.intervalMs = intervalMs;
    this.lastSyncedAt = 0;
    this.lastError = '';
    /** 本地改动尚未成功写入服务端 */
    this.dirty = false;
    this.status = 'idle'; // idle | syncing | offline | error | unconfigured

    this.timer = null;
    this.retryTimer = null;
    this.retryCount = 0;
    this.running = false;
    this.saveChain = Promise.resolve();
  }

  setIntervalMs(ms) {
    const next = Math.max(3000, Number(ms) || DEFAULT_INTERVAL_MS);
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    if (this.running) {
      this.stop();
      this.start();
    }
  }

  /** 服务端数据（只在本地没有未保存改动时采用） */
  applyRemote(rawItems) {
    const items = canonicalizeItems(rawItems);
    if (this.dirty) return false;
    if (snapshot(items) === snapshot(this.items)) return false;
    this.items = items;
    this.emitUpdate({ source: 'remote' });
    return true;
  }

  emitUpdate(meta = {}) {
    this.onUpdate(this.items.map((i) => ({ ...i })), {
      dirty: this.dirty,
      status: this.status,
      lastSyncedAt: this.lastSyncedAt,
      ...meta,
    });
  }

  setStatus(status, error = '') {
    if (this.status === status && this.lastError === error) return;
    this.status = status;
    this.lastError = error;
    this.onStatus({ status, error, lastSyncedAt: this.lastSyncedAt, dirty: this.dirty });
  }

  /** 本地改动入口：fn 拿到当前列表的副本，返回新列表 */
  mutate(fn) {
    const next = canonicalizeItems(fn(this.items.map((i) => ({ ...i }))));
    this.items = next;
    this.dirty = true;
    this.retryCount = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.emitUpdate({ source: 'local' });
    void this.flush();
    return this.items;
  }

  add(text) {
    const value = String(text || '').trim();
    if (!value) return this.items;
    return this.mutate((list) => [...list, { id: createId(), text: value, done: false }]);
  }

  toggle(id, done) {
    return this.mutate((list) => list.map((i) => (i.id === id ? { ...i, done: Boolean(done) } : i)));
  }

  remove(id) {
    return this.mutate((list) => list.filter((i) => i.id !== id));
  }

  updateText(id, text) {
    return this.mutate((list) => list.map((i) => (i.id === id ? { ...i, text: String(text) } : i)));
  }

  clearDone() {
    return this.mutate((list) => list.filter((i) => !i.done));
  }

  /** 把本地改动写回服务端（串行化，避免并发 PUT 互相覆盖） */
  flush() {
    const run = async () => {
      const widgetId = this.getWidgetId();
      if (!widgetId || !this.client.isConfigured) return false;
      if (!this.dirty) return true;

      const sentSnapshot = snapshot(this.items);
      const sentItems = this.items.map((i) => ({ ...i }));
      try {
        await this.client.saveWidgetData(widgetId, sentItems);
        if (snapshot(this.items) === sentSnapshot) {
          this.dirty = false;
        } else {
          // 保存期间又改了：保持待同步，稍后再存
          this.dirty = true;
        }
        this.lastSyncedAt = Date.now();
        this.setStatus('idle');
        this.emitUpdate({ source: 'save' });
        return true;
      } catch (e) {
        const kind = e && e.kind;
        if (kind === 'auth') {
          this.setStatus('error', '登录状态失效，请在设置里重新登录');
          await this.onAuthError?.(e);
          return false;
        }
        this.setStatus(kind === 'network' || kind === 'timeout' ? 'offline' : 'error', e.message);
        this.scheduleRetry();
        return false;
      }
    };
    this.saveChain = this.saveChain.then(run, run);
    return this.saveChain;
  }

  scheduleRetry() {
    if (this.retryTimer) return;
    if (!this.dirty) return;
    const delay = Math.min(SAVE_RETRY_BASE_MS * 2 ** this.retryCount, SAVE_RETRY_MAX_MS);
    this.retryCount += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
  }

  /**
   * 拉一次远端。
   * @param {boolean} force 忽略"本地有改动"的宽限（仍会先 flush）
   */
  async syncOnce(force = false) {
    const widgetId = this.getWidgetId();
    if (!this.client.isConfigured || !widgetId) {
      this.setStatus('unconfigured');
      return false;
    }
    if (this.status === 'syncing') return false;

    this.setStatus('syncing');
    // 本地有未保存改动：先推上去，推不上去就不要用远端覆盖本地
    if (this.dirty) {
      const ok = await this.flush();
      if (!ok || this.dirty) {
        this.setStatus(this.status === 'syncing' ? 'offline' : this.status, this.lastError);
        return false;
      }
    }
    try {
      const data = await this.client.fetchWidgetData(widgetId);
      this.applyRemote(data);
      this.lastSyncedAt = Date.now();
      this.retryCount = 0;
      this.setStatus('idle');
      this.emitUpdate({ source: 'poll' });
      return true;
    } catch (e) {
      const kind = e && e.kind;
      this.setStatus(kind === 'network' || kind === 'timeout' ? 'offline' : 'error', e.message);
      return false;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.syncOnce(true);
    this.timer = setInterval(() => {
      void this.syncOnce();
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

module.exports = { TodoSync, canonicalizeItems, createId, snapshot };
