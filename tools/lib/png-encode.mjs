/**
 * png-encode.mjs — a minimal, dependency-free PNG writer (8-bit RGBA).
 *
 * Only what the sprite-sheet pipeline needs: colour type 6 (truecolour with
 * alpha), bit depth 8, no interlace. `node:zlib` supplies DEFLATE; everything
 * else here (CRC-32, chunk framing, scanline filtering) is written out so the
 * output is a plain function of its input bytes.
 *
 * Determinism is a hard requirement — two runs of `build-frames.mjs` must produce
 * byte-identical files — so the encoder:
 *   - writes no tIME/text/ancillary chunks that could carry a clock,
 *   - picks its per-row filter with a fixed, tie-broken-to-the-lowest-index
 *     heuristic (minimum sum of absolute signed byte values, the classic PNG
 *     "minimum sum of absolute differences" rule),
 *   - deflates at a fixed level.
 *
 * Usage:
 *   import { encodePng } from './lib/png-encode.mjs';
 *   writeFileSync('x.png', encodePng(width, height, rgbaBytes));
 */

import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG filter types, in the order the encoder tries them. */
const FILTERS = [0, 1, 2, 3, 4];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32 (IEEE 802.3), as PNG's chunk checksum defines it.
 *
 * @param {Uint8Array} bytes
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** The Paeth predictor from the PNG spec. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Apply one PNG scanline filter.
 *
 * @param {number} type - 0 none, 1 sub, 2 up, 3 average, 4 paeth.
 * @param {Uint8Array} row - the unfiltered scanline.
 * @param {Uint8Array|null} prev - the previous unfiltered scanline, or null.
 * @param {Uint8Array} out - receives the filtered bytes.
 * @param {number} bpp - bytes per pixel (4 for RGBA8).
 */
function applyFilter(type, row, prev, out, bpp) {
  for (let i = 0; i < row.length; i += 1) {
    const raw = row[i];
    const left = i >= bpp ? row[i - bpp] : 0;
    const up = prev === null ? 0 : prev[i];
    const upLeft = prev === null || i < bpp ? 0 : prev[i - bpp];
    let value;
    switch (type) {
      case 0:
        value = raw;
        break;
      case 1:
        value = raw - left;
        break;
      case 2:
        value = raw - up;
        break;
      case 3:
        value = raw - ((left + up) >> 1);
        break;
      default:
        value = raw - paeth(left, up, upLeft);
        break;
    }
    out[i] = value & 0xff;
  }
}

/** Minimum sum of absolute differences: how PNG ranks competing filters. */
function filterCost(bytes) {
  let cost = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const v = bytes[i];
    cost += v < 128 ? v : 256 - v;
  }
  return cost;
}

/** Frame one PNG chunk: length, type, data, CRC. */
function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'latin1');
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), 0);
  return Buffer.concat([length, typeBytes, body, crc]);
}

/**
 * Encode 8-bit RGBA pixels as a PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Uint8ClampedArray} rgba - width*height*4 bytes.
 * @param {{ level?: number }} [options] - DEFLATE level, default 9.
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba, options = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`png-encode: bad geometry ${width}x${height}`);
  }
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`png-encode: expected ${expected} RGBA bytes, got ${rgba.length}`);
  }
  const level = options.level === undefined ? 9 : options.level;

  const stride = width * 4;
  const bpp = 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const start = y * stride;
    const row = rgba.subarray(start, start + stride);
    const prev = y === 0 ? null : rgba.subarray(start - stride, start);
    let bestType = 0;
    let bestCost = Infinity;
    for (const type of FILTERS) {
      applyFilter(type, row, prev, candidate, bpp);
      const cost = filterCost(candidate);
      // Strictly less-than keeps the lowest filter index on a tie.
      if (cost < bestCost) {
        bestCost = cost;
        bestType = type;
        best.set(candidate);
      }
    }
    raw[y * (stride + 1)] = bestType;
    best.copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const idat = deflateSync(raw, { level });

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export default encodePng;
