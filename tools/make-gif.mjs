/**
 * Animated GIF previews for the README — rasterized from the REAL frame sheet.
 *
 * Every pixel of `preview/sway-fast.gif` and `preview/sway-slow.gif` comes from
 * `preview/frames-sheet.png`: the sprite sheet the runtime's CSS mask steps
 * through. Nothing here re-derives geometry — there is no SVG rasterizer, no
 * rotation, no shape maths, no per-frame pose synthesis. The sheet's square
 * cells (one per material frame) are composited over a light background with
 * their own alpha channel, upscaled by an integer factor (nearest neighbour, so
 * each sheet pixel becomes an exact block and nothing is interpolated), mapped
 * onto a 32-step ramp and encoded as a looping GIF89a by the hand-written LZW
 * encoder below.
 *
 * Tempo comes from the runtime's own mapping: one full cycle is
 * `periodForRate(rate)` ms (imported from the real `client.js`, never mirrored),
 * sampled once per sheet frame. The per-frame delay is quantized to GIF's 10 ms
 * grid and floored at 20 ms, because browsers clamp 0-1 cs delays to 100 ms —
 * 20 ms is the shortest delay that actually plays as written.
 *
 * Self-check: after encoding, the byte stream is re-parsed and every frame is
 * decoded with the reference decoder, which implements the same code-width rule
 * real decoders use. The round trip must be PIXEL-EXACT, and frame count, frame
 * geometry, per-frame delays, distinctness and the NETSCAPE2.0 loop block are
 * all asserted. The file already on disk is re-read so a second run can prove it
 * regenerates byte-identically.
 *
 * Usage:
 *   node tools/make-gif.mjs                                        # the README previews
 *   node tools/make-gif.mjs --meta M.json --sheet S.png --out DIR  # test hooks
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { MODES } from './modes.mjs';

/** Repository root (this file lives in `<root>/tools/`). */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The real client half; the sole source of truth for the period mapping. */
export const CLIENT_PATH = join(ROOT, 'client.js');
/** The default mode's sheet, and the metadata that describes it. */
export const SHEET_PATH = join(ROOT, 'preview', 'sway-sheet.png');
export const META_PATH = join(ROOT, 'tools', 'generated', 'sway.json');

/** Light surface the README previews sit on. */
export const BG = [246, 247, 250];
/** Levels in the single straight ramp from `BG` to the sheet's ink colour. */
export const LEVELS = 32;
/** bits per pixel: log2(LEVELS). */
export const MIN_CODE_SIZE = 5;

// ---------------------------------------------------------------------------
// PNG decoder — zero dependency, deliberately narrow and loud about it
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Channels per pixel for the colour types this decoder accepts. */
const CHANNELS = { 0: 1, 2: 3, 6: 4 };

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE !== null) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}

function crc32(buffer) {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = table[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a PNG into straight 8-bit RGBA.
 *
 * Supported (and asserted, so an unexpected file fails loudly instead of
 * silently producing garbage): bit depth 8; colour types 0 (greyscale),
 * 2 (truecolour) and 6 (truecolour + alpha); no interlacing; all five
 * scanline filters; multiple IDAT chunks; every chunk CRC verified. Palette
 * (type 3), 16-bit, and interlaced files are rejected by name.
 *
 * @param {Buffer} buffer - the complete PNG file.
 * @returns {{width:number,height:number,bitDepth:number,colorType:number,channels:number,rgba:Uint8Array}}
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('PNG: bad signature');
  }
  let offset = 8;
  let header = null;
  let sawEnd = false;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataEnd = offset + 8 + length;
    if (dataEnd + 4 > buffer.length) throw new Error(`PNG: truncated ${type} chunk`);
    const data = buffer.subarray(offset + 8, dataEnd);
    const expected = buffer.readUInt32BE(dataEnd);
    const actual = crc32(buffer.subarray(offset + 4, dataEnd));
    if (expected !== actual) {
      throw new Error(`PNG: ${type} chunk CRC ${actual.toString(16)} != ${expected.toString(16)}`);
    }
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      sawEnd = true;
      offset = dataEnd + 4;
      break;
    }
    offset = dataEnd + 4;
  }
  if (header === null) throw new Error('PNG: no IHDR chunk');
  if (!sawEnd) throw new Error('PNG: no IEND chunk');
  if (idat.length === 0) throw new Error('PNG: no IDAT data');
  if (header.bitDepth !== 8) throw new Error(`PNG: bit depth ${header.bitDepth} is not supported (8 only)`);
  const channels = CHANNELS[header.colorType];
  if (channels === undefined) {
    throw new Error(`PNG: colour type ${header.colorType} is not supported (0, 2 and 6 only)`);
  }
  if (header.interlace !== 0) throw new Error('PNG: interlaced images are not supported');
  if (header.compression !== 0 || header.filter !== 0) {
    throw new Error('PNG: unknown compression/filter method');
  }

  const { width, height } = header;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) {
    throw new Error(`PNG: inflated ${raw.length} bytes, expected ${(stride + 1) * height}`);
  }
  const image = Buffer.alloc(stride * height);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const row = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const out = image.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? image.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev === null ? 0 : prev[x];
      const c = prev !== null && x >= channels ? prev[x - channels] : 0;
      const v = row[x];
      let value;
      if (filter === 0) value = v;
      else if (filter === 1) value = v + a;
      else if (filter === 2) value = v + b;
      else if (filter === 3) value = v + ((a + b) >> 1);
      else if (filter === 4) value = v + paeth(a, b, c);
      else throw new Error(`PNG: unknown filter ${filter} on row ${y}`);
      out[x] = value & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const src = i * channels;
    const dst = i * 4;
    if (channels === 1) {
      rgba[dst] = image[src];
      rgba[dst + 1] = image[src];
      rgba[dst + 2] = image[src];
      rgba[dst + 3] = 255;
    } else if (channels === 3) {
      rgba[dst] = image[src];
      rgba[dst + 1] = image[src + 1];
      rgba[dst + 2] = image[src + 2];
      rgba[dst + 3] = 255;
    } else {
      rgba[dst] = image[src];
      rgba[dst + 1] = image[src + 1];
      rgba[dst + 2] = image[src + 2];
      rgba[dst + 3] = image[src + 3];
    }
  }
  return {
    width,
    height,
    bitDepth: header.bitDepth,
    colorType: header.colorType,
    channels,
    rgba,
  };
}

