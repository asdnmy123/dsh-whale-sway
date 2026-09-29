/**
 * Offline tests for the dsh-whale-sway client half.
 *
 * `client.js` is a classic browser script that registers itself with
 * `window.__ModuleLoader__.load({ id, factory })`. This harness reproduces that
 * contract inside `node:vm` (so the loader handshake itself is under test),
 * then exercises the pure motion maths and the stylesheet builder, and finally
 * runs `apply()` against a stub DOM to prove the stylesheet is really inserted
 * and really removed again.
 *
 * Run: node tools/test-motion.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url));
const SOURCE = readFileSync(CLIENT_PATH, 'utf8');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok    ' + name);
  } catch (error) {
    failures.push({ name, error });
    console.log('  FAIL  ' + name + '\n        ' + (error && error.message));
  }
}

// ---------------------------------------------------------------------------
// load the client half exactly the way the browser module loader does
// ---------------------------------------------------------------------------

/** Stub DOM used by the `apply()` test. */
function createStubDocument() {
  const created = [];
  const head = {
    children: [],
    appendChild(node) {
      node.parentNode = head;
      head.children.push(node);
      return node;
    },
    removeChild(node) {
      head.children = head.children.filter((child) => child !== node);
      node.parentNode = null;
      return node;
    },
  };
  const documentElement = {
    style: {
      values: {},
      setProperty(name, value) {
        documentElement.style.values[name] = value;
      },
      removeProperty(name) {
        delete documentElement.style.values[name];
      },
    },
  };
  const doc = {
    head,
    body: { textContent: '' },
    documentElement,
    createElement() {
      const node = { dataset: {}, textContent: '', parentNode: null };
      created.push(node);
      return node;
    },
    querySelector() {
      return null;
    },
  };
  return { doc, created, head, documentElement };
}

