// A decision: what only the game knows (who cleared the level, which side won, where a held collectible goes), turned
// into the loot program's authority instructions and checked against the economy's rules first. One builder for the
// studio page (the creator's wallet signs) and the local keeper (a key file on the creator's machine signs).
//
//   readRequest(input)                 a request, checked for shape: { decision, id?, to?, amount?, percent?, side?,
//                                      asset?, open?, attempt?, says? }
//   prepareDecision({ economy, request, rpc, signer, ledger, now })
//       → { ok, refusals, notes, says, numbers, decision, instructions, signers, reference, record }
//   decisionsOf(economy)               what the spec lets the authority decide (its decisions, contests and holds)
//   waitingDecisions({ economy, rpc }) what is waiting now: open contests, collectibles on hold
//   the ledger                         every decision, done or refused, one JSON line each (.gamesfun/web3/decisions/)
//
// A request is a claim. It comes from the game, and a game runs in the player's browser: anyone there can post one. So
// a decision with `proof` acts only on a payment the receiver made on chain for it (a `pay` of the economy's payment,
// in full, split as the spec says), never claimed before, at least `proof.after` old; and `caps` bound what any claim
// moves (each, per receiver a day, in all a day). Caps and proof are the page's and the keeper's own rules: the program
// trusts the authority's signature and checks nothing else ("we always trust project auth").
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeBase58, encodeBase58, isAddress } from '../gf-web3/chain/base58.js';
import { decodeBorsh } from '../gf-web3/chain/borsh.js';
import { fromBase64, toHex } from '../gf-web3/chain/bytes.js';
import { parseCoreAsset } from '../gf-web3/chain/core.js';
import { awardIx, burnIx, decideIx, decodeLoot, issueIx, LOOT_IDL, LOOT_PROGRAM, LootAccount, lootEvents, lootPda, makeIx, openContestIx, payoutIx, shareAccounts } from '../gf-web3/chain/loot.js';
import { associatedTokenAddress, NATIVE_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../gf-web3/chain/pda.js';
import { createAssociatedTokenAccountIdempotent } from '../gf-web3/chain/programs.js';
import { transferExtras } from '../gf-web3/chain/token2022.js';
import { readMessage, readTransaction } from '../gf-web3/chain/tx.js';
import { readTokenAccount } from '../gf-web3/econ/chain.js';
import { sharesFor } from '../gf-web3/econ/play.js';
import { readEconomy as readSpec } from '../gf-web3/econ/spec.js';
import { findSecrets } from '../economy/check.mjs';
import { fromUnits, model, toSeconds, toUnits } from '../economy/model.mjs';
import { freshKeypair, keypairFromSecret } from './ed25519.mjs';

export const DAY = 24 * 60 * 60;
/** What a decision costs its signer besides the network fee: the program's project fee (PROJECT_FEE_LAMPORTS). */
export const PROJECT_FEE = 10_000n;
/** The least SOL a signer should hold to send a decision: fees and a receiver's first token account. */
export const SIGNER_MIN_LAMPORTS = 3_000_000n;
const RECENT_PAYOUTS = 25;
const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;

const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
const big = (v) => BigInt(v ?? 0);
const refusal = (code, message, fix) => ({ code, message, fix });
const hex32 = (text) => createHash('sha256').update(text).digest();

// ---------------------------------------------------------------- the request

/** A 64-byte value that is a Solana secret key (its second half is the public key of its first). */
function isSecretKey(bytes) {
  if (bytes.length !== 64) return false;
  try {
    return keypairFromSecret(bytes).address === encodeBase58(bytes.subarray(32));
  } catch {
    return false;
  }
}
/** A request as the page, the CLI, an agent or a game sends it, checked for shape. Throws a plain error. */
export function readRequest(input) {
  const r = input && typeof input === 'object' ? input : {};
  const { attempt, ...rest } = r;
  if (findSecrets(rest, 'request').length) throw new Error('That looks like a private key. A decision only ever names public addresses: never send a key.');
  const out = {};
  const decision = String(r.decision ?? r.decide ?? '').trim();
  const [kind, key] = decision.includes(':') ? decision.split(':', 2) : ['decision', decision];
  if (!KEY.test(key) || !['decision', 'contest', 'hold'].includes(kind)) throw new Error('Name the decision: a key from the economy’s "decisions", or "contest:<key>" or "hold:<key>".');
  out.decision = decision;
  if (r.id !== undefined && r.id !== '') {
    if (!ID.test(String(r.id))) throw new Error('"id" is the game’s own name for this result: up to 64 letters, digits and . _ : -');
    out.id = String(r.id);
  }
  if (r.to !== undefined && r.to !== '') {
    if (!isAddress(String(r.to))) throw new Error('"to" must be a wallet’s public address.');
    out.to = String(r.to);
  }
  if (r.asset !== undefined && r.asset !== '') {
    if (!isAddress(String(r.asset))) throw new Error('"asset" must be the held collectible’s address.');
    out.asset = String(r.asset);
  }
  if (r.amount !== undefined && r.amount !== '') {
    if (!/^\d{1,20}(\.\d{1,18})?$/.test(String(r.amount))) throw new Error('"amount" must be a number of whole units, like 0.5.');
    out.amount = String(r.amount);
  }
  if (r.percent !== undefined && r.percent !== '') {
    const p = Number(r.percent);
    if (!(p > 0 && p <= 100)) throw new Error('"percent" must be more than 0 and at most 100.');
    out.percent = p;
  }
  if (r.side !== undefined && r.side !== '') {
    const s = Number(r.side);
    if (!Number.isInteger(s) || s < 0 || s > 254) throw new Error('"side" is the winning side’s number, from 0.');
    out.side = s;
  }
  if (r.open === true || r.open === 'true' || r.open === '1') out.open = true;
  if (attempt !== undefined && attempt !== '') {
    let bytes;
    try {
      bytes = decodeBase58(String(attempt));
    } catch {
      bytes = null;
    }
    if (bytes && isSecretKey(bytes)) throw new Error('"attempt" is a private key, not a transaction. Never send a key; move that wallet’s funds to a new one.');
    if (!bytes || bytes.length !== 64) throw new Error('"attempt" must be the signature of the transaction that paid for the attempt.');
    out.attempt = String(attempt);
  }
  if (r.says !== undefined) out.says = String(r.says).replace(/\s+/g, ' ').slice(0, 140);
  return out;
}

// ---------------------------------------------------------------- what the spec lets the authority decide

/** A decision from the spec, or a contest's or a hold's: { key, does, contest?, hold?, pool?, ... } or null. */
export function findDecision(economy, decision, request = {}) {
  const m = model(economy);
  const [kind, key] = decision.includes(':') ? decision.split(':', 2) : ['decision', decision];
  if (kind === 'decision') return m.decisions.find((d) => d.key === key) ?? null;
  if (kind === 'contest' && m.contest.has(key)) {
    const named = m.decisions.find((d) => d.contest === key && d.does === (request.open ? 'open_contest' : 'decide'));
    return { ...(named ?? {}), key: decision, does: request.open ? 'open_contest' : 'decide', contest: key, when: named?.when ?? (request.open ? `opening “${m.contest.get(key).name}”` : `naming who won “${m.contest.get(key).name}”`) };
  }
  if (kind === 'hold' && m.hold.has(key)) {
    const named = m.decisions.find((d) => d.hold === key && d.does === 'award');
    return { ...(named ?? {}), key: decision, does: 'award', hold: key, when: named?.when ?? `saying where “${m.hold.get(key).name}”’s collectible goes` };
  }
  return null;
}

/** Everything the authority can decide in this economy, for the page's Decide section and the agent. */
export function decisionsOf(economy) {
  const m = model(economy);
  const symbolOf = (d) => (d.pool ? m.tokens.get(m.pool.get(d.pool)?.currency)?.symbol : d.currency ? m.tokens.get(d.currency)?.symbol : '') ?? '';
  return [
    ...m.decisions.map((d) => ({ key: d.key, does: d.does, when: d.when, pool: d.pool ?? null, amount: d.amount ?? null, percent: d.percent ?? null, to: d.to ?? null, symbol: symbolOf(d), signedBy: d.signedBy ?? 'page', proof: d.proof ?? null, caps: d.caps ?? null, contest: d.contest ?? null, hold: d.hold ?? null })),
    ...m.contests.map((c) => ({ key: `contest:${c.key}`, does: 'decide', when: `naming who won “${c.name}”`, contest: c.key, sides: c.sides, sideNames: c.sideNames ?? [], signedBy: 'page' })),
    ...m.holds.map((h) => ({ key: `hold:${h.key}`, does: 'award', when: `saying where “${h.name}”’s collectible goes`, hold: h.key, signedBy: 'page' })),
  ];
}

/**
 * What waits for the authority on chain now: contests open or awaiting a result, collectibles on hold whose time is
 * not up. { contests: [{ key, name, id, open, awaiting, closesAt, resultBy, sides, sideNames, entries }], holds: [{ key,
 * asset, player, freeAt }] }.
 */
export async function waitingDecisions({ economy, rpc, now = Math.floor(Date.now() / 1000) }) {
  const e = readSpec(economy);
  if (!e.game) return { contests: [], holds: [] };
  const contests = [];
  if (e.contests.length) {
    const accounts = await rpc.accounts(e.contests.map((c) => lootPda.contest(e.game, c.id)));
    e.contests.forEach((c, i) => {
      const a = accounts[i];
      if (!a) return contests.push({ key: c.key, name: c.name, id: c.id, open: false, awaiting: false, canOpen: true });
      const x = decodeLoot(LootAccount.Contest, a.data);
      const open = x.verdict === 'Open';
      contests.push({ key: c.key, name: c.name, id: c.id, open, verdict: x.verdict, awaiting: open && now >= Number(x.closes_at) && now <= Number(x.result_by), closesAt: Number(x.closes_at), resultBy: Number(x.result_by), sides: x.sides.map(String), sideNames: c.sideNames ?? [], entries: x.entries, canOpen: false });
    });
  }
  const holds = [];
  if (e.holds.length) {
    const found = await rpc.programAccounts(LOOT_PROGRAM, [{ memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(12)) } }, { memcmp: { offset: 1, bytes: e.game } }]).catch(() => []);
    for (const { account } of found) {
      const h = decodeLoot(LootAccount.Hold, account.data);
      if (Number(h.free_at) > now) holds.push({ key: e.holds.length === 1 ? e.holds[0].key : null, asset: h.asset, player: h.player, freeAt: Number(h.free_at) });
    }
  }
  return { contests, holds };
}

