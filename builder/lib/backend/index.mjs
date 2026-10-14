// Connecting a game to its own backend: one shape for every provider, Supabase first. The CLI (builder/commands/backend.mjs),
// the studio's Backend tab (builder/server/routes/backend.mjs) and the MCP tools (builder/mcp/tools/backend.mjs) all call this file.
//
// A provider here is a row of PROVIDERS: how a person connects (`ways`, best first), and, when the kit itself can
// sign in, the functions that list projects and turn one into the game's public settings. A provider whose only way
// is "deploy, then paste the public URL" (the pattern for Railway, Render and the rest) needs only `use`.
//
// What reaches the game, whatever the way: backend.json (builder/lib/backend/config.mjs: the URL, a public key, the origins)
// and the client at gf/backend/. Both are checked first: the game folder's secret scan must be clean, and the key
// must be one designed to be public.
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addKitIgnores } from '../manifest-ignores.mjs';
import * as config from './config.mjs';
import { checkGame, judgeLive, LIVE_SQL, usedTables } from './rls.mjs';
import { describeHits, scanGame } from './scan.mjs';
import * as supabase from './supabase.mjs';
import * as mcp from './mcp.mjs';
import { listed, provider } from './providers.mjs';
import { cpWritable } from '../writable.mjs';

export const CLIENT_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend', 'gf-backend');
export const CLIENT_IN_GAME = ['gf', 'backend'];

export { PROVIDERS, provider, listed } from './providers.mjs';

/** Copy the client into the game (replacing an older copy). */
export async function installClient(gameDir) {
  const target = path.join(gameDir, ...CLIENT_IN_GAME);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cpWritable(CLIENT_SOURCE, target, { recursive: true });
  return target;
}

/** Refresh gf/backend/ in a game that has a backend (create and upgrade call it, as they refresh gf/web3/). → bool */
export async function refreshClient(gameDir) {
  try { await stat(path.join(gameDir, config.FILE)); } catch { return false; }
  await installClient(gameDir);
  return true;
}

/** Refuse when the game folder holds anything key-shaped (before and after the kit writes into it). */
export async function assertClean(gameDir, when) {
  const s = await scanGame(gameDir);
  if (!s.ok) throw Object.assign(new Error(`${when}: the game's files hold something that must never be in a game:\n${describeHits(s.hits)}\nRemove it (a secret belongs in the provider's own settings or the kit's secret store, never in the game).`), { code: 'SECRET', hits: s.hits });
  return s;
}

/**
 * Write the public settings: the URL and the public key the person's agent (or the kit) got from the provider.
 * Refuses a key that is not public, and a game folder that already holds a secret. → { settings, client }
 */
export async function use(gameDir, { provider: id = 'supabase', url, key = null, project = null, players = 'anonymous', loopbackOk = true } = {}) {
  const p = provider(id);
  if (key != null && !p.publicKey(key)) throw Object.assign(new Error(`Refused: that key is not public. A game may carry only ${p.label}'s publishable key (for Supabase: sb_publishable_… or the legacy anon key). A secret or service-role key bypasses row-level security and must never leave the server.`), { code: 'NOT_PUBLIC' });
  await assertClean(gameDir, 'before connecting');
  const origin = config.checkOrigin(url, { allowLoopback: loopbackOk });
  const u = new URL(origin);
  const ws = `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
  const settings = await config.write(gameDir, { version: 1, provider: id, url: origin, ...p.settings({ url: origin, key, project }), origins: [origin, ws], players });
  const client = await installClient(gameDir);
  await addKitIgnores(gameDir).catch(() => false);
  await assertClean(gameDir, 'after connecting');
  return { settings, client };
}

/**
 * The kit's own sign-in path (a pasted token or the kit's OAuth app): pick or create a project, wait until it answers,
 * take its public key, write it. `pick`: { project: ref } or { create: { name, org, region } }. → { settings, created, dbPass? }
 */
export async function connectWithKit(gameDir, pick, { onWait, ...o } = {}) {
  let p, created = null;
  if (pick.create) { created = await supabase.createProject(pick.create, o); p = created.project; }
  else p = await supabase.project(pick.project, o);
  p = await supabase.waitReady(p.ref, { onWait, ...o });
  const keys = await supabase.apiKeys(p.ref, o);
  let picked;
  try { picked = supabase.pickPublicKey(keys); } catch (e) {
    const made = await supabase.createPublishableKey(p.ref, o).catch(() => null);
    if (!made) throw e;
    picked = supabase.pickPublicKey([made]);
  }
  if (pick.anonymous) await supabase.setAnonymousSignIns(p.ref, true, o);
  const s = supabase.publicSettings(p, picked, o.env);
  const r = await use(gameDir, { provider: 'supabase', url: s.url, key: s.key, project: { ...s.project }, players: pick.anonymous ? 'anonymous' : 'none', loopbackOk: true });
  return { ...r, project: p, created: !!created, dbPass: created?.dbPass ?? null, dbPassSaved: created?.saved ?? null };
}

/** The static checks of a game's backend part: settings valid, no secrets, RLS on every table its code reads. */
export async function check(gameDir) {
  const out = { settings: null, settingsError: null, scan: null, rls: null };
  try { out.settings = await config.read(gameDir); } catch (e) { out.settingsError = e.message; }
  out.scan = await scanGame(gameDir);
  out.rls = await checkGame(gameDir);
  out.ok = !out.settingsError && out.scan.ok && out.rls.ok;
  return out;
}

/** The live check through the kit's own sign-in: Postgres' view of the exposed schema. */
export async function checkLive(gameDir, o = {}) {
  const s = await config.read(gameDir);
  if (!s?.project?.ref) throw new Error('the game has no Supabase project in backend.json');
  const rows = await supabase.query(s.project.ref, LIVE_SQL, { readOnly: true, ...o });
  return judgeLive(rows, { used: await usedTables(gameDir) });
}

/** The live check from rows the person's agent got itself (execute_sql with LIVE_SQL through Supabase's MCP). */
export async function judgeRows(gameDir, rows) {
  return judgeLive(rows, { used: await usedTables(gameDir) });
}

/** What the studio and `status` show. A game with no backend.json has no backend: that is the default. */
export async function status(gameDir, { env = process.env } = {}) {
  let settings = null, settingsError = null;
  try { settings = await config.read(gameDir); } catch (e) { settingsError = e.message; }
  let client = null;
  try { await stat(path.join(gameDir, ...CLIENT_IN_GAME, 'index.js')); client = 'gf/backend/'; } catch {}
  const providers = [];
  for (const p of listed()) {
    const P = provider(p.id);
    let st = null; try { st = await P.status({ env }); } catch (e) { st = { error: e.message }; }
    const steps = P.agentSteps();
    providers.push({ ...p, status: st, agent: { steps: steps.steps, tools: steps.tools } });
  }
  const agents = await mcp.added(gameDir).catch(() => []);
  return { game: { settings, settingsError, client, connected: !!settings, agents }, providers };
}

/** The words the studio sends the person's session for a provider's agent way. */
export const agentRequest = (id, gameName) => provider(id).agentSteps().request(gameName);

export { config, mcp, supabase, LIVE_SQL };
