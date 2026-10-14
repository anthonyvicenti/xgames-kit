// The economy spec: the schema takes every fixture, the trimmed IDL is the deployed program's, account sizes match the
// program's own numbers, and every number in a spec is a slot that points at itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountSize, IDL, trimIdl } from '../builder/web3/economy/idl.mjs';
import { economySlots } from '../builder/web3/economy/slots.mjs';
import { validate } from '../builder/web3/economy/validate.mjs';
import { FULL_IDL, fixture, fixtureNames } from './economy/helpers.mjs';

const pointer = (doc, p) => p.split('/').slice(1).reduce((node, k) => node?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);

test('there are the coin-flip arena, ten economies from the list of 100 and the level ladder (K4)', () => {
  assert.equal(fixtureNames().length, 12);
  assert.ok(fixtureNames().includes('level-ladder'));
  assert.ok(fixtureNames().includes('coin-flip-arena'));
});

for (const name of fixtureNames())
  test(`fixture ${name} validates against economy.schema.json`, () => {
    assert.deepEqual(validate(fixture(name)), []);
  });

test('the schema refuses what it should, naming the field', () => {
  const errors = validate({ version: 2, boxes: [{ key: 'Flip', name: 'x', price: -1, outcomes: [] }], extra: true });
  const where = errors.map((e) => e.path);
  for (const path of ['economy.version', 'economy.boxes[0].key', 'economy.boxes[0].price', 'economy.boxes[0].outcomes', 'economy.extra']) assert.ok(where.includes(path), `${path} in ${where}`);
});

test('the trimmed IDL is the deployed program 0.3.2, trimmed', () => {
  assert.equal(IDL.address, 'GVzbAquLbqGxWzzjEAYvGyj1a3SHEcBr3gM9fseTg73o');
  assert.equal(IDL.version, '0.3.2');
  assert.deepEqual(IDL, trimIdl(FULL_IDL), 'web3/economy/loot-0.3.json is out of date: node web3/economy/idl.mjs <loot.json> > web3/economy/loot-0.3.json');
  assert.equal(IDL.instructions.length, 49);
});

test('account sizes match the program (state.rs tests, game.rs)', () => {
  assert.equal(accountSize('Platform', {}), 106);
  assert.equal(accountSize('Game', { official: null }), 166);
  const holder = { to: { Holder: 'x' }, bps: 1 };
  assert.equal(accountSize('Order', { status: { Pending: {} }, outcome: { Pay: { pool: 0, amount: 0 } }, shares: [holder, holder, holder, holder] }), 325);
});

for (const name of fixtureNames())
  test(`every number in ${name} is a slot whose pointer finds it`, () => {
    const economy = fixture(name);
    const config = { version: 1, network: 'devnet', economy };
    const slots = economySlots(economy);
    assert.ok(slots.length > 0);
    assert.equal(new Set(slots.map((s) => s.id)).size, slots.length, 'slot ids are unique');
    for (const s of slots) {
      assert.equal(s.source.file, 'gamesfun.json');
      assert.notEqual(pointer(config, s.source.pointer), undefined, `${s.id} → ${s.source.pointer}`);
      assert.ok(['number', 'integer', 'text'].includes(s.type));
      assert.ok(s.id.startsWith('economy.'));
    }
  });

test('the arena’s main slots are the numbers a creator tunes', () => {
  const ids = economySlots(fixture('coin-flip-arena')).map((s) => s.id);
  for (const id of ['economy.box.flip.price', 'economy.box.flip.outcomes.0.chance', 'economy.box.flip.outcomes.0.amount', 'economy.box.flip.split.1.percent', 'economy.lottery.weekly.places.0', 'economy.pool.house.seed', 'economy.stake.backers.lock'])
    assert.ok(ids.includes(id), id);
});
