'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  shell,
  screen,
  nativeImage,
  globalShortcut,
  safeStorage,
  dialog,
} = require('electron');

const { createConfigStore } = require('./src/config');
const { FlatNasClient, FlatNasError } = require('./src/flatnas-client');
const { TodoSync } = require('./src/todo-sync');

const ASSETS = path.join(__dirname, 'assets');
const isDev = !app.isPackaged;

/** @type {BrowserWindow|null} */ let widgetWin = null;
/** @type {BrowserWindow|null} */ let settingsWin = null;
/** @type {Tray|null} */ let tray = null;

let configStore = null;
/** @type {FlatNasClient} */ let client = null;
/** @type {TodoSync} */ let sync = null;
let quitting = false;

// ---------------------------------------------------------------- 配置加解密

function encryptSecret(plain) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(plain).toString('base64')}`;
    }
  } catch {
    /* 忽略，退回明文 */
  }
  return `plain:${plain}`;
}

function decryptSecret(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('plain:')) return stored.slice(6);
  } catch {
    return '';
  }
  return stored;
}

// ---------------------------------------------------------------- 状态与推送

let lastState = { items: [], meta: {} };

function currentState() {
  return {
    ...lastState,
    config: publicConfig(),
    connection: {
      configured: client.isConfigured,
      baseUrl: client.baseUrl,
      username: client.username,
    },
    appVersion: app.getVersion(),
  };
}

function publicConfig() {
  const cfg = configStore.get();
  return { ...cfg, password: undefined, hasPassword: Boolean(cfg.password) };
}

function broadcast() {
  const payload = currentState();
  for (const win of [widgetWin, settingsWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('state', payload);
  }
}

// ---------------------------------------------------------------- 窗口

function applyWindowFlags() {
  const cfg = configStore.get();
  if (!widgetWin || widgetWin.isDestroyed()) return;
  widgetWin.setAlwaysOnTop(cfg.alwaysOnTop, 'screen-saver');
  widgetWin.setSkipTaskbar(cfg.skipTaskbar);
  widgetWin.setIgnoreMouseEvents(cfg.clickThrough, { forward: true });
  widgetWin.setResizable(true);
  widgetWin.setMinimumSize(220, 180);
}

function persistBounds() {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  const b = widgetWin.getBounds();
  configStore.save({ x: b.x, y: b.y, width: b.width, height: b.height });
}

function createWidgetWindow() {
  const cfg = configStore.get();
  const bounds = {};
  if (Number.isFinite(cfg.x) && Number.isFinite(cfg.y)) {
    // 防止显示器拔掉后窗口跑到屏幕外
    const displays = screen.getAllDisplays();
    const visible = displays.some((d) => {
      const a = d.workArea;
      return cfg.x < a.x + a.width && cfg.x + cfg.width > a.x && cfg.y < a.y + a.height && cfg.y + cfg.height > a.y;
    });
    if (visible) {
      bounds.x = cfg.x;
      bounds.y = cfg.y;
    }
  }

  // 透明窗口需要桌面合成器（Windows 原生支持；Linux 需要有合成器的桌面环境）。
  // FLATNAS_NO_TRANSPARENT 供无头/CI 环境自检时关掉透明，避免因缺合成器而崩。
  const allowTransparent = !process.env.FLATNAS_NO_TRANSPARENT;

  widgetWin = new BrowserWindow({
    width: cfg.width,
    height: cfg.height,
    ...bounds,
    minWidth: 220,
    minHeight: 180,
    frame: false,
    transparent: allowTransparent,
    backgroundColor: allowTransparent ? '#00000000' : '#111827',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: cfg.skipTaskbar,
    alwaysOnTop: cfg.alwaysOnTop,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  widgetWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  widgetWin.once('ready-to-show', () => {
    applyWindowFlags();
    widgetWin.show();
    broadcast();
    if (process.env.FLATNAS_SMOKE_MS) void runSmokeTest();
  });
  widgetWin.on('resize', persistBounds);
  widgetWin.on('move', persistBounds);
  widgetWin.on('close', (e) => {
    persistBounds();
    if (!quitting) {
      e.preventDefault();
      widgetWin.hide();
    }
  });
  widgetWin.on('closed', () => {
    widgetWin = null;
  });
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 460,
    minHeight: 560,
    title: 'FlatNas 待办 · 设置',
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    broadcast();
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// ---------------------------------------------------------------- 托盘

function trayImage() {
  const file = path.join(ASSETS, 'tray.png');
  if (fs.existsSync(file)) return nativeImage.createFromPath(file);
  return nativeImage.createEmpty();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const cfg = configStore.get();
  const menu = Menu.buildFromTemplate([
    {
      label: widgetWin && widgetWin.isVisible() ? '隐藏小插件' : '显示小插件',
      click: () => toggleWidget(),
    },
    { type: 'separator' },
    {
      label: '立即同步',
      click: () => {
        void sync.syncOnce(true);
      },
    },
    {
      label: '置顶显示',
      type: 'checkbox',
      checked: cfg.alwaysOnTop,
      click: (item) => updateConfig({ alwaysOnTop: item.checked }),
    },
    {
      label: '在任务栏显示',
      type: 'checkbox',
      checked: !cfg.skipTaskbar,
      click: (item) => updateConfig({ skipTaskbar: !item.checked }),
    },
    {
      label: '鼠标穿透（Ctrl+Alt+L 切换）',
      type: 'checkbox',
      checked: cfg.clickThrough,
      click: (item) => updateConfig({ clickThrough: item.checked }),
    },
    { type: 'separator' },
    { label: '设置…', click: () => openSettingsWindow() },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: cfg.launchAtLogin,
      click: (item) => updateConfig({ launchAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: `同步状态：${statusLabel()}`, enabled: false },
    { label: '退出', click: () => quitApp() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`FlatNas 待办 · ${statusLabel()}`);
}

function statusLabel() {
  if (!client.isConfigured) return '未配置';
  const map = {
    idle: '已同步',
    syncing: '同步中',
    offline: '离线（改动已保留）',
    error: '出错',
    unconfigured: '未配置',
  };
  return map[sync ? sync.status : 'unconfigured'] || '未知';
}

function toggleWidget() {
  if (!widgetWin || widgetWin.isDestroyed()) {
    createWidgetWindow();
    return;
  }
  if (widgetWin.isVisible()) widgetWin.hide();
  else widgetWin.show();
  rebuildTrayMenu();
}

function createTray() {
  try {
    tray = new Tray(trayImage());
    tray.on('click', () => toggleWidget());
    tray.on('double-click', () => openSettingsWindow());
    rebuildTrayMenu();
  } catch (e) {
    // 某些 Linux 桌面环境没有系统托盘/StatusNotifier 宿主，创建会失败；
    // 此时小插件本身仍可正常使用，不能让主流程挂掉。
    tray = null;
    console.error('创建托盘失败（不影响主窗口）:', e && e.message);
  }
}

// ---------------------------------------------------------------- 配置变更

function updateConfig(patch) {
  configStore.save(patch);
  if (patch.intervalMs !== undefined) sync.setIntervalMs(configStore.get().intervalMs);
  if (patch.launchAtLogin !== undefined) {
    applyLaunchAtLogin(configStore.get().launchAtLogin);
  }
  if (patch.widgetId !== undefined && patch.widgetId !== '') {
    // 切换组件后重新拉取
    void sync.syncOnce(true);
  }
  applyWindowFlags();
  if (widgetWin && !widgetWin.isDestroyed()) {
    if (patch.width || patch.height) {
      const cfg = configStore.get();
      widgetWin.setSize(cfg.width, cfg.height);
    }
  }
  rebuildTrayMenu();
  broadcast();
  return publicConfig();
}

function applyLaunchAtLogin(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args: isDev ? [path.resolve(__dirname)] : [],
    });
  } catch (e) {
    console.error('设置开机自启失败', e);
  }
}

function quitApp() {
  quitting = true;
  try {
    persistBounds();
    sync.stop();
  } catch {
    /* ignore */
  }
  app.quit();
}

// ---------------------------------------------------------------- 同步装配

async function ensureLogin({ force = false } = {}) {
  const cfg = configStore.get();
  if (!cfg.baseUrl) throw new FlatNasError('未配置服务器地址', { kind: 'config' });
  client.setBaseUrl(cfg.baseUrl);
  if (!force && client.token) return true;
  if (!cfg.password) throw new FlatNasError('未配置密码', { kind: 'config' });
  await client.login(cfg.username, cfg.password);
  return true;
}

async function connectAndStart() {
  const cfg = configStore.get();
  if (!cfg.baseUrl || !cfg.widgetId) {
    sync.setStatus('unconfigured');
    return { ok: false, error: '请在设置里填写服务器地址并选择待办组件' };
  }
  try {
    await ensureLogin();
    await client.fetchVersion().catch(() => 0);
    sync.start();
    await sync.syncOnce(true);
    return { ok: true };
  } catch (e) {
    sync.setStatus(e.kind === 'auth' ? 'error' : 'offline', e.message);
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('state:get', () => currentState());

  ipcMain.handle('config:set', (_e, patch) => updateConfig(patch || {}));

  ipcMain.handle('config:get', () => configStore.get());

  ipcMain.handle('todos:add', (_e, text) => sync.add(text));

  ipcMain.handle('todos:toggle', (_e, { id, done }) => sync.toggle(id, done));

  ipcMain.handle('todos:remove', (_e, id) => sync.remove(id));

  ipcMain.handle('todos:updateText', (_e, { id, text }) => sync.updateText(id, text));

  ipcMain.handle('todos:clearDone', () => sync.clearDone());

  ipcMain.handle('sync:now', async () => {
    await sync.syncOnce(true);
    return { status: sync.status, error: sync.lastError };
  });

  ipcMain.handle('connection:test', async (_e, { baseUrl, username, password } = {}) => {
    const probe = new FlatNasClient({ baseUrl: baseUrl || client.baseUrl });
    try {
      await probe.login(username || configStore.get().username, password || '');
      const version = await probe.fetchVersion().catch(() => 0);
      const widgets = await probe.listWidgets();
      return {
        ok: true,
        version,
        todos: widgets.filter((w) => w.type === 'todo'),
        widgets,
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('connection:save', async (_e, patch) => {
    updateConfig(patch || {});
    client.token = '';
    return connectAndStart();
  });

  ipcMain.handle('window:openSettings', () => {
    openSettingsWindow();
    return true;
  });

  ipcMain.handle('window:hide', () => {
    if (widgetWin && !widgetWin.isDestroyed()) widgetWin.hide();
    rebuildTrayMenu();
    return true;
  });

  ipcMain.handle('window:close', () => {
    quitApp();
  });

  ipcMain.handle('window:minimize', () => {
    if (widgetWin && !widgetWin.isDestroyed()) widgetWin.minimize();
    return true;
  });

  ipcMain.handle('window:setClickThrough', (_e, value) => {
    updateConfig({ clickThrough: Boolean(value) });
    return configStore.get().clickThrough;
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(url);
    return true;
  });

  ipcMain.handle('dialog:pickWidget', async () => {
    const cfg = configStore.get();
    try {
      await ensureLogin();
      const widgets = await client.listWidgets();
      const todos = widgets.filter((w) => w.type === 'todo');
      return { ok: true, todos };
    } catch (e) {
      return { ok: false, error: e.message, baseUrl: cfg.baseUrl };
    }
  });
}

// ---------------------------------------------------------------- 冒烟自检

/**
 * 无头环境自检：设置 FLATNAS_SMOKE_MS=1 启动后，检查
 * 窗口 / preload 桥 / 渲染进程 DOM 是否都正常，然后退出。
 * 用于 CI 或本地快速验证（Linux 下配合 xvfb-run 使用）。
 */
async function runSmokeTest() {
  const out = (msg) => console.log(`[SMOKE] ${msg}`);
  try {
    out(`主进程启动 OK，窗口已创建: ${Boolean(widgetWin)}`);
    out(`托盘已创建: ${Boolean(tray)}`);
    const probe = await widgetWin.webContents.executeJavaScript(
      `({
         bridge: typeof window.flatnas === 'object' && typeof window.flatnas.add === 'function',
         card: Boolean(document.getElementById('card')),
         counter: document.getElementById('counter') && document.getElementById('counter').textContent,
         input: Boolean(document.getElementById('new-todo')),
         notifyHidden: document.getElementById('notify') && document.getElementById('notify').hidden,
       })`,
    );
    out(`渲染进程: ${JSON.stringify(probe)}`);
    if (!probe.bridge || !probe.card || !probe.input) {
      throw new Error('渲染进程未正确初始化（preload 桥或 DOM 缺失）');
    }
    out('SMOKE_OK');
  } catch (e) {
    out(`SMOKE_FAIL ${(e && e.message) || e}`);
    process.exitCode = 1;
  } finally {
    quitting = true;
    setTimeout(() => app.exit(process.exitCode || 0), 300);
  }
}

// ---------------------------------------------------------------- 启动

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (widgetWin) {
      widgetWin.show();
      widgetWin.focus();
    }
  });

  app.whenReady().then(() => {
    configStore = createConfigStore({
      filePath: path.join(app.getPath('userData'), 'config.json'),
      encrypt: encryptSecret,
      decrypt: decryptSecret,
    });
    configStore.load();

    client = new FlatNasClient({ baseUrl: configStore.get().baseUrl });
    sync = new TodoSync({
      client,
      getWidgetId: () => configStore.get().widgetId,
      intervalMs: configStore.get().intervalMs,
      onUpdate: (items, meta) => {
        lastState = { items, meta };
        broadcast();
      },
      onStatus: () => {
        rebuildTrayMenu();
        broadcast();
      },
    });
    sync.onAuthError = async () => {
      try {
        await ensureLogin({ force: true });
      } catch {
        /* 留给下次同步重试 */
      }
    };

    registerIpc();
    createWidgetWindow();
    createTray();
    applyLaunchAtLogin(configStore.get().launchAtLogin);

    globalShortcut.register('Control+Alt+L', () => {
      updateConfig({ clickThrough: !configStore.get().clickThrough });
      if (widgetWin && !widgetWin.isDestroyed()) widgetWin.show();
    });

    void connectAndStart();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWidgetWindow();
      else if (widgetWin) widgetWin.show();
    });
  });

  app.on('window-all-closed', (e) => {
    // 关闭窗口不退出，托盘常驻
    e.preventDefault?.();
  });

  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
  });
}

process.on('uncaughtException', (e) => {
  console.error('[FlatNas Desktop] uncaughtException:', e);
  try {
    dialog.showErrorBox('FlatNas 待办出错', String((e && e.stack) || e));
  } catch {
    /* ignore */
  }
});
