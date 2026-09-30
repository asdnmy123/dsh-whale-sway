/**
 * verify-settings.mjs — prove the Host half really is a DSH settings page.
 *
 * The configuration interface has two halves that fail in very different ways:
 * the browser half can be read in a VM (which `tools/test-motion.mjs` does), but
 * the Host half only exists once DSH's settings domain projects the plugin's
 * Loader entry, and that projection runs inside the DSH process.
 *
 * So this tool borrows the deployment the machine already has: it resolves
 * `@deepseek-ai/schemastery` and DSH's own schema-projection module from the
 * active profile, imports the *real* `index.js`, and runs the *real*
 * `volatileForm()` / `projectForm()` over the schema it exports. What it checks
 * is exactly what the settings page would see:
 *
 *   - the entry declares a Config at all (without one, DSH serves no form);
 *   - `volatileForm(Config)` selects every declared parameter, with the declared
 *     type, bounds and default — a non-volatile or unprojectable field would
 *     simply be missing from the page;
 *   - the schema validates a write and fills the defaults, and refuses a value
 *     outside a declared enum or bound.
 *
 * When no DSH installation is reachable (CI, a bare checkout) the tool reports a
 * skip and exits 0: the check needs a deployment, and the other tools cover the
 * repository-only contract.
 *
 *   node tools/verify-settings.mjs            # profile from DSH_PROFILE_DIR
 *   node tools/verify-settings.mjs --base <d> # resolve from <d>
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SETTINGS_FIELDS, SETTINGS_NAMESPACE, defaultConfig, findSetting } from './settings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PACKAGE = '@deepseek-ai/schemastery';
const SETTINGS_PACKAGE = '@deepseek-ai/dsh-settings';
const SETTINGS_SCHEMA_MODULE = '@deepseek-ai/dsh-settings/lib/types/schema.js';

const failures = [];
let checks = 0;

function check(ok, message) {
  checks += 1;
  if (ok) {
    console.log('  ok   ' + message);
    return true;
  }
  failures.push(message);
  console.log('  FAIL ' + message);
  return false;
}

/** The resolution bases to try, in order. */
function candidateBases() {
  const argAt = process.argv.indexOf('--base');
  const bases = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !bases.includes(value)) bases.push(value);
  };
  if (argAt >= 0) push(process.argv[argAt + 1]);
  push(process.env.DSH_PROFILE_DIR);
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
    push(join(process.env.DSH_HOME, 'profiles', String(process.env.DSH_PROFILE ?? '')));
    push(join(process.env.DSH_HOME, 'profiles'));
  }
  return bases;
}

/**
 * Locate DSH's schema-projection module from one base directory.
 *
 * The settings domain ships inside the `@deepseek-ai/dsh` package rather than
 * beside the profile, so resolving it from the profile root alone fails; the
 * module is reached by first resolving the `dsh` package itself and building a
 * `require` at that location. A profile that carries only the schema factory
 * still resolves, because the factory is a direct dependency of DSH.
 *
 * @param base - the directory to resolve from (a profile, or a DSH home).
 * @returns `{ schemaPath }`, or null when this base cannot serve the packages.
 */
function locateFrom(base) {
  let outer;
  try {
    outer = createRequire(join(base, 'package.json'));
    outer.resolve(SCHEMA_PACKAGE);
    // The settings package restricts its `exports`, so the projection module is
    // not addressable as a subpath specifier — but the package manifest is, and
    // its directory names the module directly. Importing by absolute path is
    // what the DSH process itself does with its own internal modules.
    const manifest = outer.resolve(SETTINGS_PACKAGE + '/package.json');
    const schemaPath = join(dirname(manifest), 'lib', 'types', 'schema.js');
    if (!existsSync(schemaPath)) return null;
    return { schemaPath, factoryPath: outer.resolve(SCHEMA_PACKAGE) };
  } catch (error) {
    return null;
  }
}

const bases = candidateBases().filter((base) => existsSync(base));
let located = null;
let base = null;
for (const candidate of bases) {
  const found = locateFrom(candidate);
  if (found !== null) {
    located = found;
    base = candidate;
    break;
  }
}

if (located === null) {
  console.log('[verify-settings] no DSH installation reachable from: ' + (bases.join(', ') || '(no candidate)'));
  console.log('[verify-settings] SKIP — this check needs a deployment that ships ' + SETTINGS_PACKAGE);
  process.exit(0);
}

console.log('[verify-settings] deployment base: ' + base);

// ---------------------------------------------------------------------------
// DSH's own projection, and this package's real Host half
// ---------------------------------------------------------------------------

const projection = await import(pathToFileURL(located.schemaPath).href);
const host = await import(pathToFileURL(resolve(ROOT, 'index.js')).href);
const factoryModule = await import(pathToFileURL(located.factoryPath).href);
/** The schema factory the client rebuilds a wire schema with. */
const schemaFactory = factoryModule.default ?? factoryModule;