// ---------------------------------------------------------------------------
// the sprite sheet
// ---------------------------------------------------------------------------

/** Luminance of a colour, the same weights the material's alpha model uses. */
function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Cut a decoded sheet into square alpha cells.
 *
 * The sheet is the runtime's mask, so only the alpha channel carries meaning;
 * the RGB channels are read once, to identify the ink colour the previews
 * composite with. The ink is the most common fully opaque RGB in the sheet, and
 * a light "ink" is refused rather than silently producing an invisible preview.
 *
 * @param {object} png - the result of {@link decodePng}.
 * @param {number} cell - expected cell edge in pixels.
 * @param {number} count - expected number of cells.
 * @returns {{cell:number,count:number,width:number,height:number,alpha:Uint8Array[],ink:number[]}}
 */
export function loadSheetCells(png, cell, count) {
  if (png.width !== cell) {
    throw new Error(`sheet: width ${png.width} is not one cell (${cell})`);
  }
  if (png.height !== cell * count) {
    throw new Error(`sheet: height ${png.height} is not count*cell (${count}*${cell})`);
  }
  const histogram = new Map();
  const alpha = [];
  for (let index = 0; index < count; index += 1) {
    const plane = new Uint8Array(cell * cell);
    for (let y = 0; y < cell; y += 1) {
      const row = (index * cell + y) * png.width;
      for (let x = 0; x < cell; x += 1) {
        const p = (row + x) * 4;
        const a = png.rgba[p + 3];
        plane[y * cell + x] = a;
        if (a === 255) {
          const key = (png.rgba[p] << 16) | (png.rgba[p + 1] << 8) | png.rgba[p + 2];
          histogram.set(key, (histogram.get(key) ?? 0) + 1);
        }
      }
    }
    alpha.push(plane);
  }
  if (histogram.size === 0) {
    throw new Error('sheet: no fully opaque pixel, so the ink colour cannot be identified');
  }
  let bestKey = -1;
  let bestCount = -1;
  for (const [key, hits] of histogram) {
    if (hits > bestCount || (hits === bestCount && key < bestKey)) {
      bestKey = key;
      bestCount = hits;
    }
  }
  const ink = [(bestKey >> 16) & 0xff, (bestKey >> 8) & 0xff, bestKey & 0xff];
  const lum = luminance(ink[0], ink[1], ink[2]);
  if (lum >= 200) {
    throw new Error(
      `sheet: the opaque ink rgb(${ink.join(',')}) has luminance ${lum.toFixed(1)} — ` +
        'that is not the material ink, so the sheet is not the frame sheet',
    );
  }
  return { cell, count, width: png.width, height: png.height, alpha, ink };
}

/**
 * Alpha-weighted ink centroid x of one horizontal band of a cell.
 *
 * @param {Uint8Array} plane - one cell's alpha plane.
 * @param {number} cell - cell edge in pixels.
 * @param {number} y0f - band start as a fraction of the cell height.
 * @param {number} y1f - band end as a fraction of the cell height.
 * @returns {number|null} centroid in cell pixels, or null when the band is empty.
 */
export function bandCentroidX(plane, cell, y0f, y1f) {
  const y0 = Math.max(0, Math.floor(y0f * cell));
  const y1 = Math.min(cell - 1, Math.ceil(y1f * cell) - 1);
  let weighted = 0;
  let total = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = 0; x < cell; x += 1) {
      const a = plane[y * cell + x] / 255;
      if (a <= 0.05) continue;
      weighted += a * x;
      total += a;
    }
  }
  return total === 0 ? null : weighted / total;
}

