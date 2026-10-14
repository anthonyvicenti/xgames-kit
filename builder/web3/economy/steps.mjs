// The steps that set an economy up, one per instruction, in the program's own terms: the instruction's name and
// argument names exactly as loot 0.3's IDL has them, its accounts by role, who signs, what it says in words and
// its size. compile.mjs orders and packs them; nothing here encodes bytes or talks to the chain. Pure.
//
// Values in `args`: amounts (u64) are decimal strings in base units; pubkeys are addresses, or "@<name>" for one
// that only exists once an earlier step ran ("@mint:points", "@wallet:owner"); enums are { Variant: fields },
// { Variant: {} } for one without fields, and { Pool: 3 } for one with a single unnamed field.
//
// Accounts are names, not addresses: "wallet:owner", "pda:game", "pda:pool/0", "pda:item/3", "mint:sol",
// "ata:owner/sol" (the owner's token account of that token), "new:collection" (a key made for this setup, which
// signs), "program:system", "pda:fees" (the game's fee box). Each name stands for one address.
import { accountSize, dataSize, instruction } from './idl.mjs';
import { WSOL, model, rarityNumber, sharesOf, toEnum, toSeconds, toTime, toUnits, weights } from './model.mjs';

const PROGRAMS = {
  '11111111111111111111111111111111': 'program:system',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'program:token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'program:token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'program:associated-token',
  CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d: 'program:mpl-core',
  Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz: 'program:vrf',
  SysvarS1otHashes111111111111111111111111111: 'sysvar:slot-hashes',
};
export const NO_ADDRESS = '11111111111111111111111111111111';

/** A loot step: every account the IDL lists, from `accounts` by name or, for fixed programs, by address. */
export function lootStep(name, args, accounts, { id, signer = 'owner', says }) {
  const ix = instruction(name) ?? fail(`Loot 0.3 has no instruction ${name}`);
  const named = {};
  for (const a of ix.accounts) {
    const value = accounts[a.name] ?? PROGRAMS[a.address];
    if (!value && !a.optional) fail(`${name}: no account for ${a.name}`);
    if (value) named[a.name] = value;
  }
  return { id, program: 'loot', ix: name, args, accounts: named, signer, signers: [`wallet:${signer}`], says, data: dataSize(name, args) };
}

/**
 * A step of another program. `data` is its instruction data, from that program's own layout; `signs` the keys made
 * for this setup that sign it. Accounts the step creates that are not the loot program's are sized roughly
 * (`approx` on what it creates).
 */
function other(program, ix, args, accounts, { id, signer = 'owner', says, data, signs = [] }) {
  return { id, program, ix, args, accounts, signer, signers: [`wallet:${signer}`, ...signs], says, data };
}

function fail(message) {
  throw new Error(message);
}

const utf8 = (s) => new TextEncoder().encode(s ?? '').length;
const owner = 'wallet:owner';
const game = 'pda:game';
const mintRef = (t) => (t.mint?.startsWith('@') ? t.mint : t.mint ?? `@mint:${t.key}`);
const tokenProgram = (t) => (t?.program === 'token-2022' ? 'program:token-2022' : 'program:token');
const shares = (split, m) => sharesOf(split).map((s) => ({ to: toEnum(s.to, m), bps: s.bps ?? 0 }));
const rise = (r, t) => (r ? { step: toUnits(r.step ?? 0, t.decimals).toString(), growth_bps: Math.round((r.growthPercent ?? 0) * 100) } : null);
const fall = (f, t, now) => (f ? { step: toUnits(f.step, t.decimals).toString(), every: toSeconds(f.every), floor: toUnits(f.floor ?? 0, t.decimals).toString(), since: toTime(f.start, now) } : null);
const amount = (value, t) => toUnits(value ?? 0, t.decimals).toString();
const reference = (text) => Buffer.from(text.padEnd(32, ' ').slice(0, 32)).toString('hex');
const sol = (m) => [...m.tokens.values()].find((t) => t.wsol);

