#!/usr/bin/env node
/**
 * Release contract: every version-bearing string in the docs is the version in
 * `package.json`, and the release checklist exists.
 *
 * The README publishes an install command that pins a git ref, and a tarball
 * name for the offline route. Both are copies of `package.json`'s identity, and
 * a copy that is not checked drifts: the first thing a forgotten bump breaks is
 * the one command new users are told to run. This script makes that drift a red
 * CI step instead of a support thread.
 *
 * It also binds the docs' repository URLs to `package.json.repository`, so a
 * fork that only edits the package manifest fails here rather than shipping a
 * README that points at someone else's repository, and it keeps the quality
 * table's offline-suite count equal to the number of tests in the suite.
 *
 * Offline and deterministic: no network, no filesystem writes.
 *
 * Usage: node tools/check-release.mjs [--quiet]
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const patch = readFileSync(resolve(ROOT, 'cordis.patch.yml'), 'utf8');
const docs = readme + '\n' + patch;

const tag = 'v' + pkg.version;
const tarball = pkg.name + '-' + pkg.version + '.tgz';

const repoMatch = /github\.com[/:]([^/#?\s]+)\/([^/#?\s]+)/.exec(pkg.repository.url);
if (repoMatch === null) {
  console.error('package.json: repository.url is not a GitHub URL: ' + pkg.repository.url);
  process.exit(1);
}
const owner = repoMatch[1];
const repo = repoMatch[2].replace(/\.git$/, '');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  if (!QUIET || !ok) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
  }
}

// --- the pinned install ref -------------------------------------------------

const pins = [...docs.matchAll(/github:([^/\s`"')]+)\/([^#\s`"')]+)#([^\s`"')]+)/g)].map((match) => ({
  spec: match[0],
  owner: match[1],
  repo: match[2],
  ref: match[3],
}));
check('the docs pin a release ref', pins.length > 0, pins.length + ' pinned spec(s)');

const wrongRef = pins.filter((pin) => pin.ref !== tag);
check('every pinned ref is ' + tag, wrongRef.length === 0, wrongRef.map((pin) => pin.ref).join(', ') || undefined);

const wrongRepo = pins.filter((pin) => pin.owner !== owner || pin.repo !== repo);
check(
  'every pinned spec points at ' + owner + '/' + repo,
  wrongRepo.length === 0,
  wrongRepo.map((pin) => pin.spec).join(', ') || undefined,
);

// --- the offline tarball name ----------------------------------------------

const tgzs = [...docs.matchAll(/\b([A-Za-z0-9._-]+)-(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)\.tgz\b/g)].map(
  (match) => match[0],
);
check('the docs name the pack tarball', tgzs.length > 0, tgzs.join(', ') || 'none');
const wrongTgz = tgzs.filter((name) => name !== tarball);
check('every tarball name is ' + tarball, wrongTgz.length === 0, wrongTgz.join(', ') || undefined);

// --- every repository URL is this repository -------------------------------

const raws = [...readme.matchAll(/raw\.githubusercontent\.com\/([^/\s)]+)\/([^/\s)]+)\//g)];
const wrongRaw = raws.filter((match) => match[1] !== owner || match[2] !== repo);
check(
  'every raw asset URL is ' + owner + '/' + repo,
  wrongRaw.length === 0,
  wrongRaw.map((match) => match[0]).join(', ') || undefined,
);

const links = [...readme.matchAll(/https:\/\/github\.com\/([^/\s)]+)\/([^/\s)#]+)/g)];
const wrongLink = links.filter(
  (match) => match[1] !== owner || match[2].replace(/\.git$/, '') !== repo,
);
check(
  'every github.com link is ' + owner + '/' + repo,
  wrongLink.length === 0,
  wrongLink.map((match) => match[0]).join(', ') || undefined,
);

// --- the quality table's offline count is the suite's count ----------------

const suite = readFileSync(resolve(ROOT, 'tools/test-motion.mjs'), 'utf8');
const suiteTests = (suite.match(/^test\(/gm) || []).length;
const countRow = /`tools\/test-motion\.mjs`\s*\|\s*(\d+)\s*\/\s*(\d+)/.exec(readme);
check('the README quality table counts the offline suite', countRow !== null, 'row not found');
if (countRow !== null) {
  const stated = Number(countRow[1]) + '/' + Number(countRow[2]);
  check(
    'the README offline count is ' + suiteTests + '/' + suiteTests,
    Number(countRow[1]) === suiteTests && Number(countRow[2]) === suiteTests,
    'README says ' + stated,
  );
}

// --- the release checklist itself ------------------------------------------

const releasingPath = resolve(ROOT, 'RELEASING.md');
check('RELEASING.md exists', existsSync(releasingPath));
if (existsSync(releasingPath)) {
  const releasing = readFileSync(releasingPath, 'utf8');
  check('the checklist bumps the package version', /package\.json/.test(releasing) && /version/i.test(releasing));
  check('the checklist tags the release', /git tag -a v/.test(releasing));
  check('the checklist attaches the tarball to a GitHub Release', /gh release create/.test(releasing));
  check('the checklist verifies the offline install', /check-release|\.tgz/.test(releasing));
}

if (!QUIET) {
  console.log('');
  console.log(`${pkg.name}: version ${pkg.version}, tag ${tag}, tarball ${tarball}`);
  console.log(`docs scanned: README.md + cordis.patch.yml (${pins.length} pins, ${tgzs.length} tarball names)`);
  console.log(`repository: ${owner}/${repo}`);
}
console.log(failures === 0 ? 'RELEASE VERDICT: PASS' : `RELEASE VERDICT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
