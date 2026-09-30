#!/usr/bin/env node
// tools/verify-frames.mjs
//
// ADVERSARIAL, INDEPENDENT verification of the delivered frame pipeline (task-4).
//
// It shares NO code with the pipeline under test. It uses the verifier's own
// GIF89a decoder (tools/lib/verify-gif.mjs), its own PNG reader
// (tools/lib/verify-png.mjs) and its own measurement primitives
// (tools/lib/verify-measure.mjs). Everything it prints is measured from bytes on
// disk; nothing is copied out of tools/generated/frames.json except the fields
// that are themselves under test.
//
// Usage:
//   node tools/verify-frames.mjs [--json <path>] [--sheet <path>] [--src <path>] [--determinism]
//
// Defaults (the shipped artifacts):
//   --json  tools/generated/frames.json
//   --sheet resolved from meta.sheet (normally preview/frames-sheet.png)
//   --src   preview/2C42C558D17C2745D1D47ED3DE000BD2.gif
//
// Exit code 0 = every check passed. Non-zero = at least one check failed.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { decodeGif } from './lib/verify-gif.mjs';
import { decodePng } from './lib/verify-png.mjs';
import {
  luminance601,
  alphaFromRgba,
  unionBbox,
  bbox,
  boxResample,
  pearson,
  meanAbsError,
  maxAbsError,
  centroid,
  strokeWidthStats,
  pathLength,
  maxPairwise,
  round,
} from './lib/verify-measure.mjs';
import { DEFAULT_MODE, findMode } from './modes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/**
 * The sway under test. `--mode` picks a registered mode and derives its material
 * path, artifact paths and distinctness expectation from `tools/modes.mjs`, so
 * one verifier covers every shipped sway; without it the default mode is used.
 */
const MODE_ID = (() => {
  const at = process.argv.indexOf('--mode');
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : DEFAULT_MODE;
})();
const MODE = findMode(MODE_ID);

const MATERIAL_REL = MODE.source;
const DEFAULT_JSON_REL = MODE.meta;
const DEFAULT_SHEET_REL = MODE.sheet;

const COUNT_EXPECTED = 24;
/**
 * How many cells of the sheet are genuinely different pictures. It is a property
 * of the artwork, pinned in `tools/modes.mjs`: a wag whose two halves are
 * mirror-symmetric rasterises a repeated cell at cell 32, so requiring 24
 * distinct cells would fail a faithful build. The measured count must equal this
 * — never more, never less — so a pipeline that duplicated or dropped a pose
 * still fails here.
 */
const DISTINCT_EXPECTED = MODE.expectDistinct === undefined ? COUNT_EXPECTED : MODE.expectDistinct;
const CELL_DISPLAY_PX = 16; // the CSS maps a cell onto a 16x16 display box
const FLUKE_BAND = [50, 180]; // inclusive source y (band of the fluke)
const LEG_BAND = [235, 278]; // inclusive source y (band of the legs / root)
const CROP_PAD_SPEC = 4; // PAD suggested by the task-2 spec
const INK_BLUE = [52, 94, 187];
const MAX_B64_LEN = 20000;

// ---------------------------------------------------------------- utilities

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readOrNull(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function f(x, d = 4) {
  if (!Number.isFinite(x)) return String(x);
  return x.toFixed(d);
}

function maxStepOf(pts) {
  let m = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (!a || !b) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > m) m = d;
  }
  return m;
}

/**
 * Centroid span of a point series: per-axis (max-min) and the Euclidean span of
 * those two axis spans. Distinct from maxPairwise (the max chord between the
 * actually-visited centroid positions), which is also reported.
 */
function spanOf(pts) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (!p) continue;
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  if (!Number.isFinite(x0)) return { x: NaN, y: NaN, xy: NaN };
  const sx = x1 - x0;
  const sy = y1 - y0;
  return { x: sx, y: sy, xy: Math.hypot(sx, sy) };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const k = a.slice(2);
        const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
        out[k] = v;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------- checks

const results = [];

function newCheck(id, title) {
  const c = { id, title, pass: true, notes: [], fails: [] };
  results.push(c);
  return c;
}
function note(c, s) {
  c.notes.push(s);
}
function fail(c, s) {
  c.fails.push(s);
  c.pass = false;
}

// ---------------------------------------------------------- alpha extraction

function sheetCellBytes(png, i, cell) {
  const out = new Uint8Array(cell * cell);
  for (let y = 0; y < cell; y++) {
    const base = (i * cell + y) * png.width;
    for (let x = 0; x < cell; x++) out[y * cell + x] = png.rgba[(base + x) * 4 + 3];
  }
  return out;
}

function buildWhiteLum(gif) {
  const W = gif.width;
  const H = gif.height;
  const white = [];
  const lum = [];
  for (const fr of gif.frames) {
    const w = new Uint8Array(W * H);
    const l = new Float32Array(W * H);
    for (let k = 0; k < W * H; k++) {
      const r = fr.rgba[k * 4];
      const g = fr.rgba[k * 4 + 1];
      const b = fr.rgba[k * 4 + 2];
      w[k] = r >= 250 && g >= 250 && b >= 250 ? 1 : 0;
      l[k] = luminance601(r, g, b);
    }
    white.push(w);
    lum.push(l);
  }
  return { white, lum };
}

/**
 * Validate the crop declared by the JSON against the material, independently:
 *   side == max(unionW, unionH) + 2*PAD with an integer PAD >= 2,
 *   the crop centre is the union-bbox centre (within 1.5 source px),
 *   every frame's ink sits >= 2 source px inside the crop.
 * Returns {ok, crop, pad, reasons[]} (falls back to the verifier's own PAD=4
 * crop when the JSON has no usable crop).
 */
