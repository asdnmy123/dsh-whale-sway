/**
 * build-frames.mjs — the frame pipeline for the whale sway sprite sheet.
 *
 * The shipped animation must be the user's own artwork, not a redraw: this tool
 * decodes the material GIF (`preview/2C42C558D17C2745D1D47ED3DE000BD2.gif`) with
 * the in-repo GIF89a decoder, removes the opaque white background by turning ink
 * coverage into an alpha channel, crops that ink to a padded square, box-filters
 * the square down to a small square cell, and writes:
 *
 *   preview/frames-sheet.png            vertical strip, one cell per frame
 *   preview/frames-contact-sheet.png    magnified QC grid for human eyes
 *   tools/generated/frames.json         metadata + the sheet itself as base64
 *
 * Everything downstream (client.js) reads only those artifacts, so this file is
 * the single source of truth for "what the whale looks like".
 *
 * Processing, exactly:
 *
 *   L      = 0.299 R + 0.587 G + 0.114 B                  (Rec.601 luminance)
 *   a      = clamp((255 - L) / (255 - 92.0), 0, 1)        (92.0 = ink #345ebb)
 *   alpha  = clamp((a - 0.02) / 0.96, 0, 1)               (contrast clean)
 *
 * The crop is the union of every frame's ink bbox (alpha > 0.5) grown by PAD
 * source pixels on all four sides and squared off around that bbox centre. The
 * square is resampled to `cell` x `cell` with an exact area-weighted box filter;
 * `cell` is the smallest of {32, 40, 48} whose base64 fits the 20000-char budget.
 *
 * PAD is 12, not the spec's suggested 4. At cell=32 one cell pixel spans
 * side/cell = 9.5 source px, so a 4 px pad leaves the outermost cell pixel
 * genuinely inked (worst alpha 144/255 across 11 of 24 frames): the box filter
 * integrates the pad into that pixel. The spec demands BOTH alpha == 0 on all
 * four cell edges AND a >= 2 source px ink margin, and PAD is a floor rather
 * than a target, so 12 is the smallest compliant value for cell 32 (ink then
 * starts 12 px inside the crop, clear of the outermost pixel) while the ink
 * itself is still fully uncropped.
 *
 * Determinism: pure functions, no clocks, no randomness, fixed DEFLATE level,
 * frames kept in material order. `node tools/build-frames.mjs` twice in a row
 * must produce byte-identical PNGs and JSON.
 *
 * Usage:
 *   node tools/build-frames.mjs [--src path] [--pad n] [--expect-count n]
 *                               [--sheet path] [--contact path] [--meta path]
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeGif } from './lib/gif-decode.mjs';
import { encodePng } from './lib/png-encode.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Paths, relative to the repo root, of the default inputs and outputs. */
export const DEFAULTS = {
  source: 'preview/2C42C558D17C2745D1D47ED3DE000BD2.gif',
  sheet: 'preview/frames-sheet.png',
  contact: 'preview/frames-contact-sheet.png',
  meta: 'tools/generated/frames.json',
};

/** The ink colour every written pixel is tinted with. */
export const INK_RGB = [52, 94, 187];
/** Rec.601 luminance of #345ebb: 0.299*52 + 0.587*94 + 0.114*187 = 92.044. */
export const INK_LUMINANCE = 92.0;
/** Contrast clean: alpha <= 0.02 becomes exactly 0, so white dither haze dies. */
export const ALPHA_FLOOR = 0.02;
export const ALPHA_SPAN = 0.96;
/** CSS box the cell is drawn into, inside a 14px slot with a 1px inset. */
export const CELL_DISPLAY_PX = 16;
export const SLOT_INSET_PX = 1;
/**
 * Crop padding in source pixels: 12 is the smallest value that keeps the
 * outermost cell pixel clear at cell 32 (see the header note). MIN_PAD is the
 * floor the spec allows.
 */
export const DEFAULT_PAD = 12;
export const MIN_PAD = 2;
/** Minimum pad that clears the cell edge, per candidate raster (side/cell). */
export const MIN_CLEAN_PAD = { 32: 12, 40: 10, 48: 8 };
/** Cell rasters to try, in preference order, and the base64 budget. */
export const CELL_CANDIDATES = [32, 40, 48];
export const BASE64_BUDGET = 20000;
/** Ink threshold for bbox/masking decisions, in coverage units. */
export const INK_THRESHOLD = 0.5;
/** Source rows used by the motion report, inclusive. */
export const LEG_BAND = [235, 278];
export const FLUKE_BAND = [50, 180];
/** Contact-sheet layout. */
export const CONTACT = { magnification: 6, columns: 6, gutter: 4, check: 4 };

