// Rules shared by the creator surfaces (CLI, MCP, studio, server) and the in-game kit: field limits that mirror the
// chain (Metaplex token metadata, the loot program), unit conversion, rarities, odds, and the check that keeps
// secrets out of a public game. Pure. Ported from games.fun's creator-studio/lib/web3/rules.mjs.

export const LIMIT = Object.freeze({
  TokenNameBytes: 32,
  TokenSymbolBytes: 10,
  ItemNameBytes: 32,
  CollectionNameBytes: 32,
  UriBytes: 200,
  DescriptionChars: 1000,
  BoxNameChars: 40,
  BoxEntries: 8,
  MaxWeight: 1_000_000,
  MaxRoyaltyBps: 2500,
  Items: 50,
  Boxes: 20,
  /** A shop publish sends at most this many transactions in one wallet approval. */
  PublishTransactions: 12,
});

/** Rarity names, in the order the program stores them (Item.rarity). */
export const RARITIES = Object.freeze(['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']);
/** Default drop weights by rarity, for a box whose odds the creator did not set. */
export const RARITY_WEIGHTS = Object.freeze({ Common: 60, Uncommon: 25, Rare: 10, Epic: 4, Legendary: 1 });
export const MAX_U64 = 2n ** 64n - 1n;
/** Control characters end up in on-chain strings and wallet screens. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** A refusal the creator reads as is. */
export class RuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuleError';
  }
}

const fail = (message) => {
  throw new RuleError(message);
};

const utf8Length = (s) => new TextEncoder().encode(s).length;

/** Trimmed text within its limits, or a refusal naming the field. */
export function text(value, label, { maxBytes, maxChars, required = true } = {}) {
  if (value !== undefined && value !== null && typeof value !== 'string') fail(`${label} must be text.`);
  const trimmed = String(value ?? '').trim();
  if (!trimmed && required) fail(`${label} is required.`);
  if (CONTROL.test(trimmed)) fail(`${label} contains control characters.`);
  if (maxBytes && utf8Length(trimmed) > maxBytes) fail(`${label} must be at most ${maxBytes} bytes.`);
  if (maxChars && trimmed.length > maxChars) fail(`${label} must be at most ${maxChars} characters.`);
  if (secretLike(trimmed)) fail(`${label} looks like it holds a key or secret. Never put secrets in a game.`);
  return trimmed;
}

/** A ticker: 2–10 letters or digits, upper case, without a leading `$`. */
export function ticker(value) {
  const symbol = text(value, 'Ticker', { maxBytes: LIMIT.TokenSymbolBytes + 1 }).replace(/^\$/, '').toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) fail('Ticker must be 2–10 letters or digits.');
  return symbol;
}

/** "12.5" with 6 decimals → 12500000n. Refuses more precision than the token has. */
export function toUnits(value, decimals) {
  const amount = String(value ?? '').trim();
  if (!/^\d{1,20}(\.\d+)?$/.test(amount)) fail('Enter an amount like 10 or 2.5.');
  const [whole = '0', fraction = ''] = amount.split('.');
  if (fraction.length > decimals) fail(`At most ${decimals} decimal places.`);
  const units = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (units > MAX_U64) fail('That amount is too large.');
  return units;
}

