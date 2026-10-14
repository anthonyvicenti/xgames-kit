// What the full simulation needs that the kit does not carry, fetched once and kept in the user's cache folder:
//   - LiteSVM (npm `litesvm`, MIT, with its prebuilt native module, about 46 MB with its dependencies), installed into
//     the cache on first use, never into the kit's own node_modules;
//   - the programs it runs, dumped read-only from devnet: games.fun's loot program 0.3 (checked against the deployed
//     file's sha256, or a local build of program/loot), Metaplex Core and MagicBlock's VRF (checked against the bytes
//     pinned below, and run as they are on devnet when devnet has moved on, with a note);
//   - a few devnet accounts: the loot platform record, the VRF oracle queue, and the accounts a spec names (an existing
//     token's mint, a partner's token account, a collectible a share pays the holder of).
// Node only. Nothing here signs or sends a transaction.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { encodeBase58 } from '../../gf-web3/chain/base58.js';
import { rpcClient } from '../../gf-web3/rpc.js';

export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const LITESVM_VERSION = '1.5.0';
/** Program data accounts start with 45 bytes of the upgradeable loader's own (tag, slot, upgrade authority). */
const PROGRAM_DATA_HEADER = 45;

/**
 * The loot program as deployed (games.fun launchpad/loot/devnet-upgrade-0.3.2-result.json, 2026-10-12: 0.3.2, the
 * cleanup, upgraded in place; before it 0.3.1 with the 95/5 registry rules, 905,320 bytes, aaa04f48…a354).
 */
export const LOOT_DEPLOY = Object.freeze({
  program: 'GVzbAquLbqGxWzzjEAYvGyj1a3SHEcBr3gM9fseTg73o',
  programData: '2RGLXrYCQedMHdArd8zWW9nNXhvjVuzP5nUTFwafrpvB',
  soBytes: 852_896,
  soSha256: '935f850022013f0cd9766c5ab8f942dd0d2678f3a0211976e043b448542accdc',
  platform: '3ASM4DQfuvjL2J6ZXLZ9dBrF8c3kbxibutgJjy2mFkCt',
});

/**
 * The other programs, as dumped from devnet on 2026-10-12 (program data after its 45-byte header, padding included).
 * The VRF one is byte for byte games.fun launchpad/loot's test fixture `vrf.so`.
 */
