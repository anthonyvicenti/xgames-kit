// Arweave uploads through Irys, paid from the creator's wallet. A file becomes an ANS-104 data item whose owner is
// the creator's wallet; the wallet signs it in the studio page with `signMessage` (Irys signature type 4, the hex
// text of the 48-byte deep hash, so the wallet shows readable characters), and this side checks that signature and
// posts the item to the node. Written from the ANS-104 specification
// (https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md) and checked byte for byte against
// @irys/bundles 0.0.5 (Apache-2.0) in tests/web3-irys.test.mjs, so the kit needs neither that package nor its
// dependencies.
import { createHash } from 'node:crypto';
import { addressBytes, encodeBase58, isAddress } from '../gf-web3/chain/base58.js';
import { concat, toHex, uintLE, utf8 } from '../gf-web3/chain/bytes.js';

/** Irys signature type for a Solana wallet signing the hex text of the deep hash (HexInjectedSolanaSigner). */
export const SOLANA_HEX_SIGNATURE = 4;
const SIGNATURE_BYTES = 64;
const OWNER_BYTES = 32;
const ANCHOR_BYTES = 32;
const MAX_TAG_BYTES = 4096;
const READ_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 90_000;
/** An Irys id: base64url (or base58 on some nodes) of a SHA-256. */
const ITEM_ID = /^[A-Za-z0-9_-]{32,64}$/;
const LAMPORTS = /^\d{1,20}$/;

const sha384 = (bytes) => new Uint8Array(createHash('sha384').update(bytes).digest());

/** Avro's zig-zag variable-length long. */
function avroLong(value) {
  const out = [];
  let n = BigInt(value) >= 0n ? BigInt(value) << 1n : (-BigInt(value) << 1n) - 1n;
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) byte |= 0x80;
    out.push(byte);
  } while (n > 0n);
  return Uint8Array.from(out);
}

const avroBytes = (bytes) => concat(avroLong(bytes.length), bytes);

/** Tags as ANS-104 serializes them: one Avro array block of {name, value} byte records. */
export function serializeTags(tags) {
  if (!tags.length) return new Uint8Array(0);
  const parts = [avroLong(tags.length)];
  for (const tag of tags) {
    const name = utf8(tag.name);
    const value = utf8(tag.value);
    if (!name.length || name.length > MAX_TAG_BYTES || value.length > MAX_TAG_BYTES) throw new Error('Invalid upload tag');
    parts.push(avroBytes(name), avroBytes(value));
  }
  parts.push(avroLong(0));
  return concat(...parts);
}

/** Arweave's deep hash: SHA-384 over a tagged tree of blobs and lists. */
export function deepHash(chunk) {
  if (!Array.isArray(chunk)) return sha384(concat(sha384(utf8(`blob${chunk.byteLength}`)), sha384(chunk)));
  let acc = sha384(utf8(`list${chunk.length}`));
  for (const item of chunk) acc = sha384(concat(acc, deepHash(item)));
  return acc;
}

/** A new unsigned item owned by a wallet. The random anchor keeps two uploads of the same bytes distinct. */
export function unsignedItem({ owner, data, tags = [], anchor = crypto.getRandomValues(new Uint8Array(ANCHOR_BYTES)) }) {
  const ownerBytes = typeof owner === 'string' ? addressBytes(owner) : owner;
  if (ownerBytes.length !== OWNER_BYTES) throw new Error('A Solana owner key is 32 bytes');
  if (anchor.length !== ANCHOR_BYTES) throw new Error('An anchor is 32 bytes');
  return { owner: ownerBytes, anchor, tags: serializeTags(tags), tagCount: tags.length, data };
}

/** The 48 bytes the signature covers. */
export function signatureData(item) {
  return deepHash([
    utf8('dataitem'),
    utf8('1'),
    utf8(String(SOLANA_HEX_SIGNATURE)),
    item.owner,
    new Uint8Array(0),
    item.anchor,
    item.tags,
    item.data,
  ]);
}

/** The text the wallet signs with `signMessage` (as UTF-8): the deep hash in hex. */
export const messageToSign = (item) => toHex(signatureData(item));

/** The signed item's bytes, ready for the node. */
export function signedItem(item, signature) {
  if (signature.length !== SIGNATURE_BYTES) throw new Error('A Solana signature is 64 bytes');
  return concat(
    uintLE(SOLANA_HEX_SIGNATURE, 2),
    signature,
    item.owner,
    Uint8Array.of(0), // no target
    Uint8Array.of(1),
    item.anchor,
    uintLE(item.tagCount, 8),
    uintLE(item.tags.length, 8),
    item.tags,
    item.data,
  );
}

/** The item's id as Irys reports it: base58 of SHA-256 of the signature (known as soon as the wallet signs). */
export const itemId = (signature) => encodeBase58(new Uint8Array(createHash('sha256').update(signature).digest()));

// ---------------------------------------------------------------- the node's HTTP API

async function call(fetchImpl, url, init, timeoutMs, what) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`Irys ${what} did not answer: ${error.message}`);
  }
  const body = await response.text();
  if (!response.ok) throw new Error(`Irys ${what} failed (${response.status}): ${body.slice(0, 200)}`);
  return body;
}

function json(text, what) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw new Error(`Irys ${what} answered with something unexpected`);
}

/** The Irys node API for one network's `irys` settings ({ node, gateway, currency }). */
export function irysNode(irys, { fetchImpl = globalThis.fetch } = {}) {
  return {
    /** What storing this many bytes costs, in lamports. */
    async price(bytes) {
      const text = (await call(fetchImpl, `${irys.node}/price/${irys.currency}/${bytes}`, {}, READ_TIMEOUT_MS, 'price')).trim();
      if (!LAMPORTS.test(text)) throw new Error('Irys price answered with something unexpected');
      return BigInt(text);
    },
    /** The wallet's prepaid balance on the node, in lamports. */
    async balance(wallet) {
      const url = `${irys.node}/account/balance/${irys.currency}?address=${encodeURIComponent(wallet)}`;
      const balance = json(await call(fetchImpl, url, {}, READ_TIMEOUT_MS, 'balance'), 'balance').balance;
      if (!LAMPORTS.test(String(balance ?? ''))) throw new Error('Irys balance answered with something unexpected');
      return BigInt(balance);
    },
    /** The node's Solana address, where a deposit goes. */
    async depositAddress() {
      const addresses = json(await call(fetchImpl, `${irys.node}/info`, {}, READ_TIMEOUT_MS, 'info'), 'info').addresses;
      const address = addresses?.[irys.currency];
      if (!isAddress(address)) throw new Error('Irys info answered with something unexpected');
      return address;
    },
    /** Tell the node about a confirmed deposit transaction, so it credits the sender. */
    async registerDeposit(signature) {
      await call(
        fetchImpl,
        `${irys.node}/account/balance/${irys.currency}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx_id: signature }) },
        UPLOAD_TIMEOUT_MS,
        'deposit',
      );
    },
    /** Upload a signed data item; returns its id. */
    async upload(item) {
      const text = await call(
        fetchImpl,
        `${irys.node}/tx/${irys.currency}`,
        { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: item },
        UPLOAD_TIMEOUT_MS,
        'upload',
      );
      const id = json(text, 'upload').id;
      if (typeof id !== 'string' || !ITEM_ID.test(id)) throw new Error('Irys upload answered with something unexpected');
      return id;
    },
    /** Where the gateway serves an uploaded item. */
    url: (id) => `${irys.gateway}/${id}`,
  };
}

