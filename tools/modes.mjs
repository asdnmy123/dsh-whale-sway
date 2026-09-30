/**
 * modes.mjs — the registry of every sway the plugin ships, and the one place
 * that says where its material comes from and what its artifacts are called.
 *
 * A "mode" is one complete wagging cycle: a material GIF in `preview/`, a frame
 * sheet derived from it, a contact sheet for eyeball QC, and a metadata JSON
 * that carries the sheet inline as base64. `tools/build-frames.mjs` renders one
 * mode at a time from this table; `tools/build-assets.mjs` walks all of them and
 * writes `tools/generated/manifest.json`; `tools/sync-sheet.mjs` splices every
 * mode's base64 into `client.js` so the runtime can swap between them.
 *
 * Adding a mode is a one-line edit here plus a re-run of the build. The paths
 * are repo-relative posix, and every mode's `id` is the name the runtime uses.
 *
 * `crop` is mode-local (the sheet is cut from that mode's own union ink box,
 * grown by `pad` source pixels), which is the pipeline's original contract: the
 * sway's width is whatever the artwork contains, never a value the build
 * imposes. That is also why modes are *not* forced through a shared crop — each
 * source wag was drawn and timed on its own terms.
 *
 * `expectDistinct` is a property of the artwork, measured once and pinned here:
 * it is how many of the 24 cells differ from each other at the shipped raster.
 * The two new wags are mirror-symmetric and repeat the first half in the second
 * (`0..11` then `0..11` again), so they collapse to 12 distinct cells at cell 32.
 * The build reports that instead of failing on it: the runtime still loops all
 * 24 cells, and the sheet each cell is cut from stays the material's own frame.
 */

/**
 * The ink every material shares. It is what the alpha model divides by, so the
 * white-removal maths is only correct for artwork drawn in exactly this colour.
 * `tools/verify-frames.mjs` re-derives it from the sheet and fails on a mismatch.
 */
export const INK_RGB = [52, 94, 187];

/** One shipped sway: material, artifacts, and the ids the runtime uses. */
export const MODES = [
  {
    id: 'sway',
    label: '摆动（原始幅度）',
    labelEn: 'sway (as drawn)',
    /** Segment copy for the settings page, where a whole line per mode is too wide. */
    shortLabel: '原生',
    shortLabelEn: 'As drawn',
    inkRgb: INK_RGB,
    /** All 24 cells differ: this material's wag is asymmetric. */
    expectDistinct: 24,
    source: 'preview/sway.gif',
    sourceSha256: '0583b5c6e37f860666f482ad2b71c6b1de99714f041b8dcae58b93fb64175f85',
    sheet: 'preview/sway-sheet.png',
    contact: 'preview/sway-contact-sheet.png',
    meta: 'tools/generated/sway.json',
  },
  {
    id: 'sway-gentle',
    label: '摆动（小幅）',
    labelEn: 'sway (gentle)',
    /** Segment copy for the settings page, where a whole line per mode is too wide. */
    shortLabel: '轻摆',
    shortLabelEn: 'Gentle',
    inkRgb: INK_RGB,
    /** Mirror-symmetric wag: the second half repeats the first at cell 32. */
    expectDistinct: 12,
    source: 'preview/sway-gentle.gif',
    sourceSha256: '46b2d9771ab9428f2c7a07d8b39d5792ec547cb15c9e5079c40a02d56b2ff3f8',
    sheet: 'preview/sway-gentle-sheet.png',
    contact: 'preview/sway-gentle-contact-sheet.png',
    meta: 'tools/generated/sway-gentle.json',
  },
  {
    id: 'sway-vivid',
    label: '摆动（大幅）',
    labelEn: 'sway (vivid)',
    /** Segment copy for the settings page, where a whole line per mode is too wide. */
    shortLabel: '大摆',
    shortLabelEn: 'Vivid',
    inkRgb: INK_RGB,
    /**
     * Mirror-symmetric wag, and a little more compact than gentle's: measured at
     * cell 32 the identical pairs are (0,12) (1,11) (2,10) (3,9) (4,8) (5,7)
     * (13,23) (14,22) (15,21) (16,20) (17,19), leaving frames 6 and 18 as the two
     * extremal poses that occur once. 13 distinct cells out of 24 frames.
     */
    expectDistinct: 13,
    source: 'preview/sway-vivid.gif',
    sourceSha256: 'ce8603ad7128f6333d7efd13c87febca404aaee26816a2715602c8eba56ce3b0',
    sheet: 'preview/sway-vivid-sheet.png',
    contact: 'preview/sway-vivid-contact-sheet.png',
    meta: 'tools/generated/sway-vivid.json',
  },
];

/** Where the combined, runtime-facing manifest lands. */
export const MANIFEST_PATH = 'tools/generated/manifest.json';

/** The mode the README documents as the default, and the CLI's default mode. */
export const DEFAULT_MODE = 'sway';

/** Every mode id, in shipped order. */
export const MODE_IDS = MODES.map((mode) => mode.id);

/** Look a mode up by id, or by artifact path. Throws on an unknown id. */
export function findMode(id) {
  const mode = MODES.find((entry) => entry.id === id);
  if (!mode) {
    throw new Error(`unknown sway mode "${id}" (known: ${MODE_IDS.join(', ')})`);
  }
  return mode;
}
