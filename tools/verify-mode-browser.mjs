/** Verify saved styles against the real CSS cascade in headless Edge/Chrome.
 * Usage: node tools/verify-mode-browser.mjs [--browser PATH] [--client PATH]
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveBrowser } from './engine-shot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = (name) => {
  const at = process.argv.indexOf('--' + name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const scratch = resolve(root, '.edge-tmp', 'mode-browser');
mkdirSync(scratch, { recursive: true });
const client = readFileSync(resolve(root, option('client') || 'client.js'), 'utf8');
const page = `<!doctype html><meta charset="utf-8">
<div data-conversation-scroll><div data-chat-running><span class="test_runningIcon"
style="display:block;width:14px;height:14px"><svg></svg></span></div></div>
<pre id="result"></pre>
<script>
window.requestAnimationFrame = callback => { window.nextFrame = callback; return 1; };
window.cancelAnimationFrame = () => { window.nextFrame = null; };
window.setInterval = () => 1;
window.clearInterval = () => {};
</script>
<script>${client.replace(/<\/script/gi, '<\\/script')}</script>
<script>
try {
  const api = window.__dshIconApi;
  let value = { mode: 'sway-vivid' };
  const listeners = new Set();
  const scope = {
    getSnapshot: () => ({ status: 'ready', value }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
  api.setModuleRequire(id => id === 'react' ? { createElement() {} } : {
    SettingsFormModel: class { bind() { return {}; } dispose() {} }
  });
  api.apply({
    effect(fn) { fn(); },
    inject(deps, mount) {
      mount({ locale: { register() {} }, configForms: {
        get: () => scope, whileServed: () => () => {}
      } });
      return { dispose() {} };
    }
  });
  const row = document.querySelector('[data-chat-running]');
  let time = 100;
  const tick = () => { time += 100; if (window.nextFrame) window.nextFrame(time); };
  const update = next => { value = next; listeners.forEach(fn => fn()); tick(); };
  const checks = [];
  const check = (name, mode) => {
    const icon = row.querySelector('[class*="_runningIcon"]');
    const mask = getComputedStyle(icon, '::after');
    const own = getComputedStyle(icon);
    const details = {
      maskMatches: mask.maskImage.includes(api.panelForMode(mode).base64),
      webkitMatches: mask.webkitMaskImage.includes(api.panelForMode(mode).base64),
      frame: own.getPropertyValue(api.FRAME_VAR).trim(),
      position: mask.maskPosition,
      expectedPosition: '0px ' + own.getPropertyValue('--' + api.POS_VAR).trim(),
      rowIsClean: row.style.getPropertyValue('--' + api.SHEET_VAR) === ''
    };
    const position = details.position.split(' ');
    const offset = parseFloat(own.getPropertyValue('--' + api.POS_VAR));
    checks.push({ name, details, ok: details.maskMatches && details.webkitMatches &&
      details.frame !== '' && parseFloat(position[0]) === 0 && position[1].endsWith('%') &&
      Math.abs(parseFloat(position[1]) - offset) < 0.0001 && details.rowIsClean });
  };
  tick();
  check('saved vivid style on initial load', 'sway-vivid');
  for (const mode of ['sway-gentle', 'sway', 'sway-vivid']) {
    update({ mode });
    check('live switch to ' + mode, mode);
  }
  const old = row.firstElementChild;
  old.replaceWith(old.cloneNode(false));
  row.firstElementChild.removeAttribute('style');
  tick();
  check('child replacement keeps saved vivid style', 'sway-vivid');
  update({ enabled: false });
  checks.push({ name: 'disable removes mask', ok: getComputedStyle(row.firstElementChild, '::after').maskImage === 'none' });
  update({ enabled: true, mode: 'sway-gentle' });
  check('reenable applies gentle style', 'sway-gentle');
  document.getElementById('result').textContent = JSON.stringify({ checks });
} catch (error) {
  document.getElementById('result').textContent = JSON.stringify({ error: String(error) });
}
</script>`;
const path = resolve(scratch, 'modes.html');
writeFileSync(path, page);
const run = spawnSync(resolveBrowser(option('browser')), [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-gpu-sandbox',
  '--user-data-dir=' + mkdtempSync(resolve(scratch, 'profile-')), '--dump-dom', pathToFileURL(path).href,
], { encoding: 'utf8', timeout: 45000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
if (run.error) throw run.error;
assert.equal(run.status, 0, run.stderr);
const result = /<pre id="result">([^<]*)<\/pre>/.exec(run.stdout);
assert.ok(result, 'browser returned no test result');
const report = JSON.parse(result[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
assert.equal(report.error, undefined, report.error);
assert.equal(report.checks.length, 7, 'all browser checks ran');
for (const check of report.checks) {
  console.log((check.ok ? 'PASS ' : 'FAIL ') + check.name + (check.ok ? '' : ' ' + JSON.stringify(check.details)));
}
assert.ok(report.checks.every(check => check.ok), 'the rendered mask differs from the saved style');
console.log('BROWSER VERDICT: PASS (7/7)');
