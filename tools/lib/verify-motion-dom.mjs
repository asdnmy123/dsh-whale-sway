/**
 * Adversarial-verification harness for the dsh-whale-sway client half.
 *
 * Nothing here trusts the author's own test file. This module
 *
 *  - loads `client.js` in a `node:vm` context through the real
 *    `window.__ModuleLoader__.load({ id, factory })` handshake,
 *  - gives it a stub DOM in which EVERY style write (both
 *    `style.setProperty()` and direct property assignment) on EVERY element is
 *    recorded with the simulated timestamp,
 *  - hands it a controllable clock: `requestAnimationFrame`, `setInterval`,
 *    `cancelAnimationFrame`, `clearInterval` and `performance.now()` are all
 *    driven by the harness, so a test can pump arbitrary simulated time,
 *  - lets a test grow the transcript text at a controlled character rate.
 *
 * It is deliberately defensive: a missing method must produce a recorded
 * no-op or a `null`, never a crash that would hide a real failure.
 */

import vm from 'node:vm';

// ---------------------------------------------------------------------------
// source inspection helpers
// ---------------------------------------------------------------------------

/**
 * Remove comments AND string literals from JavaScript source.
 *
 * Used so that base64 blobs and prose comments cannot masquerade as code when
 * grepping for transform/geometry tokens.
 */
export function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += "''";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Mask the payload of every `data:...;base64,...` URL so a later token scan
 * cannot trip over random base64 characters.
 */
export function maskDataUrls(text) {
  return String(text).replace(
    /(data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,)([A-Za-z0-9+/=]+)/gi,
    (match, prefix) => prefix + '<BASE64>',
  );
}

