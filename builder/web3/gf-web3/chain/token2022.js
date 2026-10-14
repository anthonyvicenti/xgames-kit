// What a Token-2022 transfer needs beyond the transfer itself, read from the mint. The loot program moves every token
// with TransferChecked and hands each Token-2022 transfer the instruction's remaining accounts (games.fun
// launchpad/loot PROGRAM-0.3.md "Token-2022", programs/loot/src/tokens.rs at commit 905eb7e63), so the caller passes:
//   - the Memo program, which the program calls first when the receiving account requires a memo. It is always passed
//     for a Token-2022 mint: any receiver can turn memos on between the moment a transaction is built and the moment
//     it lands, and one account more costs nothing;
//   - for a mint with a transfer hook: the hook program, its list of extra accounts ("extra-account-metas", mint) and
//     every account that list names, resolved here as spl-transfer-hook-interface does. Token-2022 takes the ones its
//     hook names by address and ignores the rest. The hook never gets a signature: every account is passed unsigned.
// Classic SPL mints need none of it.
import { addressBytes, encodeBase58 } from './base58.js';
import { concat, readUintLE, uintLE, utf8 } from './bytes.js';
import { pdaOf, TOKEN_2022_PROGRAM } from './pda.js';
import { meta } from './programs.js';

export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** The hook interface's Execute instruction: its discriminator, then the amount (u64). */
export const EXECUTE_DISCRIMINATOR = Uint8Array.of(105, 37, 101, 197, 75, 251, 102, 26);

const ACCOUNT_LEN = 165;
const ACCOUNT_TYPE_MINT = 1;
const EXTENSION = { MemoTransfer: 8, TransferHook: 14 };
const META_BYTES = 35;
const NO_ADDRESS = '11111111111111111111111111111111';

/** The value of extension `type` in a Token-2022 mint or account, or null. */
export function extension(data, type) {
  let at = ACCOUNT_LEN + 1;
  while (at + 4 <= data.length) {
    const kind = Number(readUintLE(data, at, 2));
    const length = Number(readUintLE(data, at + 2, 2));
    if (kind === type) return data.subarray(at + 4, at + 4 + length);
    if (kind === 0) return null;
    at += 4 + length;
  }
  return null;
}

/** The transfer hook program a Token-2022 mint names, or null. */
export function hookProgramOf(mintData) {
  if (mintData.length <= ACCOUNT_LEN || mintData[ACCOUNT_LEN] !== ACCOUNT_TYPE_MINT) return null;
  const value = extension(mintData, EXTENSION.TransferHook);
  if (!value || value.length < 64) return null;
  const program = encodeBase58(value.subarray(32, 64));
  return program === NO_ADDRESS ? null : program;
}

/** Whether a token account requires a memo on every transfer into it. */
export function requiresMemo(accountData) {
  const value = accountData.length > ACCOUNT_LEN ? extension(accountData, EXTENSION.MemoTransfer) : null;
  return Boolean(value?.length && value[0] !== 0);
}

/** The hook's list of extra accounts for this mint. */
export const validationAddress = (mint, hookProgram) => pdaOf([utf8('extra-account-metas'), addressBytes(mint)], hookProgram);

/** The ExtraAccountMeta entries of an "extra-account-metas" account: [{ discriminator, config, isSigner, isWritable }]. */
export function readExtraMetas(data) {
  let at = 0;
  while (at + 12 <= data.length) {
    const length = Number(readUintLE(data, at + 8, 4));
    const isExecute = EXECUTE_DISCRIMINATOR.every((b, i) => data[at + i] === b);
    if (isExecute) {
      const count = Number(readUintLE(data, at + 12, 4));
      return Array.from({ length: count }, (_, i) => {
        const o = at + 16 + i * META_BYTES;
        if (o + META_BYTES > data.length) throw new RangeError('extra account list runs past the data');
        return { discriminator: data[o], config: data.subarray(o + 1, o + 33), isSigner: data[o + 33] !== 0, isWritable: data[o + 34] !== 0 };
      });
    }
    at += 12 + length;
  }
  throw new Error('The hook’s account list has no entry for transfers.');
}

