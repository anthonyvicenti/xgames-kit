// Small readers and helpers the economy calls need beyond chain/loot.js's builders: token accounts and mints, a
// lottery's winners and a stake's pending rewards computed as the program does, the player's collectibles of an
// item, and a fresh key for a collectible a craft mints (it signs, so it is made with WebCrypto's Ed25519, which
// browsers and Node both have). Plain ES module, no Node import.
import { encodeBase58 } from '../chain/base58.js';
import { readUintLE } from '../chain/bytes.js';
import { parseCoreAsset } from '../chain/core.js';

/** A token account (classic or Token-2022): { mint, owner, amount }, or null when it is not one. */
export function readTokenAccount(data) {
  if (!data || data.length < 165) return null;
  return { mint: encodeBase58(data.subarray(0, 32)), owner: encodeBase58(data.subarray(32, 64)), amount: readUintLE(data, 64, 8) };
}

/** A mint's decimals. */
export const mintDecimals = (data) => data[44];

const PRECISION = 1_000_000_000_000n;
const LINE = 40;

/** The places that have a winner this round (Lottery::winners). */
export function winnerCount(l) {
  const set = l.places.findIndex((bps) => !bps);
  return Math.min(set < 0 ? l.places.length : set, Number(l.sold));
}

/** The ticket that wins `place` (Lottery::ticket_of_place). */
export function ticketOfPlace(l, place) {
  const sold = BigInt(l.sold);
  const ahead = BigInt(place) * (sold / BigInt(winnerCount(l)));
  const toEnd = sold - BigInt(l.first_ticket);
  return ahead < toEnd ? BigInt(l.first_ticket) + ahead : ahead - toEnd;
}

/** Who holds ticket `ticket` (Lottery::holder): the first purchase whose end is past it. */
export function holderOf(lines, ticket) {
  let [low, high] = [0, lines.length - 1];
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (BigInt(lines[middle].end) > ticket) high = middle;
    else low = middle + 1;
  }
  return lines[low]?.buyer ?? null;
}

/** Every place's winner once a round is drawn, first place first; [] before. */
export function lotteryWinners(l, lines) {
  if (l.status !== 'Drawn' || !lines.length) return [];
  return Array.from({ length: winnerCount(l) }, (_, place) => holderOf(lines, ticketOfPlace(l, place)));
}

/** Tickets `player` holds in this round's list of purchases. */
export function ticketsOf(lines, player) {
  let mine = 0n;
  let start = 0n;
  for (const { buyer, end } of lines) {
    if (buyer === player) mine += BigInt(end) - start;
    start = BigInt(end);
  }
  return mine;
}

/**
 * What a position would be paid if it staked or unstaked now: what the stake already credited, plus its share of
 * what sits in the rewards pool waiting to be credited (the program credits all of it on the next call; a transfer
 * fee would take a little off).
 */
export function pendingRewards(stake, position, poolHolds = 0n) {
  if (!position || !position.amount) return 0n;
  const total = BigInt(stake.total);
  let rpt = BigInt(stake.reward_per_token);
  if (total > 0n && BigInt(poolHolds) > 0n) rpt += (BigInt(poolHolds) * PRECISION) / total;
  return (BigInt(position.amount) * (rpt - BigInt(position.paid_per_token))) / PRECISION;
}

/** The player's collectibles of this game's collection: [{ asset, itemId, serial, attributes, frozen }]. */
export function collectiblesFrom(found) {
  return found.flatMap(({ pubkey, account }) => {
    try {
      const a = parseCoreAsset(account.data);
      return [{ asset: pubkey, owner: a.owner, name: a.name, itemId: Number(a.attributes.item_id), serial: a.attributes.serial ? Number(a.attributes.serial) : null, attributes: a.attributes, frozen: a.frozen }];
    } catch {
      return [];
    }
  });
}

/** Whether a collectible can go into a recipe now, by its item's `life` (craft.rs `take` and `Use`). */
export function lifeAllows(c, item, now, { use = false } = {}) {
  const life = item?.life;
  if (!life) return { ok: true };
  const made = Number(c.attributes.made ?? 0);
  const age = now - made;
  if (age < Number(life.ready_after)) return { ok: false, why: 'not ready', at: made + Number(life.ready_after) };
  if (Number(life.lasts) && age >= Number(life.lasts)) return { ok: false, why: 'expired' };
  if (use) {
    const used = Number(c.attributes.used ?? 0);
    if (life.uses && used >= life.uses) return { ok: false, why: 'used up' };
    if (c.attributes.used_at !== undefined && now - Number(c.attributes.used_at) < Number(life.cooldown)) return { ok: false, why: 'resting', at: Number(c.attributes.used_at) + Number(life.cooldown) };
  }
  return { ok: true };
}

/** A fresh key that signs once (a collectible's address): { address, sign(message) → Promise<64 bytes> }. */
export async function freshSigner() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('This browser cannot make a key for the new collectible (no WebCrypto). Use a current browser.');
  let pair;
  try {
    pair = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  } catch {
    throw new Error('This browser cannot make a key for the new collectible (no Ed25519 in WebCrypto). Use a current Chrome, Firefox or Safari.');
  }
  const address = encodeBase58(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  return { address, sign: async (message) => new Uint8Array(await subtle.sign({ name: 'Ed25519' }, pair.privateKey, message)) };
}
