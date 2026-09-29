/**
 * gif-decode.mjs — a small, dependency-free GIF87a/GIF89a decoder.
 *
 * Written for the frame pipeline: the shipped sprite sheet must be derived from
 * the user's material GIF pixel by pixel, so this decoder is the only thing
 * standing between those bytes and the alpha map. It therefore implements the
 * whole block grammar rather than the subset one file happens to use:
 *
 *   - global and local colour tables;
 *   - interlaced frames (four passes, rows 0/8, 4/8, 2/4, 1/2);
 *   - the transparent colour index (transparent pixels leave the canvas alone);
 *   - disposal 2 (restore the frame rectangle to the background colour) and
 *     disposal 3 (restore it to whatever was on the canvas before the frame);
 *   - sub-block framing: the length prefixes are transport, not data, and are
 *     stripped before the LZW stream is handed to the decoder;
 *   - the standard GIF LZW rule: the code width grows once the decoder's own
 *     next free code reaches `1 << codeSize` (and never past 12 bits).
 *
 * Everything is deterministic: no lookups beyond the file itself, no timers, no
 * floating point in the decode path.
 *
 * Usage:
 *   import { decodeGif } from './lib/gif-decode.mjs';
 *   const { width, height, frames } = decodeGif(readFileSync('x.gif'));
 */

/** GIF interlace passes: first row plus the row stride, in transmission order. */
const INTERLACE_PASSES = [
  { start: 0, step: 8 },
  { start: 4, step: 8 },
  { start: 2, step: 4 },
  { start: 1, step: 2 },
];

function fail(message) {
  throw new Error(`gif-decode: ${message}`);
}

/** Accept a Buffer, a typed array or an ArrayBuffer without copying when possible. */
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) return Uint8Array.from(input);
  throw new TypeError('decodeGif expects a Buffer, a typed array or an ArrayBuffer');
}

/** Copy `count` RGB triples out of the byte stream. */
function readColorTable(bytes, offset, count) {
  const end = offset + count * 3;
  if (end > bytes.length) fail('truncated colour table');
  const table = new Uint8Array(count * 3);
  table.set(bytes.subarray(offset, end));
  return table;
}

/**
 * Walk a GIF sub-block chain and return the concatenated payload.
 *
 * @returns {{ data: Uint8Array, next: number }} payload plus the offset of the
 *   byte after the terminating zero-length block.
 */
function readSubBlocks(bytes, offset) {
  const chunks = [];
  let cursor = offset;
  let total = 0;
  for (;;) {
    if (cursor >= bytes.length) fail('truncated sub-block chain');
    const size = bytes[cursor];
    cursor += 1;
    if (size === 0) break;
    if (cursor + size > bytes.length) fail('truncated sub-block payload');
    const chunk = bytes.subarray(cursor, cursor + size);
    chunks.push(chunk);
    total += size;
    cursor += size;
  }
  const data = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk, at);
    at += chunk.length;
  }
  return { data, next: cursor };
}

/**
 * Decode one frame's LZW payload into palette indices.
 *
 * The dictionary is stored as prefix/suffix arrays plus the first byte of each
 * entry, so an expansion costs one stack walk and no string allocation. `first`
 * is what makes the KwKwK case (a code that names the entry the decoder is
 * about to add) work: its first byte is the first byte of the previous string.
 *
 * @param data - the frame's LZW bytes, sub-block prefixes already removed.
 * @param minCodeSize - the file's LZW minimum code size for this frame.
 * @param pixelCount - frameWidth * frameHeight; decoding stops there.
 * @returns {Uint8Array} `pixelCount` palette indices, row-major.
 */
