/**
 * Real-engine screenshots for the README.
 *
 * These images are not drawn by this file. It builds a page whose *only* motion
 * source is the shipped `client.js`, booted exactly the way a DSH web client
 * boots it — through `window.__ModuleLoader__.load({ id, factory })` — then:
 *
 *   1. replaces `requestAnimationFrame`, `setInterval` and `performance.now`
 *      with a clock this file pumps by hand, so a screenshot is a definite
 *      virtual instant and not a race;
 *   2. grows a transcript element inside `[data-conversation-scroll]` at a
 *      controlled character rate, which is the only rate input the engine has;
 *   3. pumps to the frame the sheet itself says is the widest swing, stops, and
 *      screenshots the viewport.
 *
 * Nothing here synthesises a pose: the harness never writes a transform and
 * never touches a rotation property. The only motion state it observes is the
 * engine's integer `--dsh-whale-frame` custom property, and the evidence it
 * prints (frame index, rate, cycle, mask, geometry) is read back out of the
 * live page through `--dump-dom`, from the same run parameters that produced
 * the PNG.
 *
 * Headless Chromium/Edge is driven through its own command line, with no
 * dependencies and no CDP client:
 *
 *   <browser> --headless=new --screenshot=out.png --window-size=W,H \
 *             --force-device-scale-factor=2 file:///.../shot-fast.html
 *
 * Usage:
 *   node tools/engine-shot.mjs                 # both README screenshots
 *   node tools/engine-shot.mjs --keep          # keep the generated page for inspection
 *   node tools/engine-shot.mjs --browser PATH  # force a browser binary
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CLIENT_PATH,
  META_PATH,
  ROOT,
  decodePng,
  loadClientEngine,
  loadSheetCells,
  readFramesMeta,
  sheetMotion,
} from './make-gif.mjs';

/** Viewport of every screenshot: the whole image is the running indicator. */
export const VIEW = { width: 440, height: 320 };
/** Device scale factor: a 14px icon is rendered 10x, then this doubles again. */
export const DSF = 2;
/** The magnifier in the page. */
export const ZOOM = 10;
/** Virtual milliseconds of transcript growth before the freeze is allowed. */
const CONVERGE_MS = 5000;
/** Clock step: 120 Hz, small enough that no frame index is stepped over. */
const STEP_MS = 1000 / 120;
/** Give up (and report a failure) after this much virtual time. */
const MAX_VIRTUAL_MS = 30000;

/** The two README shots: the runtime's own rates. */
export const SHOTS = [
  { label: 'fast', rate: 47, out: 'preview/engine-fast.png' },
  { label: 'slow', rate: 7, out: 'preview/engine-slow.png' },
];

function strArg(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1 || argv[index + 1] === undefined) return fallback;
  return argv[index + 1];
}

/**
 * Find a headless Chromium. Edge first (this checkout's scratch is `.edge-tmp`),
 * then Chrome, then `--browser`.
 */
export function resolveBrowser(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_SHOT_BROWSER,
    process.env['ProgramFiles(x86)'] === undefined
      ? null
      : join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles === undefined
      ? null
      : join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA === undefined
      ? null
      : join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.ProgramFiles === undefined
      ? null
      : join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'no headless Chromium found; set DSH_SHOT_BROWSER or pass --browser <path to msedge.exe/chrome.exe>',
  );
}

