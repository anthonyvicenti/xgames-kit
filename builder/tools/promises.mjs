#!/usr/bin/env node
// gf-three promises: what this game promises a player, and how each promise is proven (no browser, under a second).
//
//   node builder/tools/promises.mjs <game dir> [--spec spec.json] [--json]
//
// The list comes from the spec (<game>/spec.json unless --spec) and config/game.json: every control the HUD lists,
// the core loop (rules.summary) and scoring, each mechanic's `as`, the hook, the spec's `accept` items and the kit's
// standing promises (friends visible: verify 5; a round to results: 6; fair play: 10; clean world: 11; something
// happens: 12; controls work: 13). notInV1 items are never promised. Proofs: 'verify:N' or 'play' (a play-tester's own
// screen, builder/spec/prompts/playtest.md). Logic and the promise format: tools/lib/promises.mjs.
// Exit: 0, or 2 on bad usage or a game with no spec or config.
import { isMain } from './lib/main.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisesFor } from './lib/promises.mjs';

if (isMain(import.meta)) {
  const a = process.argv.slice(2);
  const opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const dir = a.find((x, i) => !x.startsWith('--') && a[i - 1] !== '--spec');
  if (!dir) { console.error('usage: promises.mjs <game dir> [--spec spec.json] [--json]'); process.exit(2); }
  let list;
  try { list = await promisesFor(dir, { spec: opt('--spec') }); } catch (e) { console.error(e.message); process.exit(2); }
  if (a.includes('--json')) process.stdout.write(JSON.stringify(list, null, 2) + '\n');
  else {
    console.log(`${list.title || dir}: ${list.promises.length} promises (${list.promises.filter(p => p.core).length} core, ${list.promises.filter(p => p.proofs.includes('play')).length} for the play-tester)`);
    console.log(`  HUD: ${list.controls.hud}`);
    for (const p of list.promises) console.log(`  ${p.core ? '*' : ' '} ${p.id.padEnd(18)} [${p.proofs.join(', ')}] ${p.text}`);
    if (list.notPromised.length) console.log(`  not in v1 (never promised): ${list.notPromised.join('; ')}`);
    for (const x of list.excluded) console.log(`  excluded ${x.id}: ${x.because}`);
  }
}
