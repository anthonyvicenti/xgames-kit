// The compiler: an economy spec → the setup plan, the program's instructions in order, split into transactions
// that fit. And `diff`: only the steps a change needs. Nothing here encodes bytes or signs: a later step maps each
// plan step onto the chain client's instruction builders. Pure.
//
// The plan:
//   { ok: true, program, before: [step], transactions: [{ signer, signers, bytes, steps: [step] }],
//     play: [{ part, ix, signer, says }], warnings, notes }
// A step (steps.mjs): { id, program, ix, args, accounts, signer, signers, says, data, creates }.
//   program: 'loot' for loot 0.3 (ix and args exactly as its IDL names them), or 'system', 'spl-token',
//   'associated-token', 'mpl-core', 'mpl-token-metadata'. `before` holds steps that run outside the plan (a token
//   launched on the curve has its own approval).
// Transaction sizes are estimates that are never below the real size (txsize.mjs says how), packed to leave
// WALLET_ROOM bytes for the wallet's own compute-budget instructions.
import { check } from './check.mjs';
import { model } from './model.mjs';
import { lootStep, partStep, playSteps, setupSteps } from './steps.mjs';
import { BUDGET, MAX_TRANSACTION_BYTES, WALLET_ROOM, transactionSize } from './txsize.mjs';
import { PROGRAM_ID } from './idl.mjs';

/** How many transactions one wallet approval signs (the kit's LIMIT.PublishTransactions). */
export const PER_APPROVAL = 12;
const PROGRAM_ACCOUNT = { loot: 'loot', system: 'system', 'spl-token': 'token', 'associated-token': 'associated-token', 'mpl-core': 'mpl-core', 'mpl-token-metadata': 'token-metadata' };

/** The bytes of a transaction holding `steps`, its fee payer `payer`. */
export function sizeOf(steps, payer) {
  const signers = [payer, ...new Set(steps.flatMap((s) => s.signers).filter((s) => s !== payer))];
  return transactionSize({ signers, instructions: steps.map((s) => ({ program: PROGRAM_ACCOUNT[s.program] ?? s.program, accounts: Object.values(s.accounts), data: s.data })) });
}

/**
 * Packs steps into transactions in order, each as full as BUDGET allows. Steps signed by different keys go in
 * different transactions (each key's wallet approves its own). A step of one instruction that is too big alone is
 * reported in `tooBig`.
 */
export function pack(steps) {
  const transactions = [];
  const tooBig = [];
  let current = null;
  for (const step of steps) {
    const payer = `wallet:${step.signer}`;
    if (sizeOf([step], payer) > MAX_TRANSACTION_BYTES) {
      tooBig.push({ step: step.id, bytes: sizeOf([step], payer) });
      continue;
    }
    if (current && current.signer === step.signer && sizeOf([...current.steps, step], payer) <= BUDGET) current.steps.push(step);
    else transactions.push((current = { signer: step.signer, steps: [step] }));
  }
  for (const tx of transactions) {
    const payer = `wallet:${tx.signer}`;
    tx.signers = [payer, ...new Set(tx.steps.flatMap((s) => s.signers).filter((s) => s !== payer))];
    tx.bytes = sizeOf(tx.steps, payer);
    tx.says = [...new Set(tx.steps.map((s) => s.says))];
  }
  return { transactions, tooBig };
}

function plan(steps, economy, warnings, notes = []) {
  const before = steps.filter((s) => s.alone);
  const { transactions, tooBig } = pack(steps.filter((s) => !s.alone));
  const refusals = tooBig.map((t) => ({
    code: 'E-TX-SIZE',
    where: t.step,
    message: `Setting up ${t.step} takes about ${t.bytes} bytes, more than one transaction holds (${MAX_TRANSACTION_BYTES}), so it cannot be written to the program.`,
    fix: 'Make it smaller: fewer lines, shorter names and keys.',
  }));
  if (refusals.length) return { ok: false, refusals, warnings };
  const out = [...warnings];
  const owners = transactions.filter((t) => t.signer === 'owner').length;
  if (owners > PER_APPROVAL)
    out.push({ code: 'W-TX-MANY', where: 'economy', message: `Going live takes ${owners} transactions, more than one approval signs (${PER_APPROVAL}): your wallet will ask ${Math.ceil(owners / PER_APPROVAL)} times.` });
  for (const tx of transactions)
    if (tx.steps.length === 1 && tx.bytes > BUDGET)
      out.push({ code: 'W-TX-SIZE', where: tx.steps[0].id, message: `Setting up ${tx.steps[0].id} takes about ${tx.bytes} of ${MAX_TRANSACTION_BYTES} bytes: it fits only if your wallet adds nothing of its own.` });
  return {
    ok: true,
    program: PROGRAM_ID,
    budget: { maxBytes: MAX_TRANSACTION_BYTES, walletRoom: WALLET_ROOM, packedTo: BUDGET },
    before,
    transactions,
    play: playSteps(economy),
    warnings: out,
    notes: [...notes, 'Compute units are not counted: setup instructions are small, and each transaction stays under the default limit in the program’s own tests.'],
  };
}