/** Run a browser and return its stdout, tolerating a non-zero exit code. */
function runBrowser(browser, args) {
  const result = spawnSync(browser, args, {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    status: result.status,
    error: result.error === undefined ? null : result.error,
  };
}

/**
 * The harness page.
 *
 * The DOM above the scripts is what the engine queries: a running row inside the
 * scroll container, a 14px icon box with the shipped `_runningIcon` class inside
 * it, the shipped APNG stub and the shipped still SVG as the children the
 * override must hide, and a slot outline at exactly the shipped 14px, so the
 * extra pixel per side the sheet needs is visible in the still.
 *
 * The film strip under the magnifier is the same engine CSS applied to the same
 * icon box, once per cell, with the frame property pinned per cell: it is the
 * sheet's travel, rendered by the real stylesheet.
 *
 * @param {object} config - everything the page needs, all measured in Node.
 * @returns {string} the page source.
 */
export function buildPage(config) {
  const film = [];
  for (let index = 0; index < config.count; index += 1) {
    film.push(
      '<span class="filmCell"><span class="filmScale"><span class="iconCell">' +
        '<span class="h_runningIcon" style="--dsh-whale-frame:' +
        index +
        '"><span class="h_runningWhaleAnimated"></span></span>' +
        '</span></span></span>',
    );
  }
  const filmCells = film.join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>dsh-whale-sway engine shot</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #f6f7fa; }
  body { font: 11px/15px ui-monospace, Consolas, "Courier New", monospace; color: #333; }
  #stage { padding: 14px; }
  .conversation { color: #4d6bfe; }
  #stream { display: none; }
  /* the shipped icon box: 14px, containment strict, overflow hidden */
  .h_runningIcon { width: 14px; height: 14px; contain: strict; display: block; position: relative; overflow: hidden; }
  /* the shipped APNG layer and the shipped still fallback, as the override must find them */
  .h_runningWhaleAnimated { display: block; position: absolute; inset: 0; background: currentColor; opacity: .3; }
  .h_runningWhaleStill { display: initial; width: 100%; height: 100%; }
  .iconCell { position: relative; display: block; width: 14px; height: 14px; }
  #magBox { position: relative; width: ${ZOOM * 16}px; height: ${ZOOM * 16}px; margin: 0 auto; }
  /* The shipped 14px slot boundary, drawn OUTSIDE the magnifier so the line stays
     one pixel wide: the sheet's cell is 16px, so at peak swing the fluke is meant
     to cross this line. */
  #slotMark { position: absolute; left: ${ZOOM}px; top: ${ZOOM}px; width: ${ZOOM * 14}px; height: ${ZOOM * 14}px; outline: 1px dashed rgba(192, 57, 43, .75); }
  /* the same running-indicator colour for the film strip's cells */
  .filmWrap { color: #4d6bfe; }
  #mag { position: absolute; left: ${ZOOM}px; top: ${ZOOM}px; transform: scale(${ZOOM}); transform-origin: 0 0; }
  #caption { margin: 8px 0 0; white-space: pre; overflow: hidden; }
  #filmLabel { margin: 10px 0 6px; color: #666; }
  #film { display: grid; grid-template-columns: repeat(${config.filmCols}, 28px); gap: 6px; }
  .filmCell { width: 28px; height: 28px; position: relative; }
  .filmScale { position: absolute; left: 0; top: 0; transform: scale(2); transform-origin: 0 0; }
</style>
</head>
<body>
<div id="stage">
  <div class="conversation" data-conversation-scroll>
    <div id="stream"></div>
    <div id="magBox">
      <div id="mag">
        <div class="row" data-chat-running>
          <span class="iconCell">
            <span class="h_runningIcon">
              <span class="h_runningWhaleAnimated"></span>
              <svg class="h_runningWhaleStill" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="" stroke="currentColor" stroke-width="1"></path></svg>
            </span>
          </span>
        </div>
      </div>
      <span id="slotMark"></span>
    </div>
    <p id="caption"><span id="cap1">booting…</span>
<span id="cap2"></span></p>
  </div>
  <div id="filmLabel">one full cycle &middot; the same ${config.count} frames, stepped by the engine's own mask-position</div>
  <div class="filmWrap" data-chat-running><div id="film">${filmCells}</div></div>
</div>
<pre id="report" hidden></pre>

<script>
  window.__shotLoaderCalls = [];
  window.__ModuleLoader__ = {
    load: function (definition) {
      window.__shotLoaderCalls.push({ id: definition.id, factory: typeof definition.factory });
      window.__shotModule = definition.factory();
    }
  };
</script>
<script src="client.js"></script>
<script>
(function () {
  'use strict';
  var cfg = ${JSON.stringify(config)};
  var report = { ok: false, reason: 'the harness did not finish' };

  // --- a clock this script owns completely -------------------------------
  var clock = 0;
  var ticks = 0;
  var samples = 0;
  var rafQueue = [];
  var rafSeq = 0;
  var intervalSeq = 0;
  var intervals = [];

  window.requestAnimationFrame = function (callback) { rafQueue.push(callback); rafSeq += 1; return rafSeq; };
  window.cancelAnimationFrame = function () {};
  window.setInterval = function (callback, every) {
    intervalSeq += 1;
    intervals.push({ id: intervalSeq, callback: callback, every: every, next: clock + every });
    return intervalSeq;
  };
  window.clearInterval = function (id) {
    var kept = [];
    for (var i = 0; i < intervals.length; i += 1) if (intervals[i].id !== id) kept.push(intervals[i]);
    intervals = kept;
  };
  performance.now = function () { return clock; };
  window.matchMedia = function (query) {
    return { matches: false, media: query, addEventListener: function () {}, removeEventListener: function () {} };
  };

  var api = window.__dshIconApi;
  var box = document.querySelector('[data-chat-running] [class*="_runningIcon"]');
  var stream = document.getElementById('stream');

  function readFrame() {
    return document.documentElement.style.getPropertyValue('--dsh-whale-frame').trim();
  }

  function finish() {
    document.getElementById('report').textContent =
      'REPORT_JSON_BEGIN' + JSON.stringify(report) + 'REPORT_JSON_END';
  }

  if (api === undefined || api === null || typeof api.apply !== 'function') {
    report = { ok: false, reason: 'client.js did not expose a usable module' };
    finish();
    return;
  }
  if (window.__shotLoaderCalls.length !== 1 || window.__shotModule === undefined) {
    report = { ok: false, reason: 'the loader handshake did not deliver exactly one module' };
    finish();
    return;
  }

  // The shipped still fallback is the engine's own path data, so the page never
  // hard-codes a shape.
  var paths = document.querySelectorAll('.h_runningWhaleStill path');
  for (var p = 0; p < paths.length; p += 1) paths[p].setAttribute('d', api.REST_PATH);

  var effectRan = 0;
  try {
    window.__shotModule.apply({
      effect: function (callback) { effectRan += 1; return callback(); }
    });
  } catch (error) {
    report = { ok: false, reason: 'apply() threw: ' + error.message };
    finish();
    return;
  }

  var styleTag = document.querySelector('style[data-plugin-css]');
  var cssText = styleTag === null ? '' : styleTag.textContent;
  var charsPerToken = api.TUNING.charsPerToken;
  var charsPerSecond = cfg.rate * charsPerToken;

  function grow() {
    // Round-to-nearest rather than floor: the engine measures *differences* of
    // this length, so a systematic down-bias would read as a slower token rate.
    stream.textContent = new Array(Math.round(charsPerSecond * clock / 1000) + 1).join('x');
  }

  var reached = false;
  var guard = 0;
  while (clock < cfg.maxVirtualMs && guard < 4000000) {
    guard += 1;
    clock += cfg.stepMs;
    grow();
    for (var i = 0; i < intervals.length; i += 1) {
      var item = intervals[i];
      while (clock >= item.next - 1e-9) {
        item.next += item.every;
        item.callback(clock);
        samples += 1;
      }
    }
    var batch = rafQueue;
    rafQueue = [];
    for (var j = 0; j < batch.length; j += 1) {
      batch[j](clock);
      ticks += 1;
    }
    if (clock >= cfg.convergeMs && readFrame() === String(cfg.peakFrame)) {
      reached = true;
      break;
    }
  }

  var frameRaw = readFrame();
  var seconds = clock / 1000;
  var rateMeasured = seconds > 0 ? stream.textContent.length / seconds / charsPerToken : 0;
  var periodMs = api.periodForRate(rateMeasured, api.TUNING);
  var after = getComputedStyle(box, '::after');
  var maskImage = String(after.maskImage || after.webkitMaskImage || '');
  var animated = box.querySelector('[class*="_runningWhaleAnimated"]');
  var still = box.querySelector('[class*="_runningWhaleStill"]');
  var rect = box.getBoundingClientRect();

  report = {
    ok: reached && /^[0-9]+$/.test(frameRaw),
    reason: reached ? '' : 'the engine never displayed frame ' + cfg.peakFrame,
    label: cfg.label,
    rateTarget: cfg.rate,
    rateMeasured: rateMeasured,
    periodMs: periodMs,
    frame: frameRaw === '' ? null : Number(frameRaw),
    frameRaw: frameRaw,
    peakFrame: cfg.peakFrame,
    count: api.FRAME_COUNT,
    virtualMs: clock,
    ticks: ticks,
    samples: samples,
    loaderId: window.__shotLoaderCalls[0].id,
    effectRan: effectRan,
    hasSheet: api.hasSheet(),
    styleInjected: styleTag !== null,
    styleTagName: styleTag === null ? '' : styleTag.getAttribute('data-plugin-css'),
    cssLength: cssText.length,
    cssHasTransform: /transform/i.test(cssText),
    cssHasAnimation: /(^|[^-])animation\\s*:/i.test(cssText),
    maskImagePrefix: maskImage.slice(0, 40),
    maskImageLength: maskImage.length,
    maskSize: String(after.maskSize || after.webkitMaskSize || ''),
    maskPosition: String(after.maskPosition || after.webkitMaskPosition || ''),
    afterContent: String(after.content || ''),
    afterTransform: String(after.transform || ''),
    childrenDisplay: animated === null ? 'missing' : getComputedStyle(animated).display,
    stillDisplay: still === null ? 'missing' : getComputedStyle(still).display,
    boxRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    ua: navigator.userAgent
  };

  document.getElementById('cap1').textContent =
    cfg.label + '  ' + rateMeasured.toFixed(1) + ' tok/s   cycle ' + periodMs.toFixed(0) +
    ' ms   frame ' + frameRaw + ' / ' + api.FRAME_COUNT + '   frozen at peak swing';
  document.getElementById('cap2').textContent =
    'client.js ' + cfg.clientSha.slice(0, 12) + '\\u2026   sheet ' + cfg.sheetSha.slice(0, 12) +
    '\\u2026   (' + cfg.count + '\\u00d7' + cfg.cell + 'px mask)';
  finish();
})();
</script>
</body>
</html>
`;
}

/** Pull the JSON report back out of a dumped DOM. */
export function parseReport(dom) {
  const match = /REPORT_JSON_BEGIN([\s\S]*?)REPORT_JSON_END/.exec(dom);
  if (match === null) throw new Error('the page never wrote a report');
  const text = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return JSON.parse(text);
}

/**
 * Measure the screenshot: it must be a real PNG of the expected geometry, and it
 * must contain the masked ink — sparse bluish pixels inside the icon box, not a
 * solid square (which is what an unmasked `::after` would paint).
 */
export function measureShot(pngBytes, report, dsf) {
  const png = decodePng(pngBytes);
  // `boxRect` is the icon box *as magnified* (getBoundingClientRect is
  // post-transform), so the pseudo-element's one-pixel inset is `ZOOM` CSS px
  // wide here. Measuring the whole 16x16 cell keeps the fluke's travel inside
  // the sample.
  const pad = ZOOM;
  const x0 = Math.max(0, Math.round((report.boxRect.x - pad) * dsf));
  const y0 = Math.max(0, Math.round((report.boxRect.y - pad) * dsf));
  const x1 = Math.min(png.width, Math.round((report.boxRect.x + report.boxRect.width + pad) * dsf));
  const y1 = Math.min(png.height, Math.round((report.boxRect.y + report.boxRect.height + pad) * dsf));
  let bluish = 0;
  let used = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = (y * png.width + x) * 4;
      used += 1;
      const r = png.rgba[p];
      const b = png.rgba[p + 2];
      const a = png.rgba[p + 3];
      if (a === 255 && r < 200 && b > 180 && b - r > 60) bluish += 1;
    }
  }
  return {
    width: png.width,
    height: png.height,
    boxPixels: used,
    boxInkPixels: bluish,
    boxInkShare: used === 0 ? 0 : bluish / used,
    colorType: png.colorType,
    bitDepth: png.bitDepth,
  };
}

/**
 * Assert everything the README claim rests on.
 *
 * `expectedMaskLength` and `expectedPeriodMs` are computed in Node from the
 * delivered artifacts — the sheet's own base64 and the real `periodForRate` —
 * so the browser's numbers are checked against an independent evaluation, not
 * against themselves.
 *
 * @returns {Array<{name:string,ok:boolean,detail:string}>} one row per check.
 */
export function verifyShot({
  report,
  measured,
  expectedWidth,
  expectedHeight,
  expectedMaskLength,
  expectedPeriodMs,
}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add('page reported ok', report.ok === true, report.reason === '' ? 'ok' : report.reason);
  add(
    'frozen on the sheet\'s peak-swing frame',
    report.frame === report.peakFrame,
    `frame ${report.frame} (peak ${report.peakFrame} of ${report.count})`,
  );
  add(
    'the engine measured the requested rate',
    Math.abs(report.rateMeasured - report.rateTarget) / report.rateTarget < 0.02,
    `${report.rateMeasured.toFixed(2)} vs ${report.rateTarget} tok/s`,
  );
  add(
    'cycle is the real periodForRate for that rate',
    // The harness's rate is an average over whole characters, so it can sit a
    // fraction of a character off the target; the cycle is compared with the
    // same 2% tolerance the rate itself gets.
    Math.abs(report.periodMs - expectedPeriodMs) < Math.max(1, expectedPeriodMs * 0.02),
    `browser ${report.periodMs.toFixed(2)} ms vs Node ${expectedPeriodMs.toFixed(2)} ms`,
  );
  add('booted through __ModuleLoader__.load', report.loaderId === 'dsh-whale-sway', report.loaderId);
  add('ctx.effect ran exactly once', report.effectRan === 1, String(report.effectRan));
  add('the sheet is spliced into client.js', report.hasSheet === true, String(report.hasSheet));
  add('the override stylesheet was injected', report.styleInjected === true, `${report.cssLength} chars`);
  add('no transform in the emitted CSS', report.cssHasTransform === false, report.cssHasTransform ? 'FOUND' : 'none');
  add('no CSS animation in the emitted CSS', report.cssHasAnimation === false, report.cssHasAnimation ? 'FOUND' : 'none');
  add(
    'the mask is exactly the sheet bytes',
    report.maskImagePrefix.indexOf('url("data:image/png;base64,') === 0 &&
      report.maskImageLength === expectedMaskLength,
    `${report.maskImageLength} chars vs ${expectedMaskLength} expected`,
  );
  add(
    'the strip is sized for every cell',
    report.maskSize.indexOf(String(report.count * 100) + '%') !== -1,
    report.maskSize,
  );
  add(
    'the shipped children are hidden',
    report.childrenDisplay === 'none' && report.stillDisplay === 'none',
    `animated=${report.childrenDisplay} still=${report.stillDisplay}`,
  );
  add('the frame property is an integer', /^[0-9]+$/.test(report.frameRaw), report.frameRaw);
  add('the pseudo-element writes no transform', report.afterTransform === 'none', report.afterTransform);
  add(
    'the pseudo-element is the mask host',
    report.afterContent === '""',
    JSON.stringify(report.afterContent),
  );
  add(
    'the screenshot is a real PNG of the harness viewport',
    measured.width === expectedWidth && measured.height === expectedHeight,
    `${measured.width}x${measured.height} (colorType ${measured.colorType}, bitDepth ${measured.bitDepth})`,
  );
  add(
    'the real engine painted masked ink inside the 14px box',
    measured.boxInkPixels > 20 && measured.boxInkShare < 0.75,
    `${measured.boxInkPixels}/${measured.boxPixels} pixels (${(measured.boxInkShare * 100).toFixed(1)}% — a solid square would be ~100%)`,
  );
  return checks;
}

export async function main(argv = process.argv.slice(2)) {
  const keep = argv.includes('--keep');
  const browser = resolveBrowser(strArg(argv, 'browser', null));
  console.log(`browser ${browser}`);

  const clientBytes = readFileSync(CLIENT_PATH);
  const clientSha = createHash('sha256').update(clientBytes).digest('hex');
  const loaded = readFramesMeta(resolve(strArg(argv, 'meta', META_PATH)));
  const png = decodePng(loaded.bytes);
  const sheet = loadSheetCells(png, loaded.meta.cell, loaded.meta.count);
  const motion = sheetMotion(sheet);
  console.log(`client.js sha256 ${clientSha}`);
  console.log(
    `sheet ${png.width}x${png.height} ${loaded.meta.count} cells of ${loaded.meta.cell}px, ` +
      `peak-swing frame ${motion.peakIndex} (${motion.peakTravelDisplayPx.toFixed(3)} display px from frame 0)`,
  );

  // The expected mask length and the expected cycle come from the delivered
  // artifacts, evaluated here in Node: the sheet's own base64, and the REAL
  // `periodForRate` imported from client.js. The browser's numbers are therefore
  // checked against an independent evaluation of the same inputs.
  const engine = await loadClientEngine();
  const maskBase64 =
    typeof loaded.meta.pngBase64 === 'string' && loaded.meta.pngBase64.length > 0
      ? loaded.meta.pngBase64
      : loaded.bytes.toString('base64');
  const expectedMaskLength = `url("data:image/png;base64,${maskBase64}")`.length;

  const workDir = join(tmpdir(), `dsh-icon-shot-${process.pid}`);
  mkdirSync(workDir, { recursive: true });
  // The page loads the REAL client.js as a sibling file: no copy is edited, no
  // source is re-typed, and the browser reads exactly the bytes hashed above.
  copyFileSync(CLIENT_PATH, join(workDir, 'client.js'));

  const results = [];
  for (const shot of SHOTS) {
    const config = {
      label: shot.label,
      rate: shot.rate,
      count: loaded.meta.count,
      cell: loaded.meta.cell,
      peakFrame: motion.peakIndex,
      filmCols: 12,
      stepMs: STEP_MS,
      convergeMs: CONVERGE_MS,
      maxVirtualMs: MAX_VIRTUAL_MS,
      clientSha,
      sheetSha: loaded.sha,
    };
    const pagePath = join(workDir, `shot-${shot.label}.html`);
    writeFileSync(pagePath, buildPage(config));
    const url = pathToFileURL(pagePath).href;
    const profile = join(workDir, `profile-${shot.label}`);
    const common = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--allow-file-access-from-files',
      `--user-data-dir=${profile}`,
      `--window-size=${VIEW.width},${VIEW.height}`,
    ];

    // Run 1: the screenshot.
    const outPath = resolve(ROOT, shot.out);
    mkdirSync(resolve(ROOT, 'preview'), { recursive: true });
    const shotRun = runBrowser(browser, [...common, `--force-device-scale-factor=${DSF}`, `--screenshot=${outPath}`, url]);
    if (!existsSync(outPath)) {
      throw new Error(
        `no screenshot at ${outPath} (exit ${shotRun.status})${shotRun.error === null ? '' : `: ${shotRun.error.message}`}`,
      );
    }

    // Run 2: the same deterministic page, dumped, so the measured state can be
    // asserted in Node instead of being taken on faith.
    const domRun = runBrowser(browser, [...common, `--dump-dom`, url]);
    const report = parseReport(domRun.stdout);
    const pngBytes = readFileSync(outPath);
    const measured = measureShot(pngBytes, report, DSF);
    const checks = verifyShot({
      report,
      measured,
      expectedWidth: VIEW.width * DSF,
      expectedHeight: VIEW.height * DSF,
      expectedMaskLength,
      expectedPeriodMs: engine.periodForRate(shot.rate, engine.TUNING),
    });

    const failures = checks.filter((check) => !check.ok);
    console.log(`\n${shot.label}: ${shot.rate} tok/s -> ${shot.out}`);
    for (const check of checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
    console.log(
      `  frozen at frame ${report.frame}/${report.count}, ${report.ticks} pumped frames, ` +
        `${report.virtualMs.toFixed(0)} virtual ms, ${report.samples} rate samples`,
    );
    console.log(`  screenshot ${outPath} (${(pngBytes.length / 1024).toFixed(1)} KiB) sha256 ${createHash('sha256').update(pngBytes).digest('hex').slice(0, 16)}…`);
    if (failures.length > 0) {
      throw new Error(`${shot.out}: ${failures.length} check(s) failed: ${failures.map((f) => f.name).join(', ')}`);
    }
    results.push({ shot, report, measured, checks, sha: createHash('sha256').update(pngBytes).digest('hex') });
  }

  // The two shots are the same frame of the same sheet at two rates: the pixels
  // inside the icon box must be identical, and only the caption may differ. If
  // they were not, one of the runs would not be showing the sheet.
  const [fast, slow] = results;
  if (fast.measured.boxInkPixels !== slow.measured.boxInkPixels) {
    throw new Error(
      `the two shots render different ink (${fast.measured.boxInkPixels} vs ${slow.measured.boxInkPixels} pixels)`,
    );
  }
  console.log(
    `\nboth shots are frozen on frame ${fast.report.frame} of ${fast.report.count}: ` +
      `${fast.report.periodMs.toFixed(0)} ms/cycle at ${fast.report.rateMeasured.toFixed(1)} tok/s vs ` +
      `${slow.report.periodMs.toFixed(0)} ms/cycle at ${slow.report.rateMeasured.toFixed(1)} tok/s`,
  );
  console.log(
    `engine-${fast.shot.label}.png sha256 ${fast.sha.slice(0, 16)}…  |  ` +
      `engine-${slow.shot.label}.png sha256 ${slow.sha.slice(0, 16)}…`,
  );

  if (!keep) {
    rmSync(workDir, { recursive: true, force: true });
  } else {
    console.log(`kept the generated page: ${join(workDir, 'shot-fast.html')}`);
  }
  return { results, clientSha, sheetSha: loaded.sha };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`engine-shot: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

// Kept for the entry-point guard above; unused elsewhere.
void fileURLToPath;
