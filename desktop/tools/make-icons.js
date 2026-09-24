#!/usr/bin/env node
'use strict';

/**
 * 生成应用图标与托盘图标（不依赖任何三方库，直接手写 PNG）。
 *   node tools/make-icons.js
 * 输出：assets/icon.png (256x256)、assets/tray.png (32x32)
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BG = [37, 99, 235]; // #2563eb FlatNas 蓝
const FG = [255, 255, 255];

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 绘制

/** 点到线段的距离 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 圆角矩形内部判定 */
function insideRoundedRect(x, y, size, radius) {
  const r = radius;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return Math.hypot(x - cx, y - cy) <= r + 0.0001 || (x >= r && x <= size - r) || (y >= r && y <= size - r);
}

function makeIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const stroke = size * 0.075;

  // 对勾的两段，按比例换算
  const p1 = [size * 0.28, size * 0.52];
  const p2 = [size * 0.44, size * 0.68];
  const p3 = [size * 0.73, size * 0.34];

  const SS = 3; // 3x3 超采样做抗锯齿
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!insideRoundedRect(px, py, size, radius)) continue;
          bgHits++;
          const d = Math.min(
            distToSegment(px, py, p1[0], p1[1], p2[0], p2[1]),
            distToSegment(px, py, p2[0], p2[1], p3[0], p3[1]),
          );
          if (d <= stroke / 2) fgHits++;
        }
      }
      const total = SS * SS;
      if (bgHits === 0) continue;
      const alpha = Math.round((bgHits / total) * 255);
      const fgRatio = fgHits / bgHits;
      const color = [0, 1, 2].map((i) => Math.round(BG[i] * (1 - fgRatio) + FG[i] * fgRatio));
      const off = (y * size + x) * 4;
      rgba[off] = color[0];
      rgba[off + 1] = color[1];
      rgba[off + 2] = color[2];
      rgba[off + 3] = alpha;
    }
  }
  return encodePNG(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size] of [['icon.png', 256], ['tray.png', 32]]) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, makeIcon(size));
  console.log(`${name}  ${size}x${size}  ${fs.statSync(file).size} bytes`);
}
