'use strict';

/**
 * 生成应用图标（无第三方依赖）：用有向距离场绘制扁平风格的圆角方块 + 终端提示符图形，
 * 输出 PNG（应用 / 托盘 / macOS 模板图标）与 Windows ICO。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'src', 'assets');
const BUILD = path.join(ROOT, 'build');

/** CRC32 查表。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * 计算 CRC32。
 * @param {Buffer} buf 数据
 * @returns {number} CRC
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 编码 RGBA 像素为 PNG。
 * @param {number} w 宽
 * @param {number} h 高
 * @param {Buffer} rgba 像素
 * @returns {Buffer} PNG 数据
 */
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 圆角矩形 SDF（中心在原点，半宽 b，圆角 r）。 */
function sdRoundRect(px, py, b, r) {
  const qx = Math.abs(px) - b + r;
  const qy = Math.abs(py) - b + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 线段 SDF（带半径 r 的胶囊）。 */
function sdSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

/**
 * 渲染图标。
 * @param {number} size 尺寸
 * @param {'app'|'template'} mode 彩色应用图标 / macOS 单色模板图标
 * @returns {Buffer} PNG
 */
function render(size, mode) {
  const px = Buffer.alloc(size * size * 4);
  const aa = 1.2 / size;
  const glyph = (u, v) => {
    const w = 0.068;
    return Math.min(
      sdSegment(u, v, 0.29, 0.34, 0.47, 0.5, w),
      sdSegment(u, v, 0.47, 0.5, 0.29, 0.66, w),
      sdSegment(u, v, 0.55, 0.66, 0.73, 0.66, w),
    );
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const i = (y * size + x) * 4;
      const g = glyph(u, v);
      const ga = Math.max(0, Math.min(1, 0.5 - g / aa));
      if (mode === 'template') {
        px[i + 3] = Math.round(ga * 255);
        continue;
      }
      const bg = sdRoundRect(u - 0.5, v - 0.5, 0.46, 0.14);
      const ba = Math.max(0, Math.min(1, 0.5 - bg / aa));
      // 背景：自上而下的蓝色渐变；右上角一枚绿色状态点
      const top = [91, 120, 255];
      const bot = [60, 88, 238];
      let r = top[0] + (bot[0] - top[0]) * v;
      let gg = top[1] + (bot[1] - top[1]) * v;
      let b = top[2] + (bot[2] - top[2]) * v;
      const dot = Math.hypot(u - 0.75, v - 0.27) - 0.06;
      const da = Math.max(0, Math.min(1, 0.5 - dot / aa));
      r += (16 - r) * da;
      gg += (185 - gg) * da;
      b += (129 - b) * da;
      r += (255 - r) * ga;
      gg += (255 - gg) * ga;
      b += (255 - b) * ga;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(gg);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(ba * 255);
    }
  }
  return encodePng(size, size, px);
}

/**
 * 以 PNG 条目组装 ICO（Vista 及以上支持）。
 * @param {Array<[number, Buffer]>} images [尺寸, PNG]
 * @returns {Buffer} ICO
 */
function buildIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(([size, png], k) => {
    const e = 6 + k * 16;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(([, p]) => p)]);
}

fs.mkdirSync(ASSETS, { recursive: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.writeFileSync(path.join(ASSETS, 'icon.png'), render(256, 'app'));
fs.writeFileSync(path.join(ASSETS, 'tray.png'), render(16, 'app'));
fs.writeFileSync(path.join(ASSETS, 'tray@2x.png'), render(32, 'app'));
fs.writeFileSync(path.join(ASSETS, 'trayTemplate.png'), render(16, 'template'));
fs.writeFileSync(path.join(ASSETS, 'trayTemplate@2x.png'), render(32, 'template'));
fs.writeFileSync(path.join(BUILD, 'icon.png'), render(1024, 'app'));
fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco([16, 24, 32, 48, 64, 128, 256].map((s) => [s, render(s, 'app')])));
console.log('图标已生成：src/assets/*.png、build/icon.png、build/icon.ico');
