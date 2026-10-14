// Solana transactions without @solana/web3.js: compile instructions into a legacy or v0 message (v0 can load
// accounts from address lookup tables), wrap a message with signature slots, read a wire transaction back, and put
// a signature in its slot. Used by the Node side (creator flows) and by the in-game kit (player purchases).
import { addressBytes, encodeBase58 } from './base58.js';
import { compactU16, concat, equalBytes, readCompactU16 } from './bytes.js';

/** A serialized transaction must fit one packet. */
export const MAX_TRANSACTION_BYTES = 1232;
export const SIGNATURE_BYTES = 64;
const V0_PREFIX = 0x80;

/**
 * Every account once, in first-seen order: the payer, then each instruction's program and its accounts. Signing or
 * writable anywhere means signing or writable. Same order as @solana/web3.js's MessageV0.compile.
 */
function mergedAccounts(payer, instructions) {
  const merged = new Map([[payer, { pubkey: payer, isSigner: true, isWritable: true, invoked: false }]]);
  const add = (pubkey, isSigner, isWritable, invoked) => {
    addressBytes(pubkey);
    const seen = merged.get(pubkey);
    if (!seen) merged.set(pubkey, { pubkey, isSigner, isWritable, invoked });
    else {
      seen.isSigner ||= isSigner;
      seen.isWritable ||= isWritable;
      seen.invoked ||= invoked;
    }
  };
  for (const ix of instructions) {
    add(ix.programId, false, false, true);
    for (const key of ix.keys) add(key.pubkey, key.isSigner, key.isWritable, false);
  }
  return [...merged.values()];
}

/** The order a message lists accounts in: signers first, writable before read-only; payer at the head. */
const rank = (m) => (m.isSigner ? 0 : 2) + (m.isWritable ? 0 : 1);

function compileInstructions(instructions, index) {
  return instructions.map((ix) =>
    concat(
      Uint8Array.of(index.get(ix.programId)),
      compactU16(ix.keys.length),
      Uint8Array.from(ix.keys.map((k) => index.get(k.pubkey))),
      compactU16(ix.data.length),
      ix.data,
    ),
  );
}

/**
 * A message. `version` is 'legacy' (default) or 0. For v0, `lookupTables` is [{ address, addresses: [base58] }]:
 * read-only and writable accounts that are neither signers nor invoked programs load from a table when it holds them.
 */
export function compileMessage({ payer, blockhash, instructions, version = 'legacy', lookupTables = [] }) {
  if (!instructions?.length) throw new Error('A transaction needs at least one instruction');
  let accounts = mergedAccounts(payer, instructions);
  const lookups = [];
  if (version === 0) {
    for (const table of lookupTables) {
      const drain = (writable) => {
        const indexes = [];
        const keys = [];
        accounts = accounts.filter((m) => {
          if (m.isSigner || m.invoked || m.isWritable !== writable) return true;
          const at = table.addresses.indexOf(m.pubkey);
          if (at < 0) return true;
          if (at > 255) throw new Error('Lookup table index past 255');
          indexes.push(at);
          keys.push(m.pubkey);
          return false;
        });
        return { indexes, keys };
      };
      const w = drain(true);
      const r = drain(false);
      if (w.indexes.length || r.indexes.length)
        lookups.push({ address: table.address, writable: w.indexes, readonly: r.indexes, writableKeys: w.keys, readonlyKeys: r.keys });
    }
  }
  const [head, ...rest] = accounts;
  const statics = [head, ...rest.sort((a, b) => rank(a) - rank(b))];
  const loaded = [...lookups.flatMap((l) => l.writableKeys), ...lookups.flatMap((l) => l.readonlyKeys)];
  const index = new Map([...statics.map((m, i) => [m.pubkey, i]), ...loaded.map((k, i) => [k, statics.length + i])]);
  if (index.size > 256) throw new Error('Too many accounts for one transaction');
  const signers = statics.filter((m) => m.isSigner);
  const header = Uint8Array.of(
    signers.length,
    signers.filter((m) => !m.isWritable).length,
    statics.filter((m) => !m.isSigner && !m.isWritable).length,
  );
  const body = concat(
    header,
    compactU16(statics.length),
    ...statics.map((m) => addressBytes(m.pubkey)),
    addressBytes(blockhash),
    compactU16(instructions.length),
    ...compileInstructions(instructions, index),
  );
  if (version !== 0) return body;
  const tables = lookups.map((l) =>
    concat(
      addressBytes(l.address),
      compactU16(l.writable.length),
      Uint8Array.from(l.writable),
      compactU16(l.readonly.length),
      Uint8Array.from(l.readonly),
    ),
  );
  return concat(Uint8Array.of(V0_PREFIX), body, compactU16(tables.length), ...tables);
}

