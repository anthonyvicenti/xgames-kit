// Maintainers only: regenerates tests/web3/fixtures/loot-0.3.json, which tests/web3-loot.test.mjs holds the kit's loot
// client to, from games.fun's own 0.3 tooling: client/codec.mjs (encoding), the IDL from `anchor build`
// (target/idl/loot.json), the account walk of devnet-e2e-0.3.mjs, @solana/web3.js and @solana/spl-token (games.fun
// launchpad's own install, never the kit's) for addresses and the transfer-hook resolution, and real devnet accounts
// and transactions from games.fun's latest devnet run (devnet-e2e-0.3.1-result.json).
//
//   node tests/web3/fixtures/generate-loot.mjs --loot <games.fun>/launchpad/loot [--rpc <devnet RPC URL>]
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.loot) throw new Error('usage: --loot <games.fun>/launchpad/loot [--rpc <devnet RPC URL>]');
const LOOT = path.resolve(args.loot);
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'loot-0.3.json');
const E2E = 'devnet-e2e-0.3.1-result.json';
const require = createRequire(`${LOOT}/../package.json`);
const { PublicKey, Keypair, Connection, TransactionInstruction, SYSVAR_SLOT_HASHES_PUBKEY } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { encodeIx, encode, decodeAccount, decodeEvents, Writer } = await import(`${LOOT}/client/codec.mjs`);
const IDL = JSON.parse(readFileSync(`${LOOT}/target/idl/loot.json`, 'utf8'));
const PROGRAM = new PublicKey(IDL.address);

const hex = (b) => Buffer.from(b).toString('hex');
const ixJson = (ix) => ({ programId: ix.programId.toBase58(), keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: hex(ix.data) });
const key = (label) => Keypair.fromSeed(createHash('sha256').update(`gamesfun-kit loot 0.3 fixture ${label}`).digest()).publicKey;
const find = (seeds, program = PROGRAM) => PublicKey.findProgramAddressSync(seeds, program)[0];
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
// As devnet-e2e-0.3.mjs derives them.
const pda = {
  platform: () => find([Buffer.from('platform')]),
  game: (c) => find([Buffer.from('game'), c.toBuffer()]),
  fees: (g) => find([Buffer.from('fees'), g.toBuffer()]),
  pool: (g, i) => find([Buffer.from('pool'), g.toBuffer(), Buffer.from([i])]),
  item: (g, id) => find([Buffer.from('item'), g.toBuffer(), u32(id)]),
  box: (g, id) => find([Buffer.from('box'), g.toBuffer(), u32(id)]),
  order: (g, p, n) => find([Buffer.from('order'), g.toBuffer(), p.toBuffer(), u64(n)]),
  escrow: (o) => find([Buffer.from('escrow'), o.toBuffer()]),
  asset: (o, s) => find([Buffer.from('asset'), o.toBuffer(), u64(s)]),
  schedule: (g, id) => find([Buffer.from('schedule'), g.toBuffer(), u32(id)]),
  lottery: (g, id) => find([Buffer.from('lottery'), g.toBuffer(), u32(id)]),
  stake: (g, id) => find([Buffer.from('stake'), g.toBuffer(), u32(id)]),
  staked: (s) => find([Buffer.from('staked'), s.toBuffer()]),
  rewards: (s) => find([Buffer.from('rewards'), s.toBuffer()]),
  position: (s, p) => find([Buffer.from('position'), s.toBuffer(), p.toBuffer()]),
  recipe: (g, id) => find([Buffer.from('recipe'), g.toBuffer(), u32(id)]),
  hold: (a) => find([Buffer.from('hold'), a.toBuffer()]),
  contest: (g, id) => find([Buffer.from('contest'), g.toBuffer(), u32(id)]),
  entry: (c, p, side) => find([Buffer.from('entry'), c.toBuffer(), p.toBuffer(), Buffer.from([side])]),
  pot: (c) => find([Buffer.from('pot'), c.toBuffer()]),
  identity: () => find([Buffer.from('identity')]),
  programData: () => find([PROGRAM.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')),
};
const ata = (o, m, p = spl.TOKEN_PROGRAM_ID) => spl.getAssociatedTokenAddressSync(m, o, true, p);
const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });

