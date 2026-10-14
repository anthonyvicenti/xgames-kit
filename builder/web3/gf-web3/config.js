// gamesfun.json: a game's public web3 settings, kept in the game folder so the in-game kit can read them and an
// export carries them. Public addresses, names, prices, links and looks only. Never a key, a token, a keyed RPC URL
// or a creator setting: reading keeps only the fields below, and writing refuses anything that looks like a secret.
// Schema: builder/web3/gamesfun.schema.json (documentation; this module is what enforces it).
import { isAddress, isSignature } from './chain/base58.js';
import { cleanLook } from './looks.js';
import { DEVNET } from './network.js';
import { LIMIT, RARITIES, secretLike } from './rules.js';

export const CONFIG_FILE = 'gamesfun.json';
export const CONFIG_VERSION = 1;

const MAX_DECIMALS = 18;
const MAX_ID = 2 ** 32 - 1;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bytes = (s) => new TextEncoder().encode(s).length;

const str = (v, { maxBytes, maxChars = LIMIT.DescriptionChars } = {}) =>
  typeof v === 'string' &&
  v.length <= maxChars &&
  (!maxBytes || bytes(v) <= maxBytes) &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) &&
  !secretLike(v)
    ? v
    : undefined;
const units = (v) => (typeof v === 'string' && /^\d{1,20}$/.test(v) && BigInt(v) < 2n ** 64n ? v : undefined);
const whole = (v, min, max) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const address = (v) => (isAddress(v) ? v : undefined);
const hash = (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : undefined);

/** An https link a public page may show: no credentials, no query, at most 512 characters. */
function link(v) {
  if (typeof v !== 'string' || v.length > 512 || secretLike(v)) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A picture inside the game folder (the source an item's picture is uploaded from). */
const picture = (v) =>
  typeof v === 'string' &&
  v.length <= 300 &&
  /\.(png|jpe?g|webp|gif)$/i.test(v) &&
  !/^[a-z][a-z0-9+.-]*:/i.test(v) &&
  !v.startsWith('/') &&
  !v.includes('\\') &&
  !v.split('/').some((s) => s === '..' || s === '' || s === '.')
    ? v
    : undefined;

/** Only the fields that are present and valid. */
const present = (entries) => Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));

function cleanToken(v) {
  if (!isObject(v)) return undefined;
  const mint = address(v.mint);
  const name = str(v.name, { maxBytes: LIMIT.TokenNameBytes });
  const symbol = str(v.symbol, { maxBytes: LIMIT.TokenSymbolBytes });
  const decimals = whole(v.decimals, 0, MAX_DECIMALS);
  if (!mint || name === undefined || symbol === undefined || decimals === undefined) return undefined;
  return {
    mint,
    name,
    symbol,
    decimals,
    program: v.program === 'token-2022' ? 'token-2022' : 'spl-token',
    source: v.source === 'launched' ? 'launched' : 'linked',
    ...present({
      image: link(v.image),
      metadataUri: link(v.metadataUri),
      pool: address(v.pool),
      config: address(v.config),
      quoteMint: address(v.quoteMint),
      quoteSymbol: str(v.quoteSymbol, { maxChars: 40 }),
      split: cleanSplit(v.split),
      signature: isSignature(v.signature) ? v.signature : undefined,
      signatures: Array.isArray(v.signatures) && v.signatures.length && v.signatures.every(isSignature) ? [...v.signatures] : undefined,
    }),
  };
}

/** The fee split a launched token's config carries, as read back from chain (whole percents). */
function cleanSplit(v) {
  if (!isObject(v)) return undefined;
  const out = present({ creatorTradingFeePercentage: whole(v.creatorTradingFeePercentage, 0, 100), partnerLockedLp: whole(v.partnerLockedLp, 0, 100), creatorLockedLp: whole(v.creatorLockedLp, 0, 100) });
  return Object.keys(out).length ? out : undefined;
}

function cleanCurrency(v) {
  if (!isObject(v)) return undefined;
  const mint = address(v.mint);
  const symbol = str(v.symbol, { maxChars: 40 });
  const decimals = whole(v.decimals, 0, MAX_DECIMALS);
  if (!mint || !symbol || decimals === undefined) return undefined;
  return { mint, symbol, decimals, native: v.native === true, program: v.program === 'token-2022' ? 'token-2022' : 'spl-token' };
}

function cleanItem(v) {
  if (!isObject(v)) return undefined;
  const id = whole(v.id, 1, MAX_ID);
  const name = str(v.name, { maxBytes: LIMIT.ItemNameBytes });
  const price = units(v.price ?? '0');
  const rarity = RARITIES.find((r) => r === v.rarity) ?? 'Common';
  if (id === undefined || !name || !price) return undefined;
  const look = cleanLook(v.look);
  return {
    id,
    name,
    description: str(v.description) ?? '',
    rarity,
    price,
    maxSupply: whole(v.maxSupply, 0, MAX_ID) ?? 0,
    soulbound: v.soulbound === true,
    ...present({
      picture: picture(v.picture),
      look: Object.keys(look.values).length || Object.keys(look.files).length ? look : undefined,
      image: link(v.image),
      imageHash: hash(v.imageHash),
      uri: link(v.uri),
      metaHash: hash(v.metaHash),
    }),
    listed: v.listed === true,
  };
}

