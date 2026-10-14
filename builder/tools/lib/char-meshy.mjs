// Meshy client for track C, with a credit ledger and a hard cap. The key is never printed, and errors are scrubbed of
// it. Run on the host, never in the agent container.
//
// Everything a caller outside games.fun needs comes from the environment (meshySettings below):
//   MESHY_API_KEY     the key. Inside games.fun it may instead be in research/pipeline-v2/.env (gitignored).
//   GF_MESHY_LEDGER   the ledger file. Inside games.fun the default is gf-three/library/meshy-ledger.jsonl.
//                     Outside games.fun there is no default: a paid task is refused until it is set, so nothing is
//                     ever written into a copy of the tools.
//   GF_MESHY_WAVE     the budget this run spends from (default studio-v2-wave-1)
//   GF_MESHY_CAP      that budget's cap in credits (default 150)
// "Inside games.fun" means research/pipeline-v2 is beside these tools.
//
// Ledger: one line per create and per finish:
//   {at, wave, track, label, endpoint, id, status, credits?, estimate?}
// Cap: the creator approved 150 credits for Studio v2 wave 1 (2026-10-06). spend() refuses a task whose estimate
// would take the wave's total over the cap.
import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the key and the ledger come from, and the budget. Pure apart from `exists`.
 * → {keyFrom: 'env' | 'file' | null, envFile, ledger: path | null, wave, cap, inRepo}
 */
export function meshySettings({ env = process.env, here = import.meta.url, exists = existsSync } = {}) {
  const pipeline = fileURLToPath(new URL('../../../pipeline-v2/', here));
  const inRepo = exists(pipeline);
  const envFile = fileURLToPath(new URL('../../../pipeline-v2/.env', here));
  return {
    keyFrom: env.MESHY_API_KEY ? 'env' : inRepo && exists(envFile) ? 'file' : null, envFile, inRepo,
    ledger: env.GF_MESHY_LEDGER ? resolve(env.GF_MESHY_LEDGER) : inRepo ? fileURLToPath(new URL('../../library/meshy-ledger.jsonl', here)) : null,
    // The live Studio worker spends from its own budget: GF_MESHY_WAVE=studio-v2-live with GF_MESHY_CAP (creator turned
    // Meshy on for live builds, 2026-10-07). Unset, the tools keep wave 1's 150-credit cap.
    wave: env.GF_MESHY_WAVE || 'studio-v2-wave-1',
    cap: Number(env.GF_MESHY_CAP) > 0 ? Number(env.GF_MESHY_CAP) : 150,
  };
}
const SET = meshySettings();
export const LEDGER = SET.ledger;
export const WAVE = SET.wave;
export const CAP = SET.cap;
/** Credits Meshy charged for these steps (docs and the Gecko Zombies ledger, 2026-09-23). */
export const COST = { 'text-to-image': 6, 'image-to-image': 6, 'image-to-3d': 30, rigging: 5 };
const BASE = 'https://api.meshy.ai/openapi';

let KEY = null;
function key() {
  if (KEY) return KEY;
  if (process.env.MESHY_API_KEY) return (KEY = process.env.MESHY_API_KEY);
  if (!SET.inRepo) throw new Error('MESHY_API_KEY is not set (put your Meshy key in the environment)');
  if (!existsSync(SET.envFile)) throw new Error('MESHY_API_KEY: research/pipeline-v2/.env is missing');
  KEY = parseEnv(readFileSync(SET.envFile, 'utf8')).MESHY_API_KEY;
  if (!KEY) throw new Error('MESHY_API_KEY is not set in research/pipeline-v2/.env');
  return KEY;
}
const scrub = s => (KEY ? String(s).split(KEY).join('[key]') : String(s));
/** A paid task needs somewhere to record it: refuse before any request when there is no ledger. */
function needLedger(label) {
  if (!LEDGER) throw new Error(`Meshy cap: no ledger to count credits in, so ${label} was not started. Set GF_MESHY_LEDGER to a file (and GF_MESHY_WAVE, GF_MESHY_CAP for the budget).`);
}

export function ledger() {
  if (!LEDGER || !existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
/** Credits spent in this wave: each task's consumed_credits once it finished, its estimate while it hasn't. */
export function spent(wave = WAVE) {
  const rows = ledger().filter(r => r.wave === wave);
  let sum = 0;
  for (const c of rows.filter(r => r.status === 'CREATED')) {
    const end = rows.find(r => r.id === c.id && r.status !== 'CREATED');
    sum += !end ? c.estimate : end.credits ?? (end.status === 'SUCCEEDED' ? c.estimate : 0);
  }
  return sum;
}
function log(row) { mkdirSync(dirname(LEDGER), { recursive: true }); appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), wave: WAVE, track: 'C', ...row }) + '\n'); }

export async function call(method, path, body, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(BASE + path, { method, headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 300) }; }
  if (!r.ok) throw new Error(scrub(`Meshy ${method} ${path} → ${r.status} ${t.slice(0, 400)}`));
  return j;
}
/** Free: the account's credit balance, or null if the endpoint is unavailable. */
export async function balance() { try { const b = await call('GET', '/v1/balance'); return b.balance ?? b; } catch { return null; } }

/** Starts a paid task after checking the cap. kind is a COST key; label names it in the ledger. */
export async function create(kind, path, body, label, { cap = CAP } = {}) {
  const estimate = COST[kind] ?? 30;
  needLedger(label);
  const before = spent();
  if (before + estimate > cap) throw new Error(`Meshy cap: ${before} credits spent in ${WAVE}; ${label} (about ${estimate}) would pass the ${cap}-credit cap. Stopped.`);
  const { result } = await call('POST', path, body);
  log({ label, endpoint: path, id: result, status: 'CREATED', estimate });
  return result;
}
export async function wait(path, id, label, { onProgress = () => {}, every = 5000, timeout = 20 * 60e3 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const t = await call('GET', `${path}/${id}`);
    onProgress(`${label} ${t.status} ${t.progress ?? ''}%`);
    if (t.status === 'SUCCEEDED') { log({ label, endpoint: path, id, status: t.status, credits: t.consumed_credits ?? null }); return t; }
    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(t.status)) { log({ label, endpoint: path, id, status: t.status, credits: t.consumed_credits ?? 0, error: scrub(JSON.stringify(t.task_error ?? '')) }); throw new Error(`${label} ${t.status}: ${scrub(JSON.stringify(t.task_error ?? ''))}`); }
    if (Date.now() - t0 > timeout) throw new Error(`${label}: still ${t.status} after ${timeout / 60e3} min (task ${id})`);
    await new Promise(r => setTimeout(r, every));
  }
}
export async function download(url, path) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  if (path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, b); }
  return b;
}
export const dataUri = (bytes, mime) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
