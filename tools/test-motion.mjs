/**
 * Offline tests for the `dsh-whale-sway` client half.
 *
 * The module under test is a classic browser script, so it is evaluated in a
 * `node:vm` context with a stubbed document and a hand-pumped clock. That makes
 * the frame loop observable: every write to the frame custom property is
 * recorded, so the tests can prove the motion is frame *selection* rather than
 * any kind of transform, and that it really does speed up with the token rate.
 *
 * Usage: node tools/test-motion.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = resolve(ROOT, 'client.js');

// ---------------------------------------------------------------------------
// tiny assertion harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push({ name, error });
    console.log('  FAIL ' + name + '\n         ' + (error && error.message ? error.message : error));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      (message || 'values differ') +
        '\n         expected: ' +
        JSON.stringify(expected) +
        '\n         actual:   ' +
        JSON.stringify(actual),
    );
  }
}

function near(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(
      (message || 'value out of tolerance') +
        '\n         expected ' +
        expected +
        ' +-' +
        tolerance +
        ', got ' +
        actual,
    );
  }
}

// ---------------------------------------------------------------------------
// VM harness
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(CLIENT, 'utf8');

/** Blank out the spliced sheet, to exercise the unspliced-build path. */
function withoutSheet(source) {
  return source
    .replace(/var FRAME_SHEET_BASE64 = '[^']*';/, "var FRAME_SHEET_BASE64 = '';")
    .replace(/var FRAME_COUNT = \d+;/, 'var FRAME_COUNT = 0;');
}

function loadModule(source) {
  const state = {
    now: 0,
    textLength: 0,
    charsPerSecond: 0,
    reducedMotion: false,
    styleWrites: [],
    removed: [],
    styleTags: [],
    wall: [],
    warnings: [],
    loaded: null,
    disposal: null,
    disposed: false,
    nextId: 0,
    intervals: [],
    rafQueue: [],
  };

  const host = {
    textContent: '',
    closest: () => null,
  };

  const icon = {
    isConnected: true,
    closest: (selector) => (selector === '[data-conversation-scroll]' ? host : null),
    parentElement: host,
    /**
     * A real host carries the icon as a child. `missing` models the shipped CSS
     * module being renamed, which is exactly what the one-shot diagnostic
     * watches for; a host without `querySelector` (any other stub) stays quiet.
     */
    querySelector: (selector) =>
      selector === '[class*="_runningIcon"]' && icon.missing !== true ? icon : null,
  };

  const root = {
    style: {
      setProperty(name, value) {
        state.styleWrites.push({ name, value: String(value) });
      },
      removeProperty(name) {
        state.removed.push(name);
      },
    },
  };

  const head = {
    appendChild(node) {
      node.parentNode = head;
      state.styleTags.push(node);
    },
  };

  const documentStub = {
    documentElement: root,
    head,
    body: host,
    querySelector(selector) {
      if (selector === '[data-chat-running]') return state.indicatorGone ? null : icon;
      // The transcript container the host-miss diagnostic samples for growth.
      if (selector === '[data-conversation-scroll]') return host;
      return null;
    },
    createElement(tag) {
      const element = { tagName: String(tag).toUpperCase(), dataset: {}, textContent: '', parentNode: null };
      state.wall.push(element);
      return element;
    },
  };

  function matchMedia(query) {
    const reduced = state.reducedMotion && query.indexOf('prefers-reduced-motion') !== -1;
    return { matches: reduced, media: query, addEventListener() {}, removeEventListener() {} };
  }

  const windowStub = {
    matchMedia,
    setInterval(fn, ms) {
      state.nextId += 1;
      state.intervals.push({ id: state.nextId, fn, ms, next: state.now + ms });
      return state.nextId;
    },
    clearInterval(id) {
      state.intervals = state.intervals.filter((entry) => entry.id !== id);
    },
    __ModuleLoader__: {
      load(entry) {
        state.loaded = entry;
      },
    },
  };

  function requestAnimationFrame(callback) {
    state.nextId += 1;
    state.rafQueue.push({ id: state.nextId, callback, cancelled: false });
    return state.nextId;
  }

  function cancelAnimationFrame(id) {
    for (const entry of state.rafQueue) if (entry.id === id) entry.cancelled = true;
  }

  const consoleStub = {
    warn(...args) {
      state.warnings.push(args.map(String).join(' '));
    },
    log() {},
    error() {},
  };

  const context = createContext({
    window: windowStub,
    document: documentStub,
    performance: { now: () => state.now },
    requestAnimationFrame,
    cancelAnimationFrame,
    console: consoleStub,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });

  const api = runInContext(source + '\n;globalThis.__dshIconApi', context, { filename: 'client.js' });

  /** Advance simulated time, growing the transcript at `charsPerSecond`. */
  function pump(seconds, charsPerSecond) {
    state.charsPerSecond = charsPerSecond === undefined ? state.charsPerSecond : charsPerSecond;
    const end = state.now + seconds * 1000;
    while (state.now < end) {
      const dt = Math.min(1000 / 60, end - state.now);
      state.now += dt;
      state.textLength += state.charsPerSecond * (dt / 1000);
      host.textContent = 'x'.repeat(Math.round(state.textLength));

      for (const entry of state.intervals.slice()) {
        if (state.now >= entry.next) {
          entry.next += entry.ms;
          entry.fn();
        }
      }

      const queue = state.rafQueue;
      state.rafQueue = [];
      for (const entry of queue) if (!entry.cancelled) entry.callback(state.now);
    }
  }

  /** Install the plugin the way the shell does. */
  function install() {
    const effects = [];
    api.apply({
      effect(fn) {
        effects.push(fn);
        state.disposal = fn();
        return () => {};
      },
    });
    return effects;
  }

  const frames = () =>
    state.styleWrites.filter((write) => write.name === '--dsh-whale-frame').map((write) => write.value);

  return { api, state, pump, install, frames, host, icon, root };
}

