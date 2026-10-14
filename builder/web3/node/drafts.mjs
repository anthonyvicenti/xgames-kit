// Changes to a game's web3 setup that need no signature: link or unlink a token, pick the shop's currency, and draft
// items and loot boxes. They only edit gamesfun.json; "Put it on sale" (flows.mjs) is what reaches the chain, with the
// creator's approval in their wallet. Shared by the CLI, the MCP tools and the studio's routes.
import { isAddress } from '../gf-web3/chain/base58.js';
import { NATIVE_MINT } from '../gf-web3/chain/pda.js';
import { findBox, findItem, nextId } from '../gf-web3/config.js';
import { cleanLook } from '../gf-web3/looks.js';
import { dropTable, gamePath, LIMIT, rarity, RuleError, text, toUnits, wholeNumber } from '../gf-web3/rules.js';
import { mintInfo } from './chain.mjs';
import { gameTitle, readPicture, updateConfig } from './game.mjs';

const fail = (message) => {
  throw new RuleError(message);
};

/** A name clipped to a byte budget on a character boundary. */
export function clip(value, maxBytes) {
  let t = String(value ?? '').trim();
  while (new TextEncoder().encode(t).length > maxBytes) t = t.slice(0, -1);
  return t;
}

/** "Bean Brawl" → BEAN; one short word → its letters; else initials. */
export function tickerOf(title) {
  const words = String(title).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const first = (words[0] ?? '').slice(0, 8);
  return first.length >= 2 ? first : words.map((w) => w[0]).join('').slice(0, 8) || 'GAME';
}

const isLive = (config) => Boolean(config.shop?.collection && config.shop?.game);
const booleanOf = (v) => v === true || v === 'true' || v === 'yes' || v === '1';

/** The shop's draft settings, created on first use (named after the game). */
async function ensureShop(gameDir, config) {
  if (config.shop) return config.shop;
  const title = await gameTitle(gameDir);
  config.shop = { name: clip(`${title} Items`, LIMIT.CollectionNameBytes) || 'Game Items', description: '', royaltyBps: 500, items: [], boxes: [] };
  return config.shop;
}

/** The currency a shop would take now: the game's own token if it has one, else SOL. */
function defaultCurrency(config) {
  if (config.token) return { mint: config.token.mint, symbol: config.token.symbol, decimals: config.token.decimals, native: false, program: config.token.program };
  return { mint: NATIVE_MINT, symbol: 'SOL', decimals: 9, native: true, program: 'spl-token' };
}

// ---------------------------------------------------------------- token

/**
 * Use a token the game did not launch here (pump.fun, another launchpad, a mint of the creator's own, classic SPL or
 * Token-2022): read it from the chain and record it. No signature. Every token is welcome: it need not be launched
 * with games.fun, and games.fun takes no share of its fees.
 */
export async function linkToken({ gameDir, rpc, network }, { mint }) {
  const info = await mintInfo(rpc, mint, { network });
  if (info.native) fail('SOL is not a token you can link. Pick it as the shop’s currency instead.');
  return updateConfig(gameDir, (config) => {
    if (config.token?.source === 'launched') fail(`This game launched $${config.token.symbol}; it can’t use another token.`);
    if (config.token) fail(`This game already uses $${config.token.symbol}. Stop using it first.`);
    config.token = {
      mint: info.mint,
      name: clip(info.name || 'Linked token', LIMIT.TokenNameBytes),
      symbol: clip(info.symbol || info.mint.slice(0, 4).toUpperCase(), LIMIT.TokenSymbolBytes),
      decimals: info.decimals,
      program: info.program,
      source: 'linked',
    };
    return config;
  });
}

/** Stop using a linked token. A token launched here stays (it is on chain and the creator's). */
export async function unlinkToken({ gameDir }) {
  return updateConfig(gameDir, (config) => {
    if (!config.token) fail('This game has no token.');
    if (config.token.source === 'launched') fail('A token launched here stays with the game.');
    delete config.token;
    return config;
  });
}

// ---------------------------------------------------------------- shop

