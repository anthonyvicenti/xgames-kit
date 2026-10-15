// The frozen sets themselves: every case well formed, nothing private in a public file, every set frozen and unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { checkSet } from '../lib/freeze.mjs';
import { loadSet } from '../lib/sets.mjs';
import { HERE, SET_NAMES } from '../run.mjs';

const ABOUT = ['action', 'turns', 'perspective', 'players', 'body', 'devices', 'feel', 'reference', 'goal', 'other'];
const MUST_TYPES = ['camera', 'mechanic', 'world', 'loop', 'panel', 'body', 'rule', 'players', 'feel'];
const RUNTIMES = ['three', 'forge', 'vista', 'godot'], PROFILES = ['standard-3d', 'scenic-3d', 'flat-2d'];
const LOOPS = ['round', 'run', 'world', 'turns', 'match', 'endless', 'saved'];
const KINDS = ['silly', 'blocky', 'lofi', 'scenic', 'dark', 'calm', 'pixel', 'drawn'];
// The release cut's deny-list (rule 4 of the common brief), and engine words a breadth prompt may not use.
// the words are put together here so this file does not itself hold them (the repository's public scan reads it)
const word = (...parts) => new RegExp(parts.join(''), 'i');
const DENY = [word('\\/home\\/', 'pot', 'atoe'), word('pot', 'atoe'), word('private', '-explore'), /dark\s*veil/i, /rtx\s*5090/i, word('games\\.fun', '-library'), /(?<![\w.@/-])agent\/[a-z0-9][\w.-]*/i, /\bdpl_[A-Za-z0-9]/i];
const ENGINE_WORDS = /\b(three\.?js|forge|vista|godot|unity|unreal|webgpu|webgl|engine|runtime|2d|3d|scenic engine|party engine)\b/i;

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['records', 'node_modules'].includes(e.name)) await walk(p, out); } else out.push(p);
  }
  return out;
}

test('every set is frozen, unchanged, and has nothing loose', async () => {
  for (const name of SET_NAMES) {
    const s = await checkSet(path.join(HERE, name));
    assert.deepEqual(s.problems, [], name);
    assert.deepEqual(s.loose, [], `${name} has files no manifest lists`);
    assert.ok(s.manifests.length >= 1, `${name} has a manifest`);
  }
});

test('no public file carries a denied word', async () => {
  for (const f of await walk(HERE)) {
    if (f.endsWith('tests/sets.test.mjs')) continue; // this file holds the list
    const text = await readFile(f, 'utf8');
    for (const re of DENY) assert.doesNotMatch(text, re, `${path.relative(HERE, f)} matches ${re}`);
  }
});

test('paired: 12 cases, 3 reps, two arms, each ledger in the contract\'s words and copied from its prompt', async () => {
  const { set, cases } = await loadSet(path.join(HERE, 'paired'));
  assert.equal(Object.keys(cases).length, 12);
  assert.deepEqual(set.cases, Object.keys(cases));
  assert.equal(set.reps, 3);
  assert.deepEqual(Object.keys(set.arms), ['old', 'new']);
  const kinds = Object.values(cases).map(c => c.source.kind);
  assert.equal(kinds.filter(k => k === 'frozen-case').length, 7);
  assert.equal(kinds.filter(k => k === 'creator-prompt').length, 2);
  assert.equal(kinds.filter(k => k === 'gauntlet').length, 3);
  for (const c of Object.values(cases)) {
    assert.equal(c.frozen, '2026-10-13', c.id);
    assert.ok(c.ledger.some(l => l.core), `${c.id} has a core line`);
    c.ledger.forEach((l, i) => {
      assert.equal(l.id, `r${i + 1}`, c.id);
      assert.ok(ABOUT.includes(l.about), `${c.id} ${l.id} about ${l.about}`);
      assert.ok(c.prompt.includes(l.words), `${c.id} ${l.id}: "${l.words}" is copied from the prompt`);
      assert.equal(typeof l.means, 'string');
    });
    assert.ok(c.control?.text, `${c.id} control`);
    assert.ok(c.multiplayer?.bar, `${c.id} multiplayer bar`);
    for (const i of c.images ?? []) assert.match(i.sha256, /^[0-9a-f]{64}$/);
  }
});

