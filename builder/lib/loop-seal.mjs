// The build loop's seal: what keeps the loop's state honest when no MCP server holds it in memory.
//
// The loop's state file is <game>/.gf-loop/state.json, inside the folder the session works in. While one MCP server
// lives, the library's heldStore keeps the truth in that process's memory and writes a changed file again. The terminal
// path (`gamesfun tool <name>`) starts a new process for every call, so it has no memory, and a server that restarted
// has none either: the file would be all there is. This module gives both paths the same protection:
//
//   key     32 random bytes in the person's config folder (configDir()/loop/key, 0600), made on first use; never in a
//           game folder and never in this checkout
//   seal    after every save, configDir()/loop/seals/<id>.json holds the state's exact text and an HMAC over it (and the
//           game's folder); before a load with nothing in memory, a state file that is not the sealed text is written
//           again from the seal, and the loop is told (`state-changed`, the same refusal heldStore gives)
//   token   the play-test's one-time report token (issueToken, tokenProblem, useToken, reportSigned), kept in the same
//           folder (never in the game's): the report a play-tester writes through gamesfun_playtest_report with it can
//           be told apart from a file the session wrote itself. The second reader's reading has its own channel
//           (`channel: 'reader'`, gamesfun_reader_report), the same way
//
// What this cannot stop, plainly: anything that reads the key and computes a new HMAC, or deletes the seal records in
// the person's config folder (a state with no record is taken as it is and sealed: trust on first use, which is also
// what a game started by an older kit or copied from another machine needs). It stops the edit seen on 2026-10-11 (a
// session rewriting state.json to skip a step) on every path, and a forged play-test report on every path.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { heldStore, STATE_DIR } from '../loop/index.mjs';
import { configDir } from './secret-store.mjs';

export const SEAL_SCHEMA = 'gf-loop-seal/1';
export const TOKEN_SCHEMA = 'gf-playtest-token/1';
/** The folder this module keeps its things in (the person's config folder; GAMESFUN_CONFIG_DIR moves it). */
export const sealHome = (env = process.env) => path.join(configDir({ env }), 'loop');
const idOf = game => createHash('sha256').update(path.resolve(game)).digest('hex').slice(0, 32);
const sha = text => createHash('sha256').update(text).digest('hex');
const readText = async file => { try { return await readFile(file, 'utf8'); } catch { return null; } };

async function atomicWrite(file, text, mode) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text, mode ? { mode } : undefined);
  try { await rename(tmp, file); } catch { await writeFile(file, text, mode ? { mode } : undefined); await rm(tmp, { force: true }); }   // Windows: EPERM/EBUSY
  if (mode) await chmod(file, mode).catch(() => {});
}