function createSandbox(options) {
  const settings = options || {};
  const mediaQueries = settings.mediaQueries || {};
  const windowStub = {
    matchMedia(query) {
      return {
        matches: mediaQueries[query] === true,
        addEventListener() {},
        removeEventListener() {},
      };
    },
    setInterval() {
      return 1;
    },
    clearInterval() {},
    __ModuleLoader__: {
      load(definition) {
        windowStub.loaded = definition;
      },
    },
    loaded: null,
  };
  const sandbox = {
    window: windowStub,
    console,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  if (settings.document) sandbox.document = settings.document;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' });
  return { sandbox, windowStub };
}

/** Load the module and return its exports, via the real loader handshake. */
function loadModule(options) {
  const { sandbox, windowStub } = createSandbox(options);
  assert.ok(windowStub.loaded !== null, 'client.js must call window.__ModuleLoader__.load');
  assert.equal(windowStub.loaded.id, 'dsh-whale-sway', 'the loader id must be the package name');
  assert.equal(typeof windowStub.loaded.factory, 'function', 'the definition must expose a factory');
  const exports = windowStub.loaded.factory();
  assert.ok(Array.isArray(exports.inject), 'the module must export an inject array');
  assert.equal(typeof exports.apply, 'function', 'the module must export apply()');
  return { exports, sandbox, windowStub };
}

// ---------------------------------------------------------------------------

console.log('dsh-whale-sway client half — offline motion tests');

const { exports: api, sandbox } = loadModule();

test('loader handshake + module face', () => {
  assert.equal(api.inject.length, 0);
  assert.equal(typeof api.apply, 'function');
  assert.equal(typeof api.buildCss, 'function');
  assert.equal(typeof api.createRateMeter, 'function');
  assert.ok(api.TUNING.charsPerToken > 0);
});

test('period shortens as the token rate rises, and clamps at both ends', () => {
  const t = api.TUNING;
  assert.equal(api.periodForRate(0), t.maxPeriodMs, 'idle must use the slowest cycle');
  assert.equal(api.periodForRate(t.rateRef), t.maxPeriodMs / 2, 'rateRef must halve the cycle');
  assert.equal(api.periodForRate(1e9), t.minPeriodMs, 'an absurd rate must clamp to the floor');
  assert.equal(api.periodForRate(-50), t.maxPeriodMs, 'a negative rate must clamp to idle');

  const rates = [0, 2, 5, 10, 20, 40];
  let previous = Infinity;
  for (const rate of rates) {
    const period = api.periodForRate(rate);
    assert.ok(period < previous, `period must fall at ${rate} tok/s (got ${period})`);
    previous = period;
  }
});

test('amplitude widens with the rate and saturates', () => {
  const t = api.TUNING;
  assert.equal(api.amplitudeForRate(0), t.amplitudeDeg);
  assert.equal(api.amplitudeForRate(t.ampFullRate), t.amplitudeDeg + t.amplitudeGainDeg);
  assert.equal(api.amplitudeForRate(1e6), t.amplitudeDeg + t.amplitudeGainDeg, 'gain must saturate');
  assert.ok(api.amplitudeForRate(0) > 5, 'the shipped APNG moves only a few degrees; ours must be wider');
  assert.ok(api.amplitudeForRate(20) > api.amplitudeForRate(0), 'a busy model must swing wider');
});

test('bob stays inside a sub-pixel budget', () => {
  assert.ok(api.liftForRate(0) > 0);
  assert.ok(api.liftForRate(1e6) <= api.TUNING.liftPx);
});

test('rate meter converges on a steady stream', () => {
  const meter = api.createRateMeter();
  const tuning = api.TUNING;
  const step = 200;
  const grew = 20; // characters per sample
  meter.sample(0, 0); // prime
  let length = 0;
  for (let i = 1; i <= 14; i += 1) {
    length += grew;
    meter.sample(length, i * step);
  }
  const expected = grew / (step / 1000) / tuning.charsPerToken; // 58.8 tok/s
  assert.ok(
    Math.abs(meter.rate - expected) < 1.5,
    `expected ~${expected.toFixed(1)} tok/s, measured ${meter.rate.toFixed(1)}`,
  );
});

test('rate meter decays to idle when the stream stalls', () => {
  const meter = api.createRateMeter();
  meter.sample(0, 0);
  let length = 0;
  for (let i = 1; i <= 14; i += 1) {
    length += 20;
    meter.sample(length, i * 200);
  }
  const busy = meter.rate;
  for (let i = 15; i <= 22; i += 1) meter.sample(length, i * 200);
  assert.ok(meter.rate < busy * 0.1, `a stalled stream must fall back to idle (got ${meter.rate})`);
  assert.ok(api.periodForRate(meter.rate) > 1000, 'idle must swing slowly');
});

test('rate meter never reports a negative rate when the text shrinks', () => {
  const meter = api.createRateMeter();
  meter.sample(5000, 0);
  assert.equal(meter.sample(10, 200), 0, 'compaction must read as zero output, not negative');
  assert.equal(meter.rate, 0);
});

test('rate meter clamps a bulk re-render', () => {
  const meter = api.createRateMeter();
  meter.sample(0, 0);
  let length = 0;
  for (let i = 1; i <= 20; i += 1) {
    length += 4000; // one giant repaint, not a token stream
    meter.sample(length, i * 200);
  }
  assert.ok(meter.rate <= api.TUNING.maxRate, 'the ceiling must hold');
});

test('the mask carries the shipped geometry', () => {
  const mask = api.buildMask();
  assert.ok(mask.startsWith('url("data:image/svg+xml;charset=utf-8,'), 'mask must be an inline SVG url');
  const svg = decodeURIComponent(mask.slice('url("data:image/svg+xml;charset=utf-8,'.length, -2));
  assert.ok(svg.includes('viewBox="0 0 16 16"'), 'the mask must keep the 16x16 viewBox');
  assert.ok(svg.includes(api.REST_PATH), 'the mask must reuse the shipped path verbatim');
  assert.ok(svg.includes('stroke-width="1"'), 'the stroke width must match the shipped still SVG');
  assert.ok(!svg.includes('undefined'), 'no undefined may leak into the SVG');
});

test('the stylesheet hides the shipped motion and is gated', () => {
  const css = api.buildCss(api.buildMask());
  assert.ok(css.includes(api.ICON_SELECTOR), 'must target the running icon box');
  assert.ok(css.includes('contain:none!important'), 'paint containment would clip a wider swing');
  assert.ok(css.includes('overflow:visible!important'), 'a wider swing needs room');
  assert.ok(css.includes('@media (prefers-reduced-motion:no-preference)'), 'reduced motion must be honoured');
  assert.ok(css.includes('@supports (mask-mode:alpha) and (mask-image:url(""))'), 'a maskless browser must keep the shipped art');
  assert.ok(css.includes('display:none!important'), 'the shipped APNG mask and still SVG must be hidden');
  assert.ok(css.includes('rotate(var(--dsh-whale-angle,0deg))'), 'the loop drives rotation through the custom property');
  assert.ok(css.includes('transform-origin:' + api.TUNING.pivot), 'the pivot must be the tail stock root');
  assert.ok(!css.includes('undefined') && !css.includes('NaN'), 'no undefined/NaN may leak into the CSS');

  let depth = 0;
  for (const character of css) {
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    assert.ok(depth >= 0, 'braces must stay balanced');
  }
  assert.equal(depth, 0, 'braces must balance');
});

test('apply() inserts one tagged stylesheet through ctx.effect and cleans it up', () => {
  const stub = createStubDocument();
  const loaded = loadModule({ document: stub.doc });
  const disposers = [];
  loaded.exports.apply({
    effect(callback, label) {
      assert.equal(typeof callback, 'function');
      assert.equal(typeof label, 'string');
      disposers.push(callback());
    },
  });

  assert.equal(stub.created.length, 1, 'exactly one style tag must be inserted');
  const tag = stub.created[0];
  assert.equal(tag.dataset.plugin, 'dsh-whale-sway');
  assert.equal(tag.dataset.pluginCss, loaded.exports.CSS_TAG);
  assert.ok(tag.textContent.includes(loaded.exports.ICON_SELECTOR));
  assert.equal(stub.head.children.length, 1);

  assert.equal(disposers.length, 1);
  disposers[0]();
  assert.equal(stub.head.children.length, 0, 'the disposer must remove the stylesheet');
  assert.ok(!('--dsh-whale-angle' in stub.documentElement.style.values), 'the disposer must clear the angle');
  assert.ok(!('--dsh-whale-lift' in stub.documentElement.style.values), 'the disposer must clear the bob');
});

test('apply() survives a reduced-motion shell and still cleans up', () => {
  const stub = createStubDocument();
  const loaded = loadModule({
    document: stub.doc,
    mediaQueries: { '(prefers-reduced-motion: reduce)': true },
  });
  const disposers = [];
  loaded.exports.apply({ effect: (callback) => disposers.push(callback()) });
  assert.equal(stub.created.length, 1, 'the stylesheet self-gates on the media query');
  assert.equal(stub.documentElement.style.values['--dsh-whale-angle'], undefined, 'no motion while reduced');
  disposers[0]();
  assert.equal(stub.head.children.length, 0);
});

test('apply() without a ctx still works (defensive path)', () => {
  const stub = createStubDocument();
  const loaded = loadModule({ document: stub.doc });
  loaded.exports.apply(undefined);
  assert.equal(stub.created.length, 1);
});

// ---------------------------------------------------------------------------
// host half
// ---------------------------------------------------------------------------

{
  const host = await import('../index.js');
  test('host half exports the package name and a no-op plugin face', () => {
    assert.equal(host.name, 'dsh-whale-sway', 'the Host plugin name must match the package');
    assert.ok(Array.isArray(host.inject), 'the Host half must export an inject array');
    assert.equal(typeof host.apply, 'function', 'the Host half must export apply()');
  });
}

// ---------------------------------------------------------------------------

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} failing, ${passed} passing`);
  process.exitCode = 1;
} else {
  console.log(`all ${passed} tests passing`);
}