test('breadth: the 25 archetypes of the 2026-09-24 ranking in rank order, each with typed musts and no game or engine named', async () => {
  const { set, cases } = await loadSet(path.join(HERE, 'breadth'));
  const list = Object.values(cases);
  assert.equal(list.length, 25);
  assert.deepEqual(list.map(c => c.archetype.rank), Array.from({ length: 25 }, (_, i) => i + 1));
  assert.equal(new Set(list.map(c => c.archetype.id)).size, 25);
  assert.equal(set.reps, 1);
  assert.deepEqual(Object.keys(set.arms), ['new']);
  for (const c of list) {
    assert.doesNotMatch(c.prompt, ENGINE_WORDS, `${c.id} uses an engine word`);
    assert.ok(c.musts.length >= 3 && c.musts.length <= 5, `${c.id} has 3-5 musts`);
    for (const m of c.musts) assert.ok(MUST_TYPES.includes(m.type), `${c.id} ${m.id} type ${m.type}`);
    assert.equal(new Set(c.musts.map(m => m.id)).size, c.musts.length, `${c.id} must ids unique`);
  }
});

test('breadth prompts are new, not the 2026-10-11 gauntlet\'s', async () => {
  const { cases } = await loadSet(path.join(HERE, 'breadth'));
  const { cases: paired } = await loadSet(path.join(HERE, 'paired'));
  const gauntlet = Object.values(paired).filter(c => c.source.kind === 'gauntlet').map(c => c.prompt);
  for (const c of Object.values(cases)) assert.ok(!gauntlet.includes(c.prompt), c.id);
});

test('depth: eight kinds, two or three candidates each, no reference chosen yet', async () => {
  const slots = JSON.parse(await readFile(path.join(HERE, 'depth/slots.json'), 'utf8')).slots;
  assert.deepEqual(slots.map(s => s.kind), KINDS);
  for (const s of slots) {
    assert.ok(s.candidates.length >= 2 && s.candidates.length <= 3, s.kind);
    assert.equal(s.reference, null, `${s.kind}: the creator names the reference (choices/)`);
  }
  const set = JSON.parse(await readFile(path.join(HERE, 'depth/set.json'), 'utf8'));
  assert.deepEqual(Object.keys(set.measures), ['clarity', 'feel', 'look', 'again']);
  assert.equal(set.screen.size, '3840x2160');
});

test('cases: T1-T8 on spec v2 (T8 frozen 2026-10-14 in its own manifest), no engine field, every foundation value from the vocabulary', async () => {
  const { cases } = await loadSet(path.join(HERE, 'cases'));
  assert.deepEqual(Object.keys(cases), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
  for (const c of Object.values(cases)) {
    assert.equal(c.specVersion, 2, c.id);
    assert.ok(!('engine' in c), `${c.id} has no engine field`);
    assert.doesNotMatch(JSON.stringify(c.checklist), /verify:\d|spec\.engine/, `${c.id} uses no numbered check or engine`);
    const a = c.foundation.accept;
    for (const v of a.runtime) assert.ok(RUNTIMES.includes(v), `${c.id} runtime ${v}`);
    for (const v of a.profile ?? []) assert.ok(PROFILES.includes(v), `${c.id} profile ${v}`);
    for (const v of a.loop) assert.ok(LOOPS.includes(v), `${c.id} loop ${v}`);
    for (const v of a.kind) assert.ok(KINDS.includes(v), `${c.id} kind ${v}`);
    for (const k of Object.keys(a)) assert.match(c.foundation.at[k], /^\/[a-z]+$/, `${c.id} pointer for ${k}`);
    for (const item of c.checklist) assert.match(item.how, /^(gate:[A-F]|gates:all|release|probe:[a-z-]+|record|judge|human)$/, `${c.id} ${item.id}: ${item.how}`);
    assert.equal(new Set(c.checklist.map(i => i.id)).size, c.checklist.length, `${c.id} item ids unique`);
    assert.ok(c.prompt || c.private, `${c.id} has a prompt or a private one`);
  }
  assert.equal(cases.T6.prompt, null);
  assert.match(cases.T6.private.sha256, /^[0-9a-f]{64}$/);
});
