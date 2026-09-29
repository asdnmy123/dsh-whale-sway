#!/usr/bin/env node
// Packaging contract: the published tarball carries the plugin, nothing else.
//
// The repository holds the whole toolchain (`tools/`, every build script and
// every test) and the source artwork (`preview/`). None of that is needed to RUN
// the plugin: `client.js` inlines its own sprite sheet and builds its own
// stylesheet, and the Host half has no runtime dependency at all. `package.json`
// therefore lists only the shipped paths, and this script checks the REAL
// `npm pack` result against that intent -- it catches a hand-edited `files`
// array, a path npm includes by default, and a stray `.npmignore`.
//
// The source artwork and the toolchain stay in the repository, where CI can use
// them, so this is the one place where "in the repo" and "in the package" are
// deliberately different sets.
//
// Usage: node tools/check-pack.mjs [--quiet]

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');

// Everything the plugin needs at runtime, and nothing more.
const SHIPPED = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
];

// `client.js` is 37 KB with the sheet spliced in and ~23 KB without it, so a
// packaged copy that lost the sheet cannot pass.
const CLIENT_MIN_BYTES = 30000;

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  if (!QUIET || !ok) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
  }
}

function runPack() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

const pack = runPack();
const entries = pack.files.map((f) => f.path);
const byPath = new Map(pack.files.map((f) => [f.path, f]));
const extra = entries.filter((p) => SHIPPED.indexOf(p) === -1);

check('npm pack lists no path outside the shipped set', extra.length === 0, extra.join(', ') || undefined);
check('npm pack lists every shipped path', SHIPPED.every((p) => byPath.has(p)),
  SHIPPED.filter((p) => !byPath.has(p)).join(', ') || undefined);
check('the tarball carries no tools/ or preview/ path',
  !entries.some((p) => /^(tools|preview)\//.test(p)));

// The sheet must survive packaging: byte-identical to the tracked artifact.
const tracked = statSync(resolve(ROOT, 'client.js')).size;
const packed = byPath.get('client.js');
check('the packaged client.js is byte-identical to the tracked one',
  Boolean(packed) && packed.size === tracked, packed ? `packed ${packed.size} vs tracked ${tracked}` : 'missing');
check('the packaged client.js carries the sprite sheet', Boolean(packed) && packed.size >= CLIENT_MIN_BYTES,
  packed ? `${packed.size} bytes` : 'missing');

// A shipped README must not point at files the package does not carry, unless
// the reference is an absolute URL that resolves outside the tarball.
const readme = byPath.get('README.md') ? readFileSync(resolve(ROOT, 'README.md'), 'utf8') : '';
const relativeRefs = (readme.match(/\]\((?!https?:)[^)]+\)/g) || [])
  .map((m) => m.slice(2, -1))
  .filter((p) => !p.startsWith('#'));
const dangling = relativeRefs.filter((p) => SHIPPED.indexOf(p.replace(/^\.\//, '')) === -1);
check('the shipped README has no relative link to an unshipped file', dangling.length === 0,
  dangling.join(', ') || undefined);

const name = pack.name || JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).name;
if (!QUIET) {
  console.log('');
  console.log(`${name}: ${pack.entryCount} files, ${pack.unpackedSize} bytes unpacked`);
  console.log(`relative README links checked: ${relativeRefs.length}`);
}
console.log(failures === 0 ? 'PACK VERDICT: PASS' : `PACK VERDICT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
