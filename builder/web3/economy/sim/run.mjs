// The full simulation's run: an economy put live on the local chain through the kit's own publish code (publishPlan,
// planToInstructions, recordLanded), then players doing the scenario's actions through the in-game kit's own calls
// (econ/play.js: openBox, buy, pay, craft, buyTickets, claim), a keeper running schedules and drawing lotteries when
// they are due, and the clock moved forward day by day. Every landed transaction goes through a ledger that names
// each account it touched (a player, a pool, the treasury, a stake's vaults, the platform, the oracle's queue) and
// adds up what moved. `measure()` turns that into the numbers the quick simulation reports.
import { encodeBase58 } from '../../gf-web3/chain/base58.js';
import { parseCoreAsset } from '../../gf-web3/chain/core.js';
import { ata, burnIx, decodeLoot, issueIx, LOOT_PROGRAM, LootAccount, lootPda, payoutIx, rollIx, runScheduleIx, VRF_QUEUE } from '../../gf-web3/chain/loot.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../../gf-web3/chain/pda.js';
import { createAssociatedTokenAccountIdempotent, meta } from '../../gf-web3/chain/programs.js';
import { transferExtras } from '../../gf-web3/chain/token2022.js';
import { economyPlay } from '../../gf-web3/econ/play.js';
import { planToInstructions, publishPlan, recordLanded, resolver, specOf } from '../../node/economy.mjs';
import { model, toUnits, WSOL } from '../model.mjs';
import { lootName, newAddress, seeded, SIGNATURE_LAMPORTS, simChain } from './chain.mjs';

const DAY = 86_400;
const DEFAULT_PER_DAY = 100;
const SOL = 1_000_000_000n;
/** Kinds of scenario entries a player does, and the ones the full simulation cannot play yet. */
const PLAYED = new Set(['box', 'item', 'payment', 'recipe', 'lottery', 'stake']);
const NOT_YET = { hold: 'a hold needs the authority to award it, which the simulation does not play yet', contest: 'a contest needs the authority to open and decide it, which the simulation does not play yet' };
const TARGET = (s) => typeof s === 'string' && /^(account|holder):/.test(s);
/** A decision the simulation carries out as the authority: a payout or a burn from a pool, or a roll. */
const playable = (d) => d.does === 'roll' || ((d.does === 'payout' || d.does === 'burn') && d.pool);

/** Every `account:` and `holder:` address a spec names. */
function namedTargets(spec) {
  const out = new Set();
  JSON.stringify(spec, (k, v) => {
    if (TARGET(v)) out.add(v);
    return v;
  });
  return [...out].map((s) => ({ kind: s.split(':')[0], address: s.slice(s.indexOf(':') + 1) }));
}

/** The devnet addresses a spec needs on the local chain: existing tokens' mints, accounts, holders' collectibles. */
export function externalAddresses(economy) {
  const spec = specOf(economy);
  const out = new Set();
  for (const t of spec.tokens ?? []) if (t.source === 'existing' && t.mint) out.add(t.mint);
  for (const t of namedTargets(spec)) out.add(t.address);
  return [...out];
}

/** How many of each player action a day: the scenario's, or the quick simulation's default of 100. */
function wanted(m) {
  const per = (kind, key) => Number(m.scenario.perDay?.[`${kind}:${key}`] ?? DEFAULT_PER_DAY);
  const rows = [];
  for (const b of m.boxes) rows.push(['box', b.key, per('box', b.key)]);
  for (const it of m.items) if (Number(it.price ?? 0) > 0) rows.push(['item', it.key, per('item', it.key)]);
  for (const p of m.payments) rows.push(['payment', p.key, per('payment', p.key)]);
  for (const r of m.recipes) rows.push(['recipe', r.key, per('recipe', r.key)]);
  for (const l of m.lotteries) rows.push(['lottery', l.key, per('lottery', l.key)]);
  for (const s of m.stakes) rows.push(['stake', s.key, per('stake', s.key)]);
  for (const h of m.holds) rows.push(['hold', h.key, per('hold', h.key)]);
  for (const c of m.contests) rows.push(['contest', c.key, per('contest', c.key)]);
  for (const d of m.decisions) if (Number(d.perDay) > 0) rows.push(['decision', d.key, Number(d.perDay)]);
  return rows.map(([kind, key, perDay]) => ({ kind, key, label: `${kind}:${key}`, perDay }));
}

const addTo = (map, key, amount) => {
  if (amount) map.set(key, (map.get(key) ?? 0n) + amount);
};

