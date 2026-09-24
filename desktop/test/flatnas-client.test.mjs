import test from "node:test";
import assert from "node:assert/strict";
import { FlatNasClient, FlatNasError, normalizeBaseUrl } from "../src/lib/flatnas-client.js";

/** 构造一个可编排的 fetch 假实现 */
function makeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body });
    for (const h of handlers) {
      if (h.match(url, init)) return h.reply(url, init);
    }
    throw new Error(`未预期的请求: ${init.method || 'GET'} ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const json = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  text: async () => JSON.stringify(payload),
});

test('normalizeBaseUrl 会补协议、去掉结尾斜杠', () => {
  assert.equal(normalizeBaseUrl('192.168.1.10:23000'), 'http://192.168.1.10:23000');
  assert.equal(normalizeBaseUrl('https://nas.example.com/'), 'https://nas.example.com');
  assert.equal(normalizeBaseUrl('  '), '');
});

test('登录成功会缓存 token 与用户名', async () => {
  const fetchImpl = makeFetch([
    {
      match: (url) => url.endsWith('/api/login'),
      reply: () => json(200, { success: true, token: 'jwt-1', username: 'admin' }),
    },
  ]);
  const client = new FlatNasClient({ baseUrl: 'http://nas:23000', fetchImpl });
  const res = await client.login('admin', 'pw');

  assert.equal(res.token, 'jwt-1');
  assert.equal(client.token, 'jwt-1');
  assert.equal(client.isConfigured, true);
  const call = fetchImpl.calls[0];
  assert.deepEqual(call.body, { username: 'admin', password: 'pw' });
  assert.equal(call.headers.Authorization, undefined, '登录请求不应带 Authorization');
});

test('登录失败抛 auth 错误并带上服务端信息', async () => {
  const fetchImpl = makeFetch([
    { match: () => true, reply: () => json(401, { error: 'Password incorrect' }) },
  ]);
  const client = new FlatNasClient({ baseUrl: 'http://nas:23000', fetchImpl });
  await assert.rejects(() => client.login('admin', 'bad'), (e) => {
    assert.equal(e.kind, 'auth');
    assert.equal(e.status, 401);
    assert.match(e.message, /Password incorrect/);
    return true;
  });
});

test('请求超时会归类为 timeout', async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const client = new FlatNasClient({ baseUrl: 'http://nas:23000', fetchImpl, timeoutMs: 20 });
  // login 没有 per-call 超时覆盖，走的就是客户端超时
  await assert.rejects(() => client.login('admin', 'pw'), (e) => {
    assert.equal(e.kind, 'timeout');
    return true;
  });
});

test('网络不可达归类为 network', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const client = new FlatNasClient({ baseUrl: 'http://nas:23000', fetchImpl });
  await assert.rejects(() => client.fetchWidgetData('w8'), (e) => e.kind === 'network');
});

test('未配置服务器地址时不发请求', async () => {
  const client = new FlatNasClient({ baseUrl: '', fetchImpl: async () => json(200, {}) });
  await assert.rejects(() => client.fetchWidgetData('w8'), (e) => e.kind === 'config');
});

test('saveWidgetData 遇到 409 会用服务端版本重试一次并成功', async () => {
  let putCount = 0;
  const fetchImpl = makeFetch([
    {
      match: (url, init) => url.includes('/api/widgets/w8') && init.method === 'PUT',
      reply: (_url, init) => {
        putCount += 1;
        const body = JSON.parse(init.body);
        if (putCount === 1) return json(409, { error: 'Version conflict', currentVersion: 42 });
        return json(200, { success: true, version: 43 });
      },
    },
  ]);
  const client = new FlatNasClient({ baseUrl: 'http://nas:23000', fetchImpl });
  client.setToken('jwt-1');

  const res = await client.saveWidgetData('w8', [{ id: 'a', text: 'x', done: false }]);
  assert.equal(putCount, 2);
  assert.equal(res.version, 43);
  assert.equal(client.version, 43);

  const first = fetchImpl.calls[0].body;
  const second = fetchImpl.calls[1].body;
  assert.equal(first.version, 0, '第一次用本地已知版本');
  assert.equal(second.version, 42, '重试时带上服务端返回的当前版本');
  assert.equal(first.widgetVersion, undefined, '不应发送 widgetVersion（GET 不返回它，发了会一直 409）');
  assert.equal(first.enable, true);
});

test('saveWidgetData 连续 409 时抛出 conflict', async () => {
  const fetchImpl = makeFetch([
    {
      match: (_url, init) => init.method === 'PUT',
      reply: () => json(409, { error: 'Version conflict', currentVersion: 7 }),
    },
  ]);
  const client = new FlatNasClient({ baseUrl: 'http://nas:23000', fetchImpl });
  client.setToken('jwt-1');
  await assert.rejects(() => client.saveWidgetData('w8', []), (e) => e.kind === 'conflict');
});

test('fetchVersion 会记录版本号', async () => {
  const fetchImpl = makeFetch([
    { match: (url) => url.endsWith('/api/version'), reply: () => json(200, { version: 12345 }) },
  ]);
  const client = new FlatNasClient({ baseUrl: 'http://nas:23000', fetchImpl });
  client.setToken('jwt-1');
  assert.equal(await client.fetchVersion(), 12345);
  assert.equal(client.version, 12345);
});

test('listWidgets 只返回带 id 的组件，供设置页选择', async () => {
  const fetchImpl = makeFetch([
    {
      match: (url) => url.endsWith('/api/data'),
      reply: () =>
        json(200, {
          widgets: [
            { id: 'w8', type: 'todo', enable: true, data: [] },
            { id: 'w4', type: 'memo', enable: true, data: {} },
            { type: 'clock' },
          ],
        }),
    },
  ]);
  const client = new FlatNasClient({ baseUrl: 'http://nas:23000', fetchImpl });
  client.setToken('jwt-1');
  const list = await client.listWidgets();
  assert.deepEqual(
    list.map((w) => w.id),
    ['w8', 'w4'],
  );
  assert.equal(list[0].type, 'todo');
});
