#!/usr/bin/env node
/**
 * ADVERSARIAL verification of the dsh-whale-sway client runtime.
 *
 * This harness assumes the author cheated until measurements prove otherwise.
 * It does NOT trust client.js's own tests, comments or metadata:
 *
 *  1. it re-loads client.js in a `node:vm` context through the real
 *     `window.__ModuleLoader__.load({ id, factory })` handshake;
 *  2. it asserts the ZERO-TRANSFORM contract on the actual string returned by
 *     the module's `buildCss()`, not on a regex over the source file;
 *  3. it runs the real animation loop against a stub DOM with a hand-driven
 *     clock (`requestAnimationFrame` / `setInterval` / `performance.now`) and
 *     records EVERY style write on EVERY element;
 *  4. it decodes preview/frames-sheet.png locally and measures the fluke's
 *     travel from the pixels alone.
 *
 * Non-interactive. Prints one PASS/FAIL line per check with measured numbers,
 * writes a JSON report to .edge-tmp/mv/report.json and exits non-zero if any
 * check fails.
 *
 * Run: node tools/verify-motion.mjs [--client <path>] [--sheet <path>]
 *                                  [--frames <path>] [--quiet]
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { decodePng, measureSheet } from './lib/verify-motion-png.mjs';
import {
  createWorld,
  stripCommentsAndStrings,
  maskDataUrls,
  findBase64Literals,
  blankSheetLiterals,
  forceEmptySheet,
  TRANSFORM_PROPERTY_RE,
} from './lib/verify-motion-dom.mjs';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);

function argValue(name, fallback) {
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  return fallback;
}

const CLIENT_PATH = path.resolve(ROOT, argValue('--client', 'client.js'));
const SHEET_PATH = path.resolve(ROOT, argValue('--sheet', 'preview/frames-sheet.png'));
const FRAMES_PATH = path.resolve(ROOT, argValue('--frames', 'tools/generated/frames.json'));
const QUIET = argv.includes('--quiet');
const REPORT_PATH = path.join(ROOT, '.edge-tmp', 'mv', 'report.json');

// The rate sweep used for check 2(d). 240 Hz keeps the measurement below the
// 60 Hz display ceiling so "more distinct frames per second" is observable.
const RATES = [0, 5, 20, 60, 160];
const SWEEP_SECONDS = 5;
const SWEEP_TICK_HZ = 60;
const HIGH_TICK_HZ = 240;
const STEADY_MS = 1000; // ignore the first simulated second (EMA warm-up)

// ---------------------------------------------------------------------------
// tiny check framework
// ---------------------------------------------------------------------------

const results = [];
const measurements = {};

function log(line) {
  if (!QUIET) console.log(line);
}

function pass(id, title, detail) {
  results.push({ id, title, ok: true, detail });
  log(`PASS ${id} ${title} :: ${detail}`);
}

function fail(id, title, detail) {
  results.push({ id, title, ok: false, detail });
  log(`FAIL ${id} ${title} :: ${detail}`);
}

function check(id, title, fn) {
  try {
    const detail = fn();
    pass(id, title, detail);
  } catch (error) {
    fail(id, title, (error && error.message) || String(error));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Short, stable formatting for numbers inside messages. */
