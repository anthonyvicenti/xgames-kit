// Loot program 0.3 as the economy tools need it: each instruction's name, arguments and accounts, and the types
// they use, so a setup plan names the program's own instructions and arguments and sizes them byte for byte.
// The data is loot-0.3.json, trimmed from the program's Anchor IDL (no docs, no events). To refresh it after a new
// program release: node builder/web3/economy/idl.mjs <path to target/idl/loot.json> > builder/web3/economy/loot-0.3.json
// Pure, apart from reading that file once.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The parts of an Anchor IDL the economy tools read. Accounts are flattened ("checkout.player"). */
export function trimIdl(idl) {
  const flat = (accounts, prefix = '') =>
    accounts.flatMap((a) =>
      a.accounts ? flat(a.accounts, `${prefix}${a.name}.`) : [{ name: prefix + a.name, ...(a.signer ? { signer: true } : {}), ...(a.writable ? { writable: true } : {}), ...(a.optional ? { optional: true } : {}), ...(a.address ? { address: a.address } : {}) }],
    );
  const strip = (type) => JSON.parse(JSON.stringify(type, (key, value) => (key === 'docs' ? undefined : value)));
  return {
    address: idl.address,
    version: idl.metadata.version,
    instructions: idl.instructions.map((ix) => ({ name: ix.name, discriminator: ix.discriminator, args: strip(ix.args), accounts: flat(ix.accounts) })),
    accounts: idl.accounts.map((a) => ({ name: a.name, discriminator: a.discriminator })),
    types: idl.types.filter((t) => !idl.events?.some((e) => e.name === t.name)).map((t) => ({ name: t.name, type: strip(t.type) })),
  };
}

export const IDL = JSON.parse(readFileSync(new URL('./loot-0.3.json', import.meta.url), 'utf8'));
export const PROGRAM_ID = IDL.address;

const TYPES = new Map(IDL.types.map((t) => [t.name, t.type]));
const PRIMITIVE = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };

export const instruction = (name) => IDL.instructions.find((ix) => ix.name === name);

/**
 * The Borsh size of `value` as `type` (an IDL type). Enums are written { Variant: fields } or { Variant: {} }, a
 * one-field tuple variant { Pool: 3 }; options are null or the value; strings count their UTF-8 bytes.
 */
export function borshSize(type, value) {
  if (typeof type === 'string') {
    if (type === 'string') return 4 + new TextEncoder().encode(value ?? '').length;
    if (type === 'bytes') return 4 + (value?.length ?? 0);
    if (!(type in PRIMITIVE)) throw new Error(`Unknown IDL type ${type}`);
    return PRIMITIVE[type];
  }
  if (type.option) return value === null || value === undefined ? 1 : 1 + borshSize(type.option, value);
  if (type.vec) return 4 + (value ?? []).reduce((n, v) => n + borshSize(type.vec, v), 0);
  if (type.array) return type.array[1] * borshSize(type.array[0], value?.[0]);
  if (type.defined) return borshSize(TYPES.get(type.defined.name) ?? fail(`Unknown IDL type ${type.defined.name}`), value);
  if (type.kind === 'struct') return type.fields.reduce((n, f) => n + borshSize(f.type, value?.[f.name]), 0);
  if (type.kind === 'enum') {
    const name = typeof value === 'string' ? value : Object.keys(value ?? {})[0];
    const variant = type.variants.find((v) => v.name === name) ?? fail(`No variant ${name}`);
    const fields = variant.fields ?? [];
    if (!fields.length) return 1;
    const inner = typeof value === 'string' ? {} : value[name];
    if (typeof fields[0] === 'string' || fields[0].name === undefined) {
      const list = fields.length === 1 ? [inner] : inner;
      return 1 + fields.reduce((n, f, i) => n + borshSize(f, list[i]), 0);
    }
    return 1 + fields.reduce((n, f) => n + borshSize(f.type, inner[f.name]), 0);
  }
  throw new Error(`Unsupported IDL type ${JSON.stringify(type)}`);
}

function fail(message) {
  throw new Error(message);
}

/** The bytes of an instruction's data: its 8-byte discriminator and its arguments. */
export function dataSize(name, args) {
  const ix = instruction(name) ?? fail(`Loot 0.3 has no instruction ${name}`);
  return 8 + ix.args.reduce((n, a) => n + borshSize(a.type, args[a.name]), 0);
}

/** The bytes of a program account: its 1-byte tag and its fields (accounts are sized to what they hold). */
export function accountSize(name, value) {
  return 1 + borshSize({ defined: { name } }, value);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) {
  process.stdout.write(`${JSON.stringify(trimIdl(JSON.parse(readFileSync(process.argv[2], 'utf8'))))}\n`);
}