// ---------------------------------------------------------------- the ledger

export const ledgerFile = (kitRoot, game) => path.join(kitRoot, '.gamesfun', 'web3', 'decisions', `${game}.jsonl`);

/** Every line of a game's decision ledger (oldest first); an unreadable line is skipped. */
export async function readLedger(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export async function appendLedger(file, entry) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
}

// ---------------------------------------------------------------- proof: a paid attempt on chain

const PAY = LOOT_IDL.instructions.find((i) => i.name === 'pay');
const PAY_ACCOUNTS = ['player', 'game', 'mint', 'player_token', 'treasury'];
const startsWith = (bytes, prefix) => prefix.every((b, i) => bytes[i] === b);
const sameShares = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Shares in one plain shape whichever way they were written ({ Pool: [3] } or 'Burn', addresses as text). */
const plainShares = (shares) => shares.map((s) => ({ to: typeof s.to === 'string' ? s.to : Object.fromEntries(Object.entries(s.to).map(([k, v]) => [k, [].concat(v).map(String)])), bps: Number(s.bps) }));

/**
 * The payment `signature` names, checked: a successful top-level `pay` on this game by `player`, of the payment's whole
 * amount in its currency, split exactly as the spec says, and as old as the proof asks. Returns { ok, refusals,
 * reference (hex), paidAt }.
 */