export function decodeLzw(data, minCodeSize, pixelCount) {
  if (minCodeSize < 2 || minCodeSize > 11) fail(`illegal LZW minimum code size ${minCodeSize}`);
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let i = 0; i < clearCode; i += 1) first[i] = i;

  const out = new Uint8Array(pixelCount);
  let written = 0;
  let codeSize = minCodeSize + 1;
  let available = clearCode + 2;
  let previous = -1;
  let bitBuffer = 0;
  let bitCount = 0;
  let position = 0;

  function readCode() {
    while (bitCount < codeSize) {
      if (position >= data.length) return -1;
      bitBuffer |= data[position] << bitCount;
      bitCount += 8;
      position += 1;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>>= codeSize;
    bitCount -= codeSize;
    return code;
  }

  while (written < pixelCount) {
    const code = readCode();
    if (code < 0) break; // ran out of bits; the caller decides if that is fatal
    if (code === endCode) break;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      available = clearCode + 2;
      previous = -1;
      continue;
    }
    if (code > available) {
      fail(`LZW code ${code} is past the dictionary (next free code ${available})`);
    }

    let depth = 0;
    let current = code;
    if (code === available) {
      if (previous < 0) fail('LZW: the first code cannot name the pending entry');
      stack[depth] = first[previous];
      depth += 1;
      current = previous;
    }
    while (current >= clearCode) {
      if (depth >= stack.length) fail('LZW: string expansion overflow');
      stack[depth] = suffix[current];
      depth += 1;
      current = prefix[current];
    }
    stack[depth] = current;
    depth += 1;

    for (let i = depth - 1; i >= 0 && written < pixelCount; i -= 1) {
      out[written] = stack[i];
      written += 1;
    }

    if (previous >= 0 && available < 4096) {
      prefix[available] = previous;
      suffix[available] = stack[depth - 1];
      first[available] = first[previous];
      available += 1;
      // Code-width growth: the decoder bumps once its OWN next free code
      // reaches 1 << codeSize. Adding the entry first and then testing is what
      // keeps this in step with every real encoder.
      if (available === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previous = code;
  }

  if (written !== pixelCount) {
    fail(`LZW produced ${written} of ${pixelCount} pixels`);
  }
  return out;
}

/** Re-order an interlaced frame's rows into normal top-to-bottom order. */
function deinterlace(indices, width, height) {
  const out = new Uint8Array(indices.length);
  let source = 0;
  for (const pass of INTERLACE_PASSES) {
    for (let y = pass.start; y < height; y += pass.step) {
      out.set(indices.subarray(source, source + width), y * width);
      source += width;
    }
  }
  if (source !== indices.length) fail('interlaced frame does not fill its raster');
  return out;
}

/** Paint an opaque rectangle of one colour into an RGBA canvas. */
function fillRect(canvas, canvasWidth, left, top, width, height, rgb) {
  const [r, g, b] = rgb;
  for (let y = top; y < top + height; y += 1) {
    let at = (y * canvasWidth + left) * 4;
    for (let x = 0; x < width; x += 1) {
      canvas[at] = r;
      canvas[at + 1] = g;
      canvas[at + 2] = b;
      canvas[at + 3] = 255;
      at += 4;
    }
  }
}

/**
 * Decode a whole GIF stream into full-canvas RGBA frames.
 *
 * Background handling follows the spec: the canvas starts as the file's declared
 * background colour and disposal 2 restores a frame's rectangle to that colour,
 * which is what an opaque GIF (this pipeline's material) expects. Pixels named
 * by the frame's transparent index are left untouched.
 *
 * @param {Uint8Array|ArrayBuffer} input - the GIF bytes.
 * @returns {{ width: number, height: number, frames: Array<{rgba: Uint8ClampedArray, delayCs: number}>, info: object }}
 */
export function decodeGif(input) {
  const bytes = toBytes(input);
  if (bytes.length < 13) fail('truncated header');
  const version = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (version !== 'GIF87a' && version !== 'GIF89a') fail(`unsupported signature "${version}"`);

  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  if (width === 0 || height === 0) fail('empty logical screen');
  const packed = bytes[10];
  const backgroundIndex = bytes[11];

  let offset = 13;
  let globalTable = null;
  let globalTableSize = 0;
  if ((packed & 0x80) !== 0) {
    globalTableSize = 1 << ((packed & 0x07) + 1);
    globalTable = readColorTable(bytes, offset, globalTableSize);
    offset += globalTableSize * 3;
  }
  const background = globalTable && backgroundIndex < globalTableSize
    ? [globalTable[backgroundIndex * 3], globalTable[backgroundIndex * 3 + 1], globalTable[backgroundIndex * 3 + 2]]
    : [0, 0, 0];

  const canvas = new Uint8ClampedArray(width * height * 4);
  fillRect(canvas, width, 0, 0, width, height, background);

  const frames = [];
  const info = {
    version,
    width,
    height,
    globalTableSize,
    backgroundIndex,
    background,
    loopCount: null,
    frameDetails: [],
  };
  let pending = { delayCs: 0, disposal: 0, transparentIndex: -1 };

  while (offset < bytes.length) {
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x3b) break; // trailer

    if (marker === 0x21) {
      const label = bytes[offset];
      offset += 1;
      if (label === 0xf9) {
        // Graphic control extension: 4 payload bytes then a zero terminator.
        if (bytes[offset] !== 4) fail('malformed graphic control extension');
        const flags = bytes[offset + 1];
        const delayCs = bytes[offset + 2] | (bytes[offset + 3] << 8);
        const transparentIndex = bytes[offset + 4];
        offset += 5;
        if (bytes[offset] !== 0) fail('graphic control extension is not terminated');
        offset += 1;
        pending = {
          delayCs,
          disposal: (flags >> 2) & 0x07,
          transparentIndex: (flags & 0x01) !== 0 ? transparentIndex : -1,
        };
      } else if (label === 0xff) {
        // Application extension: capture the NETSCAPE2.0 loop count, skip the rest.
        const size = bytes[offset];
        const appId = String.fromCharCode(...bytes.subarray(offset + 1, offset + 1 + Math.min(size, 11)));
        offset += 1 + size;
        const block = readSubBlocks(bytes, offset);
        offset = block.next;
        if (appId.startsWith('NETSCAPE') && block.data.length >= 3 && block.data[0] === 1) {
          info.loopCount = block.data[1] | (block.data[2] << 8);
        }
      } else {
        // Comment / plain text / anything else: skip the whole sub-block chain.
        const block = readSubBlocks(bytes, offset);
        offset = block.next;
      }
      continue;
    }

    if (marker === 0x2c) {
      const left = bytes[offset] | (bytes[offset + 1] << 8);
      const top = bytes[offset + 2] | (bytes[offset + 3] << 8);
      const frameWidth = bytes[offset + 4] | (bytes[offset + 5] << 8);
      const frameHeight = bytes[offset + 6] | (bytes[offset + 7] << 8);
      const descriptor = bytes[offset + 8];
      offset += 9;

      let localTable = null;
      let localTableSize = 0;
      if ((descriptor & 0x80) !== 0) {
        localTableSize = 1 << ((descriptor & 0x07) + 1);
        localTable = readColorTable(bytes, offset, localTableSize);
        offset += localTableSize * 3;
      }
      const interlaced = (descriptor & 0x40) !== 0;
      const minCodeSize = bytes[offset];
      offset += 1;
      const block = readSubBlocks(bytes, offset);
      offset = block.next;

      const table = localTable ?? globalTable;
      const tableSize = localTable ? localTableSize : globalTableSize;
      if (!table) fail('frame has no colour table');

      let indices = decodeLzw(block.data, minCodeSize, frameWidth * frameHeight);
      if (interlaced) indices = deinterlace(indices, frameWidth, frameHeight);

      // Disposal 3 needs the canvas as it was before this frame was painted.
      const snapshot = pending.disposal === 3 ? canvas.slice() : null;

      if ((pending.transparentIndex >= 0 || true) && frameWidth > 0 && frameHeight > 0) {
        for (let y = 0; y < frameHeight; y += 1) {
          const canvasY = top + y;
          if (canvasY < 0 || canvasY >= height) continue;
          for (let x = 0; x < frameWidth; x += 1) {
            const canvasX = left + x;
            if (canvasX < 0 || canvasX >= width) continue;
            const index = indices[y * frameWidth + x];
            if (index === pending.transparentIndex) continue;
            if (index >= tableSize) fail(`palette index ${index} is out of range (${tableSize})`);
            const at = (canvasY * width + canvasX) * 4;
            canvas[at] = table[index * 3];
            canvas[at + 1] = table[index * 3 + 1];
            canvas[at + 2] = table[index * 3 + 2];
            canvas[at + 3] = 255;
          }
        }
      }

      frames.push({ rgba: canvas.slice(), delayCs: pending.delayCs });
      info.frameDetails.push({
        left,
        top,
        width: frameWidth,
        height: frameHeight,
        interlaced,
        localTable: localTable !== null,
        localTableSize,
        disposal: pending.disposal,
        transparentIndex: pending.transparentIndex,
        minCodeSize,
        delayCs: pending.delayCs,
      });

      if (pending.disposal === 2) {
        fillRect(canvas, width, left, top, frameWidth, frameHeight, background);
      } else if (pending.disposal === 3 && snapshot) {
        for (let y = 0; y < frameHeight; y += 1) {
          const canvasY = top + y;
          if (canvasY < 0 || canvasY >= height) continue;
          const from = (canvasY * width + left) * 4;
          const to = from + frameWidth * 4;
          canvas.set(snapshot.subarray(from, to), from);
        }
      }
      pending = { delayCs: 0, disposal: 0, transparentIndex: -1 };
      continue;
    }

    fail(`unexpected block 0x${marker.toString(16)} at offset ${offset - 1}`);
  }

  if (frames.length === 0) fail('no image frames');
  return { width, height, frames, info };
}

export default decodeGif;
