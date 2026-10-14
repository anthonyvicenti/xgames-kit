// The example games (examples/minimal/*) hold to what their own spec says. No browser: these read the spec and run
// each rules.js against a stand-in ctx. Each test names the mistake it was written for (2026-10-12 audit):
//   - giant-four read ctx.config.rules.need, but config holds rules.params.need: the rules.need slot did nothing
//   - coin-hop's spec had rules.params.coinPoints, which nothing read: a slot that did nothing
//   - soak-squad set the projectile's own tank (streamTank 20, streamRefill 0) and kept a second, bucket-filled tank in
//     rules.js: after about 20 s of spraying the stream stopped for good while the HUD still showed water
// tests/smoke.test.mjs plays every example in Chrome (GAMESFUN_SMOKE=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXAMPLES, RUNTIMES } from '../builder/lib/paths.mjs';

const ids = (await readdir(EXAMPLES, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
const specOf = async id => JSON.parse(await readFile(path.join(EXAMPLES, id, 'spec.json'), 'utf8'));
// A forge example's rules import the kit's copy in the game (`./gf/forge/feel.js`); here that is runtimes/forge/kit.
const GAME_COPIES = { './gf/forge/': pathToFileURL(path.join(RUNTIMES, 'forge', 'kit') + path.sep).href };
async function rulesOf(id) {
  const file = path.join(EXAMPLES, id, 'rules.js');
  let text = await readFile(file, 'utf8');
  if (!Object.keys(GAME_COPIES).some(k => text.includes(`'${k}`))) return (await import(pathToFileURL(file).href)).default;
  for (const [from, to] of Object.entries(GAME_COPIES)) text = text.replaceAll(`from '${from}`, `from '${to}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)).default;
}

// A stand-in for anything the rules reach that this test does not look at: callable, any property, never a promise.
const anything = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => 0 : anything), apply: () => anything, construct: () => anything });
/** A ctx whose config is the spec's rules (as create writes them into config/game.json), with every read recorded. */
function standIn(spec, more = {}) {
  const reads = { rules: new Set(), params: new Set() };
  const params = new Proxy({ ...(spec.rules?.params ?? {}) }, { get: (t, k) => { if (typeof k === 'string') reads.params.add(k); return t[k]; } });
  const rules = new Proxy({ summary: spec.rules?.summary, scoring: spec.rules?.scoring, params }, { get: (t, k) => { if (typeof k === 'string') reads.rules.add(k); return t[k]; } });
  const own = { config: { rules }, host: true, rng: () => 0.5, ...more };
  const ctx = new Proxy(own, { get: (t, k) => (k in t ? t[k] : anything), set: (t, k, v) => { t[k] = v; return true; } });
  return { ctx, reads };
}

// a page's address, which a forge example's rules read for their test hooks (?qa=1, ?room=1; never on for a player)
globalThis.location ??= new URL('http://127.0.0.1/');

test('every example reads its tuning numbers from rules.params, and every number the spec names is read', async () => {
  assert.ok(ids.length >= 4, 'the examples are found');
  for (const id of ids) {
    const spec = await specOf(id), rules = await rulesOf(id);
    const { ctx, reads } = standIn(spec, { round: { phase: 'playing', end() {} } });
    await rules.setup?.(ctx);
    // a number read when an event arrives (a forge game's `wave-clear` mends): each event name the rules compare, once
    const text = await readFile(path.join(EXAMPLES, id, 'rules.js'), 'utf8');
    for (const [, name] of text.matchAll(/\bname === '([a-z][a-z0-9-]*)'/g)) rules.event?.(ctx, name, {});
    const wrong = [...reads.rules].filter(k => !['params', 'summary', 'scoring'].includes(k));
    assert.deepEqual(wrong, [], `${id}: rules.js reads ctx.config.rules.${wrong[0]}, but config keeps the numbers in rules.params (read ctx.config.rules.params.${wrong[0]})`);
    const named = Object.keys(spec.rules?.params ?? {});
    const unread = named.filter(k => !reads.params.has(k));
    assert.deepEqual(unread, [], `${id}: the spec's rules.params.${unread[0]} becomes a rules.* slot, but rules.js never reads it, so the slot does nothing`);
    const unknown = [...reads.params].filter(k => !named.includes(k));
    assert.deepEqual(unknown, [], `${id}: rules.js reads rules.params.${unknown[0]}, which the spec does not name (no slot for it)`);
  }
});

test('giant-four: the rules.need slot decides how many in a row win', async () => {
  const spec = await specOf('giant-four'), rules = await rulesOf('giant-four');
  let given = null, asked = null;
  const board = { rules: r => { given = r; } };
  const { ctx } = standIn({ ...spec, rules: { ...spec.rules, params: { ...spec.rules.params, need: 3 } } }, { mechanics: { get: id => (id === 'board' ? board : anything) } });
  rules.setup(ctx);
  assert.ok(given?.winner, 'the board gets a winner rule');
  const win = given.winner({ last: [2, 0], line: (x, y, n) => { asked = n; return [[0, 0], [1, 0], [2, 0]]; }, owner: () => 0, full: () => false });
  assert.equal(asked, 3, 'the line it looks for is rules.need long');
  assert.equal(win.reason, '3 in a row');
});

test('one water tank: a stream whose own tank never refills stops for good, and rules that keep a tank must not have a second', async () => {
  for (const id of ids) {
    const spec = await specOf(id), text = await readFile(path.join(EXAMPLES, id, 'rules.js'), 'utf8');
    for (const m of (spec.mechanics ?? []).filter(x => x.id === 'projectile' && x.params?.kind === 'continuous')) {
      const tank = m.params.streamTank ?? 0, refill = m.params.streamRefill ?? 0.4;     // the mechanic's defaults (kit/mechanics/projectile)
      // the kit's tank has no refill call: with streamRefill 0 nothing ever fills it again
      assert.ok(!(tank > 0 && refill <= 0), `${id}: the projectile's own tank (streamTank ${tank}) never refills (streamRefill ${refill}), so the stream stops for good after ${tank} s of spraying`);
      // a tank of the game's own (p.data.tank, its own meter) beside the kit's: the kit's runs dry while the HUD shows the game's
      assert.ok(!(tank > 0 && /\.data\.tank\b/.test(text)), `${id}: rules.js keeps its own tank and the projectile has its own too (streamTank ${tank}): keep one (drop streamTank from the spec)`);
    }
  }
});

test('soak-squad: the stream still runs after 30 s of spraying, refilled by buckets', async () => {
  // the rules' own loop, with a stand-in projectile that has the kit's tank logic (kit/mechanics/projectile, stream())
  const spec = await specOf('soak-squad'), rules = await rulesOf('soak-squad');
  const prj = spec.mechanics.find(m => m.id === 'projectile').params;
  const T = prj.streamTank ?? 0, refillRate = prj.streamRefill ?? 0.4;
  let kitTank = 1, dt = 1 / 30, collect = null;
  const projectile = { onHit() {}, stream(p, on) { const want = on && (T <= 0 || kitTank > 0.001); if (T > 0) kitTank = want ? Math.max(0, kitTank - dt / T) : Math.min(1, kitTank + dt * refillRate); return want; } };
  const pickup = { onCollect: f => { collect = f; }, nearest: () => null };
  const me = { id: 'me', local: true, owned: true, data: {}, actions: { primary: { down: true } }, position: { x: 0, y: 0, z: 0 } };
  const { ctx } = standIn(spec, {
    mechanics: { get: id => (id === 'projectile' ? projectile : id === 'pickup' ? pickup : anything) },
    players: { owned: () => [me], list: () => [me] }, me, round: { phase: 'playing' }, time: { now: 0 },
  });
  rules.setup(ctx);
  rules.roundStart(ctx);
  let sprayedAt = [];
  for (let t = 0; t < 40; t += dt) {
    if (Math.abs(t % 8) < dt && t > 0) collect({ player: me });          // a bucket every 8 s, as a player who keeps grabbing them
    rules.update(ctx, dt);
    if (me.data.spraying) sprayedAt.push(t);
  }
  assert.ok(sprayedAt.some(t => t >= 30), `the stream still runs at 30 s and after (last spray at ${sprayedAt.at(-1)?.toFixed(1)} s)`);
});