function n(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function allFrames(values) {
  return values.length === 0 ? '[]' : `[${values.slice(0, 12).join(',')}${values.length > 12 ? ',…' : ''}]`;
}

// ---------------------------------------------------------------------------
// artifact loading
// ---------------------------------------------------------------------------

const missing = [];
const clientSource = existsSync(CLIENT_PATH) ? readFileSync(CLIENT_PATH, 'utf8') : null;
if (clientSource === null) missing.push(CLIENT_PATH);

const sheetBytes = existsSync(SHEET_PATH) ? readFileSync(SHEET_PATH) : null;
if (sheetBytes === null) missing.push(SHEET_PATH);

let framesJson = null;
if (existsSync(FRAMES_PATH)) {
  try {
    framesJson = JSON.parse(readFileSync(FRAMES_PATH, 'utf8'));
  } catch (error) {
    framesJson = { __parseError: String(error && error.message) };
  }
}

let sheetImage = null;
if (sheetBytes !== null) {
  try {
    sheetImage = decodePng(sheetBytes);
  } catch (error) {
    sheetImage = { __decodeError: String(error && error.message) };
  }
}

log('dsh-whale-sway — adversarial runtime verification');
log(`  client : ${path.relative(ROOT, CLIENT_PATH)} (${clientSource === null ? 'MISSING' : clientSource.length + ' chars'})`);
log(`  sheet  : ${path.relative(ROOT, SHEET_PATH)} (${sheetBytes === null ? 'MISSING' : sheetBytes.length + ' bytes'})`);
log(`  frames : ${path.relative(ROOT, FRAMES_PATH)} (${framesJson === null ? 'MISSING' : 'present'})`);
log('');

if (clientSource === null) {
  fail('0', 'ARTIFACTS', `client.js is missing at ${CLIENT_PATH}`);
  console.log('\n1 failing, 0 passing — cannot verify without client.js');
  process.exitCode = 1;
  process.exit(1);
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

const allWorlds = [];

/** Load client.js into a fresh world and run apply() the way the loader does. */
function makeRunningWorld(source, media, options = {}) {
  const world = createWorld({ source, media: media || {} });
  allWorlds.push(world);
  let api = null;
  let applyError = null;
  const disposers = [];
  try {
    api = world.loadModule();
  } catch (error) {
    applyError = `loadModule: ${(error && error.message) || error}`;
  }
  if (api !== null && options.apply !== false) {
    try {
      api.apply({
        effect(callback) {
          const disposer = callback();
          if (typeof disposer === 'function') disposers.push(disposer);
          return disposer;
        },
      });
    } catch (error) {
      applyError = `apply: ${(error && error.message) || error}`;
    }
  }
  return { world, api, disposers, applyError };
}

/** Find an export by name, then by regex over the export keys. */
function findExport(api, exact, pattern) {
  if (api === null || api === undefined) return undefined;
  if (exact !== undefined && api[exact] !== undefined) return api[exact];
  for (const key of Object.keys(api)) {
    if (pattern.test(key)) return api[key];
  }
  return undefined;
}

/** The stylesheet the module actually emits, preferring one that has a mask. */
function emittedCss(api) {
  const attempts = [];
  attempts.push(() => api.buildCss());
  if (typeof api.buildMask === 'function') {
    attempts.push(() => api.buildCss(api.buildMask()));
  }
  if (typeof api.buildCss === 'function' && typeof api.FRAME_SHEET_BASE64 === 'string') {
    attempts.push(() => api.buildCss(api.FRAME_SHEET_BASE64));
  }
  const strings = [];
  for (const attempt of attempts) {
    try {
      const value = attempt();
      if (typeof value === 'string') strings.push(value);
    } catch (error) {
      /* try the next signature */
    }
  }
  if (strings.length === 0) {
    throw new Error('buildCss() did not return a string for any known signature');
  }
  const withMask = strings.find((css) => /mask-image/i.test(css));
  const withPng = strings.find((css) => /data:image\/png;base64,/i.test(css));
  return withPng || withMask || strings[strings.length - 1];
}

/** All base64 PNG payloads embedded in a CSS string (deduplicated). */
function cssSheetPayloads(css) {
  const payloads = new Set();
  const re = /data:image\/png;base64,([A-Za-z0-9+/=]+)/gi;
  let match;
  while ((match = re.exec(css)) !== null) payloads.add(match[1]);
  return [...payloads];
}

function decodeBase64(text) {
  return Buffer.from(text, 'base64');
}

/** number of frames declared by the module (export, source, or frames.json). */
function declaredFrameCount(api, source) {
  const direct = findExport(api, 'FRAME_COUNT', /^frame_?count$/i);
  if (Number.isInteger(direct)) return { value: direct, from: 'module export' };
  const fromJson = framesJson && Number.isInteger(framesJson.count) ? framesJson.count : null;
  if (fromJson !== null) return { value: fromJson, from: 'tools/generated/frames.json' };
  const match = source.match(/\bFRAME_COUNT\s*=\s*(\d+)/);
  if (match) return { value: Number(match[1]), from: 'source declaration' };
  return { value: null, from: 'not found' };
}

/** CSS brace-block scanner: find every block whose header matches `re`. */
function findBlocks(css, re) {
  const blocks = [];
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(css)) !== null) {
    const brace = css.indexOf('{', match.index);
    if (brace < 0) continue;
    let depth = 0;
    let close = -1;
    for (let i = brace; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) continue;
    blocks.push({
      index: match.index,
      header: css.slice(match.index, brace),
      open: brace,
      close,
      body: css.slice(brace + 1, close),
    });
  }
  return blocks;
}

function insideBlock(blocks, index) {
  return blocks.find((block) => block.open < index && index < block.close) || null;
}

