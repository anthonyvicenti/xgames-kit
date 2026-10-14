// Chain reads for the creator surfaces: what a mint is, and where the game's token and shop stand on chain (each item
// and box: draft, published, or changed since it was published). Read-only; nothing here signs.
import { createHash } from 'node:crypto';
import { isAddress } from '../gf-web3/chain/base58.js';
import { readPoolConfig, readVirtualPool, dbcPda } from '../gf-web3/chain/dbc.js';
import { decodeLoot, itemOut, LootAccount, lootPda } from '../gf-web3/chain/loot.js';
import { parseMint } from '../gf-web3/chain/mint.js';
import { metadataAddress, NATIVE_MINT } from '../gf-web3/chain/pda.js';
import { cleanLook, isEmptyLook } from '../gf-web3/looks.js';
import { explorerUrl } from '../gf-web3/network.js';
import { rarityIndex, RuleError } from '../gf-web3/rules.js';

/**
 * What a mint is on this network, or a plain refusal. SOL is answered without a read. A devnet test mint the network
 * config knows (USDC-dev, MAIN-dev) gets its known name when it carries no metadata.
 */
export async function mintInfo(rpc, address, { network = null } = {}) {
  const mint = String(address ?? '').trim();
  if (!isAddress(mint)) throw new RuleError('That is not a Solana address. Paste the token’s mint address.');
  if (mint === NATIVE_MINT)
    return { mint, program: 'spl-token', native: true, decimals: 9, supply: null, mintAuthority: null, freezeAuthority: null, name: 'Solana', symbol: 'SOL', uri: null };
  const [account, metadata] = await rpc.accounts([mint, metadataAddress(mint)]);
  if (!account) throw new RuleError('There is no token at that address on devnet.');
  const info = parseMint(mint, account.owner, account.data, metadata?.data ?? null);
  if (!info) throw new RuleError('That address is not a token mint (it may be a wallet, a pool or a token account).');
  const known = network?.knownMints?.find((c) => c.mint === mint);
  if (known && !info.symbol) Object.assign(info, { symbol: known.symbol, name: known.name });
  return info;
}

/** Stable JSON (sorted keys), so a hash of it only changes when the content does. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hashJson = (value) => createHash('sha256').update(canonical(value)).digest('hex');

/** What an item's uploaded metadata depends on: when this changes, the metadata is uploaded again. */
export const itemMetaSource = (shop, item, image = item.image) => ({
  name: item.name,
  description: item.description,
  rarity: item.rarity,
  soulbound: item.soulbound,
  game: shop.name,
  image: image ?? null,
  look: cleanLook(item.look),
});
/** What the collection's uploaded metadata depends on. */
export const collectionMetaSource = (shop, image = shop.image) => ({ name: shop.name, description: shop.description, image: image ?? null });

/** The public metadata JSON of an item (what wallets and explorers show), from its config and uploaded picture. */
export function itemMetadata(shop, item, image, contentType) {
  const look = cleanLook(item.look);
  return {
    name: item.name,
    description: item.description,
    image,
    attributes: [
      { trait_type: 'Rarity', value: item.rarity },
      { trait_type: 'Game', value: shop.name },
      ...(item.soulbound ? [{ trait_type: 'Soulbound', value: 'Yes' }] : []),
    ],
    properties: {
      files: [{ uri: image, type: contentType }],
      category: 'image',
      ...(isEmptyLook(look) ? {} : { gameLook: look }),
    },
  };
}

/** The public metadata JSON of the shop's collection. */
export const collectionMetadata = (shop, image, contentType) => ({
  name: shop.name,
  description: shop.description || `Items for ${shop.name}.`,
  image,
  properties: { files: [{ uri: image, type: contentType }], category: 'image' },
});

/** The public metadata JSON of a launched token. */
export const tokenMetadata = ({ name, symbol, description, image, contentType }) => ({
  name,
  symbol,
  description,
  image,
  properties: { files: [{ uri: image, type: contentType }], category: 'image', launchpad: 'games.fun' },
});

/** An item's on-chain definition (ItemArgs, program 0.3), from its config: a collectible, the whole sale to the treasury. */
export const itemOnChainArgs = (item) => ({
  kind: 'Collectible',
  rarity: rarityIndex(item.rarity),
  soulbound: item.soulbound,
  name: item.name,
  uri: item.uri ?? '',
  max_supply: item.maxSupply,
  price: BigInt(item.price),
  active: true,
});

/** A box's on-chain definition (BoxArgs): priced in the game's own currency, one item per entry. */
export const boxOnChainArgs = (box) => ({
  price: BigInt(box.price),
  entries: box.entries.map((e) => ({ outcome: { Item: [e.item] }, weight: e.weight })),
});