/**
 * Measure the sheet's own motion: the fluke band's per-frame centroid, the leg
 * band's drift, and which frame is the widest swing (used to freeze the engine
 * screenshots at peak).
 *
 * @param {object} sheet - the result of {@link loadSheetCells}.
 * @returns {{flukeCellX:number[],legCellX:number[],flukeDisplayX:number[],
 *   travelDisplayPx:number,peakIndex:number,peakTravelDisplayPx:number,legDriftDisplayPx:number}}
 */
export function sheetMotion(sheet) {
  const { cell, count, alpha } = sheet;
  const flukeCellX = [];
  const legCellX = [];
  const flukeDisplayX = [];
  for (let i = 0; i < count; i += 1) {
    flukeCellX.push(bandCentroidX(alpha[i], cell, 0.06, 0.55));
    legCellX.push(bandCentroidX(alpha[i], cell, 0.6, 0.85));
  }
  // The cell is displayed in a 16x16 box (14px slot, inset -1px on each side).
  const toDisplay = (value) => (value === null ? null : (value * 16) / cell);
  for (let i = 0; i < count; i += 1) flukeDisplayX.push(toDisplay(flukeCellX[i]));
  const base = flukeDisplayX[0] ?? 0;
  let min = Infinity;
  let max = -Infinity;
  let peakIndex = 0;
  let peakTravel = -1;
  for (let i = 0; i < count; i += 1) {
    const value = flukeDisplayX[i];
    if (value === null) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
    const travel = Math.abs(value - base);
    if (travel > peakTravel) {
      peakTravel = travel;
      peakIndex = i;
    }
  }
  const legBase = toDisplay(legCellX[0]) ?? 0;
  let legDrift = 0;
  for (let i = 0; i < count; i += 1) {
    const value = toDisplay(legCellX[i]);
    if (value !== null) legDrift = Math.max(legDrift, Math.abs(value - legBase));
  }
  return {
    flukeCellX,
    legCellX,
    flukeDisplayX,
    travelDisplayPx: Number.isFinite(min) ? max - min : 0,
    peakIndex,
    peakTravelDisplayPx: Math.max(0, peakTravel),
    legDriftDisplayPx: legDrift,
  };
}

// ---------------------------------------------------------------------------
// the runtime's period mapping, imported from the real client half
// ---------------------------------------------------------------------------

/**
 * Import the real `client.js` and return the manifest it exposes.
 *
 * The period mapping is never mirrored here: the previews are timed with the
 * exact function the runtime runs. `client.js` is a classic script, so it is
 * loaded for its side effect on `globalThis.__dshIconApi`.
 *
 * @returns {Promise<object>} the client manifest.
 */
export async function loadClientEngine() {
  const namespace = await import(pathToFileURL(CLIENT_PATH).href);
  const manifest =
    typeof globalThis.__dshIconApi === 'object' && globalThis.__dshIconApi !== null
      ? globalThis.__dshIconApi
      : (namespace.default ?? namespace);
  if (typeof manifest.periodForRate !== 'function') {
    throw new Error(
      `${CLIENT_PATH} does not export periodForRate — the frame-stepping engine is not in place`,
    );
  }
  return manifest;
}

/**
 * Read and cross-check `tools/generated/frames.json` against the sheet bytes.
 *
 * @param {string} metaPath - the metadata path.
 * @param {string|null} sheetOverride - optional sheet path override.
 * @returns {{meta:object,bytes:Buffer,sha:string,sheetPath:string}}
 */
