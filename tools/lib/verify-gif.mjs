// tools/lib/verify-gif.mjs
//
// INDEPENDENT GIF89a decoder, written from first principles by the verifier
// (frame-verifier / task-4). It deliberately shares no code with
// tools/lib/gif-decode.mjs (frame-smith's pipeline decoder): this file exists so
// the verification verdict cannot inherit a bug from the code under test.
//
// Features: global + local colour tables, sub-block framing, LZW with the
// standard code-width growth rule (bump when the *decoder's* next free code
// reaches 1 << codeSize), interlacing (Adam7-ish GIF 4-pass), transparent colour
// index, disposal methods 0/1/2/3, GIF87a + GIF89a.
//
// decodeGif(buffer) -> {
//   version, width, height, gctSize, bgIndex, aspect,
//   frames: [{ rgba: Uint8Array(w*h*4), delayCs, left, top, width, height,
//              disposal, transparent, transparentIndex, interlaced, minCodeSize }],
//   globalPalette: Uint8Array|null,
// }

function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}

function u32be(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function readPalette(b, off, entries) {
  const p = new Uint8Array(entries * 3);
  p.set(b.subarray(off, off + entries * 3));
  return p;
}

/**
 * Decode one LZW image data stream (already stripped of sub-block length bytes).
 */
function lzwDecode(data, minCodeSize, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const MAXCODES = 4096;
  const prefix = new Int32Array(MAXCODES);
  const suffix = new Uint8Array(MAXCODES);
  const stack = new Uint8Array(MAXCODES + 1);
  const out = new Uint8Array(pixelCount);

  let next = 0;
  let codeSize = 0;
  const resetDict = () => {
    for (let i = 0; i < clearCode; i++) {
      prefix[i] = -1;
      suffix[i] = i;
    }
    next = eoiCode + 1;
    codeSize = minCodeSize + 1;
  };
  resetDict();

  let outLen = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  let pos = 0;
  const readCode = () => {
    while (bitCnt < codeSize) {
      if (pos >= data.length) return -1;
      bitBuf |= data[pos++] << bitCnt;
      bitCnt += 8;
    }
    const c = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize;
    bitCnt -= codeSize;
    return c;
  };

  let prev = -1;
  while (outLen < pixelCount) {
    const code = readCode();
    if (code < 0 || code === eoiCode) break;
    if (code === clearCode) {
      resetDict();
      prev = -1;
      continue;
    }
    let sp = 0;
    let first = 0;
    if (code < next) {
      let c = code;
      while (c >= 0) {
        stack[sp++] = suffix[c];
        c = prefix[c];
      }
      first = stack[sp - 1];
      for (let i = sp - 1; i >= 0; i--) out[outLen++] = stack[i];
    } else if (code === next && prev >= 0) {
      // KwKwK: string(prev) + firstChar(string(prev))
      let c = prev;
      while (c >= 0) {
        stack[sp++] = suffix[c];
        c = prefix[c];
      }
      first = stack[sp - 1];
      for (let i = sp - 1; i >= 0; i--) out[outLen++] = stack[i];
      out[outLen++] = first;
    } else {
      throw new Error(`GIF LZW: invalid code ${code} (next free = ${next})`);
    }
    if (prev >= 0 && next < MAXCODES) {
      prefix[next] = prev;
      suffix[next] = first;
      next++;
      // Standard decoder growth rule: bump when the next free code reaches 1<<codeSize.
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }

  if (outLen < pixelCount) {
    throw new Error(`GIF LZW: truncated stream (${outLen}/${pixelCount} px)`);
  }
  return out;
}

function collectSubBlocks(b, start) {
  const parts = [];
  let total = 0;
  let p = start;
  for (;;) {
    if (p >= b.length) throw new Error('GIF: unterminated sub-block sequence');
    const n = b[p++];
    if (n === 0) break;
    if (p + n > b.length) throw new Error('GIF: sub-block overruns file');
    parts.push(b.subarray(p, p + n));
    total += n;
    p += n;
  }
  const data = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    data.set(part, o);
    o += part.length;
  }
  return { data, end: p };
}

export function decodeGif(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 13) throw new Error('GIF: file too short');
  const version = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
  if (version !== 'GIF87a' && version !== 'GIF89a') {
    throw new Error(`GIF: bad signature "${version}"`);
  }
  const width = u16(b, 6);
  const height = u16(b, 8);
  const packed = b[10];
  const bgIndex = b[11];
  const aspect = b[12];
  let p = 13;

  let globalPalette = null;
  let gctSize = 0;
  if (packed & 0x80) {
    gctSize = 1 << ((packed & 0x07) + 1);
    globalPalette = readPalette(b, p, gctSize);
    p += gctSize * 3;
  } else {
    gctSize = 1 << ((packed & 0x07) + 1); // declared size even without a table
  }

  // Background: GIF has no alpha in the palette. If a global table exists we
  // start the canvas on the declared background colour (opaque). If a frame
  // later declares a transparent index, uncovered pixels stay transparent.
  const bgR = globalPalette ? globalPalette[bgIndex * 3] : 0;
  const bgG = globalPalette ? globalPalette[bgIndex * 3 + 1] : 0;
  const bgB = globalPalette ? globalPalette[bgIndex * 3 + 2] : 0;

  const canvas = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    canvas[i * 4] = bgR;
    canvas[i * 4 + 1] = bgG;
    canvas[i * 4 + 2] = bgB;
    canvas[i * 4 + 3] = 255;
  }

  const frames = [];
  let gce = null;
  let sawTrailer = false;

  while (p < b.length) {
    const marker = b[p++];
    if (marker === 0x3b) {
      sawTrailer = true;
      break;
    }
    if (marker === 0x21) {
      const label = b[p++];
      if (label === 0xf9) {
        const size = b[p];
        if (size < 4) throw new Error('GIF: malformed graphic control extension');
        const gp = b[p + 1];
        const delay = u16(b, p + 2);
        const tIndex = b[p + 4];
        gce = {
          disposal: (gp >> 2) & 0x07,
          transparent: (gp & 0x01) === 1,
          transparentIndex: tIndex,
          delayCs: delay,
        };
        p += 1 + size;
        if (b[p] === 0) p++; // block terminator
        else throw new Error('GIF: GCE missing terminator');
      } else {
        const { end } = collectSubBlocks(b, p);
        p = end;
      }
      continue;
    }
    if (marker === 0x2c) {
      const left = u16(b, p);
      const top = u16(b, p + 2);
      const fw = u16(b, p + 4);
      const fh = u16(b, p + 6);
      const ipacked = b[p + 8];
      p += 9;
      let palette = globalPalette;
      if (ipacked & 0x80) {
        const n = 1 << ((ipacked & 0x07) + 1);
        palette = readPalette(b, p, n);
        p += n * 3;
      }
      const interlaced = (ipacked & 0x40) !== 0;
      if (!palette) throw new Error('GIF: frame without any colour table');
      const minCodeSize = b[p++];
      const { data, end } = collectSubBlocks(b, p);
      p = end;

      if (fw <= 0 || fh <= 0 || left + fw > width || top + fh > height) {
        throw new Error('GIF: frame rectangle outside logical screen');
      }

      const indices = lzwDecode(data, minCodeSize, fw * fh);
      const disposal = gce ? gce.disposal : 0;
      const transparent = gce ? gce.transparent : false;
      const tIndex = gce ? gce.transparentIndex : -1;

      const saved = disposal === 3 ? canvas.slice() : null;

      // Paint this frame's rectangle onto the canvas.
      const paint = (rowPtr, dy) => {
        const y = top + dy;
        for (let x = 0; x < fw; x++) {
          const idx = indices[rowPtr * fw + x];
          if (transparent && idx === tIndex) continue;
          const o = (y * width + (left + x)) * 4;
          canvas[o] = palette[idx * 3];
          canvas[o + 1] = palette[idx * 3 + 1];
          canvas[o + 2] = palette[idx * 3 + 2];
          canvas[o + 3] = 255;
        }
      };

      if (!interlaced) {
        for (let y = 0; y < fh; y++) paint(y, y);
      } else {
        const passes = [
          [0, 8],
          [4, 8],
          [2, 4],
          [1, 2],
        ];
        let row = 0;
        for (const [start, step] of passes) {
          for (let y = start; y < fh; y += step) {
            paint(row++, y);
          }
        }
      }

      frames.push({
        rgba: canvas.slice(),
        delayCs: gce ? gce.delayCs : 0,
        left,
        top,
        width: fw,
        height: fh,
        disposal,
        transparent,
        transparentIndex: tIndex,
        interlaced,
        minCodeSize,
      });

      // Apply disposal *after* snapshotting this frame.
      if (disposal === 2) {
        for (let y = top; y < top + fh; y++) {
          for (let x = left; x < left + fw; x++) {
            const o = (y * width + x) * 4;
            canvas[o] = bgR;
            canvas[o + 1] = bgG;
            canvas[o + 2] = bgB;
            canvas[o + 3] = 255;
          }
        }
      } else if (disposal === 3 && saved) {
        canvas.set(saved);
      }
      gce = null;
      continue;
    }
    throw new Error(
      `GIF: unknown block marker 0x${marker.toString(16)} at offset ${p - 1}`
    );
  }

  if (!sawTrailer) throw new Error('GIF: missing trailer (0x3B)');
  if (frames.length === 0) throw new Error('GIF: no frames');

  return {
    version,
    width,
    height,
    gctSize,
    bgIndex,
    aspect,
    globalPalette,
    frames,
  };
}

export { u32be };
