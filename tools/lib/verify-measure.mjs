// tools/lib/verify-measure.mjs
//
// Verifier-owned measurement primitives (task-4). Independent of frame-smith's
// tools/lib/*. Everything here is written from the task-4 spec text, not read
// out of the pipeline under test.
//
// Alpha model (spec, exact):
//   L      = 0.299 R + 0.587 G + 0.114 B            (Rec.601 luminance)
//   a      = clamp((255 - L) / (255 - 92), 0, 1)     (ink luminance 92 = #345ebb)
//   alpha  = clamp((a - 0.02) / 0.96, 0, 1)          (contrast clean)

export const L_INK = 92.0;
export const CONTRAST_LO = 0.02;
export const CONTRAST_SPAN = 0.96;

export function luminance601(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function alphaFromLuminance(L) {
  let a = (255 - L) / (255 - L_INK);
  if (a < 0) a = 0;
  else if (a > 1) a = 1;
  let v = (a - CONTRAST_LO) / CONTRAST_SPAN;
  if (v < 0) v = 0;
  else if (v > 1) v = 1;
  return v;
}

export function alphaFromRgb(r, g, b) {
  return alphaFromLuminance(luminance601(r, g, b));
}

/** Float32Array(w*h) of coverage alpha in [0,1] from an RGBA byte buffer. */
export function alphaFromRgba(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) {
    out[i] = alphaFromRgb(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  return out;
}

/**
 * Union bbox over a stack of alpha maps for pixels with alpha > thr.
 * Returns {x0,y0,x1,y1,w,h,count} or null.
 */
export function unionBbox(frames, w, h, thr = 0.5) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, count = 0;
  for (const a of frames) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (a[row + x] > thr) {
          count++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
  }
  if (count === 0) return null;
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, count };
}

/** Bbox for a single alpha map. */
export function bbox(a, w, h, thr = 0.5) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, count = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (a[row + x] > thr) {
        count++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (count === 0) return null;
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, count };
}

/**
 * Exact area-weighted box resample of a rectangular source region
 * [x0, x0+side) x [y0, y0+side) into a cell x cell grid.
 */
export function boxResample(src, srcW, srcH, x0, y0, side, cell) {
  const out = new Float32Array(cell * cell);
  for (let j = 0; j < cell; j++) {
    const sy0 = y0 + (j * side) / cell;
    const sy1 = y0 + ((j + 1) * side) / cell;
    const iy0 = Math.max(0, Math.floor(sy0));
    const iy1 = Math.min(srcH - 1, Math.ceil(sy1) - 1);
    for (let i = 0; i < cell; i++) {
      const sx0 = x0 + (i * side) / cell;
      const sx1 = x0 + ((i + 1) * side) / cell;
      const ix0 = Math.max(0, Math.floor(sx0));
      const ix1 = Math.min(srcW - 1, Math.ceil(sx1) - 1);
      let acc = 0, wsum = 0;
      for (let y = iy0; y <= iy1; y++) {
        const wy = Math.min(y + 1, sy1) - Math.max(y, sy0);
        if (wy <= 0) continue;
        const row = y * srcW;
        for (let x = ix0; x <= ix1; x++) {
          const wx = Math.min(x + 1, sx1) - Math.max(x, sx0);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          acc += src[row + x] * wgt;
          wsum += wgt;
        }
      }
      out[j * cell + i] = wsum > 0 ? acc / wsum : 0;
    }
  }
  return out;
}

/** Pearson correlation (normalized cross-correlation) of two equal-length arrays. */
export function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

export function meanAbsError(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

export function maxAbsError(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

/**
 * Coverage-weighted centroid over the half-open rectangle
 * [x0,x1) x [y0,y1) using pixel centres (x+0.5, y+0.5).
 * Returns {x,y,weight} or null when the region is empty.
 */
export function centroid(a, w, x0, x1, y0, y1) {
  let sw = 0, sx = 0, sy = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++) {
      const v = a[row + x];
      if (v <= 0) continue;
      sw += v;
      sx += v * (x + 0.5);
      sy += v * (y + 0.5);
    }
  }
  if (sw <= 0) return null;
  return { x: sx / sw, y: sy / sw, weight: sw };
}

/**
 * Per-row stroke estimate: row ink area (sum of alpha) divided by the number of
 * threshold runs on that row, which is a resampling-robust estimate of the mean
 * stroke width in pixels. Returns mean/median over the rows that contain ink.
 */
export function strokeWidthStats(a, w, x0, x1, y0, y1, thr = 0.5) {
  const widths = [];
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    let total = 0, runs = 0, inRun = false;
    for (let x = x0; x < x1; x++) {
      const v = a[row + x];
      total += v;
      if (v > thr) {
        if (!inRun) { runs++; inRun = true; }
      } else inRun = false;
    }
    if (runs > 0) widths.push(total / runs);
  }
  if (widths.length === 0) return { mean: NaN, median: NaN, rows: 0 };
  const sorted = widths.slice().sort((p, q) => p - q);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    mean: widths.reduce((s, v) => s + v, 0) / widths.length,
    median,
    rows: widths.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/** Total circular path length of a series of points. */
export function pathLength(pts, circular = true) {
  let total = 0;
  const n = pts.length;
  const last = circular ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if (!a || !b) continue;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** Max pairwise (chord) displacement of a point series. */
export function maxPairwise(pts) {
  let m = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (!pts[i] || !pts[j]) continue;
      const d = Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
      if (d > m) m = d;
    }
  }
  return m;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function round(v, digits = 4) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