export const UPSTREAM = Object.freeze({
  core: { name: 'Metaplex Core', program: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', sha256: '7e033fd24ce189d9e7dc2600152c6c88ce80d662deeeb7ecc64f0c8437867cf7' },
  vrf: { name: 'MagicBlock VRF', program: 'Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz', sha256: '5ce6715cc338c135c996f04b13d1f1652d95e51ee52bd7c2eb0a31d09282950e' },
  /** Token Metadata: the name and ticker a token the game mints gets at setup. */
  metadata: { name: 'Metaplex Token Metadata', program: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', sha256: 'bb0842f6d5740eabe8f9fb3b723b9ecd89cadf9f48ef9ad6a9dc6cfa8a9658e4' },
});
export const VRF_QUEUE = 'Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh';
/** Devnet's rent (5,080 lamports a byte since SIMD-0194, threshold 1): LiteSVM's default is the older 6,960. */
export const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The user's cache folder for the kit: GAMESFUN_CACHE, else the system's cache folder + gamesfun. */
export function cacheDir(env = process.env) {
  if (env.GAMESFUN_CACHE) return path.resolve(env.GAMESFUN_CACHE);
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'gamesfun', 'cache');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'gamesfun');
  return path.join(env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'gamesfun');
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeAtomic(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

// ---------------------------------------------------------------- LiteSVM

/**
 * LiteSVM's class, from the kit's own node_modules when someone installed it there, else from the cache (installed
 * there with npm on first use when `install` is true). Throws a plain sentence when it cannot be had.
 */
export async function loadLiteSVM({ dir = cacheDir(), install = true, log = () => {} } = {}) {
  if (process.platform === 'win32') throw new Error('LiteSVM has no Windows build (its npm package ships Linux and macOS binaries only).');
  const tryLoad = (from) => {
    try {
      return createRequire(from)('litesvm');
    } catch {
      return null;
    }
  };
  const own = tryLoad(import.meta.url);
  if (own?.LiteSVM) return { LiteSVM: own.LiteSVM, Rent: own.Rent, from: 'the kit’s node_modules' };
  const home = path.join(dir, `litesvm-${LITESVM_VERSION}`);
  const anchor = path.join(home, 'package.json');
  let cached = tryLoad(anchor);
  if (!cached?.LiteSVM && install) {
    log(`Installing LiteSVM ${LITESVM_VERSION} into ${home} (once, about 46 MB)…`);
    await mkdir(home, { recursive: true });
    await writeFile(anchor, JSON.stringify({ name: 'gamesfun-sim-deps', private: true }, null, 2));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await new Promise((resolve, reject) =>
      execFile(npm, ['install', '--prefix', home, `litesvm@${LITESVM_VERSION}`, '--no-audit', '--no-fund', '--save-exact'], { timeout: 300_000 }, (error, stdout, stderr) =>
        error ? reject(new Error(`npm could not install litesvm@${LITESVM_VERSION}: ${String(stderr || error.message).trim().split('\n').at(-1)}`)) : resolve(stdout),
      ),
    );
    cached = tryLoad(anchor);
  }
  if (!cached?.LiteSVM) throw new Error(`LiteSVM ${LITESVM_VERSION} is not installed (looked in ${home}).`);
  return { LiteSVM: cached.LiteSVM, Rent: cached.Rent, from: home };
}

// ---------------------------------------------------------------- devnet bytes

/** A devnet account, from the cache or read once from devnet: { owner, lamports, data, executable, fetchedAt } or null. */
async function cachedAccount(address, { dir, rpc, offline }) {
  const file = path.join(dir, 'accounts', `${address}.json`);
  const kept = await readJson(file);
  if (kept) return kept.missing ? null : { ...kept, lamports: BigInt(kept.lamports), data: Buffer.from(kept.data, 'base64') };
  if (offline) throw new Error(`The devnet account ${address} is not in the cache and the run is offline.`);
  const a = await rpc.account(address);
  const fetchedAt = new Date().toISOString();
  await writeAtomic(file, JSON.stringify(a ? { owner: a.owner, lamports: String(a.lamports), executable: a.executable, data: Buffer.from(a.data).toString('base64'), fetchedAt } : { missing: true, fetchedAt }));
  return a ? { ...a, lamports: BigInt(a.lamports), data: Buffer.from(a.data), fetchedAt } : null;
}

/** Devnet accounts by address (null for one devnet does not have). */
export async function devnetAccounts(addresses, { dir = cacheDir(), rpcUrl = DEVNET_RPC, offline = false } = {}) {
  const rpc = rpcClient(rpcUrl);
  const out = {};
  for (const address of [...new Set(addresses)]) out[address] = await cachedAccount(address, { dir, rpc, offline });
  return out;
}

/** A program's executable bytes as deployed on devnet (its program data after the loader's header), cached. */
async function programBytes(program, { dir, rpc, offline }) {
  const file = path.join(dir, 'programs', `${program}.so`);
  const meta = path.join(dir, 'programs', `${program}.json`);
  const kept = await readJson(meta);
  if (kept) {
    const bytes = await readFile(file).catch(() => null);
    if (bytes && sha256(bytes) === kept.sha256) return { bytes, ...kept, cached: true };
  }
  if (offline) throw new Error(`The program ${program} is not in the cache and the run is offline.`);
  const account = await rpc.account(program);
  if (!account) throw new Error(`Devnet has no program ${program}.`);
  const programData = encodeBase58(account.data.subarray(4, 36));
  const data = await rpc.account(programData);
  if (!data) throw new Error(`Devnet has no program data for ${program}.`);
  const bytes = Buffer.from(data.data.subarray(PROGRAM_DATA_HEADER));
  const record = { program, programData, deploySlot: String(Buffer.from(data.data.subarray(4, 12)).readBigUInt64LE()), size: bytes.length, sha256: sha256(bytes), fetchedAt: new Date().toISOString() };
  await writeAtomic(file, bytes);
  await writeAtomic(meta, JSON.stringify(record, null, 2));
  return { bytes, ...record, cached: false };
}

/**
 * The programs and the devnet accounts the simulation loads: { loot, core, vrf, metadata, queue, platform, rent, notes }.
 * `program`: a local loot.so (a build of program/loot) to run instead of the deployed one. Throws a plain sentence
 * when something cannot be had (offline with an empty cache, a deployed loot program that is not the recorded one).
 */
export async function simBinaries({ dir = cacheDir(), rpcUrl = DEVNET_RPC, offline = false, program } = {}) {
  const rpc = rpcClient(rpcUrl);
  const notes = [];
  let loot;
  if (program) {
    const bytes = await readFile(program);
    const hash = sha256(bytes);
    const deployed = hash === LOOT_DEPLOY.soSha256;
    loot = { bytes, sha256: hash, source: program, deployed };
    notes.push(deployed ? `The loot program is a local build (${program}), byte for byte the one deployed on devnet.` : `The loot program is a local build (${program}) that is NOT the one deployed on devnet (sha256 ${hash.slice(0, 12)}…, devnet ${LOOT_DEPLOY.soSha256.slice(0, 12)}…): these results are for that build.`);
  } else {
    const got = await programBytes(LOOT_DEPLOY.program, { dir, rpc, offline });
    // The program data account can be larger than the file deployed into it; the file is its first soBytes bytes.
    const bytes = got.bytes.subarray(0, LOOT_DEPLOY.soBytes);
    const hash = sha256(bytes);
    if (hash !== LOOT_DEPLOY.soSha256) throw new Error(`The loot program on devnet is not the deployed 0.3 the kit knows (sha256 ${hash.slice(0, 12)}…, expected ${LOOT_DEPLOY.soSha256.slice(0, 12)}…). Update the kit, or pass --program with a build of program/loot.`);
    loot = { bytes, sha256: hash, source: `devnet ${LOOT_DEPLOY.program}`, deployed: true };
    notes.push(`The loot program is the one deployed on devnet (${LOOT_DEPLOY.program}, sha256 ${hash.slice(0, 12)}…, the deploy record's).`);
  }
  const upstream = {};
  for (const [key, u] of Object.entries(UPSTREAM)) {
    const got = await programBytes(u.program, { dir, rpc, offline });
    upstream[key] = got;
    if (got.sha256 !== u.sha256) notes.push(`${u.name} on devnet has changed since the kit pinned it (sha256 ${got.sha256.slice(0, 12)}…, pinned ${u.sha256.slice(0, 12)}…); this run used devnet's current one.`);
  }
  const accounts = await devnetAccounts([VRF_QUEUE, LOOT_DEPLOY.platform, RENT_SYSVAR], { dir, rpcUrl, offline });
  if (!accounts[VRF_QUEUE] || !accounts[LOOT_DEPLOY.platform] || !accounts[RENT_SYSVAR]) throw new Error('Devnet has no VRF queue, loot platform record or rent sysvar at the known addresses.');
  const r = Buffer.from(accounts[RENT_SYSVAR].data);
  const rent = { lamportsPerByteYear: r.readBigUInt64LE(0), exemptionThreshold: r.readDoubleLE(8), burnPercent: r[16] };
  const fetched = [accounts[VRF_QUEUE], accounts[LOOT_DEPLOY.platform]].map((a) => a.fetchedAt).filter(Boolean).sort()[0];
  if (fetched) notes.push(`The loot platform record (its fees) and the oracle queue are devnet's as read on ${fetched.slice(0, 10)}.`);
  return { loot, core: upstream.core, vrf: upstream.vrf, metadata: upstream.metadata, queue: accounts[VRF_QUEUE], platform: accounts[LOOT_DEPLOY.platform], rent, notes };
}