/** The seeds a PDA entry packs into its 32 bytes: [{ literal } | { ixData: [index, length] } | { key: index } | { data: [account, at, length] }]. */
function unpackSeeds(config) {
  const seeds = [];
  for (let at = 0; at < config.length && config[at] !== 0; ) {
    const kind = config[at];
    if (kind === 1) {
      seeds.push({ literal: config.subarray(at + 2, at + 2 + config[at + 1]) });
      at += 2 + config[at + 1];
    } else if (kind === 2) {
      seeds.push({ ixData: [config[at + 1], config[at + 2]] });
      at += 3;
    } else if (kind === 3) {
      seeds.push({ key: config[at + 1] });
      at += 2;
    } else if (kind === 4) {
      seeds.push({ data: [config[at + 1], config[at + 2], config[at + 3]] });
      at += 4;
    } else throw new Error(`The hook asks for an account by a seed this kit does not know (${kind}).`);
  }
  return seeds;
}

/**
 * The extra accounts the hook names for one transfer: { source, destination, authority, amount } (amount a bigint).
 * `read(address)` returns an account's data (or null), for seeds taken from account data.
 */
async function resolveFor(mint, hookProgram, validation, metas, transfer, read) {
  const keys = [transfer.source, mint, transfer.destination, transfer.authority, validation];
  const ixData = concat(EXECUTE_DISCRIMINATOR, uintLE(transfer.amount ?? 0n, 8));
  const out = [];
  for (const m of metas) {
    let address;
    if (m.discriminator === 0) address = encodeBase58(m.config);
    else if (m.discriminator === 1 || m.discriminator >= 128) {
      const program = m.discriminator === 1 ? hookProgram : keys[m.discriminator - 128];
      const seeds = [];
      for (const s of unpackSeeds(m.config)) {
        if (s.literal) seeds.push(s.literal);
        else if (s.ixData) seeds.push(ixData.subarray(s.ixData[0], s.ixData[0] + s.ixData[1]));
        else if (s.key !== undefined) seeds.push(addressBytes(keys[s.key]));
        else {
          const data = await read(keys[s.data[0]]);
          if (!data) throw new Error(`The hook needs data from ${keys[s.data[0]]}, which does not exist yet.`);
          seeds.push(data.subarray(s.data[1], s.data[1] + s.data[2]));
        }
      }
      if (!program) throw new Error('The hook names a program by an account it does not have.');
      address = pdaOf(seeds, program);
    } else throw new Error(`The hook asks for an account in a way this kit does not resolve (${m.discriminator}).`);
    if (!address) throw new Error('The hook asks for an account this transfer does not have.');
    keys.push(address);
    out.push(meta(address, false, m.isWritable));
  }
  return out;
}

/** Whether the hook's list depends on which transfer it is (an account, the amount or account data). */
const perTransfer = (metas) =>
  metas.some((m) => m.discriminator >= 128 || (m.discriminator === 1 && unpackSeeds(m.config).some((s) => !s.literal && !(s.key === 1 || s.key === 4))));

/**
 * The accounts to append after an instruction's own remaining accounts so every transfer of `mint` it makes can run:
 * [] for a classic mint; the Memo program, and for a hooked mint the hook's accounts, for a Token-2022 one.
 * `transfers`: the transfers the instruction makes ({ source, destination, authority, amount }), needed only when the
 * hook's list depends on them; the accounts of all of them are passed. `rpc` reads the mint and the hook's list.
 */
export async function transferExtras(rpc, mint, transfers = []) {
  const [mintAccount] = await rpc.accounts([mint]);
  if (!mintAccount) throw new Error(`There is no token ${mint} on this network.`);
  if (mintAccount.owner !== TOKEN_2022_PROGRAM) return [];
  const extras = [meta(MEMO_PROGRAM, false, false)];
  const hookProgram = hookProgramOf(mintAccount.data);
  if (!hookProgram) return extras;
  const validation = validationAddress(mint, hookProgram);
  const [list] = await rpc.accounts([validation]);
  extras.push(meta(hookProgram, false, false), meta(validation, false, false));
  if (!list) return extras;
  const metas = readExtraMetas(list.data);
  const read = async (address) => (await rpc.accounts([address]))[0]?.data ?? null;
  const cases = perTransfer(metas) ? transfers : [{ source: NO_ADDRESS, destination: NO_ADDRESS, authority: NO_ADDRESS, amount: 0n }];
  if (!cases.length) throw new Error('This token’s transfer hook needs to know each transfer; pass them.');
  for (const transfer of cases) for (const m of await resolveFor(mint, hookProgram, validation, metas, transfer, read)) extras.push(m);
  // One entry per address; writable if any transfer needs it writable.
  const merged = new Map();
  for (const m of extras) merged.set(m.pubkey, merged.has(m.pubkey) ? { ...m, isWritable: m.isWritable || merged.get(m.pubkey).isWritable } : m);
  return [...merged.values()];
}
