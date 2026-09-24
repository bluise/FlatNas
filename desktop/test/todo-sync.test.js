'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TodoSync, canonicalizeItems } = require('../src/todo-sync');

function makeClient(overrides = {}) {
  const state = { saved: [], saves: 0, fetches: 0, remote: [], failSave: false, isConfigured: true };
  const client = {
    isConfigured: true,
    version: 0,
    async saveWidgetData(_id, data) {
      state.saves += 1;
      if (state.failSave) {
        const e = new Error('网络不可达');
        e.kind = 'network';
        throw e;
      }
      state.saved.push(JSON.parse(JSON.stringify(data)));
      state.remote = JSON.parse(JSON.stringify(data));
      return { success: true, version: (client.version += 1) };
    },
    async fetchWidgetData() {
      state.fetches += 1;
      return JSON.parse(JSON.stringify(state.remote));
    },
    ...overrides,
  };
  return { client, state };
}

function makeSync(extra = {}) {
  const { client, state } = makeClient();
  const updates = [];
  const sync = new TodoSync({
    client,
    getWidgetId: () => 'w8',
    onUpdate: (items, meta) => updates.push({ items, meta }),
    ...extra,
  });
  return { sync, state, updates, client };
}

test('canonicalizeItems 补齐缺失 id、去重、统一字段', () => {
  const items = canonicalizeItems([
    { text: '没有 id', done: 1 },
    { id: 'dup', text: 'a' },
    { id: 'dup', text: 'b' },
    null,
    'x',
  ]);
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => typeof i.id === 'string' && i.id.length > 0));
  assert.equal(new Set(items.map((i) => i.id)).size, 3, 'id 必须唯一');
  assert.equal(items[0].done, true);
  assert.equal(items[1].text, 'a');
});

test('本地改动会标记 dirty 并写入服务端', async () => {
  const { sync, state } = makeSync();
  sync.add('买牛奶');
  await sync.flush();

  assert.equal(sync.dirty, false);
  assert.equal(state.saves, 1);
  assert.equal(state.saved[0].length, 1);
  assert.equal(state.saved[0][0].text, '买牛奶');
});

test('有未落盘的本地改动时，远端数据不会覆盖本地（关键回归）', async () => {
  const { sync, state } = makeSync();
  sync.items = canonicalizeItems([{ id: 'a', text: '本地条目', done: false }]);
  sync.dirty = true;
  state.remote = [{ id: 'z', text: '服务端旧数据', done: false }];

  const applied = sync.applyRemote(state.remote);

  assert.equal(applied, false);
  assert.deepEqual(sync.items.map((i) => i.text), ['本地条目']);
});

test('没有本地改动时，远端数据是权威的（正常同步）', () => {
  const { sync } = makeSync();
  sync.items = canonicalizeItems([{ id: 'a', text: '旧', done: false }]);
  sync.dirty = false;

  const changed = sync.applyRemote([{ id: 'b', text: '服务端新内容', done: false }]);

  assert.equal(changed, true);
  assert.deepEqual(sync.items.map((i) => i.text), ['服务端新内容']);
});

test('syncOnce 会先推送本地改动再拉取远端', async () => {
  const { sync, state } = makeSync();
  sync.add('本地新增');
  await sync.syncOnce(true);

  assert.equal(state.saves, 1, '先保存');
  assert.equal(state.fetches, 1, '再拉取');
  assert.equal(sync.dirty, false);
  assert.deepEqual(sync.items.map((i) => i.text), ['本地新增']);
});

test('保存失败时保留本地改动并标记 offline，不会丢数据', async () => {
  const { sync, state } = makeSync();
  state.failSave = true;
  sync.add('离线写的');
  await sync.flush();

  assert.equal(sync.dirty, true, '未成功保存必须保持 dirty');
  assert.equal(sync.items.length, 1);
  assert.equal(sync.status, 'offline');
  sync.stop();
});

test('保存失败后 syncOnce 不会用远端覆盖本地', async () => {
  const { sync, state } = makeSync();
  state.failSave = true;
  sync.add('本地重要内容');
  state.remote = [];
  await sync.syncOnce(true);

  assert.equal(sync.dirty, true);
  assert.deepEqual(sync.items.map((i) => i.text), ['本地重要内容']);
  sync.stop();
});

test('未配置时不请求网络', async () => {
  const { sync, state } = makeSync({ getWidgetId: () => '' });
  await sync.syncOnce(true);
  assert.equal(sync.status, 'unconfigured');
  assert.equal(state.fetches, 0);
});

test('删除与勾选都会同步', async () => {
  const { sync, state } = makeSync();
  sync.items = canonicalizeItems([
    { id: 'a', text: 'A', done: false },
    { id: 'b', text: 'B', done: false },
  ]);
  sync.toggle('a', true);
  await sync.flush();
  sync.remove('b');
  await sync.flush();

  assert.equal(state.saved.at(-1).length, 1);
  assert.equal(state.saved.at(-1)[0].done, true);
  assert.equal(sync.status, 'idle');
});

test('clearDone 只删除已完成项', async () => {
  const { sync, state } = makeSync();
  sync.items = canonicalizeItems([
    { id: 'a', text: 'A', done: true },
    { id: 'b', text: 'B', done: false },
  ]);
  sync.clearDone();
  await sync.flush();

  assert.deepEqual(state.saved.at(-1).map((i) => i.text), ['B']);
});
