// A style target's looks (looks wave 2, 2026-10-14): the references of one game often span very different levels (a
// desert, a sky level, a night level, a fortress at dusk), and one averaged target matches none of them. target.mjs
// groups the frames into looks (the reader's levels, each measured from its own frames: measureLooks); this file turns
// one look into a whole target, and the looks into the per-level look values a game switches between.
//
//   targetOfLook(target, id)      → the target as that look (its palette, sky, light and place), `level` naming it
//   levelValues(target, values)   → {level, levels: {id: look values}} for config/look.json (values(t) maps a target)
//
// A game takes one look per level or round (config/look.json levels; the three runtime's look.level(id) restyles to it
// live), or the pitch offers them as options (pitch.mjs readings).

/**
 * One look of a target as a whole target: the look's palette, regions, edges and reads in place of the whole set's, its
 * lighting and world over the whole set's; its frames are the ones a judge holds it to. → a target (no `looks`), or the
 * target itself when it has no such look.
 */
export function targetOfLook(t, id) {
  const L = t?.looks?.find(x => x.id === id);
  if (!L) return t;
  const { looks, ...rest } = t;
  const out = structuredClone(rest);
  for (const k of ['palette', 'regions', 'edges']) if (L[k]) out[k] = structuredClone(L[k]);
  if (L.lighting) out.lighting = { ...(out.lighting ?? {}), ...structuredClone(L.lighting) };
  if (L.world) out.world = { ...(out.world ?? {}), ...structuredClone(L.world), ...(L.world.sky ? { sky: { ...(out.world?.sky ?? {}), ...L.world.sky } } : {}) };
  if (L.reads?.length) out.reads = [...L.reads, ...out.reads.filter(r => !L.reads.includes(r))].slice(0, 6);
  out.level = { id: L.id, name: L.name, frames: L.frames, ...(L.setting ? { setting: L.setting } : {}) };
  return out;
}

/**
 * The per-level look values of a target with looks: each look as a target, mapped by `values` (apply.mjs: the
 * runtime's look values of a target). → {level (the one the game starts in: the target's own level, else the biggest),
 * levels: {id: values}} or null when the target has fewer than two looks.
 */
export function levelValues(t, values) {
  if (!(t?.looks?.length >= 2)) return null;
  const levels = Object.fromEntries(t.looks.map(L => [L.id, values(targetOfLook(t, L.id))]));
  const first = t.level?.id && levels[t.level.id] ? t.level.id : [...t.looks].sort((a, b) => (b.share ?? 0) - (a.share ?? 0))[0].id;
  return { level: first, levels };
}

/**
 * Framings with the kind of place each camera stands in (`where`, the look judge's place requests: a world answers
 * ctx.world.lookout(where)), where none is given: a play or close framing stands at a seat, a scene framing on a sunlit
 * rise (over an open sea view when the horizon is the sea), a night frame outdoors at night; a map or UI framing has
 * no place. → new framings
 */
export function wherePlaces(framings = [], world = null) {
  return framings.map(f => {
    if (f.where) return f;
    const where = f.frame === 'gameplay' || f.frame === 'character' ? 'seat'
      : f.frame === 'scene' ? (world?.horizon === 'sea' ? 'sea-view' : 'day')
      : f.frame === 'terrain' && f.pitch < 50 ? 'day' : null;
    return where ? { ...f, where } : f;
  });
}