export async function checkAttempt({ rpc, economy, proof, signature, player, now }) {
  const e = readSpec(economy);
  const payment = e.part('payment', proof.payment);
  const fail = (code, message, fix) => ({ ok: false, refusals: [refusal(code, message, fix)] });
  if (!signature) return fail('D-PROOF-MISSING', `This decision pays only for a paid “${payment?.name ?? proof.payment}”, and the request names none.`, 'Send the signature of the transaction that paid for the attempt as "attempt".');
  if (!player) return fail('D-TO', 'Say who receives it ("to"): the wallet that paid for the attempt.', 'Add "to".');
  if (!payment) return fail('D-PROOF-SPEC', `The economy has no payment “${proof.payment}”.`, 'Fix "proof.payment" in the spec.');
  const tx = await rpc.call('getTransaction', [signature, { commitment: 'confirmed', encoding: 'base64', maxSupportedTransactionVersion: 0 }]).catch(() => null);
  if (!tx?.transaction) return fail('D-PROOF-NOT-FOUND', `No confirmed transaction ${short(signature)} on devnet: the attempt was never paid, or not yet.`, 'Pay for the attempt first, then claim with its signature.');
  if (tx.meta?.err) return fail('D-PROOF-FAILED', `The transaction ${short(signature)} failed on chain: nothing was paid.`, 'Claim with a payment that landed.');
  const wire = fromBase64(Array.isArray(tx.transaction) ? tx.transaction[0] : tx.transaction);
  const m = readMessage(readTransaction(wire).message);
  const token = e.priceToken(payment);
  const mint = token?.mint ?? (token?.wsol ? NATIVE_MINT : null);
  const decimals = token?.decimals ?? 9;
  const want = { amount: toUnits(payment.amount, decimals), shares: plainShares(sharesFor(payment.split, e)) };
  let found = null;
  let wrong = null;
  for (const ix of m.instructions) {
    if (m.keys[ix.programIndex] !== LOOT_PROGRAM || !startsWith(ix.data, PAY.discriminator)) continue;
    const accounts = Object.fromEntries(PAY_ACCOUNTS.map((n, i) => [n, m.keys[ix.accountIndexes[i]]]));
    let at = 8;
    const args = {};
    for (const a of PAY.args) [args[a.name], at] = decodeBorsh(LOOT_IDL, a.type, ix.data, at);
    if (accounts.game !== e.game) {
      wrong ??= 'it paid another game';
      continue;
    }
    if (accounts.player !== player) {
      wrong = `it was paid by ${short(accounts.player)}, not by ${short(player)}`;
      continue;
    }
    if (mint && accounts.mint !== mint) {
      wrong = `it was paid in another token (${short(accounts.mint)})`;
      continue;
    }
    if (big(args.amount) !== big(want.amount) || !sameShares(plainShares(args.shares), want.shares)) {
      wrong = `it paid ${fromUnits(args.amount, decimals)} ${token?.symbol ?? ''} split its own way, not “${payment.name}” as the economy prices and splits it`;
      continue;
    }
    found = { args, accounts };
  }
  if (!found)
    return fail('D-PROOF-NOT-PAY', wrong ? `${short(signature)} is not a paid “${payment.name}” for ${short(player)}: ${wrong}.` : `${short(signature)} pays nothing in this game.`, `Claim with the transaction in which ${short(player)} paid for “${payment.name}”.`);
  const reference = toHex(Uint8Array.from(found.args.reference));
  const paid = lootEvents(tx.meta?.logMessages ?? []).find((ev) => ev.name === 'Paid' && ev.data.player === player && toHex(Uint8Array.from(ev.data.reference)) === reference);
  if (!paid) return fail('D-PROOF-NOT-PAY', `${short(signature)} has no receipt of the payment from the program.`, 'Claim with a payment that landed.');
  const paidAt = Number(tx.blockTime ?? 0);
  const after = toSeconds(proof.after ?? 0);
  const within = proof.within !== undefined ? toSeconds(proof.within) : null;
  if (!paidAt) return fail('D-PROOF-TIME', 'The network does not say when the attempt was paid yet.', 'Claim again in a few seconds.');
  if (now - paidAt < after) return fail('D-PROOF-EARLY', `Claimed ${now - paidAt} seconds after the attempt was paid; the economy says no one gets there in under ${after} seconds.`, `If it is real, claim again after ${after - (now - paidAt)} more seconds; the rule is "proof.after" in the spec.`);
  if (within !== null && now - paidAt > within) return fail('D-PROOF-LATE', `The attempt was paid ${now - paidAt} seconds ago; claims must come within ${within} seconds.`, 'Claim sooner; the rule is "proof.within" in the spec.');
  return { ok: true, refusals: [], reference, paidAt, attempt: signature };
}