const sameItem = (item, onChain) =>
  onChain.kind === 'Collectible' &&
  onChain.name === item.name &&
  onChain.uri === (item.uri ?? '') &&
  onChain.price === BigInt(item.price) &&
  onChain.max_supply === item.maxSupply &&
  onChain.soulbound === item.soulbound &&
  onChain.rarity === rarityIndex(item.rarity) &&
  onChain.active === true &&
  !onChain.rise && !onChain.fall && !onChain.life && !onChain.shares.length;

const sameBox = (box, onChain) =>
  onChain.price === BigInt(box.price) &&
  onChain.active === true &&
  !onChain.currency && !onChain.rise && !onChain.fall && !onChain.shares.length &&
  onChain.entries.length === box.entries.length &&
  onChain.entries.every((e, i) => e.outcome?.Item?.[0] === box.entries[i].item && e.weight === box.entries[i].weight);

/**
 * The game's token and shop as the chain has them. `pictureHash(path)` returns the current sha256 of a game picture
 * (or null), so an item whose picture changed since its upload reads as changed. Returns:
 * { token: {exists, pool?, explorer}, shop: {exists, game?, items: {id: {state, issued, out, onChain}}, boxes: {...}} }
 */
export async function chainStatus(rpc, network, config, { pictureHash = async () => null } = {}) {
  const token = config.token;
  const shop = config.shop;
  const game = shop?.collection ? lootPda.game(shop.collection) : null;
  const addresses = [
    token?.mint,
    token?.pool,
    shop?.collection,
    game,
    ...(game ? (shop.items ?? []).map((i) => lootPda.item(game, i.id)) : []),
    ...(game ? (shop.boxes ?? []).map((b) => lootPda.box(game, b.id)) : []),
  ].filter(Boolean);
  const accounts = addresses.length ? await rpc.accounts(addresses) : [];
  const byAddress = new Map(addresses.map((a, i) => [a, accounts[i]]));
  const out = { token: null, shop: null };
  if (token) {
    let pool = null;
    try {
      pool = token.pool && byAddress.get(token.pool) ? readVirtualPool(byAddress.get(token.pool).data) : null;
    } catch {
      pool = null;
    }
    out.token = {
      exists: Boolean(byAddress.get(token.mint)),
      pool: pool ? { creator: pool.creator, baseReserve: pool.baseReserve.toString(), quoteReserve: pool.quoteReserve.toString(), isMigrated: pool.isMigrated } : null,
      explorer: explorerUrl(network, 'address', token.mint),
    };
  }
  if (shop) {
    let gameAccount = null;
    try {
      gameAccount = game && byAddress.get(game) ? decodeLoot(LootAccount.Game, byAddress.get(game).data) : null;
    } catch {
      gameAccount = null;
    }
    const items = {};
    for (const item of shop.items) {
      let onChain = null;
      try {
        const a = game ? byAddress.get(lootPda.item(game, item.id)) : null;
        onChain = a ? decodeLoot(LootAccount.Item, a.data) : null;
      } catch {
        onChain = null;
      }
      const currentPicture = item.picture ? await pictureHash(item.picture) : null;
      const pictureChanged = Boolean(currentPicture && item.imageHash && currentPicture !== item.imageHash);
      const needsPicture = !item.image && !currentPicture;
      const metaStale = !item.uri || pictureChanged || !item.image || item.metaHash !== hashJson(itemMetaSource(shop, item));
      let state = 'draft';
      if (onChain) state = sameItem(item, onChain) && !metaStale ? 'published' : 'changed';
      items[item.id] = {
        state,
        issued: onChain ? onChain.issued : 0,
        out: onChain ? itemOut(onChain) : 0,
        onChain: onChain ? { name: onChain.name, uri: onChain.uri, price: onChain.price.toString(), maxSupply: onChain.max_supply, active: onChain.active } : null,
        needsPicture,
        needsUpload: !item.image || pictureChanged || metaStale,
      };
    }
    const boxes = {};
    for (const box of shop.boxes) {
      let onChain = null;
      try {
        const a = game ? byAddress.get(lootPda.box(game, box.id)) : null;
        onChain = a ? decodeLoot(LootAccount.Box, a.data) : null;
      } catch {
        onChain = null;
      }
      boxes[box.id] = {
        state: onChain ? (sameBox(box, onChain) ? 'published' : 'changed') : 'draft',
        opened: onChain ? Number(onChain.opened) : 0,
      };
    }
    out.shop = {
      exists: Boolean(gameAccount),
      collectionExists: Boolean(shop.collection && byAddress.get(shop.collection)),
      game: gameAccount ? { mint: gameAccount.mint, treasury: gameAccount.treasury, owner: gameAccount.owner, authority: gameAccount.authority, paused: gameAccount.paused } : null,
      explorer: shop.collection ? explorerUrl(network, 'address', shop.collection) : null,
      items,
      boxes,
    };
  }
  return out;
}