// ---------------------------------------------------------------------------
// pure motion maths
// ---------------------------------------------------------------------------

const api = loadModule(SOURCE).api;
/**
 * The strip size the pure maths is exercised with. These tests are about the
 * mapping, not about the build, so they must not depend on the splice having
 * run: a bare checkout has `FRAME_COUNT === 0` and would fail them all.
 */
const STRIP = 24;
/** The strip size actually spliced into client.js; the sheet tests need this. */
const COUNT = api.FRAME_COUNT;

test('clamp bounds the range and survives NaN', () => {
  equal(api.clamp(5, 0, 10), 5);
  equal(api.clamp(-1, 0, 10), 0);
  equal(api.clamp(11, 0, 10), 10);
  equal(api.clamp(Number.NaN, 2, 10), 2);
  equal(api.clamp('4', 0, 10), 4);
});

test('periodForRate is fast at speed, slow at rest, and clamped', () => {
  equal(api.periodForRate(0), api.TUNING.maxPeriodMs, 'idle cycle');
  assert(api.periodForRate(9) < api.periodForRate(0), 'a busy model must cycle faster');
  assert(api.periodForRate(60) < api.periodForRate(9), 'monotone in rate');
  equal(api.periodForRate(1e6), api.TUNING.minPeriodMs, 'peak clamp');
  equal(api.periodForRate(-5), api.TUNING.maxPeriodMs, 'negative rate parks at idle');
});

test('frameIndexForPhase yields whole frames inside the strip', () => {
  for (let i = 0; i < 500; i += 1) {
    const index = api.frameIndexForPhase(i / 137, STRIP);
    assert(Number.isInteger(index), 'frame index must be an integer, got ' + index);
    assert(index >= 0 && index < STRIP, 'frame index out of range: ' + index);
  }
  equal(api.frameIndexForPhase(0, STRIP), 0);
  equal(api.frameIndexForPhase(1, STRIP), 0, 'a full cycle wraps to the first frame');
  equal(api.frameIndexForPhase(-0.5, STRIP) >= 0, true, 'negative phase stays in range');
  equal(api.frameIndexForPhase(-0.5, STRIP) < STRIP, true, 'negative phase stays below the top');
  equal(api.frameIndexForPhase(0, 1), 0, 'a one-frame strip cannot divide by zero');
  equal(api.frameIndexForPhase(Number.NaN, STRIP), 0);
});

test('frameIndexForPhase never skips a frame for small phase steps', () => {
  const step = 1 / (STRIP * 4);
  let previous = api.frameIndexForPhase(0, STRIP);
  for (let phase = 0; phase < 1; phase += step) {
    const index = api.frameIndexForPhase(phase, STRIP);
    const delta = (index - previous + STRIP) % STRIP;
    assert(delta <= 1, 'frame jumped from ' + previous + ' to ' + index);
    previous = index;
  }
});