/** Every long base64-ish string literal in the source, longest first. */
export function findBase64Literals(source) {
  const found = [];
  const re = /(['"])([A-Za-z0-9+/=\s]{200,})\1/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const clean = match[2].replace(/\s+/g, '');
    if (clean.length >= 200) found.push(clean);
  }
  found.sort((a, b) => b.length - a.length);
  return found;
}

/** Replace every declaration whose value is a huge base64 literal with ''. */
export function blankSheetLiterals(source) {
  return source.replace(
    /(\b[A-Za-z_$][\w$]*\s*=\s*)(['"])([A-Za-z0-9+/=\s]{200,})\2/g,
    (match, head, quote) => head + quote + quote,
  );
}

/**
 * Force the sheet empty the way an unspliced build would be: blank ONLY the
 * base64 value, so `FRAME_COUNT` (and every other spliced constant) survives.
 * That makes the fallback test strictly *harder* — the module has to key off the
 * base64 being empty, not off the frame count being zero.
 *
 * Prefers the generated marker block (robust even if the base64 were split over
 * several concatenated literals); falls back to blanking huge literals.
 */
export function forceEmptySheet(source) {
  const markers = /(\/\* dsh-whale-sway:sheet:begin \*\/)([\s\S]*?)(\/\* dsh-whale-sway:sheet:end \*\/)/;
  const match = markers.exec(source);
  if (match) {
    // Every strip in the payload, not just the default one: the build carries one
    // `"base64"` field per mode, and the fallback must survive all of them being
    // empty (a one-mode build is the same code path with a one-element array).
    const inner = match[2]
      // `"base64"` is a quoted JSON key, so a `\b` before the word never matches
      // (the preceding character is a quote, which is not a word character).
      // Match the quoted key the runtime actually emits.
      .replace(/("base64"\s*:\s*)(['"])[\s\S]*?\2/g, (whole, head, quote) => head + quote + quote)
      .replace(/(\bFRAME_SHEET_BASE64\s*=\s*)(['"])[\s\S]*?\2/, (whole, head, quote) => head + quote + quote);
    const block = match[1] + inner + match[3];
    return source.slice(0, match.index) + block + source.slice(match.index + match[0].length);
  }
  return blankSheetLiterals(source);
}

// ---------------------------------------------------------------------------
// stub DOM
// ---------------------------------------------------------------------------

const TRANSFORM_PROPERTY_RE =
  /transform|rotate|translate|scale|skew|perspective|matrix|writing-mode|offset-path|offset-rotate|^zoom$/i;

/**
 * A style object whose writes are all recorded, whether they arrive through
 * `setProperty`/`removeProperty` or as a direct property assignment.
 */
function makeStyle(records, clock, label) {
  const values = new Map();
  const api = {
    setProperty(name, value, priority) {
      const key = String(name);
      const text = value === undefined || value === null ? '' : String(value);
      values.set(key, text);
      records.push({
        t: clock.now,
        label,
        kind: 'setProperty',
        name: key,
        value: text,
        priority: priority === undefined ? '' : String(priority),
      });
      return undefined;
    },
    removeProperty(name) {
      const key = String(name);
      const previous = values.has(key) ? values.get(key) : '';
      values.delete(key);
      records.push({ t: clock.now, label, kind: 'removeProperty', name: key, value: previous });
      return previous;
    },
    getPropertyValue(name) {
      const key = String(name);
      return values.has(key) ? values.get(key) : '';
    },
    getPropertyPriority() {
      return '';
    },
    item() {
      return '';
    },
    get cssText() {
      return [...values.entries()].map(([k, v]) => `${k}:${v}`).join(';');
    },
    set cssText(text) {
      values.clear();
      records.push({ t: clock.now, label, kind: 'assign', name: 'cssText', value: String(text) });
    },
  };
  return new Proxy(api, {
    get(target, prop) {
      if (prop in target) {
        const value = target[prop];
        return typeof value === 'function' ? value : value;
      }
      if (typeof prop === 'string' && values.has(prop)) return values.get(prop);
      return undefined;
    },
    set(target, prop, value) {
      const key = String(prop);
      values.set(key, String(value));
      records.push({ t: clock.now, label, kind: 'assign', name: key, value: String(value) });
      return true;
    },
    has(target, prop) {
      return prop in target || values.has(String(prop));
    },
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(target), ...values.keys()])];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop in target) return Reflect.getOwnPropertyDescriptor(target, prop);
      if (values.has(String(prop))) {
        return { configurable: true, enumerable: true, value: values.get(String(prop)) };
      }
      return undefined;
    },
  });
}

function makeElement({ tagName = 'DIV', records, clock, label = 'div', cssText = '' } = {}) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    nodeType: 1,
    dataset: {},
    children: [],
    parentNode: null,
    parentElement: null,
    isConnected: true,
    textContent: '',
    className: '',
    id: '',
    style: makeStyle(records, clock, `${label}.style`),
  };
  if (cssText) element.style.cssText = cssText;
  element.classList = {
    add() {},
    remove() {},
    contains() {
      return false;
    },
    toggle() {
      return false;
    },
  };
  element.setAttribute = function (name, value) {
    element[name] = String(value);
  };
  element.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(element, name) ? String(element[name]) : null;
  };
  element.removeAttribute = function (name) {
    delete element[name];
  };
  element.hasAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(element, name);
  };
  element.appendChild = function (child) {
    child.parentNode = element;
    child.parentElement = element;
    child.isConnected = true;
    element.children.push(child);
    return child;
  };
  element.insertBefore = function (child) {
    return element.appendChild(child);
  };
  element.removeChild = function (child) {
    element.children = element.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  };
  element.remove = function () {
    if (element.parentNode !== null) element.parentNode.removeChild(element);
  };
  element.closest = function () {
    return null;
  };
  element.querySelector = function () {
    return null;
  };
  element.querySelectorAll = function () {
    return [];
  };
  element.addEventListener = function () {};
  element.removeEventListener = function () {};
  element.dispatchEvent = function () {
    return true;
  };
  element.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 16, bottom: 16, width: 16, height: 16 };
  };
  element.getClientRects = function () {
    return [element.getBoundingClientRect()];
  };
  return element;
}

/**
 * Build one isolated world: stub DOM + controllable time + loader capture.
 *
 * @param options.source - client.js source text (may be a mutated copy).
 * @param options.media - map of media query string -> boolean `matches`.
 * @param options.transcript - initial transcript text.
 */
