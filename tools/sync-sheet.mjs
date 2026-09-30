/**
 * Splice every generated sprite sheet into `client.js`.
 *
 * `tools/build-assets.mjs` turns the registered artwork into one sheet per sway
 * plus `tools/generated/manifest.json`. The runtime needs those bytes *inline*,
 * because a DSH client half is a single classic script: it has no `import` and
 * must not depend on a sibling fetch.
 *
 * This tool is the only writer of the region between the two markers in
 * `client.js`, and it is idempotent: running it twice leaves the same bytes.
 * What it writes is a JSON array of the manifest's panels — mode id and label,
 * frame count, cell size, source identity, and the sheet itself as base64 — so
 * the runtime can build one `mask-image` per mode. The inline payload is a
 * projection of the manifest: `--check` re-derives it from the manifest and the
 * sheets on disk and fails if `client.js` carries anything else.
 *
 *   node tools/sync-sheet.mjs          # splice (writes client.js when stale)
 *   node tools/sync-sheet.mjs --check  # exit 1 when client.js is out of date
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODE, MANIFEST_PATH, MODE_IDS } from './modes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BEGIN = '/* dsh-whale-sway:sheet:begin */';
const END = '/* dsh-whale-sway:sheet:end */';
const CLIENT_PATH = resolve(ROOT, 'client.js');

const check = process.argv.includes('--check');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function fail(message) {
  console.error('[sync-sheet] ' + message);
  process.exit(1);
}

const manifestAbs = resolve(ROOT, MANIFEST_PATH);
if (!existsSync(manifestAbs)) {
  fail('missing ' + MANIFEST_PATH + ' — run `node tools/build-assets.mjs` first');
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestAbs, 'utf8'));
} catch (error) {
  fail('unreadable manifest.json: ' + error.message);
}

if (!Array.isArray(manifest.modes) || manifest.modes.length === 0) {
  fail('manifest.json carries no modes — regenerate it with `node tools/build-assets.mjs`');
}
if (manifest.modeIds !== undefined) {
  const listed = manifest.modeIds.join(',');
  const found = manifest.modes.map((entry) => entry.id).join(',');
  if (listed !== found) fail(`manifest.json modeIds [${listed}] disagree with its modes [${found}]`);
}