test('createRateMeter turns appended characters into a smoothed token rate', () => {
  const meter = api.createRateMeter();
  equal(meter.rate, 0, 'starts idle');
  meter.sample(0, 0);
  for (let step = 1; step <= 40; step += 1) {
    // 34 characters per 200ms = 170 chars/s = 100 tok/s at 1.7 chars/token.
    meter.sample(step * 34, step * 200);
  }
  near(meter.rate, 100, 8, 'converges on chars/s / charsPerToken');
  const settled = meter.rate;
  meter.sample(0, 40 * 200 + 200);
  assert(meter.rate <= settled, 'a shrinking transcript must not push the rate up');
  meter.reset();
  equal(meter.rate, 0, 'reset parks the rate');
});

// ---------------------------------------------------------------------------
// the spliced sheet
// ---------------------------------------------------------------------------

test('the sheet is spliced and self-consistent', () => {
  assert(api.hasSheet(), 'client.js has no sheet: run `node tools/build-frames.mjs` then `node tools/sync-sheet.mjs`');
  assert(COUNT >= 2, 'a strip needs at least two frames');
  assert(Number.isInteger(api.FRAME_CELL) && api.FRAME_CELL >= 2, 'cell size must be an integer');
  assert(/^[A-Za-z0-9+/=]+$/.test(api.FRAME_SHEET_BASE64), 'sheet must be plain base64');
  assert(api.buildSheetUrl().startsWith('url("data:image/png;base64,'), 'sheet must become a PNG data URL');
});

test('the sheet is a PNG whose height is count * cell', () => {
  const bytes = Buffer.from(api.FRAME_SHEET_BASE64, 'base64');
  assert(bytes.length > 8, 'sheet bytes are empty');
  equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a', 'PNG signature');
  equal(bytes.toString('latin1', 12, 16), 'IHDR', 'first chunk is IHDR');
  equal(bytes.readUInt32BE(16), api.FRAME_CELL, 'sheet width equals one cell');
  equal(bytes.readUInt32BE(20), api.FRAME_CELL * COUNT, 'sheet height equals count cells');
  assert(bytes.length > 1000, 'sheet looks suspiciously small');
});

// ---------------------------------------------------------------------------
// the stylesheet is pure frame selection
// ---------------------------------------------------------------------------

const CSS = api.buildCss();

test('the stylesheet contains no transform of any kind', () => {
  const forbidden = /\b(transform|rotate|translate|matrix|skew|scale|perspective|animation|transition)\b/i;
  const match = CSS.match(forbidden);
  assert(match === null, 'forbidden motion token in the stylesheet: ' + (match && match[0]));
  assert(CSS.indexOf('will-change') === -1, 'will-change must not be used');
  assert(CSS.indexOf('!important') !== -1, 'the override must win against the shipped rules');
});

test('the stylesheet steps the strip by whole cells', () => {
  assert(CSS.indexOf('mask-image:url("data:image/png;base64,') !== -1, 'the strip is the mask');
  assert(CSS.indexOf('mask-mode:alpha') !== -1, 'the strip is an alpha mask');
  assert(CSS.indexOf('mask-size:100% ' + COUNT * 100 + '%') !== -1, 'the mask holds every cell');
  assert(
    CSS.indexOf('mask-position:0 calc(var(' + api.FRAME_VAR + ',0) / ' + (COUNT - 1) + ' * 100%)') !== -1,
    'mask-position must be driven by the integer frame property',
  );
  assert(CSS.indexOf('-webkit-mask-image') !== -1, 'the -webkit twin is required by the shipped bundle');
  assert(CSS.indexOf('-webkit-mask-position') !== -1, 'the -webkit position twin is required');
});

test('the stylesheet keeps its safety gates', () => {
  assert(CSS.indexOf('@media (prefers-reduced-motion:no-preference)') !== -1, 'reduced-motion gate');
  assert(CSS.indexOf('@supports (mask-mode:alpha)') !== -1, 'masking support gate');
  assert(CSS.indexOf('>*{display:none!important}') !== -1, 'the shipped mark must be hidden');
  assert(CSS.indexOf('contain:none!important') !== -1, 'the frame cell needs the slot to stop clipping');
  assert(CSS.indexOf('overflow:visible!important') !== -1, 'the frame cell needs to paint outside the slot');
  assert(CSS.indexOf('position:relative!important') !== -1, 'the pseudo-element needs a containing block');
  assert(CSS.indexOf('inset:calc(-100% / 14)') !== -1, 'the cell is one fourteenth of the slot wider per side');
  assert(CSS.indexOf('currentColor') !== -1, 'the mark follows the shell text colour');
});

