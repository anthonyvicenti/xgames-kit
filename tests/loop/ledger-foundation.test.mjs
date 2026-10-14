// The requirements ledger and the foundation.   node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAnswers, checkAmend, checkLedger, chooseFoundation, diffLedger, ledgerView, migrationOf, rehomeLedger, resolveProbes } from '../../builder/loop/index.mjs';
import { fakeRegistry, goodLedger, PROMPT } from './fixtures/registry.mjs';

const reg = fakeRegistry();
const check = (l, sources = [PROMPT]) => checkLedger(l, { sources, registry: reg });
const line = (l, id) => l.rows.find(x => x.id === id);

test('a ledger in the person\'s words passes', async () => {
  assert.deepEqual(await check(goodLedger()), []);
});

test('a line not in the person\'s words is refused, and so is a line with no home', async () => {
  const l = goodLedger();
  line(l, 'boss').words = 'an epic final boss';
  line(l, 'waves').home = 'maybe';
  const p = await check(l);
  assert.ok(p.some(x => /rows\[2\]\.words: .* is not the person's words/.test(x)));
  assert.ok(p.some(x => /rows\[1\]\.home: one of the words "exists", "build" or "probe"$/.test(x)));
  line(l, 'waves').home = { exists: true, by: 'mechanic:waves' };
  assert.ok((await check(l)).some(x => /rows\[1\]\.home: .* \(a word, not an object: by, how, where and probe are fields of the line itself\)/.test(x)), 'found by the PA11 re-run');
});

test('the person is asked only how friends play and what a player is, and only what their words leave open', async () => {
  const l = goodLedger();
  l.asks = [{ about: 'feel', text: 'Grim?', options: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }], default: 'a' }];
  assert.ok((await check(l)).some(x => /asks\[0\]\.about: the person is asked only players or body/.test(x)));
  const settled = goodLedger();
  settled.asks = [{ about: 'players', text: 'Together or against?', options: [{ id: 'coop', label: 'Together' }, { id: 'versus', label: 'Against' }], default: 'coop' }];
  assert.ok((await check(settled)).some(x => /the players line quotes the person .* and is not marked asked\. When their words settle .* drop this question; when they leave part of it open .* set asked: true/.test(x)), 'the problem says both ways out (found by the PA11 build: the ledger round went back and forth)');
  // their words, and still a part of it open (a board game: what a player is, not how each is shown): asked, with the words kept
  line(settled, 'friends').asked = true;
  assert.deepEqual(await check(settled), []);
  // words that leave it open: asked, with a default, and the answer becomes the line's
  const open = goodLedger();
  Object.assign(line(open, 'friends'), { words: null, asked: true });
  open.asks = settled.asks;
  assert.deepEqual(await check(open), []);
  const answered = applyAnswers(open, { players: 'versus' }, { words: 'against each other' });
  assert.equal(line(answered, 'friends').together, 'versus');
  assert.deepEqual(await check(answered, [PROMPT, 'against each other']), []);
});

test('a character needs no question; a missing essential is named', async () => {
  const l = goodLedger();
  l.rows = l.rows.filter(x => x.about !== 'acts');
  assert.ok((await check(l)).some(x => /no "acts" line/.test(x)));
});

test('build lines say what will be written; probes are bounded', async () => {
  const l = goodLedger();
  Object.assign(line(l, 'hook'), { how: 'somehow', where: 'elsewhere' });
  Object.assign(line(l, 'boss'), { home: 'probe', probe: { question: 'can it?', minutes: 90 } });
  const p = await check(l);
  assert.ok(p.some(x => /rows\[3\]\.how/.test(x)) && p.some(x => /rows\[3\]\.where/.test(x)) && p.some(x => /probe\.minutes: a bound/.test(x)));
});

