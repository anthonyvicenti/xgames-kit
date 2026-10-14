#!/usr/bin/env node
// gf-three serve: one game folder as static files plus this machine's signaling, so two windows can play together.
// The multiplayer kit's own server (multiplayer/party/serve.mjs → lib.mjs startParty), unchanged.
//
//   node builder/tools/serve.mjs <game-dir> [--port 5790] [--host 127.0.0.1]
//   → http://127.0.0.1:<port>/          the game alone (with bots)
//     http://127.0.0.1:<port>/gf/mp/    with friends: Host, then open the invite link in another window
import { isMain } from './lib/main.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startParty, readManifest, validateMultiplayer } from '../multiplayer/party/lib.mjs';

export async function serve(dir, { port = 0, host = '127.0.0.1' } = {}) {
  const { manifest, error } = await readManifest(resolve(dir));
  const problems = error ? [`multiplayer.json is ${error}`] : validateMultiplayer(manifest).problems;
  const s = await startParty({ dir: resolve(dir), port, host });
  return { ...s, problems };
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const dir = a.find((x, i) => !x.startsWith('--') && !['--port', '--host'].includes(a[i - 1]));
  if (!dir) { console.error('usage: serve.mjs <game-dir> [--port 5790] [--host 127.0.0.1]'); process.exit(2); }
  const s = await serve(dir, { port: Number(opt('--port', 5790)), host: opt('--host', '127.0.0.1') });
  for (const p of s.problems) console.log(`problem: ${p}`);
  console.log(`game      ${s.url}`);
  console.log(`friends   ${s.partyUrl}   (Host, then open the invite link in a second window)`);
}
