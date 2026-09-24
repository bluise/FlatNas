'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConfigStore, sanitize, DEFAULTS } = require('../src/config');

function tempFile(name = 'config.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flatnas-cfg-'));
  return path.join(dir, name);
}

test('sanitize 会夹紧数值范围并补默认值', () => {
  const cfg = sanitize({
    opacity: 5,
    fontSize: 999,
    intervalMs: 1,
    width: 10,
    height: 99999,
    baseUrl: '  http://nas:23000  ',
    username: '',
  });
  assert.equal(cfg.opacity, 1, 'opacity 上限 1');
  assert.equal(cfg.fontSize, 28, 'fontSize 上限 28');
  assert.equal(cfg.intervalMs, 3000, 'intervalMs 下限 3000');
  assert.equal(cfg.width, 220, 'width 下限 220');
  assert.equal(cfg.height, 1600, 'height 上限 1600');
  assert.equal(cfg.baseUrl, 'http://nas:23000');
  assert.equal(cfg.username, 'admin');
  assert.equal(sanitize({ opacity: -3 }).opacity, 0.15, 'opacity 下限 0.15');
});

test('布尔字段会被强制成 boolean', () => {
  const cfg = sanitize({ alwaysOnTop: 0, skipTaskbar: '', showDone: undefined, clickThrough: 'yes' });
  assert.equal(cfg.alwaysOnTop, false);
  assert.equal(cfg.skipTaskbar, false);
  assert.equal(cfg.showDone, false);
  assert.equal(cfg.clickThrough, true);
});

test('保存后能读回，且密码经过注入的加解密', () => {
  const file = tempFile();
  const encrypt = (v) => `enc(${v})`;
  const decrypt = (v) => String(v).replace(/^enc\((.*)\)$/, '$1');
  const store = createConfigStore({ filePath: file, encrypt, decrypt });

  store.save({ baseUrl: 'http://nas:23000', widgetId: 'w8', password: 'secret', opacity: 0.4 });

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.password, undefined, '明文密码不落盘');
  assert.equal(onDisk.passwordEnc, 'enc(secret)');

  const reloaded = createConfigStore({ filePath: file, encrypt, decrypt });
  reloaded.load();
  assert.equal(reloaded.get().password, 'secret');
  assert.equal(reloaded.get().widgetId, 'w8');
  assert.equal(reloaded.get().opacity, 0.4);
});

test('文件不存在或损坏时回落到默认值', () => {
  const missing = createConfigStore({ filePath: tempFile('nope.json') });
  assert.deepEqual(missing.load(), sanitize(null));

  const broken = tempFile();
  fs.writeFileSync(broken, '{ this is not json');
  const store = createConfigStore({ filePath: broken });
  const cfg = store.load();
  assert.equal(cfg.baseUrl, DEFAULTS.baseUrl);
  assert.equal(cfg.opacity, DEFAULTS.opacity);
});

test('set 只覆盖传入的字段', () => {
  const file = tempFile();
  const store = createConfigStore({ filePath: file });
  store.save({ baseUrl: 'http://a:1', fontSize: 16 });
  store.set({ fontSize: 20 });
  const cfg = store.get();
  assert.equal(cfg.baseUrl, 'http://a:1', '未传的字段保持原值');
  assert.equal(cfg.fontSize, 20);
});

test('窗口坐标非数字时存为 null', () => {
  const cfg = sanitize({ x: 'abc', y: '12.7' });
  assert.equal(cfg.x, null);
  assert.equal(cfg.y, 13);
});