/** The program's ItemArgs for an item. */
export function itemArgs(it, m) {
  const t = m.currency;
  const collectible = (it.kind ?? 'collectible') === 'collectible';
  const life = it.life && collectible ? { ready_after: toSeconds(it.life.readyAfter), lasts: toSeconds(it.life.lasts), uses: it.life.uses ?? 0, cooldown: toSeconds(it.life.cooldown) } : null;
  return {
    kind: collectible ? { Collectible: {} } : { Normal: {} },
    rarity: rarityNumber(it.rarity),
    soulbound: !!it.soulbound,
    burnable: !!it.burnable,
    name: it.name,
    uri: it.uri ?? '',
    max_supply: it.supply ?? 0,
    price: amount(it.price, t),
    rise: rise(it.rise, t),
    fall: fall(it.fall, t, m.now),
    life,
    active: it.active !== false,
    shares: shares(it.split, m),
  };
}

/** The program's BoxArgs for a box. */
export function boxArgs(b, m) {
  const t = m.priceToken(b);
  const w = weights(b);
  const outcome = (o) => {
    if (o.gives === 'item') return { Item: m.item.get(o.item)?.id ?? 0 };
    if (o.gives === 'pay') return { Pay: { pool: m.pool.get(o.pool)?.index ?? 0, amount: amount(o.amount, m.poolToken(o.pool) ?? t) } };
    if (o.gives === 'share') return { Share: { pool: m.pool.get(o.pool)?.index ?? 0, bps: Math.round((o.percent ?? 0) * 100) } };
    return o.gives === 'burn' ? { Burn: {} } : { Nothing: {} };
  };
  return {
    price: amount(b.price, t),
    currency: b.currency && b.currency !== m.currencyKey ? mintRef(t) : null,
    rise: rise(b.rise, t),
    fall: fall(b.fall, t, m.now),
    stock_odds: !!b.stockOdds,
    active: b.active !== false,
    shares: shares(b.split, m),
    entries: (b.outcomes ?? []).map((o, i) => ({ outcome: outcome(o), weight: w[i] })),
  };
}

/** The program's RecipeArgs for a recipe. */
export function recipeArgs(r, m) {
  const tok = (key) => m.tokens.get(key ?? m.currencyKey);
  const inputs = (r.in ?? []).map((l) => {
    if (l.takes === 'burn') return { Burn: { item: m.item.get(l.item)?.id ?? 0, count: l.count ?? 1 } };
    if (l.takes === 'use') return { Use: { item: m.item.get(l.item)?.id ?? 0 } };
    if (l.takes === 'renew') return { Renew: { item: m.item.get(l.item)?.id ?? 0 } };
    return { Pay: { mint: mintRef(tok(l.currency)), amount: amount(l.amount, tok(l.currency)), to: toEnum(l.to, m) } };
  });
  const outputs = (r.out ?? []).map((l) => {
    if (l.gives === 'item') return { Item: m.item.get(l.item)?.id ?? 0 };
    if (l.gives === 'share') return { Share: { mint: mintRef(m.poolToken(l.pool)), pool: m.pool.get(l.pool)?.index ?? 0, bps: Math.round(l.percent * 100) } };
    const from = l.from === 'mint' ? { Issue: {} } : { Pool: m.pool.get(l.from.slice(5))?.index ?? 0 };
    return { Tokens: { mint: mintRef(tok(l.currency)), amount: amount(l.amount, tok(l.currency)), from } };
  });
  return {
    active: r.active !== false,
    inputs,
    outputs,
    needs: (r.needs ?? []).map((n) => ({ place: n.place, key: n.key, at_least: n.atLeast })),
    keeps: (r.keeps ?? []).map((k) => ({ key: k.key, from: k.from, to: k.to })),
  };
}

/** The program's ScheduleArgs for a schedule. */
export function scheduleArgs(s, m) {
  const every = toSeconds(s.every);
  let action;
  if (s.does === 'issue') {
    const t = m.tokens.get(s.currency ?? m.pool.get(s.pool)?.currency);
    action = { Issue: { mint: mintRef(t), pool: m.pool.get(s.pool)?.index ?? 0, amount: amount(s.amount, t), halve_every: s.halveEvery ?? 0 } };
  } else if (s.does === 'burn') action = { Burn: { pool: m.pool.get(s.pool)?.index ?? 0, bps: Math.round(s.percent * 100) } };
  else action = { Move: { from: m.pool.get(s.from)?.index ?? 0, to: m.pool.get(s.to)?.index ?? 0, bps: Math.round(s.percent * 100) } };
  return { active: s.active !== false, action, every, next_at: s.start ? toTime(s.start, m.now) : m.now + every, max_runs: s.maxRuns ?? 0 };
}

