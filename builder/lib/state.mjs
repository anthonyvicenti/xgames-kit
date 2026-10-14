// Local state in .gamesfun/ (git-ignored): the dev servers running from this checkout, so `gamesfun dev` started in
// one terminal can be found by the MCP server or another command.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STATE } from './paths.mjs';

const DEV = path.join(STATE, 'dev.json');

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function read() {
  try { return JSON.parse(await readFile(DEV, 'utf8')); } catch { return { servers: [] }; }
}
async function write(v) {
  await mkdir(STATE, { recursive: true });
  const tmp = `${DEV}.${process.pid}.tmp`;
  const text = JSON.stringify(v, null, 2) + '\n';
  await writeFile(tmp, text);
  try { await rename(tmp, DEV); } catch { await writeFile(DEV, text); await rm(tmp, { force: true }); }   // Windows: EPERM/EBUSY
}

/** Running dev servers (dead entries dropped). */
export async function listDevServers() {
  const v = await read();
  return (v.servers ?? []).filter(s => alive(s.pid));
}
export async function recordDevServer(entry) {
  const servers = (await listDevServers()).filter(s => s.pid !== entry.pid);
  servers.push(entry);
  await write({ servers });
}
export async function forgetDevServer(pid) {
  const v = await read();
  await write({ servers: (v.servers ?? []).filter(s => s.pid !== pid && alive(s.pid)) });
}