test('an amended ledger never drops a line; only the person\'s words cut one', async () => {
  const before = goodLedger(), after = goodLedger();
  after.rows = after.rows.filter(x => x.id !== 'boss');
  assert.ok((await checkAmend(before, after, { sources: [PROMPT], registry: reg })).some(x => /"boss" is gone/.test(x)));
  const cut = goodLedger();
  line(cut, 'boss').cut = { words: 'no boss please' };
  assert.ok((await checkAmend(before, cut, { sources: [PROMPT], registry: reg })).some(x => /cut only by the person's own words/.test(x)));
  assert.deepEqual(await checkAmend(before, cut, { sources: [PROMPT, 'drop it, no boss please'], registry: reg }), []);
  assert.deepEqual(diffLedger(before, cut).cut, ['boss']);
  assert.equal(ledgerView(cut).lines.find(x => x.id === 'boss').home, 'cut');
});

test('the foundation: hard limits choose the runtime, who acts when the loop, the feel line the kind', async () => {
  const f = await chooseFoundation(goodLedger(), reg);
  assert.equal(f.ok, true);
  assert.deepEqual([f.runtime, f.profile, f.loop, f.kind], ['forge', null, 'run', 'dark']);
  assert.deepEqual(f.builds.map(b => b.capability), ['grappling-hook']);
  assert.ok(f.said.some(s => /phones first/.test(s)));
});

test('no word of the idea routes anything: the same lines under other words give the same foundation', async () => {
  const silly = goodLedger();
  const a = await chooseFoundation(silly, reg);
  const b = await chooseFoundation(structuredClone(silly), reg);     // the prompt is not even an input
  for (const k of ['runtime', 'profile', 'loop', 'kind']) assert.equal(a[k], b[k]);
  // change only the structured limits and the runtime moves
  const desk = goodLedger();
  Object.assign(line(desk, 'view'), { camera: 'third', needs: [] });
  const c = await chooseFoundation(desk, reg);
  assert.equal(c.runtime, 'three');
});

test('photoreal said: the default devices yield and the foundation says so', async () => {
  const l = goodLedger();
  l.rows = l.rows.filter(x => x.id !== 'phone');
  Object.assign(line(l, 'view'), { camera: 'third', needs: [] });
  Object.assign(line(l, 'feel'), { graphics: 'photoreal', kind: 'calm' });
  const f = await chooseFoundation(l, reg);
  assert.equal(f.runtime, 'vista');
  assert.ok(f.said.some(s => /default devices .* yield/.test(s)));
});

test('a loop that is not open is built on the closest one; a kind not proven on the runtime is proven by the game', async () => {
  const l = goodLedger();
  Object.assign(line(l, 'acts'), { acts: 'progress-kept' });
  let f = await chooseFoundation(l, reg);
  assert.equal(f.ok, false);
  assert.ok(f.problems.some(p => /builds it on "world"/.test(p)));
  Object.assign(line(l, 'acts'), { home: 'build', how: 'a module in src/save.js that keeps progress', where: 'module' });
  f = await chooseFoundation(l, reg);
  assert.equal(f.loop, 'world');
  assert.equal(f.loopBuild.wants, 'saved');
  const calm = goodLedger();
  line(calm, 'feel').kind = 'calm';
  f = await chooseFoundation(calm, reg);
  assert.equal(f.runtime, 'forge');                       // the kind never moves the runtime
  assert.deepEqual(f.kindProof, { kind: 'calm', runtime: 'forge', profile: null });
});

test('probes come first, and their results give the line its home', async () => {
  const l = goodLedger();
  Object.assign(line(l, 'hook'), { home: 'probe', probe: { question: 'can it pull?', minutes: 10 } });
  const f = await chooseFoundation(l, reg);
  assert.deepEqual(f.probes.map(p => p.row), ['hook']);
  const r = resolveProbes(l, [{ row: 'hook', home: 'build', evidence: 'probe.txt', how: 'a module in src/hook.js', where: 'module' }]);
  assert.deepEqual(r.problems, []);
  assert.equal(line(r.ledger, 'hook').home, 'build');
});

test('a mechanic with no implementation on the runtime becomes a build line; a migration names its consequences', async () => {
  const l = goodLedger();
  l.rows = l.rows.filter(x => x.id !== 'phone');
  Object.assign(line(l, 'view'), { camera: 'third', needs: [] });
  Object.assign(line(l, 'feel'), { graphics: 'photoreal', kind: 'calm' });
  const f = await chooseFoundation(l, reg);
  const r = rehomeLedger(l, f);
  assert.equal(line(r, 'waves').home, 'build');
  const before = await chooseFoundation(goodLedger(), reg);
  const m = await migrationOf(before, f, { spec: { mechanics: [{ id: 'waves' }] }, registry: reg, ownFiles: ['src/hook.js'] });
  assert.equal(m.to, 'vista');
  assert.deepEqual(m.devices.lost, ['phone']);
  assert.ok(m.consequences.some(c => /Rewritten: 1 file/.test(c)));
});

test('a change is classified by what changed in the ledger: tune, look, play, loop, runtime', async () => {
  const { classifyChange } = await import('../../builder/loop/index.mjs');
  const before = { ledger: goodLedger(), foundation: await chooseFoundation(goodLedger(), reg), spec: { mechanics: [] } };
  const cls = async edit => { const l = goodLedger(); edit(l); return (await classifyChange({ before, ledger: l, registry: reg })).class; };
  assert.equal(await cls(() => {}), 'tune');
  assert.equal(await cls(l => { line(l, 'feel').kind = 'lofi'; }), 'look');
  assert.equal(await cls(l => { line(l, 'boss').what = 'Two bosses'; }), 'play');
  assert.equal(await cls(l => { Object.assign(line(l, 'acts'), { acts: 'until-you-fall' }); }), 'loop');
  assert.equal(await cls(l => { Object.assign(line(l, 'view'), { camera: 'top', needs: [] }); }), 'runtime');
});