check(typeof projection.volatileForm === 'function', 'DSH ships the schema projection this check runs');
check(host.name === SETTINGS_NAMESPACE, `the Host half is the plugin "${SETTINGS_NAMESPACE}"`);
check(host.Config !== undefined && host.Config !== null, 'the Host half exports a Config schema (without one DSH serves no form)');

if (host.Config === undefined || host.Config === null) {
  console.log('');
  console.log(`VERDICT: FAIL (${failures.length} of ${checks})`);
  process.exit(1);
}

const form = projection.volatileForm(host.Config);
check(form !== undefined && form !== null, 'volatileForm() selects a form from the schema (every field is volatile)');

// `describe()` puts exactly this literal on the wire (`schema: form.toJSON()`),
// and a client rebuilds it with the same factory before rendering a control, so
// the fields checked here are the fields the settings page receives.
const rebuilt = form === undefined || form === null ? null : new schemaFactory(form.toJSON());
const projected = rebuilt !== null && rebuilt.dict !== undefined ? rebuilt.dict : null;
check(projected !== null, 'the projected form is a flat object of fields');

const declared = SETTINGS_FIELDS.map((field) => field.id);
const served = projected === null ? [] : Object.keys(projected);
check(
  served.length === declared.length && declared.every((id) => served.includes(id)),
  `every declared parameter is projected (declared ${declared.length}, projected ${served.length}: ${served.join(', ')})`,
);

for (const field of SETTINGS_FIELDS) {
  const node = projected === null ? undefined : projected[field.id];
  if (node === undefined || node === null) {
    check(false, `field ${field.id} is missing from the projected form`);
    continue;
  }
  const meta = node.meta ?? {};
  // `volatileForm()` selects on volatility and strips the marker from the form it
  // publishes, so a projected field is volatile by construction; the declaration
  // itself is checked at the source schema.
  check(
    host.Config.dict !== undefined &&
      host.Config.dict[field.id] !== undefined &&
      host.Config.dict[field.id].meta?.volatile === true,
    `field ${field.id} is declared volatile (a write applies without a remount)`,
  );
  check(
    JSON.stringify(meta.default) === JSON.stringify(field.default),
    `field ${field.id} keeps its declared default ${JSON.stringify(field.default)}`,
  );
  if (field.type === 'enum') {
    const values = Array.isArray(node.list) ? node.list.map((entry) => entry.value) : [];
    check(
      field.values.every((value) => values.includes(value)) && values.length === field.values.length,
      `field ${field.id} offers exactly [${field.values.join(', ')}] (projected ${values.join(', ')})`,
    );
  } else if (field.type === 'boolean') {
    check(node.type === 'boolean', `field ${field.id} is a boolean`);
  } else {
    check(node.type === 'number', `field ${field.id} is a number`);
    check(node.meta?.min === field.min, `field ${field.id} keeps its lower bound ${field.min}`);
    check(node.meta?.max === field.max, `field ${field.id} keeps its upper bound ${field.max}`);
  }
}

// ---------------------------------------------------------------------------
// the same read/write path the settings page uses
// ---------------------------------------------------------------------------

const defaults = defaultConfig();
const resolvedDefaults = projection.plainConfig(host.Config({}));
for (const field of SETTINGS_FIELDS) {
  check(
    JSON.stringify(resolvedDefaults[field.id]) === JSON.stringify(defaults[field.id]),
    `an empty config resolves ${field.id} to its default`,
  );
}

const mode = findSetting('mode');
for (const panel of mode.values) {
  const value = projection.plainConfig(host.Config({ mode: panel }));
  check(value.mode === panel, `a write of mode="${panel}" validates and resolves to itself`);
}
const written = projection.plainConfig(host.Config({ mode: 'sway-vivid', minPeriodMs: 240 }));
check(written.mode === 'sway-vivid' && written.minPeriodMs === 240, 'a partial write keeps its fields and fills the rest');
check(
  JSON.stringify(projection.projectForm(form, written)) === JSON.stringify(written),
  'projectForm() carries every field of an accepted write through to the page',
);

let refusedUnknownMode = false;
try {
  host.Config({ mode: 'sway-nope' });
} catch (error) {
  refusedUnknownMode = true;
}
check(refusedUnknownMode, 'a value outside the sway enum is refused (the Host validates before persisting)');

let refusedBound = false;
try {
  host.Config({ minPeriodMs: 1 });
} catch (error) {
  refusedBound = true;
}
check(refusedBound, 'a number below its declared bound is refused');

let refusedType = false;
try {
  host.Config({ enabled: 'yes' });
} catch (error) {
  refusedType = true;
}
check(refusedType, 'a non-boolean for the enable switch is refused');

console.log('');
if (failures.length > 0) {
  for (const failure of failures) console.log('FAILED: ' + failure);
  console.log(`VERDICT: FAIL (${failures.length} of ${checks})`);
  process.exit(1);
}
console.log(
  `VERDICT: PASS — ${checks}/${checks} checks: the deployment projects ${served.length} configurable ` +
    `parameter(s) for "${SETTINGS_NAMESPACE}", every one volatile`,
);