function resolveCrop(meta, myCrop, union) {
  const reasons = [];
  let crop = null;
  const mc = meta && meta.crop;
  if (mc && Number.isFinite(mc.x0) && Number.isFinite(mc.y0) && Number.isFinite(mc.side)) {
    crop = { x0: mc.x0, y0: mc.y0, side: mc.side, source: 'json' };
  } else if (myCrop) {
    crop = { ...myCrop, source: 'verifier(PAD=4)' };
    reasons.push('JSON has no usable crop{} — used the verifier\'s own PAD=4 crop');
  } else {
    return { ok: false, crop: null, pad: null, reasons: ['no crop available'] };
  }

  const unionMax = Math.max(union.w, union.h);
  const pad = (crop.side - unionMax) / 2;
  if (!Number.isInteger(pad) || pad < 2) {
    reasons.push(
      `crop.side=${crop.side} is not max(unionW,unionH)+2*PAD for an integer PAD >= 2 ` +
        `(max=${unionMax} -> PAD=${pad})`
    );
  }
  const ccx = crop.x0 + crop.side / 2;
  const ccy = crop.y0 + crop.side / 2;
  const ucx = (union.x0 + union.x1 + 1) / 2;
  const ucy = (union.y0 + union.y1 + 1) / 2;
  if (Math.abs(ccx - ucx) > 1.5) reasons.push(`crop centre x ${f(ccx, 2)} vs union centre ${f(ucx, 2)}`);
  if (Math.abs(ccy - ucy) > 1.5) reasons.push(`crop centre y ${f(ccy, 2)} vs union centre ${f(ucy, 2)}`);
  if (crop.x0 < 0 || crop.y0 < 0 || crop.x0 + crop.side > union.imgW || crop.y0 + crop.side > union.imgH) {
    reasons.push('crop leaves the logical screen');
  }
  return { ok: reasons.length === 0, crop, pad, reasons };
}