export function readFramesMeta(metaPath, sheetOverride = null) {
  if (!existsSync(metaPath)) {
    throw new Error(
      `missing ${metaPath} — task-2 (tools/build-frames.mjs) has not produced the frame sheet yet`,
    );
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  for (const key of ['count', 'cell', 'sheet', 'sheetSha256']) {
    if (meta[key] === undefined) throw new Error(`frames.json: missing "${key}"`);
  }
  const sheetPath = sheetOverride ?? resolve(ROOT, meta.sheet);
  if (!existsSync(sheetPath)) throw new Error(`missing sheet ${sheetPath}`);
  const bytes = readFileSync(sheetPath);
  const sha = createHash('sha256').update(bytes).digest('hex');
  // The hash cross-check binds the metadata to the sheet on disk. `--sheet` is a
  // test hook that deliberately aims the encoder at other bytes, so it skips the
  // check instead of pretending the override is the delivered sheet.
  if (sheetOverride === null) {
    if (sha !== meta.sheetSha256) {
      throw new Error(`frames.json: sheetSha256 says ${meta.sheetSha256}, ${sheetPath} hashes to ${sha}`);
    }
    if (typeof meta.pngBase64 === 'string') {
      const inlined = Buffer.from(meta.pngBase64, 'base64');
      if (!inlined.equals(bytes)) {
        throw new Error('frames.json: pngBase64 does not decode to the sheet bytes');
      }
    }
  }
  return { meta, bytes, sha, sheetPath };
}

// ---------------------------------------------------------------------------
// palette + compositing
// ---------------------------------------------------------------------------

/** One straight ramp from the surface colour to the sheet's ink colour. */
export function paletteFor(ink) {
  return Array.from({ length: LEVELS }, (_, level) => {
    const t = level / (LEVELS - 1);
    return [
      Math.round(BG[0] + (ink[0] - BG[0]) * t),
      Math.round(BG[1] + (ink[1] - BG[1]) * t),
      Math.round(BG[2] + (ink[2] - BG[2]) * t),
    ];
  });
}

/** Integer upscale that lands a cell near 128 px without ever shrinking it. */
export function scaleForCell(cell) {
  let scale = Math.max(1, Math.round(128 / cell));
  while (cell * scale > 160 && scale > 1) scale -= 1;
  return scale;
}

/**
 * Composite every cell over `BG` with its own alpha and quantize the result.
 *
 * The composited colour lies exactly on the `BG -> ink` segment, so the nearest
 * entry of the 32-step ramp is the closed form `round(alpha * (LEVELS-1))`;
 * the palette entry itself is what the GIF renders, which is the composited
 * colour rounded to the nearest ramp level.
 *
 * @param {object} sheet - the result of {@link loadSheetCells}.
 * @param {number} scale - integer upscale factor.
 * @returns {{size:number,palette:number[][],frames:Uint8Array[]}}
 */
export function compositeFrames(sheet, scale) {
  const size = sheet.cell * scale;
  const palette = paletteFor(sheet.ink);
  const frames = [];
  for (const plane of sheet.alpha) {
    const indices = new Uint8Array(size * size);
    for (let y = 0; y < size; y += 1) {
      const sy = Math.floor(y / scale);
      for (let x = 0; x < size; x += 1) {
        const a = plane[sy * sheet.cell + Math.floor(x / scale)] / 255;
        const level = Math.round(a * (LEVELS - 1));
        indices[y * size + x] = level < 0 ? 0 : level > LEVELS - 1 ? LEVELS - 1 : level;
      }
    }
    frames.push(indices);
  }
  return { size, palette, frames };
}

// ---------------------------------------------------------------------------
// GIF89a writer
// ---------------------------------------------------------------------------

/**
 * The GIF flavour of LZW: a clear code and an end code above the pixel codes,
 * a code width that grows with the dictionary, and a full-dictionary reset.
 *
 * @param {Uint8Array} pixels - palette indices, row-major.
 * @param {number} minCodeSize - bits per pixel (5 for the 32-entry ramp).
 * @returns {number[]} the raw LZW byte stream, before sub-block framing.
 */
export function lzwCompress(pixels, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dict = new Map();

  function emit(code) {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  }

  emit(clearCode);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i += 1) {
    const suffix = pixels[i];
    const key = (prefix << 8) | suffix;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (nextCode < 4096) {
      dict.set(key, nextCode);
      nextCode += 1;
      // Code-width growth is where GIF LZW encoders go wrong. A decoder grows
      // its width once its OWN next free code reaches `1 << codeSize`; the
      // encoder's table runs exactly one entry ahead of the decoder's, so the
      // matching trigger here is one higher: `> (1 << codeSize)`. Writing
      // `(1 << codeSize) - 1` shifts every later code by one bit, and the whole
      // raster decodes as noise.
      if (nextCode > 1 << codeSize) {
        if (codeSize < 12) {
          codeSize += 1;
        } else {
          emit(clearCode);
          dict = new Map();
          nextCode = endCode + 1;
          codeSize = minCodeSize + 1;
        }
      }
    } else {
      emit(clearCode);
      dict = new Map();
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = suffix;
  }
  emit(prefix);
  emit(endCode);
  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return out;
}

/** Frame a byte stream into GIF sub-blocks, length-prefixed and 0-terminated. */
export function subBlocks(out, data) {
  for (let offset = 0; offset < data.length; offset += 255) {
    const length = Math.min(255, data.length - offset);
    out.push(length);
    for (let i = 0; i < length; i += 1) out.push(data[offset + i]);
  }
  out.push(0);
}

/**
 * Assemble a looping GIF89a animation.
 *
 * @param {number} width - frame width in pixels.
 * @param {number} height - frame height in pixels.
 * @param {number[][]} palette - the global colour table (<= 256 entries).
 * @param {Uint8Array[]} frames - palette-index frames.
 * @param {number} delayCs - per-frame delay in centiseconds.
 * @returns {Buffer} the encoded file.
 */
export function buildGif(width, height, palette, frames, delayCs) {
  const minCodeSize = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))));
  const out = [];
  const short = (value) => out.push(value & 0xff, (value >> 8) & 0xff);
  const text = (value) => {
    for (const character of value) out.push(character.charCodeAt(0));
  };

  text('GIF89a');
  short(width);
  short(height);
  // Global colour table, 8-bit colour resolution, 2^(bits+1) entries.
  const tableBits = Math.ceil(Math.log2(Math.max(2, palette.length))) - 1;
  out.push(0x80 | (0x07 << 4) | tableBits, 0x00, 0x00);
  for (let i = 0; i < 1 << (tableBits + 1); i += 1) {
    const colour = palette[i] ?? [0, 0, 0];
    out.push(colour[0], colour[1], colour[2]);
  }

  // Netscape looping extension: 0 = forever.
  out.push(0x21, 0xff, 0x0b);
  text('NETSCAPE2.0');
  out.push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const pixels of frames) {
    // Graphic control: disposal "do not dispose", delay, no transparency.
    out.push(0x21, 0xf9, 0x04, 0x04);
    short(delayCs);
    out.push(0x00, 0x00);
    // Image descriptor: full frame, no local table, not interlaced.
    out.push(0x2c);
    short(0);
    short(0);
    short(width);
    short(height);
    out.push(0x00);
    out.push(minCodeSize);
    subBlocks(out, lzwCompress(pixels, minCodeSize));
  }
  out.push(0x3b);
  return Buffer.from(out);
}