export function createWorld(options = {}) {
  const source = options.source !== undefined ? String(options.source) : '';
  const media = options.media || {};
  const records = [];
  const clock = { now: 0 };
  const rafQueue = [];
  const intervals = new Map();
  const styleTags = [];
  let nextTimerId = 1;
  let rafIdCounter = 1;

  const html = makeElement({ tagName: 'HTML', records, clock, label: 'html' });
  const head = makeElement({ tagName: 'HEAD', records, clock, label: 'head' });
  const body = makeElement({ tagName: 'BODY', records, clock, label: 'body' });
  const transcript = makeElement({ tagName: 'DIV', records, clock, label: 'transcript' });
  const host = makeElement({ tagName: 'DIV', records, clock, label: 'running-host' });
  const icon = makeElement({ tagName: 'DIV', records, clock, label: 'running-icon' });
  const shipped = makeElement({ tagName: 'SVG', records, clock, label: 'shipped-child' });

  html.appendChild(head);
  html.appendChild(body);
  body.appendChild(transcript);
  transcript.appendChild(host);
  host.appendChild(icon);
  icon.appendChild(shipped);

  transcript.textContent = options.transcript !== undefined ? String(options.transcript) : '';
  host.setAttribute('data-chat-running', '');
  icon.className = 'xyz_runningIcon';

  // `closest()` on the indicator walks up to the conversation scroll container,
  // the same way the real DOM does.
  const closestImpl = function (selector) {
    const sel = String(selector);
    if (sel.includes('data-conversation-scroll')) return transcript;
    if (sel.includes('data-chat-running')) return host;
    return null;
  };
  host.closest = closestImpl;
  icon.closest = closestImpl;
  shipped.closest = closestImpl;
  host.parentElement = transcript;
  icon.parentElement = host;
  shipped.parentElement = icon;

  function isStyleSelector(selector) {
    return /\bstyle\b/i.test(selector) && /data-plugin-css/i.test(selector);
  }

  const documentStub = {
    nodeType: 9,
    documentElement: html,
    head,
    body,
    createElement(tag) {
      const element = makeElement({ tagName: tag, records, clock, label: `created:${tag}` });
      createdElements.push(element);
      return element;
    },
    createElementNS(_ns, tag) {
      return documentStub.createElement(tag);
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text) };
    },
    createDocumentFragment() {
      return makeElement({ tagName: 'FRAGMENT', records, clock, label: 'fragment' });
    },
    querySelector(selector) {
      const sel = String(selector);
      if (isStyleSelector(sel)) {
        const match = sel.match(/data-plugin-css\s*=\s*("([^"]*)"|'([^']*)'|([^\]\s]+))/);
        const wanted = match ? match[2] ?? match[3] ?? match[4] : null;
        return (
          styleTags.find((tag) => (wanted === null ? true : tag.dataset.pluginCss === wanted)) || null
        );
      }
      if (sel.includes('_runningIcon')) return icon;
      if (sel.includes('data-chat-running')) return host;
      if (sel.includes('data-conversation-scroll')) return transcript;
      if (sel === 'body') return body;
      if (sel === 'html' || sel === ':root') return html;
      return null;
    },
    querySelectorAll(selector) {
      const one = documentStub.querySelector(selector);
      return one === null ? [] : [one];
    },
    getElementById() {
      return null;
    },
    getElementsByTagName() {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
    defaultView: null,
  };
  const createdElements = [];
  documentStub.defaultView = null;

  // style tags inserted via head.appendChild() are tracked
  const originalHeadAppend = head.appendChild;
  head.appendChild = function (child) {
    const result = originalHeadAppend(child);
    if (child && child.tagName === 'STYLE') styleTags.push(child);
    return result;
  };

  function matchMedia(query) {
    const q = String(query);
    const matches = media[q] === true;
    const list = {
      media: q,
      matches,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return true;
      },
    };
    return list;
  }

  const windowStub = {
    document: documentStub,
    matchMedia,
    requestAnimationFrame(callback) {
      const id = rafIdCounter;
      rafIdCounter += 1;
      rafQueue.push({ id, callback });
      return id;
    },
    cancelAnimationFrame(id) {
      const index = rafQueue.findIndex((entry) => entry.id === id);
      if (index >= 0) rafQueue.splice(index, 1);
    },
    setInterval(callback, ms) {
      const id = nextTimerId;
      nextTimerId += 1;
      const delay = Number(ms);
      intervals.set(id, {
        callback,
        delay: Number.isFinite(delay) && delay > 0 ? delay : 16,
        next: clock.now + (Number.isFinite(delay) && delay > 0 ? delay : 16),
      });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    setTimeout(callback, ms) {
      return windowStub.setInterval(callback, ms);
    },
    clearTimeout(id) {
      intervals.delete(id);
    },
    getComputedStyle() {
      return { getPropertyValue: () => '' };
    },
    addEventListener() {},
    removeEventListener() {},
    loaded: null,
    __ModuleLoader__: {
      load(definition) {
        windowStub.loaded = definition;
        return definition;
      },
    },
  };
  documentStub.defaultView = windowStub;

  const sandbox = {
    window: windowStub,
    document: documentStub,
    console,
    performance: {
      now() {
        return clock.now;
      },
      timeOrigin: 0,
    },
    requestAnimationFrame: windowStub.requestAnimationFrame,
    cancelAnimationFrame: windowStub.cancelAnimationFrame,
    setInterval: windowStub.setInterval,
    clearInterval: windowStub.clearInterval,
    setTimeout: windowStub.setTimeout,
    clearTimeout: windowStub.clearTimeout,
    getComputedStyle: windowStub.getComputedStyle,
    matchMedia,
    Date,
    Math,
    JSON,
    Symbol,
    Object,
    Array,
    Number,
    String,
    Boolean,
    isFinite,
    parseFloat,
    parseInt,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });

  const world = {
    sandbox,
    windowStub,
    document: documentStub,
    html,
    head,
    body,
    transcript,
    host,
    icon,
    shipped,
    records,
    clock,
    styleTags,
    createdElements,
    media,
    /** All writes to a style property whose name matches /frame/i. */
    frameWrites(filter) {
      const re = filter || /frame/i;
      return records.filter(
        (record) => (record.kind === 'setProperty' || record.kind === 'assign') && re.test(record.name),
      );
    },
    /** All writes whose property name looks like a transform/motion property. */
    transformWrites() {
      return records.filter((record) => TRANSFORM_PROPERTY_RE.test(record.name));
    },
    /** Property names written during [from, to] ms, deduplicated. */
    writtenNames(from = -Infinity, to = Infinity) {
      const names = new Set();
      for (const record of records) {
        if (record.t < from || record.t > to) continue;
        if (record.kind === 'setProperty' || record.kind === 'assign') names.add(record.name);
      }
      return [...names];
    },
    insertedCss() {
      return styleTags.length === 0 ? null : styleTags.map((tag) => tag.textContent).join('\n');
    },
    loadModule() {
      const definition = windowStub.loaded;
      if (definition === null || definition === undefined) {
        throw new Error('client.js did not call window.__ModuleLoader__.load');
      }
      const exports = definition.factory();
      world.definition = definition;
      world.api = exports;
      return exports;
    },
    /**
     * Pump simulated time.
     *
     * @param options.charsPerSecond - transcript growth rate.
     * @param options.seconds - simulated duration.
     * @param options.tickHz - rAF ticks per simulated second.
     * @returns analysis of the frame-property writes.
     */
    pump({ charsPerSecond = 0, seconds = 4, tickHz = 60 } = {}) {
      const tickMs = 1000 / tickHz;
      const totalTicks = Math.round(seconds * tickHz);
      const startIndex = records.length;
      for (let step = 1; step <= totalTicks; step += 1) {
        const target = step * tickMs;
        // fire every interval whose deadline falls inside this tick
        let guard = 0;
        for (;;) {
          let due = null;
          for (const entry of intervals.values()) {
            if (entry.next <= target + 1e-9 && (due === null || entry.next < due.next)) due = entry;
          }
          if (due === null) break;
          clock.now = due.next;
          due.next += due.delay;
          try {
            due.callback();
          } catch (error) {
            records.push({ t: clock.now, label: 'interval', kind: 'throw', name: '', value: String(error && error.message) });
          }
          guard += 1;
          if (guard > 10000) break;
        }
        clock.now = target;
        if (charsPerSecond > 0) {
          const length = Math.floor((charsPerSecond * target) / 1000);
          transcript.textContent = 'x'.repeat(length);
        }
        const pending = rafQueue.splice(0, rafQueue.length);
        for (const entry of pending) {
          try {
            entry.callback(clock.now);
          } catch (error) {
            records.push({ t: clock.now, label: 'raf', kind: 'throw', name: '', value: String(error && error.message) });
          }
        }
      }
      return { startIndex, endIndex: records.length, totalTicks, tickMs };
    },
  };

  return world;
}

/** Collapse a list of `setProperty` records into {time, value(number)} points. */
export function toPoints(records) {
  const points = [];
  for (const record of records) {
    const number = Number(record.value);
    points.push({
      t: record.t,
      raw: record.value,
      value: number,
      integerText: /^\s*[+-]?\d+\s*$/.test(record.value),
      integer: Number.isInteger(number),
    });
  }
  return points;
}

export { TRANSFORM_PROPERTY_RE };
