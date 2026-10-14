// The Economy tab's server side (builder/web3/node/economy-routes.mjs under /api/web3) and its pure helpers
// (builder/studio/tabs/web3/economy-parts.js): read and save the economy in gamesfun.json, a shop shown migrated, the checker,
// the quick simulation and the cost as the tab asks for them while the creator types, and the money flow as a graph.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { check } from '../builder/web3/economy/check.mjs';
import { keepLive, starterEconomy } from '../builder/web3/node/economy-routes.mjs';
import { SECTIONS, addPart, amountText, flowGraph, layoutFlow, notesByPart, parseAmount, parseDuration, parseNumber, partOfWhere, removePart, roundAmounts } from '../builder/studio/tabs/web3/economy-parts.js';
import { linkAsks } from '../builder/studio/tabs/economy.js';
import { makeGame, post, request, serve } from './web3/helpers.mjs';

const FIXTURES = new URL('../builder/web3/economy/fixtures/', import.meta.url);
const fixture = async (name) => JSON.parse(await readFile(new URL(`${name}.json`, FIXTURES), 'utf8'));
const servers = [];
async function gameWith(config) {
  const game = await makeGame({ config });
  const server = await serve({ gameDir: game.gameDir, kitRoot: game.kitRoot, env: {}, log: () => {} });
  servers.push(server);
  const file = path.join(game.gameDir, 'gamesfun.json');
  return { ...game, server, get: (p) => request(server.port, { path: `/api/web3${p}` }), post: (p, body) => post(server.port, p, body), saved: async () => JSON.parse(await readFile(file, 'utf8')), file };
}
after(async () => {
  for (const s of servers) await s.close();
});

const SHOP = {
  version: 1,
  network: 'devnet',
  shop: {
    name: 'Bean Brawl Shop',
    royaltyBps: 500,
    currency: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9, native: true },
    items: [{ id: 1, name: 'Golden Hat', rarity: 'Rare', price: '50000000', maxSupply: 0, picture: 'assets/hat.png' }, { id: 2, name: 'Ice Skin', rarity: 'Common', price: '0', maxSupply: 0 }],
    boxes: [{ id: 1, name: 'Mystery Box', price: '10000000', entries: [{ item: 1, weight: 1 }, { item: 2, weight: 9 }] }],
  },
};

