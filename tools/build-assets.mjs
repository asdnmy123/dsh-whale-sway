/**
 * build-assets.mjs — build every registered sway in one pass and write the
 * runtime-facing manifest.
 *
 * `tools/build-frames.mjs` renders ONE mode and validates it hard; this tool is
 * the orchestrator above it. For every entry in `tools/modes.mjs` it:
 *
 *   1. reads the material GIF from `preview/` and re-hashes it — the bytes on
 *      disk must equal the `sourceSha256` the registry declares, so a swapped or
 *      re-exported GIF can never silently change what ships;
 *   2. runs the frame pipeline, which writes the mode's sheet, its contact sheet
 *      for eyeball QC, and its metadata JSON;
 *   3. keeps the built result in memory for the manifest.
 *
 * It then writes `tools/generated/manifest.json`: the single artifact that
 * describes the whole shipped set — every mode's id, label, material identity,
 * frame count, cell size, crop, sheet hash and how many cells are genuinely
 * distinct at that raster. `tools/sync-sheet.mjs` reads that manifest and
 * splices every sheet into `client.js`.
 *
 * Determinism: the per-mode artifacts come from a byte-deterministic pipeline,
 * and the manifest records only measured values, so two runs in a row produce
 * byte-identical output. `--check` re-runs everything into memory and compares
 * against the files on disk without writing, which is what CI uses.
 *
 * Usage:
 *   node tools/build-assets.mjs            # build every mode + the manifest
 *   node tools/build-assets.mjs --check    # verify the shipped set is current
 *   node tools/build-assets.mjs --mode id  # build a single mode (manifest still
 *                                          # needs every mode, so it is skipped)
 *   node tools/build-assets.mjs --silent   # build without the per-mode reports
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMetadata, buildFrames, ROOT } from './build-frames.mjs';
import { findMode, MANIFEST_PATH, MODE_IDS, MODES } from './modes.mjs';

export const MANIFEST_VERSION = 1;
/**
 * Ceiling on the base64 the client half carries for all modes at once. The
 * runtime inlines every sheet, so this is the budget that keeps `client.js` a
 * plausible plugin file; the build fails loudly instead of quietly ballooning.
 */
export const BASE64_BUDGET = 75000;

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : null;
};
const silent = flag('silent');
const check = flag('check');
const only = value('mode');

if (only !== null && !MODE_IDS.includes(only)) {
  throw new Error(`unknown mode "${only}" (known: ${MODE_IDS.join(', ')})`);
}
const selected = only === null ? MODES : [findMode(only)];
if (only !== null) {
  console.log(`[build-assets] single mode "${only}": the manifest covers every mode, so it is not written`);
}

/**
 * Render one mode into memory. Returns everything the manifest and the caller
 * need; nothing is written here.
 */
function renderMode(mode) {
  const sourceAbs = resolve(ROOT, mode.source);
  if (!existsSync(sourceAbs)) {
    throw new Error(`mode "${mode.id}": missing material ${mode.source} — run \`git status\` and check preview/`);
  }
  const material = readFileSync(sourceAbs);
  const onDisk = sha256Hex(material);
  if (mode.sourceSha256 && mode.sourceSha256 !== onDisk) {
    throw new Error(
      `mode "${mode.id}": ${mode.source} hashes to ${onDisk}, but tools/modes.mjs declares ${mode.sourceSha256}. ` +
        'The artwork changed: update the registry hash deliberately, then rebuild.',
    );
  }

  const built = buildFrames(material, {
    source: mode.source,
    inkRgb: mode.inkRgb,
    expectDistinct: mode.expectDistinct,
  });
  const metadata = buildMetadata(built, {
    modeId: mode.id,
    modeLabel: mode.label,
    modeLabelEn: mode.labelEn,
    sheet: mode.sheet,
    expectDistinct: mode.expectDistinct,
  });
  const report = built.report;

  return {
    mode,
    materialBytes: material.length,
    sourceAbs,
    sheetAbs: resolve(ROOT, mode.sheet),
    contactAbs: resolve(ROOT, mode.contact),
    metaAbs: resolve(ROOT, mode.meta),
    built,
    metadata,
    json: `${JSON.stringify(metadata, null, 2)}\n`,
    entry: {
      id: mode.id,
      label: mode.label,
      labelEn: mode.labelEn,
      source: mode.source,
      sourceSha256: onDisk,
      sourceBytes: material.length,
      count: metadata.count,
      cell: metadata.cell,
      cellDisplayPx: metadata.cellDisplayPx,
      slotInsetPx: metadata.slotInsetPx,
      distinctCells: report.distinctCells.distinct,
      expectDistinct: mode.expectDistinct,
      sheet: mode.sheet,
      sheetBytes: built.sheetPng.length,
      sheetSha256: built.sheetSha256,
      sheetWidth: report.sheet.width,
      sheetHeight: report.sheet.height,
      base64Chars: built.pngBase64.length,
      contactSheet: mode.contact,
      metadata: mode.meta,
      crop: report.crop,
      motion: {
        unit: report.motion.unit,
        flukeTravelMax: report.motion.flukeTravelMax,
        flukeTravelPath: report.motion.flukeTravelPath,
        rootDriftMax: report.motion.rootDriftMax,
        rootDriftPath: report.motion.rootDriftPath,
      },
      delaysCs: report.material.delayCs,
    },
  };
}