/** References of the pool's recent payouts (from the program's receipts), to catch a claim paid before the ledger knew. */
async function recentPayoutReferences(rpc, pool) {
  const refs = new Set();
  const recent = await rpc.call('getSignaturesForAddress', [pool, { limit: RECENT_PAYOUTS, commitment: 'confirmed' }]).catch(() => []);
  for (const r of recent ?? []) {
    if (r.err) continue;
    const t = await rpc.call('getTransaction', [r.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]).catch(() => null);
    for (const ev of lootEvents(t?.meta?.logMessages ?? [])) if (ev.name === 'PaidOut') refs.add(toHex(Uint8Array.from(ev.data.reference)));
  }
  return refs;
}

// ---------------------------------------------------------------- caps

/** What this decision moved in the last 24 hours, in base units: { all, receiver }. */
function movedToday(ledger, decisionKey, to, now) {
  let all = 0n;
  let receiver = 0n;
  for (const x of ledger) {
    if (x.verdict !== 'done' || x.decision !== decisionKey || !x.units) continue;
    if (Date.parse(x.at) / 1000 < now - DAY) continue;
    all += big(x.units);
    if (to && x.to === to) receiver += big(x.units);
  }
  return { all, receiver };
}

// ---------------------------------------------------------------- the builder

const tokenProgramOf = (t) => (t?.program === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);
const mintOf = (t) => (t?.wsol || t?.source === 'sol' ? NATIVE_MINT : t?.mint);

/**
 * One decision, checked and built. ctx:
 *   economy   the game's economy (with `live`)
 *   request   readRequest's
 *   rpc       the creator's RPC (the game, its pools, contests, holds and the attempt are read from the chain)
 *   signer    the address that will sign (the connected wallet, or the keeper's key); checked against the game's authority
 *   ledger    the game's ledger lines (caps and claims already paid), and `by`: 'page' | 'keeper'
 *   now       Unix seconds
 * Returns { ok, refusals, notes, says, numbers: [[label, value]], decision, instructions, signers (fresh keys), reference,
 * record } where record is the ledger line to write once it lands (add signature and verdict).
 */
