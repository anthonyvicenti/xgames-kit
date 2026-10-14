// The economy tools (builder/mcp/tools/economy.mjs): behind the web3 switch, callable through the MCP server, their output on
// every fixture and eval reference, saving only what the checker passes, and the links that never sign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, loadTools, offered } from '../builder/mcp/server.mjs';
import * as economy from '../builder/mcp/tools/economy.mjs';
import { CASES } from '../builder/web3/economy/evals/score.mjs';
import { fixture, fixtureNames, NOW } from './economy/helpers.mjs';
import { tempDir } from './helpers.mjs';

const NAMES = ['economy_catalog', 'economy_examples', 'economy_check', 'economy_simulate', 'economy_cost', 'economy_explain', 'economy_save', 'economy_publish', 'economy_status', 'economy_decide'];
const by = Object.fromEntries(economy.tools.map((t) => [t.name, t]));
const ctx = (extra = {}) => ({ now: NOW, log: () => {}, progress: () => {}, env: {}, ...extra });
const call = (name, args = {}, extra) => by[name].handler(args, ctx(extra));
const ALL = [...fixtureNames(), ...CASES.filter((c) => !c.reference.startsWith('fixtures/')).map((c) => c.id)];

/** A scratch kit root with one game folder in it. → { root, game, rel, cleanup } */
async function scratchGame(t, config) {
  const d = await tempDir('gf-econ-tools-');
  t.after(d.cleanup);
  const game = path.join(d.dir, 'games', 'arena');
  await import('node:fs/promises').then((fs) => fs.mkdir(game, { recursive: true }));
  await writeFile(path.join(game, 'index.html'), '<!doctype html><title>arena</title>');
  if (config) await writeFile(path.join(game, 'gamesfun.json'), `${JSON.stringify(config, null, 2)}\n`);
  return { root: d.dir, game, rel: 'games/arena' };
}

async function listed(env) {
  const { server } = await createServer({ log: () => {}, env });
  const [a, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(a), client.connect(c)]);
  return client;
}

test('the economy tools sit behind the web3 switch', async () => {
  const { tools: all } = await loadTools();
  for (const n of NAMES) assert.ok(all.has(n), n);
  assert.equal(offered('economy_check', {}), true, 'web3 is on by default (2026-10-12)');
  assert.equal(offered('economy_check', { GAMESFUN_WEB3: '0' }), false);
  const off = await listed({ GAMESFUN_WEB3: '0' });
  const on = await listed({});
  try {
    assert.deepEqual((await off.listTools()).tools.filter((x) => x.name.startsWith('economy_')), []);
    const tools = (await on.listTools()).tools.filter((x) => x.name.startsWith('economy_'));
    assert.deepEqual(tools.map((x) => x.name).sort(), [...NAMES].sort());
    for (const x of tools) {
      assert.ok(x.description.length > 120, `${x.name} says when to use it`);
      // economy_save writes gamesfun.json; economy_publish leaves a request for the studio page (never signs): neither is read-only
      assert.equal(x.annotations?.readOnlyHint, !['economy_save', 'economy_publish'].includes(x.name), `${x.name} read-only hint`);
    }
  } finally {
    await off.close();
    await on.close();
  }
});

test('the tools answer through the MCP server', async () => {
  const client = await listed({ GAMESFUN_WEB3: '1' });
  try {
    const r = await client.callTool({ name: 'economy_check', arguments: { example: 'coin-flip-arena' } });
    assert.ok(!r.isError, r.content[0].text);
    const body = JSON.parse(r.content[0].text);
    assert.equal(body.ok, true);
    assert.ok(body.warnings.some((w) => w.code === 'W-CHANCE-PRIZE'));
    const cat = JSON.parse((await client.callTool({ name: 'economy_catalog', arguments: { part: 'recipes' } })).content[0].text);
    assert.equal(cat.parts[0].part, 'recipes');
    const bad = await client.callTool({ name: 'economy_decide', arguments: {} });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /decision is required/);
    const unknown = await client.callTool({ name: 'economy_examples', arguments: { name: 'nope' } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /economy_examples lists them/);
  } finally {
    await client.close();
  }
});

