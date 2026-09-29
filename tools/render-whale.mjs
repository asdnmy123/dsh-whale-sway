/**
 * Zero-dependency rasterizer for the DSH "running whale tail" icon path.
 *
 * Purpose: the shipped icon is a 16x16 stroked SVG path baked into
 * `@deepseek-ai/dsh-client-ui-chat`, and its animated form is a base64 APNG used
 * as a CSS mask. Before re-animating it we need to *see* its anatomy (where the
 * fluke is, where it attaches) so we can pick a believable rotation pivot.
 *
 * The path contains only M and C commands, so it can be flattened into a
 * polyline and stroke-rendered by distance-to-segment tests. PNG is written by
 * hand with node:zlib (no image dependencies).
 *
 * Usage:
 *   node tools/render-whale.mjs                      # base render
 *   node tools/render-whale.mjs --pivot 12 13 --amp 18 --frames 5
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The shipped `REST_PATH` from RunningWhaleTail.js (16x16 viewBox, stroke 1). */
export const REST_PATH =
  'M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43' +
  'C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945' +
  'C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978' +
  'C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686' +
  'C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202' +
  'C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115' +
  'C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368' +
  'C5.157 11.27 5.089 12.19 4.926 13.742';

// ---------------------------------------------------------------------------
// path parsing + flattening
// ---------------------------------------------------------------------------

/** Parse an `M`/`C` only path into a list of cubic subpaths (each: points[]). */
export function parsePath(d) {
  const tokens = d.match(/[MCLZmlcz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const subpaths = [];
  let current = null;
  let cursor = [0, 0];
  let i = 0;
  let command = null;

  const num = () => Number(tokens[i++]);

  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[MCLZmlcz]$/.test(token)) {
      command = token.toUpperCase();
      i += 1;
      if (command === 'Z') {
        if (current !== null) current.push([...cursor]);
        continue;
      }
    }
    if (command === 'M') {
      const point = [num(), num()];
      cursor = point;
      current = [point];
      subpaths.push(current);
      command = 'L'; // implicit lineto for following coordinate pairs
      continue;
    }
    if (command === 'L') {
      const point = [num(), num()];
      current.push(point);
      cursor = point;
      continue;
    }
    if (command === 'C') {
      const c1 = [num(), num()];
      const c2 = [num(), num()];
      const end = [num(), num()];
      const steps = 24;
      for (let s = 1; s <= steps; s += 1) {
        const t = s / steps;
        const u = 1 - t;
        const x =
          u * u * u * cursor[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0];
        const y =
          u * u * u * cursor[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1];
        current.push([x, y]);
      }
      cursor = end;
      continue;
    }
    // Unknown token: skip it so a malformed tail cannot loop forever.
    i += 1;
  }
  return subpaths;
}