/**
 * Walk the encoded bytes back and collect the structure of the file.
 *
 * A GIF's block structure is self-describing, so the encoder can be checked
 * against its own output. Any malformed block throws.
 *
 * @param {Buffer} gif - the encoded file.
 * @returns {{width:number,height:number,frames:object[],loops:number[],palette:number[][]}}
 */
export function readGif(gif) {
  if (gif.toString('ascii', 0, 6) !== 'GIF89a') throw new Error('not a GIF89a stream');
  const width = gif.readUInt16LE(6);
  const height = gif.readUInt16LE(8);
  const flags = gif[10];
  let offset = 13;
  const palette = [];
  if ((flags & 0x80) !== 0) {
    const entries = 1 << ((flags & 0x07) + 1);
    for (let i = 0; i < entries; i += 1) {
      palette.push([gif[offset + i * 3], gif[offset + i * 3 + 1], gif[offset + i * 3 + 2]]);
    }
    offset += entries * 3;
  }
  const frames = [];
  const loops = [];
  let pendingDelayCs = 0;
  let pendingDisposal = 0;
  while (offset < gif.length) {
    const marker = gif[offset];
    offset += 1;
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = gif[offset];
      offset += 1;
      if (label === 0xf9) {
        const size = gif[offset];
        if (size !== 4) throw new Error(`GCE: sub-block size ${size}, expected 4`);
        const packed = gif[offset + 1];
        pendingDisposal = (packed >> 2) & 0x07;
        pendingDelayCs = gif.readUInt16LE(offset + 2);
        offset += 1 + size;
        // The graphic control extension is terminated by a zero-length block.
        if (gif[offset] !== 0) throw new Error('GCE: sub-block chain is not terminated');
        offset += 1;
        continue;
      }
      if (label === 0xff) {
        const size = gif[offset];
        const identifier = gif.toString('ascii', offset + 1, offset + 1 + size);
        let cursor = offset + 1 + size;
        const blocks = [];
        // Bounds-checked: a desynchronized stream must fail loudly rather than
        // spin forever on an out-of-range read that yields `undefined`.
        while (cursor < gif.length && gif[cursor] !== 0) {
          const length = gif[cursor];
          blocks.push(gif.subarray(cursor + 1, cursor + 1 + length));
          cursor += 1 + length;
        }
        if (cursor >= gif.length) throw new Error('GIF: application extension runs past the end');
        cursor += 1;
        if (identifier === 'NETSCAPE2.0') {
          if (blocks.length !== 1 || blocks[0].length !== 3 || blocks[0][0] !== 1) {
            throw new Error('NETSCAPE2.0: malformed loop sub-block');
          }
          loops.push(blocks[0][1] | (blocks[0][2] << 8));
        }
        offset = cursor;
        continue;
      }
      while (offset < gif.length && gif[offset] !== 0) offset += 1 + gif[offset];
      if (offset >= gif.length) throw new Error('GIF: extension runs past the end');
      offset += 1;
      continue;
    }
    if (marker === 0x2c) {
      const frameWidth = gif.readUInt16LE(offset + 4);
      const frameHeight = gif.readUInt16LE(offset + 6);
      const packed = gif[offset + 8];
      offset += 9;
      if ((packed & 0x80) !== 0) throw new Error('GIF: unexpected local colour table');
      const minCodeSize = gif[offset];
      offset += 1;
      // The LZW stream is carried in length-prefixed sub-blocks of at most 255
      // bytes: the prefixes are framing, not data, so they are stripped before
      // the stream reaches the decoder.
      const chunks = [];
      while (offset < gif.length && gif[offset] !== 0) {
        const length = gif[offset];
        chunks.push(gif.subarray(offset + 1, offset + 1 + length));
        offset += 1 + length;
      }
      if (offset >= gif.length) throw new Error('GIF: image data runs past the end');
      offset += 1;
      frames.push({
        width: frameWidth,
        height: frameHeight,
        minCodeSize,
        disposal: pendingDisposal,
        delayCs: pendingDelayCs,
        lzw: Buffer.concat(chunks),
      });
      continue;
    }
    throw new Error(`unexpected GIF block 0x${marker.toString(16)} at ${offset - 1}`);
  }
  return { width, height, frames, loops, palette };
}

/**
 * The reference decoder the encoder is checked against.
 *
 * Implements the code-width rule every real decoder uses — the width grows once
 * the decoder's own next free code reaches `1 << codeSize` — so a pixel-exact
 * round trip here means Chromium will decode the file too. Written the naive way
 * (a stack per code, no dictionary of strings) because it only ever runs over a
 * 128x128 preview.
 *
 * @param {Buffer} data - one frame's packed LZW bytes.
 * @param {number} minCodeSize - that frame's LZW minimum code size.
 * @param {number} expectedPixels - how many indices the frame holds.
 * @returns {Uint8Array} the decoded indices.
 */