/** The program's LotteryArgs for a lottery. */
export function lotteryArgs(l, m) {
  const potToken = m.poolToken(l.pot);
  const ticket = l.ticketCurrency ? m.tokens.get(l.ticketCurrency) : potToken;
  const every = toSeconds(l.every);
  return {
    price: amount(l.price, ticket),
    pot: m.pool.get(l.pot)?.index ?? 0,
    cut_bps: Math.round((l.cutPercent ?? 0) * 100),
    places: (l.places ?? []).map((p) => Math.round(p * 100)),
    ticket_mint: l.ticketCurrency ? mintRef(ticket) : NO_ADDRESS,
    every,
    draws_at: l.firstDraw ? toTime(l.firstDraw, m.now) : m.now + every,
  };
}

/** Bytes of each account an item, box, recipe, schedule, lottery or stake creates (for the rent). */
export const accountBytes = {
  item: (args) => accountSize('Item', { ...args, game: '', item_id: 0, issued: 0, voided: 0, bump: 0 }),
  box: (args) => accountSize('LootBox', { ...args, game: '', box_id: 0, opened: 0, version: 0, bump: 0 }),
  recipe: (args) => accountSize('Recipe', { ...args, game: '', id: 0, bump: 0, version: 0 }),
  schedule: (args) => accountSize('Schedule', { ...args, game: '', id: 0, bump: 0, runs: 0 }),
  lottery: () => accountSize('Lottery', { status: 'Open' }),
  stake: () => accountSize('Stake', {}),
  game: () => accountSize('Game', { official: null }),
};

/** The step that writes one item, box, recipe or schedule (create or replace), with the account it creates. */
export const partStep = {
  item(it, m) {
    const args = itemArgs(it, m);
    const on = it.active === false ? 'Switch off' : 'List';
    return { ...lootStep('upsert_item', { item_id: it.id, args }, { owner, game, item: `pda:item/${it.id}` }, { id: `item:${it.key}`, says: `${on} “${it.name}”${it.price && Number(it.price) > 0 ? ` at ${it.price} ${m.currency.symbol}` : ''}` }), creates: [{ what: `the item “${it.name}”`, bytes: accountBytes.item(args) }] };
  },
  box(b, m) {
    const args = boxArgs(b, m);
    const says = b.active === false ? `Switch off the box “${b.name}”` : `Put the box “${b.name}” on sale at ${b.price} ${m.priceToken(b)?.symbol}`;
    return { ...lootStep('upsert_box', { box_id: b.id, args }, { owner, game, loot_box: `pda:box/${b.id}` }, { id: `box:${b.key}`, says }), creates: [{ what: `the box “${b.name}”`, bytes: accountBytes.box(args) }] };
  },
  recipe(r, m) {
    const args = recipeArgs(r, m);
    const says = `${r.active === false ? 'Switch off' : 'Write'} the recipe “${r.name}”`;
    return { ...lootStep('upsert_recipe', { id: r.id, args }, { owner, game, recipe: `pda:recipe/${r.id}` }, { id: `recipe:${r.key}`, says }), creates: [{ what: `the recipe “${r.name}”`, bytes: accountBytes.recipe(args) }] };
  },
  schedule(s, m) {
    const args = scheduleArgs(s, m);
    const says = `${s.active === false ? 'Stop' : 'Start'} the schedule “${s.name ?? s.key}”`;
    return { ...lootStep('upsert_schedule', { id: s.id, args }, { owner, game, schedule: `pda:schedule/${s.id}` }, { id: `schedule:${s.key}`, says }), creates: [{ what: `the schedule “${s.name ?? s.key}”`, bytes: accountBytes.schedule(args) }] };
  },
};

/**
 * Every step that sets the economy up, in order: tokens the game makes, the collection, the treasury, the game,
 * pools, items, boxes, recipes, schedules, lotteries, stakes, then the seeds. Each step carries what it creates
 * (`creates`: [{ what, bytes }]) for the rent, and `alone` when it runs outside this plan (a curve launch).
 */