test('an unspliced build injects nothing at all', () => {
  const bare = loadModule(withoutSheet(SOURCE));
  equal(bare.api.hasSheet(), false, 'no sheet means hasSheet() is false');
  equal(bare.api.buildCss(), '', 'no sheet means no stylesheet');
  bare.install();
  equal(bare.state.styleTags.length, 0, 'the shipped indicator must be left alone');
  equal(bare.frames().length, 0, 'no frame writes without a sheet');
  bare.pump(1, 40);
  equal(bare.frames().length, 0, 'still nothing after a second of pumping');
});

test('the module registers itself with the loader', () => {
  const harness = loadModule(SOURCE);
  assert(harness.state.loaded !== null, 'the loader handshake did not happen');
  equal(harness.state.loaded.id, 'dsh-whale-sway', 'loader id');
  const factory = harness.state.loaded.factory;
  const produced = factory();
  equal(typeof produced.apply, 'function', 'factory must return the plugin face');
  equal(typeof produced.buildCss, 'function', 'factory must return the tested helpers');
});

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

test('the loop writes whole frames and nothing else', () => {
  const harness = loadModule(SOURCE);
  harness.install();
  harness.pump(4, 40);
  const writes = harness.frames();
  assert(writes.length > 20, 'expected a steady stream of frame changes, got ' + writes.length);
  const names = Array.from(new Set(harness.state.styleWrites.map((write) => write.name)));
  equal(names.join(','), api.FRAME_VAR, 'the loop may only write the frame property');
  for (const value of writes) {
    assert(/^\d+$/.test(value), 'frame value must be a whole number, got ' + value);
    const index = Number(value);
    assert(index >= 0 && index < COUNT, 'frame out of range: ' + value);
  }
});

test('the tail wags through the whole strip', () => {
  const harness = loadModule(SOURCE);
  harness.install();
  harness.pump(3, 40);
  const seen = new Set(harness.frames().map(Number));
  assert(seen.size >= COUNT - 1, 'expected nearly every frame to be shown, saw ' + seen.size + '/' + COUNT);
});

test('a higher token rate advances more frames per second', () => {
  function rate(harness, charsPerSecond) {
    harness.install();
    harness.pump(6, charsPerSecond);
    harness.state.styleWrites.length = 0;
    harness.pump(2, charsPerSecond);
    return harness.frames().length;
  }
  const slow = rate(loadModule(SOURCE), 4);
  const fast = rate(loadModule(SOURCE), 60);
  const flat = rate(loadModule(SOURCE), 0);
  assert(fast > slow * 1.8, 'fast (' + fast + ' changes / 2s) must clearly beat slow (' + slow + ' changes / 2s)');
  assert(slow > flat, 'a trickle must still beat an idle indicator (' + slow + ' vs ' + flat + ')');
  assert(flat > 0, 'idle still breathes rather than freezing');
});

test('reduced motion keeps the shipped indicator', () => {
  const harness = loadModule(SOURCE);
  harness.state.reducedMotion = true;
  harness.install();
  harness.pump(2, 40);
  equal(harness.frames().length, 0, 'no frames may be written when motion is reduced');
  assert(harness.state.warnings.length === 0, 'reduced motion is not an error: ' + harness.state.warnings.join(' | '));
});

test('disposing clears the frame property and stops the clock', () => {
  const harness = loadModule(SOURCE);
  harness.install();
  harness.pump(1, 40);
  assert(harness.frames().length > 0, 'the loop should have started');
  harness.state.disposal();
  assert(harness.state.removed.indexOf(api.FRAME_VAR) !== -1, 'dispose must remove the frame property');
  equal(harness.state.intervals.length, 0, 'dispose must clear the sampler');
  harness.state.styleWrites.length = 0;
  harness.pump(1, 40);
  equal(harness.frames().length, 0, 'nothing may be written after dispose');
});

test('the loop parks itself when the indicator disappears', () => {
  const harness = loadModule(SOURCE);
  harness.install();
  harness.pump(1, 40);
  harness.state.indicatorGone = true;
  // Let the animation frame that is already scheduled observe the vanished
  // indicator. Emptying the queue here instead would hide the behaviour under
  // test: a parked loop stops rescheduling itself, so a cleared queue is exactly
  // the state we are trying to prove.
  harness.pump(0.5, 40);
  assert(harness.state.removed.indexOf(api.FRAME_VAR) !== -1, 'a vanished indicator must clear the frame property');
  const writesAfterVanish = harness.state.styleWrites.length;
  harness.pump(0.5, 40);
  equal(harness.state.styleWrites.length, writesAfterVanish, 'a parked loop must not write again');
  equal(harness.state.rafQueue.length, 0, 'a parked loop must not reschedule itself');
});

