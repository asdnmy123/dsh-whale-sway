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

/**
 * Blank out the spliced payload, to exercise the unspliced-build path.
 *
 * The splice carries the whole payload twice — once as `MODE_PANELS`, once as
 * the default mode's legacy constants — so a bare checkout is modelled by
 * emptying both: the base64 becomes `''`, the strip counts become `0`, and the
 * panel array becomes empty.
 */
function withoutSheet(source) {
  return source
    .replace(/var MODE_PANELS = \[[\s\S]*?\n  \];/, 'var MODE_PANELS = [];')
    .replace(/var FRAME_SHEET_BASE64 = '[\s\S]*?';/, "var FRAME_SHEET_BASE64 = '';")
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
    removedStyles: [],
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

  /**
   * A stand-in for one element's inline style declaration: the writes the
   * controller makes, the read it makes to notice a host a re-render replaced,
   * and the removals it makes when it stops painting. Every mutation records the
   * element it happened on, because which element carries the paint properties is
   * exactly what makes one stylesheet serve three strips.
   */
  function createStyle(owner) {
    const values = new Map();
    return {
      values,
      setProperty(name, value) {
        const text = String(value);
        values.set(name, text);
        state.styleWrites.push({ name, value: text, owner });
      },
      getPropertyValue(name) {
        return values.has(name) ? values.get(name) : '';
      },
      removeProperty(name) {
        values.delete(name);
        state.removed.push(name);
      },
    };
  }

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
  icon.style = createStyle('icon');

  const root = { style: createStyle('root') };

  const head = {
    appendChild(node) {
      node.parentNode = head;
      state.styleTags.push(node);
    },
    removeChild(node) {
      node.parentNode = null;
      state.removedStyles.push(node);
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

  /**
   * Install the plugin the way the shell does.
   *
   * @param extra - context members a test adds (services, `inject`, …).
   * @returns the registered effect callbacks, in the order apply() registered them.
   */
  function install(extra) {
    const effects = [];
    api.apply(
      Object.assign(
        {
          effect(fn) {
            effects.push(fn);
            const product = fn();
            // The first effect is the animation's; later ones (the configuration
            // page) have their own disposers and must not shadow it.
            if (state.disposal === null) state.disposal = product;
            return () => {};
          },
        },
        extra || {},
      ),
    );
    return effects;
  }

  /** Every value written for one paint property, in write order. */
  const writesOf = (name) =>
    state.styleWrites.filter((write) => write.name === name).map((write) => write.value);
  const frames = () => writesOf(api.FRAME_VAR);
  const offsets = () => writesOf('--' + api.POS_VAR);

  /** The element each paint property was last written on, or null. */
  function writerOf(name) {
    const matches = state.styleWrites.filter((write) => write.name === name);
    return matches.length === 0 ? null : matches[matches.length - 1].owner;
  }

  return { api, state, pump, install, frames, offsets, writesOf, writerOf, host, icon, root };
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

test('the stylesheet is one mode-independent rule driven by the paint properties', () => {
  const sheet = '--' + api.SHEET_VAR;
  const cells = '--' + api.CELLS_VAR;
  const position = '--' + api.POS_VAR;
  assert(CSS.indexOf('mask-image:var(' + sheet + ')') !== -1, 'the mask reads the selected strip');
  assert(CSS.indexOf('-webkit-mask-image:var(' + sheet + ')') !== -1, 'the -webkit twin is required');
  assert(
    CSS.indexOf('mask-size:100% calc(var(' + cells + ',' + COUNT + ') * 100%)') !== -1,
    'the mask height is the active strip cell count',
  );
  assert(CSS.indexOf('mask-position:0 var(' + position + ',0%)') !== -1, 'the mask position reads the loop percentage');
  assert(CSS.indexOf('-webkit-mask-position') !== -1, 'the -webkit position twin is required');
  assert(CSS.indexOf('mask-mode:alpha') !== -1, 'the strip is an alpha mask');
  // Exactly one strip is inlined, and it is the default mode's. One inlined strip
  // is the whole point of the mode-independent rule; the default one is what
  // makes the first painted frame correct before the configuration is read.
  const inlined = api.MODE_PANELS.filter((panel) => CSS.indexOf(panel.base64) !== -1);
  equal(inlined.length, 1, 'exactly one strip may be inlined in the stylesheet');
  equal(inlined[0].id, api.DEFAULT_MODE, "the inlined strip is the default mode's");
});

test('all three sways are embedded and selectable at runtime', () => {
  equal(api.MODE_PANELS.length, 3, 'all three sways must be spliced');
  const ids = api.MODE_PANELS.map((panel) => panel.id);
  for (const id of ['sway', 'sway-gentle', 'sway-vivid']) {
    assert(ids.indexOf(id) !== -1, 'missing sway ' + id + ' (have ' + ids.join(', ') + ')');
    const panel = api.panelForMode(id);
    equal(panel.id, id, 'panelForMode must resolve ' + id);
    assert(panel.base64.length > 1000, id + ': its strip must be embedded, not a placeholder');
  }
  equal(api.panelForMode('no-such-sway').id, api.DEFAULT_MODE, 'an unknown mode falls back to the default sway');
});

test('every registered sway mode is spliced with a matching strip and cell count', () => {
  assert(api.MODE_PANELS.length >= 3, 'all shipped sway modes must be spliced, got ' + api.MODE_PANELS.length);
  const seen = new Set();
  for (const panel of api.MODE_PANELS) {
    assert(typeof panel.id === 'string' && panel.id.length > 0, 'each panel names its mode');
    assert(!seen.has(panel.id), 'duplicate mode id ' + panel.id);
    seen.add(panel.id);
    assert(Number.isInteger(panel.count) && panel.count >= 2, panel.id + ': count must be an integer >= 2');
    assert(Number.isInteger(panel.cell) && panel.cell >= 2, panel.id + ': cell must be an integer >= 2');
    const bytes = Buffer.from(panel.base64, 'base64');
    assert(bytes.length > 1000, panel.id + ': the strip looks suspiciously small');
    equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a', panel.id + ': PNG signature');
    equal(bytes.readUInt32BE(16), panel.cell, panel.id + ': sheet width is one cell');
    equal(bytes.readUInt32BE(20), panel.cell * panel.count, panel.id + ': sheet height is count cells');
    assert(/(^|\/)preview\/[a-z-]+\.gif$/.test(panel.source), panel.id + ': source must name a preview GIF');
  }
  assert(seen.has(api.DEFAULT_MODE), 'the default mode must be one of the spliced panels');
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

test('the loop writes whole frames and the offset, and nothing else', () => {
  const harness = loadModule(SOURCE);
  harness.install();
  harness.pump(4, 40);
  const writes = harness.frames();
  assert(writes.length > 20, 'expected a steady stream of frame changes, got ' + writes.length);
  const names = Array.from(new Set(harness.state.styleWrites.map((write) => write.name)));
  // Per frame: the integer index and the finished percentage. Once per mode: the
  // strip, its cell count, and its mode id. Nothing else may reach the style
  // engine — no transform, no geometry, no interpolated pose.
  const allowed = [api.FRAME_VAR, '--' + api.POS_VAR, '--' + api.SHEET_VAR, '--' + api.CELLS_VAR, api.MODE_VAR].sort();
  equal(names.slice().sort().join(','), allowed.join(','), 'unexpected style writes: ' + names.join(', '));
  for (const value of writes) {
    assert(/^\d+$/.test(value), 'frame value must be a whole number, got ' + value);
    const index = Number(value);
    assert(index >= 0 && index < COUNT, 'frame out of range: ' + value);
  }
  const positions = harness.state.styleWrites
    .filter((write) => write.name === '--' + api.POS_VAR)
    .map((write) => write.value);
  equal(positions.length, writes.length, 'every frame change carries its strip offset');
  for (const value of positions) {
    assert(/^\d+(\.\d+)?%$/.test(value), 'offset must be a percentage, got ' + value);
  }
  assert(
    harness.state.styleWrites.every((write) => write.owner === 'icon'),
    'the paint properties belong on the indicator element, not on <html>',
  );
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
// the configuration contract
// ---------------------------------------------------------------------------

const settings = await import(pathToFileURL(resolve(ROOT, 'tools/settings.mjs')).href);

test('the spliced settings contract is tools/settings.mjs, verbatim', () => {
  equal(
    JSON.stringify(api.SETTINGS_FIELDS),
    JSON.stringify(settings.SETTINGS_FIELDS),
    'the field table in client.js must be the registry table',
  );
  equal(
    JSON.stringify(api.SETTINGS_GROUPS),
    JSON.stringify(settings.SETTINGS_GROUPS),
    'the group table in client.js must be the registry table',
  );
  equal(
    JSON.stringify(api.SETTINGS_I18N),
    JSON.stringify(settings.settingsDictionary()),
    'the dictionary in client.js must be the registry dictionary',
  );
  equal(api.SETTINGS_NS, settings.SETTINGS_NAMESPACE, 'the settings namespace is the package name');
  equal(api.ROW_CONFIG_KEY, settings.SETTINGS_NAMESPACE + '#' + settings.SETTINGS_NAMESPACE, 'the row key is <package>#<row>');
  equal(api.BUNDLE_CONFIG_KEY, settings.SETTINGS_NAMESPACE, 'the bundle key is the package name');
});

test('the mode field offers every shipped sway, in every language', () => {
  const field = api.SETTINGS_FIELDS.find((entry) => entry.id === 'mode');
  assert(field !== undefined, 'the configuration must expose the sway mode');
  equal(field.type, 'enum', 'the sway mode is a finite choice');
  equal(field.control, 'segmented', 'the previews keep the shared finite-choice field contract');
  equal(field.values.length, 3, 'all three sways are choices');
  equal(field.default, api.DEFAULT_MODE, 'the default choice is the default sway');
  for (const panel of api.MODE_PANELS) {
    assert(field.values.indexOf(panel.id) !== -1, panel.id + ' must be selectable');
    assert(api.SETTINGS_I18N.zh['field.mode.option.' + panel.id] !== undefined, panel.id + ' needs a Chinese segment label');
    assert(api.SETTINGS_I18N.en['field.mode.option.' + panel.id] !== undefined, panel.id + ' needs an English segment label');
  }
  for (const locale of ['zh', 'en']) {
    for (const key of Object.keys(api.SETTINGS_I18N[locale])) {
      const text = api.SETTINGS_I18N[locale][key];
      assert(typeof text === 'string' && text.length > 0, locale + ' ' + key + ' must carry copy');
      // Official voice: no second person, in either language.
      assert(!/你|您|your\b/i.test(text), locale + ' ' + key + ' must not address a reader: ' + text);
    }
  }
});

test('normalizeConfig accepts the document, clamps numbers, and defaults the rest', () => {
  const defaults = api.defaultConfig();
  equal(
    Object.keys(defaults).sort().join(','),
    api.SETTINGS_FIELDS.map((field) => field.id).sort().join(','),
    'one default per field',
  );
  equal(defaults.mode, api.DEFAULT_MODE, 'the default sway');
  equal(defaults.enabled, true, 'the animation is on out of the box');
  const dirty = api.normalizeConfig({
    mode: 'sway-vivid',
    enabled: false,
    minPeriodMs: -100,
    maxPeriodMs: 1e9,
    charsPerToken: '2.5',
    sampleMs: 'nonsense',
    unknown: 7,
  });
  equal(dirty.mode, 'sway-vivid', 'a declared sway is kept');
  equal(dirty.enabled, false, 'a boolean is kept');
  equal(dirty.minPeriodMs, 60, 'a number below its bound is clamped to the bound');
  equal(dirty.maxPeriodMs, 10000, 'a number above its bound is clamped to the bound');
  equal(dirty.charsPerToken, 2.5, 'a numeric string is accepted');
  equal(dirty.sampleMs, defaults.sampleMs, 'an unparsable value falls back to the default');
  equal(dirty.unknown, undefined, 'unknown keys never reach the runtime');
  equal(JSON.stringify(api.normalizeConfig(null)), JSON.stringify(defaults), 'a missing document yields the defaults');
  equal(api.normalizeConfig({ mode: 'sway-nope' }).mode, api.DEFAULT_MODE, 'an unknown sway falls back to the default');
  const inverted = api.normalizeConfig({ minPeriodMs: 900, maxPeriodMs: 300 });
  assert(inverted.maxPeriodMs >= inverted.minPeriodMs, 'an inverted interval is repaired');
});

/**
 * A minimal React: enough for the configuration card's element tree, and small
 * enough that a test reads what the card asked to render rather than a DOM.
 */
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children };
  },
};

/**
 * A stand-in for `@deepseek-ai/dsh-client-ui-primitives`: the staged form model,
 * the shipped numeric field spec, and name-only stubs for the controls, so a
 * test can assert exactly what the page contributed and what it renders.
 */
function fakePrimitives() {
  const calls = { edits: [], resets: [] };
  class SettingsFormModel {
    constructor(scope, specs) {
      this.scope = scope;
      this.specs = specs;
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false };
    }
    field(id) {
      const value = this.scope.getSnapshot().value;
      return { text: String(value === undefined ? '' : value[id]), overridden: false, invalid: false };
    }
    bind(project) {
      return { getSnapshot: project, subscribe: () => () => {} };
    }
    actions() {
      return {
        edit: (id, text) => calls.edits.push({ id, text }),
        resetField: (id) => calls.resets.push(id),
        save: () => {},
        discard: () => {},
      };
    }
    dispose() {}
  }
  return {
    calls,
    SettingsFormModel,
    settingsNumberField: (field) => ({
      field,
      format: (value) => String(value),
      parse: (text) => ({ kind: 'set', value: Number(text) }),
    }),
    SettingsForm: 'SettingsForm',
    SettingsValueField: 'SettingsValueField',
    SegmentedControl: 'SegmentedControl',
    Switch: 'Switch',
  };
}

/** Visit every element node in a fake-React tree. */
function walkTree(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) walkTree(item, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  for (const child of node.children || []) walkTree(child, visit);
}

test('the Plugins page is given the configuration, and the document repaints the sway', () => {
  const harness = loadModule(SOURCE);
  const primitives = fakePrimitives();
  harness.api.setModuleRequire((specifier) => {
    if (specifier === 'react') return fakeReact;
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error('unexpected require: ' + specifier);
  });

  const registrations = [];
  const dictionaries = [];
  const listeners = [];
  let documentValue = { mode: 'sway-vivid', enabled: true };
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: documentValue,
      base: {},
      user: documentValue,
      revision: 1,
      writable: true,
      mode: 'host',
    }),
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
    mutate: async () => true,
    set: async () => true,
    unset: async () => true,
  };
  const scoped = {
    locale: {
      bind: () => (key) => key,
      register(namespace, dictionary) {
        dictionaries.push({ namespace, dictionary });
        return () => {};
      },
    },
    slots: {
      inject(slot, callback) {
        callback();
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    configForms: { get: () => scope, whileServed: (namespaces, register) => register() },
  };

  const effects = [];
  harness.api.apply({
    effect(fn) {
      effects.push(fn);
      return () => {};
    },
    inject(deps, callback) {
      callback(scoped);
      return { dispose() {} };
    },
  });
  for (const fn of effects) fn();

  equal(registrations.length, 3, 'the configuration reaches Settings navigation and both Plugins-page seats');
  const keys = registrations.filter((entry) => entry.options.key).map((entry) => entry.options.key).sort();
  equal(
    keys.join(','),
    [harness.api.BUNDLE_CONFIG_KEY, harness.api.ROW_CONFIG_KEY].sort().join(','),
    'the keys are the package name and <package>#<row>',
  );
  for (const entry of registrations) {
    assert(
      ['settings.section', 'plugins.bundle.config', 'plugins.row.config'].includes(entry.options.name),
      'registered on a settings or plugin configuration slot, got ' + entry.options.name,
    );
    equal(entry.options.locale, harness.api.SETTINGS_NS, 'the page owns the plugin dictionary');
    equal(typeof entry.component, 'function', 'the slot carries a component');
  }
  equal(dictionaries.length, 1, 'exactly one dictionary is registered');
  equal(dictionaries[0].namespace, harness.api.SETTINGS_NS, 'the dictionary namespace is the plugin');
  equal(
    JSON.stringify(dictionaries[0].dictionary),
    JSON.stringify(harness.api.SETTINGS_I18N),
    'the registered dictionary is the generated one',
  );

  const pluginCard = registrations.find((entry) => entry.options.name === 'plugins.row.config');
  const face = pluginCard.options.inject();
  const projection = face.hooks.whaleSwayConfig.getSnapshot();
  equal(projection.fields.mode.text, 'sway-vivid', 'the staged mode is the document\'s mode');
  equal(projection.state.available, true, 'the form is available while the Host serves the namespace');

  const card = pluginCard.component({
    t: (key) => key,
    view: 'page',
    useWhaleSwayConfig: (select) => select(projection),
    edit: face.edit,
    resetField: face.resetField,
    save: face.save,
    discard: face.discard,
  });
  const types = [];
  walkTree(card, (node) => types.push(node.type));
  const previews = [];
  walkTree(card, (node) => { if (node.props['data-sway-preview']) previews.push(node); });
  equal(previews.length, 3, 'every sway mode renders a preview');
  equal(types.filter((type) => type === 'SettingsValueField').length, 7, 'every number field renders a value field');
  equal(types.filter((type) => type === 'Switch').length, 1, 'the enable switch renders once');
  const summary = pluginCard.component({ t: (key) => key, view: 'summary' });
  equal(summary, 'page.summary', 'the summary view is the row\'s one-liner');

  // The document selects a sway: the icon must carry that mode's own strip.
  harness.pump(1, 40);
  const sheets = () => harness.state.styleWrites.filter((write) => write.name === '--' + harness.api.SHEET_VAR);
  assert(sheets().length >= 1, 'the configured sway must be written onto the icon');
  // The LAST write is the one under test: the plugin paints its own default the
  // moment it applies, and adopts the document as soon as the settings mirror
  // reports one, so the first write is the default sway by construction.
  equal(
    sheets()[sheets().length - 1].value.indexOf(harness.api.panelForMode('sway-vivid').base64) !== -1,
    true,
    'the inline strip is the configured mode\'s',
  );

  // Changing the mode repaints without a reload.
  documentValue = { mode: 'sway-gentle', enabled: true };
  for (const listener of listeners.slice()) listener();
  assert(sheets().length >= 2, 'a mode change rewrites the strip');
  equal(
    sheets()[sheets().length - 1].value.indexOf(harness.api.panelForMode('sway-gentle').base64) !== -1,
    true,
    'the rewritten strip is the new mode\'s',
  );

  // Switching the animation off restores the shipped indicator: the animation
  // stylesheet goes away with it, because that stylesheet is what hides the
  // shipped mark. The configuration page keeps its own stylesheet, so the page
  // still renders while the animation is off.
  const attached = () => harness.state.styleTags.filter((tag) => tag.parentNode !== null);
  documentValue = { mode: 'sway-gentle', enabled: false };
  for (const listener of listeners.slice()) listener();
  equal(attached().length, 1, 'only the configuration page stylesheet may survive a disable');
  equal(attached()[0].dataset.pluginCss, harness.api.PAGE_CSS_TAG, 'the survivor is the page stylesheet');
  const framesWhileDisabled = harness.frames().length;
  harness.pump(1, 40);
  equal(harness.frames().length, framesWhileDisabled, 'the loop stays parked while the animation is off');

  // ... and switching it back on reinstalls the animation stylesheet.
  documentValue = { mode: 'sway', enabled: true };
  for (const listener of listeners.slice()) listener();
  equal(attached().length, 2, 'enabling reinstalls the animation stylesheet');
  assert(
    attached().some((tag) => tag.dataset.pluginCss === harness.api.CSS_TAG),
    'the reinstalled stylesheet is the animation one',
  );
});

// ---------------------------------------------------------------------------
// settings navigation and registration lifecycle
// ---------------------------------------------------------------------------

/** Simulate the two independent gates: a served config and a declared slot. */
function settingsHarness() {
  const harness = loadModule(SOURCE);
  const primitives = fakePrimitives();
  let disposedModels = 0;
  const BaseModel = primitives.SettingsFormModel;
  primitives.SettingsFormModel = class extends BaseModel {
    dispose() { disposedModels += 1; }
  };
  harness.api.setModuleRequire((id) => id === 'react' ? fakeReact : primitives);
  const listeners = new Set();
  const registrations = new Map();
  const declared = new Set();
  const waiting = new Map();
  let language = 'zh';
  let served = false;
  let registerServed;
  let offServed = null;
  let dictionaries = 0;
  const scope = {
    getSnapshot: () => ({ status: served ? 'ready' : 'unavailable', value: harness.api.defaultConfig() }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const scoped = {
    locale: {
      bind: () => (key) => harness.api.SETTINGS_I18N[language][key],
      register() { dictionaries += 1; return () => { dictionaries -= 1; }; },
    },
    slots: {
      inject(name, callback) {
        const item = { callback, off: null };
        if (!waiting.has(name)) waiting.set(name, new Set());
        waiting.get(name).add(item);
        if (declared.has(name)) item.off = callback();
        return () => { waiting.get(name).delete(item); item.off?.(); };
      },
      register(options, component) {
        if (!declared.has(options.name)) throw new Error('slot not declared: ' + options.name);
        if (registrations.has(options.name)) throw new Error('duplicate slot: ' + options.name);
        registrations.set(options.name, { options, component });
        return () => registrations.delete(options.name);
      },
    },
    configForms: {
      get: () => scope,
      whileServed(namespaces, callback) {
        equal(namespaces.join(','), harness.api.SETTINGS_NS, 'only the plugin namespace gates registration');
        registerServed = callback;
        return () => { offServed?.(); offServed = null; registerServed = null; };
      },
    },
  };
  const dispose = harness.api.mountConfiguration({
    inject(deps, mount) { mount(scoped); return { dispose() {} }; },
  }, { setConfig() {} }, harness.api.defaultConfig(), () => {});
  return {
    ...harness, primitives, registrations, listeners,
    declare(name) {
      declared.add(name);
      for (const item of waiting.get(name) || []) item.off = item.callback();
    },
    serve(next) {
      served = next;
      if (next) offServed = registerServed();
      else { offServed?.(); offServed = null; }
      for (const listener of listeners) listener();
    },
    setLanguage(next) { language = next; },
    dispose,
    get disposedModels() { return disposedModels; },
    get dictionaries() { return dictionaries; },
  };
}

test('settings navigation waits for the host form and slot, and follows the locale', () => {
  const h = settingsHarness();
  equal(h.registrations.size, 0, 'an unserved form has no navigation entry');
  h.serve(true);
  equal(h.registrations.size, 0, 'a served form still waits for slot declaration');
  h.declare('settings.section');
  const section = h.registrations.get('settings.section');
  assert(section, 'a declared settings section receives the page');
  equal(section.options.id, h.api.SETTINGS_NS, 'section identity is stable and unique');
  equal(section.options.key, undefined, 'list slots use id rather than a keyed card identity');
  equal(section.options.locale, h.api.SETTINGS_NS, 'section uses the plugin locale');
  assert(Number.isFinite(section.options.order), 'navigation has an explicit position');
  equal(section.options.label(), '鲸尾摆动', 'Chinese navigation label');
  h.setLanguage('en');
  equal(section.options.label(), 'Whale tail', 'the registered label follows locale changes');
  h.dispose();
});

test('settings page renders all controls and shares drafts and actions with plugin details', () => {
  const h = settingsHarness();
  for (const name of ['settings.section', 'plugins.row.config', 'plugins.bundle.config']) h.declare(name);
  h.serve(true);
  const section = h.registrations.get('settings.section');
  const face = section.options.inject();
  for (const entry of h.registrations.values()) {
    const other = entry.options.inject();
    equal(other.hooks.whaleSwayConfig, face.hooks.whaleSwayConfig, 'every entry shares the draft store');
  }
  const props = {
    ...face, t: (key) => h.api.SETTINGS_I18N.zh[key],
    useWhaleSwayConfig: (select) => select(face.hooks.whaleSwayConfig.getSnapshot()),
  };
  const nodes = [];
  function expand(node) {
    if (Array.isArray(node)) { node.forEach(expand); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'function') { expand(node.type(node.props)); return; }
    nodes.push(node);
    (node.children || []).forEach(expand);
  }
  expand(section.component(props));
  assert(nodes.some((node) => /^h[1-4]$/.test(node.type) && node.children.includes(props.t('page.title'))), 'page has a localized heading');
  const form = nodes.find((node) => node.type === 'SettingsForm');
  assert(form, 'section renders the shared form');
  equal(form.props.onSave, face.save, 'saving uses the same staged form action');
  equal(form.props.onDiscard, face.discard, 'discarding uses the same staged form action');
  equal(form.props.labels.save, '保存', 'the save action has generated Chinese text');
  const numbers = nodes.filter((node) => node.type === 'SettingsValueField');
  equal(numbers.length, 7, 'all numeric parameters are editable');
  numbers[0].props.onEdit('240');
  numbers[0].props.onReset();
  const mode = nodes.find((node) => node.type === 'button' && node.props['aria-label'] === '大摆');
  mode.props.onClick();
  nodes.find((node) => node.type === 'Switch').props.onChange(false);
  equal(h.primitives.calls.edits.map((edit) => edit.id).join(','), 'minPeriodMs,mode,enabled', 'controls edit their own shared fields');
  equal(h.primitives.calls.resets.join(','), 'minPeriodMs', 'reset stages the field default');
  h.dispose();
});

/** Read the real configuration component with controllable drafts and permissions. */
function previewCard({ mode = 'sway', writable = true, locale = 'zh' } = {}) {
  const snapshot = {
    state: { available: true, writable, dirty: false, invalid: false, saving: false, failed: false },
    fields: Object.fromEntries(api.SETTINGS_FIELDS.map((field) => [field.id, {
      text: String(field.id === 'mode' ? mode : field.default), overridden: false, invalid: false,
    }])),
  };
  const edits = [];
  let saves = 0;
  const props = {
    t: (key) => api.SETTINGS_I18N[locale][key],
    useWhaleSwayConfig: (select) => select(snapshot),
    edit: (field, text) => edits.push({ field, text }), resetField() {}, discard() {},
    save() { saves += 1; },
  };
  const Card = api.createConfigCard(fakeReact, fakePrimitives()).ConfigCard;
  const nodes = [];
  walkTree(Card(props), (node) => nodes.push(node));
  return { nodes, edits, get saves() { return saves; } };
}

test('sway previews use each shipped sprite sheet and expose a single selected choice', () => {
  for (const panel of api.MODE_PANELS) {
    const card = previewCard({ mode: panel.id });
    const icons = card.nodes.filter((node) => node.props['data-sway-preview']);
    equal(icons.length, 3, 'three separate previews are rendered');
    for (const icon of icons) {
      const source = api.panelForMode(icon.props['data-sway-preview']);
      equal(icon.props['aria-hidden'], true, 'the decorative image does not duplicate the choice label');
      equal(icon.props.style.maskImage, 'url("data:image/png;base64,' + source.base64 + '")', 'the preview uses the real matching artwork');
      equal(icon.props.style.WebkitMaskImage, icon.props.style.maskImage, 'WebKit uses the same artwork');
      equal(icon.props.style.maskSize, '100% ' + source.count * 100 + '%', 'exactly one sprite cell fills the preview');
    }
    const buttons = card.nodes.filter((node) => node.type === 'button' && node.props['aria-pressed'] !== undefined);
    equal(buttons.length, 3, 'all three previews are keyboard-operable buttons');
    equal(buttons.filter((node) => node.props['aria-pressed']).length, 1, 'only the draft choice is selected');
    const selected = buttons.find((node) => node.props['aria-pressed']);
    const selectedIcon = [];
    walkTree(selected, (node) => { if (node.props['data-sway-preview']) selectedIcon.push(node); });
    equal(selectedIcon[0].props['data-sway-preview'], panel.id, 'the selected tile follows the draft');
  }
});

test('preview selection stages a mode and obeys read-only state in both languages', () => {
  for (const locale of ['zh', 'en']) {
    const card = previewCard({ locale });
    const buttons = card.nodes.filter((node) => node.type === 'button' && node.props['aria-pressed'] !== undefined);
    const labels = api.SETTINGS_FIELDS.find((field) => field.id === 'mode').options;
    buttons.forEach((button, index) => {
      equal(button.props.type, 'button', 'choosing a preview cannot submit the form');
      equal(button.props['aria-label'], labels[index].label[locale], 'the choice has a localized accessible name');
      equal(button.props.disabled, false, 'writable forms allow preview selection');
      button.props.onClick();
    });
    equal(card.edits.map((edit) => edit.field).join(','), 'mode,mode,mode', 'previews edit only the mode');
    equal(card.edits.map((edit) => edit.text).join(','), api.MODE_PANELS.map((panel) => panel.id).join(','), 'each choice stages its own mode');
    equal(card.saves, 0, 'preview selection leaves persistence to Save');
    const readOnly = previewCard({ locale, writable: false });
    const disabled = readOnly.nodes.filter((node) => node.type === 'button' && node.props['aria-pressed'] !== undefined);
    assert(disabled.every((node) => node.props.disabled), 'read-only forms disable every choice while retaining previews');
  }
});

test('preview animation shows every whole sprite cell once per uniform cycle', () => {
  const css = api.pageCss();
  for (const panel of api.MODE_PANELS) {
    const keyframes = 'dsh-whale-sway-config-preview-' + panel.id;
    const start = css.indexOf('@keyframes ' + keyframes + '{');
    assert(start >= 0, 'the mode has its own animation: ' + panel.id);
    const block = css.slice(start, css.indexOf('}}', start) + 2);
    const stops = [...block.matchAll(/([\d.]+)%\{mask-position:0 ([\d.]+)(?:%|;)/g)];
    equal(stops.length, panel.count + 1, 'every frame has a stop, plus the loop boundary');
    stops.slice(0, panel.count).forEach((stop, frame) => {
      near(Number(stop[1]), frame / panel.count * 100, 1e-8, 'every frame has equal display time');
      near(Number(stop[2]) / 100 * (panel.count - 1), frame, 1e-8, 'each position lands on a whole sprite cell');
    });
    equal(Number(stops.at(-1)[1]), 100, 'loop boundary is at the end');
    equal(Number(stops.at(-1)[2]), 0, 'loop returns to the first frame');
    assert(css.includes(keyframes + ' 1000ms steps(1,end) infinite'), 'all previews use the same discrete one-second cycle');
  }
  assert(css.includes('@media (prefers-reduced-motion:no-preference)'), 'automatic playback respects reduced-motion preference');
  assert(css.includes(':focus-visible'), 'keyboard navigation has visible focus');
});

test('settings contributions disappear on unserve and unload, and return without duplicates', () => {
  const h = settingsHarness();
  for (const name of ['settings.section', 'plugins.row.config', 'plugins.bundle.config']) h.declare(name);
  h.serve(true);
  equal(h.registrations.size, 3, 'all three entries are mounted');
  h.serve(false);
  equal(h.registrations.size, 0, 'unserved namespaces remove navigation and detail entries');
  h.serve(true);
  equal(h.registrations.size, 3, 'serving again restores exactly one of each entry');
  h.dispose();
  equal(h.registrations.size, 0, 'unload removes every entry');
  equal(h.listeners.size, 0, 'unload removes the runtime document subscription');
  equal(h.dictionaries, 0, 'unload removes the locale dictionary');
  equal(h.disposedModels, 1, 'the shared form model is disposed once');
  equal(h.state.styleTags.filter((tag) => tag.parentNode !== null).length, 0, 'unload removes the page stylesheet');
});

test('generated locale dictionaries include every page action and status message', () => {
  for (const locale of ['zh', 'en']) {
    for (const key of ['nav', 'title', 'summary', 'unavailable', 'readOnly', 'save', 'saving', 'saveFailed', 'overridden', 'reset', 'invalidNumber']) {
      const text = api.SETTINGS_I18N[locale]['page.' + key];
      assert(typeof text === 'string' && text.length > 0, locale + ' needs page.' + key);
    }
  }
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
  assert(/^0\.3\./.test(pkg.version), 'the configuration interface is a 0.3.x release, got ' + pkg.version);
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