export function setupSteps(economy, { now = 0 } = {}) {
  const m = model(economy, { now });
  const authority = m.authority === 'owner' ? '@wallet:owner' : m.authority;
  const steps = [];
  const push = (step, creates = []) => steps.push({ ...step, creates });

  // Tokens: a curve launch runs in its own approval (the token part of the Economy tab); a token the game mints is made here.
  for (const t of m.tokens.values()) {
    if (t.source === 'curve' && t.mint.startsWith('@'))
      push({ id: `token:${t.key}`, program: 'launch', ix: 'launch_on_curve', args: { name: t.name, symbol: t.symbol }, accounts: {}, signer: 'owner', signers: [owner], alone: true, says: `Launch ${t.symbol} on a Meteora curve of its own, paired with ${t.pair ?? 'SOL'} (the token launch, its own approval), then put its mint in the economy.` });
    if (t.source === 'game' && t.mint.startsWith('@')) {
      const mint = `new:mint/${t.key}`;
      const id = `token:${t.key}`;
      push(other('system', 'create_account', { lamports: 'rent of 82 bytes', space: 82, owner: 'program:token' }, { from: owner, to: mint }, { id, says: `Make the token ${t.symbol} (${t.decimals} decimals)`, data: 52, signs: [mint] }), [{ what: `the mint of ${t.symbol}`, bytes: 82 }]);
      push(other('spl-token', 'initialize_mint2', { decimals: t.decimals, mint_authority: owner, freeze_authority: null }, { mint }, { id, says: `Set ${t.symbol} up with no freeze authority`, data: 35 }));
      const meta = 1 + 4 + utf8(t.name) + 4 + utf8(t.symbol) + 4 + utf8(t.uri) + 2 + 1 + 1 + 1 + 1 + 1;
      push(other('mpl-token-metadata', 'create_metadata_account_v3', { name: t.name, symbol: t.symbol, uri: t.uri ?? '', seller_fee_basis_points: 0, is_mutable: true }, { metadata: `pda:metadata/${t.key}`, mint, mint_authority: owner, payer: owner, update_authority: owner, system_program: 'program:system' }, { id, says: `Name ${t.symbol} so wallets show it`, data: meta }), [{ what: `the name record of ${t.symbol}`, bytes: 679, approx: true }]);
      push(other('spl-token', 'set_authority', { authority_type: 'MintTokens', new_authority: '@pda:game' }, { mint, current_authority: owner }, { id, says: `Hand the minting of ${t.symbol} to the game, so its schedules and recipes can mint it`, data: 35 }));
    }
  }

  // The collection and the game (game.rs create_game: a Core collection whose update authority is the owner).
  if (!m.live.game) {
    const c = m.collection;
    const data = 1 + 4 + utf8(c.name) + 4 + utf8(c.uri) + 1 + 4 + 42 + 38 + 1;
    push(
      other('mpl-core', 'create_collection_v2', { name: c.name, uri: c.uri ?? '', royalty_bps: Math.round((c.royaltyPercent ?? 5) * 100), update_delegate: '@pda:game' }, { collection: 'new:collection', update_authority: owner, payer: owner, system_program: 'program:system' }, { id: 'collection', says: `Make the collection “${c.name}”, with ${c.royaltyPercent ?? 5}% resale royalty to you; the game may mint into it`, data, signs: ['new:collection'] }),
      [{ what: 'the collection', bytes: 1 + 32 + 4 + utf8(c.name) + 4 + utf8(c.uri) + 4 + 4 + 140, approx: true }],
    );
    const t = m.currency;
    push(other('associated-token', 'create_idempotent', {}, { payer: owner, account: `ata:owner/${t.key}`, wallet: owner, mint: `mint:${t.key}`, system_program: 'program:system', token_program: tokenProgram(t) }, { id: 'treasury', says: `Open your ${t.symbol} account, the game’s treasury (if you have none)`, data: 1 }), [{ what: `your ${t.symbol} account (if new)`, bytes: t.program === 'token-2022' ? 170 : 165 }]);
    push(
      lootStep('create_game', { authority }, { owner, game, fees: 'pda:fees', collection: 'new:collection', mint: `mint:${t.key}`, treasury: `ata:owner/${t.key}` }, { id: 'game', says: `Open the game on the loot program, priced in ${t.symbol}; ${m.authority === 'owner' ? 'your wallet' : m.authority} signs its decisions` }),
      [{ what: 'the game', bytes: accountBytes.game() }, { what: 'the game’s fee box', bytes: 0 }],
    );
  }

  for (const p of m.pools) {
    const t = m.tokens.get(p.currency);
    push(lootStep('open_pool', { index: p.index }, { owner, game, mint: `mint:${p.currency}`, pool: `pda:pool/${p.index}` }, { id: `pool:${p.key}`, says: `Open the pool “${p.key}” for ${t?.symbol}` }), [{ what: `the pool “${p.key}”`, bytes: poolBytes(t) }]);
  }
  for (const it of m.items) steps.push(partStep.item(it, m));
  for (const b of m.boxes) steps.push(partStep.box(b, m));
  for (const r of m.recipes) steps.push(partStep.recipe(r, m));
  for (const s of m.schedules) steps.push(partStep.schedule(s, m));
  for (const l of m.lotteries) {
    const args = lotteryArgs(l, m);
    push(lootStep('upsert_lottery', { id: l.id, args }, { owner, game, lottery: `pda:lottery/${l.id}` }, { id: `lottery:${l.key}`, says: `Start the lottery “${l.name}”` }), [{ what: `the lottery “${l.name}”`, bytes: accountBytes.lottery() }]);
  }
  for (const s of m.stakes) {
    const staked = m.tokens.get(s.stakes);
    const rewards = m.poolToken(s.rewards);
    push(
      lootStep(
        'open_stake',
        { id: s.id, rewards_pool: m.pool.get(s.rewards)?.index ?? 0, lock: toSeconds(s.lock) },
        { owner, game, stake: `pda:stake/${s.id}`, mint: `mint:${s.stakes}`, rewards_mint: `mint:${rewards?.key}`, staked_vault: `pda:staked/${s.id}`, rewards_vault: `pda:rewards/${s.id}` },
        { id: `stake:${s.key}`, says: `Open the stake “${s.name}”: lock ${staked?.symbol}, earn from “${s.rewards}”` },
      ),
      [
        { what: `the stake “${s.name}”`, bytes: accountBytes.stake() },
        { what: `its vault of ${staked?.symbol}`, bytes: poolBytes(staked) },
        { what: `its vault of ${rewards?.symbol}`, bytes: poolBytes(rewards) },
      ],
    );
  }

  // Seeds: what the creator puts in each pool. SOL is wrapped into the owner's account first.
  const wsol = sol(m);
  const wraps = m.pools.filter((p) => Number(p.seed ?? 0) > 0 && m.tokens.get(p.currency)?.wsol);
  if (wsol && wraps.length) {
    const lamports = wraps.reduce((n, p) => n + toUnits(p.seed, 9), 0n).toString();
    if (!steps.some((s) => s.accounts?.account === `ata:owner/${wsol.key}`))
      push(other('associated-token', 'create_idempotent', {}, { payer: owner, account: `ata:owner/${wsol.key}`, wallet: owner, mint: `mint:${wsol.key}`, system_program: 'program:system', token_program: 'program:token' }, { id: 'wrap', says: 'Open your wrapped SOL account (if you have none)', data: 1 }), [{ what: 'your wrapped SOL account (if new)', bytes: 165 }]);
    push(other('system', 'transfer', { lamports }, { from: owner, to: `ata:owner/${wsol.key}` }, { id: 'wrap', says: `Wrap ${wraps.reduce((n, p) => n + Number(p.seed), 0)} SOL for the seeds`, data: 12 }));
    push(other('spl-token', 'sync_native', {}, { account: `ata:owner/${wsol.key}` }, { id: 'wrap', says: 'Count the wrapped SOL', data: 1 }));
  }
  for (const p of m.pools) {
    if (!(Number(p.seed ?? 0) > 0)) continue;
    const t = m.tokens.get(p.currency);
    if (t.gameMints) {
      const signer = m.authority === 'owner' ? 'owner' : 'authority';
      push(lootStep('issue', { amount: amount(p.seed, t), reference: reference(`seed ${p.key}`) }, { authority: `wallet:${signer}`, game, mint: `mint:${t.key}`, to: `pda:pool/${p.index}`, 'fee.platform': 'pda:platform', 'fee.fees': 'pda:fees' }, { id: `seed:${p.key}`, signer, says: `Mint ${p.seed} ${t.symbol} into “${p.key}”` }));
    } else
      push(lootStep('deposit', { index: p.index, amount: amount(p.seed, t) }, { depositor: owner, game, pool: `pda:pool/${p.index}`, from: `ata:owner/${t.key}`, mint: `mint:${t.key}`, 'fee.platform': 'pda:platform', 'fee.fees': 'pda:fees' }, { id: `seed:${p.key}`, says: `Put ${p.seed} ${t.symbol} into “${p.key}”` }));
  }
  return steps;
}