function cleanBox(v, itemIds) {
  if (!isObject(v) || !Array.isArray(v.entries)) return undefined;
  const id = whole(v.id, 1, MAX_ID);
  const name = str(v.name, { maxChars: LIMIT.BoxNameChars });
  const price = units(v.price);
  const seen = new Set();
  const entries = v.entries
    .filter(isObject)
    .map((e) => ({ item: whole(e.item, 1, MAX_ID), weight: whole(e.weight, 1, LIMIT.MaxWeight) }))
    .filter((e) => e.item !== undefined && e.weight !== undefined && itemIds.has(e.item) && !seen.has(e.item) && seen.add(e.item));
  if (id === undefined || !name || !price || price === '0' || !entries.length || entries.length > LIMIT.BoxEntries) return undefined;
  return { id, name, price, entries, listed: v.listed === true };
}

function cleanShop(v) {
  if (!isObject(v)) return undefined;
  const name = str(v.name, { maxBytes: LIMIT.CollectionNameBytes });
  if (!name) return undefined;
  const unique = (list, key = (x) => x.id) => {
    const seen = new Set();
    return list.filter((x) => x && !seen.has(key(x)) && seen.add(key(x)));
  };
  const items = unique((Array.isArray(v.items) ? v.items : []).map(cleanItem)).slice(0, LIMIT.Items);
  const itemIds = new Set(items.map((i) => i.id));
  const boxes = unique((Array.isArray(v.boxes) ? v.boxes : []).map((b) => cleanBox(b, itemIds))).slice(0, LIMIT.Boxes);
  return {
    name,
    description: str(v.description) ?? '',
    royaltyBps: whole(v.royaltyBps, 0, LIMIT.MaxRoyaltyBps) ?? 500,
    ...present({
      currency: cleanCurrency(v.currency),
      collection: address(v.collection),
      game: address(v.game),
      treasury: address(v.treasury),
      image: link(v.image),
      metadataUri: link(v.metadataUri),
      metaHash: hash(v.metaHash),
    }),
    items,
    boxes,
  };
}

/** An empty setup. */
export const emptyConfig = () => ({ version: CONFIG_VERSION, network: DEVNET });

/** A config object with only valid known fields. Network and version are checked by parseConfig. */
export function cleanConfig(value) {
  if (!isObject(value)) return emptyConfig();
  const creator = address(value.creator);
  const token = cleanToken(value.token);
  const shop = cleanShop(value.shop);
  // The economy section is checked by builder/web3/economy/check.mjs, not here; this file only carries it through.
  const economy = isObject(value.economy) ? value.economy : null;
  return {
    version: CONFIG_VERSION,
    network: DEVNET,
    ...(creator ? { creator } : {}),
    ...(token ? { token } : {}),
    ...(shop ? { shop } : {}),
    ...(economy ? { economy } : {}),
  };
}

/**
 * The game's gamesfun.json, keeping only valid known fields. Missing or empty text is an empty setup; broken JSON,
 * another version or another network is refused rather than reinterpreted.
 */
export function parseConfig(text) {
  if (text === null || text === undefined || !String(text).trim()) return emptyConfig();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${CONFIG_FILE} is not valid JSON.`);
  }
  if (!isObject(value) || value.version !== CONFIG_VERSION) throw new Error(`${CONFIG_FILE} has an unknown version.`);
  if (value.network !== DEVNET) throw new Error(`${CONFIG_FILE} names a network this kit does not support (devnet only).`);
  return cleanConfig(value);
}

/** The file's text: the cleaned config, pretty-printed. Refuses to write anything that looks like a secret. */
export function serializeConfig(config) {
  const clean = cleanConfig(config);
  const text = `${JSON.stringify(clean, null, 2)}\n`;
  // Transaction signatures are 64 bytes of base58 like a secret key, so the scan skips them by field name.
  const scan = text
    .replace(/"signature": "[1-9A-HJ-NP-Za-km-z]{64,88}"/g, '"signature": ""')
    .replace(/"signatures": \[(\s*"[1-9A-HJ-NP-Za-km-z]{64,88}",?)+\s*\]/g, '"signatures": []');
  if (secretLike(scan)) throw new Error(`Refusing to write ${CONFIG_FILE}: something in it looks like a key or secret.`);
  return text;
}

/** An item by id (number or digits) or by name (any case). */
export function findItem(config, sku) {
  const items = config.shop?.items ?? [];
  const id = typeof sku === 'number' ? sku : /^\d+$/.test(String(sku ?? '').trim()) ? Number(sku) : NaN;
  return items.find((i) => i.id === id) ?? items.find((i) => i.name.toLowerCase() === String(sku ?? '').trim().toLowerCase());
}

export const findBox = (config, id) => (config.shop?.boxes ?? []).find((b) => b.id === Number(id));

/** The next free id in a list. */
export const nextId = (list) => Math.max(0, ...list.map((x) => x.id)) + 1;
