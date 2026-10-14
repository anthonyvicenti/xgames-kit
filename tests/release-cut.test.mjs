// scripts/release-cut.mjs: the public cut is refused on a secret, a private word or a huge file, unless an allow-list
// entry explains it; and it never writes into a folder that is not empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cut, DENY, MAX_BYTES, nextSteps, scanOne, scanTree } from '../scripts/release-cut.mjs';
import { tempDir } from './helpers.mjs';

const B = s => Buffer.from(s);

test('the deny-list catches the private words, in contents and in paths, case-insensitively', () => {
  const ids = t => scanOne('docs/x.md', B(t), { allow: [] }).map(h => h.id);
  assert.deepEqual(ids('cd /home/POTATOE/Documents'), ['home path', 'owner handle']);
  assert.deepEqual(ids('a game like dark veil'), ['private reference game']);
  assert.deepEqual(ids('on an RTX 5090'), ['the owner\'s graphics card']);
  assert.deepEqual(ids('see research/private-explore/trials'), ['private reference folder']);
  assert.deepEqual(ids('the ../games.fun-library folder'), ['private library']);
  assert.deepEqual(ids('merged from agent/backend'), ['internal branch name']);
  assert.deepEqual(ids('deploy dpl_2XLsx'), ['deployment id']);
  assert.deepEqual(ids('plugin/agents/playtester.md, a user-agent/1.0 header, .claude/agents/x'), [], 'agents/ folders and user-agent are not branch names');
  assert.deepEqual(scanOne('docs/potatoe-notes.md', B('fine'), { allow: [] }).map(h => h.kind), ['in the file\'s path']);
  assert.ok(DENY.length >= 8);
});

test('secrets and size are refused; an allow-list entry explains a hit, and only its own', () => {
  const key = 'sk-ant-' + 'a'.repeat(30);
  const lists = { allow: [{ file: 'tests/fixtures/', id: '*', why: 'test cases' }, { file: 'runtimes/forge/x.md', id: 'private reference game', why: 'a test entry' }] };
  assert.equal(scanOne('builder/lib/a.mjs', B(`const k = '${key}';`), lists)[0].allowed, null);
  assert.equal(scanOne('tests/fixtures/cases.json', B(`"${key}"`), lists)[0].allowed, 'allow');
  assert.equal(scanOne('runtimes/forge/x.md', B('like Dark Veil'), lists)[0].allowed, 'allow');
  assert.equal(scanOne('runtimes/forge/x.md', B('RTX 5090'), lists)[0].allowed, null, 'an entry covers only its own word');
  const big = Buffer.alloc(MAX_BYTES + 1);
  assert.equal(scanOne('runtimes/big.wasm', big, lists)[0].id, 'size');
});

test('a tree scan counts files and bytes, and reports allow-list entries that explain nothing', async t => {
  const d = await tempDir('gf-cut-');
  t.after(d.cleanup);
  await mkdir(path.join(d.dir, 'docs'), { recursive: true });
  await writeFile(path.join(d.dir, 'docs', 'a.md'), 'plain words');
  await writeFile(path.join(d.dir, 'docs', 'b.md'), 'built on an RTX 5090');
  const r = await scanTree(d.dir, { allow: [{ file: 'docs/a.md', id: 'home path', why: 'stale' }] });
  assert.equal(r.files, 2);
  assert.equal(r.refused.length, 1);
  assert.equal(r.refused[0].file, 'docs/b.md');
  assert.deepEqual(r.unusedAllow.map(a => a.file), ['docs/a.md']);
});

test('the cut never writes into a folder that is not empty, and its next steps never push without the owner', async t => {
  const d = await tempDir('gf-cut-');
  t.after(d.cleanup);
  await writeFile(path.join(d.dir, 'keep.txt'), 'mine');
  await assert.rejects(cut({ out: d.dir, log: () => {} }), /not empty/);
  const steps = nextSteps('/x/xgames-kit').join('\n');
  assert.match(steps, /gh repo create anthonyvicenti\/xgames-kit --private/);
  assert.match(steps, /--visibility public/);
});