function reportLine(rendered) {
  const { mode, entry, built } = rendered;
  const r = built.report;
  const pad = (text, width) => String(text).padEnd(width);
  console.log(`[build-assets] ${mode.id}`);
  console.log(`  ${pad('material', 22)} ${entry.source}  ${entry.sourceBytes} B  sha256 ${entry.sourceSha256.slice(0, 16)}…`);
  console.log(`  ${pad('frames / cell', 22)} ${entry.count} frames, ${entry.cell}px cells, ${entry.distinctCells}/${entry.expectDistinct} distinct`);
  console.log(`  ${pad('crop', 22)} ${entry.crop.side}x${entry.crop.side} at (${entry.crop.x0},${entry.crop.y0}), pad ${r.pad}`);
  console.log(`  ${pad('sheet', 22)} ${entry.sheet} ${entry.sheetWidth}x${entry.sheetHeight} ${entry.sheetBytes} B base64 ${entry.base64Chars} chars`);
  console.log(`  ${pad('sheet sha256', 22)} ${entry.sheetSha256}`);
  console.log(`  ${pad('fluke travel', 22)} max ${entry.motion.flukeTravelMax} px, path ${entry.motion.flukeTravelPath} px (display)`);
  console.log(`  ${pad('root drift', 22)} max ${entry.motion.rootDriftMax} px (display)`);
}

const rendered = [];
for (const mode of selected) {
  const result = renderMode(mode);
  rendered.push(result);
  if (!silent) reportLine(result);
}

// ---------------------------------------------------------------------------
// write the per-mode artifacts (or compare them, under --check)
// ---------------------------------------------------------------------------

const stale = [];
for (const item of rendered) {
  if (check) {
    const onDiskSheet = existsSync(item.sheetAbs) ? readFileSync(item.sheetAbs) : null;
    const onDiskContact = existsSync(item.contactAbs) ? readFileSync(item.contactAbs) : null;
    const onDiskMeta = existsSync(item.metaAbs) ? readFileSync(item.metaAbs, 'utf8') : null;
    if (onDiskSheet === null || !onDiskSheet.equals(item.built.sheetPng)) stale.push(item.mode.sheet);
    if (onDiskContact === null || !onDiskContact.equals(item.built.contactPng)) stale.push(item.mode.contact);
    if (onDiskMeta === null || onDiskMeta !== item.json) stale.push(item.mode.meta);
    continue;
  }
  for (const dir of [dirname(item.sheetAbs), dirname(item.contactAbs), dirname(item.metaAbs)]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(item.sheetAbs, item.built.sheetPng);
  writeFileSync(item.contactAbs, item.built.contactPng);
  writeFileSync(item.metaAbs, item.json);
}

// ---------------------------------------------------------------------------
// the manifest
// ---------------------------------------------------------------------------

if (only !== null) {
  if (check && stale.length > 0) {
    console.error(`[build-assets] stale artifacts: ${stale.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`[build-assets] mode "${only}" is ${check ? 'current' : 'built'}`);
  }
} else {
  const totalBase64 = rendered.reduce((sum, item) => sum + item.entry.base64Chars, 0);
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    defaultMode: MODES[0].id,
    modeIds: rendered.map((item) => item.entry.id),
    totalBase64Chars: totalBase64,
    base64Budget: BASE64_BUDGET,
    modes: rendered.map((item) => item.entry),
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestAbs = resolve(ROOT, MANIFEST_PATH);

  if (totalBase64 > BASE64_BUDGET) {
    throw new Error(
      `the ${rendered.length} sheets need ${totalBase64} base64 chars, over the ${BASE64_BUDGET} budget`,
    );
  }

  if (check) {
    const current = existsSync(manifestAbs) ? readFileSync(manifestAbs, 'utf8') : null;
    if (current !== manifestJson) stale.push(MANIFEST_PATH);
  } else {
    writeFileSync(manifestAbs, manifestJson);
  }

  console.log('');
  console.log(
    `[build-assets] ${rendered.length} modes (${rendered.map((item) => item.entry.id).join(', ')}): ` +
      `base64 ${totalBase64} / ${BASE64_BUDGET} chars across the set`,
  );
  console.log(`[build-assets] manifest ${check ? 'checked' : 'wrote'} ${MANIFEST_PATH} (${manifestJson.length} chars)`);
  for (const item of rendered) {
    console.log(`  ${item.entry.id.padEnd(12)} ${item.entry.count} frames x ${item.entry.cell}px  ${item.entry.base64Chars} base64 chars`);
  }

  if (check) {
    if (stale.length > 0) {
      console.error('');
      console.error(`[build-assets] STALE: ${stale.join(', ')}`);
      console.error('[build-assets] run `node tools/build-assets.mjs` to regenerate');
      process.exitCode = 1;
    } else {
      console.log('[build-assets] every shipped artifact matches a fresh build');
    }
  }
}
