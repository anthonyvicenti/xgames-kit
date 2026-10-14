// The run file: how the plugin's scripts and the tools find the running dev server without a fixed port. One small
// JSON file, <kit>/.gamesfun/bridge.json (git-ignored), with one entry per running server. plugin/scripts/lib.mjs
// reads the same file with its own copy of findRun (an installed plugin is copied away from the kit, so it cannot
// import this one); tests/bridge.test.mjs holds the two to the same answers.
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SCHEMA = 'gf-bridge/1';
export const RUN_FILE = ['.gamesfun', 'bridge.json'];
export const CONFIG_FILE = ['.gamesfun', 'bridge-config.json'];
export const WAIT_FORMS = ['rewake', 'monitor'];

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const text = JSON.stringify(value, null, 2) + '\n';
  await writeFile(tmp, text, { mode: 0o600 });
  // Windows: a rename over a file another process holds open fails with EPERM or EBUSY; write in place then.
  try { await rename(tmp, file); } catch { await writeFile(file, text, { mode: 0o600 }); await rm(tmp, { force: true }); }
  // macOS and Linux: only the person reads it. Windows: chmod changes nothing; the file sits in the person's own folder.
  await chmod(file, 0o600).catch(() => {});
}

const live = v => (v?.schema === SCHEMA && Array.isArray(v.runs) ? v.runs.filter(r => r && alive(r.pid)) : []);

/** Record this server. root: the folder that holds .gamesfun/. */
export async function recordRun(root, entry) {
  const file = path.join(root, ...RUN_FILE);
  const runs = live(await readJson(file, null)).filter(r => r.pid !== entry.pid);
  runs.push(entry);
  await writeJson(file, { schema: SCHEMA, runs });
  return file;
}
export async function forgetRun(root, pid) {
  const file = path.join(root, ...RUN_FILE);
  const v = await readJson(file, null);
  if (!v) return;
  await writeJson(file, { schema: SCHEMA, runs: live(v).filter(r => r.pid !== pid) });
}

const inside = (base, p) => { const rel = path.relative(path.resolve(base), path.resolve(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
function* above(dir) {
  let d = path.resolve(dir);
  for (;;) { yield d; const up = path.dirname(d); if (up === d) return; d = up; }
}

/**
 * Find the run for a session or a tool. Looks for .gamesfun/bridge.json in: env.GAMESFUN_BRIDGE_FILE; cwd and above;
 * env.CLAUDE_PROJECT_DIR and above; each of `extra` and above. Among live runs: the one whose game is cwd, inside it
 * or above it, else the newest. → { url, token, run, pid, game, wait, started, file } or null
 */
export async function findRun({ cwd = process.cwd(), env = process.env, extra = [] } = {}) {
  const files = [];
  if (env.GAMESFUN_BRIDGE_FILE) files.push(path.resolve(env.GAMESFUN_BRIDGE_FILE));
  for (const start of [cwd, env.CLAUDE_PROJECT_DIR, ...extra]) if (start) for (const d of above(start)) files.push(path.join(d, ...RUN_FILE));
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    const runs = live(await readJson(file, null));
    if (!runs.length) continue;
    const near = cwd ? runs.filter(r => r.game && (inside(cwd, r.game) || inside(r.game, cwd))) : [];
    const pick = (near.length ? near : runs).sort((a, b) => (b.started ?? 0) - (a.started ?? 0))[0];
    return { ...pick, file };
  }
  return null;
}

/** The form of the wait this checkout uses: 'rewake' (default) or 'monitor'. */
export async function waitForm(root, env = process.env) {
  if (WAIT_FORMS.includes(env.GAMESFUN_BRIDGE_WAIT)) return env.GAMESFUN_BRIDGE_WAIT;
  const v = await readJson(path.join(root, ...CONFIG_FILE), null);
  return WAIT_FORMS.includes(v?.wait) ? v.wait : 'rewake';
}
/** What `doctor` calls to switch. Takes effect at the next start of the dev server. */
export async function setWaitForm(root, form) {
  if (!WAIT_FORMS.includes(form)) throw new Error(`the wait is one of: ${WAIT_FORMS.join(', ')}`);
  await writeJson(path.join(root, ...CONFIG_FILE), { wait: form });
  return form;
}