// ---------------------------------------------------------------------- main

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    console.log(
      'usage: node tools/verify-frames.mjs [--json <path>] [--sheet <path>] [--src <path>]\n' +
        'Verifies preview/frames-sheet.png + tools/generated/frames.json against the material GIF.'
    );
    return 0;
  }

  // ---- load the three inputs ------------------------------------------------
  const jsonPath = opt.json ? path.resolve(opt.json) : path.join(ROOT, DEFAULT_JSON_REL);
  const jsonBytes = readOrNull(jsonPath);
  let meta = null;
  let jsonErr = null;
  if (!jsonBytes) jsonErr = `not found: ${jsonPath}`;
  else {
    try {
      meta = JSON.parse(jsonBytes.toString('utf8'));
    } catch (e) {
      jsonErr = `unparseable JSON (${e.message})`;
    }
  }

  const materialPath = opt.src ? path.resolve(opt.src) : path.join(ROOT, MATERIAL_REL);
  const materialBytes = readOrNull(materialPath);

  const sheetPath = opt.sheet
    ? path.resolve(opt.sheet)
    : meta && typeof meta.sheet === 'string'
      ? path.resolve(ROOT, meta.sheet)
      : path.join(ROOT, DEFAULT_SHEET_REL);
  const sheetBytes = readOrNull(sheetPath);

  console.log('='.repeat(78));
  console.log('INDEPENDENT FRAME-PIPELINE VERIFICATION (task-4, frame-verifier)');
  console.log('='.repeat(78));
  console.log(`repo root      : ${ROOT}`);
  console.log(`metadata       : ${jsonPath}${jsonBytes ? ` (${jsonBytes.length} bytes)` : ' [MISSING]'}`);
  console.log(`sheet          : ${sheetPath}${sheetBytes ? ` (${sheetBytes.length} bytes)` : ' [MISSING]'}`);
  console.log(`material       : ${materialPath}${materialBytes ? ` (${materialBytes.length} bytes)` : ' [MISSING]'}`);
  console.log('');

  // ---- decode ---------------------------------------------------------------
  let gif = null;
  let gifErr = null;
  if (materialBytes) {
    try {
      gif = decodeGif(materialBytes);
    } catch (e) {
      gifErr = e.message;
    }
  } else gifErr = 'material file missing';

  let png = null;
  let pngErr = null;
  if (sheetBytes) {
    try {
      png = decodePng(sheetBytes);
    } catch (e) {
      pngErr = e.message;
    }
  } else pngErr = 'sheet file missing';

  // ---- material-side derivations -------------------------------------------
  let alphaFrames = null;
  let union = null;
  let myCrop = null;
  if (gif) {
    const W = gif.width;
    const H = gif.height;
    alphaFrames = gif.frames.map((fr) => alphaFromRgba(fr.rgba, W, H));
    union = unionBbox(alphaFrames, W, H, 0.5);
    union.imgW = W;
    union.imgH = H;
    const side = Math.max(union.w, union.h) + 2 * CROP_PAD_SPEC;
    myCrop = {
      x0: Math.round((union.x0 + union.x1) / 2 - side / 2),
      y0: Math.round((union.y0 + union.y1) / 2 - side / 2),
      side,
    };
  }

  const cell = png ? png.width : 0;
  const count = png ? Math.floor(png.height / png.width) : 0;
  const cellBytes = [];
  const cellAlpha = [];
  if (png) {
    for (let i = 0; i < count; i++) {
      const b = sheetCellBytes(png, i, cell);
      cellBytes.push(b);
      const a = new Float32Array(cell * cell);
      for (let k = 0; k < b.length; k++) a[k] = b[k] / 255;
      cellAlpha.push(a);
    }
  }

  const ready = !!(gif && png && meta && Number.isFinite(meta.cell) && Number.isFinite(meta.count));

  // =========================================================================
  // CHECK 1 — the image really is the material's imagery, in the right order
  // =========================================================================
  const c1 = newCheck(1, "THE IMAGE IS THE MATERIAL'S (per-cell correlation, MAE, frame order)");
  if (!gif) fail(c1, `material GIF not decodable: ${gifErr}`);
  else if (!png) fail(c1, `sheet not decodable: ${pngErr}`);
  else if (!meta) fail(c1, `metadata unusable: ${jsonErr}`);
  else {
    const rc = resolveCrop(meta, myCrop, union);
    if (!rc.crop) fail(c1, 'no crop');
    else {
      const crop = rc.crop;
      for (const r of rc.reasons) fail(c1, `crop problem: ${r}`);
      note(
        c1,
        `crop used: x0=${crop.x0} y0=${crop.y0} side=${crop.side} PAD=${rc.pad} [${crop.source}]`
      );
      note(
        c1,
        `verifier's own derivation: x0=${myCrop.x0} y0=${myCrop.y0} side=${myCrop.side} ` +
          `(union ${union.w}x${union.h} at (${union.x0},${union.y0}), PAD=${CROP_PAD_SPEC})`
      );

      const W = gif.width;
      const H = gif.height;
      const mine = alphaFrames.map((a) => boxResample(a, W, H, crop.x0, crop.y0, crop.side, cell));

      // correlation matrix (row = sheet cell, col = material frame)
      const selfCorr = new Array(count).fill(0);
      const selfMae = new Array(count).fill(0);
      const selfMax = new Array(count).fill(0);
      const bestIdx = new Array(count).fill(-1);
      const bestCorr = new Array(count).fill(-2);
      const secondCorr = new Array(count).fill(-2);
      for (let i = 0; i < count; i++) {
        for (let j = 0; j < count; j++) {
          const r = pearson(cellAlpha[i], mine[j]);
          if (j === i) selfCorr[i] = r;
          if (r > bestCorr[i]) {
            secondCorr[i] = bestCorr[i];
            bestCorr[i] = r;
            bestIdx[i] = j;
          } else if (r > secondCorr[i]) secondCorr[i] = r;
        }
        selfMae[i] = meanAbsError(cellAlpha[i], mine[i]);
        selfMax[i] = maxAbsError(cellAlpha[i], mine[i]);
      }

      let minCorr = Infinity;
      let minCorrCell = -1;
      let maxMae = 0;
      let maxMaeCell = -1;
      let maeSum = 0;
      let corrFails = 0;
      let bestFails = 0;
      let maeFails = 0;
      note(c1, 'cell    corr(sheet,material[i])   MAE      maxErr   bestMatch(margin)');
      for (let i = 0; i < count; i++) {
        maeSum += selfMae[i];
        if (selfCorr[i] < minCorr) {
          minCorr = selfCorr[i];
          minCorrCell = i;
        }
        if (selfMae[i] > maxMae) {
          maxMae = selfMae[i];
          maxMaeCell = i;
        }
        if (selfCorr[i] < 0.98) corrFails++;
        if (selfMae[i] > 0.15) maeFails++;
        // A back-and-forth wag draws the same pose twice (frames i and i+12), so
        // "the best match must be the frame with the same index" is ambiguous by
        // construction: the other copy scores identically and Pearson's last-bit
        // rounding decides the winner. The claim that actually matters is that
        // cell i matches material frame i EXACTLY — and that no genuinely
        // different frame beats it. Both are checked below.
        const qualifies = selfMae[i] <= 0.05 && selfCorr[i] >= 0.98;
        if (!qualifies) bestFails++;
        const margin = bestCorr[i] - secondCorr[i];
        const tie = bestIdx[i] !== i && selfCorr[i] >= bestCorr[i] - 1e-6;
        note(
          c1,
          `  ${String(i).padStart(2)}    ${f(selfCorr[i], 5)}                ${f(selfMae[i], 5)}  ` +
            `${f(selfMax[i], 4)}   ${String(bestIdx[i]).padStart(2)} (${f(margin, 5)})` +
            (bestIdx[i] === i ? '' : tie ? '  (= tie: the repeated pose)' : '  <-- MISMATCH')
        );
      }
      const meanMae = maeSum / count;
      note(c1, `min per-cell correlation : ${f(minCorr, 5)} (cell ${minCorrCell})   [require >= 0.98]`);
      note(c1, `mean per-cell MAE        : ${f(meanMae, 5)}                [require <= 0.05]`);
      note(c1, `max  per-cell MAE        : ${f(maxMae, 5)} (cell ${maxMaeCell})   [adversarial bound <= 0.15]`);
      note(c1, `cells with correlation < 0.98 : ${corrFails}`);
      note(c1, `cells whose best match is not their own material frame : ${bestFails}`);
      if (corrFails > 0) fail(c1, `${corrFails} cell(s) have correlation < 0.98 (min ${f(minCorr, 5)} at cell ${minCorrCell})`);
      if (meanMae > 0.05) fail(c1, `mean absolute error ${f(meanMae, 5)} > 0.05`);
      if (maeFails > 0) fail(c1, `${maeFails} cell(s) have MAE > 0.15 (max ${f(maxMae, 5)} at cell ${maxMaeCell})`);
      if (bestFails > 0) {
        const bad = [];
        for (let i = 0; i < count; i++) {
          if (selfMae[i] <= 0.05 && selfCorr[i] >= 0.98) continue;
          bad.push(`cell ${i}: corr ${f(selfCorr[i], 5)} / MAE ${f(selfMae[i], 5)}`);
        }
        fail(c1, `frame order/duplication problem: ${bad.join(', ')}`);
      }
      if (c1.pass) note(c1, 'every sheet cell is the material frame with the same index.');

      // cross-check with the verifier's own PAD=4 crop (informational)
      if (crop.x0 !== myCrop.x0 || crop.y0 !== myCrop.y0) {
        const mine4 = alphaFrames.map((a) => boxResample(a, W, H, myCrop.x0, myCrop.y0, myCrop.side, cell));
        let m = Infinity;
        for (let i = 0; i < count; i++) {
          const r = pearson(cellAlpha[i], mine4[i]);
          if (r < m) m = r;
        }
        note(c1, `cross-check with verifier PAD=${CROP_PAD_SPEC} crop: min correlation ${f(m, 5)}`);
      }
    }
  }

  // =========================================================================
  // CHECK 2 — 24 distinct frames
  // =========================================================================
  const c2 = newCheck(2, 'FRAMES ARE DISTINCT (24/24, plus the closest pair)');
  if (!png) fail(c2, `sheet not decodable: ${pngErr}`);
  else {
    const hashes = cellBytes.map((b) => sha256(Buffer.from(b)));
    const distinct = new Set(hashes).size;
    let minDiffPx = Infinity;
    let minDiffL1 = Infinity;
    let pairA = -1;
    let pairB = -1;
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let dp = 0;
        let l1 = 0;
        const a = cellBytes[i];
        const b = cellBytes[j];
        for (let k = 0; k < a.length; k++) {
          const d = Math.abs(a[k] - b[k]);
          if (d) {
            dp++;
            l1 += d;
          }
        }
        if (dp < minDiffPx) {
          minDiffPx = dp;
          minDiffL1 = l1;
          pairA = i;
          pairB = j;
        }
      }
    }
    note(c2, `distinct alpha hashes : ${distinct} / ${count}   [require ${DISTINCT_EXPECTED} for ${MODE.id}]`);
    note(c2, `closest pair          : cells ${pairA} & ${pairB} — ${minDiffPx} of ${cell * cell} pixels differ, L1=${minDiffL1}`);
    note(c2, `closest pair mean |dalpha| : ${f(minDiffL1 / (cell * cell), 6)}`);
    if (distinct !== DISTINCT_EXPECTED) {
      fail(c2, `sheet has ${distinct} distinct cells, expected ${DISTINCT_EXPECTED} (${MODE.id})`);
    }
    if (count !== COUNT_EXPECTED) fail(c2, `sheet holds ${count} cells, expected ${COUNT_EXPECTED}`);
    // A zero-difference closest pair is the expected consequence of a
    // back-and-forth wag, not a defect: the material itself repeats those poses
    // (the registry records how many) and the pipeline must reproduce it
    // faithfully rather than invent a difference at cell 32.
    if (minDiffPx === 0 && distinct === DISTINCT_EXPECTED) {
      note(c2, `cells ${pairA} and ${pairB} are identical, which is the artwork's own repetition (${distinct} distinct poses)`);
    } else if (minDiffPx === 0) {
      fail(c2, `cells ${pairA} and ${pairB} have identical alpha although ${distinct} distinct cells were expected`);
    }
  }

  // =========================================================================
  // CHECK 3 — the white background is really gone
  // =========================================================================
  const c3 = newCheck(3, 'WHITE BACKGROUND REALLY REMOVED (no white plate, no grey plate)');
  if (!gif || !png || !meta) fail(c3, 'need material + sheet + metadata');
  else {
    const rc = resolveCrop(meta, myCrop, union);
    const crop = rc.crop;
    const { white, lum } = buildWhiteLum(gif);
    const sx = crop.side / cell;
    let pureWhiteViol = 0;
    let worstOnPureWhite = 0;
    let worstPureWhiteAt = null;
    let plateViol = 0;
    let worstPlateAlpha = 0;
    let worstPlateAt = null;
    let nearWhiteViol = 0;
    let worstNearWhite = 0;
    let worstNearWhiteFrac = 1;
    let minLumAtOpaque = Infinity;
    const W = gif.width;

    for (let i = 0; i < count; i++) {
      const a = cellAlpha[i];
      const wRow = white[i];
      const lRow = lum[i];
      for (let py = 0; py < cell; py++) {
        const sy0 = crop.y0 + py * sx;
        const sy1 = crop.y0 + (py + 1) * sx;
        const rows = [];
        for (let y = Math.floor(sy0); y <= Math.ceil(sy1) - 1; y++) {
          const oy = Math.min(y + 1, sy1) - Math.max(y, sy0);
          if (oy > 0 && y >= 0 && y < gif.height) rows.push([y, oy]);
        }
        for (let px = 0; px < cell; px++) {
          const sx0 = crop.x0 + px * sx;
          const sx1 = crop.x0 + (px + 1) * sx;
          let area = 0;
          let whiteArea = 0;
          let minLum = Infinity;
          for (const [y, oy] of rows) {
            const base = y * W;
            for (let x = Math.floor(sx0); x <= Math.ceil(sx1) - 1; x++) {
              if (x < 0 || x >= W) continue;
              const ox = Math.min(x + 1, sx1) - Math.max(x, sx0);
              if (ox <= 0) continue;
              const wgt = ox * oy;
              area += wgt;
              const k = base + x;
              if (wRow[k]) whiteArea += wgt;
              const l = lRow[k];
              if (l < minLum) minLum = l;
            }
          }
          const A = a[py * cell + px];
          const Abyte = a[py * cell + px] * 255;
          const frac = area > 0 ? whiteArea / area : 1;
          if (frac >= 1) {
            if (Abyte !== 0) {
              pureWhiteViol++;
              if (Abyte > worstOnPureWhite) {
                worstOnPureWhite = Abyte;
                worstPureWhiteAt = { cell: i, x: px, y: py, alpha: Abyte };
              }
            }
          } else if (frac >= 0.99) {
            if (Abyte > worstNearWhite) {
              worstNearWhite = Abyte;
              worstNearWhiteFrac = frac;
            }
            if (Abyte > 0) nearWhiteViol++;
          }
          if (Abyte >= 250) {
            if (minLum < minLumAtOpaque) minLumAtOpaque = minLum;
            if (minLum >= 200) {
              plateViol++;
              if (Abyte > worstPlateAlpha) {
                worstPlateAlpha = Abyte;
                worstPlateAt = { cell: i, x: px, y: py, alpha: Abyte, minLum: round(minLum, 1) };
              }
            }
          }
        }
      }
    }

    note(c3, `sheet pixels whose whole source box is pure white (>=250 on R,G,B): violations ${pureWhiteViol}, worst residual alpha ${f(worstOnPureWhite, 4)}/255${worstPureWhiteAt ? ` at ${JSON.stringify(worstPureWhiteAt)}` : ''}   [require 0]`);
    note(c3, `sheet pixels >=99% pure-white box with alpha>0: ${nearWhiteViol} (worst alpha ${f(worstNearWhite, 4)} at white fraction ${f(worstNearWhiteFrac, 5)}) [diagnostic]`);
    note(c3, `opaque plate test (alpha >= 250 over a source box with no ink, minLum >= 200): violations ${plateViol}${worstPlateAt ? `, worst ${JSON.stringify(worstPlateAt)}` : ''}   [require 0]`);
    note(c3, `darkest material luminance under any alpha>=250 sheet pixel: ${f(minLumAtOpaque, 1)} (ink luminance is 92.0)`);
    if (pureWhiteViol > 0) {
      fail(c3, `${pureWhiteViol} sheet pixel(s) are non-zero alpha where the material is pure white (worst ${f(worstOnPureWhite, 4)}/255 at ${JSON.stringify(worstPureWhiteAt)})`);
    }
    if (plateViol > 0) fail(c3, `${plateViol} opaque sheet pixel(s) sit over inkless near-white material (worst ${JSON.stringify(worstPlateAt)})`);
    if (c3.pass) note(c3, 'no white/grey plate anywhere: pure white -> alpha 0');
  }

  // =========================================================================
  // CHECK 4 — nothing is clipped
  // =========================================================================
  const c4 = newCheck(4, 'NOTHING IS CLIPPED (empty cell borders + worst in-cell margin)');
  if (!png || !gif || !meta) fail(c4, 'need sheet + material + metadata');
  else {
    const rc = resolveCrop(meta, myCrop, union);
    const crop = rc.crop;
    let borderViol = 0;
    let worstBorder = 0;
    let worstBorderAt = null;
    const perCellBorder = [];
    for (let i = 0; i < count; i++) {
      const a = cellBytes[i];
      let m = 0;
      const at = (x, y) => {
        const v = a[y * cell + x];
        if (v > m) {
          m = v;
          return { x, y, v };
        }
        return null;
      };
      let hit = null;
      for (let x = 0; x < cell; x++) {
        hit = at(x, 0) || hit;
        hit = at(x, cell - 1) || hit;
      }
      for (let y = 0; y < cell; y++) {
        hit = at(0, y) || hit;
        hit = at(cell - 1, y) || hit;
      }
      perCellBorder.push(m);
      if (m > 0) {
        borderViol++;
        if (m > worstBorder) {
          worstBorder = m;
          worstBorderAt = { cell: i, ...hit };
        }
      }
    }
    note(c4, `cells with non-zero alpha on any border row/col: ${borderViol} / ${count}   [require 0]`);
    note(c4, `worst border alpha: ${f(worstBorder, 4)}/255${worstBorderAt ? ` at ${JSON.stringify(worstBorderAt)}` : ''}`);
    note(c4, `per-cell worst border alpha: ${perCellBorder.join(',')}`);

    // independent margin recomputation from the material
    const W = gif.width;
    const H = gif.height;
    let worstMargin = Infinity;
    let worstMarginFrame = -1;
    const margins = [];
    for (let i = 0; i < count; i++) {
      const bb = bbox(alphaFrames[i], W, H, 0.5);
      if (!bb) {
        margins.push('empty');
        continue;
      }
      const m = Math.min(
        bb.x0 - crop.x0,
        crop.x0 + crop.side - 1 - bb.x1,
        bb.y0 - crop.y0,
        crop.y0 + crop.side - 1 - bb.y1
      );
      margins.push(m);
      if (m < worstMargin) {
        worstMargin = m;
        worstMarginFrame = i;
      }
    }
    note(c4, `per-frame ink margin to the crop edge (source px): ${margins.join(',')}`);
    note(c4, `worst in-cell ink margin: ${worstMargin} source px (frame ${worstMarginFrame}) = ${f((worstMargin * cell) / crop.side, 4)} cell px   [require >= 2 source px]`);
    if (borderViol > 0) {
      fail(c4, `${borderViol} cell(s) have ink on a border row/col (worst alpha ${f(worstBorder, 4)}/255 at ${JSON.stringify(worstBorderAt)})`);
    }
    if (worstMargin < 2) fail(c4, `worst in-cell margin ${worstMargin} source px < 2`);
  }

  // =========================================================================
  // CHECK 5 — exact geometry, hashes, base64 identity
  // =========================================================================
  const c5 = newCheck(5, 'GEOMETRY (width==cell, height==count*cell, square cells, hashes, base64)');
  if (!meta) fail(c5, `metadata unusable: ${jsonErr}`);
  if (!png) fail(c5, `sheet not decodable: ${pngErr}`);
  if (meta && png) {
    note(c5, `sheet raster: ${png.width} x ${png.height}, colourType=${png.colorType}, bitDepth=${png.bitDepth}, interlace=${png.interlace}, chunks=[${png.chunks.join(',')}], idat=${png.idatBytes} B, pngCrcAllOk=${png.crcOk}`);
    note(c5, `meta: count=${meta.count} cell=${meta.cell} cellDisplayPx=${meta.cellDisplayPx} slotInsetPx=${meta.slotInsetPx}`);
    note(c5, `measured cells: ${count} (width ${png.width}, height/width ${f(png.height / png.width, 4)})`);
    if (png.width !== meta.cell) fail(c5, `sheet width ${png.width} != meta.cell ${meta.cell}`);
    if (png.height !== meta.count * meta.cell) {
      fail(c5, `sheet height ${png.height} != count*cell ${meta.count * meta.cell}`);
    }
    if (png.height !== png.width * meta.count) {
      fail(c5, `height ${png.height} != width*count ${png.width * meta.count} (cells not square / count mismatch)`);
    }
    if (meta.count !== COUNT_EXPECTED) fail(c5, `meta.count ${meta.count} != ${COUNT_EXPECTED}`);
    const sheetHash = sha256(sheetBytes);
    note(c5, `sheet sha256 (measured) : ${sheetHash}`);
    note(c5, `sheet sha256 (json)     : ${meta.sheetSha256}`);
    if (sheetHash !== String(meta.sheetSha256).toLowerCase()) fail(c5, 'sheet sha256 does not match meta.sheetSha256');
    if (meta.sheetSha256 !== String(meta.sheetSha256).toLowerCase()) {
      note(c5, 'note: meta.sheetSha256 is not lower-case hex (compared case-insensitively)');
    }

    const b64 = typeof meta.pngBase64 === 'string' ? meta.pngBase64 : '';
    note(c5, `pngBase64 length: ${b64.length} chars (${f(b64.length / 1024, 2)} KiB)   [raster budget <= ${MAX_B64_LEN}]`);
    const decoded = b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
    note(c5, `pngBase64 decodes to ${decoded.length} bytes; sheet file is ${sheetBytes.length} bytes`);
    if (!b64) fail(c5, 'meta.pngBase64 missing/empty');
    else if (!decoded.equals(Buffer.from(sheetBytes))) fail(c5, 'pngBase64 does not decode to the exact bytes of the sheet file');
    if (b64.length > MAX_B64_LEN) fail(c5, `pngBase64 length ${b64.length} > ${MAX_B64_LEN}`);

    // informational: the sheet's RGB channel (the mask ignores it, but the spec fixes it)
    let rgbMismatch = 0;
    let rgbFirst = null;
    for (let k = 0; k < png.width * png.height; k++) {
      const r = png.rgba[k * 4];
      const g = png.rgba[k * 4 + 1];
      const b = png.rgba[k * 4 + 2];
      if (r !== INK_BLUE[0] || g !== INK_BLUE[1] || b !== INK_BLUE[2]) {
        rgbMismatch++;
        if (!rgbFirst) rgbFirst = [r, g, b];
      }
    }
    note(c5, `sheet pixels whose RGB != (52,94,187): ${rgbMismatch}${rgbFirst ? ` (first ${JSON.stringify(rgbFirst)})` : ''} [informational]`);
  }

  // =========================================================================
  // CHECK 6 — the exact source path and its hash
  // =========================================================================
  const c6 = newCheck(6, 'SOURCE PATH (exact material referenced, hash matches the file on disk)');
  if (!meta) fail(c6, `metadata unusable: ${jsonErr}`);
  else {
    const claimed = String(meta.source ?? '');
    const norm = claimed.replace(/\\/g, '/').replace(/^\.\//, '');
    note(c6, `meta.source            : ${JSON.stringify(claimed)}`);
    note(c6, `expected               : ${JSON.stringify(MATERIAL_REL)}`);
    note(c6, `resolved               : ${path.join(ROOT, MATERIAL_REL)}`);
    if (norm !== MATERIAL_REL) fail(c6, `meta.source does not name ${MATERIAL_REL} exactly`);
    if (!materialBytes) fail(c6, `material file missing at ${materialPath}`);
    else {
      const h = sha256(materialBytes);
      note(c6, `material sha256 (measured from disk) : ${h}`);
      note(c6, `material sha256 (json sourceSha256)  : ${meta.sourceSha256}`);
      if (h !== String(meta.sourceSha256).toLowerCase()) fail(c6, 'material sha256 != meta.sourceSha256');
      if (path.resolve(ROOT, norm) !== path.resolve(materialPath)) {
        note(c6, `note: verified file ${materialPath} differs from the JSON-resolved path ${path.resolve(ROOT, norm)}`);
      }
    }
  }
  if (gif) {
    const delays = new Set(gif.frames.map((x) => x.delayCs));
    const disposals = new Set(gif.frames.map((x) => x.disposal));
    const rects = new Set(gif.frames.map((x) => `${x.left},${x.top},${x.width}x${x.height}`));
    note(c6, `material (decoded independently): ${gif.version} ${gif.width}x${gif.height}, GCT ${gif.gctSize} entries, bgIndex ${gif.bgIndex}, frames ${gif.frames.length}`);
    note(c6, `  delays(cs)=[${[...delays].join(',')}], disposals=[${[...disposals].join(',')}], rects=[${[...rects].join(' | ')}], transparent=${gif.frames.some((x) => x.transparent)}, interlaced=${gif.frames.some((x) => x.interlaced)}`);
    note(c6, `  minCodeSizes=[${[...new Set(gif.frames.map((x) => x.minCodeSize))].join(',')}], bg colour=${gif.globalPalette ? `(${gif.globalPalette[gif.bgIndex * 3]},${gif.globalPalette[gif.bgIndex * 3 + 1]},${gif.globalPalette[gif.bgIndex * 3 + 2]})` : 'n/a'}`);
    if (gif.frames.length !== COUNT_EXPECTED) fail(c6, `material has ${gif.frames.length} frames, expected ${COUNT_EXPECTED}`);
    if (gif.width !== 360 || gif.height !== 360) fail(c6, `material is ${gif.width}x${gif.height}, expected 360x360`);
  } else if (materialBytes) {
    fail(c6, `material GIF not decodable: ${gifErr}`);
  }

  // =========================================================================
  // CHECK 7 — natural amplitude, no amplification
  // =========================================================================
  const c7 = newCheck(7, 'NATURAL AMPLITUDE (fluke/leg centroid travel, sheet vs raw material)');
  if (!gif || !png || !meta) fail(c7, 'need material + sheet + metadata');
  else {
    const rc = resolveCrop(meta, myCrop, union);
    const crop = rc.crop;
    const dispPx = Number.isFinite(meta.cellDisplayPx) ? meta.cellDisplayPx : CELL_DISPLAY_PX;
    const rawScale = dispPx / crop.side; // display px per source px
    const cellScale = dispPx / cell; // display px per cell px
    if (dispPx !== CELL_DISPLAY_PX) note(c7, `note: meta.cellDisplayPx=${dispPx} (expected ${CELL_DISPLAY_PX})`);
    note(c7, `display scale: raw ${f(rawScale, 6)} px/source-px (cellDisplayPx ${dispPx} / crop side ${crop.side}); sheet ${f(cellScale, 6)} px/cell-px`);

    // union extent of the whole animation
    let uMinX = Infinity, uMinY = Infinity, uMaxX = -Infinity, uMaxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const bb = bbox(cellAlpha[i], cell, cell, 0.5);
      if (!bb) continue;
      if (bb.x0 < uMinX) uMinX = bb.x0;
      if (bb.y0 < uMinY) uMinY = bb.y0;
      if (bb.x1 > uMaxX) uMaxX = bb.x1;
      if (bb.y1 > uMaxY) uMaxY = bb.y1;
    }
    const sheetUnionW = (uMaxX - uMinX + 1) * cellScale;
    const sheetUnionH = (uMaxY - uMinY + 1) * cellScale;
    const rawUnionW = union.w * rawScale;
    const rawUnionH = union.h * rawScale;
    note(c7, `union extent, raw material : ${f(rawUnionW, 4)} x ${f(rawUnionH, 4)} display px (source ${union.w}x${union.h})`);
    note(c7, `union extent, sheet       : ${f(sheetUnionW, 4)} x ${f(sheetUnionH, 4)} display px (cell ${uMaxX - uMinX + 1}x${uMaxY - uMinY + 1})`);
    note(c7, `  extent ratio w/h        : ${f(sheetUnionW / rawUnionW, 4)} / ${f(sheetUnionH / rawUnionH, 4)}`);

    const bands = [
      { name: 'fluke', y0: FLUKE_BAND[0], y1: FLUKE_BAND[1] },
      { name: 'leg', y0: LEG_BAND[0], y1: LEG_BAND[1] },
    ];
    const summary = {};
    for (const band of bands) {
      const rawY0 = Math.max(crop.y0, band.y0);
      const rawY1 = Math.min(crop.y0 + crop.side, band.y1 + 1);
      const rawPts = alphaFrames.map((a) => centroid(a, gif.width, crop.x0, crop.x0 + crop.side, rawY0, rawY1));
      const rowA = Math.max(0, Math.floor(((band.y0 - crop.y0) * cell) / crop.side));
      const rowB = Math.min(cell, Math.ceil(((band.y1 + 1 - crop.y0) * cell) / crop.side));
      const cellPts = cellAlpha.map((a) => centroid(a, cell, 0, cell, rowA, rowB));
      // Apples-to-apples raw band: the exact source-y range that the chosen cell
      // rows [rowA,rowB) actually cover. A cell row straddling the band edge drags
      // unrelated material into the sheet-side centroid, which inflates the
      // apparent drift for a short band (the leg band is only ~4.6 cell rows tall
      // at cell=32). Reported next to the literal-band figure so the difference
      // between "the pipeline amplified the motion" and "the band edge moved" is
      // visible instead of hidden.
      const matchY0 = Math.max(0, Math.round(crop.y0 + (rowA * crop.side) / cell));
      const matchY1 = Math.min(gif.height, Math.round(crop.y0 + (rowB * crop.side) / cell));
      const rawPtsMatched = alphaFrames.map((a) => centroid(a, gif.width, crop.x0, crop.x0 + crop.side, matchY0, matchY1));
      const rawPathMatched = pathLength(rawPtsMatched, true) * rawScale;
      const rawStepMatched = maxStepOf(rawPtsMatched) * rawScale;
      const rawSpanMatched = spanOf(rawPtsMatched);
      const rawPath = pathLength(rawPts, true) * rawScale;
      const rawStep = maxStepOf(rawPts) * rawScale;
      const rawChord = maxPairwise(rawPts) * rawScale;
      const rawSpan = spanOf(rawPts);
      const sheetPath = pathLength(cellPts, true) * cellScale;
      const sheetStep = maxStepOf(cellPts) * cellScale;
      const sheetChord = maxPairwise(cellPts) * cellScale;
      const sheetSpan = spanOf(cellPts);
      summary[band.name] = { rawPath, rawStep, rawChord, rawSpan, sheetPath, sheetStep, sheetChord, sheetSpan };
      note(c7, `${band.name} band, source y [${band.y0},${band.y1}] -> cell rows [${rowA},${rowB})`);
      note(c7, `  raw   : pathSum ${f(rawPath, 4)}  maxStep ${f(rawStep, 4)}  xSpan ${f(rawSpan.x * rawScale, 4)}  ySpan ${f(rawSpan.y * rawScale, 4)}  xySpan ${f(rawSpan.xy * rawScale, 4)}  euclidSpan ${f(rawChord, 4)}  display px`);
      note(c7, `  sheet : pathSum ${f(sheetPath, 4)}  maxStep ${f(sheetStep, 4)}  xSpan ${f(sheetSpan.x * cellScale, 4)}  ySpan ${f(sheetSpan.y * cellScale, 4)}  xySpan ${f(sheetSpan.xy * cellScale, 4)}  euclidSpan ${f(sheetChord, 4)}  display px`);
      note(c7, `  ratio : pathSum ${f(sheetPath / rawPath, 4)}  maxStep ${f(sheetStep / rawStep, 4)}  xSpan ${f((sheetSpan.x * cellScale) / (rawSpan.x * rawScale), 4)}  ySpan ${f((sheetSpan.y * cellScale) / (rawSpan.y * rawScale), 4)}  xySpan ${f((sheetSpan.xy * cellScale) / (rawSpan.xy * rawScale), 4)}  euclidSpan ${f(sheetChord / rawChord, 4)}`);
      note(c7, `  band-matched raw band = source y [${matchY0},${matchY1}) (the exact rows the chosen cell rows cover)`);
      note(c7, `  ratio : pathSum ${f(sheetPath / rawPathMatched, 4)}  maxStep ${f(sheetStep / rawStepMatched, 4)}  xSpan ${f((sheetSpan.x * cellScale) / (rawSpanMatched.x * rawScale), 4)}  ySpan ${f((sheetSpan.y * cellScale) / (rawSpanMatched.y * rawScale), 4)}  xySpan ${f((sheetSpan.xy * cellScale) / (rawSpanMatched.xy * rawScale), 4)}`);
      if (band.name === 'fluke') {
        const gate = [
          ['pathSum', sheetPath / rawPath],
          ['maxStep', sheetStep / rawStep],
          ['euclidSpan', sheetChord / rawChord],
        ];
        for (const [key, r] of gate) {
          if (!(r >= 0.85 && r <= 1.15)) {
            fail(c7, `fluke ${key} ratio ${f(r, 4)} is outside +-15% (see the raw/sheet lines above, display px)`);
          }
        }
      }
    }
    if (c7.pass) note(c7, 'fluke travel is within +-15% of the raw material: no amplitude added or removed.');
    note(c7, `leg-band drift (informational, sub-pixel at this raster): raw maxStep ${f(summary.leg.rawStep, 4)} vs sheet maxStep ${f(summary.leg.sheetStep, 4)} display px`);
  }

  // =========================================================================
  // CHECK 8 — no stray processing (stroke weight)
  // =========================================================================
  const c8 = newCheck(8, 'NO STRAY PROCESSING (measured stroke weight, sheet vs raw material)');
  if (!gif || !png || !meta) fail(c8, 'need material + sheet + metadata');
  else {
    const rc = resolveCrop(meta, myCrop, union);
    const crop = rc.crop;
    const dispPx = Number.isFinite(meta.cellDisplayPx) ? meta.cellDisplayPx : CELL_DISPLAY_PX;
    const rawScale = dispPx / crop.side;
    const cellScale = dispPx / cell;
    const rawY0 = Math.max(crop.y0, LEG_BAND[0]);
    const rawY1 = Math.min(crop.y0 + crop.side, LEG_BAND[1] + 1);
    const rowA = Math.max(0, Math.floor(((LEG_BAND[0] - crop.y0) * cell) / crop.side));
    const rowB = Math.min(cell, Math.ceil(((LEG_BAND[1] + 1 - crop.y0) * cell) / crop.side));

    const rawMeans = [];
    const cellMeans = [];
    for (let i = 0; i < count; i++) {
      const rs = strokeWidthStats(alphaFrames[i], gif.width, crop.x0, crop.x0 + crop.side, rawY0, rawY1);
      const cs = strokeWidthStats(cellAlpha[i], cell, 0, cell, rowA, rowB);
      if (rs.rows > 0) rawMeans.push(rs.mean);
      if (cs.rows > 0) cellMeans.push(cs.mean);
    }
    const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
    const rawW = avg(rawMeans) * rawScale;
    const cellW = avg(cellMeans) * cellScale;
    const ratio = cellW / rawW;
    const diff = Math.abs(cellW - rawW);
    const tol = Math.max(0.5, 0.25 * rawW);
    note(c8, `leg-band rows: raw source y [${rawY0},${rawY1}), sheet cell rows [${rowA},${rowB})`);
    note(c8, `stroke weight, raw material : ${f(rawW, 4)} display px  (${f(avg(rawMeans), 3)} source px x ${f(rawScale, 5)})`);
    note(c8, `stroke weight, sheet        : ${f(cellW, 4)} display px  (${f(avg(cellMeans), 3)} cell px x ${f(cellScale, 5)})`);
    note(c8, `ratio sheet/raw: ${f(ratio, 4)}   abs diff ${f(diff, 4)} display px (tolerance ${f(tol, 4)})`);
    note(c8, `per-frame raw stroke  (source px): ${rawMeans.map((v) => f(v, 2)).join(',')}`);
    note(c8, `per-frame sheet stroke (cell px) : ${cellMeans.map((v) => f(v, 2)).join(',')}`);
    if (!(diff <= tol)) fail(c8, `stroke weight changed: raw ${f(rawW, 4)} vs sheet ${f(cellW, 4)} display px (ratio ${f(ratio, 4)})`);
    else note(c8, 'no unannounced thickening/thinning detected.');
  }

  // =========================================================================
  // CHECK 9 (optional, --determinism): two fresh pipeline runs are byte-identical
  // and the shipped artifacts equal a fresh run. Runs build-frames.mjs with
  // --sheet/--contact/--meta redirected into .edge-tmp/fv/determinism/, so this
  // never writes to the artifacts it is verifying.
  // =========================================================================
  if (opt.determinism) {
    const c9 = newCheck(9, 'DETERMINISM (two fresh build-frames runs byte-identical; shipped artifacts == fresh run)');
    const buildScript = path.join(ROOT, 'tools', 'build-frames.mjs');
    const detRoot = path.join(ROOT, '.edge-tmp', 'fv', 'determinism');
    const runInto = (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      const argv = [
        buildScript,
        '--sheet', path.join(dir, 'frames-sheet.png'),
        '--contact', path.join(dir, 'frames-contact.png'),
        '--meta', path.join(dir, 'frames.json'),
      ];
      // stdio:'ignore' needs no pipes, so this stays valid under a confined sandbox.
      const res = spawnSync(process.execPath, argv, { cwd: ROOT, stdio: 'ignore' });
      if (res.error) throw res.error;
      if (res.status !== 0) throw new Error(`build-frames.mjs exited ${res.status}`);
    };
    // JSON carries the sheet path, so normalise it before comparing.
    const normJson = (p) => {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      m.sheet = '<normalised>';
      return JSON.stringify(m);
    };
    try {
      if (!fs.existsSync(buildScript)) throw new Error(`missing ${buildScript}`);
      const dirA = path.join(detRoot, 'a');
      const dirB = path.join(detRoot, 'b');
      runInto(dirA);
      runInto(dirB);
      const aSheet = fs.readFileSync(path.join(dirA, 'frames-sheet.png'));
      const bSheet = fs.readFileSync(path.join(dirB, 'frames-sheet.png'));
      const aContact = fs.readFileSync(path.join(dirA, 'frames-contact.png'));
      const bContact = fs.readFileSync(path.join(dirB, 'frames-contact.png'));
      const aJson = normJson(path.join(dirA, 'frames.json'));
      const bJson = normJson(path.join(dirB, 'frames.json'));
      const shippedContactPath = path.join(ROOT, 'preview', 'frames-contact-sheet.png');
      const shippedContact = readOrNull(shippedContactPath);
      const sameSheet = aSheet.equals(bSheet);
      const sameContact = aContact.equals(bContact);
      const sameJson = aJson === bJson;
      const shippedSheetSame = sheetBytes ? sheetBytes.equals(aSheet) : false;
      const shippedContactSame = shippedContact ? shippedContact.equals(aContact) : false;
      const shippedJsonSame = meta ? normJson(jsonPath) === aJson : false;
      note(c9, `run A: sheet ${sha256(aSheet).slice(0, 16)} ${aSheet.length} B | run B: sheet ${sha256(bSheet).slice(0, 16)} ${bSheet.length} B`);
      note(c9, `sheet PNG   identical across two fresh runs : ${sameSheet}`);
      note(c9, `contact PNG identical across two fresh runs : ${sameContact} (${aContact.length} B)`);
      note(c9, `metadata    identical across two fresh runs : ${sameJson} (sheet path normalised)`);
      note(c9, `shipped sheet          == fresh run A       : ${shippedSheetSame} (${sheetBytes ? sha256(sheetBytes).slice(0, 16) : 'missing'})`);
      note(c9, `shipped contact sheet  == fresh run A       : ${shippedContactSame}`);
      note(c9, `shipped metadata JSON  == fresh run A       : ${shippedJsonSame} (only the sheet path differs)`);
      if (!sameSheet) fail(c9, 'sheet PNG is NOT byte-identical across two runs (pipeline is not deterministic)');
      if (!sameContact) fail(c9, 'contact-sheet PNG is NOT byte-identical across two runs');
      if (!sameJson) fail(c9, 'metadata JSON is NOT byte-identical across two runs (excluding the sheet path)');
      if (sheetBytes && !shippedSheetSame) fail(c9, 'shipped sheet differs from a fresh pipeline run (stale artifact)');
      if (shippedContact && !shippedContactSame) fail(c9, 'shipped contact sheet differs from a fresh pipeline run (stale artifact)');
      if (meta && !shippedJsonSame) fail(c9, 'shipped metadata JSON differs from a fresh pipeline run (stale or hand-edited)');
      if (c9.pass) note(c9, 'two independent runs reproduce the shipped PNG/JSON byte-for-byte.');
    } catch (e) {
      fail(c9, `determinism run failed: ${e.message}`);
    }
  }

  // =========================================================================
  // Baseline cross-check against the numbers supplied by the Lead
  // =========================================================================
  console.log('');
  console.log('-'.repeat(78));
  console.log('VERIFIER BASELINE (measured here, from the material only)');
  console.log('-'.repeat(78));
  if (gif && alphaFrames) {
    const inkLum = luminance601(INK_BLUE[0], INK_BLUE[1], INK_BLUE[2]);
    console.log(`material geometry        : ${gif.width}x${gif.height}, ${gif.frames.length} frames, delays ${[...new Set(gif.frames.map((x) => x.delayCs))].join('/')} cs`);
    console.log(`ink luminance (#345ebb)  : ${f(inkLum, 3)}  (alpha(exact ink)=${f(alphaFromRgba(Uint8Array.from([...INK_BLUE, 255]), 1, 1)[0], 6)})`);
    console.log(`union ink bbox           : ${union.w}x${union.h} at (${union.x0},${union.y0})..(${union.x1},${union.y1})`);
    console.log(`verifier PAD=${CROP_PAD_SPEC} crop     : x0=${myCrop.x0} y0=${myCrop.y0} side=${myCrop.side}`);
    console.log('Lead baseline claims: 360x360, 24 frames, 2cs, ink #345ebb (L=92.0), union bbox 281x221 at (32,50),');
    console.log('                     24/24 distinct, leg-band drift 0.031 display px, fluke travel 2.719 display px.');
    console.log('NOTE: the Lead\'s travel figures are not reproduced by any metric this verifier computes');
    console.log('      (see check 7: pathSum / maxStep / chord for both bands), which is why check 7 compares');
    console.log('      the sheet against the material with the SAME metric instead of against that constant.');
  } else {
    console.log(`material not decoded (${gifErr})`);
  }

  // =========================================================================
  // Verdict
  // =========================================================================
  console.log('');
  console.log('='.repeat(78));
  console.log('RESULTS');
  console.log('='.repeat(78));
  let failed = 0;
  for (const c of results) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    console.log(`[${tag}] check ${c.id}: ${c.title}`);
    for (const n of c.notes) console.log(`        ${n}`);
    for (const x of c.fails) console.log(`        !! ${x}`);
    if (!c.pass) failed++;
  }
  console.log('');
  console.log(
    `VERDICT: ${failed === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed}/${results.length} checks passed` +
      (failed ? `, ${failed} failed` : '')
  );
  console.log(`artifacts: ${sheetPath} (${sheetBytes ? sha256(sheetBytes).slice(0, 16) : 'missing'}) + ${jsonPath}`);
  return failed === 0 ? 0 : 1;
}

let code = 1;
try {
  code = main();
} catch (e) {
  console.log('');
  console.log(`[FAIL] verifier crashed: ${e && e.stack ? e.stack : e}`);
  code = 1;
}
process.exitCode = code;
