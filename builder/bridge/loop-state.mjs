// The one place the bridge reads the build loop's state. The file is written only by the loop library, through the
// loop tools (builder/loop/state.mjs); the bridge never writes it. If its place or
// shape changes, this function is all that follows.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { trustedState } from '../lib/loop-seal.mjs';

export const LOOP_STATE = ['.gf-loop', 'state.json'];
export const LOOP_STATUSES = ['building', 'waiting-on-creator', 'delivered', 'failed', 'cancelled'];
// The mark the dev server's roll-back route leaves when the person rolls back a run that is under way (builder/lib/cancel.mjs
// writes it; a test holds the two to the same file). The loop tools end the run at their next call; until then a
// building run with this mark is read as cancelled, with `cancel` naming the mark so a session can be told once.
export const CANCEL_FILE = ['.gf-loop', 'cancel.json'];
export async function readCancel(gameDir) {
  try { const m = JSON.parse(await readFile(path.join(gameDir, ...CANCEL_FILE), 'utf8')); return m?.schema === 'gf-cancel/1' && typeof m.reason === 'string' ? m : null; } catch { return null; }
}

/** → { status, step, why, round, updated, session, handed, cancel? } or null (no file, not JSON, or a status the bridge does not know). */
export async function readLoopState(gameDir) {
  // the state as its seal has it (builder/lib/loop-seal.mjs): a state file edited to "delivered" does not let a session stop
  const s = await trustedState(gameDir, path.join(gameDir, ...LOOP_STATE)).catch(() => null);
  if (!s || typeof s !== 'object' || !LOOP_STATUSES.includes(s.status)) return null;
  const mark = s.status === 'building' ? await readCancel(gameDir) : null;
  if (mark) return { status: 'cancelled', step: 'done', why: mark.reason, round: s.round ?? null, updated: mark.at ?? null, session: typeof s.session === 'string' ? s.session : null, handed: null, cancel: { at: mark.at ?? null, label: mark.label ?? null } };
  // the play-tester has reported for the round that is handed over: the round is the session's again (it reads the report)
  let reported = false;
  if (s.step === 'playtest' && s.handed?.step === 'playtest') {
    const at = await stat(path.join(gameDir, '.gf-loop', 'job', 'playtest', 'out', 'playtest.json')).then(x => x.mtimeMs, () => null);
    reported = at != null && at + 1000 >= (Date.parse(s.handed.at) || 0);
  }
  return {
    ...(reported ? { reported } : {}),
    status: s.status,
    step: typeof s.step === 'string' ? s.step : null,
    why: typeof s.why === 'string' ? s.why : null,
    round: s.round ?? null,
    updated: s.updated ?? null,
    session: typeof s.session === 'string' ? s.session : null,
    // who has the round, when someone does: 'playtest' means the play-tester subagent, not the session itself
    handed: s.handed && typeof s.handed === 'object' ? String(s.handed.step ?? s.handed.kind ?? 'round') : null,
  };
}

// Tool calls of ours that are running on the game right now (builder/lib/running.mjs writes one marker per call; this is the
// bridge's reader of them). A marker counts while its process lives and it is younger than half an hour.
export const RUNNING_DIR = ['.gf-loop', 'running'];
const MAX_AGE_MS = 30 * 60 * 1000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** → [{ tool, pid, since }] */
export async function readRunning(gameDir, { now = Date.now, isAlive = alive } = {}) {
  const dir = path.join(gameDir, ...RUNNING_DIR);
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    let m = null;
    try { m = JSON.parse(await readFile(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!m || !Number.isInteger(m.pid) || typeof m.since !== 'number') continue;
    if (now() - m.since > MAX_AGE_MS || !isAlive(m.pid)) continue;
    out.push({ tool: String(m.tool ?? ''), pid: m.pid, since: m.since });
  }
  return out;
}

// The locked spec, as the stop guard reads it. Reads only. The lock (builder/loop/loop.mjs, gf-loop/2) holds the spec's
// text in the state itself, so there is no locked file on disk to compare: `problems` is empty and stays in the answer
// for the guard's shape.
//   refusals  what the loop refused: [{ code, at }]
export async function readLock(gameDir) {
  let s;
  try { s = JSON.parse(await readFile(path.join(gameDir, ...LOOP_STATE), 'utf8')); } catch { return { problems: [], refusals: [] }; }
  const refusals = (Array.isArray(s?.refusals) ? s.refusals : []).filter(r => r && typeof r.code === 'string' && r.told !== true).map(r => ({ code: r.code, at: r.at ?? null }));
  return { problems: [], refusals };
}