describe('GET and POST /economy: the spec in gamesfun.json', () => {
  it('reads a saved economy as it is', async () => {
    const economy = await fixture('coin-flip-arena');
    const g = await gameWith({ version: 1, network: 'devnet', economy });
    const r = await g.get('/economy');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.source, 'economy');
    assert.deepEqual(r.json.economy, economy);
  });

  it('shows a game with only a shop as an economy, migrated, and saves it as one (the shop goes)', async () => {
    const g = await gameWith(SHOP);
    const r = await g.get('/economy');
    assert.equal(r.json.source, 'shop');
    assert.deepEqual(r.json.economy.items.map((i) => [i.key, i.price]), [['golden-hat', '0.05'], ['ice-skin', '0']]);
    assert.equal(r.json.economy.boxes[0].outcomes.length, 2);
    assert.match(r.json.notes.join(' '), /Moved 2 items and 1 box/);
    assert.ok(check(r.json.economy).ok, JSON.stringify(check(r.json.economy).refusals));
    assert.ok((await g.saved()).shop, 'reading never writes');
    const s = await g.post('/economy', { economy: r.json.economy });
    assert.equal(s.status, 200, s.text);
    const file = await g.saved();
    assert.equal(file.shop, undefined);
    assert.equal(file.economy.items[0].name, 'Golden Hat');
    assert.equal((await g.get('/economy')).json.source, 'economy');
  });

  it('starts a game with no web3 settings from SOL alone, named after the game', async () => {
    const g = await gameWith(null);
    const r = await g.get('/economy');
    assert.equal(r.json.source, 'new');
    assert.deepEqual(r.json.economy, starterEconomy('Bean Brawl'));
  });

  it('refuses to save what the schema does not take, a secret, or another network, and saves nothing then', async () => {
    const g = await gameWith(null);
    const bad = { ...starterEconomy('x'), boxes: [{ key: 'flip', name: 'Flip', price: 'cheap', outcomes: [{ gives: 'nothing', chance: 100 }] }] };
    const r = await g.post('/economy', { economy: bad });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /^Not saved: economy\.boxes\[0\]\.price/);
    const secret = await g.post('/economy', { economy: { ...starterEconomy('x'), name: Array.from({ length: 12 }, () => 'abandon').join(' ') } });
    assert.equal(secret.status, 400);
    assert.match(secret.json.error, /private key or a seed phrase/);
    assert.equal((await g.post('/economy', { economy: { ...starterEconomy('x'), network: 'mainnet-beta' } })).status, 400);
    assert.equal((await g.post('/economy', { nope: 1 })).status, 400);
    await assert.rejects(readFile(g.file, 'utf8'), /ENOENT/, 'nothing was written');
  });

  it('keeps program ids, pool indexes and live addresses a stale page leaves out', async () => {
    const economy = await fixture('coin-flip-arena');
    economy.pools[0].index = 0;
    economy.boxes[0].id = 7;
    economy.live = { game: '88Labq6tdVnBQsjHSfic6qqgvo5b9NGmy99AYj7KVXqM' };
    const g = await gameWith({ version: 1, network: 'devnet', economy });
    const stale = structuredClone(economy);
    delete stale.pools[0].index;
    delete stale.boxes[0].id;
    delete stale.live;
    stale.boxes[0].price = 0.2;
    assert.equal((await g.post('/economy', { economy: stale })).status, 200);
    const file = (await g.saved()).economy;
    assert.equal(file.boxes[0].price, 0.2);
    assert.equal(file.boxes[0].id, 7);
    assert.equal(file.pools[0].index, 0);
    assert.equal(file.live.game, economy.live.game);
    assert.deepEqual(keepLive(null, { a: 1 }), { a: 1 });
  });

  it('fills in the mint of a token launched from the tab, so the tab can save it', async () => {
    const economy = await fixture('coin-flip-arena');
    const token = { mint: '7MJWx2uKqiGHyhRsHjo8VPyskKUTRcH5ZUGPmDKX3vt9', name: 'Arena', symbol: 'ARENA', decimals: 6, program: 'spl-token', source: 'launched' };
    const g = await gameWith({ version: 1, network: 'devnet', token, economy });
    const r = await g.get('/economy');
    assert.equal(r.json.filled, true);
    assert.equal(r.json.economy.tokens.find((t) => t.key === 'arena').mint, token.mint);
  });

  it('keeps the web3 routes’ boundary: a save from another origin is refused', async () => {
    const g = await gameWith(null);
    const r = await request(g.server.port, { method: 'POST', path: '/api/web3/economy', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ economy: starterEconomy('x') }) });
    assert.equal(r.status, 403);
  });
});

describe('POST /economy/check, /simulate and /cost: what the tab shows beside the numbers', () => {
  it('answers for the spec it is sent (the page’s, as the creator types) or the saved one', async () => {
    const economy = await fixture('coin-flip-arena');
    const g = await gameWith({ version: 1, network: 'devnet', economy });
    const c = await g.post('/economy/check', {});
    assert.equal(c.json.ok, true);
    assert.ok(c.json.warnings.some((w) => w.code === 'W-CHANCE-PRIZE'));
    const s = await g.post('/economy/simulate', { economy });
    assert.equal(s.json.ok, true);
    assert.equal(s.json.boxes[0].returnPercent, 88);
    assert.equal(s.json.lotteries[0].potBeforeDraw, 77);
    const cost = await g.post('/economy/cost', { economy });
    assert.equal(cost.json.ok, true);
    assert.equal(cost.json.setup.approvals, 1);
    assert.ok(Math.abs(cost.json.setup.totalSol - 5.01687028) < 1e-6, String(cost.json.setup.totalSol));
  });

  it('a broken spec: refusals with their fixes, no numbers, and why', async () => {
    const economy = await fixture('coin-flip-arena');
    economy.boxes[0].outcomes[0].chance = 70;
    const g = await gameWith(null);
    const c = await g.post('/economy/check', { economy });
    assert.equal(c.json.ok, false);
    const odds = c.json.refusals.find((r) => r.code === 'E-ODDS');
    assert.ok(odds?.fix, JSON.stringify(c.json.refusals));
    economy.boxes[0].price = 'cheap';
    const s = await g.post('/economy/simulate', { economy });
    assert.equal(s.json.ok, false);
    assert.match(s.json.error, /notes marked ✗/);
    assert.equal((await g.post('/economy/cost', { economy })).json.ok, false);
  });

  it('every fixture checks, simulates and costs through the routes', async () => {
    const g = await gameWith(null);
    for (const f of (await readdir(FIXTURES)).filter((x) => x.endsWith('.json'))) {
      const economy = JSON.parse(await readFile(new URL(f, FIXTURES), 'utf8'));
      assert.equal((await g.post('/economy/check', { economy })).json.ok, true, f);
      assert.equal((await g.post('/economy/simulate', { economy })).json.ok, true, f);
      assert.equal((await g.post('/economy/cost', { economy })).json.ok, true, f);
    }
  });
});

