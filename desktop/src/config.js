'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  // 连接
  baseUrl: '',
  username: 'admin',
  password: '',
  widgetId: '',
  intervalMs: 10000,
  // 窗口外观
  alwaysOnTop: true,
  skipTaskbar: true,
  clickThrough: false,
  opacity: 0.85,
  cardColor: '#111827',
  textColor: '#f9fafb',
  accentColor: '#3b82f6',
  fontSize: 14,
  width: 320,
  height: 440,
  x: null,
  y: null,
  // 行为
  launchAtLogin: false,
  showDone: true,
  confirmDelete: false,
};

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitize(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  cfg.baseUrl = String(cfg.baseUrl || '').trim();
  cfg.username = String(cfg.username || 'admin');
  cfg.password = String(cfg.password || '');
  cfg.widgetId = String(cfg.widgetId || '');
  cfg.intervalMs = clampNumber(cfg.intervalMs, 3000, 3600000, DEFAULTS.intervalMs);
  cfg.opacity = clampNumber(cfg.opacity, 0.15, 1, DEFAULTS.opacity);
  cfg.fontSize = clampNumber(cfg.fontSize, 10, 28, DEFAULTS.fontSize);
  cfg.width = clampNumber(cfg.width, 220, 1200, DEFAULTS.width);
  cfg.height = clampNumber(cfg.height, 200, 1600, DEFAULTS.height);
  for (const key of ['alwaysOnTop', 'skipTaskbar', 'clickThrough', 'launchAtLogin', 'showDone', 'confirmDelete']) {
    cfg[key] = Boolean(cfg[key]);
  }
  for (const key of ['x', 'y']) {
    const n = Number(cfg[key]);
    cfg[key] = Number.isFinite(n) ? Math.round(n) : null;
  }
  cfg.cardColor = String(cfg.cardColor || DEFAULTS.cardColor);
  cfg.textColor = String(cfg.textColor || DEFAULTS.textColor);
  cfg.accentColor = String(cfg.accentColor || DEFAULTS.accentColor);
  return cfg;
}

/**
 * 配置读写。密码的加解密由调用方注入（Electron 下用 safeStorage），
 * 这样这个模块在纯 Node 里也能测。
 */
function createConfigStore({ filePath, encrypt = (v) => v, decrypt = (v) => v } = {}) {
  let config = sanitize(null);

  const load = () => {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const storedPassword = parsed && parsed.passwordEnc ? decrypt(parsed.passwordEnc) : parsed.password;
      config = sanitize({ ...parsed, password: storedPassword || '' });
    } catch {
      config = sanitize(null);
    }
    return config;
  };

  const save = (patch) => {
    if (patch) config = sanitize({ ...config, ...patch });
    const { password, ...rest } = config;
    const payload = { ...rest, passwordEnc: password ? encrypt(password) : '' };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
    return config;
  };

  const get = () => ({ ...config });
  const set = (patch) => save(patch);

  return { load, save, get, set, DEFAULTS };
}

module.exports = { createConfigStore, sanitize, DEFAULTS };