/** devnet-e2e-0.3.mjs's builder, with the platform, the game's fee box and the oracle filled as the e2e passed them. */
function ix(name, args, given, remaining = []) {
  const def = IDL.instructions.find((i) => i.name === name);
  const all = { platform: pda.platform(), fees: given.game && pda.fees(given.game), program_identity: pda.identity(), oracle_queue: new PublicKey('Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh'), slot_hashes: SYSVAR_SLOT_HASHES_PUBKEY, ...given };
  const keys = [];
  const walk = (accounts) => {
    for (const a of accounts) {
      if (a.accounts) { walk(a.accounts); continue; }
      const value = all[a.name] ?? a.address;
      if (!value && !a.optional) throw new Error(`${name}: missing account ${a.name}`);
      keys.push(value ? { pubkey: new PublicKey(value), isSigner: !!a.signer, isWritable: !!a.writable } : { pubkey: PROGRAM, isSigner: false, isWritable: false });
    }
  };
  walk(def.accounts);
  return ixJson(new TransactionInstruction({ programId: PROGRAM, keys: [...keys, ...remaining], data: encodeIx(IDL, name, args) }));
}

const K = Object.fromEntries(['owner', 'authority', 'player', 'collection', 'mint', 'mint22', 'asset', 'partner', 'to', 'launcher', 'venueA', 'venueB', 'admin', 'newKey', 'stud'].map((n) => [n, key(n)]));
const game = pda.game(K.collection);
const T22 = spl.TOKEN_2022_PROGRAM_ID;
const nonce = 1234567890123n;
const slot = 987654321n;
const clientSeed = createHash('sha256').update('client seed').digest();
const reference = createHash('sha256').update('reference').digest();
const treasury = ata(K.owner, K.mint);
const order = pda.order(game, K.player, nonce);
const shares = [{ to: { Pool: [0] }, bps: 2000 }, { to: { Account: [K.partner] }, bps: 500 }, { to: { Holder: [K.stud] }, bps: 300 }, { to: 'Burn', bps: 100 }];
const shareTargets = [w(pda.pool(game, 0)), w(K.partner), r(K.stud), w(ata(K.to, K.mint))];
const itemArgs = { kind: 'Collectible', rarity: 3, soulbound: true, burnable: false, name: 'Golden Hat', uri: 'https://devnet.irys.xyz/abc', max_supply: 100, price: 2500000n, rise: { step: 10n, growth_bps: 500 }, fall: { step: 1n, every: 60, floor: 5n, since: 1760000000n }, life: { ready_after: 1, lasts: 2, uses: 3, cooldown: 4 }, active: true, shares };
const entries = [{ outcome: { Item: [7] }, weight: 60 }, { outcome: { Pay: { pool: 1, amount: 5000n } }, weight: 20 }, { outcome: { Share: { pool: 2, bps: 1000 } }, weight: 10 }, { outcome: 'Burn', weight: 5 }, { outcome: 'Nothing', weight: 5 }];
const boxArgs = { price: 1000000n, currency: K.mint22, rise: null, fall: null, stock_odds: true, active: true, shares: [{ to: { Pool: [3] }, bps: 10000 }], entries };
const entryTargets = [w(pda.item(game, 7)), w(pda.pool(game, 1)), w(pda.pool(game, 2))];
const recipeArgs = {
  active: true,
  inputs: [{ Burn: { item: 1, count: 2 } }, { Use: { item: 2 } }, { Renew: { item: 3 } }, { Pay: { mint: K.mint, amount: 5n, to: { Pool: [1] } } }],
  outputs: [{ Item: [4] }, { Tokens: { mint: K.mint, amount: 9n, from: 'Issue' } }, { Tokens: { mint: K.mint, amount: 1n, from: { Pool: [2] } } }, { Share: { mint: K.mint, pool: 2, bps: 100 } }],
  needs: [{ place: 1, key: 'level', at_least: 10 }],
  keeps: [{ key: 'coat', from: 0, to: 0 }],
};
const contestArgs = { sides: 2, closes_at: 1760000000n, result_by: 1760003600n, shares: [{ to: 'Burn', bps: 200 }] };
const stake = pda.stake(game, 4);
const contest = pda.contest(game, 6);
const lottery = pda.lottery(game, 3);
const hook = [r(new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'))];

const cases = {
  init_platform: ix('init_platform', { fees: { player: 2000000n, project: 10000n }, partner: K.partner }, { admin: K.admin, program_data: pda.programData() }),
  set_platform: ix('set_platform', { fees: { player: 3000000n, project: 10000n } }, { admin: K.admin, next_admin: K.owner }),
  collect_fees: ix('collect_fees', {}, { admin: K.admin, to: K.to }, [r(game), w(pda.fees(game))]),
  set_suspended: ix('set_suspended', { suspended: true }, { admin: K.admin, game }),
  create_game: ix('create_game', { authority: K.authority }, { owner: K.owner, game, collection: K.collection, mint: K.mint, treasury }),
  update_game: ix('update_game', { update: { authority: K.to, paused: true } }, { owner: K.owner, game, treasury }),
  update_game_new_owner: ix('update_game', { update: { authority: null, paused: null } }, { owner: K.owner, game, treasury, new_owner: K.newKey }),
  open_pool: ix('open_pool', { index: 3 }, { owner: K.owner, game, mint: K.mint22, pool: pda.pool(game, 3) }),
  close_pool: ix('close_pool', { index: 3 }, { owner: K.owner, game, pool: pda.pool(game, 3), mint: K.mint22 }),
  upsert_item: ix('upsert_item', { item_id: 7, args: itemArgs }, { owner: K.owner, game, item: pda.item(game, 7) }),
  upsert_box: ix('upsert_box', { box_id: 3, args: boxArgs }, { owner: K.owner, game, loot_box: pda.box(game, 3) }),
  upsert_schedule: ix('upsert_schedule', { id: 2, args: { active: true, action: { Issue: { mint: K.mint, pool: 1, amount: 100n, halve_every: 52 } }, every: 86400n, next_at: 1760000000n, max_runs: 0 } }, { owner: K.owner, game, schedule: pda.schedule(game, 2) }),
  upsert_schedule_move: ix('upsert_schedule', { id: 5, args: { active: false, action: { Move: { from: 1, to: 2, bps: 250 } }, every: 3600n, next_at: 0n, max_runs: 9 } }, { owner: K.owner, game, schedule: pda.schedule(game, 5) }),
  upsert_lottery: ix('upsert_lottery', { id: 3, args: { price: 1000000n, pot: 1, cut_bps: 100, places: [7000, 3000], ticket_mint: PublicKey.default, every: 120n, draws_at: 1760000075n } }, { owner: K.owner, game, lottery }),
  upsert_recipe: ix('upsert_recipe', { id: 8, args: recipeArgs }, { owner: K.owner, game, recipe: pda.recipe(game, 8) }),
  open_stake: ix('open_stake', { id: 4, rewards_pool: 2, lock: 3600n }, { owner: K.owner, game, stake, mint: K.mint, rewards_mint: K.mint22, staked_vault: pda.staked(stake), rewards_vault: pda.rewards(stake) }),
  pay: ix('pay', { amount: 1000n, shares, reference }, { player: K.player, game, mint: K.mint, player_token: ata(K.player, K.mint), treasury }, [...shareTargets, ...hook]),
  deposit: ix('deposit', { index: 1, amount: 20n }, { depositor: K.owner, game, pool: pda.pool(game, 1), from: treasury, mint: K.mint }),
  buy_item: ix('buy_item', { item_id: 7, nonce, max_price: 2500000n }, { item: pda.item(game, 7), player: K.player, game, order, escrow: pda.escrow(order), mint: K.mint, player_token: ata(K.player, K.mint), vault: ata(game, K.mint) }),
  open_box_2022: ix('open_box', { box_id: 3, nonce, client_seed: [...clientSeed], max_price: 1000000n }, {
    loot_box: pda.box(game, 3), player: K.player, game, order, escrow: pda.escrow(order), mint: K.mint22, player_token: ata(K.player, K.mint22, T22), vault: ata(game, K.mint22, T22),
  }, [...entryTargets, ...hook]),
  settle: ix('settle', {}, { signer: K.player, order, player: K.player, game, item: pda.item(game, 7), escrow: pda.escrow(order), mint: K.mint, vault: ata(game, K.mint), treasury, collection: K.collection, asset: pda.asset(order, slot) }, shareTargets),
  settle_prize_pay: ix('settle_prize', {}, { order, player: K.player, game, escrow: pda.escrow(order), mint: K.mint22, vault: ata(game, K.mint22, T22), treasury, prize_pool: pda.pool(game, 1), prize_to: ata(K.player, K.mint), prize_mint: K.mint, platform: pda.platform() }, [w(pda.pool(game, 3)), ...hook]),
  settle_prize_nothing: ix('settle_prize', {}, { order, player: K.player, game, escrow: pda.escrow(order), mint: K.mint, vault: ata(game, K.mint), treasury }),
  refund_rolled: ix('refund', {}, { signer: K.player, order, player: K.player, game, escrow: pda.escrow(order), mint: K.mint, vault: ata(game, K.mint), player_token: ata(K.player, K.mint) }, [w(pda.item(game, 7))]),
  refund_2022: ix('refund', {}, { signer: K.player, order, player: K.player, game, escrow: pda.escrow(order), mint: K.mint22, vault: ata(game, K.mint22, T22), player_token: ata(K.player, K.mint22, T22) }, hook),
  payout: ix('payout', { index: 1, amount: 77n, reference }, { authority: K.authority, game, pool: pda.pool(game, 1), to: ata(K.to, K.mint), mint: K.mint }),
  burn: ix('burn', { index: 2, amount: 5n, reference }, { authority: K.authority, game, pool: pda.pool(game, 2), mint: K.mint }),
  issue: ix('issue', { amount: 1000n, reference }, { authority: K.authority, game, mint: K.mint, to: ata(K.to, K.mint) }),
  make: ix('make', { reference }, { authority: K.authority, game, item: pda.item(game, 7), collection: K.collection, asset: K.newKey, owner: K.player }),
  unmake: ix('unmake', { reference }, { authority: K.authority, game, asset: K.asset, collection: K.collection }),
  set: ix('set', { attributes: [{ key: 'level', value: '10' }], reference }, { authority: K.authority, game, asset: K.asset, collection: K.collection }),
  roll: ix('roll', { reference }, { authority: K.authority, game }),
  run_schedule: ix('run_schedule', {}, { game, schedule: pda.schedule(game, 2) }, [w(K.mint), w(pda.pool(game, 1))]),
  buy_tickets: ix('buy_tickets', { count: 3n, max_price: 1000000n }, { player: K.player, game, lottery, player_token: ata(K.player, K.mint), pot: pda.pool(game, 1), treasury, mint: K.mint }),
  draw_lottery: ix('draw_lottery', {}, { payer: K.owner, lottery }),
  pay_lottery: ix('pay_lottery', { place: 1 }, { game, lottery, first_place: K.player, pot: pda.pool(game, 1), to: ata(K.to, K.mint), mint: K.mint }),
  stake: ix('stake', { amount: 50n }, { player: K.player, game, stake, position: pda.position(stake, K.player), staked_vault: pda.staked(stake), rewards_vault: pda.rewards(stake), rewards_pool: pda.pool(game, 2), player_tokens: ata(K.player, K.mint), player_rewards: ata(K.player, K.mint22, T22), mint: K.mint, rewards_mint: K.mint22 }),
  unstake: ix('unstake', { amount: 0n, forfeit: false }, { player: K.player, game, stake, position: pda.position(stake, K.player), staked_vault: pda.staked(stake), rewards_vault: pda.rewards(stake), rewards_pool: pda.pool(game, 2), player_tokens: ata(K.player, K.mint), player_rewards: ata(K.player, K.mint22, T22), mint: K.mint, rewards_mint: K.mint22 }),
  craft: ix('craft', { version: 2, times: 500n }, { player: K.player, game, recipe: pda.recipe(game, 8), collection: K.collection }),
  hold: ix('hold', { seconds: 600n, reference }, { player: K.player, game, hold: pda.hold(K.asset), asset: K.asset, collection: K.collection }),
  award: ix('award', { reference }, { signer: K.authority, game, hold: pda.hold(K.asset), asset: K.asset, player: K.player, to: K.to, collection: K.collection }),
  take_back: ix('take_back', {}, { signer: K.owner, game, hold: pda.hold(K.asset), asset: K.asset, player: K.player, collection: K.collection }),
  open_contest: ix('open_contest', { id: 6, args: contestArgs }, { authority: K.authority, game, contest, mint: K.mint, pot: pda.pot(contest) }),
  enter: ix('enter', { side: 1, amount: 40n, terms: [...reference] }, { player: K.player, game, contest, entry: pda.entry(contest, K.player, 1), pot: pda.pot(contest), player_token: ata(K.player, K.mint), mint: K.mint }),
  decide: ix('decide', { side: 1, reference }, { authority: K.authority, game, contest, mint: K.mint, pot: pda.pot(contest) }),
  call_off: ix('call_off', {}, { signer: K.owner, game, contest }),
  claim: ix('claim', {}, { game, contest, entry: pda.entry(contest, K.player, 1), player: K.player, pot: pda.pot(contest), to: ata(K.player, K.mint), mint: K.mint }),
  close_contest: ix('close_contest', {}, { game, contest, opener: K.authority, mint: K.mint, pot: pda.pot(contest) }),
  attach_token: ix('attach_token', { venue: 'Meteora', mint: K.mint }, { owner: K.owner, launcher: K.launcher, game, venue_a: K.venueA, venue_b: K.venueB }),
  recheck_token: ix('recheck_token', {}, { game, venue_a: K.venueA, venue_b: K.venueB }),
};
// The game's Core collection, as games.fun's client/loot.mjs createCollectionIx writes it (royalties to the creator,
// the game as update delegate), with the 0.3 game address.
function createCollection({ collection, updateAuthority, name, uri, royaltyBps }) {
  const wr = new Writer();
  wr.int('u8', 21);
  for (const s of [name, uri]) { const b = Buffer.from(s, 'utf8'); wr.int('u32', b.length); wr.bytes(b); }
  wr.int('u8', 1); wr.int('u32', 2);
  wr.int('u8', 0); wr.int('u16', royaltyBps); wr.int('u32', 1); wr.bytes(updateAuthority.toBuffer()); wr.int('u8', 100); wr.int('u8', 0); wr.int('u8', 0);
  wr.int('u8', 4); wr.int('u32', 1); wr.bytes(pda.game(collection).toBuffer()); wr.int('u8', 0);
  wr.int('u8', 0);
  return ixJson(new TransactionInstruction({
    programId: new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),
    keys: [
      { pubkey: collection, isSigner: true, isWritable: true },
      { pubkey: updateAuthority, isSigner: false, isWritable: false },
      { pubkey: updateAuthority, isSigner: true, isWritable: true },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    data: wr.done(),
  }));
}
const collectionCase = createCollection({ collection: K.collection, updateAuthority: K.owner, name: 'Bean Brawl Items', uri: 'https://devnet.irys.xyz/col', royaltyBps: 500 });
// The contest's terms, as contest.rs hashes them: sha256(mint || borsh(ContestArgs)).
const termsBytes = Buffer.concat([K.mint.toBuffer(), encode(IDL, { defined: { name: 'ContestArgs' } }, contestArgs).done()]);
const scalars = [-1n, -5n, 0n, 1760000000n, -(2n ** 63n), 2n ** 63n - 1n].map((v) => ({ value: String(v), hex: hex(encode(IDL, 'i64', v).done()) }));

// ---------------------------------------------------------------- real devnet accounts and receipts (the e2e run)
const conn = new Connection(args.rpc ?? 'https://api.devnet.solana.com', 'confirmed');
const e2e = JSON.parse(readFileSync(`${LOOT}/${E2E}`, 'utf8'));
const g = new PublicKey(e2e.game);
const plain = (v) => (v instanceof PublicKey ? v.toBase58() : typeof v === 'bigint' ? v.toString() : Buffer.isBuffer(v) ? hex(v) : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);
const accounts = {};
for (const [name, type, address] of [
  ['platform', 'Platform', pda.platform()],
  ['game', 'Game', g],
  ['item', 'Item', pda.item(g, 1)],
  ['box', 'LootBox', pda.box(g, 1)],
  ['box2022', 'LootBox', pda.box(g, 2)],
  ['lottery', 'Lottery', pda.lottery(g, 1)],
  ['stake', 'Stake', pda.stake(g, 1)],
]) {
  const info = await conn.getAccountInfo(address, 'confirmed');
  accounts[name] = { type, address: address.toBase58(), data: info.data.toString('base64'), expect: plain(decodeAccount(IDL, type, info.data)) };
}
const events = [];
for (const step of e2e.steps.filter((s) => s.signature && s.events?.length).slice(0, 9)) {
  await new Promise((res) => setTimeout(res, 3000));
  const tx = await conn.getTransaction(step.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const logs = tx.meta.logMessages;
  events.push({ step: step.step, signature: step.signature, logs, expect: plain(decodeEvents(IDL, logs)) });
}

// ---------------------------------------------------------------- a transfer hook, resolved by spl-token
const HOOK = key('hook program');
const hookMint = key('hooked mint');
const counter = key('counter');
const mintData = Buffer.alloc(166 + 4 + 64);
mintData[44] = 6; // decimals
mintData[45] = 1; // initialized
mintData[165] = 1; // a mint
mintData.writeUInt16LE(14, 166);
mintData.writeUInt16LE(64, 168);
key('hook authority').toBuffer().copy(mintData, 170);
HOOK.toBuffer().copy(mintData, 202);
const validation = spl.getExtraAccountMetaAddress(hookMint, HOOK);
const metaEntry = (discriminator, config, signer, writable) => {
  const b = Buffer.alloc(35);
  b[0] = discriminator;
  Buffer.from(config).copy(b, 1);
  b[33] = signer ? 1 : 0;
  b[34] = writable ? 1 : 0;
  return b;
};
const seeds = (...parts) => Buffer.concat(parts);
const metas = [
  metaEntry(0, counter.toBuffer(), false, true), // a fixed account
  metaEntry(1, seeds(Buffer.from([1, 4]), Buffer.from('cnt0'), Buffer.from([3, 1])), false, true), // literal + the mint
  metaEntry(1, seeds(Buffer.from([3, 2]), Buffer.from([2, 8, 8])), false, false), // the destination + the amount
  metaEntry(1, seeds(Buffer.from([4, 0, 32, 32])), false, false), // 32 bytes of the source's data (its owner)
  metaEntry(128 + 5, seeds(Buffer.from([3, 3])), false, true), // a PDA of the counter's "program" (account 5), from the authority
];
const list = Buffer.concat([Buffer.from([105, 37, 101, 197, 75, 251, 102, 26]), u32(4 + 35 * metas.length), u32(metas.length), ...metas]);
const transfer = { source: key('hook source'), destination: key('hook destination'), authority: key('hook authority wallet'), amount: 4242n };
const sourceData = Buffer.alloc(165);
hookMint.toBuffer().copy(sourceData, 0);
key('source owner').toBuffer().copy(sourceData, 32);
const fakeAccounts = new Map([
  [hookMint.toBase58(), { data: mintData, owner: T22 }],
  [validation.toBase58(), { data: list, owner: HOOK }],
  [transfer.source.toBase58(), { data: sourceData, owner: T22 }],
]);
const fakeConn = { getAccountInfo: async (k) => { const a = fakeAccounts.get(k.toBase58()); return a ? { data: a.data, owner: a.owner, lamports: 1, executable: false } : null; } };
const transferIx = await spl.createTransferCheckedWithTransferHookInstruction(fakeConn, transfer.source, hookMint, transfer.destination, transfer.authority, transfer.amount, 6, [], 'confirmed', T22);
const hookCase = {
  mint: hookMint.toBase58(),
  hookProgram: HOOK.toBase58(),
  validation: validation.toBase58(),
  accounts: Object.fromEntries([...fakeAccounts].map(([k, a]) => [k, { owner: a.owner.toBase58(), data: a.data.toString('base64') }])),
  transfer: { source: transfer.source.toBase58(), destination: transfer.destination.toBase58(), authority: transfer.authority.toBase58(), amount: String(transfer.amount) },
  // what spl-token appends after the transfer's own four accounts
  extras: transferIx.keys.slice(4).map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
};

writeFileSync(OUT, `${JSON.stringify({
  source: {
    what: `games.fun launchpad/loot ${IDL.metadata.version}: client/codec.mjs, target/idl/loot.json (sha256 ${createHash('sha256').update(readFileSync(`${LOOT}/target/idl/loot.json`)).digest('hex').slice(0, 8)}…), the account walk of devnet-e2e-0.3.mjs; @solana/web3.js and @solana/spl-token for addresses and the transfer hook; accounts and transactions of the devnet run ${E2E} (${e2e.date.slice(0, 10)})`,
    made: new Date().toISOString(),
  },
  inputs: { ...Object.fromEntries(Object.entries(K).map(([k, v]) => [k, v.toBase58()])), game: game.toBase58(), nonce: String(nonce), slot: String(slot), clientSeed: hex(clientSeed), reference: hex(reference) },
  cases,
  createCollection: collectionCase,
  contestTerms: hex(createHash('sha256').update(termsBytes).digest()),
  i64: scalars,
  accounts,
  events,
  hook: hookCase,
}, null, 1)}\n`);
console.log('wrote', OUT, Object.keys(cases).length, 'cases', Object.keys(accounts).length, 'accounts', events.length, 'transactions');
