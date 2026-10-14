// "One of our tools is running on this game": a small marker the MCP server writes while a tool call is under way
// (builder/mcp/server.mjs) and the studio bridge reads at a turn end (builder/bridge/loop-state.mjs, readRunning; a test holds the two
// to the same file). Why: an agent moves a long tool call (a verify takes minutes) to the background and ends its turn
// to wait for the result. That turn end is a wait, not a build left half done, and only the tool's own process knows.
// The marker is one file per call in <game>/.gf-loop/running/ (the loop's own folder: never a game file, never in a
// checkpoint). A reader drops a marker whose process is gone or that is older than MAX_AGE_MS.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import path from 'node:path';

export const RUNNING_DIR = ['.gf-loop', 'running'];
export const MAX_AGE_MS = 30 * 60 * 1000;
let n = 0;
const open = new Set();
let hooked = false;

/** Mark a tool call as running on a game folder. → done(), to call when the call is over (never throws). */
export async function markRunning(gameDir, tool, { pid = process.pid, now = Date.now } = {}) {
  const file = path.join(gameDir, ...RUNNING_DIR, `${pid}-${++n}.json`);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ tool, pid, since: now() }) + '\n');
  } catch { return async () => {}; }   // a folder that cannot be written: the guard then counts the stop, as before
  open.add(file);
  if (!hooked) { hooked = true; process.once('exit', () => { for (const f of open) { try { rmSync(f, { force: true }); } catch { /* gone */ } } }); }
  return async () => { open.delete(file); await rm(file, { force: true }).catch(() => {}); };
}