/** Flatten subpaths into a single list of [x1,y1,x2,y2] segments. */
export function segments(subpaths) {
  const out = [];
  for (const points of subpaths) {
    for (let i = 1; i < points.length; i += 1) {
      out.push([points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// raster
// ---------------------------------------------------------------------------

const BG = [246, 247, 250, 255];
const INK = [77, 107, 254, 255];
const PIVOT = [232, 62, 62, 255];

/**
 * Render the stroked path into an RGBA buffer.
 *
 * @param segs - segments in viewBox units.
 * @param opts - { size, scale, stroke, rotateDeg, pivot, mark }
 * @returns {Uint8Array} RGBA bytes.
 */
export function render(segs, opts) {
  const size = opts.size ?? 256;
  const viewBox = 16;
  const ss = 4; // supersample factor
  const inner = size * ss;
  // `pad` widens the mapped box by that many viewBox units on every side: a
  // rotated frame needs room the live CSS box gets from `overflow: visible`,
  // but a rasterized frame is simply clipped by its canvas.
  const pad = opts.pad ?? 0;
  const unit = inner / (viewBox + pad * 2);
  const half = ((opts.stroke ?? 1) / 2) * unit;

  const coverage = new Float32Array(inner * inner);
  const rotate = ((opts.rotateDeg ?? 0) * Math.PI) / 180;
  const pivot = opts.pivot ?? [8, 8];
  const cos = Math.cos(rotate);
  const sin = Math.sin(rotate);

  const map = (x, y) => {
    let px = x;
    let py = y;
    if (rotate !== 0) {
      const dx = x - pivot[0];
      const dy = y - pivot[1];
      px = pivot[0] + dx * cos - dy * sin;
      py = pivot[1] + dx * sin + dy * cos;
    }
    return [(px + pad) * unit, (py + pad) * unit];
  };

  for (const [x1, y1, x2, y2] of segs) {
    const [ax, ay] = map(x1, y1);
    const [bx, by] = map(x2, y2);
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1));
    const maxX = Math.min(inner - 1, Math.ceil(Math.max(ax, bx) + half + 1));
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - half - 1));
    const maxY = Math.min(inner - 1, Math.ceil(Math.max(ay, by) + half + 1));
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy || 1;

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        let t = ((px - ax) * vx + (py - ay) * vy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - (ax + t * vx);
        const dy = py - (ay + t * vy);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const cov = half + 0.5 - dist;
        if (cov <= 0) continue;
        const index = y * inner + x;
        if (cov > coverage[index]) coverage[index] = cov > 1 ? 1 : cov;
      }
    }
  }

  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          sum += coverage[(y * ss + sy) * inner + (x * ss + sx)];
        }
      }
      const alpha = sum / (ss * ss);
      const out = (y * size + x) * 4;
      rgba[out] = Math.round(BG[0] * (1 - alpha) + INK[0] * alpha);
      rgba[out + 1] = Math.round(BG[1] * (1 - alpha) + INK[1] * alpha);
      rgba[out + 2] = Math.round(BG[2] * (1 - alpha) + INK[2] * alpha);
      rgba[out + 3] = 255;
    }
  }

  if (opts.mark !== false) {
    const [px, py] = map(pivot[0], pivot[1]);
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = Math.round(px + dx);
        const y = Math.round(py + dy);
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        if (Math.abs(dx) > 1 && Math.abs(dy) > 1) continue;
        const out = (y * size + x) * 4;
        rgba[out] = PIVOT[0];
        rgba[out + 1] = PIVOT[1];
        rgba[out + 2] = PIVOT[2];
      }
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// PNG writer (8-bit RGBA, no dependencies)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** @returns {Buffer} a PNG for the given RGBA pixel rows. */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Tile several equal-size RGBA frames into one wide strip. */
export function strip(frames, size, gap = 8) {
  const width = frames.length * size + (frames.length - 1) * gap;
  const rgba = new Uint8Array(width * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      rgba[out] = 255;
      rgba[out + 1] = 255;
      rgba[out + 2] = 255;
      rgba[out + 3] = 255;
    }
  }
  frames.forEach((frame, index) => {
    const offsetX = index * (size + gap);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const src = (y * size + x) * 4;
        const dst = (y * width + offsetX + x) * 4;
        rgba[dst] = frame[src];
        rgba[dst + 1] = frame[src + 1];
        rgba[dst + 2] = frame[src + 2];
        rgba[dst + 3] = frame[src + 3];
      }
    }
  });
  return { width, rgba };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const values = [];
  for (let i = index + 1; i < process.argv.length && !process.argv[i].startsWith('--'); i += 1) {
    values.push(Number(process.argv[i]));
  }
  return values.length === 0 ? fallback : values.length === 1 ? values[0] : values;
}

/** Read a raw string option (`--name value`). */
function strArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || process.argv[index + 1] === undefined) return fallback;
  return process.argv[index + 1];
}

function save(path, width, height, rgba) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, encodePng(width, height, rgba));
  console.log(`wrote ${target} (${width}x${height})`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const subpaths = parsePath(REST_PATH);
  const segs = segments(subpaths);
  const xs = subpaths.flat().map((p) => p[0]);
  const ys = subpaths.flat().map((p) => p[1]);
  console.log(
    `points=${subpaths.flat().length} segments=${segs.length} ` +
      `bbox=[${Math.min(...xs).toFixed(2)},${Math.min(...ys).toFixed(2)}]..[${Math.max(...xs).toFixed(2)},${Math.max(...ys).toFixed(2)}]`,
  );

  const size = 256;
  const pivot = arg('pivot', [8, 8]);
  const amp = arg('amp', 0);
  const frames = arg('frames', 1);

  if (frames <= 1) {
    save(process.argv.includes('--out') ? strArg('out', 'preview/whale-base.png') : 'preview/whale-base.png',
      size, size, render(segs, { size, pivot, mark: true }));
  } else {
    const rendered = [];
    for (let i = 0; i < frames; i += 1) {
      const t = frames === 1 ? 0 : i / (frames - 1);
      const deg = -amp + 2 * amp * t;
      rendered.push(render(segs, { size, pivot, rotateDeg: deg, mark: i === (frames - 1) / 2 }));
    }
    const { width, rgba } = strip(rendered, size);
    save(strArg('out', 'preview/whale-sway.png'), width, size, rgba);
  }
}