/** The key, made once (0600). Two processes making it at once agree: the second reads the first's. */
export async function sealKey(env = process.env) {
  const file = path.join(sealHome(env), 'key');
  const have = (await readText(file))?.trim();
  if (have && /^[0-9a-f]{64}$/.test(have)) return Buffer.from(have, 'hex');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { await writeFile(file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  await chmod(file, 0o600).catch(() => {});
  return Buffer.from((await readFile(file, 'utf8')).trim(), 'hex');
}
const macOf = (key, ...parts) => createHmac('sha256', key).update(parts.map(String).join('\0')).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------------------------------------------------------------- the state's seal
const sealFile = (game, env) => path.join(sealHome(env), 'seals', `${idOf(game)}.json`);
export const SEAL_BROKEN_WORDS = 'The build loop\'s seal record for this game (in the person\'s config folder) was changed by something other than the loop, so the state file cannot be checked. Tell the person plainly. To start the build again they can delete the game\'s .gf-loop folder; nothing in it is theirs to edit.';

/** Once per process: forget the records of games whose folder is gone (a deleted game, a test's scratch folder). */
let pruned = false;
export async function pruneSeals(env = process.env) {
  const out = [];
  for (const sub of ['seals', ...TOKEN_CHANNELS]) {
    const dir = path.join(sealHome(env), sub);
    for (const f of await readdir(dir).catch(() => [])) {
      if (!f.endsWith('.json')) continue;
      let game = null;
      try { game = JSON.parse(await readFile(path.join(dir, f), 'utf8'))?.game ?? null; } catch { /* unreadable: kept, a load reports it */ }
      if (typeof game === 'string' && !existsSync(game)) { await rm(path.join(dir, f), { force: true }); out.push(`${sub}/${f}`); }
    }
  }
  return out;
}

/** Seal the state file as it is on disk now. */
export async function sealState(game, file, env = process.env) {
  const text = await readText(file);
  if (text == null) return null;
  if (!pruned) { pruned = true; await pruneSeals(env).catch(() => {}); }
  const key = await sealKey(env), g = path.resolve(game);
  const rec = { schema: SEAL_SCHEMA, game: g, at: new Date().toISOString(), text, mac: macOf(key, 'state', g, text) };
  await atomicWrite(sealFile(game, env), JSON.stringify(rec) + '\n', 0o600);
  return rec;
}

/** The sealed record when it is whole. → { rec } | { broken: true } | { none: true } */
async function sealOf(game, env) {
  const raw = await readText(sealFile(game, env));
  if (raw == null) return { none: true };
  let rec = null;
  try { rec = JSON.parse(raw); } catch { return { broken: true }; }
  const key = await sealKey(env);
  if (rec?.schema !== SEAL_SCHEMA || typeof rec.text !== 'string' || !same(rec.mac, macOf(key, 'state', path.resolve(game), rec.text))) return { broken: true };
  return { rec };
}

/**
 * Check the state file against its seal, and put the sealed text back when it differs.
 * → { changed: boolean, sealed: 'ok' | 'new' | 'restored' | 'none' } ; throws SEAL_BROKEN_WORDS on a broken record.
 * A state with no record is sealed as it is (trust on first use). A game whose whole .gf-loop folder is gone starts
 * again: its record is dropped (starting over skips nothing).
 */
export async function checkState(game, file, env = process.env) {
  // the whole loop folder gone: the build starts again, whatever the record says
  if (!existsSync(path.join(path.resolve(game), STATE_DIR))) { await rm(sealFile(game, env), { force: true }); return { changed: false, sealed: 'none' }; }
  const disk = await readText(file), s = await sealOf(game, env);
  if (s.none) { if (disk != null) await sealState(game, file, env); return { changed: false, sealed: disk == null ? 'none' : 'new' }; }
  if (s.broken) { const e = new Error(SEAL_BROKEN_WORDS); e.code = 'seal-broken'; throw e; }
  if (disk === s.rec.text) return { changed: false, sealed: 'ok' };
  await atomicWrite(file, s.rec.text);
  return { changed: true, sealed: 'restored' };
}

/** The state as the seal says it is, without writing anything (for readers that are not the loop). → object | null */
export async function trustedState(game, file, env = process.env) {
  const s = await sealOf(game, env).catch(() => ({ broken: true }));
  const text = s.rec ? s.rec.text : s.none ? await readText(file) : null;
  try { return text == null ? null : JSON.parse(text); } catch { return null; }
}

/**
 * The library's heldStore with the seal around it: one per game, kept for as long as the process lives. Before this
 * process has saved the state (a terminal call, a server that restarted) every load checks the seal; after that the
 * memory is the truth, as heldStore has it. Every save is sealed. takeChanged() reports either kind of change once.
 */
export function sealedStore(file, { game = path.dirname(path.dirname(file)), env = process.env } = {}) {
  const held = heldStore(file);
  let holding = false, changed = false;
  return {
    file,
    async load() {
      if (!holding && (await checkState(game, file, env)).changed) changed = true;
      return held.load();
    },
    async save(state) { await held.save(state); holding = true; await sealState(game, file, env); },
    takeChanged() { const a = held.takeChanged(), b = changed; changed = false; return a || b; },
  };
}

// ---------------------------------------------------------------- the play-test's report token
/** The one-time report tokens' channels: the play-tester's report and the second reader's reading. */
export const TOKEN_CHANNELS = ['playtest', 'reader'];
const channelOf = c => (TOKEN_CHANNELS.includes(c) ? c : 'playtest');
const tokenFile = (game, env, channel = 'playtest') => path.join(sealHome(env), channelOf(channel), `${idOf(game)}.json`);
const tokenMac = (key, r) => macOf(key, 'token', r.game, r.round, r.checkpoint, r.hash, r.token ?? '', r.used ? 1 : 0, r.report ?? '');

async function tokenRecord(game, env, channel) {
  const raw = await readText(tokenFile(game, env, channel));
  if (raw == null) return null;
  try {
    const r = JSON.parse(raw), key = await sealKey(env);
    return r?.schema === TOKEN_SCHEMA && same(r.mac, tokenMac(key, r)) ? r : { broken: true };
  } catch { return { broken: true }; }
}
async function writeToken(game, r, env, channel) {
  const key = await sealKey(env);
  await atomicWrite(tokenFile(game, env, channel), JSON.stringify({ ...r, mac: tokenMac(key, r) }) + '\n', 0o600);
}

/** A new token for the play-test round being handed over (any earlier one stops counting). → the token */
export async function issueToken(game, { round, checkpoint, channel = 'playtest' }, env = process.env) {
  const token = `${channel === 'reader' ? 'rd' : 'pt'}_${randomBytes(18).toString('base64url')}`;
  await writeToken(game, { schema: TOKEN_SCHEMA, game: path.resolve(game), round: Number(round) || 0, checkpoint: String(checkpoint ?? ''), hash: sha(token), token, used: false, report: null, at: new Date().toISOString() }, env, channel);
  return token;
}

/** The token of the round under way, when it is still unused (gamesfun_next shows the round's message again). */
export async function currentToken(game, { checkpoint, channel = 'playtest' } = {}, env = process.env) {
  const r = await tokenRecord(game, env, channel);
  return r && !r.broken && !r.used && typeof r.token === 'string' && same(sha(r.token), r.hash) && (checkpoint == null || r.checkpoint === String(checkpoint)) ? r.token : null;
}

/** Is this the round's token, still unused? → null when it is, else why not (plain words). */
export async function tokenProblem(game, token, { checkpoint, channel = 'playtest' } = {}, env = process.env) {
  if (typeof token !== 'string' || !token) return 'the report needs the token from your task message ("token")';
  const r = await tokenRecord(game, env, channel);
  if (!r) return `no ${channel === 'reader' ? 'reading' : 'play-test'} round has handed out a token for this game`;
  if (r.broken) return 'the token record was changed by something other than the loop';
  if (checkpoint != null && r.checkpoint !== String(checkpoint)) return 'that token is for another play-test round';
  if (r.used) return 'that token was already used: one report per round';
  if (!same(sha(token), r.hash)) return 'that is not this round\'s token';
  return null;
}

/** The report was written with the token: the token is used, and the report's exact bytes are recorded. */
export async function useToken(game, reportText, env = process.env, { channel = 'playtest' } = {}) {
  const r = await tokenRecord(game, env, channel);
  if (!r || r.broken) throw new Error(`no ${channel} token to use`);
  const { mac, ...rest } = r;
  await writeToken(game, { ...rest, token: null, used: true, report: sha(reportText), usedAt: new Date().toISOString() }, env, channel);
}

/** Was this report text written through the report tool with this round's token? */
export async function reportSigned(game, reportText, { checkpoint, channel = 'playtest' } = {}, env = process.env) {
  if (reportText == null) return false;
  const r = await tokenRecord(game, env, channel);
  return !!r && !r.broken && r.used && (checkpoint == null || r.checkpoint === String(checkpoint)) && same(r.report, sha(reportText));
}
