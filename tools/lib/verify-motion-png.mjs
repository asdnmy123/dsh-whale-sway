/**
 * Minimal, dependency-free PNG reader + frame-sheet measurement helpers.
 *
 * Used by tools/verify-motion.mjs to prove, from the *sheet pixels alone*, how
 * far the fluke actually travels between frames. Nothing here trusts the
 * author's metadata: the bytes are decoded locally.
 */

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decode an 8-bit, non-interlaced PNG into raw samples.
 *
 * @param {Buffer} buffer - PNG file bytes.
 * @returns {{width:number,height:number,channels:number,colorType:number,data:Buffer,palette:(Buffer|null),trns:(Buffer|null)}}
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG (bad signature)');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) throw new Error('truncated PNG chunk ' + type);
    const data = buffer.subarray(start, end);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }

  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  if (bitDepth !== 8) throw new Error('only 8-bit PNG is supported (got ' + bitDepth + ')');
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error('unsupported PNG color type ' + colorType);
  if (width <= 0 || height <= 0) throw new Error('bad PNG dimensions');
  if (idat.length === 0) throw new Error('PNG has no IDAT data');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const expected = height * (stride + 1);
  if (raw.length < expected) {
    throw new Error('inflated data too short: ' + raw.length + ' < ' + expected);
  }
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          v = (v + a) & 0xff;
          break;
        case 2:
          v = (v + b) & 0xff;
          break;
        case 3:
          v = (v + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (v + pr) & 0xff;
          break;
        }
        default:
          throw new Error('unknown PNG filter ' + filter + ' on row ' + y);
      }
      cur[x] = v;
    }
  }

  return { width, height, channels, colorType, data: out, palette, trns };
}

/** Alpha (0..255) at pixel (x, y) for the supported color types. */
export function alphaAt(image, x, y) {
  const i = (y * image.width + x) * image.channels;
  switch (image.colorType) {
    case 6:
      return image.data[i + 3];
    case 4:
      return image.data[i + 1];
    case 3: {
      const index = image.data[i];
      if (image.trns && index < image.trns.length) return image.trns[index];
      return 255;
    }
    case 0:
      return image.trns && image.trns.length >= 2 && image.data[i] === image.trns[0] ? 0 : 255;
    case 2:
      return 255;
    default:
      return 255;
  }
}

/** Luminance (0..255) at pixel (x, y) — used when a sheet is opaque gray. */
export function lumaAt(image, x, y) {
  const i = (y * image.width + x) * image.channels;
  switch (image.colorType) {
    case 6:
    case 2:
      return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
    case 4:
    case 0:
      return image.data[i];
    case 3: {
      const index = image.data[i] * 3;
      if (!image.palette || index + 2 >= image.palette.length) return 0;
      return (
        0.2126 * image.palette[index] +
        0.7152 * image.palette[index + 1] +
        0.0722 * image.palette[index + 2]
      );
    }
    default:
      return 0;
  }
}

/**
 * Measure the fluke silhouette per cell of a vertical (column-of-cells) sheet.
 *
 * Each cell is `cellWidth x cellHeight` and maps onto a 16x16 display box, so
 * every measurement is also reported in display px.
 *
 * @param {object} image - decoded PNG.
 * @param {number} count - number of frames.
 * @param {{threshold?:number, box?:number}} [options]
 */
export function measureSheet(image, count, options) {
  const opts = options || {};
  const threshold = opts.threshold === undefined ? 8 : opts.threshold;
  const box = opts.box === undefined ? 16 : opts.box;
  if (!Number.isInteger(count) || count <= 0) throw new Error('bad frame count ' + count);
  if (image.height % count !== 0) {
    throw new Error('sheet height ' + image.height + ' is not a multiple of count ' + count);
  }
  const cellWidth = image.width;
  const cellHeight = image.height / count;
  const scale = box / cellWidth;

  const cells = [];
  for (let frame = 0; frame < count; frame += 1) {
    const y0 = frame * cellHeight;
    const y1 = y0 + cellHeight;
    let sumX = 0;
    let weight = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let pixels = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const a = alphaAt(image, x, y);
        const on = image.colorType === 3 ? a >= threshold : a > threshold;
        if (!on) continue;
        pixels += 1;
        sumX += x;
        weight += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    cells.push({
      frame,
      pixels,
      centroidX: weight > 0 ? sumX / weight : NaN,
      minX: weight > 0 ? minX : NaN,
      maxX: weight > 0 ? maxX : NaN,
    });
  }

  const empty = cells.filter((cell) => cell.pixels === 0);
  if (empty.length > 0) {
    throw new Error('cells with no silhouette: ' + empty.map((c) => c.frame).join(','));
  }

  // Frame-to-frame travel, including the wrap from the last frame back to the
  // first so a full cycle is measured.
  let maxCentroidDelta = 0;
  let maxCentroidPair = '';
  let maxEdgeDelta = 0;
  let maxEdgePair = '';
  for (let i = 0; i < count; i += 1) {
    const a = cells[i];
    const b = cells[(i + 1) % count];
    const dc = Math.abs(b.centroidX - a.centroidX);
    const de = Math.max(Math.abs(b.maxX - a.maxX), Math.abs(b.minX - a.minX));
    if (dc > maxCentroidDelta) {
      maxCentroidDelta = dc;
      maxCentroidPair = a.frame + '->' + b.frame;
    }
    if (de > maxEdgeDelta) {
      maxEdgeDelta = de;
      maxEdgePair = a.frame + '->' + b.frame;
    }
  }

  const centroidValues = cells.map((cell) => cell.centroidX);
  const minEdgeValues = cells.map((cell) => cell.minX);
  const maxEdgeValues = cells.map((cell) => cell.maxX);
  const cycleTravel = Math.max(...centroidValues) - Math.min(...centroidValues);
  const cycleTravelMaxEdge = Math.max(...maxEdgeValues) - Math.min(...maxEdgeValues);
  const cycleTravelMinEdge = Math.max(...minEdgeValues) - Math.min(...minEdgeValues);

  return {
    cellWidth,
    cellHeight,
    count,
    scale,
    cells,
    maxCentroidDeltaCellPx: maxCentroidDelta,
    maxCentroidDeltaDisplayPx: maxCentroidDelta * scale,
    maxCentroidDeltaPair: maxCentroidPair,
    maxEdgeDeltaCellPx: maxEdgeDelta,
    maxEdgeDeltaDisplayPx: maxEdgeDelta * scale,
    maxEdgeDeltaPair: maxEdgePair,
    cycleTravelCellPx: cycleTravel,
    cycleTravelDisplayPx: cycleTravel * scale,
    cycleTravelMaxEdgeDisplayPx: cycleTravelMaxEdge * scale,
    cycleTravelMinEdgeDisplayPx: cycleTravelMinEdge * scale,
    minCentroid: Math.min(...centroidValues),
    maxCentroid: Math.max(...centroidValues),
  };
}
