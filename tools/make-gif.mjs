/**
 * Animated GIF previews for the README — one per token rate.
 *
 * Nothing here is hand-drawn or screen-recorded: `render-whale.mjs` rasterizes
 * the shipped `REST_PATH` with the same tail-stock pivot the client half uses
 * (`transform-origin: 43% 86%`), and the period/amplitude of each loop come from
 * the same formulas `client.js` runs at runtime. The frames are then encoded as
 * a GIF89a animation by the hand-written LZW encoder below — no dependencies, no
 * build step, same policy as the rest of this package.
 *
 * GIF frame delays are quantized to 10 ms, so the loops land on 240 ms and
 * 840 ms: the real mapped periods are 240.6 ms (47.1 tok/s) and 838.5 ms
 * (7.1 tok/s), each rounded to the nearest 10 ms.
 *
 * Usage:
 *   node tools/make-gif.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { REST_PATH, parsePath, render, segments } from './render-whale.mjs';

// ---------------------------------------------------------------------------
// the client half's mapping, mirrored from client.js `TUNING`
// ---------------------------------------------------------------------------

const TUNING = {
  amplitudeDeg: 15,
  amplitudeGainDeg: 8,
  ampFullRate: 45,
  minPeriodMs: 190,
  maxPeriodMs: 1500,
  rateRef: 9,
  maxRate: 160,
  /** Tail-stock root in viewBox units — 43% 86% of the 16x16 icon box. */
  pivot: [6.88, 13.76],
};

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

/** Same curve as the client half: fast tokens, short cycle. */
function periodForRate(rate) {
  const r = clamp(rate, 0, TUNING.maxRate);
  return clamp(
    TUNING.maxPeriodMs / (1 + r / TUNING.rateRef),
    TUNING.minPeriodMs,
    TUNING.maxPeriodMs,
  );
}

/** Same curve as the client half: a busier model swings wider. */
function amplitudeForRate(rate) {
  const r = clamp(rate, 0, TUNING.maxRate);
  return TUNING.amplitudeDeg + TUNING.amplitudeGainDeg * Math.min(1, r / TUNING.ampFullRate);
}

// ---------------------------------------------------------------------------
// palette: one straight ramp from the surface colour to the icon colour
// ---------------------------------------------------------------------------

const BG = [246, 247, 250];
const INK = [77, 107, 254];
const LEVELS = 32; // 0 = background, LEVELS-1 = full ink

const PALETTE = Array.from({ length: LEVELS }, (_, level) => {
  const t = level / (LEVELS - 1);
  return [
    Math.round(BG[0] + (INK[0] - BG[0]) * t),
    Math.round(BG[1] + (INK[1] - BG[1]) * t),
    Math.round(BG[2] + (INK[2] - BG[2]) * t),
  ];
});

/** Quantize one rendered RGBA frame into palette indices. */
function quantize(rgba) {
  const pixels = new Uint8Array(rgba.length / 4);
  const span = BG[0] - INK[0];
  for (let i = 0; i < pixels.length; i += 1) {
    // The red channel is monotonic along the ramp, so it inverts the blend.
    const t = (BG[0] - rgba[i * 4]) / span;
    pixels[i] = clamp(Math.round(t * (LEVELS - 1)), 0, LEVELS - 1);
  }
  return pixels;
}

// ---------------------------------------------------------------------------
// GIF89a writer
// ---------------------------------------------------------------------------

/**
 * The GIF flavour of LZW: a clear code and an end code above the pixel codes,
 * a code width that grows with the dictionary, and a full-dictionary reset.
 *
 * @param pixels - palette indices, row-major.
 * @param minCodeSize - bits per pixel (5 for the 32-entry table above).
 * @returns the raw LZW byte stream, before sub-block framing.
 */
