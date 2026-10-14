// A change request re-enters at the ledger. What changed in the ledger says what the change may touch:
//   look     only feel and reference lines changed: kind, packs, slots and look values; the loop, the mechanics, the
//            rules and the controls are held, so a look change never silently changes play
//   tune     no line changed (a fix or a number): the runtime, the profile and the loop are held
//   play     what a player does changed (action, thing, players, body, perspective lines): the runtime and profile held
//   loop     who acts when changed: the loop moves, the runtime is held
//   runtime  the hard limits now need another runtime: shown to the person as a migration with its consequences,
//            and nothing moves until they say yes
import { chooseFoundation, migrationOf } from './foundation.mjs';
import { diffLedger } from './ledger.mjs';

const LOOK = ['feel', 'reference'];
export const HOLDS = {
  look: ['runtime', 'profile', 'loop', 'mechanics', 'rules', 'controls', 'players'],
  tune: ['runtime', 'profile', 'loop'],
  play: ['runtime', 'profile'],
  loop: ['runtime', 'profile'],
  runtime: [],
};

/** → {class, foundation, diff, migration, holds, problems, probes} */
export async function classifyChange({ before, ledger, registry, ownFiles = [] }) {
  const diff = diffLedger(before.ledger, ledger);
  const foundation = await chooseFoundation(ledger, registry, { current: before.foundation });
  if (!foundation.ok) return { class: null, foundation, diff, migration: null, holds: [], problems: foundation.problems ?? [], probes: foundation.probes ?? [] };
  const moved = k => foundation[k] !== before.foundation[k];
  const cls = moved('runtime') || moved('profile') ? 'runtime'
    : moved('loop') || diff.abouts.has('acts') ? 'loop'
    : !diff.abouts.size ? 'tune'
    : [...diff.abouts].every(a => LOOK.includes(a)) ? 'look' : 'play';
  const migration = cls === 'runtime' ? await migrationOf(before.foundation, foundation, { spec: before.spec, registry, ownFiles }) : null;
  return { class: cls, foundation, diff, migration, holds: HOLDS[cls], problems: [], probes: [] };
}

/** The spec a change round leaves, against what its class holds. → problems */
export function checkChangeSpec(cls, before, after) {
  const out = [];
  for (const k of HOLDS[cls] ?? []) {
    if (JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null)) {
      out.push(cls === 'look'
        ? `${k}: a change of look never changes play, and this one changed the spec's ${k}. Put it back; if the person wants play changed too, that is its own change request`
        : `${k}: a ${cls} change holds the spec's ${k}; ${k === 'runtime' || k === 'profile' ? 'another runtime is a migration the person agrees to first' : 'a change of who acts when goes through the ledger\'s acts line'}`);
    }
  }
  return out;
}