/** Human-readable record of the alpha formula, shipped in frames.json. */
export const ALPHA_MODEL =
  'alpha = clamp((clamp((255 - L) / (255 - 92.0), 0, 1) - 0.02) / 0.96, 0, 1) with ' +
  'L = 0.299*R + 0.587*G + 0.114*B (Rec.601 luminance); 92.0 is the Rec.601 ' +
  'luminance of the ink colour #345ebb (52,94,187); alpha byte = round(alpha * 255). ' +
  'Pure white (255,255,255) -> L = 255 -> alpha 0.';

const CONTACT_BACKDROP = [18, 20, 26];
const CONTACT_CHECKER = [
  [232, 234, 240],
  [198, 202, 214],
];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function fail(message) {
  throw new Error(`build-frames: ${message}`);
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Fixed-precision rounding so JSON output is stable and readable. */
export function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toPosix(path) {
  return path.split('\\').join('/');
}

/** A repo-relative posix path when the target lives inside the repo. */
function repoRelative(absolute) {
  const rel = relative(ROOT, absolute);
  if (rel === '') return '.';
  return isAbsolute(rel) || rel.startsWith('..') ? toPosix(absolute) : toPosix(rel);
}

/** Rec.601 luminance of one RGB triple. */
export function luminance601(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** The pipeline's white-removal function: RGB -> coverage alpha in [0,1]. */
export function inkAlpha(r, g, b) {
  const raw = (255 - luminance601(r, g, b)) / (255 - INK_LUMINANCE);
  return clamp01((clamp01(raw) - ALPHA_FLOOR) / ALPHA_SPAN);
}

/** Alpha in [0,1] for every pixel of an RGBA frame. */
export function coverageMap(rgba, width, height) {
  const out = new Float64Array(width * height);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = inkAlpha(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  return out;
}

/**
 * Bounding box of the pixels above `threshold` in a coverage map.
 * `x1`/`y1` are inclusive; `width`/`height` are the box's span.
 */
export function coverageBBox(alpha, width, height, threshold = INK_THRESHOLD) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (alpha[row + x] > threshold) {
        count += 1;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (count === 0) return null;
  return { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1, count };
}

/** Union of per-frame bboxes (or null when nothing has ink). */
export function unionBBox(boxes) {
  const present = boxes.filter(Boolean);
  if (present.length === 0) return null;
  const x0 = Math.min(...present.map((b) => b.x0));
  const y0 = Math.min(...present.map((b) => b.y0));
  const x1 = Math.max(...present.map((b) => b.x1));
  const y1 = Math.max(...present.map((b) => b.y1));
  return { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * Square crop window: the union bbox centre, side = max(w,h) + 2*pad, clamped to
 * the image. Returned coordinates are the top-left corner in source pixels.
 */
export function cropWindow(union, pad, imageWidth, imageHeight) {
  const side = Math.max(union.width, union.height) + 2 * pad;
  if (side > imageWidth || side > imageHeight) {
    fail(`crop side ${side} does not fit the ${imageWidth}x${imageHeight} material`);
  }
  const centreX = (union.x0 + union.x1 + 1) / 2;
  const centreY = (union.y0 + union.y1 + 1) / 2;
  const x0 = Math.min(Math.max(0, Math.round(centreX - side / 2)), imageWidth - side);
  const y0 = Math.min(Math.max(0, Math.round(centreY - side / 2)), imageHeight - side);
  return { x0, y0, side };
}

/** Source-pixel margin from one frame's ink box to the crop edges. */
export function boxMargin(box, crop) {
  return {
    left: box.x0 - crop.x0,
    top: box.y0 - crop.y0,
    right: crop.x0 + crop.side - 1 - box.x1,
    bottom: crop.y0 + crop.side - 1 - box.y1,
  };
}

/**
 * Exact area-weighted box resample of the square [x0,x0+side) x [y0,y0+side)
 * into a cell x cell grid. Each destination pixel is the coverage-weighted mean
 * of the source area it covers, so ink area is conserved and downscaling is
 * linear (no ringing, no aliasing beyond what box filtering inherently has).
 */
export function boxResample(source, sourceWidth, sourceHeight, x0, y0, side, cell) {
  const out = new Float64Array(cell * cell);
  for (let j = 0; j < cell; j += 1) {
    const sy0 = y0 + (j * side) / cell;
    const sy1 = y0 + ((j + 1) * side) / cell;
    const iy0 = Math.max(0, Math.floor(sy0));
    const iy1 = Math.min(sourceHeight - 1, Math.ceil(sy1) - 1);
    for (let i = 0; i < cell; i += 1) {
      const sx0 = x0 + (i * side) / cell;
      const sx1 = x0 + ((i + 1) * side) / cell;
      const ix0 = Math.max(0, Math.floor(sx0));
      const ix1 = Math.min(sourceWidth - 1, Math.ceil(sx1) - 1);
      let acc = 0;
      let weight = 0;
      for (let y = iy0; y <= iy1; y += 1) {
        const wy = Math.min(y + 1, sy1) - Math.max(y, sy0);
        if (wy <= 0) continue;
        const row = y * sourceWidth;
        for (let x = ix0; x <= ix1; x += 1) {
          const wx = Math.min(x + 1, sx1) - Math.max(x, sx0);
          if (wx <= 0) continue;
          acc += source[row + x] * wx * wy;
          weight += wx * wy;
        }
      }
      out[j * cell + i] = weight > 0 ? acc / weight : 0;
    }
  }
  return out;
}

/** Quantize a cell's float coverage to the bytes the PNG will carry. */
export function quantizeCell(cellAlpha) {
  const out = new Uint8Array(cellAlpha.length);
  for (let i = 0; i < cellAlpha.length; i += 1) {
    out[i] = Math.round(cellAlpha[i] * 255);
  }
  return out;
}

/** Stack the quantized cells into the vertical RGBA strip. */
export function buildSheet(cellBytes, cell) {
  const count = cellBytes.length;
  const rgba = new Uint8ClampedArray(cell * cell * count * 4);
  for (let frame = 0; frame < count; frame += 1) {
    const tile = cellBytes[frame];
    const base = frame * cell * cell;
    for (let p = 0; p < tile.length; p += 1) {
      const at = (base + p) * 4;
      rgba[at] = INK_RGB[0];
      rgba[at + 1] = INK_RGB[1];
      rgba[at + 2] = INK_RGB[2];
      rgba[at + 3] = tile[p];
    }
  }
  return rgba;
}

/** Magnified grid of every cell over a checkerboard, for eyeball QC. */
export function buildContactSheet(
  cellBytes,
  cell,
  layout = CONTACT,
  backdrop = CONTACT_BACKDROP,
) {
  const { magnification, columns, gutter, check } = layout;
  const rows = Math.ceil(cellBytes.length / columns);
  const tile = cell * magnification;
  const width = columns * tile + (columns + 1) * gutter;
  const height = rows * tile + (rows + 1) * gutter;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    rgba[p * 4] = backdrop[0];
    rgba[p * 4 + 1] = backdrop[1];
    rgba[p * 4 + 2] = backdrop[2];
    rgba[p * 4 + 3] = 255;
  }
  for (let frame = 0; frame < cellBytes.length; frame += 1) {
    const tile_ = cellBytes[frame];
    const originX = gutter + (frame % columns) * (tile + gutter);
    const originY = gutter + Math.floor(frame / columns) * (tile + gutter);
    for (let y = 0; y < tile; y += 1) {
      const sy = Math.floor(y / magnification);
      for (let x = 0; x < tile; x += 1) {
        const sx = Math.floor(x / magnification);
        const a = tile_[sy * cell + sx] / 255;
        const checker = ((Math.floor(x / check) + Math.floor(y / check)) & 1) === 0;
        const base = checker ? CONTACT_CHECKER[0] : CONTACT_CHECKER[1];
        const at = ((originY + y) * width + originX + x) * 4;
        rgba[at] = Math.round(base[0] + (INK_RGB[0] - base[0]) * a);
        rgba[at + 1] = Math.round(base[1] + (INK_RGB[1] - base[1]) * a);
        rgba[at + 2] = Math.round(base[2] + (INK_RGB[2] - base[2]) * a);
        rgba[at + 3] = 255;
      }
    }
  }
  return { width, height, rgba };
}

/** Coverage-weighted centroid over source rows [y0,y1] inclusive. */
export function bandCentroid(alpha, width, y0, y1) {
  let weight = 0;
  let sx = 0;
  let sy = 0;
  for (let y = y0; y <= y1; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const v = alpha[row + x];
      if (v <= 0) continue;
      weight += v;
      sx += v * (x + 0.5);
      sy += v * (y + 0.5);
    }
  }
  if (weight <= 0) return null;
  return { x: sx / weight, y: sy / weight, weight };
}

/** Per-frame distance from frame 0, scaled into display pixels. */
function displacementSeries(centroids, scale) {
  const first = centroids[0];
  const series = [];
  for (let i = 0; i < centroids.length; i += 1) {
    const point = centroids[i];
    if (!point || !first) {
      series.push(0);
      continue;
    }
    series.push(round(Math.hypot(point.x - first.x, point.y - first.y) * scale));
  }
  return series;
}

/** Closed-loop path length of a centroid track, in display pixels. */
function pathLength(centroids, scale) {
  let total = 0;
  for (let i = 0; i < centroids.length; i += 1) {
    const a = centroids[i];
    const b = centroids[(i + 1) % centroids.length];
    if (!a || !b) continue;
    total += Math.hypot(b.x - a.x, b.y - a.y) * scale;
  }
  return round(total);
}

function maxOf(series) {
  return series.reduce((m, v) => (v > m ? v : m), 0);
}

/** Distinct-cell report: sha256 of each cell's alpha bytes plus min Hamming. */
export function distinctCells(cellBytes) {
  const hashes = cellBytes.map((cell) => sha256Hex(cell));
  const distinct = new Set(hashes).size;
  let minHamming = Infinity;
  let closest = null;
  for (let i = 0; i < cellBytes.length; i += 1) {
    for (let j = i + 1; j < cellBytes.length; j += 1) {
      let differing = 0;
      for (let p = 0; p < cellBytes[i].length; p += 1) {
        if (cellBytes[i][p] !== cellBytes[j][p]) differing += 1;
      }
      if (differing < minHamming) {
        minHamming = differing;
        closest = [i, j];
      }
    }
  }
  return { hashes, distinct, minHamming, closest };
}

/** Border check: the outermost row/column of every cell must be fully clear. */
export function borderReport(cellBytes, cell) {
  let maxAlpha = 0;
  let framesWithInk = 0;
  const offenders = [];
  const perFrameMaxBorderAlpha = [];
  for (let frame = 0; frame < cellBytes.length; frame += 1) {
    const tile = cellBytes[frame];
    let worst = 0;
    for (let i = 0; i < cell; i += 1) {
      const edges = [
        tile[i],
        tile[(cell - 1) * cell + i],
        tile[i * cell],
        tile[i * cell + cell - 1],
      ];
      for (const v of edges) if (v > worst) worst = v;
    }
    perFrameMaxBorderAlpha.push(worst);
    if (worst > 0) {
      framesWithInk += 1;
      offenders.push({ frame, maxBorderAlpha: worst });
    }
    if (worst > maxAlpha) maxAlpha = worst;
  }
  return {
    ok: framesWithInk === 0 && maxAlpha === 0,
    maxBorderAlpha: maxAlpha,
    framesWithInk,
    offenders,
    perFrameMaxBorderAlpha,
  };
}

// ---------------------------------------------------------------------------
// the pipeline
// ---------------------------------------------------------------------------

/**
 * Run the whole pipeline for one material buffer and return everything the CLI
 * writes plus the report it prints. Pure with respect to the filesystem.
 */
export function buildFrames(material, options = {}) {
  const pad = options.pad === undefined ? DEFAULT_PAD : options.pad;
  const expectCount = options.expectCount === undefined ? 24 : options.expectCount;
  const candidates = options.candidates || CELL_CANDIDATES;
  if (!Number.isInteger(pad) || pad < MIN_PAD) fail(`--pad must be an integer >= ${MIN_PAD}`);

  const gif = decodeGif(material);
  const { width, height, frames } = gif;
  const count = frames.length;
  if (count !== expectCount) {
    fail(`material holds ${count} frames, expected ${expectCount}`);
  }

  // --- white removal ------------------------------------------------------
  const coverage = frames.map((frame) => coverageMap(frame.rgba, width, height));
  const frameBoxes = coverage.map((alpha) => coverageBBox(alpha, width, height));
  if (frameBoxes.some((box) => box === null)) fail('a frame has no ink above the threshold');
  const union = unionBBox(frameBoxes);

  // --- crop ---------------------------------------------------------------
  const crop = cropWindow(union, pad, width, height);
  const margins = frameBoxes.map((box) => boxMargin(box, crop));
  const worstMargin = { value: Infinity, frame: -1 };
  for (let i = 0; i < margins.length; i += 1) {
    const m = margins[i];
    const value = Math.min(m.left, m.top, m.right, m.bottom);
    if (value < worstMargin.value) {
      worstMargin.value = value;
      worstMargin.frame = i;
    }
  }

  // --- rasters ------------------------------------------------------------
  const rasterTrials = candidates.map((cell) => {
    const floatCells = coverage.map((alpha) =>
      boxResample(alpha, width, height, crop.x0, crop.y0, crop.side, cell),
    );
    const cells = floatCells.map(quantizeCell);
    const sheet = buildSheet(cells, cell);
    const png = encodePng(cell, cell * count, sheet);
    return { cell, cells, sheet, png, base64: png.toString('base64') };
  });
  const affordable = rasterTrials.find((trial) => trial.base64.length <= BASE64_BUDGET);
  const chosen = affordable || rasterTrials.find((trial) => trial.cell === 32) || rasterTrials[0];

  const cell = chosen.cell;
  const cells = chosen.cells;
  const sheetPng = chosen.png;
  const pngBase64 = chosen.base64;
  const sheetSha256 = sha256Hex(sheetPng);

  // Encoding twice must produce identical bytes; the second run of the CLI is
  // the real proof, but this catches a stray non-deterministic dependency.
  const encodedAgain = encodePng(cell, cell * count, chosen.sheet);
  const pngStable = encodedAgain.equals(sheetPng);

  // --- contact sheet ------------------------------------------------------
  const contact = buildContactSheet(cells, cell);
  const contactPng = encodePng(contact.width, contact.height, contact.rgba);

  // --- assertions / measurements -----------------------------------------
  const distinct = distinctCells(cells);
  const border = borderReport(cells, cell);

  let pureWhitePixels = 0;
  let pureWhiteNonZeroAlpha = 0;
  let inkPixels = 0;
  let inkPixelsBelowFull = 0;
  const maxAlphaByPixel = { pureWhite: 0 };
  const alphaFrame = frames.map((frame) => coverageMap(frame.rgba, width, height));
  for (let f = 0; f < frames.length; f += 1) {
    const rgba = frames[f].rgba;
    const alpha = alphaFrame[f];
    for (let p = 0; p < width * height; p += 1) {
      const r = rgba[p * 4];
      const g = rgba[p * 4 + 1];
      const b = rgba[p * 4 + 2];
      if (r === 255 && g === 255 && b === 255) {
        pureWhitePixels += 1;
        if (alpha[p] !== 0) {
          pureWhiteNonZeroAlpha += 1;
          if (alpha[p] > maxAlphaByPixel.pureWhite) maxAlphaByPixel.pureWhite = alpha[p];
        }
      }
      if (r === INK_RGB[0] && g === INK_RGB[1] && b === INK_RGB[2]) {
        inkPixels += 1;
        if (alpha[p] < 1) inkPixelsBelowFull += 1;
      }
    }
  }

  // --- motion metrics (source bands, reported in display pixels) ----------
  const displayScale = CELL_DISPLAY_PX / crop.side;
  const legCentroids = alphaFrame.map((alpha) => bandCentroid(alpha, width, LEG_BAND[0], LEG_BAND[1]));
  const flukeCentroids = alphaFrame.map((alpha) => bandCentroid(alpha, width, FLUKE_BAND[0], FLUKE_BAND[1]));
  const rootDrift = displacementSeries(legCentroids, displayScale);
  const flukeTravel = displacementSeries(flukeCentroids, displayScale);

  const delays = frames.map((frame) => frame.delayCs);
  const details = gif.info.frameDetails;

  const report = {
    material: {
      path: options.source,
      bytes: material.length,
      sha256: sha256Hex(material),
      version: gif.info.version,
      width,
      height,
      frames: count,
      delayCs: delays,
      delaysUniform: delays.every((d) => d === delays[0]),
      globalTableSize: gif.info.globalTableSize,
      backgroundIndex: gif.info.backgroundIndex,
      backgroundRgb: gif.info.background,
      loopCount: gif.info.loopCount,
      disposalMethods: [...new Set(details.map((d) => d.disposal))],
      transparentIndexes: [...new Set(details.map((d) => d.transparentIndex))],
      interlaced: details.some((d) => d.interlaced),
      localTables: details.filter((d) => d.localTable).length,
      minCodeSizes: [...new Set(details.map((d) => d.minCodeSize))],
      frameRectangles: [...new Set(details.map((d) => `${d.width}x${d.height}+${d.left}+${d.top}`))],
    },
    alphaModel: ALPHA_MODEL,
    alphaSpan: 255 - INK_LUMINANCE,
    whiteRemoval: {
      pureWhitePixels,
      pureWhiteNonZeroAlpha,
      maxAlphaOnPureWhite: maxAlphaByPixel.pureWhite,
      inkPixels,
      inkPixelsBelowFullAlpha: inkPixelsBelowFull,
    },
    inkCoverage: {
      perFramePixels: frameBoxes.map((b) => b.count),
      unionInkBBox: union,
      unionInkPixels: coverage.reduce((sum, alpha) => {
        let n = 0;
        for (let p = 0; p < alpha.length; p += 1) if (alpha[p] > INK_THRESHOLD) n += 1;
        return sum + n;
      }, 0),
    },
    crop: { x0: crop.x0, y0: crop.y0, side: crop.side, scaleToCell: cell / crop.side },
    pad,
    margins: {
      requiredSourcePx: 2,
      worstSourcePx: worstMargin.value,
      worstFrame: worstMargin.frame,
      perFrame: margins,
    },
    scale: { displayScale: round(displayScale, 6), cellSourceScale: round(cell / crop.side, 6) },
    raster: {
      chosen: cell,
      budget: BASE64_BUDGET,
      trials: rasterTrials.map((trial) => ({
        cell: trial.cell,
        pngBytes: trial.png.length,
        base64Chars: trial.base64.length,
        fits: trial.base64.length <= BASE64_BUDGET,
      })),
    },
    sheet: {
      width: cell,
      height: cell * count,
      pngBytes: sheetPng.length,
      base64Chars: pngBase64.length,
      sha256: sheetSha256,
      colorType: 6,
      bitDepth: 8,
    },
    contactSheet: {
      width: contact.width,
      height: contact.height,
      pngBytes: contactPng.length,
      magnification: CONTACT.magnification,
      columns: CONTACT.columns,
    },
    distinctCells: {
      distinct: distinct.distinct,
      hashes: distinct.hashes,
      minHammingDistance: distinct.minHamming === Infinity ? 0 : distinct.minHamming,
      closestPair: distinct.closest,
    },
    cellBorder: {
      ok: border.ok,
      maxBorderAlpha: border.maxBorderAlpha,
      framesWithBorderInk: border.framesWithInk,
      perFrameMaxBorderAlpha: border.perFrameMaxBorderAlpha,
      offenders: border.offenders,
    },
    motion: {
      unit: 'display px (cellDisplayPx / cropSide)',
      legBandRows: LEG_BAND,
      flukeBandRows: FLUKE_BAND,
      legCentroidSourcePx: legCentroids.map((c) => (c ? { x: round(c.x, 3), y: round(c.y, 3) } : null)),
      flukeCentroidSourcePx: flukeCentroids.map((c) => (c ? { x: round(c.x, 3), y: round(c.y, 3) } : null)),
      rootDriftSeries: rootDrift,
      flukeTravelSeries: flukeTravel,
      rootDriftMax: maxOf(rootDrift),
      flukeTravelMax: maxOf(flukeTravel),
      rootDriftPath: pathLength(legCentroids, displayScale),
      flukeTravelPath: pathLength(flukeCentroids, displayScale),
    },
    deterministic: { pngStable, framesInMaterialOrder: true },
  };

  return { report, crop, cell, cells, sheetPng, contactPng, pngBase64, sheetSha256 };
}

/** Build the frames.json object (metadata order matches the task schema). */
export function buildMetadata(built, options) {
  const { report } = built;
  return {
    source: report.material.path,
    sourceSha256: report.material.sha256,
    count: report.material.frames,
    cell: built.cell,
    cellDisplayPx: CELL_DISPLAY_PX,
    slotInsetPx: SLOT_INSET_PX,
    sheet: options.sheet,
    sheetSha256: built.sheetSha256,
    pngBase64: built.pngBase64,
    alphaModel: ALPHA_MODEL,
    crop: built.report.crop,
    report,
  };
}

/** Parse the CLI's argv (without `node script`). */
export function parseArgs(argv) {
  const options = { ...DEFAULTS, pad: DEFAULT_PAD, expectCount: 24, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length) fail(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--src') options.source = value();
    else if (arg === '--sheet') options.sheet = value();
    else if (arg === '--contact') options.contact = value();
    else if (arg === '--meta') options.meta = value();
    else if (arg === '--pad') options.pad = Number(value());
    else if (arg === '--expect-count') options.expectCount = Number(value());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else fail(`unknown argument ${arg}`);
  }
  return options;
}

function formatBytes(n) {
  return `${n} B (${(n / 1024).toFixed(1)} KiB)`;
}

/** Print the full report the task asks for. */
export function printReport(built, options, written) {
  const { report } = built;
  const line = (label, value) => console.log(`  ${label.padEnd(30)} ${value}`);
  const assertion = (ok, label, detail) =>
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`);

  console.log('material');
  line('path', report.material.path);
  line('sha256', report.material.sha256);
  line('format', `${report.material.version} ${report.material.width}x${report.material.height}`);
  line('bytes', formatBytes(report.material.bytes));
  line('frames', `${report.material.frames} (delays ${report.material.delayCs.join(',')} cs)`);
  line('colour table', `${report.material.globalTableSize} entries, background index ${report.material.backgroundIndex} = rgb(${report.material.backgroundRgb.join(',')})`);
  line('disposal / transparent', `${report.material.disposalMethods.join(',')} / ${report.material.transparentIndexes.join(',')}`);
  line('frame rectangles', report.material.frameRectangles.join(' '));

  console.log('\nalpha model');
  console.log(`  ${ALPHA_MODEL}`);

  console.log('\nwhite removal');
  line('pure white pixels', report.whiteRemoval.pureWhitePixels);
  line('pure white -> alpha != 0', report.whiteRemoval.pureWhiteNonZeroAlpha);
  line('ink pixels (#345ebb)', report.whiteRemoval.inkPixels);
  line('ink pixels below alpha 1', report.whiteRemoval.inkPixelsBelowFullAlpha);

  console.log('\nink + crop');
  line('union ink bbox', `${report.inkCoverage.unionInkBBox.width}x${report.inkCoverage.unionInkBBox.height} at (${report.inkCoverage.unionInkBBox.x0},${report.inkCoverage.unionInkBBox.y0})`);
  line('crop', `${report.crop.side}x${report.crop.side} at (${report.crop.x0},${report.crop.y0}), pad ${report.pad}`);
  line('scale to cell', `${report.crop.scaleToCell.toFixed(6)} src px per cell px`);
  line('display scale', `${report.scale.displayScale} px_disp per px_src`);
  line('worst ink margin', `${report.margins.worstSourcePx} source px (frame ${report.margins.worstFrame})`);

  console.log('\ncell raster');
  for (const trial of report.raster.trials) {
    line(`${trial.cell}px`, `${formatBytes(trial.pngBytes)}, base64 ${trial.base64Chars} chars${trial.fits ? '' : ' (over budget)'}`);
  }
  line('chosen', `${report.raster.chosen}px`);

  console.log('\nassertions');
  assertion(
    report.material.frames === options.expectCount,
    `frame count is ${options.expectCount}`,
    `${report.material.frames}`,
  );
  assertion(
    report.distinctCells.distinct === report.material.frames,
    `all ${report.material.frames} cells distinct at ${report.raster.chosen}px`,
    `${report.distinctCells.distinct} distinct, min Hamming ${report.distinctCells.minHammingDistance} (frames ${report.distinctCells.closestPair?.join(' vs ')})`,
  );
  assertion(
    report.margins.worstSourcePx >= report.margins.requiredSourcePx,
    `every frame's ink is >= ${report.margins.requiredSourcePx} source px inside the crop`,
    `worst ${report.margins.worstSourcePx} px (frame ${report.margins.worstFrame})`,
  );
  assertion(
    report.cellBorder.ok,
    'cell border alpha is exactly 0 on all four edges of every cell',
    report.cellBorder.ok
      ? `all ${report.material.frames} cells clear, max border alpha ${report.cellBorder.maxBorderAlpha}`
      : `${report.cellBorder.framesWithBorderInk} cells inked, max border alpha ${report.cellBorder.maxBorderAlpha}`,
  );
  assertion(
    report.whiteRemoval.pureWhiteNonZeroAlpha === 0,
    'pure-white material pixels map to alpha 0',
    `${report.whiteRemoval.pureWhitePixels} pixels checked`,
  );
  assertion(
    report.whiteRemoval.inkPixelsBelowFullAlpha === 0,
    'full-ink pixels reach alpha 255',
    `${report.whiteRemoval.inkPixels} pixels checked`,
  );
  assertion(report.deterministic.pngStable, 'PNG encoding is deterministic in-process');
  assertion(
    report.sheet.width === report.raster.chosen && report.sheet.height === report.raster.chosen * report.material.frames,
    'sheet geometry is cell x (frames * cell)',
    `${report.sheet.width}x${report.sheet.height}`,
  );
  assertion(
    report.sheet.base64Chars <= report.raster.budget,
    `base64 <= ${report.raster.budget} chars`,
    `${report.sheet.base64Chars} chars`,
  );

  console.log('\nmotion (display px, scale = cellDisplayPx / cropSide)');
  line('root drift series', report.motion.rootDriftSeries.join(' '));
  line('root drift max', `${report.motion.rootDriftMax} px  (closed path ${report.motion.rootDriftPath} px)`);
  line('fluke travel series', report.motion.flukeTravelSeries.join(' '));
  line('fluke travel max', `${report.motion.flukeTravelMax} px  (closed path ${report.motion.flukeTravelPath} px)`);

  console.log('\nartifacts');
  line('sheet', `${written.sheetPath} ${report.sheet.width}x${report.sheet.height}, ${formatBytes(report.sheet.pngBytes)}, base64 ${report.sheet.base64Chars} chars`);
  line('sheet sha256', report.sheet.sha256);
  line('contact sheet', `${written.contactPath} ${report.contactSheet.width}x${report.contactSheet.height}, ${formatBytes(report.contactSheet.pngBytes)}`);
  line('metadata', written.metaPath);
  console.log('');
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('usage: node tools/build-frames.mjs [--src path] [--pad n] [--expect-count n]');
    console.log('                               [--sheet path] [--contact path] [--meta path]');
    return;
  }
  const sourceAbs = resolve(ROOT, options.source);
  const material = readFileSync(sourceAbs);
  options.source = repoRelative(sourceAbs);

  const built = buildFrames(material, {
    pad: options.pad,
    expectCount: options.expectCount,
    source: options.source,
  });

  const sheetAbs = resolve(ROOT, options.sheet);
  const contactAbs = resolve(ROOT, options.contact);
  const metaAbs = resolve(ROOT, options.meta);
  options.sheet = repoRelative(sheetAbs);
  mkdirSync(dirname(sheetAbs), { recursive: true });
  mkdirSync(dirname(contactAbs), { recursive: true });
  mkdirSync(dirname(metaAbs), { recursive: true });

  const metadata = buildMetadata(built, options);
  const json = `${JSON.stringify(metadata, null, 2)}\n`;

  writeFileSync(sheetAbs, built.sheetPng);
  writeFileSync(contactAbs, built.contactPng);
  writeFileSync(metaAbs, json);

  printReport(built, options, {
    sheetPath: repoRelative(sheetAbs),
    contactPath: repoRelative(contactAbs),
    metaPath: repoRelative(metaAbs),
  });
  console.log(`metadata JSON: ${json.length} chars (pngBase64 ${built.pngBase64.length} of them)`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[build-frames] ${error.message}`);
    process.exitCode = 1;
  }
}
