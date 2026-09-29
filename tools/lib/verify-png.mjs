// Independent PNG reader used by the frame verifier (verifier-owned; do NOT reuse
// tools/make-gif.mjs' decoder or frame-smith's code).
//
// Deliberately small but explicit about what it supports:
//   colour types 0 (grey), 2 (RGB), 3 (palette), 4 (grey+alpha), 6 (RGBA)
//   bit depths: 1/2/4/8 for palette, 8/16 for the rest, 8 for grey+alpha/RGBA
//   no interlace (Adam7 is rejected loudly rather than silently mis-read)
import zlib from 'node:zlib';

function u32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function u16(b, o) {
  return (b[o] << 8) | b[o + 1];
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

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
 * @param {Uint8Array|Buffer} input
 * @returns {{width:number,height:number,colorType:number,bitDepth:number,interlace:number,
 *            channels:number,rgba:Uint8Array,idatBytes:number,chunks:string[],crcOk:boolean}}
 */
export function decodePng(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) throw new Error('not a PNG (bad signature)');

  let p = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  const chunks = [];
  let idatBytes = 0;
  let crcOk = true;
  let sawIhdr = false;

  while (p + 8 <= b.length) {
    const len = u32(b, p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const dataStart = p + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > b.length) throw new Error(`PNG truncated in chunk ${type}`);
    const data = b.subarray(dataStart, dataEnd);
    chunks.push(type);
    // CRC check (zlib.crc32 exists in modern Node; fall back silently if absent)
    if (typeof zlib.crc32 === 'function') {
      const expect = u32(b, dataEnd);
      const got = zlib.crc32(data, zlib.crc32(Buffer.from(type, 'latin1'))) >>> 0;
      if (got !== expect) crcOk = false;
    }
    p = dataEnd + 4;

    if (type === 'IHDR') {
      width = u32(data, 0);
      height = u32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      sawIhdr = true;
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
      idatBytes += data.length;
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!sawIhdr) throw new Error('PNG: no IHDR');
  if (interlace !== 0) throw new Error('PNG: interlaced (Adam7) images are not supported by the verifier');
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error('PNG: unsupported colour type ' + colorType);
  if (colorType !== 3 && bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`PNG: unsupported bit depth ${bitDepth} for colour type ${colorType}`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  const bitsPerPixel = channels * bitDepth;
  const stride = Math.ceil((bitsPerPixel * width) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  if (raw.length < (stride + 1) * height) {
    throw new Error(`PNG: inflated data too short (${raw.length} < ${(stride + 1) * height})`);
  }

  // Un-filter into a packed scanline buffer.
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dst = out.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? dst[x - bpp] : 0;
      const bb = up ? up[x] : 0;
      const c = up && x >= bpp ? up[x - bpp] : 0;
      let v = src[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + bb) & 0xff; break;
        case 3: v = (v + ((a + bb) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(a, bb, c)) & 0xff; break;
        default: throw new Error('PNG: bad filter type ' + filter + ' on row ' + y);
      }
      dst[x] = v;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  const sample = (arr, bitOffset) => {
    if (bitDepth === 8) return arr[bitOffset];
    if (bitDepth === 16) return arr[bitOffset * 2]; // take the high byte
    const byte = arr[bitOffset >> 3];
    const perByte = 8 / bitDepth;
    const idx = bitOffset % 8;
    const shift = 8 - bitDepth * (Math.floor(idx / bitDepth) + 1);
    return (byte >> shift) & ((1 << bitDepth) - 1);
  };

  for (let y = 0; y < height; y++) {
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const ci = sample(row, x);
        const pi = ci * 3;
        rgba[o] = palette ? palette[pi] : 0;
        rgba[o + 1] = palette ? palette[pi + 1] : 0;
        rgba[o + 2] = palette ? palette[pi + 2] : 0;
        rgba[o + 3] = trns && ci < trns.length ? trns[ci] : 255;
      } else if (colorType === 0) {
        const v = sample(row, x);
        const vv = bitDepth === 16 ? row[x * 2] : bitDepth < 8 ? Math.round((v * 255) / ((1 << bitDepth) - 1)) : v;
        rgba[o] = vv; rgba[o + 1] = vv; rgba[o + 2] = vv; rgba[o + 3] = 255;
      } else if (colorType === 4) {
        if (bitDepth === 8) {
          const v = row[x * 2], a = row[x * 2 + 1];
          rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = a;
        } else {
          const v = row[x * 4], a = row[x * 4 + 2];
          rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = a;
        }
      } else if (colorType === 2) {
        const step = bitDepth === 8 ? 3 : 6;
        rgba[o] = row[x * step];
        rgba[o + 1] = row[x * step + (bitDepth === 8 ? 1 : 2)];
        rgba[o + 2] = row[x * step + (bitDepth === 8 ? 2 : 4)];
        rgba[o + 3] = 255;
      } else {
        const step = bitDepth === 8 ? 4 : 8;
        rgba[o] = row[x * step];
        rgba[o + 1] = row[x * step + (bitDepth === 8 ? 1 : 2)];
        rgba[o + 2] = row[x * step + (bitDepth === 8 ? 2 : 4)];
        rgba[o + 3] = row[x * step + (bitDepth === 8 ? 3 : 6)];
      }
    }
  }

  return { width, height, colorType, bitDepth, interlace, channels, rgba, idatBytes, chunks, crcOk };
}