/** 12500000n with 6 decimals → "12.5". */
export function fromUnits(units, decimals) {
  const digits = BigInt(units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** A rarity by name (any case) or index. */
export function rarity(value) {
  const index =
    typeof value === 'number' ? value : RARITIES.findIndex((r) => r.toLowerCase() === String(value ?? 'common').trim().toLowerCase());
  const found = RARITIES[index];
  if (!found) fail(`Rarity must be one of ${RARITIES.join(', ')}.`);
  return found;
}

export const rarityIndex = (value) => RARITIES.indexOf(value);

/** A whole number within bounds; empty means `fallback`. */
export function wholeNumber(value, label, min, max, fallback = min) {
  const n = typeof value === 'string' ? (value.trim() ? Number(value.trim()) : undefined) : value;
  if (n === undefined || n === null) return fallback;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

/**
 * A box's drop table: [{item, weight}] or "itemId:weight" pairs ("1:60, 2:25"). An empty table takes every listed
 * item (up to 8) with its rarity's default weight.
 */
export function dropTable(value, items) {
  let entries;
  if (Array.isArray(value)) {
    entries = value.map((e) => ({
      item: wholeNumber(e?.item ?? e?.itemId, 'Item id', 1, 2 ** 32 - 1),
      weight: wholeNumber(e?.weight, 'Drop weight', 1, LIMIT.MaxWeight, RARITY_WEIGHTS[items.find((i) => i.id === Number(e?.item ?? e?.itemId))?.rarity] ?? 1),
    }));
  } else {
    const spec = text(value, 'Odds', { maxChars: 400, required: false });
    entries = spec
      ? spec.split(',').map((pair) => {
          const [id = '', weight = ''] = pair.split(':').map((s) => s.trim());
          const item = wholeNumber(id, 'Item id', 1, 2 ** 32 - 1);
          const fallback = RARITY_WEIGHTS[items.find((i) => i.id === item)?.rarity] ?? 1;
          return { item, weight: wholeNumber(weight, 'Drop weight', 1, LIMIT.MaxWeight, fallback) };
        })
      : items.slice(0, LIMIT.BoxEntries).map((item) => ({ item: item.id, weight: RARITY_WEIGHTS[item.rarity] ?? 1 }));
  }
  if (!entries.length) fail('Add an item before making a loot box.');
  if (entries.length > LIMIT.BoxEntries) fail(`A box holds at most ${LIMIT.BoxEntries} items.`);
  const seen = new Set();
  for (const entry of entries) {
    if (!items.some((item) => item.id === entry.item)) fail(`Item ${entry.item} is not in this shop.`);
    if (seen.has(entry.item)) fail('Each item can appear once per box.');
    seen.add(entry.item);
  }
  return entries;
}

/** Published odds: each entry's share of the total weight (entries not available count 0). */
export function odds(entries, available = () => true) {
  const total = entries.reduce((n, e) => n + (available(e.item) ? e.weight : 0), 0);
  return entries.map((e) => ({ ...e, chance: total && available(e.item) ? e.weight / total : 0 }));
}

/** A URI that fits the on-chain field. */
export function onChainUri(uri) {
  if (utf8Length(uri) > LIMIT.UriBytes) fail(`Metadata link is longer than ${LIMIT.UriBytes} bytes.`);
  return uri;
}

// ---------------------------------------------------------------- secrets never go in a game

const SECRET_PATTERNS = [
  // a 64-byte Solana secret key in base58 (signatures are the same length; the schema keeps those in their own field)
  /(^|[^1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{86,90}($|[^1-9A-HJ-NP-Za-km-z])/,
  // a keypair file's byte array
  /\[\s*\d{1,3}(\s*,\s*\d{1,3}){31,}\s*\]/,
  // key=value or key: value for credential names
  /\b(api[-_ ]?key|apikey|secret|private[-_ ]?key|secret[-_ ]?key|seed[-_ ]?phrase|mnemonic|access[-_ ]?token|auth[-_ ]?token|bearer)\b\s*[=:]/i,
  // a credential in a URL query
  /[?&](api[-_]?key|apikey|key|token|secret|auth|access_token|sig)=/i,
  // RPC providers that put the key in the path
  /\b(helius-rpc\.com|quiknode\.pro|alchemy\.com\/v2|ankr\.com\/[a-z]+\/[0-9a-f]{32})/i,
  // PEM blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Whether a string looks like it carries a key, a token or a keyed RPC URL. */
export const secretLike = (value) => typeof value === 'string' && SECRET_PATTERNS.some((p) => p.test(value));

/** A public https link: no credentials, no query keys, at most `max` characters. */
export function publicUrl(value, label = 'Link', max = 512) {
  const t = text(value, label, { maxChars: max });
  let url;
  try {
    url = new URL(t);
  } catch {
    fail(`${label} is not a valid link.`);
  }
  if (url.protocol !== 'https:') fail(`${label} must be an https link.`);
  if (url.username || url.password) fail(`${label} must not contain credentials.`);
  return url.toString();
}

/** A path inside the game folder: relative, forward slashes, no `..`, no drive letters, no scheme. */
export function gamePath(value, label = 'Path') {
  const t = text(value, label, { maxChars: 300 }).replaceAll('\\', '/').replace(/^\.\//, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/') || t.split('/').some((s) => s === '..' || s === '') || t.includes('\0'))
    fail(`${label} must be a path inside the game folder, like assets/hat.png.`);
  return t;
}
