#!/usr/bin/env node
// Maintainers only: cut the public repository. Takes this repository's tree at a git ref into a new folder as ONE
// commit with no history, after scanning every file, and prints what the owner runs next (it never creates, pushes to
// or changes a GitHub repository itself).
//
//   node scripts/release-cut.mjs [--ref <ref>] [--out <dir>] [--json]
//
//   --ref   what to cut (default HEAD): a branch, a tag or a commit. Only committed files go (git archive), never the
//           working tree, games/, .gamesfun/ or anything git ignores.
//   --out   the new folder (default ../xgames-kit beside this checkout). It must not exist or be empty.
//
// Before the commit the tree is scanned, and the cut is refused on any hit that no allow-list below explains:
//   1. secrets: builder/lib/publish/scan.mjs's scanFile, the same rules a published game is held to (key-shaped strings,
//      .env files, key and keypair files);
//   2. the deny-list (DENY, case-insensitive): private paths and names that must not be in a public repository;
//   3. size: no file over 50 MB (GitHub refuses a file over 100 MB and warns over 50 MB).
// An allow-list entry that no longer matches anything is reported, so the list only shrinks.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFile } from '../builder/lib/publish/scan.mjs';
import { isMain } from '../builder/lib/main.mjs';

const KIT_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const REPO = 'anthonyvicenti/xgames-kit';
export const MESSAGE = 'xgames-kit: initial import';
export const ATTRIBUTION = [
  'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
];
export const MAX_BYTES = 50 * 1024 * 1024;

/** Words and paths that must not be in the public tree (matched case-insensitively, in file contents and file paths). */
export const DENY = [
  { id: 'home path', re: /\/home\/potatoe/i },
  { id: 'owner handle', re: /potatoe/i },
  { id: 'private reference folder', re: /private-explore/i },
  { id: 'private reference game', re: /dark\s*veil/i },
  { id: 'the owner\'s graphics card', re: /rtx\s*5090/i },
  { id: 'private library', re: /games\.fun-library/i },
  { id: 'internal branch name', re: /(?<![\w.@/-])agent\/[a-z0-9][\w.-]*/i },
  { id: 'deployment id', re: /\bdpl_[A-Za-z0-9]/i },
];

/**
 * Hits that are allowed, each with its reason. `file` is a path in the cut (exact, or a prefix ending in '/'); `id` is
 * a DENY id or a secret kind from builder/lib/publish/scan.mjs ('*' for any).
 */
export const ALLOW = [
  { file: 'scripts/release-cut.mjs', id: '*', why: 'this script: it holds the deny-list itself' },
  { file: 'tests/release-cut.test.mjs', id: '*', why: 'the tests of this script: they feed it the words it must refuse' },
  { file: '.env.example', id: 'a .env file (secrets live there, never in a game)', why: 'the template a person copies to .env: every value in it is empty or a number, and any key-shaped text in it is still refused by the other rules' },
  { file: 'tests/art.test.mjs', id: '*', why: 'a made-up key (sk-THIS-MUST-NOT-APPEAR-…) the test proves never reaches a choice, a doctor line or a ticket' },
  { file: 'tests/web3-routes.test.mjs', id: 'Solana secret key (base58)', why: 'a key-shaped string the item route must refuse' },
  { file: 'tests/backend-local-e2e.mjs', id: 'database address with a password', why: 'the local Supabase stack\'s documented default (postgres:postgres on 127.0.0.1), in a usage comment' },
  { file: 'tests/web3/fixtures/loot-0.3.json', id: 'Solana secret key (base58)', why: 'devnet transaction signatures (64 bytes in base58, the same shape as a key), public on the explorer' },
  { file: 'builder/web3/economy/evals/results/2026-10-11.json', id: 'Solana secret key (base58)', why: 'devnet transaction signatures of the eval run, public on the explorer' },
  { file: 'program/README.md', id: 'Solana secret key (base58)', why: 'the devnet upgrade transaction\'s signature, public on the explorer' },
  { file: 'program/loot/BUILD.md', id: 'Solana secret key (base58)', why: 'the devnet deploy transaction\'s signature, public on the explorer' },
];

const inList = (list, rel, id) => list.find(a => (a.file.endsWith('/') ? rel.startsWith(a.file) : rel === a.file) && (a.id === '*' || a.id === id)) ?? null;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout;
}

async function walk(dir, base = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === '.git' && dir === base) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/** Scan one file. → [{file, id, kind, line, allowed: null | 'allow', why}] */
export function scanOne(rel, buf, { allow = ALLOW } = {}) {
  const hits = [];
  const add = (id, kind, line) => {
    const a = inList(allow, rel, id);
    hits.push({ file: rel, id, kind, line, allowed: a ? 'allow' : null, why: a?.why ?? null });
  };
  if (buf.length > MAX_BYTES) add('size', `${(buf.length / 1048576).toFixed(1)} MB (over ${MAX_BYTES / 1048576} MB)`, 0);
  for (const h of scanFile(rel, buf)) add(h.kind, 'secret', h.line);
  for (const d of DENY) if (d.re.test(rel)) add(d.id, 'in the file\'s path', 0);
  const text = buf.subarray(0, 8192).includes(0) ? null : buf.toString('utf8');
  if (text != null) {
    for (const d of DENY) {
      const re = new RegExp(d.re.source, d.re.flags.includes('g') ? d.re.flags : d.re.flags + 'g');
      let n = 0, first = null;
      for (const m of text.matchAll(re)) { n++; first ??= text.slice(0, m.index).split('\n').length; }
      if (n) add(d.id, `${n} match${n === 1 ? '' : 'es'}`, first);
    }
  }
  return hits;
}