/** The whole setup plan for a spec, or its refusals. `now` (Unix seconds) dates "publish". */
export function compile(economy, { now = Math.floor(Date.now() / 1000), network = 'devnet' } = {}) {
  const verdict = check(economy, { now, network });
  if (!verdict.ok) return { ok: false, refusals: verdict.refusals, warnings: verdict.warnings };
  return plan(setupSteps(economy, { now }), economy, verdict.warnings);
}

// ---------------------------------------------------------------- diff

const LISTS = ['items', 'pools', 'boxes', 'recipes', 'schedules', 'lotteries', 'stakes'];
const ID_FIELD = (list) => (list === 'pools' ? 'index' : 'id');

/** The new spec with each part that was already live keeping its program id, and new parts given free ones. */
export function carryIds(oldSpec, newSpec) {
  const old = model(oldSpec);
  const next = structuredClone(newSpec);
  for (const list of LISTS) {
    const field = ID_FIELD(list);
    const known = new Map((old[list] ?? []).map((x) => [x.key, x[field]]));
    const used = new Set([...(old[list] ?? []).map((x) => x[field]), ...(next[list] ?? []).map((x) => x[field]).filter(Number.isInteger)]);
    let free = list === 'pools' ? 0 : 1;
    for (const part of next[list] ?? []) {
      if (Number.isInteger(part[field])) continue;
      if (known.has(part.key)) part[field] = known.get(part.key);
      else {
        while (used.has(free)) free += 1;
        part[field] = free;
        used.add(free);
      }
    }
  }
  return next;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Only the steps a change from `oldSpec` (what is live) to `newSpec` needs, with notes on what the program cannot
 * change. Parts keep their program ids by key. A part removed is switched off where the program allows it.
 */
export function diff(oldSpec, newSpec, { now = Math.floor(Date.now() / 1000), network = 'devnet' } = {}) {
  const next = carryIds(oldSpec, newSpec);
  const fixedCurrency = { code: 'E-CURRENCY-FIXED', where: 'economy.currency', message: 'The game’s currency is fixed once it is live: every price and the treasury are in it.', fix: 'Keep the currency, and price new boxes in another token with their own "currency".' };
  if (oldSpec?.live?.game && model(oldSpec).currencyKey !== model(next).currencyKey) return { ok: false, refusals: [fixedCurrency], warnings: [] };
  const verdict = check(next, { now, network });
  if (!verdict.ok) return { ok: false, refusals: verdict.refusals, warnings: verdict.warnings };
  if (!oldSpec?.live?.game) return { ...plan(setupSteps(next, { now }), next, verdict.warnings), note: 'Nothing is live yet: the whole setup.' };

  const oldModel = model(carryIds(oldSpec, oldSpec), { now });
  const newModel = model(next, { now });
  const before = new Map(setupSteps(carryIds(oldSpec, oldSpec), { now }).map((s) => [`${s.id}#${s.ix}`, s]));
  const after = setupSteps(next, { now });
  const notes = [];
  const steps = [];
  const refusals = [];
  for (const s of after) {
    const was = before.get(`${s.id}#${s.ix}`);
    if (s.id.startsWith('seed:') || s.id === 'wrap') continue; // seeds are handled below
    if (was && same(was.args, s.args)) continue;
    if (s.alone && was) continue;
    if (was && s.ix === 'open_stake')
      refusals.push({ code: 'E-STAKE-FIXED', where: s.id, message: `The stake ${s.id.slice(6)} is open, and a stake cannot be edited: what stakers agreed to stays what it is (stake.rs).`, fix: 'Leave it as it was, or open a new stake under a new key.' });
    else if (was && s.ix === 'open_pool')
      refusals.push({ code: 'E-POOL-FIXED', where: s.id, message: `The pool ${s.id.slice(5)} is open in its token, which cannot change.`, fix: 'Open a new pool under a new key; an empty pool can be closed.' });
    else if (was && ['create_game', 'create_collection_v2', 'create_idempotent'].includes(s.ix)) notes.push(`${s.id} is already set up; a change to it is not made here.`);
    else {
      if (was && s.ix === 'upsert_lottery') notes.push(`The lottery ${s.id.slice(8)} only takes a change between rounds, while no tickets are sold (lottery.rs RoundRunning).`);
      if (was && s.ix === 'upsert_item') notes.push(`The item ${s.id.slice(5)} keeps its kind, name, life, soulbound and burnable once any is issued (catalog.rs KindLocked).`);
      if (was && s.ix === 'upsert_box') notes.push(`Orders paid before the box ${s.id.slice(4)} changed are refunded, not rolled on the new one (catalog.rs).`);
      steps.push(s);
    }
  }
  // Removed parts: switched off where the program lets them be (an item, box, recipe or schedule has no close).
  // A part already switched off when it was removed stays in what is live (its number is never reused): nothing to do.
  const removed = (list) => (oldModel[list] ?? []).filter((x) => x.active !== false && !(newModel[list] ?? []).some((y) => y.key === x.key));
  for (const [list, kind] of [['items', 'item'], ['boxes', 'box'], ['recipes', 'recipe'], ['schedules', 'schedule']])
    for (const part of removed(list)) {
      const step = partStep[kind]({ ...part, active: false }, oldModel);
      steps.push({ ...step, creates: [], says: `${step.says} (its account stays; the program has no close for it)` });
    }
  for (const p of removed('pools')) {
    const accounts = { owner: 'wallet:owner', game: 'pda:game', pool: `pda:pool/${p.index}`, mint: `mint:${p.currency}` };
    steps.push({ ...lootStep('close_pool', { index: p.index }, accounts, { id: `pool:${p.key}`, says: `Close the pool “${p.key}” and get its rent back` }), creates: [] });
    notes.push(`The pool “${p.key}” closes only when it holds nothing (game.rs PoolNotEmpty).`);
  }
  for (const l of removed('lotteries')) notes.push(`The lottery “${l.key}” cannot be switched off or closed: it keeps its schedule. Leave its pot empty, or keep it in the spec.`);
  for (const s of removed('stakes')) notes.push(`The stake “${s.key}” cannot be closed: stakers can always unstake.`);
  // Seeds: only what was added.
  for (const p of newModel.pools) {
    const was = oldModel.pool.get(p.key);
    const more = Number(p.seed ?? 0) - Number(was?.seed ?? 0);
    if (more > 0) {
      const step = setupSteps({ ...next, pools: next.pools.map((x) => (x.key === p.key ? { ...x, seed: more } : { ...x, seed: 0 })) }, { now }).filter((s) => s.id === `seed:${p.key}` || s.id === 'wrap');
      steps.push(...step);
      notes.push(`“${p.key}”: ${more} more put in (the seed went from ${Number(was?.seed ?? 0)} to ${Number(p.seed)}).`);
    } else if (more < 0) notes.push(`“${p.key}”: a smaller seed takes nothing back out; only the authority can pay out of a pool.`);
  }
  if (oldModel.authority !== newModel.authority) {
    const update = { authority: newModel.authority === 'owner' ? '@wallet:owner' : newModel.authority, paused: null };
    const accounts = { owner: 'wallet:owner', game: 'pda:game', treasury: `ata:owner/${newModel.currencyKey}` };
    steps.push({ ...lootStep('update_game', { update }, accounts, { id: 'game', says: 'Hand the game’s decisions to the new authority' }), creates: [] });
  }
  if (refusals.length) return { ok: false, refusals, warnings: verdict.warnings };
  return { ...plan(steps, next, verdict.warnings, notes), spec: next };
}
