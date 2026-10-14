// Did the build agent run its own `verify --quick` on the game as it delivered it? (Pipeline track C, 2026-10-07.)
//
// The build round's brief (builder/loop/brief.mjs composeBrief) has the agent run `node …/verify.mjs game --quick` until it
// passes, then write out/delivery.json last. verify (no --out) leaves each run in <game>/evidence/verify-N/verdict.json,
// and every verdict carries `gameFiles`: a hash of the files the agent tunes. So the worker can tell, with no browser,
// whether the agent's last quick verify passed on exactly the files it delivered, before spending a full verify, a
// play-test and a repair round on a game the agent never checked (or checked before its last edit).
//
//   const fp = await gameFingerprint(gameDir);   // {sha, files}
//   const own = await ownVerify(gameDir);        // {ok, found, pass, fresh, quick, at, failed, verdict, why}
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** The files the build agent edits (rules and tuning). Bodies the worker generates afterwards never make a run stale. */
export const GAME_FILES = ['rules.js', 'config/game.json', 'config/world.json', 'config/props.json', 'config/look.json'];

/** The agent's code beyond GAME_FILES (CONTRACT §1.7): the game's own modules under src/ and its declared overrides
 *  (gf-three.json → overrides, each file and the declaration). → [paths], sorted */
async function ownCode(dir) {
  const out = (await readdir(join(dir, 'src'), { recursive: true }).catch(() => [])).filter(f => /\.m?js$/.test(f)).map(f => `src/${f.split('\\').join('/')}`).sort();
  try { out.push(...Object.keys(JSON.parse(await readFile(join(dir, 'gf-three.json'), 'utf8')).overrides ?? {}).sort()); } catch {}
  return out;
}

/** One hash over the agent's files as they are now (a missing file counts as missing): GAME_FILES, then its src/
 *  modules and declared overrides when it has any. → {sha, files} */
export async function gameFingerprint(dir) {
  const h = createHash('sha256'), files = [];
  for (const f of [...GAME_FILES, ...(await ownCode(dir))]) {
    const p = join(dir, f);
    h.update(`${f}\n`);
    if (existsSync(p)) { h.update(await readFile(p)); files.push(f); } else h.update('(missing)');
    h.update('\n');
  }
  return { sha: h.digest('hex'), files };
}

/**
 * The agent's last verify in <game>/evidence/verify-N/ (by when it finished). ok when it ran the whole quick verify
 * (not --check N alone), passed, and its gameFiles match the files now. → {ok, found, pass, fresh, quick, at, failed:
 * [check numbers], verdict (the folder, relative to the game), why}
 */
export async function ownVerify(dir) {
  const root = join(dir, 'evidence');
  const runs = [];
  for (const e of existsSync(root) ? await readdir(root, { withFileTypes: true }) : []) {
    if (!e.isDirectory() || !/^verify-\d+$/.test(e.name)) continue;
    try { const v = JSON.parse(await readFile(join(root, e.name, 'record.json'), 'utf8')); if (!v.only) runs.push({ name: e.name, v }); } catch {}
  }
  runs.sort((a, b) => String(a.v.finished ?? '').localeCompare(String(b.v.finished ?? '')));
  const last = runs.at(-1);
  if (!last) return { ok: false, found: false, why: 'no verify run in game/evidence/ (the agent never ran verify --quick on this folder)' };
  const now = await gameFingerprint(dir);
  const fresh = last.v.gameFiles?.sha === now.sha;
  const failed = (last.v.checks ?? []).filter(c => c.ok === false).map(c => c.n);
  const pass = last.v.pass === true;
  const why = !pass ? `its last verify (${last.name}) failed check${failed.length === 1 ? '' : 's'} ${failed.join(', ') || '(none listed)'}`
    : !fresh ? `its last passing verify (${last.name}) ran before the last change to ${GAME_FILES.join(', ')}${last.v.gameFiles ? '' : ' (or on a verify too old to record them)'}`
      : `its last verify (${last.name}) passed on the files it delivered`;
  return { ok: pass && fresh, found: true, pass, fresh, quick: !!last.v.quick, at: last.v.finished ?? null, failed, verdict: `evidence/${last.name}`, runs: runs.length, why };
}