describe('the tab’s parts (studio/tabs/web3/economy-parts.js)', () => {
  it('amountText: the one formatter for amounts people read (the tab and the host bridge)', () => {
    const cases = [
      ['0.368812502', '0.3688'], [0.368812502, '0.3688'], ['0.176', '0.176'], ['1.234000', '1.234'], ['0.00005', '0.0001'],
      ['0.000049', '<0.0001'], ['0.000001', '<0.0001'], [1e-9, '<0.0001'], ['0', '0'], [0, '0'], ['0.00000', '0'],
      ['1234.56789', '1,234.5679'], ['5', '5'], ['99.99995', '100'], ['-0.00001', '-<0.0001'], ['-2.5', '-2.5'],
      ['5000000000', '5,000,000,000'], [null, ''], [undefined, ''], ['abc', 'abc'],
    ];
    for (const [input, out] of cases) assert.equal(amountText(input), out, String(input));
    assert.equal(roundAmounts('Player won 0.368812502 SOL; pot 0.3 SOL; 0.000001 SOL earned'), 'Player won 0.3688 SOL; pot 0.3 SOL; <0.0001 SOL earned');
    assert.equal(roundAmounts('Box 12 at slot 400123'), 'Box 12 at slot 400123', 'whole numbers stay');
  });

  it('every "Add …" makes a part that passes the checker, from nothing and next to the fixtures', async () => {
    for (const base of [null, 'coin-flip-arena', 'blind-forge', 'duel-arena']) {
      for (const s of SECTIONS) {
        const variants = s.kind === 'token' ? ['curve', 'game'] : [undefined];
        for (const variant of variants) {
          const spec = base ? await fixture(base) : starterEconomy('Bean Brawl');
          const added = addPart(spec, s.kind, { title: 'Bean Brawl', variant });
          assert.ok(spec[added.section].some((p) => p.key === added.key));
          const v = check(spec);
          assert.deepEqual(v.refusals.map((r) => `${r.code} ${r.message}`), [], `${base ?? 'new'} + ${s.kind}${variant ? ` (${variant})` : ''}`);
        }
      }
    }
  });

  it('keys stay unique, and removing a part drops its line in the scenario', async () => {
    const spec = await fixture('coin-flip-arena');
    const a = addPart(spec, 'lottery');
    const b = addPart(spec, 'lottery');
    assert.notEqual(a.key, b.key);
    assert.notEqual(spec.lotteries.find((l) => l.key === a.key).pot, spec.lotteries.find((l) => l.key === b.key).pot, 'each lottery gets a pot of its own');
    removePart(spec, 'boxes', 'flip');
    assert.equal(spec.boxes, undefined);
    assert.equal(spec.scenario.perDay['box:flip'], undefined);
    assert.equal(spec.scenario.perDay['lottery:weekly'], 100);
  });

  it('puts each checker note next to the part it is about (by key or by place in the list)', async () => {
    const spec = await fixture('coin-flip-arena');
    assert.deepEqual(partOfWhere(spec, 'economy.boxes.flip.price'), { section: 'boxes', key: 'flip', field: 'price' });
    assert.deepEqual(partOfWhere(spec, 'economy.lotteries[0].places[1]'), { section: 'lotteries', key: 'weekly', field: 'places[1]' });
    assert.equal(partOfWhere(spec, 'economy'), null);
    assert.equal(partOfWhere(spec, 'economy.keys.authority'), null);
    const { byPart, general } = notesByPart(spec, check(spec));
    assert.equal(byPart.get('boxes:flip')[0].code, 'W-FEE');
    assert.ok(general.some((n) => n.code === 'W-CHANCE-PRIZE'));
  });

  it('draws the coin-flip arena’s money: players → the flip, the lottery and the stake → three pools → winners, places, stakers', async () => {
    const g = flowGraph(await fixture('coin-flip-arena'));
    const edges = g.edges.map((e) => `${e.from} → ${e.to} ${e.label}`);
    for (const want of [
      'players → boxes:flip 0.1',
      'boxes:flip → pools:house 88%',
      'boxes:flip → pools:pot 10%',
      'boxes:flip → pools:backers 2%',
      'pools:house → winners 50%: 0.176',
      'lotteries:weekly → pools:pot 100%',
      'pools:pot → places:weekly 50/30/20%',
      'pools:backers → stakers:backers all of it',
    ])
      assert.ok(edges.includes(want), `${want}\n${edges.join('\n')}`);
    assert.ok(!g.nodes.some((n) => n.id === 'treasury'), 'every flip is split in full: nothing reaches the treasury');
  });

  it('draws what a split leaves to the treasury, burns, and moves between pools', async () => {
    const spec = await fixture('falling-drop');
    const g = flowGraph(spec);
    assert.ok(g.edges.some((e) => e.to === 'treasury'));
    assert.ok(g.edges.some((e) => e.to === 'burn'));
    const halving = flowGraph(await fixture('halving-seasons'));
    assert.ok(halving.edges.some((e) => e.kind === 'move'), JSON.stringify(halving.edges));
  });

  it('lays the picture out inside its width, at a phone’s and a desktop panel’s', async () => {
    for (const f of (await readdir(FIXTURES)).filter((x) => x.endsWith('.json'))) {
      const graph = flowGraph(JSON.parse(await readFile(new URL(f, FIXTURES), 'utf8')));
      for (const width of [326, 540, 900]) {
        const L = layoutFlow(graph, width);
        for (const n of L.nodes) assert.ok(n.x >= 0 && n.x + n.w <= width, `${f} @${width}: ${n.id} at ${n.x}+${n.w}`);
        for (const e of L.edges.filter((x) => x.label)) assert.ok(e.lx - e.lw / 2 >= 0 && e.lx + e.lw / 2 <= width, `${f} @${width}: label ${e.label}`);
        // boxes never overlap
        for (const a of L.nodes) for (const b of L.nodes) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${f} @${width}: ${a.id} overlaps ${b.id}`);
      }
    }
  });

  it('reads numbers as the creator types them', () => {
    assert.equal(parseAmount('0.1'), 0.1);
    assert.equal(parseAmount('0,25'), 0.25);
    assert.equal(parseAmount('0.10000000000000000001'), '0.10000000000000000001', 'exact amounts stay text');
    assert.equal(parseAmount(''), undefined);
    assert.equal(parseAmount('cheap'), 'cheap', 'left for the checker to name');
    assert.equal(parseNumber('12.5%'), 12.5);
    assert.equal(parseDuration('7 d'), '7d');
    assert.equal(parseDuration('3600'), 3600);
  });
});

describe('links into the tab', () => {
  it('economy_publish\'s link offers "Put it live"; a decision link is read for the K4 note; anything else asks nothing', () => {
    assert.deepEqual(linkAsks('#economy?flow=economy'), { kind: 'publish' });
    assert.deepEqual(linkAsks('#economy?decide=reward&to=Ann&amount=0.1&side='), { kind: 'decide', key: 'reward', values: { to: 'Ann', amount: '0.1' } });
    assert.equal(linkAsks('#economy'), null);
    assert.equal(linkAsks('#items?flow=economy'), null);
    assert.equal(linkAsks(''), null);
  });
});