// Token-2022 extensions a DBC quote mint may carry without a token badge (DBC 0.2.1 utils/token.rs, as games.fun's
// launchpad lib/pairs.mjs reads it): metadata, and a transfer fee config whose fees are zero.
const T22_TRANSFER_FEE_CONFIG = 1;
const T22_METADATA_POINTER = 18;
const T22_TOKEN_METADATA = 19;
const NATIVE_MINT_2022 = '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP';

function token2022Extensions(data) {
  const found = [];
  if (data.length <= 165 || data[165] !== 1) return found;
  let at = 166;
  while (at + 4 <= data.length) {
    const type = data[at] | (data[at + 1] << 8);
    const length = data[at + 2] | (data[at + 3] << 8);
    if (type === 0) break;
    found.push({ type, value: data.subarray(at + 4, at + 4 + length) });
    at += 4 + length;
  }
  return found;
}

/** Can a DBC config be quoted in this mint? Classic SPL and SOL: yes. Token-2022: only without badge extensions. */
function meteoraCheck(info, data) {
  if (info.native) return { ok: true, reason: null };
  if (info.mint === NATIVE_MINT_2022) return { ok: false, reason: 'Token-2022 wrapped SOL cannot be a Meteora pair; use SOL.' };
  if (info.program !== 'token-2022') return { ok: true, reason: null };
  const extensions = token2022Extensions(data);
  const other = extensions.filter((e) => ![T22_TRANSFER_FEE_CONFIG, T22_METADATA_POINTER, T22_TOKEN_METADATA].includes(e.type));
  if (other.length) return { ok: false, reason: `This Token-2022 token has extensions Meteora does not take without a token badge (types ${other.map((e) => e.type).join(', ')}).` };
  const fee = extensions.find((e) => e.type === T22_TRANSFER_FEE_CONFIG)?.value;
  // TransferFeeConfig: two authorities, the withheld amount, then the older and newer fees (epoch, maximum, bps).
  if (fee && fee.length >= 108 && ((fee[88] | (fee[89] << 8)) > 0 || (fee[106] | (fee[107] << 8)) > 0)) return { ok: false, reason: 'Tokens with a transfer fee cannot be a Meteora pair.' };
  return { ok: true, reason: null };
}

/**
 * The pair a token launches against (the DBC quote mint): "SOL" (the default), "USDC" / "USDC-dev", or any mint
 * address. Returns { mint, symbol, name, decimals, program, native, usd, usdSource, meteora: { ok, reason } }.
 * Prices are the network's devnet reference prices (network.launchpad.pairPrices), never fetched; `solUsd` overrides
 * SOL's. A mint with no price needs the creator's own market caps.
 */
export async function describePair(rpc, network, choice, { solUsd = null } = {}) {
  const { launchpad } = network;
  const text = String(choice ?? '').trim() || launchpad.defaultPair;
  const quick = launchpad.pairs.find((p) => p.symbol.toLowerCase() === text.toLowerCase() || p.symbol.split('-')[0].toLowerCase() === text.toLowerCase() || (text.toLowerCase() === 'native' && p.native));
  const address = quick?.mint ?? text;
  if (!isAddress(address)) throw new RuleError(`A pair is SOL, USDC or a token's mint address (got "${text}").`);
  const info = await mintInfo(rpc, address, { network });
  let data = null;
  if (info.program === 'token-2022') data = (await rpc.account(info.mint))?.data ?? null;
  let usd = launchpad.pairPrices[info.mint] ?? null;
  let usdSource = usd == null ? null : 'devnet reference price';
  if (info.native && solUsd != null) {
    const price = Number(solUsd);
    if (!(price > 0) || !Number.isFinite(price)) throw new RuleError('The SOL price must be a positive number of dollars.');
    usd = price;
    usdSource = 'your price';
  }
  return {
    mint: info.mint,
    symbol: quick?.symbol ?? (info.symbol || info.mint.slice(0, 4)),
    name: info.name ?? null,
    decimals: info.decimals,
    program: info.program,
    native: Boolean(info.native),
    usd,
    usdSource,
    meteora: meteoraCheck(info, data ?? new Uint8Array(0)),
  };
}

/** A DBC config account, decoded (the fields the kit reads, the split included). */
export async function poolConfigAt(rpc, address) {
  const account = await rpc.account(address);
  if (!account) throw new Error(`There is no DBC config at ${address}.`);
  return readPoolConfig(account.data);
}

export { dbcPda };