/** What the shop is priced in: "SOL", "USDC", "token" (the game's) or any mint address, classic SPL or Token-2022. */
export async function setCurrency({ gameDir, rpc, network }, { currency }) {
  const choice = String(currency ?? '').trim();
  const quick = network.currencies.find((c) => c.symbol.toLowerCase() === choice.toLowerCase() || c.kind === choice.toLowerCase() || c.symbol.split('-')[0].toLowerCase() === choice.toLowerCase());
  let next;
  if (quick) next = { mint: quick.mint, symbol: quick.symbol, decimals: quick.decimals, native: quick.mint === NATIVE_MINT, program: 'spl-token' };
  else if (choice.toLowerCase() === 'token') next = null;
  else if (isAddress(choice)) {
    const info = await mintInfo(rpc, choice, { network });
    next = { mint: info.mint, symbol: clip(info.symbol || info.mint.slice(0, 4), 40), decimals: info.decimals, native: info.native, program: info.program };
  } else fail('Currency is SOL, USDC, token (the game’s own) or a mint address.');
  return updateConfig(gameDir, async (config) => {
    if (isLive(config)) fail(`The shop is live and priced in ${config.shop.currency?.symbol}. A live shop keeps its currency.`);
    if (next === null) {
      if (!config.token) fail('This game has no token yet. Launch or link one in the Economy tab.');
      next = defaultCurrency(config);
    }
    const shop = await ensureShop(gameDir, config);
    const old = shop.currency;
    // Rescale draft prices to the new decimals, so 2.5 stays 2.5.
    if (old && old.decimals !== next.decimals) {
      const scale = (units) => {
        const shift = next.decimals - old.decimals;
        const value = shift >= 0 ? BigInt(units) * 10n ** BigInt(shift) : BigInt(units) / 10n ** BigInt(-shift);
        return value.toString();
      };
      for (const item of shop.items) item.price = scale(item.price);
      for (const box of shop.boxes) box.price = scale(box.price);
    }
    shop.currency = next;
    return config;
  });
}

/** The shop's name, description and resale royalty (fixed once the shop is live). */
export async function setShop({ gameDir }, input) {
  return updateConfig(gameDir, async (config) => {
    const shop = await ensureShop(gameDir, config);
    const live = isLive(config);
    if (input.name !== undefined) {
      const name = text(input.name, 'Shop name', { maxBytes: LIMIT.CollectionNameBytes });
      if (live && name !== shop.name) fail('The collection is live; its name can’t change.');
      shop.name = name;
    }
    if (input.description !== undefined) shop.description = text(input.description, 'Description', { maxChars: LIMIT.DescriptionChars, required: false });
    if (input.royaltyBps !== undefined) {
      const bps = wholeNumber(input.royaltyBps, 'Resale royalty (basis points)', 0, LIMIT.MaxRoyaltyBps);
      if (live && bps !== shop.royaltyBps) fail('The collection is live; its royalty can’t change here.');
      shop.royaltyBps = bps;
    }
    return config;
  });
}

/** A price in the shop's currency ("2.5"), or "" for loot boxes only. Sets the currency on the first priced item. */
function priceUnits(config, value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '0') return '0';
  config.shop.currency ??= defaultCurrency(config);
  return toUnits(raw, config.shop.currency.decimals).toString();
}

/**
 * Add or change an item (a draft until "Put it on sale"). Fields: name, picture (a game picture path), rarity,
 * price (in the shop's currency, "" = loot boxes only), description, maxSupply, soulbound, look ({values, files}).
 * `issued`: how many serials the chain has given out; once it has, only price and supply change. `out`: how many
 * exist (issued less those a refund voided), which the supply can't go below.
 */
