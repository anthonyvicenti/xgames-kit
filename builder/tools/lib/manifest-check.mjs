// verify check 1, second half: assets.json holds exactly the slots the game's declarations give (the creator's
// question 16, open builder wave 8, track V).
//
// assets.json is written by tools/slots.mjs from the declarations: the kit modules' slots (from the game's own kit
// copy), config/*.json and the files under assets/ (tools/lib/slots-lib.mjs assembleManifest). An agent that adds a
// rules param, a prop or a mechanic and does not run `slots.mjs --write` leaves a value Studio cannot show; a slot
// deleted from assets.json by hand left a hole nothing noticed (STATUS.md, "Known faults"). Until now check 1 only
// asked that the file was well formed.
//
//   missing   a slot the declarations give and assets.json lacks. Mechanical: tools/fix.mjs (fix "manifest-slots") puts
//             it back from the declarations and notes the repair. verify itself never writes a game, so a game that
//             reaches verify with one fails check 1 and is told the command.
//   extra     a slot in assets.json that nothing declares. Not mechanical (delete it, or declare it: a rules param in
//             config/game.json → rules.params, a prop in config/world.json): it fails check 1 and is named.
//
// Only ids are compared. A slot whose id is declared and whose label or default differs is not judged here.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assembleManifest } from './slots-lib.mjs';

/**
 * assets.json's slot ids against the declarations'. → {ok, missing: [ids], extra: [ids], have, want, slots (the
 * declarations' slots by id, for a repair), error (when the declarations could not be read: then ok is true and the
 * caller says so: a game this tool cannot assemble is judged by the rest of check 1)}
 */
export async function manifestDiff(dir, { manifest = null } = {}) {
  let cur = manifest;
  try { cur ??= JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8')); } catch (e) { return { ok: true, missing: [], extra: [], have: 0, want: 0, slots: new Map(), error: `assets.json could not be read: ${e.message}` }; }
  let want;
  try { want = (await assembleManifest(dir, { sounds: cur.sounds ?? null })).manifest; } catch (e) { return { ok: true, missing: [], extra: [], have: (cur.slots ?? []).length, want: 0, slots: new Map(), error: `the declarations could not be assembled: ${String(e.message).split('\n')[0]}` }; }
  const have = new Set((cur.slots ?? []).map(s => s.id)), slots = new Map(want.slots.map(s => [s.id, s]));
  const missing = want.slots.map(s => s.id).filter(id => !have.has(id)), extra = [...have].filter(id => !slots.has(id));
  return { ok: !missing.length && !extra.length, missing, extra, have: have.size, want: slots.size, slots, order: want.slots.map(s => s.id), error: null };
}

/** Check 1's words for a difference. */
export function manifestLine(d, game = '<game>') {
  if (d.error) return `slot ids not compared (${d.error})`;
  if (d.ok) return `its ${d.have} slots are the ${d.want} the declarations give`;
  const some = (l, n = 5) => `${l.slice(0, n).join(', ')}${l.length > n ? ` and ${l.length - n} more` : ''}`;
  return [
    d.missing.length ? `assets.json lacks ${d.missing.length} slot${d.missing.length === 1 ? '' : 's'} the declarations give (${some(d.missing)}): node gf-three/tools/fix.mjs ${game} adds ${d.missing.length === 1 ? 'it' : 'them'} (or slots.mjs ${game} --write)` : '',
    d.extra.length ? `assets.json has ${d.extra.length} slot${d.extra.length === 1 ? '' : 's'} that nothing declares (${some(d.extra)}): declare ${d.extra.length === 1 ? 'it' : 'each'} where it belongs (a rules number in config/game.json → rules.params, a prop in config/world.json) or delete ${d.extra.length === 1 ? 'it' : 'them'}; no tool can tell which` : '',
  ].filter(Boolean).join('; ');
}