/** One panel of the inline payload: everything the runtime needs per sway. */
const panels = manifest.modes.map((entry) => {
  const where = `mode "${entry.id}"`;
  if (!MODE_IDS.includes(entry.id)) {
    fail(`${where} is not registered in tools/modes.mjs (known: ${MODE_IDS.join(', ')})`);
  }
  const count = Number(entry.count);
  const cell = Number(entry.cell);
  if (!Number.isInteger(count) || count < 2) fail(`${where}: count must be an integer >= 2 (got ${entry.count})`);
  if (!Number.isInteger(cell) || cell < 2) fail(`${where}: cell must be an integer >= 2 (got ${entry.cell})`);
  if (typeof entry.source !== 'string' || entry.source.length === 0) fail(`${where}: source is missing`);
  if (typeof entry.sheet !== 'string' || entry.sheet.length === 0) fail(`${where}: sheet path is missing`);

  const sheetAbs = resolve(ROOT, entry.sheet);
  if (!existsSync(sheetAbs)) fail(`${where}: missing sheet ${entry.sheet}`);
  const bytes = readFileSync(sheetAbs);
  const digest = sha256(bytes);
  if (entry.sheetSha256 !== digest) {
    fail(`${where}: ${entry.sheet} hashes to ${digest}, but manifest.json declares ${entry.sheetSha256}`);
  }
  if (bytes.length < 24 || bytes.toString('latin1', 1, 4) !== 'PNG') {
    fail(`${where}: ${entry.sheet} is not a PNG`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== cell || height !== count * cell) {
    fail(
      `${where}: sheet geometry disagrees with the manifest: PNG is ${width}x${height}, ` +
        `expected ${cell}x${count * cell}`,
    );
  }
  const base64 = bytes.toString('base64');
  if (entry.base64Chars !== undefined && entry.base64Chars !== base64.length) {
    fail(`${where}: base64 is ${base64.length} chars, but manifest.json declares ${entry.base64Chars}`);
  }
  return { id: entry.id, count, cell, source: entry.source, base64 };
});

const defaultMode = typeof manifest.defaultMode === 'string' ? manifest.defaultMode : DEFAULT_MODE;
if (!panels.some((panel) => panel.id === defaultMode)) {
  fail(`manifest.json defaultMode "${defaultMode}" is not one of [${panels.map((p) => p.id).join(', ')}]`);
}
if (!MODE_IDS.every((id) => panels.some((panel) => panel.id === id))) {
  fail(`the manifest is missing a registered mode: expected [${MODE_IDS.join(', ')}], got [${panels.map((p) => p.id).join(', ')}]`);
}

// The inline payload is the manifest's panel fields: a JSON array so the runtime
// reads ids, counts, cells and strips from one literal instead of parallel
// arrays. It is pretty-printed — one panel per seven lines — because this block
// is inside a shipped source file, and a 43,000-character single line would make
// every diff of `client.js` unreadable.
const inline = panels.map((panel) => ({
  id: panel.id,
  count: panel.count,
  cell: panel.cell,
  source: panel.source,
  base64: panel.base64,
}));
const inlineJson = JSON.stringify(inline, null, 2).split('\n').join('\n  ');
const summary = panels.map((panel) => `${panel.id}=${panel.count}@${panel.cell}`).join(' ');
const payloadSha = createHash('sha256')
  .update(panels.map((panel) => panel.base64).join('\n'))
  .digest('hex');
// The legacy single-mode constants are kept in step with the default panel: the
// older tools (`tools/test-motion.mjs`, `tools/make-gif.mjs`, `tools/verify-motion.mjs`)
// and any checkout that still reads `FRAME_COUNT` / `FRAME_SHEET_BASE64` keep
// working, and they provably describe the default mode, not a stale copy.
const defaultPanel = panels.find((panel) => panel.id === defaultMode);
const block = [
  BEGIN,
  '  // Generated by `node tools/sync-sheet.mjs` from tools/generated/manifest.json.',
  '  // Do not edit by hand: `node tools/build-assets.mjs` renders every sway from',
  '  // the source artwork in preview/, and the sync tool fills this literal in.',
  '  var MODE_PANELS = ' + inlineJson + ';',
  '  var DEFAULT_MODE = ' + JSON.stringify(defaultMode) + ';',
  '  var FRAME_COUNT = ' + defaultPanel.count + ';',
  '  var FRAME_CELL = ' + defaultPanel.cell + ';',
  "  var FRAME_SHEET_BASE64 = '" + defaultPanel.base64 + "';",
  '  var FRAME_SOURCE = ' + JSON.stringify(defaultPanel.source) + ';',
  '  ' + END,
].join('\n');

const source = readFileSync(CLIENT_PATH, 'utf8');
const begin = source.indexOf(BEGIN);
const end = source.indexOf(END);
if (begin < 0 || end < 0 || end < begin) {
  fail('client.js is missing the sheet markers');
}
if (source.indexOf(BEGIN, begin + 1) >= 0 || source.indexOf(END, end + 1) >= 0) {
  fail('client.js has duplicate sheet markers');
}

const next = source.slice(0, begin) + block + source.slice(end + END.length);

if (next === source) {
  console.log('[sync-sheet] client.js is already in sync');
} else if (check) {
  fail('client.js is out of date — run `node tools/sync-sheet.mjs`');
} else {
  writeFileSync(CLIENT_PATH, next);
  console.log('[sync-sheet] spliced the mode panels into client.js');
}

console.log(
  '[sync-sheet] modes=' +
    panels.length +
    ' [' +
    summary +
    '] default=' +
    defaultMode +
    ' panel0=' +
    defaultPanel.count +
    'x' +
    defaultPanel.cell +
    ' totalBase64=' +
    panels.reduce((sum, panel) => sum + panel.base64.length, 0) +
    ' payloadSha256=' +
    payloadSha.slice(0, 16),
);