test('the catalog covers every part of the schema, with its fields', async () => {
  const { SCHEMA } = await import('../builder/web3/economy/validate.mjs');
  const r = await call('economy_catalog');
  const parts = r.parts.map((p) => p.part);
  for (const k of Object.keys(SCHEMA.properties).filter((k) => !['version', 'network', 'name', 'prompt', 'live', 'previous'].includes(k))) assert.ok(parts.includes(k), k);
  const boxes = r.parts.find((p) => p.part === 'boxes');
  assert.ok(boxes.fields.some((f) => f.name === 'outcomes' && f.required));
  assert.ok(boxes.nested.some((n) => n.name === 'outcome' && n.fields.some((f) => f.name === 'gives')));
  assert.match(r.text, /USDC-dev: \{ "key": "usdc", "source": "existing"/);
  assert.match(r.text, /0\.002 SOL player fee/);
  assert.ok(r.conventions.length >= 5);
});

test('the examples: every fixture and reference, the whole spec by name, and a search', async () => {
  const list = await call('economy_examples');
  assert.equal(list.examples.length, ALL.length);
  assert.equal(list.ideas.count, 100);
  for (const name of ALL) {
    const ex = await call('economy_examples', { name });
    assert.equal(ex.checks, 'clean', name);
    assert.equal(ex.spec.version, 1);
  }
  const plinko = await call('economy_examples', { query: 'plinko' });
  assert.equal(plinko.examples[0].name, 'e16-plinko');
  assert.equal(plinko.ideas[0].n, 62);
  assert.equal(plinko.ideas[0].startFrom, 'e16-plinko');
  const gap = await call('economy_examples', { query: 'auction', fit: 'Gap' });
  assert.ok(gap.ideas.every((i) => i.fit === 'Gap'));
  assert.ok(gap.ideas.some((i) => i.n === 91 && /cannot do the core/.test(i.note)));
});

test('check, simulate, cost and explain on every fixture and eval reference', async () => {
  const authority = new Set(['duel-arena', 'scorched-treasury', 'level-ladder', 'e15-level-ladder', 'e19-weekly-ladder']);
  for (const name of ALL) {
    const c = await call('economy_check', { example: name });
    assert.equal(c.ok, true, `${name}: ${c.text}`);
    const s = await call('economy_simulate', { example: name });
    assert.equal(s.ok, true, name);
    assert.ok(s.text.length > 40 && Array.isArray(s.summary.pools), name);
    const k = await call('economy_cost', { example: name });
    assert.equal(k.ok, true, name);
    assert.ok(k.setup.totalSol > 0 && k.setup.transactions >= 1, name);
    assert.match(k.text, /Going live takes/);
    const e = await call('economy_explain', { example: name });
    assert.equal(e.ok, true, name);
    assert.match(e.text, /What setting it up costs/, name);
    assert.doesNotMatch(e.text, /undefined|NaN/, name);
    assert.equal(e.chance, c.warnings.some((w) => w.code === 'W-CHANCE-PRIZE'), `${name}: chance is flagged exactly when the checker warns`);
    if (e.chance) assert.match(e.text, /Chance that pays money \(flagged\)/, name);
    assert.equal(e.needsAuthority, authority.has(name), `${name}: needs the authority`);
    assert.equal((await call('economy_explain', { example: name })).text, e.text, `${name}: the same words every time`);
  }
  const flip = await call('economy_explain', { example: 'coin-flip-arena' });
  assert.match(flip.text, /Open “Coin flip”: 0\.1 SOL \+ 0\.002 SOL player fee \+ 0\.0005 SOL to MagicBlock’s oracle for the roll \(0\.10251 SOL in all with the network fee\); gives back 0\.088 SOL on average \(88% of its price/);
  assert.match(flip.text, /plus 2\.22 SOL in player fees and 0\.5 SOL to MagicBlock’s oracle/);
  assert.match(flip.text, /anyone can ask for the draw \(0\.0005 SOL to the oracle\) and pay the places/);
  assert.match(flip.text, /88% to the pool “house”, 10% to the pool “pot”, 2% to the pool “backers”/);
  assert.match(flip.text, /About 5\.01\d+ SOL in all/);
});

test('a spec with refusals is refused by every tool that reads numbers, with each fix', async () => {
  const spec = fixture('coin-flip-arena');
  spec.boxes[0].outcomes[1].chance = 40;
  const c = await call('economy_check', { spec });
  assert.equal(c.ok, false);
  assert.ok(c.refusals.every((r) => r.code && r.fix));
  for (const name of ['economy_simulate', 'economy_cost', 'economy_explain']) {
    const r = await call(name, { spec });
    assert.equal(r.ok, false, name);
    assert.ok(r.refusals.length, name);
  }
  const s = await call('economy_simulate', { spec: fixture('coin-flip-arena'), scenario: { perDay: { 'box:flip': 10 } } });
  assert.match(s.text, /10 × box:flip/);
  assert.match(s.text, /100 × lottery:weekly/, 'the rest of the scenario stays');
});

test('economy_save writes only a spec the checker passes, keeps the rest of gamesfun.json, and keeps what is live', async (t) => {
  const g = await scratchGame(t, { version: 1, network: 'devnet', creator: '9YwNxYMHHbJX3977FWspv5mkhFJ3AUd96bTEV6CzYpxq' });
  const k = { kitRoot: g.root };
  const read = async () => JSON.parse(await readFile(path.join(g.game, 'gamesfun.json'), 'utf8'));

  const broken = fixture('coin-flip-arena');
  broken.lotteries[0].pot = 'nowhere';
  let r = await call('economy_save', { game: g.rel, spec: broken }, k);
  assert.equal(r.saved, false);
  assert.ok(r.refusals.some((x) => x.code === 'E-REF'));
  assert.equal((await read()).economy, undefined, 'nothing written');

  const secret = fixture('coin-flip-arena');
  secret.name = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  r = await call('economy_save', { game: g.rel, spec: secret }, k);
  assert.equal(r.saved, false);
  assert.equal(r.refusals[0].code, 'E-SECRET');

  r = await call('economy_save', { game: g.rel, spec: { version: 1, network: 'devnet', economy: fixture('coin-flip-arena') } }, k);
  assert.equal(r.saved, true, r.text);
  let file = await read();
  assert.equal(file.creator, '9YwNxYMHHbJX3977FWspv5mkhFJ3AUd96bTEV6CzYpxq', 'the rest of the file stays');
  assert.equal(file.economy.name, 'Coin-flip arena');
  assert.equal((await call('economy_check', { game: g.rel }, k)).ok, true, 'the tools read it back from the game');

  // live: parts keep their ids, the live addresses stay, and the program's fixed parts are refused
  const live = { ...fixture('coin-flip-arena'), pools: fixture('coin-flip-arena').pools.map((p, i) => ({ ...p, index: i })), boxes: [{ ...fixture('coin-flip-arena').boxes[0], id: 1 }], stakes: [{ ...fixture('coin-flip-arena').stakes[0], id: 1 }], lotteries: [{ ...fixture('coin-flip-arena').lotteries[0], id: 1 }], live: { game: '9YwNxYMHHbJX3977FWspv5mkhFJ3AUd96bTEV6CzYpxq', at: '2026-10-11' } };
  await writeFile(path.join(g.game, 'gamesfun.json'), JSON.stringify({ ...file, economy: live }));
  const cheaper = fixture('coin-flip-arena');
  cheaper.boxes[0].price = 0.2;
  cheaper.boxes[0].outcomes[0].amount = 0.352;
  r = await call('economy_save', { game: g.rel, spec: cheaper }, k);
  assert.equal(r.saved, true, r.text);
  assert.equal(r.live, true);
  file = await read();
  assert.equal(file.economy.live.game, live.live.game);
  assert.equal(file.economy.boxes[0].id, 1);
  assert.deepEqual(file.economy.pools.map((p) => p.index), [0, 1, 2]);
  const restake = fixture('coin-flip-arena');
  restake.stakes[0].lock = '7d';
  r = await call('economy_save', { game: g.rel, spec: restake }, k);
  assert.equal(r.saved, false);
  assert.ok(r.refusals.some((x) => x.code === 'E-STAKE-FIXED'));
});

test('economy_save asks for an old shop to be moved first', async (t) => {
  const g = await scratchGame(t, { version: 1, network: 'devnet', shop: { name: 'Old', currency: { kind: 'sol' }, items: [], boxes: [] } });
  const r = await call('economy_save', { game: g.rel, spec: fixture('coin-flip-arena') }, { kitRoot: g.root });
  assert.equal(r.saved, false);
  assert.equal(r.refusals[0].code, 'E-SHOP');
  assert.match(r.refusals[0].fix, /the studio's Economy tab/);
  await assert.rejects(() => call('economy_check', { game: g.rel }, { kitRoot: g.root }), /has a shop and no economy yet/);
});

test('economy_publish returns the studio link for the economy flow and signs nothing', async (t) => {
  const g = await scratchGame(t, { version: 1, network: 'devnet', economy: fixture('coin-flip-arena') });
  let r = await call('economy_publish', { game: g.rel }, { kitRoot: g.root, env: { GAMESFUN_DEV_URL: 'http://127.0.0.1:5999/' } });
  assert.equal(r.ok, true);
  assert.equal(r.approve.flow, 'economy');
  assert.equal(r.approve.link, 'http://127.0.0.1:5999/studio/#economy?flow=economy');
  assert.match(r.approve.step, /Put it live/);
  assert.match(r.text, /Nothing is signed until they approve it in their wallet/);
  assert.ok(r.cost.totalSol > 5, 'the seed is counted');
  r = await call('economy_publish', { game: g.rel }, { kitRoot: g.root });
  assert.equal(r.approve.link, null);
  assert.match(r.text, /npx gamesfun dev games\/arena/);
  const broken = fixture('coin-flip-arena');
  broken.stakes[0].rewards = 'pot';
  await writeFile(path.join(g.game, 'gamesfun.json'), JSON.stringify({ version: 1, network: 'devnet', economy: broken }));
  r = await call('economy_publish', { game: g.rel }, { kitRoot: g.root });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.length);
});

test('economy_status says plainly when the chain reader is not there, and formats it when it is', async (t) => {
  const g = await scratchGame(t, { version: 1, network: 'devnet', economy: fixture('coin-flip-arena') });
  t.after(() => { economy.seams.status = undefined; });
  economy.seams.status = null;
  let r = await call('economy_status', { game: g.rel }, { kitRoot: g.root });
  assert.equal(r.available, false);
  assert.match(r.text, /not available yet/);
  const asked = [];
  economy.seams.status = async (dir, opts) => {
    asked.push([dir, opts.kitRoot]);
    return { live: true, program: '88Labq6tdVnBQsjHSfic6qqgvo5b9NGmy99AYj7KVXqM', game: 'Gam3', parts: [{ part: 'box', key: 'flip', onChain: true, address: 'B0x', differs: false }, { part: 'stake', key: 'backers', onChain: false, address: null, differs: false }], pools: [{ index: 0, mint: 'So11111111111111111111111111111111111111112', balance: '5' }], receipts: [{}, {}] };
  };
  r = await call('economy_status', { game: g.rel }, { kitRoot: g.root });
  assert.equal(r.available, true);
  assert.equal(r.live, true);
  assert.deepEqual(asked, [[g.game, g.root]]);
  assert.match(r.text, /is live on devnet \(game Gam3\)/);
  assert.match(r.text, /box “flip”: on chain/);
  assert.match(r.text, /stake “backers”: not on chain yet/);
  assert.match(r.text, /2 recent receipts/);
});

test('economy_decide prepares a decision link for the creator’s wallet (the Economy tab signs it)', async (t) => {
  const g = await scratchGame(t, { version: 1, network: 'devnet', economy: fixture('duel-arena') });
  const k = { kitRoot: g.root, env: { GAMESFUN_DEV_URL: 'http://127.0.0.1:5999/' } };
  let r = await call('economy_decide', { game: g.rel, decision: 'contest:duel', side: 1 }, k);
  assert.equal(r.link, 'http://127.0.0.1:5999/studio/#economy?decide=contest%3Aduel&side=1');
  assert.match(r.says, /Name side 1 \(Blue\) as the winner of “Duel”/);
  assert.equal(r.pending, undefined, 'the signing page exists now (K4)');
  assert.match(r.text, /Sign in my wallet/);
  assert.match(r.signer, /not the creator’s wallet/, 'a separate authority key is named, not the wallet');
  r = await call('economy_decide', { game: g.rel, decision: 'mission-loot', to: '4JaSvbECYUyqYjWoyBzAjYTfvaQxMBmXnKhyLHcoaGNE' }, k);
  assert.match(r.says, /Pay 2 USDC from the pool “mission-rewards” to 4JaS/);
  assert.match(r.link, /decide=mission-loot&to=4JaS.*&amount=2/);
  await assert.rejects(() => call('economy_decide', { game: g.rel, decision: 'contest:duel' }, k), /Say which side won/);
  await assert.rejects(() => call('economy_decide', { game: g.rel, decision: 'contest:duel', side: 2 }, k), /0 to 1/);
  await assert.rejects(() => call('economy_decide', { game: g.rel, decision: 'nope' }, k), /It has: open-duel, duel-result, mission-end, mission-loot, contest:duel, hold:mission/);
  await assert.rejects(() => call('economy_decide', { game: g.rel, decision: 'mission-loot', to: 'not an address' }, k), /public address/);
  r = await call('economy_decide', { game: g.rel, decision: 'contest:duel', open: true }, k);
  assert.equal(r.link, 'http://127.0.0.1:5999/studio/#economy?decide=contest%3Aduel&open=1');
  assert.match(r.says, /Open a new round of “Duel”/);
  r = await call('economy_decide', { game: g.rel, decision: 'mission-loot', to: '4JaSvbECYUyqYjWoyBzAjYTfvaQxMBmXnKhyLHcoaGNE', id: 'run-7', attempt: '5'.repeat(87) }, k);
  assert.match(r.link, /&attempt=5{87}&id=run-7/);
});
