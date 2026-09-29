/**
 * dsh-whale-sway — client half: a whale tail that actually wags, as fast as the model
 * is producing tokens.
 *
 * ## What is being changed, and what is not
 *
 * The DSH running indicator ("深度求索中，用时 N 秒 ···") draws a DeepSeek
 * whale-tail mark to the left of its shimmering label. Shipped, that mark is a
 * base64 APNG used as a CSS mask, so the wag timing lives *inside the image*:
 * no stylesheet can change how fast it plays, and its amplitude is fixed.
 *
 * This half replaces **only the motion**. It hides the shipped mask and the
 * static SVG fallback inside the icon box, then draws the *same* geometry
 * (`REST_PATH`, the still fallback's own path data, 16x16 viewBox, stroke 1,
 * `currentColor`) as a pseudo-element mask and rotates it with a
 * requestAnimationFrame integrator. Shape, colour, size and the layout box are
 * untouched, so the icon still looks like the icon — it just swings much wider
 * and its tempo follows the live token rate.
 *
 * ## Why a JS integrator instead of CSS keyframes
 *
 * The sway rate has to follow the token rate continuously. With keyframes, every
 * new rate means a new `animation-duration`, and the browser restarts the
 * timeline: the tail jumps. Integrating the phase here makes a speed change
 * continuous — it accelerates instead of teleporting.
 *
 * ## Where the rate comes from (and its honest limitation)
 *
 * The Client API exposes no token counter to a plugin: the client event catalog
 * has only connection/locale/slot/theme events, and `ctx.sessions.binding()`
 * needs a session id this half deliberately does not want to plumb through a
 * Slot. So the rate is measured the way the user perceives it — characters
 * appended to the open conversation per second, divided by a
 * characters-per-token estimate. That is monotonic in real tok/s and needs no
 * shell internals, so a shell update cannot break it.
 *
 * ## Why nothing is clipped
 *
 * The icon box ships as `contain: strict; overflow: hidden` (about 14px). A
 * wider swing pushes the fluke tips ~1px outside that box, so the stylesheet
 * relaxes containment on that one element; everything else keeps its geometry.
 *
 * ## Load contract
 *
 * A DSH web client module: `window.__ModuleLoader__.load({ id, factory })`,
 * with `apply(ctx)` / `inject` on the returned module. No build step, no React,
 * no Slot registration — one stylesheet plus one animation loop.
 */

