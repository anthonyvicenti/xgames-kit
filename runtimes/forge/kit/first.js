// gf-forge: what a game needs before its menu, and what waits (wave 3, track M), vendored as gf/forge/first.js; pure
// (create imports it in Node for the loading bar's total).
//
// The first view is the arena behind a menu that works (research/rust-engine/PLAN.md §5: under 5 s on a phone). On a
// phone's link every megabyte before it is about a second, so only the arena is fetched before the menu. The rest
// comes in two steps once the menu is on screen, never by a player's leave:
//
//   first   what the first wave and the first shot need: the bodies of the enemies the first wave raises and what
//           they hold, the enemies' clip file, the weapon a player starts with, a kill's pieces and the coin. It
//           starts the moment the menu is drawn; the wave director waits for it (gf/forge/ai.js), so a first wave
//           never rises without its bodies, however fast Play is pressed
//   later   what later waves and rewards need: every other enemy's body (the boss among them) and what it holds, the
//           caster's orb when no caster is in the first wave, the weapons a card gives. After `first`
//
//   firstEnemyRows(tables)            the enemies-table rows the first wave raises (no waves: every row)
//   firstWeaponRows(tables)           the weapons-table rows a player starts with (none marked: the first)
//   tiers({tables, world, characters})   → { first: [file…], later: [file…] }: the files of each step (create's total
//                                     for the loading bar leaves both out; the same lists say what the boot fetches when)

/** The enemies-table rows (indices) the first wave raises, a boss's summons with it. No waves: every row. */
export function firstEnemyRows(tables) {
  const rows = Array.isArray(tables?.enemies) ? tables.enemies : [];
  const wave = (Array.isArray(tables?.waves) ? tables.waves : [])[0];
  if (!wave) return rows.map((_, i) => i);
  const ids = new Set((wave.enemies ?? []).map(g => g.type));
  // what a boss in the first wave calls up rises with it
  for (const r of rows) if (ids.has(r.id) && r.archetype === 'boss' && r.boss?.summon) ids.add(r.boss.summon);
  return rows.map((r, i) => (ids.has(r.id) ? i : -1)).filter(i => i >= 0);
}

/** The weapons-table rows (indices) a player holds when a round starts: every row not marked `start: false`. */
export function firstWeaponRows(tables) {
  const rows = Array.isArray(tables?.weapons) ? tables.weapons : [];
  const first = rows.map((r, i) => (r.start === false ? -1 : i)).filter(i => i >= 0);
  return first.length || !rows.length ? first : [0];
}

/** Whether the first wave casts (its orb is then part of `first`). */
export function firstWaveCasts(tables) {
  const rows = Array.isArray(tables?.enemies) ? tables.enemies : [];
  return firstEnemyRows(tables).some(i => rows[i]?.archetype === 'caster');
}

/**
 * The files of each step, from the game's configs: `world` (config/world.json: enemies.bodies[], .held[], .clips,
 * .orb) and `characters` (config/characters.json → forge: held, fp.arms, fight.debris, fight.coin, fight.target).
 * → { first, later } (game paths, each once; a file both steps name is `first`'s).
 */
export function tiers({ tables = {}, world = {}, characters = {} } = {}) {
  const E = world?.enemies ?? {}, C = characters?.forge ?? characters ?? {};
  const first = new Set(), later = new Set();
  const heldFile = slot => (E.held ?? []).find(h => h.slot === slot)?.file ?? null;
  const rows = new Set(firstEnemyRows(tables));
  for (const b of E.bodies ?? []) {
    const to = rows.has(b.row) ? first : later;
    if (b.file) to.add(b.file);
    for (const h of b.held ?? []) { const f = heldFile(h.slot); if (f) to.add(f); }
  }
  if ((E.bodies ?? []).length && E.clips?.file) first.add(E.clips.file);
  if (E.orb?.file) (firstWaveCasts(tables) ? first : later).add(E.orb.file);
  const weapons = Array.isArray(tables?.weapons) ? tables.weapons : [], start = new Set(firstWeaponRows(tables));
  weapons.forEach((w, i) => { const f = C.held?.[w.id]; if (f) (start.has(i) ? first : later).add(f); });
  if (typeof C.fp?.arms === 'string') first.add(C.fp.arms);
  for (const f of Object.values(C.fight?.debris ?? {})) if (typeof f === 'string') first.add(f);
  if (typeof C.fight?.coin === 'string') first.add(C.fight.coin);
  // a target dummy's body is asked for when one is raised (a test room): never before the menu
  if (typeof C.fight?.target === 'string') later.add(C.fight.target);
  for (const f of first) later.delete(f);
  return { first: [...first], later: [...later] };
}