/**
 * Runs one economy. `externals`: devnet accounts by address (cache.mjs devnetAccounts). Returns the raw measurements
 * (`measure()` in report.mjs reads them) and the counts of what was wanted, done and refused.
 */
export async function runFull(economy, { LiteSVM, Rent, bins, externals = {}, players: playerCount = 20, days, seed = 'gamesfun', start = Math.floor(Date.now() / 1000), log = () => {}, debugErrors = false, onTx }) {
  const random = seeded(seed);
  const pick = (n) => Number(BigInt(`0x${Buffer.from(random(6)).toString('hex')}`) % BigInt(n));
  const spec = structuredClone(specOf(economy));
  const m0 = model(spec);
  const D = Number(days ?? m0.scenario.days ?? 30);
  spec.scenario = { ...(spec.scenario ?? {}), days: D };

  // ---- who is who
  const owner = newAddress(random);
  const keeper = newAddress(random);
  const authority = m0.authority === 'owner' ? owner : m0.authority;
  const players = Array.from({ length: playerCount }, () => newAddress(random));
  const playerSet = new Set(players);

  // ---- the ledger: every landed transaction, by what it was for
  const roles = new Map(); // address → category ("pool:house", "treasury", ...)
  const mintToken = new Map(); // mint → token key
  const decimals = new Map(); // mint → decimals
  const ledger = { byLabel: new Map(), txs: 0 };
  const row = (label) => {
    if (!ledger.byLabel.has(label))
      ledger.byLabel.set(label, { txs: 0, signatures: 0, network: new Map(), pay: new Map(), get: new Map(), rewards: new Map(), burned: new Map(), minted: new Map(), in: new Map(), out: new Map(), platform: new Map(), oracle: new Map(), rent: new Map() });
    return ledger.byLabel.get(label);
  };
  const categoryOf = (address, entry) => {
    if (roles.has(address)) return roles.get(address);
    const holder = entry?.token?.owner;
    if (holder) {
      if (playerSet.has(holder)) return 'players';
      if (holder === keeper) return 'keeper';
      if (holder === owner) return 'owner';
      if (holder === authority) return 'authority';
      return `other:${holder}`;
    }
    if (playerSet.has(address)) return 'players';
    return null;
  };
  const isRentAccount = (entry) => entry && (entry.owner === LOOT_PROGRAM || entry.owner === 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
  const onSent = (t) => {
    onTx?.(t);
    ledger.txs += 1;
    const r = row(t.label.replace(/ \(oracle\)$/, ''));
    r.txs += 1;
    r.signatures += t.signatures;
    addTo(r.network, t.role, BigInt(t.signatures) * SIGNATURE_LAMPORTS);
    for (const k of t.keys) {
      const b = t.before.get(k);
      const a = t.after.get(k);
      if (a?.token || b?.token || a?.mint || b?.mint) continue;
      const dl = (a?.lamports ?? 0n) - (b?.lamports ?? 0n);
      if (k === lootPda.platform()) addTo(r.platform, t.role, dl);
      else if (k === VRF_QUEUE) addTo(r.oracle, t.role, dl);
      else if (isRentAccount(a) || isRentAccount(b)) addTo(r.rent, t.role, dl);
    }
    const names = t.instructions.map((ix) => lootName(ix)?.name).filter(Boolean);
    const staking = names.some((n) => n === 'stake' || n === 'unstake');
    const cat = (address) => (address ? (categoryOf(address, t.after.get(address) ?? t.before.get(address)) ?? `other:${address}`) : null);
    for (const mv of t.moves) {
      const [from, to] = [cat(mv.from), cat(mv.to)];
      if (from) addTo(r.out, `${from}|${mv.mint}`, mv.amount);
      if (to) addTo(r.in, `${to}|${mv.mint}`, mv.amount);
      if (mv.kind === 'burn') addTo(r.burned, mv.mint, mv.amount);
      if (mv.kind === 'mint') addTo(r.minted, mv.mint, mv.amount);
      // What players paid and got: money crossing between a player and anything else. A stake's principal going in
      // and coming back is neither; its rewards are what players got.
      if (from === 'players' && to !== 'players' && !(staking && to?.startsWith('staked:'))) addTo(r.pay, mv.mint, mv.amount);
      if (to === 'players' && from !== 'players' && !from?.startsWith('staked:')) addTo(r.get, mv.mint, mv.amount);
      if (to === 'players' && from?.startsWith('rewards:')) addTo(r.rewards, mv.mint, mv.amount);
    }
  };

  const chain = simChain({ LiteSVM, Rent, bins, start, random, onSent });
  for (const a of [owner, keeper, ...players]) chain.fund(a, 10_000_000n * SOL);
  if (authority !== owner) chain.fund(authority, 10_000_000n * SOL);

  // ---- devnet accounts the spec names, and a mint for a token still to launch on the curve
  for (const [address, account] of Object.entries(externals)) if (account) chain.put(address, account);
  const curveMints = {};
  for (const t of spec.tokens ?? []) {
    if (t.source !== 'curve' || (t.mint && !t.mint.startsWith('@'))) continue;
    const mint = newAddress(random);
    const data = new Uint8Array(82);
    data[44] = t.decimals ?? 6;
    data[45] = 1; // initialized; no mint authority, no freeze authority, supply 0
    chain.put(mint, { owner: TOKEN_PROGRAM, lamports: chain.rent(82), data });
    t.mint = mint;
    curveMints[t.key] = mint;
  }
  const missing = (spec.tokens ?? []).filter((t) => t.source === 'existing' && !chain.get(t.mint));
  if (missing.length) throw new Error(`Devnet has no mint ${missing.map((t) => t.mint).join(', ')} (${missing.map((t) => t.key).join(', ')}).`);

  /** Give `holder` `units` base units of `mint`: its token account is made by the real program, then credited. */
  function credit(holder, mint, units) {
    if (mint === WSOL || mint === NATIVE_MINT) return;
    const program = chain.get(mint).owner;
    chain.send(holder, [createAssociatedTokenAccountIdempotent(holder, holder, mint, program)], { label: 'setup', role: 'setup' });
    const address = ata(holder, mint, program);
    const a = chain.get(address);
    const data = Uint8Array.from(a.data);
    const view = new DataView(data.buffer);
    view.setBigUint64(64, view.getBigUint64(64, true) + BigInt(units), true);
    chain.put(address, { ...a, data });
    const mintAccount = chain.get(mint);
    const md = Uint8Array.from(mintAccount.data);
    const mv = new DataView(md.buffer);
    mv.setBigUint64(36, mv.getBigUint64(36, true) + BigInt(units), true);
    chain.put(mint, { ...mintAccount, data: md });
  }
  const plenty = (t) => 10n ** BigInt((t.decimals ?? 6) + 12);
  for (const t of spec.tokens ?? []) if (t.source === 'existing' || t.source === 'curve') for (const who of [owner, ...(authority !== owner ? [authority] : [])]) credit(who, t.mint, plenty(t));

  // ---- put it live, as the Economy tab's flow does
  const { plan, next } = publishPlan(spec, { now: start });
  if (!plan.ok) throw new Error(`The economy does not compile: ${plan.refusals.map((r) => r.message).join(' ')}`);
  const keys = {};
  for (const tx of plan.transactions) for (const name of tx.signers) if (name.startsWith('new:') && !keys[name]) keys[name] = newAddress(random);
  const ctxBuild = { economy: next, owner, authority, keys, rpc: chain.rpc, rent: chain.rent, collection: keys['new:collection'] ?? spec.live?.collection, mints: curveMints };
  const built = await planToInstructions(plan, ctxBuild);
  const resolve = resolver(ctxBuild);
  const treasury = resolve(`ata:owner/${model(next).currencyKey}`);
  const mints = Object.fromEntries(Object.entries(keys).filter(([n]) => n.startsWith('new:mint/')).map(([n, k]) => [n.slice('new:mint/'.length), k]));
  let config = { economy: structuredClone(spec) };
  for (const tx of built.transactions) {
    const payer = tx.signer === 'owner' ? owner : authority;
    const signature = chain.send(payer, tx.instructions, { label: 'setup', role: 'setup' });
    config = recordLanded(config, { signature, steps: tx.stepList, next, owner, collection: ctxBuild.collection, treasury, authority: resolve('@wallet:authority'), mints, at: new Date(start * 1000).toISOString() });
  }
  const live = config.economy;
  const m = model(live);
  const game = live.live.game;
  log(`Live on the local chain: game ${game}, ${built.transactions.length} setup transaction(s).`);

  // ---- name every account the ledger will see
  for (const t of m.tokens.values()) {
    const mint = t.wsol ? WSOL : t.mint;
    if (!mint) continue;
    mintToken.set(mint, t.key);
    decimals.set(mint, t.decimals);
    const program = t.program === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
    roles.set(ata(game, mint, program), 'vault');
  }
  roles.set(live.live.treasury, 'treasury');
  // Token accounts that live only inside one transaction (a player's wrapped SOL) are named by their address.
  for (const [mint] of mintToken) {
    const program = mint === WSOL ? TOKEN_PROGRAM : chain.get(mint)?.owner ?? TOKEN_PROGRAM;
    for (const p of players) roles.set(ata(p, mint, program), 'players');
    roles.set(ata(keeper, mint, program), 'keeper');
    if (!roles.has(ata(owner, mint, program))) roles.set(ata(owner, mint, program), 'owner');
  }
  for (const p of m.pools) roles.set(lootPda.pool(game, p.index), `pool:${p.key}`);
  for (const s of m.stakes) {
    const stake = lootPda.stake(game, s.id);
    roles.set(lootPda.staked(stake), `staked:${s.key}`);
    roles.set(lootPda.rewards(stake), `rewards:${s.key}`);
  }
  for (const c of m.contests) roles.set(lootPda.pot(lootPda.contest(game, c.id)), `pot:${c.key}`);
  for (const target of namedTargets(spec)) {
    if (target.kind === 'account') roles.set(target.address, `account:${target.address}`);
    else {
      const asset = chain.get(target.address);
      const holder = asset ? parseCoreAsset(asset.data).owner : null;
      if (!holder) continue;
      // The holder's token accounts must exist for a share to reach them: made here, as their wallet would have.
      for (const t of m.tokens.values()) {
        const mint = t.wsol ? WSOL : t.mint;
        if (!mint || !chain.get(mint)) continue;
        const program = chain.get(mint).owner;
        chain.fund(holder, SOL);
        chain.send(holder, [createAssociatedTokenAccountIdempotent(holder, holder, mint, program)], { label: 'setup', role: 'setup' });
        roles.set(ata(holder, mint, program), `holder:${target.address}`);
      }
    }
  }

  // ---- players' tokens: what they bring from outside the game (an existing coin, the game's curve token)
  for (const t of m.tokens.values()) if (t.source === 'existing' || t.source === 'curve') for (const p of players) credit(p, t.mint, plenty(t));

  // ---- the in-game kit's economy calls, on the local chain
  let current = players[0];
  let label = 'setup';
  let role = 'player';
  const economyCalls = economyPlay({
    ready: async () => ({ economy: live }),
    connect: async () => current,
    address: () => current,
    rpc: () => chain.rpc,
    send: async (player, instructions) => chain.send(player, instructions, { label, role }),
    mock: () => false,
    emit: () => {},
    say: () => {},
    rollPollMs: 0,
    now: () => chain.now(),
  });

  const counts = new Map(); // label → { wanted, done, refused: Map(reason → n), outcomes: Map }
  const countRow = (l) => counts.get(l) ?? counts.set(l, { wanted: 0, done: 0, refused: new Map(), outcomes: new Map(), realCost: [] }).get(l);
  // Refusals grouped by their words, numbers left out ("ready again in 5 hours" and "in 7 hours" are one reason).
  const refuse = (c, error) => {
    if (debugErrors && error?.logs?.length) console.error(error.message, error.logs.slice(-8));
    const inner = error?.logs?.find((l) => /^Program log: (Error|AnchorError)/.test(l));
    const words = `${String(error?.message ?? error).split('\n')[0]}${inner && !String(error?.message).includes('AnchorError') ? ` (${inner.replace(/^Program log: /, '')})` : ''}`;
    addTo(c.refused, words.slice(0, 200).replace(/\b\d+(\.\d+)?\b/g, 'N'), 1n);
  };

  // Stakers: the scenario's staked amount, shared by up to five players at the start.
  const stakers = new Map();
  for (const s of m.stakes) {
    const total = Number(m.scenario.staked?.[s.key] ?? 0);
    const who = players.slice(0, Math.min(5, players.length));
    stakers.set(s.key, who);
    if (!total) continue;
    const t = m.tokens.get(s.stakes);
    for (const p of who) {
      current = p;
      label = `setup: stake:${s.key}`;
      const amount = (total / who.length).toFixed(Math.min(6, t?.decimals ?? 0));
      try {
        if (t?.source === 'game') {
          // A token the game mints: the authority issues the staker's share first (outside the economy's own flows).
          const ix = issueIx({ authority, game, mint: t.mint, to: ata(p, t.mint), amount: toUnits(amount, t.decimals) });
          chain.send(authority, [createAssociatedTokenAccountIdempotent(authority, p, t.mint), ix], { label: 'setup', role: 'setup' });
        }
        await economyCalls.stake(s.key, { amount });
      } catch (error) {
        refuse(countRow(`stake:${s.key} (start)`), error);
      }
    }
  }

  // ---- the keeper: runs every schedule that is due and draws every lottery that is due
  const dueTimes = () => {
    const times = [];
    for (const s of m.schedules) {
      const a = chain.get(lootPda.schedule(game, s.id));
      if (!a) continue;
      const x = decodeLoot(LootAccount.Schedule, a.data);
      if (x.active && (!x.max_runs || x.runs < x.max_runs)) times.push({ at: Number(x.next_at), kind: 'schedule', part: s, x });
    }
    for (const l of m.lotteries) {
      const a = chain.get(lootPda.lottery(game, l.id));
      if (!a) continue;
      const x = decodeLoot(LootAccount.Lottery, a.data);
      times.push({ at: Number(x.draws_at), kind: 'lottery', part: l, x });
    }
    return times.sort((a, b) => a.at - b.at);
  };
  async function keep(due) {
    current = keeper;
    role = 'keeper';
    if (due.kind === 'schedule') {
      label = `schedule:${due.part.key}`;
      const action = due.x.action;
      let remaining;
      if (action.Issue) remaining = [meta(action.Issue.mint, false, true), meta(lootPda.pool(game, action.Issue.pool), false, true)];
      else if (action.Burn) {
        const pool = lootPda.pool(game, action.Burn.pool);
        const mint = encodeBase58(chain.get(pool).data.subarray(0, 32));
        remaining = [meta(mint, false, true), meta(pool, false, true)];
      } else {
        const [from, to] = [lootPda.pool(game, action.Move.from), lootPda.pool(game, action.Move.to)];
        const mint = encodeBase58(chain.get(from).data.subarray(0, 32));
        remaining = [meta(from, false, true), meta(to, false, true), meta(mint, false, false), ...(await transferExtras(chain.rpc, mint, [{ source: from, destination: to, authority: game, amount: 0n }]))];
      }
      chain.send(keeper, [runScheduleIx({ game, id: due.part.id, remaining })], { label, role });
    } else {
      label = `lottery:${due.part.key} (draw)`;
      await economyCalls.claim(`lottery:${due.part.key}`);
    }
    role = 'player';
  }
  /** A keeper call that failed is tried again an hour later, not on every event. */
  const retryAt = new Map();
  async function catchUp(until) {
    for (let guard = 0; guard < 100_000; guard++) {
      const next = dueTimes()
        .map((d) => ({ ...d, at: Math.max(d.at, retryAt.get(`${d.kind}:${d.part.key}`) ?? 0) }))
        .sort((a, b) => a.at - b.at)
        .find((d) => d.at <= until);
      if (!next) return;
      chain.warp(Math.max(chain.now(), next.at));
      const c = countRow(next.kind === 'schedule' ? `schedule:${next.part.key}` : `lottery:${next.part.key} (draw)`);
      try {
        await keep(next);
        c.done += 1;
      } catch (error) {
        refuse(c, error);
        role = 'player';
        retryAt.set(`${next.kind}:${next.part.key}`, chain.now() + 3600);
      }
    }
  }

  // ---- the day's actions, spread evenly
  const rows = wanted(m);
  const events = [];
  for (const r of rows) {
    const total = Math.floor(r.perDay * D + 1e-9);
    countRow(r.label).wanted = total;
    for (let k = 0; k < total; k++) events.push({ at: start + ((k + 0.5) * DAY) / r.perDay, ...r });
  }
  events.sort((a, b) => a.at - b.at);
  const isPlayed = (r) => PLAYED.has(r.kind) || (r.kind === 'decision' && playable(m.decisions.find((d) => d.key === r.key)));
  const notPlayed = rows.filter((r) => !isPlayed(r)).map((r) => ({ label: r.label, why: NOT_YET[r.kind] ?? `a decision that does “${m.decisions.find((d) => d.key === r.key)?.does}” needs what only the game knows (an open contest, a held collectible), which the simulation does not play yet` }));
  const daily = []; // end-of-day pool balances
  const poolBalance = (p) => chain.rpc.tokenBalance(lootPda.pool(game, p.index));
  const snapshotDay = async (day) => daily.push({ day, pools: Object.fromEntries(await Promise.all(m.pools.map(async (p) => [p.key, String(await poolBalance(p))]))) });
  await snapshotDay(0);
  let day = 1;
  let lastLog = 0;
  for (const ev of events) {
    while (ev.at >= start + day * DAY) {
      await catchUp(start + day * DAY);
      chain.warp(start + day * DAY);
      await snapshotDay(day);
      day += 1;
    }
    await catchUp(ev.at);
    chain.warp(ev.at);
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      log(`Day ${((ev.at - start) / DAY).toFixed(2)} of ${D}: ${ledger.txs} transactions so far.`);
    }
    if (!isPlayed(ev)) continue;
    const c = countRow(ev.label);
    label = ev.label;
    role = 'player';
    try {
      if (ev.kind === 'decision') await decide(ev);
      else if (ev.kind === 'recipe') await craftByAnyone(ev, c);
      else {
        current = ev.kind === 'stake' ? (stakers.get(ev.key) ?? players)[pick((stakers.get(ev.key) ?? players).length)] : players[pick(players.length)];
        // SOL in the wallet, wrapped SOL included: a lottery prize paid by someone else stays wrapped until the
        // player's next SOL purchase unwraps it with the purchase's own wrapped account.
        const solOf = (who) => (chain.get(who)?.lamports ?? 0n) + (chain.get(ata(who, WSOL))?.lamports ?? 0n);
        const before = solOf(current);
        const result = await act(ev);
        if (ev.kind === 'box') {
          const outcome = result.outcome ?? {};
          addTo(c.outcomes, outcome.kind === 'item' ? `item:${outcome.item}` : outcome.kind === 'prize' ? `prize:${outcome.units}` : outcome.kind, 1n);
          const prizeSol = outcome.kind === 'prize' && m.poolToken(outcome.pool)?.wsol ? BigInt(outcome.units) : 0n;
          c.realCost.push(before - solOf(current) + prizeSol);
        }
      }
      c.done += 1;
    } catch (error) {
      refuse(c, error);
    }
  }
  while (day <= D) {
    await catchUp(start + day * DAY);
    chain.warp(start + day * DAY);
    await snapshotDay(day);
    day += 1;
  }

  async function act(ev) {
    if (ev.kind === 'box') return economyCalls.openBox(ev.key);
    if (ev.kind === 'item') return economyCalls.buy(ev.key);
    if (ev.kind === 'payment') return economyCalls.pay(ev.key);
    if (ev.kind === 'lottery') return economyCalls.buyTickets(ev.key, { count: 1 });
    if (ev.kind === 'stake') return economyCalls.claim(`stake:${ev.key}`);
    throw new Error(`No player action for ${ev.kind}.`);
  }

  /** A recipe: the first player (from a random one on) who holds what it takes. */
  async function craftByAnyone(ev, c) {
    const from = pick(players.length);
    let last;
    for (let i = 0; i < players.length; i++) {
      current = players[(from + i) % players.length];
      try {
        return await economyCalls.craft(ev.key);
      } catch (error) {
        last = error;
        if (error.logs) throw error; // the program refused it: that is a result, not a missing input
      }
    }
    throw last;
  }

  /** A decision with a rate: the authority pays out (to a player) or burns from a pool, or rolls. */
  async function decide(ev) {
    const d = m.decisions.find((x) => x.key === ev.key);
    role = 'authority';
    try {
      if (d.does === 'roll') return chain.send(authority, [rollIx({ authority, game, reference: random(32) })], { label: ev.label, role });
      const pool = m.pool.get(d.pool);
      if (!pool) throw new Error(`The decision ${d.key} names no pool the simulation can read.`);
      const t = m.tokens.get(pool.currency);
      const mint = t.wsol ? WSOL : t.mint;
      const program = chain.get(mint).owner;
      const holds = await chain.rpc.tokenBalance(lootPda.pool(game, pool.index));
      const amount = d.percent !== undefined ? (holds * BigInt(Math.round(Number(d.percent) * 100))) / 10_000n : toUnits(d.amount, t.decimals);
      if (d.does === 'burn') return chain.send(authority, [burnIx({ authority, game, index: pool.index, mint, amount, reference: random(32) })], { label: ev.label, role });
      const to = players[pick(players.length)];
      return chain.send(authority, [createAssociatedTokenAccountIdempotent(authority, to, mint, program), payoutIx({ authority, game, index: pool.index, mint, to: ata(to, mint, program), amount, reference: random(32) })], { label: ev.label, role });
    } finally {
      role = 'player';
    }
  }

  return { live, game, start, days: D, players: players.length, ledger, counts, daily, notPlayed, mintToken, decimals, transactions: ledger.txs, setupTransactions: built.transactions.length };
}

