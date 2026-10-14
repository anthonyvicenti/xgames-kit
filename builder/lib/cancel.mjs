// "The person rolled the game back from the studio page while a run was under way": one small file, written by the
// dev server's roll-back route and applied by the loop tools.
//
// Why a file and not a write to the loop's state: the state file is the loop library's, and the MCP server holds it
// in memory for as long as it lives (heldStore: a state file changed by anyone else is written again and refused as
// `state-changed`). The dev server is another process, so it cannot end a run itself. It leaves this mark; the next
// loop tool call ends the run with the library's own `loop.cancel(reason)` and removes the mark. Until then every
// reader of the loop's state on the dev server's side (the stop guard, the Build tab, gamesfun_requests) reads a run
// with this mark as cancelled (builder/bridge/loop-state.mjs readCancel; a test holds the two to the same file).
//
// The mark is in the loop's own folder (<game>/.gf-loop/), which the plugin's write guard keeps the session out of.
// A forged mark gains a session nothing: a cancelled run delivers nothing.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CANCEL_FILE = ['.gf-loop', 'cancel.json'];
export const CANCEL_SCHEMA = 'gf-cancel/1';
const fileOf = game => path.join(game, ...CANCEL_FILE);

/** → { schema, reason, checkpoint, label, at } or null */
export async function readCancel(game) {
  try { const m = JSON.parse(await readFile(fileOf(game), 'utf8')); return m?.schema === CANCEL_SCHEMA && typeof m.reason === 'string' ? m : null; } catch { return null; }
}
export async function writeCancel(game, { reason, checkpoint = null, label = null, at = new Date().toISOString() }) {
  const file = fileOf(game), tmp = `${file}.${process.pid}.tmp`, mark = { schema: CANCEL_SCHEMA, reason: String(reason).slice(0, 600), checkpoint, label, at };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, JSON.stringify(mark, null, 1) + '\n');
  await rename(tmp, file);
  return mark;
}
export const clearCancel = game => rm(fileOf(game), { force: true }).catch(() => {});
