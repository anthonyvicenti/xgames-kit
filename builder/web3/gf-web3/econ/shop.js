// The one shop migration: a `shop` section of gamesfun.json (gf-web3 2.0.0 and earlier: one currency, collectible
// items, boxes of items) → an `economy` section on loot 0.3. Pure, browser-safe (no Node import, no file read), so
// the game page (gf-web3 reads an old shop as the economy it stands for) and the kit's tools
// (builder/web3/economy/migrate.mjs, which adds the file read and write) share this one function.
//
// Where the shop was live:
// - on loot 0.1/0.2 (its game is not the 0.3 address of its collection): a new program, so it is not live on 0.3.
//   Its addresses are kept under `economy.previous`, and the economy goes live fresh (a new collection and game).
// - on loot 0.3 (gf-web3 2.0.0 put it there): with `keepLive`, the game page plays it where it is (`economy.live`).
//   Without it (the file migration and the publish flow) it is kept as `previous` too, as the migration always did.
// A shop currency on Token-2022 stays `token-2022`; anything else is `spl-token`.
import { lootPda, onThisProgram } from '../chain/loot.js';
import { fromUnits, WSOL } from './spec.js';

/** A key from a name: "Golden Sword!" → "golden-sword", unique within `taken`. */
export function keyFrom(name, taken = new Set(), fallback = 'part') {
  let base = String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  if (!/^[a-z]/.test(base)) base = `${fallback}${base ? `-${base}` : ''}`.slice(0, 28);
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

/**
 * An economy put live on an earlier deploy of the program goes live fresh on this one, like a 0.2 shop: its addresses
 * move to `economy.previous` and `live` goes. Changes `economy` in place; returns the notes (none when nothing moved).
 */
export function leaveOldProgram(economy) {
  const live = economy?.live;
  if (!live?.game || onThisProgram(live)) return [];
  economy.previous = { program: live.program ?? '0.3', ...live };
  delete economy.live;
  return [`The economy was live on loot program ${live.program ?? '0.3'} (game ${live.game}), which games.fun replaced on devnet with 0.3.1 on 2026-10-12. It goes live fresh, with a new collection and game; the old addresses are kept under economy.previous.`];
}

/** True when a shop's game is the loot 0.3 game of its collection (gf-web3 2.0.0 published it on 0.3). */
export function shopOnLoot03(shop) {
  if (!shop?.collection || !shop?.game) return false;
  try {
    return lootPda.game(shop.collection) === shop.game;
  } catch {
    return false;
  }
}

/**
 * The config with its `shop` turned into an `economy`. Returns { config, changed, notes }. A config that already has
 * an economy, or has no shop, comes back unchanged. `keepLive`: a shop already on loot 0.3 stays live (see above).
 */
export function migrateShop(config, { keepLive = false } = {}) {
  const notes = [];
  if (!config?.shop) return { config, changed: false, notes: ['There is no shop to move.'] };
  if (config.economy) return { config, changed: false, notes: ['This game already has an economy; its shop was left as it is.'] };
  const shop = config.shop;
  const cur = shop.currency ?? { mint: WSOL, symbol: 'SOL', decimals: 9, native: true };
  const tokenKeys = new Set();
  const tokens = [];
  let currency;
  const linked = config.token;
  if (cur.native || cur.mint === WSOL) {
    currency = keyFrom('sol', tokenKeys);
    tokens.push({ key: currency, source: 'sol' });
  } else {
    currency = keyFrom(cur.symbol, tokenKeys, 'coin');
    const same = linked?.mint === cur.mint;
    tokens.push({
      key: currency,
      source: same && linked.source === 'launched' ? 'curve' : 'existing',
      mint: cur.mint,
      ...(same ? { name: linked.name } : {}),
      symbol: String(cur.symbol).slice(0, 10),
      decimals: cur.decimals,
      program: same ? linked.program : cur.program === 'token-2022' ? 'token-2022' : 'spl-token',
      ...(same && linked.source === 'launched' ? { venue: 'games.fun' } : {}),
    });
  }
  if (linked && linked.mint !== cur.mint)
    tokens.push({ key: keyFrom(linked.symbol, tokenKeys, 'coin'), source: linked.source === 'launched' ? 'curve' : 'existing', mint: linked.mint, name: linked.name, symbol: linked.symbol, decimals: linked.decimals, program: linked.program, ...(linked.source === 'launched' ? { venue: 'games.fun' } : {}) });

  const itemKeys = new Set();
  const keyOf = new Map();
  const items = (shop.items ?? []).map((it) => {
    const key = keyFrom(it.name, itemKeys, 'item');
    keyOf.set(it.id, key);
    return {
      key,
      id: it.id,
      name: it.name,
      ...(it.description ? { description: it.description } : {}),
      kind: 'collectible',
      rarity: it.rarity ?? 'Common',
      soulbound: !!it.soulbound,
      supply: it.maxSupply ?? 0,
      price: fromUnits(BigInt(it.price ?? '0'), cur.decimals),
      ...(it.uri ? { uri: it.uri } : {}),
      ...(it.image ? { image: it.image } : {}),
      ...(it.picture ? { picture: it.picture } : {}),
      ...(it.look ? { look: it.look } : {}),
    };
  });
  const boxKeys = new Set();
  const boxes = (shop.boxes ?? []).map((b) => ({
    key: keyFrom(b.name, boxKeys, 'box'),
    id: b.id,
    name: b.name,
    price: fromUnits(BigInt(b.price), cur.decimals),
    outcomes: b.entries.filter((e) => keyOf.has(e.item)).map((e) => ({ gives: 'item', item: keyOf.get(e.item), weight: e.weight })),
  }));

  const economy = {
    version: 1,
    network: 'devnet',
    name: shop.name,
    currency,
    tokens,
    collection: {
      name: shop.name,
      ...(shop.description ? { description: shop.description } : {}),
      royaltyPercent: (shop.royaltyBps ?? 500) / 100,
      ...(shop.metadataUri ? { uri: shop.metadataUri } : {}),
      ...(shop.image ? { image: shop.image } : {}),
    },
    items,
    boxes,
  };
  if (keepLive && shopOnLoot03(shop)) {
    economy.live = { game: shop.game, collection: shop.collection, ...(shop.treasury ? { treasury: shop.treasury } : {}) };
    notes.push(`The shop is live on loot program 0.3 (collection ${shop.collection}); it stays live where it is.`);
  } else if (shop.collection || shop.game) {
    economy.previous = { program: '0.2', ...(shop.collection ? { collection: shop.collection } : {}), ...(shop.game ? { game: shop.game } : {}), ...(shop.treasury ? { treasury: shop.treasury } : {}) };
    notes.push(`The shop was live on loot program 0.2 (collection ${shop.collection ?? 'unknown'}). Program 0.3 is a new program: the economy goes live fresh, with a new collection; the old one is kept under economy.previous.`);
  }
  notes.push(`Moved ${items.length} item${items.length === 1 ? '' : 's'} and ${boxes.length} box${boxes.length === 1 ? '' : 'es'} into the economy, priced in ${tokens[0].symbol ?? 'SOL'}.`);
  const { shop: _, ...rest } = config;
  return { config: { ...rest, economy }, changed: true, notes };
}

/** The economy a config's shop stands for in the game page (a 0.3 shop stays live), or null when it has none (or
 * already has an economy). */
export function economyFromShop(config) {
  const moved = migrateShop(config, { keepLive: true });
  return moved.changed ? moved.config.economy : null;
}