/** The parts of a message: version, header, static keys, blockhash and compiled instructions. */
export function readMessage(message) {
  let at = 0;
  let version = 'legacy';
  if (message[0] & V0_PREFIX) {
    version = message[0] & 0x7f;
    if (version !== 0) throw new Error(`Unsupported transaction version ${version}`);
    at = 1;
  }
  const header = {
    numRequiredSignatures: message[at],
    numReadonlySigned: message[at + 1],
    numReadonlyUnsigned: message[at + 2],
  };
  at += 3;
  const keyCount = readCompactU16(message, at);
  at += keyCount.size;
  const keys = [];
  for (let i = 0; i < keyCount.value; i++) {
    keys.push(encodeBase58(message.subarray(at, at + 32)));
    at += 32;
  }
  const blockhash = encodeBase58(message.subarray(at, at + 32));
  at += 32;
  const ixCount = readCompactU16(message, at);
  at += ixCount.size;
  const instructions = [];
  for (let i = 0; i < ixCount.value; i++) {
    const programIndex = message[at++];
    const accounts = readCompactU16(message, at);
    at += accounts.size;
    const accountIndexes = Array.from(message.subarray(at, at + accounts.value));
    at += accounts.value;
    const data = readCompactU16(message, at);
    at += data.size;
    instructions.push({ programIndex, accountIndexes, data: message.slice(at, at + data.value) });
    at += data.value;
  }
  const lookups = [];
  if (version === 0) {
    const n = readCompactU16(message, at);
    at += n.size;
    for (let i = 0; i < n.value; i++) {
      const address = encodeBase58(message.subarray(at, at + 32));
      at += 32;
      const w = readCompactU16(message, at);
      at += w.size;
      const writable = Array.from(message.subarray(at, at + w.value));
      at += w.value;
      const r = readCompactU16(message, at);
      at += r.size;
      const readonly = Array.from(message.subarray(at, at + r.value));
      at += r.value;
      lookups.push({ address, writable, readonly });
    }
  }
  if (at !== message.length) throw new Error('Trailing bytes after the message');
  return { version, header, keys, blockhash, instructions, lookups };
}

/** The addresses that must sign a message, in signature-slot order. */
export function signersOf(message) {
  const { header, keys } = readMessage(message);
  return keys.slice(0, header.numRequiredSignatures);
}

/** The wire form: one signature slot per required signer (empty unless given), then the message. */
export function wireTransaction(message, signatures = []) {
  const count = readMessage(message).header.numRequiredSignatures;
  const slots = Array.from({ length: count }, (_, i) => signatures[i] ?? new Uint8Array(SIGNATURE_BYTES));
  if (slots.some((s) => s.length !== SIGNATURE_BYTES)) throw new Error('A signature is 64 bytes');
  return concat(compactU16(count), ...slots, message);
}

/** A wire transaction read back: its signatures, its message bytes and its signers. */
export function readTransaction(wire) {
  const count = readCompactU16(wire, 0);
  let at = count.size;
  const signatures = [];
  for (let i = 0; i < count.value; i++) {
    if (at + SIGNATURE_BYTES > wire.length) throw new Error('Truncated signatures');
    signatures.push(wire.slice(at, at + SIGNATURE_BYTES));
    at += SIGNATURE_BYTES;
  }
  const message = wire.slice(at);
  const signers = signersOf(message);
  if (signers.length !== signatures.length) throw new Error('Signature count does not match the message');
  return { signatures, message, signers };
}

/** A copy of the wire transaction with `signer`'s slot holding `signature`. */
export function withSignature(wire, signer, signature) {
  const { signatures, message, signers } = readTransaction(wire);
  const at = signers.indexOf(signer);
  if (at < 0) throw new Error(`${signer} does not sign this transaction`);
  signatures[at] = signature;
  return wireTransaction(message, signatures);
}

/** The transaction's id: its first signature, in base58. */
export const transactionId = (wire) => encodeBase58(readTransaction(wire).signatures[0]);

/** Whether a signature slot is still empty. */
export const isEmptySignature = (signature) => signature.every((b) => b === 0);

/** Whether two wire transactions carry the same message. */
export const sameMessage = (a, b) => equalBytes(readTransaction(a).message, readTransaction(b).message);

/** The size this message's transaction takes on the wire. */
export const transactionSize = (message) => wireTransaction(message).length;

/** Whether these instructions fit one transaction from this payer. */
export function fits(input) {
  try {
    return transactionSize(compileMessage(input)) <= MAX_TRANSACTION_BYTES;
  } catch {
    return false;
  }
}