/** true when a `mask-size` value maps exactly one sheet cell onto the box. */
function maskSizeMatchesCount(value, count) {
  const compact = String(value).replace(/\s+/g, '');
  if (compact.includes(`${count * 100}%`)) return true;
  if (compact.includes(`calc(${count}*100%)`)) return true;
  const numbers = [...compact.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
  const calcNumbers = [...compact.matchAll(/calc\(([^)]*)\)/g)].map((m) => m[1]);
  if (numbers.includes(count * 100)) return true;
  for (const inner of calcNumbers) {
    const innerNumbers = [...inner.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    if (innerNumbers.includes(count * 100) || (innerNumbers.includes(count) && inner.includes('100%'))) return true;
  }
  return false;
}

/** A property name that would betray motion produced by something other than frame selection. */
const MOTION_PROPERTY_RE = /angle|rotate|transform|translate|scale|skew|matrix|lift|bob|phase|deg/i;

// ---------------------------------------------------------------------------
// the canonical live world used by checks 1-4
// ---------------------------------------------------------------------------

let live = null;
let liveCss = null;
let liveApi = null;
let liveError = null;
try {
  live = makeRunningWorld(clientSource, {});
  liveApi = live.api;
  if (liveApi === null) throw new Error(live.applyError || 'module did not load');
  liveCss = emittedCss(liveApi);
} catch (error) {
  liveError = (error && error.message) || String(error);
}

const frameCountInfo = declaredFrameCount(liveApi, clientSource);
const frameCount = frameCountInfo.value;
log(
  `  module : hasSheet=${liveApi && typeof liveApi.hasSheet === 'function' ? liveApi.hasSheet() : 'n/a'}` +
    `, FRAME_COUNT=${liveApi ? liveApi.FRAME_COUNT : 'n/a'}` +
    `, FRAME_VAR=${liveApi ? liveApi.FRAME_VAR : 'n/a'}` +
    `, emitted css=${liveCss === null ? 'n/a' : liveCss.length + ' chars'}`,
);
log('');

// ===========================================================================
// CHECK 1 — ZERO ROTATION / ZERO TRANSFORM
// ===========================================================================

check('1', 'ZERO-TRANSFORM (emitted stylesheet + runtime writes)', () => {
  assert(liveError === null, `could not obtain the emitted stylesheet: ${liveError}`);
  const css = liveCss;
  const unspliced =
    typeof liveApi.hasSheet === 'function' && liveApi.hasSheet() === false
      ? ' (hasSheet()=false — the frame sheet is NOT spliced into client.js yet)'
      : '';
  assert(
    typeof css === 'string' && css.length > 0,
    `the module emitted an EMPTY stylesheet, so no motion contract can be verified${unspliced}`,
  );
  measurements.hasSheet = typeof liveApi.hasSheet === 'function' ? liveApi.hasSheet() : null;
  measurements.cssLength = css.length;
  const injected = live.world.insertedCss();
  measurements.injectedCssLength = injected === null ? 0 : injected.length;

  const scanned = maskDataUrls(css);
  measurements.cssBase64Masked = scanned.length;
  measurements.sheetPayloadCount = cssSheetPayloads(css).length;

  const tokenChecks = [
    ['transform', /transform/i, css],
    ['rotate', /rotate/i, css],
    ['translate', /translate/i, css],
    ['matrix', /matrix/i, css],
    ['scale', /scale/i, css],
    ['skew', /skew/i, css],
    ['perspective', /perspective/i, css],
    ['writing-mode', /writing-mode/i, css],
    ['offset-path/offset-rotate', /offset-(?:path|rotate)/i, css],
    ['will-change:transform', /will-change\s*:[^;}]*transform/i, css],
    ['animation:', /(?:^|[;{}]|\))\s*(?:-[a-z]+-)?animation\s*:/i, css],
    ['transition:', /(?:^|[;{}]|\))\s*(?:-[a-z]+-)?transition\s*:/i, css],
  ];
  const tokenHits = [];
  for (const [label, re, text] of tokenChecks) {
    const masked = maskDataUrls(text);
    const match = re.exec(masked);
    if (match) {
      // Slice the MASKED text: masking shortens the string, so an index into it
      // is meaningless in the original.
      tokenHits.push(`${label}@${match.index}:"${masked.slice(match.index, match.index + 40).replace(/\s+/g, ' ')}"`);
    }
  }
  // Also scan the string with base64 left intact, but only report hits outside data URLs.
  measurements.maskDataUrlScanMasked = scanned.length;
  assert(
    tokenHits.length === 0,
    `emitted CSS contains forbidden motion tokens: ${tokenHits.join(' | ')}`,
  );

  // The stylesheet actually injected by apply() must be the same contract.
  if (typeof injected === 'string' && injected.length > 0) {
    const injectedHits = tokenChecks
      .map(([label, re, text]) => [label, re.exec(maskDataUrls(injected))])
      .filter(([, match]) => match !== null)
      .map(([label]) => label);
    assert(injectedHits.length === 0, `injected <style> contains forbidden tokens: ${injectedHits.join(', ')}`);
  }

  // Runtime: no element style may ever receive a transform-ish property write.
  const runtimeHits = [];
  for (const world of allWorlds) {
    for (const record of world.transformWrites()) {
      runtimeHits.push(`${record.label}.${record.name}=${record.value}@t=${record.t}ms`);
    }
  }
  measurements.runtimeTransformWrites = runtimeHits.length;
  assert(
    runtimeHits.length === 0,
    `runtime wrote transform-ish properties: ${runtimeHits.slice(0, 6).join(' | ')}`,
  );

  // The source CODE (comments and strings stripped) must not build transforms.
  const code = stripCommentsAndStrings(clientSource);
  const codeHits = [];
  for (const [label, re] of [
    ['transform', /transform/i],
    ['rotate(', /rotate\s*\(/i],
    ['translate(', /translate\s*\(/i],
    ['scale(', /scale\s*\(/i],
    ['skew', /skew/i],
    ['matrix(', /matrix\s*\(/i],
    ['will-change', /will-change/i],
    ['style.animation', /\.animation\b/],
    ['style.transition', /\.transition\b/],
  ]) {
    if (re.test(code)) codeHits.push(label);
  }
  assert(codeHits.length === 0, `client.js code (comments/strings stripped) mentions: ${codeHits.join(', ')}`);

  return (
    `hasSheet=${measurements.hasSheet}, css=${css.length} chars, injected=${measurements.injectedCssLength} chars, ` +
    `0/${tokenChecks.length} forbidden motion tokens, 0 runtime transform writes, source code clean`
  );
});

// ===========================================================================
// CHECK 2 — THE MOTION IS FRAME SELECTION
// ===========================================================================

function analyzeTrace(points, count, options = {}) {
  const steadyFrom = options.steadyFrom === undefined ? STEADY_MS : options.steadyFrom;
  const values = points.map((p) => p.value);
  const integers = points.every((p) => p.integer);
  const nonInteger = points.filter((p) => !p.integer).slice(0, 5).map((p) => p.raw);
  const inRange = values.every((v) => Number.isInteger(v) && v >= 0 && v <= count - 1);
  const outOfRange = values.filter((v) => !(Number.isInteger(v) && v >= 0 && v <= count - 1)).slice(0, 5);

  let steps = 0;
  let changes = 0;
  let maxDelta = 0;
  let maxDeltaAt = -1;
  const deltas = [];
  for (let i = 1; i < values.length; i += 1) {
    const delta = ((values[i] - values[i - 1]) % count + count) % count;
    deltas.push(delta);
    if (delta > maxDelta) {
      maxDelta = delta;
      maxDeltaAt = points[i].t;
    }
  }
  for (const delta of deltas) {
    if (delta !== 0) changes += 1;
    steps += delta;
  }

  // steady-state window
  const steadyIndex = points.findIndex((p) => p.t >= steadyFrom);
  const steadyPoints = steadyIndex < 0 ? [] : points.slice(steadyIndex);
  const steadyValues = steadyPoints.map((p) => p.value);
  let steadySteps = 0;
  let steadyChanges = 0;
  let steadyMaxDelta = 0;
  for (let i = 1; i < steadyValues.length; i += 1) {
    const delta = ((steadyValues[i] - steadyValues[i - 1]) % count + count) % count;
    if (delta > steadyMaxDelta) steadyMaxDelta = delta;
    if (delta !== 0) steadyChanges += 1;
    steadySteps += delta;
  }
  const steadySeconds = steadyPoints.length > 1 ? (steadyPoints[steadyPoints.length - 1].t - steadyPoints[0].t) / 1000 : 0;

  return {
    samples: points.length,
    integers,
    nonInteger,
    inRange,
    outOfRange,
    distinct: new Set(values).size,
    steps,
    changes,
    maxDelta,
    maxDeltaAt,
    steadySamples: steadyPoints.length,
    steadySteps,
    steadyChanges,
    steadyMaxDelta,
    steadySeconds,
    steadyStepsPerSec: steadySeconds > 0 ? steadySteps / steadySeconds : 0,
    steadyChangesPerSec: steadySeconds > 0 ? steadyChanges / steadySeconds : 0,
    steadyDistinct: new Set(steadyValues).size,
    first: values.slice(0, 6),
    last: values.slice(-6),
  };
}

function sweep(rate, tickHz, seconds) {
  const run = makeRunningWorld(clientSource, {});
  assert(run.api !== null, `module did not load for rate ${rate}: ${run.applyError}`);
  const disposers = run.disposers;
  run.world.pump({ charsPerSecond: rate, seconds, tickHz });
  const points = run.world.frameWrites().map((record) => ({
    t: record.t,
    raw: record.value,
    value: Number(record.value),
    integer: Number.isInteger(Number(record.value)),
  }));
  const analysis = analyzeTrace(points, frameCount);
  return { run, points, analysis, disposers };
}

const sweep60 = new Map();
const sweep240 = new Map();

check('2', 'FRAME-SELECTION motion (integer frame property, monotone, rate-scaled)', () => {
  assert(liveApi !== null, 'module did not load');
  assert(
    Number.isInteger(frameCount) && frameCount > 1,
    `could not determine FRAME_COUNT (got ${frameCount}; source: ${frameCountInfo.from})`,
  );
  const frameProp =
    findExport(liveApi, 'FRAME_VAR', /frame.*var|frame.*prop|prop.*frame/) || '--dsh-whale-frame';
  measurements.frameProperty = frameProp;

  // --- sweep at 60 ticks/s (the monotonicity gate) ---
  for (const rate of RATES) {
    const result = sweep(rate, SWEEP_TICK_HZ, SWEEP_SECONDS);
    sweep60.set(rate, result);
  }
  measurements.rateSweep60 = {};
  for (const rate of RATES) {
    const { analysis } = sweep60.get(rate);
    measurements.rateSweep60[rate] = {
      samples: analysis.samples,
      distinct: analysis.distinct,
      steadyStepsPerSec: Number(analysis.steadyStepsPerSec.toFixed(3)),
      steadyChangesPerSec: Number(analysis.steadyChangesPerSec.toFixed(3)),
      maxDelta: analysis.maxDelta,
      steadyMaxDelta: analysis.steadyMaxDelta,
    };
  }

  const at60 = sweep60.get(60).analysis;
  assert(at60.samples > 0, 'the 60 char/s run wrote NO frame property at all');
  assert(at60.integers, `non-integer frame values written: ${at60.nonInteger.join(', ')}`);
  assert(at60.inRange, `frame values outside [0,${frameCount - 1}]: ${at60.outOfRange.join(', ')}`);
  assert(
    at60.steadySteps > 0,
    'the frame index never advanced at 60 char/s — there is no frame-selection motion',
  );

  // (c) monotone non-decreasing modulo wrap at 60 ticks/s.
  const tickMs = 1000 / SWEEP_TICK_HZ;
  const minPeriod = liveApi.TUNING && Number.isFinite(liveApi.TUNING.minPeriodMs) ? liveApi.TUNING.minPeriodMs : null;
  const advanceBound =
    minPeriod !== null && minPeriod > 0
      ? Math.max(2, Math.ceil((frameCount * tickMs) / minPeriod) + 1)
      : Math.max(2, Math.ceil(frameCount / 10));
  assert(
    at60.steadyMaxDelta <= advanceBound,
    `non-monotone frame sequence at 60 ticks/s: max forward delta ${at60.steadyMaxDelta} > bound ${advanceBound} (a backward jump reads as wrap-around)`,
  );

  // --- sweep at 240 ticks/s: no display ceiling, so rate scaling is observable ---
  for (const rate of RATES) {
    sweep240.set(rate, sweep(rate, HIGH_TICK_HZ, SWEEP_SECONDS));
  }
  measurements.rateSweep240 = {};
  const perSec = [];
  for (const rate of RATES) {
    const { analysis } = sweep240.get(rate);
    perSec.push(analysis.steadyStepsPerSec);
    measurements.rateSweep240[rate] = {
      samples: analysis.samples,
      distinct: analysis.distinct,
      steadyStepsPerSec: Number(analysis.steadyStepsPerSec.toFixed(3)),
      steadyChangesPerSec: Number(analysis.steadyChangesPerSec.toFixed(3)),
      steadyDistinct: analysis.steadyDistinct,
    };
    assert(analysis.integers, `rate ${rate}: non-integer frame values ${analysis.nonInteger.join(', ')}`);
    assert(analysis.inRange, `rate ${rate}: out-of-range values ${analysis.outOfRange.join(', ')}`);
  }

  // (d) a higher token rate must yield strictly more distinct frames per second.
  const scaling = [];
  for (let i = 1; i < RATES.length; i += 1) {
    const lower = perSec[i - 1];
    const higher = perSec[i];
    scaling.push(`${RATES[i - 1]}->${RATES[i]}: ${n(lower)} -> ${n(higher)} steps/s`);
    assert(
      higher > lower,
      `rate does not scale frame throughput: ${RATES[i - 1]} chars/s gives ${n(lower)} frames/s, ` +
        `${RATES[i]} chars/s gives ${n(higher)} frames/s`,
    );
  }

  // Direct unit evidence: the exported phase -> index mapping is integral and in range.
  let phaseEvidence = 'frameIndexForPhase not exported';
  if (typeof liveApi.frameIndexForPhase === 'function') {
    const bad = [];
    for (let i = 0; i <= 4000; i += 1) {
      const phase = i / 400; // 0..10 turns
      const value = liveApi.frameIndexForPhase(phase, frameCount);
      if (!Number.isInteger(value) || value < 0 || value > frameCount - 1) bad.push(`${phase}->${value}`);
    }
    assert(bad.length === 0, `frameIndexForPhase gave non-integer/out-of-range values: ${bad.slice(0, 5).join(', ')}`);
    phaseEvidence = `frameIndexForPhase: 4001 phases -> integers in [0,${frameCount - 1}]`;
  }
  measurements.phaseEvidence = phaseEvidence;

  // (e) the emitted CSS must point at the spliced sheet data URL.
  assert(liveCss !== null && liveCss.length > 0, 'no emitted CSS (empty stylesheet)');
  assert(/data:image\/png;base64,/i.test(liveCss), 'emitted CSS has no PNG data URL');
  const payloads = cssSheetPayloads(liveCss);
  assert(payloads.length === 1, `emitted CSS must contain exactly ONE distinct sheet payload (got ${payloads.length})`);
  assert(payloads[0].length > 1000, `the sheet payload looks truncated (${payloads[0].length} base64 chars)`);

  measurements.frameProperty = frameProp;
  measurements.frameCount = frameCount;
  measurements.monotoneAdvanceBound = advanceBound;
  measurements.scaling440 = scaling;
  measurements.rateScaling = scaling;

  const table = RATES.map((rate) => `${rate}c/s=${n(measurements.rateSweep240[rate].steadyStepsPerSec)}fps`).join(' ');
  return (
    `count=${frameCount}, ${at60.samples} samples@60Hz, ints ✓, range ✓, max delta ${at60.steadyMaxDelta}<=${advanceBound} ✓, ` +
    `240Hz throughput ${table}; ${phaseEvidence}`
  );
});

// ===========================================================================
// CHECK 3 — NO HIDDEN RE-DERIVATION
// ===========================================================================

check('3', 'NO-RE-DERIVATION (no canvas/angle/geometry; loop writes only the frame index; stop clears it)', () => {
  assert(liveApi !== null, 'module did not load');
  const code = stripCommentsAndStrings(clientSource);

  const forbiddenCode = [];
  for (const [label, re] of [
    ['getContext', /getContext\s*\(/],
    ['canvas', /createElement\s*\(\s*['"`]canvas/i],
    ['HTMLCanvasElement', /HTMLCanvasElement/],
    ['Math.atan2', /Math\.atan2/],
    ['Math.sin', /Math\.sin/],
    ['Math.cos', /Math\.cos/],
    ['Math.tan', /Math\.tan/],
    ['createLinearGradient', /createLinearGradient/],
    ['setTransform', /setTransform/],
    ['toDataURL', /toDataURL/],
  ]) {
    if (re.test(code)) forbiddenCode.push(label);
  }
  // `canvas` may legitimately appear only as a word in an identifier; check bare token too.
  const canvasWord = /\bcanvas\b/i.test(code);
  if (canvasWord && !forbiddenCode.includes('canvas')) forbiddenCode.push('bare "canvas" token');
  assert(forbiddenCode.length === 0, `per-frame geometry/canvas synthesis found in code: ${forbiddenCode.join(', ')}`);

  // The loop may only write the integer frame property in steady state.
  const props = new Set();
  for (const world of allWorlds) {
    for (const name of world.writtenNames(STEADY_MS, Infinity)) props.add(name);
  }
  const written = [...props];
  measurements.steadyWrittenProperties = written;
  const frameProps = written.filter((name) => /frame/i.test(name));
  assert(frameProps.length >= 1, `the loop never wrote a frame property in steady state (wrote: ${written.join(', ') || 'nothing'})`);
  const motionProps = written.filter((name) => MOTION_PROPERTY_RE.test(name) && !/frame/i.test(name));
  assert(
    motionProps.length === 0,
    `the loop wrote motion properties other than the frame index: ${motionProps.join(', ')}`,
  );

  // stop() must clear the frame property.
  const run = makeRunningWorld(clientSource, {});
  assert(run.api !== null, 'module did not load');
  run.world.pump({ charsPerSecond: 60, seconds: 2, tickHz: 60 });
  const before = run.world.frameWrites();
  assert(before.length > 0, 'no frame write before stop()');
  const frameName = frameProps[0];
  const indexBefore = run.world.records.length;
  assert(run.disposers.length > 0, 'apply() registered no disposer, so stop() cannot be exercised');
  for (const dispose of run.disposers) dispose();
  const after = run.world.records.slice(indexBefore);
  const cleared = after.filter(
    (record) => record.name === frameName && (record.kind === 'removeProperty' || record.value === '' || record.value === '0'),
  );
  measurements.stopWrites = after
    .filter((record) => record.name === frameName)
    .map((record) => `${record.kind}(${record.name}=${JSON.stringify(record.value)})`);
  assert(
    cleared.length > 0,
    `stop() did not clear ${frameName}; writes after dispose: ${measurements.stopWrites.join(', ') || 'none'}`,
  );

  return `code clean (10 patterns), steady props=[${written.join(', ')}], stop cleared ${frameName} via ${cleared[0].kind}`;
});

// ===========================================================================
// CHECK 4 — SHEET INTEGRITY
// ===========================================================================

check('4', 'SHEET-INTEGRITY (base64 == frames-sheet.png, count == cells, mask-size == count*100%)', () => {
  assert(sheetBytes !== null, `missing artifact ${path.relative(ROOT, SHEET_PATH)}`);
  assert(sheetImage && !sheetImage.__decodeError, `could not decode the sheet: ${sheetImage && sheetImage.__decodeError}`);
  assert(liveCss !== null, 'no emitted CSS');
  assert(Number.isInteger(frameCount), `FRAME_COUNT could not be determined (${frameCountInfo.from})`);

  const payloads = cssSheetPayloads(liveCss);
  assert(payloads.length >= 1, 'no PNG base64 payload in the emitted CSS');
  const decoded = decodeBase64(payloads[0]);
  const identical = decoded.equals(sheetBytes);
  measurements.sheetBytes = sheetBytes.length;
  measurements.decodedBase64Bytes = decoded.length;
  measurements.sheetIdentical = identical;
  assert(
    identical,
    `inlined base64 (${decoded.length} bytes) is NOT byte-identical to ${path.relative(ROOT, SHEET_PATH)} (${sheetBytes.length} bytes)`,
  );

  // The source must also carry that exact literal (not a second, different sheet).
  const literals = findBase64Literals(clientSource);
  measurements.sourceBase64Literals = literals.map((text) => text.length);
  assert(literals.length >= 1, 'no base64 literal found in client.js');
  const sourceMatches = literals.some((text) => decodeBase64(text).equals(sheetBytes));
  assert(sourceMatches, 'no base64 literal in client.js decodes to the shipped frames-sheet.png');

  // FRAME_COUNT == sheet cell count (vertical strip: height / width).
  const cells = sheetImage.height / sheetImage.width;
  measurements.sheetCellCount = cells;
  measurements.declaredFrameCount = frameCount;
  assert(
    Number.isInteger(cells),
    `sheet is ${sheetImage.width}x${sheetImage.height}; not a whole number of square cells (${cells})`,
  );
  assert(
    cells === frameCount,
    `FRAME_COUNT=${frameCount} but the sheet has ${cells} cells (${sheetImage.width}x${sheetImage.height})`,
  );

  // mask-size must map exactly one cell onto the box.
  const sizeValues = [...liveCss.matchAll(/mask-size\s*:\s*([^;}]+)/gi)].map((m) => m[1].trim());
  measurements.maskSizeValues = sizeValues;
  assert(sizeValues.length > 0, 'the emitted CSS has no mask-size declaration');
  const matching = sizeValues.filter((value) => maskSizeMatchesCount(value, frameCount));
  assert(
    matching.length >= 1,
    `no mask-size equals count*100% (${frameCount * 100}%): got ${sizeValues.map((v) => JSON.stringify(v)).join(', ')}`,
  );

  // mask-position must be driven by the frame custom property only.
  const posValues = [...liveCss.matchAll(/mask-position\s*:\s*([^;}]+)/gi)].map((m) => m[1].trim());
  measurements.maskPositionValues = posValues;
  assert(posValues.length > 0, 'the emitted CSS has no mask-position declaration');
  const driven = posValues.filter((value) => /var\(\s*--dsh-whale-frame\b/i.test(value));
  assert(
    driven.length >= 1,
    `mask-position is not driven by --dsh-whale-frame: ${posValues.map((v) => JSON.stringify(v)).join(', ')}`,
  );

  if (framesJson !== null && !framesJson.__parseError) {
    measurements.framesJson = {
      count: framesJson.count,
      cellWidth: framesJson.cellWidth,
      cellHeight: framesJson.cellHeight,
    };
    if (Number.isInteger(framesJson.count)) {
      assert(
        framesJson.count === frameCount,
        `tools/generated/frames.json count=${framesJson.count} but the runtime has ${frameCount} frames`,
      );
    }
  }

  return `sheet ${sheetImage.width}x${sheetImage.height}, ${cells} cells == FRAME_COUNT ${frameCount}, base64 ${decoded.length}B identical ✓, mask-size ${matching[0]}`;
});

// ===========================================================================
// CHECK 5 — AMPLITUDE HONESTY
// ===========================================================================

check('5', 'AMPLITUDE-HONESTY (motion comes from the sheet, runtime adds none)', () => {
  assert(sheetBytes !== null, `missing artifact ${path.relative(ROOT, SHEET_PATH)}`);
  assert(sheetImage && !sheetImage.__decodeError, 'sheet did not decode');
  assert(Number.isInteger(frameCount) && frameCount > 1, `need FRAME_COUNT > 1 (got ${frameCount})`);

  const measured = measureSheet(sheetImage, frameCount, { box: 16 });
  measurements.sheetTravel = {
    cellWidth: measured.cellWidth,
    cellHeight: measured.cellHeight,
    scaleToDisplayPx: Number(measured.scale.toFixed(5)),
    maxFrameToFrameCentroidDisplayPx: Number(measured.maxCentroidDeltaDisplayPx.toFixed(3)),
    maxFrameToFrameCentroidPair: measured.maxCentroidDeltaPair,
    maxFrameToFrameEdgeDisplayPx: Number(measured.maxEdgeDeltaDisplayPx.toFixed(3)),
    fullCycleCentroidTravelDisplayPx: Number(measured.cycleTravelDisplayPx.toFixed(3)),
    fullCycleMaxEdgeTravelDisplayPx: Number(measured.cycleTravelMaxEdgeDisplayPx.toFixed(3)),
    fullCycleMinEdgeTravelDisplayPx: Number(measured.cycleTravelMinEdgeDisplayPx.toFixed(3)),
  };

  assert(
    measured.cycleTravelDisplayPx > 0.05,
    `the sheet itself barely moves: full-cycle fluke travel ${n(measured.cycleTravelDisplayPx)} display px`,
  );
  assert(
    measured.maxCentroidDeltaDisplayPx < 16,
    `implausible frame-to-frame jump ${n(measured.maxCentroidDeltaDisplayPx)} display px (bigger than the 16px box)`,
  );

  // The runtime must contribute no amplitude of its own: no transform, and the
  // mask must show exactly one cell, positioned only by the frame index.
  assert(liveCss !== null, 'no emitted CSS');
  const scanned = maskDataUrls(liveCss);
  const ownMotion = [];
  for (const [label, re] of [
    ['transform', /transform/i],
    ['rotate', /rotate/i],
    ['translate', /translate/i],
    ['scale(', /scale\s*\(/i],
    ['skew', /skew/i],
  ]) {
    if (re.test(scanned)) ownMotion.push(label);
  }
  assert(ownMotion.length === 0, `the runtime adds its own amplitude via: ${ownMotion.join(', ')}`);

  const sizeValues = [...liveCss.matchAll(/mask-size\s*:\s*([^;}]+)/gi)].map((m) => m[1].trim());
  assert(
    sizeValues.some((value) => maskSizeMatchesCount(value, frameCount)),
    'mask-size does not show exactly one sheet cell, so extra motion could be introduced',
  );

  // Derive the paint box the CSS builds inside the shipped 14px slot. The cell is
  // authored for a 16x16 box, so any other box size would SCALE the artwork —
  // amplitude added by the runtime without a single transform token.
  const SLOT_PX = 14;
  const insetValues = [...liveCss.matchAll(/inset\s*:\s*([^;}]+)/gi)].map((m) => m[1].trim());
  measurements.insetValues = insetValues;
  let boxPx = null;
  for (const value of insetValues) {
    const compact = value.replace(/\s+/g, '');
    const asFraction = /^calc\(-100%\/([\d.]+)\)$/.exec(compact);
    const asLength = /^-([\d.]+)px$/.exec(compact);
    if (asFraction) {
      boxPx = SLOT_PX + 2 * (SLOT_PX / Number(asFraction[1]));
      break;
    }
    if (asLength) {
      boxPx = SLOT_PX + 2 * Number(asLength[1]);
      break;
    }
  }
  measurements.paintBoxPx = boxPx === null ? null : Number(boxPx.toFixed(4));
  if (boxPx !== null) {
    measurements.cellScale = Number((boxPx / 16).toFixed(4));
    assert(
      Math.abs(boxPx - 16) <= 0.51,
      `the painted cell box is ${n(boxPx)}px, not the 16px the sheet cell is authored for ` +
        `(that scales the artwork by x${n(boxPx / 16, 4)} — amplitude the runtime added)`,
    );
  }

  return (
    `cell ${measured.cellWidth}x${measured.cellHeight} -> 16px box (x${n(measured.scale, 4)}); ` +
    `silhouette centroid: max per-frame delta ${n(measured.maxCentroidDeltaDisplayPx)}px (${measured.maxCentroidDeltaPair}), full-cycle travel ${n(measured.cycleTravelDisplayPx)}px; ` +
    `fluke-tip edge: max per-frame delta ${n(measured.maxEdgeDeltaDisplayPx)}px (${measured.maxEdgeDeltaPair}), full-cycle travel ${n(measured.cycleTravelMaxEdgeDisplayPx)}px; ` +
    `paint box ${boxPx === null ? 'unknown' : n(boxPx) + 'px'} => mask/cell scale x${measurements.cellScale === undefined ? 'n/a' : n(measurements.cellScale, 4)}, runtime adds 0px`
  );
});

// ===========================================================================
// CHECK 6 — NO-FRAME-SHEET FALLBACK
// ===========================================================================

check('6', 'NO-SHEET-FALLBACK (empty sheet => shipped children survive, no mask injected)', () => {
  const blanked = forceEmptySheet(clientSource);
  const literalsLeft = findBase64Literals(blanked).filter((text) => text.length > 200);
  measurements.blankedSourceLiteralsLeft = literalsLeft.map((text) => text.length);
  measurements.fallbackAlreadyEmpty = blanked === clientSource;
  // Valid when either the blanking changed the source, or it was already empty.
  assert(
    blanked !== clientSource || literalsLeft.length === 0,
    'could not blank the sheet in client.js (no FRAME_SHEET_BASE64 declaration found)',
  );

  const run = makeRunningWorld(blanked, {});
  assert(run.api !== null, `module did not load with an empty sheet: ${run.applyError}`);
  measurements.fallbackLoaded = true;

  let css = '';
  try {
    css = emittedCss(run.api);
  } catch (error) {
    css = '';
  }
  const injected = run.world.insertedCss() || '';
  measurements.fallbackCssLength = css.length;
  measurements.fallbackInjectedLength = injected.length;

  const combined = `${css}\n${injected}`;
  const maskHits = [];
  if (/mask-image/i.test(combined)) maskHits.push('mask-image');
  if (/-webkit-mask-image/i.test(combined)) maskHits.push('-webkit-mask-image');
  if (/data:image\/png;base64,/i.test(combined)) maskHits.push('png data URL');
  if (/display\s*:\s*none/i.test(combined)) maskHits.push('display:none on shipped children');
  measurements.fallbackMaskHits = maskHits;
  assert(
    maskHits.length === 0,
    `with an empty sheet the module still injects motion CSS: ${maskHits.join(', ')}`,
  );

  // The shipped indicator node itself must not be touched.
  const shippedWrites = run.world.records.filter((record) => record.label.startsWith('shipped-child'));
  measurements.fallbackShippedWrites = shippedWrites.length;
  assert(shippedWrites.length === 0, `with an empty sheet the module wrote styles onto the shipped child: ${shippedWrites.length} writes`);

  // The loop must not run either. (Reported, not asserted on its own: a stray
  // custom property that no stylesheet consumes cannot change the rendering.)
  run.world.pump({ charsPerSecond: 60, seconds: 2, tickHz: 60 });
  const frameWrites = run.world.frameWrites().length;
  measurements.fallbackFrameWrites = frameWrites;
  assert(
    frameWrites === 0 || injected.length === 0,
    `with an empty sheet the loop wrote the frame property ${frameWrites} times AND motion CSS was injected`,
  );

  return `blanked ${clientSource.length - blanked.length} chars; css=${css.length}B, injected=${injected.length}B, 0 mask/display:none hits, 0 shipped-child writes, frame writes=${frameWrites}`;
});

// ===========================================================================
// CHECK 7 — GATES
// ===========================================================================

check('7', 'GATES (reduced-motion, forced-colors, @supports)', () => {
  assert(liveCss !== null, 'no emitted CSS');
  const css = liveCss;

  const supportsBlocks = findBlocks(css, /@supports\b/g);
  const noPreferenceBlocks = findBlocks(css, /@media[^{]*prefers-reduced-motion\s*:\s*no-preference/g);
  const forcedBlocks = findBlocks(css, /@media[^{]*forced-colors/g);
  measurements.gates = {
    supportsBlocks: supportsBlocks.map((b) => b.header.trim()),
    noPreferenceBlocks: noPreferenceBlocks.map((b) => b.header.trim()),
    forcedColorBlocks: forcedBlocks.map((b) => b.header.trim()),
  };
  assert(supportsBlocks.length >= 1, 'the emitted CSS has no @supports probe');
  assert(
    /mask/i.test(supportsBlocks[0].header),
    `the @supports probe does not test masking: "${supportsBlocks[0].header.trim()}"`,
  );
  assert(noPreferenceBlocks.length >= 1, 'the emitted CSS has no @media (prefers-reduced-motion:no-preference) gate');

  // NOTE: the @supports *header* itself contains `mask-image:url("")`, so the
  // real paint rule must be located by its data URL, not by a bare "mask-image".
  const maskIndex = css.search(/mask-image\s*:\s*url\(\s*["']?data:/i);
  assert(maskIndex >= 0, 'no data-URL mask-image rule to gate (the stylesheet must paint the sheet)');
  const frameIndex = css.search(/var\(\s*--dsh-whale-frame\b/i);
  assert(frameIndex >= 0, 'no --dsh-whale-frame usage to gate');

  const maskSupports = insideBlock(supportsBlocks, maskIndex);
  const frameSupports = insideBlock(supportsBlocks, frameIndex);
  assert(
    maskSupports !== null && frameSupports !== null,
    'the mask/frame rules are OUTSIDE the @supports probe, so a maskless browser would get them',
  );
  const maskMedia = insideBlock(noPreferenceBlocks, maskIndex);
  const frameMedia = insideBlock(noPreferenceBlocks, frameIndex);
  assert(
    maskMedia !== null && frameMedia !== null,
    'the mask/frame rules are OUTSIDE the reduced-motion gate, so reduced-motion users would animate',
  );
  measurements.gates.maskInsideSupports = true;
  measurements.gates.maskInsideReducedMotionGate = true;

  // reduced-motion runtime behaviour
  const reduced = makeRunningWorld(clientSource, { '(prefers-reduced-motion: reduce)': true });
  assert(reduced.api !== null, 'module did not load under reduced motion');
  reduced.world.pump({ charsPerSecond: 60, seconds: 2, tickHz: 60 });
  const reducedWrites = reduced.world.frameWrites().length;
  measurements.gates.reducedMotionFrameWrites = reducedWrites;

  // forced-colors runtime behaviour
  const forced = makeRunningWorld(clientSource, { '(forced-colors: active)': true });
  assert(forced.api !== null, 'module did not load under forced colors');
  forced.world.pump({ charsPerSecond: 60, seconds: 2, tickHz: 60 });
  const forcedWrites = forced.world.frameWrites().length;
  measurements.gates.forcedColorsFrameWrites = forcedWrites;

  // reduced motion: either the loop stops, or (below) the CSS gate suppresses it.
  assert(
    reducedWrites === 0 || maskMedia !== null,
    `reduced motion neither stops the loop (${reducedWrites} writes) nor gates the CSS`,
  );
  // forced colors: needs a runtime stop or an explicit forced-colors gate.
  const forcedGate =
    forcedBlocks.length > 0 &&
    insideBlock(forcedBlocks, maskIndex) !== null &&
    insideBlock(forcedBlocks, frameIndex) !== null;
  measurements.gates.forcedColorsCssGate = forcedGate;
  assert(
    forcedWrites === 0 || forcedGate,
    `forced colors neither stops the loop (${forcedWrites} writes) nor gates the CSS`,
  );

  return (
    `@supports=${supportsBlocks.length} (probe "${supportsBlocks[0].header.trim()}"), ` +
    `reduced-motion gate=${noPreferenceBlocks.length} with mask inside ✓, ` +
    `runtime writes under reduce=${reducedWrites}, under forced-colors=${forcedWrites}, forced-colors CSS gate=${forcedGate}`
  );
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

try {
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        node: process.version,
        artifacts: {
          client: path.relative(ROOT, CLIENT_PATH),
          clientLength: clientSource.length,
          sheet: path.relative(ROOT, SHEET_PATH),
          sheetBytes: sheetBytes === null ? null : sheetBytes.length,
          framesJson: framesJson === null ? null : path.relative(ROOT, FRAMES_PATH),
        },
        frameCount,
        frameCountSource: frameCountInfo.from,
        results,
        measurements,
      },
      null,
      2,
    ),
  );
} catch (error) {
  log(`note: could not write ${REPORT_PATH}: ${(error && error.message) || error}`);
}

const failed = results.filter((result) => !result.ok);
const passed = results.length - failed.length;

log('');
log(`report: ${path.relative(ROOT, REPORT_PATH)}`);
if (failed.length > 0) {
  console.log(`${failed.length} failing, ${passed} passing — checks: ${failed.map((r) => r.id).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`all ${passed} checks passing`);
}
