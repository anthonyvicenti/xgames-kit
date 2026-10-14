// verify check 17's own rule for a forge world, beside the kit's world lint (gf/forge/arena.js lintWorld, which
// tools/verify-forge.mjs runs first and which stays the kit's): what a world's lists claim must be in the world.
//
// Why (track S2, 2026-10-10; gf-three/regressions/forge-no-cover): the kit's lint counts cover from
// config/world.json → cover, a list the arena generator writes beside the pieces. With every cover piece and collider
// taken out of the arena and the list left, it said "10 cover" and passed check 17: an arena with nothing to stand
// behind was "complete". (With the list emptied and every pillar standing it failed.) A build agent who opens an arena
// up edits pieces and colliders, not that list.
//
//   listedCover(world)        → {listed, standing, missing: [{piece, at}]}: a listed piece of cover stands when a solid
//                               cover collider is at its place (within PAD metres)
//   forgeWorldProblems(world) → problems in the lint's own shape ({check, rule, severity, message, fix}) for check 17
export const COVER_PAD = 0.5;

/** The cover a world lists, and which of it stands: a collider of kind "cover", solid and above knee height, where the entry says. */
export function listedCover(world, pad = COVER_PAD) {
  const list = Array.isArray(world?.cover) ? world.cover : [];
  const boxes = (world?.colliders ?? []).filter(c => c && c.kind === 'cover' && !c.invisible && Array.isArray(c.min) && Array.isArray(c.max) && c.max[1] > 0.35);
  const missing = list.filter(c => {
    const at = Array.isArray(c) ? c : c?.at;
    if (!Array.isArray(at)) return true;
    const x = at[0], z = at[2];
    return !boxes.some(b => x >= b.min[0] - pad && x <= b.max[0] + pad && z >= b.min[2] - pad && z <= b.max[2] + pad);
  });
  return { listed: list.length, standing: list.length - missing.length, missing: missing.map(c => ({ piece: c?.piece ?? 'cover', at: Array.isArray(c) ? c : c?.at ?? null })) };
}

/** Check 17's problems the kit's lint cannot see (the lint's shape, so verify lists them with its own). */
export function forgeWorldProblems(world) {
  const out = [], c = listedCover(world);
  if (c.missing.length) {
    const where = c.missing.slice(0, 3).map(m => `${m.piece}${m.at ? ` at ${m.at[0]}, ${m.at[2]}` : ''}`).join('; ');
    out.push({ check: 17, rule: 'cover-standing', severity: 'error',
      message: `${c.missing.length} of the ${c.listed} pieces of cover the world lists are not in it: no cover collider stands where the list says (${where}${c.missing.length > 3 ? '; …' : ''}), so ${c.standing} piece${c.standing === 1 ? '' : 's'} of cover stand${c.standing === 1 ? 's' : ''}`,
      fix: 'put the cover back in config/world.json (its piece and its collider), or move cover there: an arena needs the cover its size asks for, standing' });
  }
  return out;
}