export function lzwDecode(data, minCodeSize, expectedPixels) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Int32Array(4096);
  const first = new Int32Array(4096);
  for (let i = 0; i < clearCode; i += 1) first[i] = i;

  const out = new Uint8Array(expectedPixels);
  const stack = new Uint8Array(4096);
  let codeSize = minCodeSize + 1;
  let available = clearCode + 2;
  let previous = -1;
  let bitBuffer = 0;
  let bitCount = 0;
  let position = 0;
  let written = 0;

  function readCode() {
    while (bitCount < codeSize) {
      if (position >= data.length) return endCode;
      bitBuffer |= data[position] << bitCount;
      bitCount += 8;
      position += 1;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>>= codeSize;
    bitCount -= codeSize;
    return code;
  }

  for (;;) {
    const code = readCode();
    if (code === endCode) break;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      available = clearCode + 2;
      previous = -1;
      continue;
    }
    if (code > available) throw new Error(`LZW: code ${code} is past the table (${available})`);

    let depth = 0;
    let current = code;
    if (code === available) {
      if (previous < 0) throw new Error('LZW: the first code cannot be the pending entry');
      stack[depth] = first[previous];
      depth += 1;
      current = previous;
    }
    while (current >= clearCode) {
      if (depth >= stack.length) throw new Error('LZW: string overflow');
      stack[depth] = suffix[current];
      depth += 1;
      current = prefix[current];
    }
    stack[depth] = current;
    depth += 1;

    for (let i = depth - 1; i >= 0; i -= 1) {
      if (written >= out.length) throw new Error('LZW: more pixels than the frame holds');
      out[written] = stack[i];
      written += 1;
    }

    if (previous >= 0 && available < 4096) {
      prefix[available] = previous;
      suffix[available] = stack[depth - 1];
      first[available] = first[previous];
      available += 1;
      if (available === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previous = code;
  }

  if (written !== out.length) throw new Error(`LZW: decoded ${written} of ${out.length} pixels`);
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function strArg(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1 || argv[index + 1] === undefined) return fallback;
  return argv[index + 1];
}

/** The two README previews: the runtime's own rates, sampled once per frame. */
export const SHOTS = [
  { file: 'preview/sway-fast.gif', rate: 47, label: 'fast' },
  { file: 'preview/sway-slow.gif', rate: 7, label: 'slow' },
];

/**
 * Verify one encoded GIF against the indices it was built from.
 *
 * @returns {object} the measured proof.
 */
function verifyGif({ gif, path, frames, size, delayCs, palette, label, previous }) {
  const parsed = readGif(gif);
  const sha = createHash('sha256').update(gif).digest('hex');

  if (parsed.width !== size || parsed.height !== size) {
    throw new Error(`${path}: geometry ${parsed.width}x${parsed.height} != ${size}x${size}`);
  }
  if (parsed.frames.length !== frames.length) {
    throw new Error(`${path}: ${parsed.frames.length} frames, expected ${frames.length}`);
  }
  if (parsed.loops.length !== 1 || parsed.loops[0] !== 0) {
    throw new Error(`${path}: expected exactly one NETSCAPE2.0 loop block with count 0 (forever)`);
  }
  const distinct = new Set(parsed.frames.map((frame) => frame.lzw.toString('base64'))).size;
  if (distinct < 2) throw new Error(`${path}: every frame is identical, so nothing sways`);

  for (let index = 0; index < parsed.frames.length; index += 1) {
    const frame = parsed.frames[index];
    if (frame.delayCs !== delayCs) {
      throw new Error(`${path}: frame ${index} delay ${frame.delayCs} cs != ${delayCs} cs`);
    }
    if (frame.width !== size || frame.height !== size) {
      throw new Error(`${path}: frame ${index} geometry ${frame.width}x${frame.height} != ${size}`);
    }
    if (frame.disposal !== 1) {
      throw new Error(`${path}: frame ${index} disposal ${frame.disposal} != 1 (do not dispose)`);
    }
    if (frame.minCodeSize !== MIN_CODE_SIZE) {
      throw new Error(`${path}: frame ${index} LZW min code size ${frame.minCodeSize}`);
    }
    const roundTrip = lzwDecode(frame.lzw, frame.minCodeSize, frames[index].length);
    for (let pixel = 0; pixel < frames[index].length; pixel += 1) {
      if (roundTrip[pixel] !== frames[index][pixel]) {
        throw new Error(
          `${path}: frame ${index} differs at pixel ${pixel} ` +
            `(${roundTrip[pixel]} != ${frames[index][pixel]}) — the LZW code width is wrong`,
        );
      }
    }
  }
  if (palette.length !== LEVELS) throw new Error(`${path}: palette has ${palette.length} entries`);

  const identical = previous !== null && previous.equals(gif);
  console.log(
    `  round trip: ${parsed.frames.length}/${frames.length} frames pixel-exact ` +
      `(${frames[0].length} indices each), delays ${delayCs} cs, geometry ${size}x${size}, ` +
      `NETSCAPE2.0 loop=forever, ${distinct} distinct frames`,
  );
  if (previous === null) {
    console.log(`  determinism: no previous file; wrote sha256 ${sha.slice(0, 16)}…`);
  } else if (identical) {
    console.log(`  determinism: byte-identical to the file already on disk (sha256 ${sha.slice(0, 16)}…)`);
  } else {
    console.log(
      `  determinism: REWROTE an existing file — sha256 ${createHash('sha256')
        .update(previous)
        .digest('hex')
        .slice(0, 16)}… -> ${sha.slice(0, 16)}…`,
    );
  }
  return { sha, bytes: gif.length, frames: parsed.frames.length, distinct, identical, label };
}

export async function main(argv = process.argv.slice(2)) {
  const outDir = resolve(strArg(argv, 'out', ROOT));
  const metaPath = resolve(strArg(argv, 'meta', META_PATH));
  const sheetOverride = strArg(argv, 'sheet', null);

  console.log(`sheet metadata ${metaPath}`);
  const loaded = readFramesMeta(metaPath, sheetOverride === null ? null : resolve(sheetOverride));
  const png = decodePng(loaded.bytes);
  const sheet = loadSheetCells(png, loaded.meta.cell, loaded.meta.count);
  console.log(
    `  sheet ${png.width}x${png.height} png(colorType ${png.colorType}, bitDepth ${png.bitDepth}) ` +
      `${loaded.meta.count} cells of ${loaded.meta.cell}px, ink rgb(${sheet.ink.join(',')}), ` +
      `sha256 ${loaded.sha.slice(0, 16)}…`,
  );

  const motion = sheetMotion(sheet);
  console.log(
    `  sheet motion: fluke centroid travels ${motion.travelDisplayPx.toFixed(3)} display px ` +
      `(peak frame ${motion.peakIndex}, ${motion.peakTravelDisplayPx.toFixed(3)} px from frame 0), ` +
      `leg band drift ${motion.legDriftDisplayPx.toFixed(3)} px`,
  );
  console.log(
    `  fluke centroid x per frame (display px): ` +
      motion.flukeDisplayX.map((value) => value.toFixed(2)).join(' '),
  );

  const api = await loadClientEngine();
  // `hasSheet` is exported as a predicate by the runtime; accept either shape so
  // this check cannot be fooled by a function that is always truthy.
  const engineHasSheet = typeof api.hasSheet === 'function' ? api.hasSheet() : api.hasSheet;
  if (engineHasSheet === false) {
    throw new Error('client.js reports hasSheet=false: it cannot step the frames, so previews would lie');
  }
  if (typeof api.FRAME_COUNT === 'number' && api.FRAME_COUNT !== loaded.meta.count) {
    throw new Error(`client.js FRAME_COUNT ${api.FRAME_COUNT} != sheet count ${loaded.meta.count}`);
  }

  // Every spliced mode, cross-checked against the sheet in the same panel. This
  // is the strongest statement the preview tool can make: the bytes it is about
  // to rasterise are the bytes `client.js` will mask, one data URL per mode.
  const enginePanels = Array.isArray(api.MODE_PANELS) ? api.MODE_PANELS : [];
  if (enginePanels.length === 0) {
    throw new Error('client.js exposes no MODE_PANELS: run `node tools/build-assets.mjs` then `node tools/sync-sheet.mjs`');
  }
  const mismatched = [];
  const modeSheets = new Map();
  for (const panel of enginePanels) {
    const bytes = Buffer.from(String(panel.base64 || ''), 'base64');
    const modeMetaPath = join(ROOT, 'tools', 'generated', `${panel.id}.json`);
    const modeMeta = JSON.parse(readFileSync(modeMetaPath, 'utf8'));
    const sheetPath = resolve(ROOT, modeMeta.sheet);
    const sheetBytes = readFileSync(sheetPath);
    const inlined = `${panel.id} mode sha256 ${createHash('sha256').update(bytes).digest('hex')}`;
    if (!bytes.equals(sheetBytes)) {
      mismatched.push(`${panel.id}: client.js inlines ${bytes.length} B, ${modeMeta.sheet} is ${sheetBytes.length} B`);
    }
    if (bytes.length > 0 && bytes.length !== sheetBytes.length) mismatched.push(inlined);
    modeSheets.set(panel.id, { panel, meta: modeMeta, sheetPath, sheetBytes });
  }
  if (mismatched.length > 0) {
    throw new Error(`client.js panels do not match their sheets: ${mismatched.join('; ')}`);
  }
  console.log(
    `  client.js inlines ${enginePanels.length} sheet(s), each byte-identical to its sheet: ` +
      enginePanels.map((panel) => panel.id).join(', '),
  );

  const scale = scaleForCell(sheet.cell);
  const composited = compositeFrames(sheet, scale);
  console.log(
    `  preview raster: ${composited.size}x${composited.size} ` +
      `(${sheet.cell}px cell upscaled ${scale}x, nearest neighbour, ${LEVELS}-level ramp to the ink)`,
  );

  const proofs = [];
  const payloads = [];
  for (const shot of SHOTS) {
    const periodMs = api.periodForRate(shot.rate, api.TUNING);
    // GIF delays live on a 10 ms grid; browsers clamp 0-1 cs to 100 ms, so 20 ms
    // is the shortest delay that survives a browser. Both shots land on an exact
    // multiple of the grid, so the loop is an honest quantization of the mapping.
    const delayCs = Math.max(2, Math.round(periodMs / loaded.meta.count / 10));
    const gif = buildGif(composited.size, composited.size, composited.palette, composited.frames, delayCs);
    const path = resolve(outDir, shot.file);
    mkdirSync(dirname(path), { recursive: true });
    const previous = existsSync(path) ? readFileSync(path) : null;
    writeFileSync(path, gif);
    const loopMs = delayCs * 10 * loaded.meta.count;
    console.log(
      `\n${shot.label}: ${shot.rate} tok/s -> periodForRate = ${periodMs.toFixed(2)} ms/cycle, ` +
        `${loaded.meta.count} frames @ ${delayCs * 10} ms = ${loopMs} ms/loop ` +
        `(${(loopMs / periodMs).toFixed(2)}x the mapped period: GIF's grid and the 20 ms browser floor)`,
    );
    console.log(`  wrote ${path} (${(gif.length / 1024).toFixed(1)} KiB)`);
    const proof = verifyGif({
      gif,
      path,
      frames: composited.frames,
      size: composited.size,
      delayCs,
      palette: composited.palette,
      label: shot.label,
      previous,
    });
    proof.delayCs = delayCs;
    proof.periodMs = periodMs;
    proof.loopMs = loopMs;
    proof.rate = shot.rate;
    proof.payloads = readGif(gif).frames.map((frame) => frame.lzw.toString('base64'));
    proofs.push(proof);
    payloads.push(proof.payloads);
  }

  // The two previews are the same 24 real frames in the same order, played at
  // two different tempos: that is the whole point of the pair.
  if (payloads[0].length !== payloads[1].length) {
    throw new Error('the two previews do not carry the same number of frames');
  }
  for (let i = 0; i < payloads[0].length; i += 1) {
    if (payloads[0][i] !== payloads[1][i]) {
      throw new Error(`the two previews differ at frame ${i}: they are not the same sheet frames`);
    }
  }
  console.log(
    '\nthe two previews carry the identical 24 sheet frames in the same order; ' +
      `only the tempo differs (${proofs[0].delayCs * 10} ms vs ${proofs[1].delayCs * 10} ms per frame).`,
  );
  console.log(
    `sway-fast.gif ${(proofs[0].bytes / 1024).toFixed(1)} KiB sha256 ${proofs[0].sha.slice(0, 16)}…  |  ` +
      `sway-slow.gif ${(proofs[1].bytes / 1024).toFixed(1)} KiB sha256 ${proofs[1].sha.slice(0, 16)}…`,
  );

  // One preview per mode, so the README can show what each spliced sway looks
  // like. They share a fixed tempo (2 cs/frame, the browser floor): the point of
  // these files is the amplitude, and leaving the tempo constant is what makes a
  // side-by-side amplitude comparison honest.
  const modeProofs = [];
  for (const mode of MODES) {
    const entry = modeSheets.get(mode.id);
    if (entry === undefined) throw new Error(`mode "${mode.id}" is registered but not spliced into client.js`);
    const modePng = decodePng(entry.sheetBytes);
    const modeSheet = loadSheetCells(modePng, entry.meta.cell, entry.meta.count);
    const modeScale = scaleForCell(modeSheet.cell);
    const modeComposited = compositeFrames(modeSheet, modeScale);
    const delayCs = 2;
    const gif = buildGif(
      modeComposited.size,
      modeComposited.size,
      modeComposited.palette,
      modeComposited.frames,
      delayCs,
    );
    const rel = `preview/${mode.id}-preview.gif`;
    // Never doubled: `rel` is already outDir-relative (see SHOTS).
    const path = resolve(outDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    const previous = existsSync(path) ? readFileSync(path) : null;
    writeFileSync(path, gif);
    const proof = verifyGif({
      gif,
      path,
      frames: modeComposited.frames,
      size: modeComposited.size,
      delayCs,
      palette: modeComposited.palette,
      label: mode.id,
      previous,
    });
    proof.rate = null;
    proof.delayCs = delayCs;
    proof.loopMs = delayCs * 10 * entry.meta.count;
    proof.mode = mode.id;
    proof.cell = modeSheet.cell;
    proof.count = entry.meta.count;
    modeProofs.push(proof);
    console.log(
      `\nmode ${mode.id}: ${entry.meta.count} frames x ${modeSheet.cell}px @ ${delayCs * 10} ms = ` +
        `${proof.loopMs} ms/loop, ${modeComposited.size}x${modeComposited.size} raster -> ${rel} (${(gif.length / 1024).toFixed(1)} KiB)`,
    );
  }

  return { sheet, motion, proofs, modeProofs, scale, composited, enginePanels };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`make-gif: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}
