// What a game's parts declare about the player, for the checks that used to assume a body that walks (open builder
// wave 8, track V). Nothing here is a table of mechanics: every answer is read from a part's own manifest
// (kit/mechanics/<id>/index.js → manifest.owns(params), tools/catalog.mjs partFor) or from what the part says on the
// page (window.__game.controls(): `mark`, `points`, and `interactables` with `turn: true`).
//
//   holdsBody(game)   → the part that owns `player.control` in this game (a board with a cursor: the body stands at the
//                       table and the keys move the player's mark), or null. Checks 3 and 24 then judge the part's own
//                       sign of the player moving (the mark, snapshot().players[].mark) and never pass a body that
//                       stands still without one. Check 5 needs no reading here: the kit's own gate block
//                       (kit/net/session.js gateBlock) reports the mark as where the player is, and says `mark: true`.
//   whereIs(player)   → the mark when the page reports one, else the body: {x, z, mark}
import { mechanicParts, partFor } from '../catalog.mjs';

/** The kit's mechanics with their manifests, read once (as alive-check.mjs reads them for check 15's signs). */
export const MECHANICS = await mechanicParts();

/** The parts of this game that own `res` outright (not shared), by their manifests: [{id, why, free}]. */
export function ownersOf(game, res, parts = MECHANICS) {
  const out = [];
  for (const m of game?.mechanics ?? []) {
    const part = parts.find(p => p.id === m.id && p.manifest);
    if (!part) continue;
    let owns = []; try { owns = partFor(part, m.params ?? {}).owns; } catch { owns = []; }
    for (const o of owns) if (o.res === res && !o.shared) out.push({ id: m.id, why: o.why ?? '', free: o.free ?? '' });
  }
  return out;
}

/** The part that holds the player's body in this game (owns player.control), or null. */
export const holdsBody = (game, parts = MECHANICS) => ownersOf(game, 'player.control', parts)[0] ?? null;

/** Where a player of the observation is: their mark when a part gave one, else their body. */
export const whereIs = p => (p ? (p.mark && Number.isFinite(p.mark.x) && Number.isFinite(p.mark.z) ? { x: p.mark.x, z: p.mark.z, mark: true } : { x: p.x, z: p.z, mark: false }) : null);