test('a renamed icon class is diagnosed once instead of failing silently', () => {
  const harness = loadModule(SOURCE);
  harness.install();
  harness.pump(1, 40);
  equal(harness.state.warnings.length, 0, 'a healthy indicator must stay quiet: ' + harness.state.warnings.join(' | '));
  harness.icon.missing = true;
  harness.pump(1, 40);
  equal(harness.state.warnings.length, 0, 'a mismatch shorter than the window must stay quiet');
  harness.pump(1, 40);
  equal(harness.state.warnings.length, 1, 'exactly one diagnostic, got: ' + harness.state.warnings.join(' | '));
  assert(harness.state.warnings[0].indexOf('_runningIcon') !== -1, 'the diagnostic must name the missing class token');
  assert(harness.state.warnings[0].indexOf('dsh-whale-sway') !== -1, 'the diagnostic must identify the plugin');
  harness.pump(4, 40);
  equal(harness.state.warnings.length, 1, 'the diagnostic must not repeat');
});

test('streaming with no running host is diagnosed once, and idling never is', () => {
  const harness = loadModule(SOURCE);
  harness.state.indicatorGone = true;
  harness.install();
  harness.pump(3, 0);
  equal(harness.state.warnings.length, 0, 'an idle shell must not be reported');
  harness.pump(3, 40);
  equal(harness.state.warnings.length, 1, 'exactly one diagnostic, got: ' + harness.state.warnings.join(' | '));
  assert(harness.state.warnings[0].indexOf('data-chat-running') !== -1, 'the diagnostic must name the missing attribute');
  harness.pump(3, 40);
  equal(harness.state.warnings.length, 1, 'the diagnostic must not repeat');
});

test('apply tags its stylesheet like a shipped bundle', () => {
  const harness = loadModule(SOURCE);
  harness.install();
  equal(harness.state.styleTags.length, 1, 'exactly one stylesheet is injected');
  const tag = harness.state.styleTags[0];
  equal(tag.tagName, 'STYLE', 'a style element');
  equal(tag.dataset.pluginCss, api.CSS_TAG, 'tagged with the bundle stylesheet identity');
  equal(tag.dataset.plugin, 'dsh-whale-sway', 'tagged with the plugin id');
  equal(tag.textContent, CSS, 'the injected stylesheet is the built one');
});

// ---------------------------------------------------------------------------
// the host half
// ---------------------------------------------------------------------------

const host = await import(pathToFileURL(resolve(ROOT, 'index.js')).href);

test('the host half declares the plugin without a runtime dependency', () => {
  equal(host.name, 'dsh-whale-sway', 'host plugin name');
  equal(Array.isArray(host.inject), true, 'host inject must be an array');
  equal(typeof host.apply, 'function', 'host apply must exist');
});

test('package.json ships both halves and keeps the toolchain out of the tarball', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  equal(pkg.name, 'dsh-whale-sway', 'package name');
  assert(/^0\.2\./.test(pkg.version), 'the frame-stepping rewrite is a 0.2.x release, got ' + pkg.version);
  assert(pkg.files.indexOf('client.js') !== -1, 'client.js must ship');
  assert(pkg.files.indexOf('index.js') !== -1, 'index.js must ship');
  assert(pkg.files.indexOf('cordis.patch.yml') !== -1, 'cordis.patch.yml must ship');
  assert(pkg.files.indexOf('LICENSE') !== -1, 'LICENSE must ship');
  assert(pkg.files.indexOf('tools') === -1, 'the toolchain stays in the repository, not in the tarball');
  assert(pkg.files.indexOf('preview') === -1, 'the source artwork stays in the repository, not in the tarball');
  assert(pkg.exports['./client'] !== undefined, 'the client entry must exist');
  equal(pkg.dsh.client.platform, 'web', 'the client half targets the web platform');
});

// ---------------------------------------------------------------------------

console.log('');
console.log('client.js sha256 = ' + createHash('sha256').update(SOURCE).digest('hex').slice(0, 16));
console.log(passed + ' passed, ' + failures.length + ' failed');

if (failures.length > 0) {
  console.log('');
  for (const failure of failures) console.log('FAILED: ' + failure.name);
  process.exitCode = 1;
}
