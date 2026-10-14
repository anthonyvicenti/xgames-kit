// Shared by tests/economy-*.test.mjs: the fixtures, and an independent reading of the full loot 0.3 IDL
// (tests/economy/loot-0.3.idl.json, copied from games.fun launchpad/loot/target/idl/loot.json at commit 5cf40df40,
// loot 0.3.2, the cleanup, as upgraded on devnet at GVzbAquL…, sha256 a18209d0…) to hold the economy
// tools to it.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const FIXTURES = path.join(ROOT, 'builder/web3/economy/fixtures');
export const FULL_IDL = JSON.parse(readFileSync(path.join(here, 'loot-0.3.idl.json'), 'utf8'));
/** A fixed "publish" time, so plans and times are the same on every run. */
export const NOW = 1_800_000_000;

export const fixtureNames = () => readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
export const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

const types = new Map(FULL_IDL.types.map((t) => [t.name, t.type]));
const PRIMITIVE = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };

/**
 * Walks `value` as IDL `type`, the way a Borsh encoder would, and returns its size. Throws when a struct field is
 * missing or extra, an enum variant does not exist, or a value has the wrong shape: so a plan whose args pass this
 * names only what the program has.
 */
export function idlSize(type, value, where = 'args') {
  const fail = (why) => {
    throw new Error(`${where}: ${why}`);
  };
  if (typeof type === 'string') {
    if (type === 'string') return typeof value === 'string' ? 4 + Buffer.byteLength(value) : fail('not a string');
    if (type === 'pubkey') return typeof value === 'string' && value.length ? 32 : fail('not an address');
    if (type in PRIMITIVE) {
      if (type === 'bool') return typeof value === 'boolean' ? 1 : fail('not a boolean');
      if (type === 'u64' || type === 'i64' || type === 'u128') return /^-?\d+$/.test(String(value)) ? PRIMITIVE[type] : fail(`not a number: ${value}`);
      return Number.isInteger(value) ? PRIMITIVE[type] : fail(`not a whole number: ${value}`);
    }
    fail(`unknown type ${type}`);
  }
  if (type.option) return value === null ? 1 : 1 + idlSize(type.option, value, where);
  if (type.vec) return Array.isArray(value) ? 4 + value.reduce((n, v, i) => n + idlSize(type.vec, v, `${where}[${i}]`), 0) : fail('not a list');
  if (type.array) return type.array[1] * (type.array[0] === 'u8' ? 1 : fail('array of non-bytes'));
  if (type.defined) return idlSize(types.get(type.defined.name) ?? fail(`no type ${type.defined.name}`), value, `${where}<${type.defined.name}>`);
  if (type.kind === 'struct') {
    const names = type.fields.map((f) => f.name);
    const extra = Object.keys(value ?? {}).filter((k) => !names.includes(k));
    if (extra.length) fail(`fields the program does not have: ${extra.join(', ')}`);
    return type.fields.reduce((n, f) => n + (f.name in (value ?? {}) ? idlSize(f.type, value[f.name], `${where}.${f.name}`) : fail(`missing ${f.name}`)), 0);
  }
  if (type.kind === 'enum') {
    const [name, ...more] = Object.keys(value ?? {});
    if (more.length) fail('an enum value names one variant');
    const variant = type.variants.find((v) => v.name === name) ?? fail(`no variant ${name}`);
    const fields = variant.fields ?? [];
    const inner = value[name];
    if (!fields.length) return 1;
    if (fields[0].name === undefined) return 1 + idlSize(fields[0], fields.length === 1 ? inner : inner[0], `${where}.${name}`);
    return 1 + idlSize({ kind: 'struct', fields }, inner, `${where}.${name}`);
  }
  fail(`unsupported ${JSON.stringify(type)}`);
}

export const idlInstruction = (name) => FULL_IDL.instructions.find((ix) => ix.name === name);

/** An instruction's accounts, flattened as "checkout.player". */
export function idlAccounts(name) {
  const flat = (accounts, prefix = '') => accounts.flatMap((a) => (a.accounts ? flat(a.accounts, `${prefix}${a.name}.`) : [{ ...a, name: prefix + a.name }]));
  return flat(idlInstruction(name).accounts);
}