/** Scan a folder. → { files, bytes, hits, refused, unusedAllow } */
export async function scanTree(dir, lists = {}) {
  const files = (await walk(dir)).sort();
  const hits = []; let bytes = 0;
  for (const rel of files) {
    const buf = await readFile(path.join(dir, ...rel.split('/')));
    bytes += buf.length;
    hits.push(...scanOne(rel, buf, lists));
  }
  // an entry that explained no hit is reported (the lists only shrink)
  const all = lists.allow ?? ALLOW;
  const unusedAllow = all.filter(a => !hits.some(h => h.allowed && (a.file.endsWith('/') ? h.file.startsWith(a.file) : h.file === a.file) && (a.id === '*' || a.id === h.id)));
  return { files: files.length, bytes, hits, refused: hits.filter(h => !h.allowed), unusedAllow };
}

/** The steps the owner runs after the cut (printed, never run here). */
export const nextSteps = out => [
  `cd ${out}`,
  `gh repo create ${REPO} --private --source . --remote origin   # create it private, without pushing yet`,
  `gh api -X PUT repos/${REPO}/actions/permissions -F enabled=false   # optional: .github/workflows/check.yml runs on every push`,
  'git push -u origin main',
  `gh repo edit ${REPO} --visibility public --accept-visibility-change-consequences   # once the private copy looks right`,
];

export async function cut({ ref = 'HEAD', out = path.resolve(KIT_ROOT, '..', 'xgames-kit'), log = console.log } = {}) {
  const commit = run('git', ['-C', KIT_ROOT, 'rev-parse', '--verify', `${ref}^{commit}`]).trim();
  out = path.resolve(out);
  if (existsSync(out) && readdirSync(out).length) throw Object.assign(new Error(`${out} is not empty: the cut goes into a new or empty folder`), { code: 'NOT_EMPTY' });
  mkdirSync(out, { recursive: true });
  log(`release-cut: ${ref} (${commit.slice(0, 12)}) into ${out}`);
  // git archive | tar -x: only committed files, with .gitattributes export-ignore honoured
  const archive = spawnSync('git', ['-C', KIT_ROOT, 'archive', '--format=tar', commit], { maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
  run('tar', ['-x', '-C', out], { input: archive.stdout, encoding: null });
  const scan = await scanTree(out);
  const counts = {};
  for (const h of scan.hits) counts[h.allowed ?? 'refused'] = (counts[h.allowed ?? 'refused'] ?? 0) + 1;
  log(`scanned ${scan.files} files, ${(scan.bytes / 1048576).toFixed(1)} MB: ${scan.hits.length} hit(s) (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'})`);
  for (const a of scan.unusedAllow) log(`  allow-list entry no longer needed: ${a.file} ${a.id}`);
  if (scan.refused.length) {
    for (const h of scan.refused) log(`  REFUSED ${h.file}${h.line ? `:${h.line}` : ''}: ${h.id} (${h.kind})`);
    rmSync(out, { recursive: true, force: true });
    return { ok: false, commit, out, scan };
  }
  run('git', ['-C', out, 'init', '-q', '-b', 'main']);
  run('git', ['-C', out, 'add', '-A']);   // the new folder holds exactly the archive
  run('git', ['-C', out, 'commit', '-q', '-m', MESSAGE, '-m', `Cut from ${commit.slice(0, 12)} of the development repository with scripts/release-cut.mjs.`, '-m', ATTRIBUTION.join('\n')]);
  const head = run('git', ['-C', out, 'rev-parse', 'HEAD']).trim();
  const tracked = run('git', ['-C', out, 'ls-files']).trim().split('\n').length;
  log(`one commit ${head.slice(0, 12)} on main: ${tracked} files. Next, for the owner (not run here):`);
  for (const s of nextSteps(out)) log(`  ${s}`);
  return { ok: true, commit, out, head, tracked, scan };
}

async function main() {
  const a = process.argv.slice(2);
  const opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const r = await cut({ ref: opt('--ref') ?? 'HEAD', out: opt('--out') ?? undefined, log: a.includes('--json') ? () => {} : console.log });
    if (a.includes('--json')) console.log(JSON.stringify({ ...r, scan: { ...r.scan, hits: r.scan.hits } }, null, 1));
    if (!r.ok) console.error('release-cut: REFUSED (nothing was committed; the folder was removed)');
    return r.ok ? 0 : 1;
  } catch (e) { console.error(`release-cut: ${e.message}`); return 2; }
}

if (isMain(import.meta)) process.exitCode = await main();