function lzwCompress(pixels, minCodeSize) {
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
      if (nextCode > (1 << codeSize)) {
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

/** Frame the byte stream into GIF sub-blocks, length-prefixed and 0-terminated. */
function subBlocks(out, data) {
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
 * @param width - frame width in pixels.
 * @param height - frame height in pixels.
 * @param frames - array of palette-index frames.
 * @param delayCs - per-frame delay in centiseconds.
 * @returns {Buffer} the encoded file.
 */
function buildGif(width, height, frames, delayCs) {
  const out = [];
  const short = (value) => out.push(value & 0xff, (value >> 8) & 0xff);
  const text = (value) => {
    for (const character of value) out.push(character.charCodeAt(0));
  };

  text('GIF89a');
  short(width);
  short(height);
  // Global color table present, 8-bit color resolution, 32 entries (2^(4+1)).
  out.push(0xf4, 0x00, 0x00);
  for (const [r, g, b] of PALETTE) out.push(r, g, b);

  // Netscape looping extension: 0 = forever.
  out.push(0x21, 0xff, 0x0b);
  text('NETSCAPE2.0');
  out.push(0x03, 0x01, 0x00, 0x00, 0x00);

  const minCodeSize = 5; // log2(PALETTE.length)
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
 * Walk the encoded bytes back and collect the frame payloads.
 *
 * A GIF's block structure is self-describing, so the encoder can be checked
 * against its own output: the frame count must match, and the payloads must not
 * all be identical (a still image would mean the sway never moved).
 */
function readGifFrames(gif) {
  if (gif.toString('ascii', 0, 6) !== 'GIF89a') throw new Error('not a GIF89a stream');
  const flags = gif[10];
  let offset = 13;
  if ((flags & 0x80) !== 0) offset += 3 * (1 << ((flags & 0x07) + 1));
  const frames = [];
  let pendingDelayCs = 0;
  while (offset < gif.length) {
    const marker = gif[offset];
    offset += 1;
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = gif[offset];
      offset += 1;
      // Graphic control extension: keep its delay so the CLI can assert it.
      if (label === 0xf9 && gif[offset] === 0x04) pendingDelayCs = gif.readUInt16LE(offset + 2);
      while (gif[offset] !== 0) offset += 1 + gif[offset];
      offset += 1;
      continue;
    }
    if (marker === 0x2c) {
      const width = gif.readUInt16LE(offset + 4);
      const height = gif.readUInt16LE(offset + 6);
      const packed = gif[offset + 8];
      offset += 9;
      if ((packed & 0x80) !== 0) offset += 3 * (1 << ((packed & 0x07) + 1));
      const minCodeSize = gif[offset];
      offset += 1;
      // The LZW stream is carried in length-prefixed sub-blocks of at most 255
      // bytes: the prefixes are framing, not data, so they must be stripped
      // before the stream is handed to a decoder.
      const chunks = [];
      while (gif[offset] !== 0) {
        const length = gif[offset];
        chunks.push(gif.subarray(offset + 1, offset + 1 + length));
        offset += 1 + length;
      }
      const lzw = Buffer.concat(chunks);
      frames.push({ width, height, minCodeSize, payload: lzw.toString('base64'), lzw, delayCs: pendingDelayCs });
      offset += 1;
      continue;
    }
    throw new Error(`unexpected GIF block 0x${marker.toString(16)} at ${offset - 1}`);
  }
  return frames;
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
 * @param data - one frame's packed LZW bytes.
 * @param minCodeSize - that frame's LZW minimum code size.
 * @param expected - the palette indices the encoder started from.
 * @returns {Uint8Array} the decoded indices.
 */
function lzwDecode(data, minCodeSize, expected) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Int32Array(4096);
  const first = new Int32Array(4096);
  for (let i = 0; i < clearCode; i += 1) first[i] = i;

  const out = new Uint8Array(expected.length);
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

/** Edge of the square frame; the tail is padded so a full swing stays inside. */
const SIZE = 128;
/** Canvas margin in viewBox units, for the fluke tips at full amplitude. */
const PAD = 2.5;

const SEGS = segments(parsePath(REST_PATH));

/** One full sway cycle, sampled `count` times, exactly as the client integrates it. */
function framesForRate(rate, count) {
  const amplitude = amplitudeForRate(rate);
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const angle = amplitude * Math.sin((i / count) * Math.PI * 2);
    frames.push(
      quantize(
        render(SEGS, {
          size: SIZE,
          pad: PAD,
          pivot: TUNING.pivot,
          rotateDeg: angle,
          mark: false,
        }),
      ),
    );
  }
  return frames;
}

const SHOTS = [
  { file: 'preview/sway-fast.gif', rate: 47.1, frames: 12 },
  { file: 'preview/sway-slow.gif', rate: 7.1, frames: 21 },
];

for (const shot of SHOTS) {
  const period = periodForRate(shot.rate);
  const amplitude = amplitudeForRate(shot.rate);
  const delayCs = Math.max(2, Math.round(period / shot.frames / 10));
  const frames = framesForRate(shot.rate, shot.frames);
  const gif = buildGif(SIZE, SIZE, frames, delayCs);
  const target = resolve(shot.file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, gif);
  console.log(
    `${shot.rate} tok/s -> period ${period.toFixed(0)} ms, amplitude +-${amplitude.toFixed(1)} deg, ` +
      `${shot.frames} frames @ ${delayCs * 10} ms = ${shot.frames * delayCs * 10} ms loop`,
  );
  // Self-check: decode what was just written and prove it is a real animation.
  const decoded = readGifFrames(gif);
  const distinct = new Set(decoded.map((frame) => frame.payload)).size;
  if (decoded.length !== shot.frames) {
    throw new Error(`${shot.file}: expected ${shot.frames} frames, read back ${decoded.length}`);
  }
  if (distinct < 2) throw new Error(`${shot.file}: every frame is identical, so nothing sways`);
  if (decoded.some((frame) => frame.width !== SIZE || frame.height !== SIZE)) {
    throw new Error(`${shot.file}: frame geometry does not match the canvas`);
  }
  // The delay IS the demo: it is the mapped period, so a wrong one would show a
  // slow tail as fast.
  if (decoded.some((frame) => frame.delayCs !== delayCs)) {
    throw new Error(`${shot.file}: a frame delay is not ${delayCs} cs`);
  }
  if (!gif.includes(Buffer.from('NETSCAPE2.0'))) {
    throw new Error(`${shot.file}: the looping extension is missing`);
  }
  // Pixel-exact round trip through the reference decoder. This is the check that
  // catches a wrong LZW code-width step: a one-bit shift decodes as noise, and
  // structure-only checks would still pass.
  for (let index = 0; index < decoded.length; index += 1) {
    const roundTrip = lzwDecode(decoded[index].lzw, decoded[index].minCodeSize, frames[index]);
    for (let pixel = 0; pixel < frames[index].length; pixel += 1) {
      if (roundTrip[pixel] !== frames[index][pixel]) {
        throw new Error(
          `${shot.file}: frame ${index} differs at pixel ${pixel} ` +
            `(${roundTrip[pixel]} != ${frames[index][pixel]})`,
        );
      }
    }
  }
  console.log(
    `  wrote ${target} (${SIZE}x${SIZE}, ${(gif.length / 1024).toFixed(1)} KiB) ` +
      `— read back ${decoded.length} frames, ${distinct} distinct, pixel-exact`,
  );
}