export async function saveItem({ gameDir }, input, { issued = 0, out = issued } = {}) {
  let saved;
  const config = await updateConfig(gameDir, async (config) => {
    const shop = await ensureShop(gameDir, config);
    const existing = input.id !== undefined && input.id !== null && input.id !== '' ? findItem(config, Number(input.id)) : null;
    if (input.id !== undefined && input.id !== null && input.id !== '' && !existing) fail(`There is no item ${input.id} in this shop.`);
    if (!existing && shop.items.length >= LIMIT.Items) fail(`A shop holds at most ${LIMIT.Items} items.`);
    const item = existing ?? { id: nextId(shop.items), name: '', description: '', rarity: 'Common', price: '0', maxSupply: 0, soulbound: false, listed: false };
    const locked = existing && issued > 0;
    const lockedFields = ['name', 'picture', 'description', 'rarity', 'soulbound', 'look'];
    if (locked && lockedFields.some((f) => input[f] !== undefined && JSON.stringify(input[f]) !== JSON.stringify(f === 'look' ? item.look : item[f])))
      fail('Players already own this item, so its name, picture, rarity and look can’t change. Make a new item instead.');
    if (input.name !== undefined || !existing) item.name = text(input.name, 'Item name', { maxBytes: LIMIT.ItemNameBytes });
    if (input.description !== undefined) item.description = text(input.description, 'Description', { maxChars: LIMIT.DescriptionChars, required: false });
    if (input.rarity !== undefined) item.rarity = rarity(input.rarity);
    if (input.price !== undefined) item.price = priceUnits(config, input.price);
    if (input.maxSupply !== undefined) {
      const supply = wholeNumber(input.maxSupply, 'Supply', 0, 2 ** 32 - 1, 0);
      if (supply && supply < out) fail(`${out} already exist; the supply can’t go below that.`);
      item.maxSupply = supply;
    }
    if (input.soulbound !== undefined) item.soulbound = booleanOf(input.soulbound);
    if (input.picture !== undefined && input.picture !== null && input.picture !== '') {
      const rel = gamePath(input.picture, 'Picture');
      await readPicture(gameDir, rel);
      item.picture = rel;
    }
    if (input.look !== undefined) {
      const raw = typeof input.look === 'string' ? JSON.parse(input.look || '{}') : input.look;
      const look = cleanLook(raw);
      if (Object.keys(look.values).length || Object.keys(look.files).length) item.look = look;
      else delete item.look;
    }
    if (!existing) shop.items.push(item);
    saved = item;
    return config;
  });
  return { config, item: findItem(config, saved.id) };
}

/** Remove a draft item (one that never went on sale and is in no box). */
export async function removeItem({ gameDir }, { id }) {
  return updateConfig(gameDir, (config) => {
    const item = findItem(config, Number(id));
    if (!item) fail(`There is no item ${id} in this shop.`);
    if (item.listed) fail('This item is on sale. Set its price to loot boxes only instead of deleting it.');
    if (config.shop.boxes.some((b) => b.entries.some((e) => e.item === item.id))) fail('This item is in a loot box. Take it out of the box first.');
    config.shop.items = config.shop.items.filter((i) => i.id !== item.id);
    return config;
  });
}

/** Add or change a loot box: name, price (> 0), and odds ("1:60,2:25", [{item, weight}], or empty for rarity weights). */
export async function saveBox({ gameDir }, input) {
  let savedId;
  const config = await updateConfig(gameDir, async (config) => {
    const shop = await ensureShop(gameDir, config);
    if (!shop.items.length) fail('Add an item before making a loot box.');
    const existing = input.id !== undefined && input.id !== null && input.id !== '' ? findBox(config, input.id) : null;
    if (input.id !== undefined && input.id !== null && input.id !== '' && !existing) fail(`There is no loot box ${input.id} in this shop.`);
    if (!existing && shop.boxes.length >= LIMIT.Boxes) fail(`A shop holds at most ${LIMIT.Boxes} loot boxes.`);
    const box = existing ?? { id: nextId(shop.boxes), name: '', price: '0', entries: [], listed: false };
    if (input.name !== undefined || !existing) box.name = text(input.name ?? 'Mystery Box', 'Box name', { maxChars: LIMIT.BoxNameChars });
    if (input.price !== undefined || !existing) {
      box.price = priceUnits(config, input.price);
      if (box.price === '0') fail('A loot box needs a price above 0.');
    }
    if (input.entries !== undefined || input.odds !== undefined || !existing) box.entries = dropTable(input.entries ?? input.odds ?? '', shop.items);
    if (!existing) shop.boxes.push(box);
    savedId = box.id;
    return config;
  });
  return { config, box: findBox(config, savedId) };
}

/** Remove a draft loot box (one that never went on sale). */
export async function removeBox({ gameDir }, { id }) {
  return updateConfig(gameDir, (config) => {
    const box = findBox(config, id);
    if (!box) fail(`There is no loot box ${id} in this shop.`);
    if (box.listed) fail('This loot box is on sale; it can’t be deleted here.');
    config.shop.boxes = config.shop.boxes.filter((b) => b.id !== box.id);
    return config;
  });
}

export { defaultCurrency };