export async function prepareDecision({ economy, request, rpc, signer, ledger = [], by = 'page', now = Math.floor(Date.now() / 1000) }) {
  const refusals = [];
  const notes = [];
  const numbers = [];
  const refuse = (code, message, fix) => (refusals.push(refusal(code, message, fix)), null);
  const done = (extra = {}) => ({ ok: refusals.length === 0, refusals, notes, numbers, ...extra });
  const m = model(economy);
  const e = readSpec(economy);
  const d = findDecision(economy, request.decision, request);
  if (!d) {
    const known = decisionsOf(economy).map((x) => x.key);
    refuse('D-UNKNOWN', `There is no decision “${request.decision}” in this economy.`, known.length ? `Name one of: ${known.join(', ')}.` : 'Add one to the spec’s "decisions".');
    return done({ says: 'Nothing to decide.' });
  }
  const decision = { key: d.key, does: d.does, when: d.when };
  if (!e.game) {
    refuse('D-NOT-LIVE', 'The economy is not live yet, so there is nothing on chain to decide.', 'Put it live first (the Economy tab’s Put it live, or npx gamesfun economy publish).');
    return done({ decision, says: `${d.when}: not live yet.` });
  }
  // A request the ledger already decided under the same id is never signed twice.
  if (request.id) {
    const before = ledger.find((x) => x.requestId === request.id && x.decision === d.key && x.verdict === 'done');
    if (before) refuse('D-SAME-ID', `The game’s result “${request.id}” was already decided: ${before.says} (${short(before.signature)}).`, 'Nothing to do: each result is decided once.');
  }
  const [gameAccount] = await rpc.accounts([e.game]);
  if (!gameAccount) return (refuse('D-NOT-LIVE', `The game ${short(e.game)} is not on devnet.`, 'Put the economy live first.'), done({ decision }));
  const game = decodeLoot(LootAccount.Game, gameAccount.data);
  if (signer && game.authority !== signer)
    refuse('D-SIGNER', `This game’s decisions are signed by ${game.authority === game.owner ? (by === 'keeper' ? 'the owner’s wallet' : 'your wallet') : `the key ${short(game.authority)}`}, not ${short(signer)}.`,
      by === 'keeper' ? 'Let the keeper decide: the Economy tab’s "Let my keeper decide" (one approval in your wallet).' : game.authority === game.owner ? `Connect ${short(game.owner)}.` : 'Your keeper decides for this game: post the request to it, or press "Take it back" in the Economy tab first.');
  if (game.suspended) refuse('D-SUSPENDED', 'games.fun has suspended this game: payouts and decisions are refused by the program.', 'Ask games.fun.');
  if (signer && by === 'keeper') {
    const lamports = await rpc.balance(signer).catch(() => null);
    if (lamports !== null && big(lamports) < SIGNER_MIN_LAMPORTS) refuse('D-SIGNER-SOL', `The keeper’s key ${short(signer)} holds ${fromUnits(lamports, 9)} SOL; a decision needs about ${fromUnits(SIGNER_MIN_LAMPORTS, 9)} SOL for its fees.`, `Send it a little devnet SOL (solana transfer ${signer} 0.05).`);
  }

  const instructions = [];
  const signers = [];
  let reference = request.id ? hex32(`gf-decide:${e.game}:${d.key}:${request.id}`) : hex32(`gf-decide:${e.game}:${d.key}:${now}:${Math.random()}`);
  let says = '';
  let units = null;
  let token = null;
  const to = request.to ?? null;

  // ---- what moves value: a payout, a burn, a mint, a collectible
  if (['payout', 'burn', 'issue', 'make'].includes(d.does)) {
    if (d.does !== 'burn') {
      if (!to) refuse('D-TO', `Say who receives it: ${d.to ? `${d.to}, as` : ''} a wallet’s public address ("to").`, 'Add "to".');
      else if ([e.game, e.collection, game.treasury, game.owner].includes(to) || (d.pool && to === lootPda.pool(e.game, m.pool.get(d.pool)?.index ?? 0))) refuse('D-TO', `${short(to)} is the game’s own account, not a player’s wallet.`, 'Name the receiver’s wallet.');
    }
    // proof: a paid attempt by the receiver, not claimed before
    if (d.proof) {
      const proof = await checkAttempt({ rpc, economy, proof: d.proof, signature: request.attempt, player: to, now });
      refusals.push(...proof.refusals);
      if (proof.ok) {
        reference = Buffer.from(proof.reference, 'hex');
        const used = ledger.find((x) => x.verdict === 'done' && (x.attempt === request.attempt || x.reference === proof.reference));
        if (used) refuse('D-PROOF-USED', `That attempt (${short(request.attempt)}) was already paid for: ${used.says} (${short(used.signature)}).`, 'One attempt, one claim: pay for another attempt.');
        numbers.push(['Attempt', `${short(request.attempt)}, paid ${now - proof.paidAt} seconds ago by ${short(to)}`]);
      }
    }
  }
  if (d.does === 'payout' || d.does === 'burn') {
    const pool = d.pool ? e.part('pool', d.pool) : null;
    if (!pool) return (refuse('D-SPEC', `${d.key} names no pool.`, 'Fix the decision in the spec.'), done({ decision }));
    token = e.poolToken(d.pool);
    const mint = mintOf(token);
    const program = tokenProgramOf(token);
    const poolAddress = lootPda.pool(e.game, pool.index);
    const [poolAccount] = await rpc.accounts([poolAddress]);
    const holds = readTokenAccount(poolAccount?.data)?.amount ?? 0n;
    // the amount: the request's, else the decision's; never more than the decision's own
    const percent = request.percent ?? (request.amount === undefined && d.amount === undefined ? d.percent : undefined);
    if (percent !== undefined) {
      if (d.percent !== undefined && percent > Number(d.percent)) refuse('D-AMOUNT', `${percent}% is more than the ${d.percent}% the economy says for “${d.when}”.`, `Ask for at most ${d.percent}%.`);
      if (d.percent === undefined && d.amount !== undefined) refuse('D-AMOUNT', `“${d.when}” pays a fixed ${d.amount} ${token.symbol}, not a share.`, 'Leave out "percent".');
      units = (holds * BigInt(Math.round(percent * 100))) / 10_000n;
    } else {
      const amount = request.amount ?? (d.amount !== undefined ? String(d.amount) : undefined);
      if (amount === undefined) refuse('D-AMOUNT', 'Say how much ("amount", in whole units) or what share ("percent").', 'Add "amount".');
      else {
        units = toUnits(amount, token.decimals);
        if (d.amount !== undefined && units > toUnits(d.amount, token.decimals)) refuse('D-AMOUNT', `${amount} ${token.symbol} is more than the ${d.amount} ${token.symbol} the economy says for “${d.when}”.`, `Ask for at most ${d.amount}.`);
      }
    }
    if (units !== null) {
      if (units <= 0n) refuse('D-AMOUNT', 'That moves nothing.', 'Ask for more than 0.');
      if (units > holds) refuse('D-POOL-SHORT', `The pool “${d.pool}” holds ${fromUnits(holds, token.decimals)} ${token.symbol}; this needs ${fromUnits(units, token.decimals)}.`, `Wait until it fills, or ask for less.`);
      numbers.push(['Amount', `${fromUnits(units, token.decimals)} ${token.symbol}`], [`The pool “${d.pool}”`, `holds ${fromUnits(holds, token.decimals)} ${token.symbol}${units <= holds ? `, ${fromUnits(holds - units, token.decimals)} after` : ''}`]);
    }
    // a claim paid on chain already (the ledger may be new, or on another machine)
    if (d.proof && request.attempt && refusals.every((r) => !r.code.startsWith('D-PROOF'))) {
      const refs = await recentPayoutReferences(rpc, poolAddress);
      if (refs.has(toHex(reference))) refuse('D-PROOF-USED', `That attempt (${short(request.attempt)}) was already paid out of “${d.pool}” on chain.`, 'One attempt, one claim: pay for another attempt.');
    }
    if (units !== null && units > 0n) {
      const extras = program === TOKEN_2022_PROGRAM ? await transferExtras(rpc, mint, [{ source: poolAddress, destination: to ? associatedTokenAddress(to, mint, program) : poolAddress, authority: e.game, amount: units }]) : [];
      if (d.does === 'payout' && to) {
        const toAccount = associatedTokenAddress(to, mint, program);
        instructions.push(createAssociatedTokenAccountIdempotent(signer ?? game.authority, to, mint, program), payoutIx({ authority: signer ?? game.authority, game: e.game, index: pool.index, mint, to: toAccount, amount: units, reference, remaining: extras }));
        says = `Pay ${fromUnits(units, token.decimals)} ${token.symbol} from the pool “${d.pool}” to ${short(to)}${d.to ? ` (${d.to})` : ''}`;
        if (mint === NATIVE_MINT) notes.push('It arrives as wrapped SOL in the receiver’s wallet (their SOL token account, which the signer opens for them the first time: about 0.002 SOL of rent).');
      } else if (d.does === 'burn') {
        instructions.push(burnIx({ authority: signer ?? game.authority, game: e.game, index: pool.index, mint, amount: units, reference }));
        says = `Burn ${fromUnits(units, token.decimals)} ${token.symbol} from the pool “${d.pool}”`;
      }
    }
  } else if (d.does === 'issue') {
    token = e.token(d.currency);
    if (!token?.mint) refuse('D-SPEC', `${d.key} mints a token that is not live yet.`, 'Put the economy live first.');
    const amount = request.amount ?? (d.amount !== undefined ? String(d.amount) : undefined);
    if (amount === undefined) refuse('D-AMOUNT', 'Say how much ("amount").', 'Add "amount".');
    else if (token) {
      units = toUnits(amount, token.decimals);
      if (d.amount !== undefined && units > toUnits(d.amount, token.decimals)) refuse('D-AMOUNT', `${amount} ${token.symbol} is more than the ${d.amount} the economy says.`, `Ask for at most ${d.amount}.`);
      numbers.push(['Amount', `${amount} ${token.symbol} (newly minted)`]);
    }
    if (token?.mint && to && units) {
      const program = tokenProgramOf(token);
      instructions.push(createAssociatedTokenAccountIdempotent(signer ?? game.authority, to, token.mint, program), issueIx({ authority: signer ?? game.authority, game: e.game, mint: token.mint, to: associatedTokenAddress(to, token.mint, program), amount: units, reference }));
      says = `Mint ${fromUnits(units, token.decimals)} ${token.symbol} to ${short(to)}`;
    }
  } else if (d.does === 'make') {
    const item = e.part('item', d.item);
    if (!item?.id) refuse('D-SPEC', `${d.key} gives an item that is not live yet.`, 'Put the economy live first.');
    if (item?.id && to) {
      const asset = freshKeypair();
      signers.push(asset);
      units = 1n;
      instructions.push(makeIx({ authority: signer ?? game.authority, game: e.game, itemId: item.id, collection: e.collection, asset: asset.address, owner: to, reference }));
      says = `Give ${short(to)} a new ${item.name} (collectible ${short(asset.address)})`;
      numbers.push(['Collectible', `${item.name}, new`]);
    }
  } else if (d.does === 'decide' || d.does === 'open_contest') {
    const c = e.part('contest', d.contest);
    const contestAddress = lootPda.contest(e.game, c.id);
    const [account] = await rpc.accounts([contestAddress]);
    const x = account ? decodeLoot(LootAccount.Contest, account.data) : null;
    token = e.priceToken(c);
    const mint = mintOf(token);
    const program = tokenProgramOf(token);
    if (d.does === 'open_contest') {
      if (x) refuse('D-CONTEST', `“${c.name}” is ${x.verdict === 'Open' ? 'already open' : 'decided but not closed yet (anyone can close it once every winner has claimed)'}.`, x.verdict === 'Open' ? 'Name its winner first.' : 'Wait until it is closed.');
      const closes = now + toSeconds(c.entriesClose ?? '1h');
      const due = now + toSeconds(c.resultDue ?? c.entriesClose ?? '1h') + (c.resultDue ? 0 : DAY);
      const args = { sides: c.sides, closes_at: BigInt(closes), result_by: BigInt(Math.max(due, closes)), shares: sharesFor(c.split, e) };
      instructions.push(openContestIx({ authority: signer ?? game.authority, game: e.game, id: c.id, mint, args }));
      says = `Open “${c.name}”: ${c.sides} sides, entries close ${new Date(closes * 1000).toISOString()}, the result is due by ${new Date(Number(args.result_by) * 1000).toISOString()}`;
      numbers.push(['Sides', (c.sideNames ?? []).length ? c.sideNames.join(', ') : String(c.sides)]);
    } else {
      const side = request.side;
      if (!x) refuse('D-CONTEST', `“${c.name}” is not open.`, 'Open it first ("contest:<key>" with "open": true).');
      else if (x.verdict !== 'Open') refuse('D-CONTEST', `“${c.name}” was already ${x.verdict === 'Won' ? `decided (side ${x.winner} won)` : 'called off'}.`, 'Nothing to do.');
      else if (now > Number(x.result_by)) refuse('D-CONTEST', `“${c.name}”’s result was due ${new Date(Number(x.result_by) * 1000).toISOString()}: it is too late, and anyone can call it off now (every entry gets its money back).`, 'Call it off.');
      if (side === undefined) refuse('D-SIDE', `Say which side won ("side", from 0 to ${c.sides - 1}).`, 'Add "side".');
      else if (side >= c.sides) refuse('D-SIDE', `“${c.name}” has ${c.sides} sides: "side" is 0 to ${c.sides - 1}.`, 'Name a side that exists.');
      else if (x && big(x.sides[side]) === 0n) refuse('D-SIDE', `Nobody backed side ${side}${c.sideNames?.[side] ? ` (${c.sideNames[side]})` : ''}: the program refuses a winner nobody backed.`, 'Call it off instead, so everyone gets their money back.');
      if (x && side !== undefined && refusals.length === 0) {
        const holderAccount = {};
        for (const s of x.shares) {
          if (!s.to.Holder) continue;
          const asset = s.to.Holder[0];
          const [a] = await rpc.accounts([asset]);
          const holder = a ? parseCoreAsset(a.data).owner : null;
          if (holder) holderAccount[asset] = associatedTokenAddress(holder, mint, program);
        }
        const remaining = shareAccounts(e.game, x.shares, holderAccount);
        instructions.push(decideIx({ authority: signer ?? game.authority, game: e.game, id: c.id, side, mint, reference, remaining }));
        const pot = x.sides.reduce((n, v) => n + big(v), 0n);
        says = `Name side ${side}${c.sideNames?.[side] ? ` (${c.sideNames[side]})` : ''} as the winner of “${c.name}”`;
        numbers.push(['Pot', `${fromUnits(pot, token.decimals)} ${token.symbol}, ${x.entries} entr${x.entries === 1 ? 'y' : 'ies'}`], ['Backed the winner', `${fromUnits(x.sides[side], token.decimals)} ${token.symbol}`]);
      }
    }
  } else if (d.does === 'award') {
    if (!request.asset) refuse('D-ASSET', 'Say which held collectible ("asset").', 'Add "asset".');
    else {
      const [h] = await rpc.accounts([lootPda.hold(request.asset)]);
      const hold = h ? decodeLoot(LootAccount.Hold, h.data) : null;
      if (!hold || hold.game !== e.game) refuse('D-HOLD', `${short(request.asset)} is not held by this game.`, 'Name a collectible on hold here.');
      else if (now >= Number(hold.free_at)) refuse('D-HOLD', `Its time with the game is up: the authority has no say any more, and anyone can send it home.`, 'Nothing to award.');
      else {
        const receiver = to ?? hold.player;
        instructions.push(awardIx({ signer: signer ?? game.authority, game: e.game, asset: request.asset, player: hold.player, to: receiver, collection: e.collection, reference }));
        units = 1n;
        says = receiver === hold.player ? `Send the held collectible ${short(request.asset)} back to ${short(hold.player)}` : `Send the held collectible ${short(request.asset)} to ${short(receiver)} (it was ${short(hold.player)}’s)`;
      }
    }
  } else {
    refuse('D-NOT-YET', `The kit does not build “${d.does}” decisions from a request yet (it builds payout, burn, issue, make, award, and a contest’s open and result).`, 'Sign it with your own tools for now, or ask for it to be added.');
  }

  // ---- caps: the page's and the keeper's own limits, not the program's
  if (d.caps && units !== null && token) {
    const cap = (v) => toUnits(v, token.decimals);
    const today = movedToday(ledger, d.key, to, now);
    if (d.caps.each !== undefined && units > cap(d.caps.each)) refuse('D-CAP-EACH', `${fromUnits(units, token.decimals)} ${token.symbol} is over this decision’s cap of ${d.caps.each} ${token.symbol} each time.`, `Ask for at most ${d.caps.each}; the cap is "caps.each" in the spec.`);
    if (d.caps.perPlayerPerDay !== undefined && to && today.receiver + units > cap(d.caps.perPlayerPerDay)) refuse('D-CAP-PLAYER', `${short(to)} already got ${fromUnits(today.receiver, token.decimals)} ${token.symbol} from it in the last 24 hours; the cap is ${d.caps.perPlayerPerDay} a day each.`, 'Wait a day; the cap is "caps.perPlayerPerDay" in the spec.');
    if (d.caps.perDay !== undefined && today.all + units > cap(d.caps.perDay)) refuse('D-CAP-DAY', `It already paid ${fromUnits(today.all, token.decimals)} ${token.symbol} in the last 24 hours; the cap is ${d.caps.perDay} a day in all.`, 'Wait; the cap is "caps.perDay" in the spec.');
    numbers.push(['Caps (the keeper’s and the page’s, not the program’s)', [d.caps.each !== undefined ? `${d.caps.each} each` : null, d.caps.perPlayerPerDay !== undefined ? `${d.caps.perPlayerPerDay} a player a day` : null, d.caps.perDay !== undefined ? `${d.caps.perDay} a day` : null].filter(Boolean).join(', ')]);
  }
  if (instructions.length) notes.push(`${by === 'keeper' ? 'The keeper’s key' : 'Your wallet'} pays games.fun’s 0.00001 SOL fee for it and the network fee.`);
  if (d.signedBy === 'keeper' && by === 'page') notes.push('The economy says the keeper signs this one; you are signing it yourself from the page.');
  if (!says) says = `${d.when}`;
  const record = {
    decision: d.key, does: d.does, requestId: request.id ?? null, to, units: units === null ? null : String(units), amount: units !== null && token ? fromUnits(units, token.decimals) : null, symbol: token?.symbol ?? null,
    attempt: request.attempt ?? null, reference: toHex(reference), says, by, claim: request.says ?? null,
  };
  return done({ says, decision, instructions: refusals.length ? [] : instructions, signers, reference: toHex(reference), record, authority: game.authority, owner: game.owner });
}

/** A request as the studio link's hash parameters (#economy?decide=…): the Economy tab reads them back (linkAsks). */
export function linkParams(request) {
  const out = { decide: request.decision };
  for (const k of ['to', 'amount', 'percent', 'side', 'asset', 'attempt', 'id']) if (request[k] !== undefined) out[k] = String(request[k]);
  if (request.open) out.open = '1';
  return out;
}
