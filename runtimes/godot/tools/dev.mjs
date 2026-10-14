#!/usr/bin/env node
// Play a runtime godot game while building it: serves the game with the friends page and its signaling (gf/mp), and
// exports the Godot project again whenever a file in project/ changes (reload the tab to see it). rules.js, config/
// and assets/ are read by the page as they are: a reload shows them, no export needed.
//
//   node runtimes/godot/tools/dev.mjs <game-dir> [--port 5780] [--host 127.0.0.1]
//   → the game alone, and the friends page: Host in one window, open the invite link in another
import { watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportGame } from './export.mjs';
import { isMain, SHARED } from './lib.mjs';

export async function dev(gameDir, { port = 5780, host = '127.0.0.1', log = console.log } = {}) {
  const dir = resolve(gameDir);
  const first = await exportGame(dir, { log });
  if (!first.ok) for (const e of first.errors) log(`export: ${e}`);
  const { startParty } = await import(pathToFileURL(join(SHARED.party, 'lib.mjs')).href);
  const srv = await startParty({ dir, port, host });
  log(`game      ${srv.url}`);
  log(`friends   ${srv.partyUrl}   (Host here, then open the invite link in another window)`);
  let timer = null, running = false, again = false;
  const rebuild = async () => {
    if (running) { again = true; return; }
    running = true;
    const r = await exportGame(dir, { log }).catch(e => ({ ok: false, errors: [e.message] }));
    if (!r.ok) for (const e of r.errors) log(`export: ${e}`);
    else if (!r.skipped) log('exported: reload the tab');
    running = false;
    if (again) { again = false; rebuild(); }
  };
  const w = watch(join(dir, 'project'), { recursive: true }, (_, f) => {
    if (!f || /(^|[\\/])\.godot([\\/]|$)/.test(f)) return;
    clearTimeout(timer); timer = setTimeout(rebuild, 400);
  });
  return { srv, close: async () => { w.close(); await srv.close(); } };
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const dir = a.find((x, i) => !x.startsWith('--') && !['--port', '--host'].includes(a[i - 1]));
  if (!dir) { console.error('usage: dev.mjs <game-dir> [--port 5780] [--host 127.0.0.1]'); process.exit(2); }
  const d = await dev(dir, { port: Number(opt('--port', 5780)), host: opt('--host', '127.0.0.1') });
  process.on('SIGINT', async () => { await d.close(); process.exit(0); });
}