/** A pool's (or a stake vault's) token account: 165 bytes, more for a Token-2022 mint with extensions. */
export function poolBytes(t) {
  if (t?.program !== 'token-2022') return 165;
  const p = t.powers ?? {};
  // Token-2022 accounts: 165 + 1 account-type byte + each extension the mint asks for (4-byte header + its data).
  const extensions = (p.transferFeePercent > 0 ? 4 + 8 : 0) + (p.transferHook ? 4 + 1 : 0) + (p.pausable ? 4 : 0) + (p.nonTransferable ? 4 : 0);
  return extensions ? 165 + 1 + extensions : 165;
}

/** What each part needs while the game runs: the instruction, and who signs it. */
export function playSteps(economy) {
  const m = model(economy);
  const rows = [];
  const add = (part, ix, signer, says) => rows.push({ part, ix, signer, says });
  for (const it of m.items) if (Number(it.price ?? 0) > 0) add(`item:${it.key}`, 'buy_item', 'player', `buy “${it.name}”`), add(`item:${it.key}`, 'settle', (it.kind ?? 'collectible') === 'collectible' ? 'anyone' : 'owner or authority', 'deliver it');
  for (const b of m.boxes) {
    add(`box:${b.key}`, 'open_box', 'player', `open “${b.name}”`);
    if ((b.outcomes ?? []).some((o) => o.gives === 'item')) add(`box:${b.key}`, 'settle', 'anyone', 'mint the item it rolled');
    if ((b.outcomes ?? []).some((o) => o.gives !== 'item')) add(`box:${b.key}`, 'settle_prize', 'anyone', 'pay, burn or close what it rolled');
  }
  for (const p of m.payments) add(`payment:${p.key}`, 'pay', 'player', `pay “${p.name}”`);
  for (const r of m.recipes) add(`recipe:${r.key}`, 'craft', 'player', `craft “${r.name}”`);
  for (const s of m.schedules) add(`schedule:${s.key}`, 'run_schedule', 'anyone', `run “${s.name ?? s.key}” when it is due`);
  for (const l of m.lotteries) add(`lottery:${l.key}`, 'buy_tickets', 'player', 'buy tickets'), add(`lottery:${l.key}`, 'draw_lottery', 'anyone', 'ask for the draw when it is due'), add(`lottery:${l.key}`, 'pay_lottery', 'anyone', 'pay each place');
  for (const s of m.stakes) add(`stake:${s.key}`, 'stake', 'player', 'stake'), add(`stake:${s.key}`, 'unstake', 'player', 'unstake or collect');
  for (const c of m.contests) {
    add(`contest:${c.key}`, 'open_contest', 'authority', `open “${c.name}”`);
    add(`contest:${c.key}`, 'enter', 'player', 'back a side');
    add(`contest:${c.key}`, 'decide', 'authority', 'name the side that won');
    add(`contest:${c.key}`, 'claim', 'anyone', 'pay a winner');
    add(`contest:${c.key}`, 'call_off', 'authority, or anyone once the result is overdue', 'give every entry its money back');
    add(`contest:${c.key}`, 'close_contest', 'anyone', 'close it once everyone is paid');
  }
  for (const h of m.holds) add(`hold:${h.key}`, 'hold', 'player', `hand in a “${h.item}”`), add(`hold:${h.key}`, 'award', 'authority', 'say where it goes'), add(`hold:${h.key}`, 'take_back', 'anyone', 'send it home when the time is up');
  for (const d of m.decisions) add(`decision:${d.key}`, d.does, 'authority', d.when);
  return rows;
}

export { WSOL };