(function () {
  'use strict';

  /**
   * The shipped still-fallback path from `RunningWhaleTail.js` (viewBox 0 0 16
   * 16, `stroke="currentColor"`, `stroke-width="1"`). Kept byte-identical so the
   * re-animated mark is geometrically the same mark.
   */
  var REST_PATH =
    'M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43' +
    'C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945' +
    'C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978' +
    'C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686' +
    'C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202' +
    'C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115' +
    'C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368' +
    'C5.157 11.27 5.089 12.19 4.926 13.742';

  /** Stylesheet identity, tagged like every shipped client bundle stylesheet. */
  var CSS_TAG = 'dsh-whale-sway/WhaleSway.css';
  /** Host of the running indicator; the icon box is a descendant of this div. */
  var RUNNING_ATTR = 'data-chat-running';
  /** Scroll container the text-length sampler reads from. */
  var SCROLL_ATTR = 'data-conversation-scroll';
  /**
   * The shippped CSS-module class is `<hash>_runningIcon`. The hash changes per
   * build, the suffix does not, so the override keys on the substring.
   */
  var ICON_SELECTOR = '[' + RUNNING_ATTR + '] [class*="_runningIcon"]';

  /**
   * Motion tuning. Every number here is a taste decision, not a contract; the
   * README documents how to edit and reload them.
   */
  var TUNING = {
    /** Swing half-range at idle, in degrees. The shipped APNG moves a few degrees. */
    amplitudeDeg: 15,
    /** Extra half-range earned at `ampFullRate` — 15deg idle, 23deg flat out. */
    amplitudeGainDeg: 8,
    /** tok/s at which the full amplitude gain is reached. */
    ampFullRate: 45,
    /** Fastest full cycle (peak token rate). */
    minPeriodMs: 190,
    /** Slowest full cycle (idle, or waiting on a tool call). */
    maxPeriodMs: 1500,
    /** tok/s that halves the cycle time. */
    rateRef: 9,
    /** Ceiling on the measured rate, so one bulk re-render cannot peg it. */
    maxRate: 160,
    /** Characters per token for DeepSeek output (CJK-leaning). Tune per taste. */
    charsPerToken: 1.7,
    /** Text-length sampling window, in ms. */
    sampleMs: 200,
    /** EMA weight applied to each fresh measurement (0..1). */
    smooth: 0.4,
    /** Vertical bob half-range in px — the tell that sells a wag; 0 disables. */
    liftPx: 0.6,
    /** Root of the tail stock inside the 16x16 box: (6.89, 13.76) => 43% 86%. */
    pivot: '43% 86%',
  };

  // ---------------------------------------------------------------------
  // Pure motion maths (exported for the offline tests)
  // ---------------------------------------------------------------------

  function clamp(value, low, high) {
    var number = Number(value);
    if (!isFinite(number)) number = low;
    return number < low ? low : number > high ? high : number;
  }

  /**
   * Full-cycle duration for a token rate: fast tokens, short cycle.
   *
   * `maxPeriodMs / (1 + rate / rateRef)` — halves the cycle at `rateRef`, and is
   * asymptotic to 0, so it is clamped at both ends: never brisker than
   * `minPeriodMs`, never slower than `maxPeriodMs`.
   *
   * @param rate - tokens per second (any finite number; clamped).
   * @param tuning - optional tuning override.
   * @returns the cycle duration in milliseconds.
   */
  function periodForRate(rate, tuning) {
    var t = tuning || TUNING;
    var r = clamp(rate, 0, t.maxRate);
    return clamp(t.maxPeriodMs / (1 + r / t.rateRef), t.minPeriodMs, t.maxPeriodMs);
  }

  /**
   * Swing half-range for a token rate: the busier the model, the wider the tail.
   *
   * Linear in rate up to `ampFullRate`, then flat — enough to read as "excited"
   * without letting the fluke tips wander far outside the icon box.
   *
   * @param rate - tokens per second.
   * @param tuning - optional tuning override.
   * @returns the half-range in degrees.
   */
  function amplitudeForRate(rate, tuning) {
    var t = tuning || TUNING;
    var r = clamp(rate, 0, t.maxRate);
    var share = t.ampFullRate <= 0 ? 1 : Math.min(1, r / t.ampFullRate);
    return clamp(t.amplitudeDeg + t.amplitudeGainDeg * share, 0, 60);
  }

  /** Vertical bob half-range for a token rate, in px. */
  function liftForRate(rate, tuning) {
    var t = tuning || TUNING;
    var r = clamp(rate, 0, t.maxRate);
    var share = t.ampFullRate <= 0 ? 1 : Math.min(1, r / t.ampFullRate);
    return clamp(t.liftPx * (0.35 + 0.65 * share), 0, 8);
  }

  /**
   * Token-rate estimator over a monotonically growing text length.
   *
   * Characters appended since the previous sample, divided by the elapsed time
   * and by `charsPerToken`, then smoothed with an EMA. Shrinking lengths (a
   * re-render, a compaction) contribute nothing instead of a negative rate.
   *
   * @param tuning - optional tuning override.
   * @returns { sample, reset, rate } — `sample(length, nowMs)` returns the rate.
   */
  function createRateMeter(tuning) {
    var t = tuning || TUNING;
    var primed = false;
    var prevLength = 0;
    var prevTime = 0;
    var rate = 0;

    return {
      /**
       * Feed one observation.
       *
       * @param length - current text length of the observed container.
       * @param nowMs - monotonic timestamp in ms.
       * @returns the smoothed tokens-per-second estimate.
       */
      sample: function (length, nowMs) {
        var current = Number(length);
        if (!isFinite(current) || current < 0) current = 0;
        var now = Number(nowMs);
        if (!isFinite(now)) now = 0;
        if (!primed) {
          primed = true;
          prevLength = current;
          prevTime = now;
          return rate;
        }
        var seconds = (now - prevTime) / 1000;
        // Ignore sub-window re-entry so a burst of samples cannot inflate dt.
        if (seconds > 0.05) {
          var grown = Math.max(0, current - prevLength);
          var measured = clamp(grown / seconds / t.charsPerToken, 0, t.maxRate);
          rate = rate + t.smooth * (measured - rate);
          prevLength = current;
          prevTime = now;
        }
        return rate;
      },
      reset: function () {
        primed = false;
        prevLength = 0;
        prevTime = 0;
        rate = 0;
      },
      get rate() {
        return rate;
      },
    };
  }

  // ---------------------------------------------------------------------
  // Stylesheet
  // ---------------------------------------------------------------------

  /** The mask must be the shipped stroke geometry, or the mark changes shape. */
  function buildMask() {
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">' +
      '<path d="' +
      REST_PATH +
      '" stroke="#000" stroke-width="1"/></svg>';
    return 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
  }

  /**
   * Build the override stylesheet.
   *
   * Two self-gates keep a hostile shell from making things worse:
   * `prefers-reduced-motion: no-preference` (a reduced-motion user keeps the
   * shipped still mark) and `@supports (mask-mode: alpha) and
   * (mask-image: url(""))` — the same probe the shipped bundle uses — so a
   * browser without CSS masking keeps the shipped rendering instead of getting
   * an unmasked solid square.
   *
   * @param mask - the `url(...)` produced by `buildMask()`.
   * @returns the stylesheet text.
   */
  function buildCss(mask) {
    return (
      // Relax containment on the icon box only: a wider swing needs ~1px more room.
      ICON_SELECTOR +
      '{contain:none!important;overflow:visible!important}' +
      '@media (prefers-reduced-motion:no-preference){' +
      '@supports (mask-mode:alpha) and (mask-image:url("")){' +
      // Hide the shipped APNG mask and the shipped still SVG.
      ICON_SELECTOR +
      '>*{display:none!important}' +
      // Draw the same mark, driven by the two custom properties the loop writes.
      ICON_SELECTOR +
      '::after{' +
      'content:"";position:absolute;inset:0;background:currentColor;' +
      'transform-origin:' +
      TUNING.pivot +
      ';' +
      'transform:translateY(var(--dsh-whale-lift,0px)) rotate(var(--dsh-whale-angle,0deg));' +
      'mask-image:' +
      mask +
      ';mask-mode:alpha;mask-repeat:no-repeat;mask-position:50% 50%;mask-size:100% 100%;' +
      '-webkit-mask-image:' +
      mask +
      ';-webkit-mask-repeat:no-repeat;-webkit-mask-position:50% 50%;-webkit-mask-size:100% 100%;' +
      'will-change:transform}' +
      '}}'
    );
  }

  // ---------------------------------------------------------------------
  // Driver
  // ---------------------------------------------------------------------

  function nowMs() {
    if (typeof performance !== 'undefined' && performance !== null && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  /**
   * Own the animation loop for one document.
   *
   * `sync()` is idempotent: it starts the loop when the running indicator exists
   * and motion is allowed, and stops it otherwise. `stop()` also clears the two
   * custom properties so a disabled plugin leaves no residue.
   *
   * @param root - the element the custom properties are written to (`<html>`).
   * @param tuning - tuning values.
   * @returns { sync, stop }.
   */
  function createController(root, tuning) {
    var meter = createRateMeter(tuning);
    var rafId = 0;
    var pollId = 0;
    var phase = 0;
    var lastTs = 0;
    var target = null;
    var watch = [];

    function findRunning() {
      try {
        return document.querySelector('[' + RUNNING_ATTR + ']');
      } catch (error) {
        return null;
      }
    }

    /** Length of the visible transcript: the raw material of the rate estimate. */
    function readLength(element) {
      var host = null;
      try {
        host = element.closest('[' + SCROLL_ATTR + ']') || element.parentElement || document.body;
      } catch (error) {
        host = document.body;
      }
      try {
        return host !== null && typeof host.textContent === 'string' ? host.textContent.length : 0;
      } catch (error) {
        return 0;
      }
    }

    /** Accessibility and forced-colors gate, mirroring the shipped media query. */
    function allowed() {
      try {
        if (typeof window.matchMedia !== 'function') return true;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
        if (window.matchMedia('(forced-colors: active)').matches) return false;
      } catch (error) {
        // A shell without matchMedia (or a throwing stub) animates; the CSS gate
        // still protects reduced-motion users that the platform does report.
      }
      return true;
    }

    function clearProperties() {
      try {
        root.style.removeProperty('--dsh-whale-angle');
        root.style.removeProperty('--dsh-whale-lift');
      } catch (error) {
        /* detached root: nothing to clear */
      }
    }

    function frame(timestamp) {
      var element = target;
      if (element === null || element.isConnected !== true) element = target = findRunning();
      if (element === null) {
        // The indicator is gone: park the loop; poll() restarts it.
        rafId = 0;
        lastTs = 0;
        clearProperties();
        return;
      }
      rafId = requestAnimationFrame(frame);

      var seconds = lastTs === 0 ? 0 : Math.min(0.12, (timestamp - lastTs) / 1000);
      lastTs = timestamp;

      var rate = meter.rate;
      var period = periodForRate(rate, tuning);
      phase += (seconds * 1000) / period;
      if (phase > 1e6) phase -= Math.floor(phase / 1e6) * 1e6;

      var angle = amplitudeForRate(rate, tuning) * Math.sin(phase * Math.PI * 2);
      // The bob runs at twice the sway frequency: one dip per swing.
      var lift = liftForRate(rate, tuning) * Math.sin(phase * Math.PI * 4);
      root.style.setProperty('--dsh-whale-angle', angle.toFixed(2) + 'deg');
      root.style.setProperty('--dsh-whale-lift', lift.toFixed(2) + 'px');
    }

    function poll() {
      if (typeof document === 'undefined') return;
      var element = findRunning();
      if (element === null) {
        meter.reset();
        target = null;
        return;
      }
      target = element;
      meter.sample(readLength(element), nowMs());
      if (rafId === 0) {
        lastTs = 0;
        rafId = requestAnimationFrame(frame);
      }
    }

    function sync() {
      if (typeof document === 'undefined') return;
      if (!allowed()) {
        stop();
        return;
      }
      poll();
      if (pollId === 0) {
        try {
          pollId = window.setInterval(poll, tuning.sampleMs);
        } catch (error) {
          pollId = 0;
        }
      }
    }

    function stop() {
      if (rafId !== 0) {
        try {
          cancelAnimationFrame(rafId);
        } catch (error) {
          /* nothing to cancel */
        }
        rafId = 0;
      }
      if (pollId !== 0) {
        try {
          window.clearInterval(pollId);
        } catch (error) {
          /* nothing to clear */
        }
        pollId = 0;
      }
      meter.reset();
      target = null;
      phase = 0;
      lastTs = 0;
      clearProperties();
    }

    // React to a preference change without a reload.
    try {
      if (typeof window.matchMedia === 'function') {
        var queries = ['(prefers-reduced-motion: reduce)', '(forced-colors: active)'];
        for (var i = 0; i < queries.length; i += 1) {
          var media = window.matchMedia(queries[i]);
          if (media !== null && typeof media.addEventListener === 'function') {
            media.addEventListener('change', sync);
            watch.push(media);
          }
        }
      }
    } catch (error) {
      watch = [];
    }

    return {
      sync: sync,
      stop: function () {
        stop();
        for (var i = 0; i < watch.length; i += 1) {
          try {
            watch[i].removeEventListener('change', sync);
          } catch (error) {
            /* already detached */
          }
        }
        watch = [];
      },
    };
  }

  // ---------------------------------------------------------------------
  // Plugin face
  // ---------------------------------------------------------------------

  /**
   * Client plugin body: inject the stylesheet and run the sway loop.
   *
   * Deliberately tolerant: a failure here must leave the shipped indicator
   * exactly as it was, never break the transcript.
   *
   * @param ctx - client root context.
   */
  function apply(ctx) {
    if (typeof document === 'undefined' || document === null) return;

    var root = document.documentElement;
    var css = buildCss(buildMask());
    var controller = createController(root, TUNING);
    var tag = null;

    function ensureStyle() {
      if (tag !== null && tag.parentNode !== null) return;
      try {
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') !== null) return;
        tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-whale-sway';
        tag.dataset.pluginCss = CSS_TAG;
        tag.textContent = css;
        document.head.appendChild(tag);
      } catch (error) {
        tag = null;
        try {
          console.warn('[dsh-whale-sway] stylesheet injection failed; the shipped indicator is untouched:', error);
        } catch (ignored) {
          /* console unavailable */
        }
      }
    }

    function dispose() {
      controller.stop();
      try {
        if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag);
      } catch (error) {
        /* already detached */
      }
      tag = null;
    }

    try {
      if (ctx !== undefined && ctx !== null && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          ensureStyle();
          controller.sync();
          return dispose;
        }, 'dsh-whale-sway: whale-tail sway');
      } else {
        ensureStyle();
        controller.sync();
      }
    } catch (error) {
      try {
        console.warn('[dsh-whale-sway] whale-tail sway setup failed; the shipped indicator is untouched:', error);
      } catch (ignored) {
        /* console unavailable */
      }
    }
  }

  // ---------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------

  /** Named-only exports: the Loader unwraps `exports.default ?? exports`. */
  var manifest = {
    apply: apply,
    inject: [],
    REST_PATH: REST_PATH,
    TUNING: TUNING,
    CSS_TAG: CSS_TAG,
    ICON_SELECTOR: ICON_SELECTOR,
    clamp: clamp,
    periodForRate: periodForRate,
    amplitudeForRate: amplitudeForRate,
    liftForRate: liftForRate,
    createRateMeter: createRateMeter,
    buildMask: buildMask,
    buildCss: buildCss,
  };

  if (
    typeof window !== 'undefined' &&
    window !== null &&
    window.__ModuleLoader__ !== undefined &&
    window.__ModuleLoader__ !== null &&
    typeof window.__ModuleLoader__.load === 'function'
  ) {
    window.__ModuleLoader__.load({
      id: 'dsh-whale-sway',
      factory: function () {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
        for (var key in manifest) {
          if (Object.prototype.hasOwnProperty.call(manifest, key)) exports[key] = manifest[key];
        }
        return module.exports;
      },
    });
  }

  // Test hook: the offline harness evaluates this file in a VM and reads it back.
  if (typeof globalThis !== 'undefined') globalThis.__dshIconApi = manifest;
  if (typeof module !== 'undefined' && module !== null && module.exports !== undefined) {
    module.exports = manifest;
  }
})();
