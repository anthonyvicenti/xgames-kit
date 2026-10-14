// The forge library's stand-ins: what create draws when a role's own files are not in this checkout.
//
// The forge catalog (library/catalog.json) names a role's preferred files: some of them are models made with a paid
// generator, which this kit does not ship. Every such role has a free stand-in here: a KayKit or Quaternius model
// (CC0) the library already carries, or one of the library's own code-made pieces. A role with no stand-in (a card's
// picture, the first-person hands) is left out, and the kit draws without it (no picture on the card, the weapon with
// no hands).
//
//   const r = standIns(catalog, licences, rel => existsSync(join(LIBRARY, rel)));
//   r.catalog    the catalog with every missing role resolved: the stand-in role's fields under the role's own name,
//                its own file names kept (so every lookup by name still works), and each section entry and licence
//                record of a missing file read from its stand-in's
//   r.licences   LICENSES.json → files, with a record for each missing file: the stand-in's licence, author and source
//   r.alias      Map(missing file → the stand-in file create copies)
//   r.report     {resolved: {role: stand-in role}, dropped: [role]}
//
// Pure: no file is read here. The data is STAND_INS below; the rule for a role with none listed: its own spare
// sibling (`<role>.kaykit`, `<role>.quaternius`, `<role>.code`), when that one's files are here.

/** A role → its stand-in role, for the roles with no spare sibling of their own. null: none (the role is left out). */
export const STAND_INS = {
  'player.coop': 'player.coop.kaykit',
  'player.coop.hooded': 'player.coop.kaykit',
  'player.coop.templar': 'player.coop.knight',
  'player.coop.rogue': 'player.coop.kaykit',
  'player.coop.witchfinder': 'player.coop.knight',
  'enemy.zombie.chaser': 'enemy.skeleton.chaser.kaykit',
  'enemy.zombie.runner': 'enemy.skeleton.skirmisher',
  'enemy.zombie.ranged': 'enemy.skeleton.ranged.kaykit',
  'enemy.zombie.shield': 'enemy.skeleton.shield.kaykit',
  'enemy.zombie.brute': 'enemy.skeleton.brute.kaykit',
  'enemy.zombie.boss': 'enemy.skeleton.boss.kaykit',
  'held.town.cleaver': 'held.axe',
  'held.town.cudgel': 'held.blade.kaykit',
  'held.town.door': 'held.shield.kaykit',
  'held.town.mace': 'held.axe',
  'held.town.pole': 'held.staff.kaykit',
  'debris.skull': 'ruins.skull.kaykit',
  'debris.ribcage': 'ruins.ribcage.kaykit',
  'debris.bone': 'ruins.bones.kaykit',
  'debris.bone.short': 'ruins.bones.kaykit.b',
  'debris.chip': 'ruins.bones.kaykit.c',
  'debris.zombie.skull': 'ruins.skull.kaykit',
  'debris.zombie.ribcage': 'ruins.ribcage.kaykit',
  'debris.zombie.bone': 'ruins.bones.kaykit',
  'debris.zombie.bone.short': 'ruins.bones.kaykit.b',
  'debris.zombie.chip': 'ruins.bones.kaykit.c',
  'weapon.melee': 'weapon.melee.quaternius',
  'weapon.focus': 'weapon.focus.kaykit',
  'weapon.wand': 'weapon.wand.kaykit',
  'ruins.brazier.tall': 'ruins.brazier.code',
  'ruins.tree.yew': 'ruins.tree.dead.large.kaykit',
  'ruins.tree.oak': 'ruins.tree.dead.large.kaykit',
  'ruins.gibbet': 'ruins.lantern.post.kaykit',
  'ruins.banner': 'ruins.lantern',
  'ruins.statue': 'ruins.shrine',
  'ruins.column': 'ruins.pillar.broken',
  'ruins.coffin': 'ruins.grave.slab',
  'ruins.bones.pile': 'ruins.bones.kaykit',
  'ruins.jaw': 'ruins.bones.kaykit.b',
  'ruins.pelvis': 'ruins.bones.kaykit.c',
  'ruins.scapula': 'ruins.bones.kaykit.b',
  'ruins.reliquary': null,
  // a spec's "chest" with no forge piece of its own is the scenic library's KayKit chest (world.js arenaConfig)
  'prop.chest': null,
  'prop.pump': 'town.trough',
  'town.pump': 'town.trough',
  'town.lamp.gas': 'ruins.lantern.post.kaykit',
  'town.cart': 'town.stall',
};
const SIBLINGS = ['kaykit', 'quaternius', 'code'];

/** The files a role draws from: its model or body, and what its hands hold. */
export function roleFiles(role) {
  if (!role || typeof role !== 'object') return [];
  const out = [];
  for (const k of ['file', 'body']) if (typeof role[k] === 'string') out.push(role[k]);
  for (const h of Object.values(role.held ?? {})) if (typeof h?.file === 'string') out.push(h.file);
  return out;
}

/**
 * Resolve a catalog's missing roles to their stand-ins. catalog: library/catalog.json; licences: LICENSES.json →
 * files; has(rel): whether the library holds the file. → {catalog, licences, alias, report}
 */
export function standIns(catalog, licences = {}, has = () => true, table = STAND_INS) {
  const small = { ...(catalog.small ?? {}) };
  // a small variant the library does not hold is no variant: the file is its full one (or its stand-in's)
  for (const [rel, s] of Object.entries(small)) if (!has(s)) delete small[rel];
  const shipped = rel => small[rel] ?? rel;
  // a model, picture or sound needs its licence record too; a list (sounds/sounds.json) only needs to be there
  const here = rel => has(shipped(rel)) && (!!licences[shipped(rel)] || !/\.(glb|gltf|png|jpe?g|webp|ogg|mp3|wav)$/i.test(rel));
  // a role's art must be here; a list a role names (sounds/sounds.json) is the kit's own, not art
  const ART = /\.(glb|gltf|png|jpe?g|webp|ogg|mp3|wav)$/i;
  const present = role => { const f = roleFiles(role); return f.length > 0 && f.filter(x => ART.test(x)).every(here); };
  const roles = catalog.roles ?? {}, out = {}, resolved = {}, dropped = [], alias = new Map();
  const standInOf = name => {
    const listed = Object.hasOwn(table, name) ? [table[name]] : [];
    for (const c of [...listed, ...SIBLINGS.map(s => `${name}.${s}`)]) if (c && present(roles[c])) return c;
    return null;
  };
  for (const [name, role] of Object.entries(roles)) {
    if (!roleFiles(role).some(x => ART.test(x)) || present(role)) { out[name] = role; continue; }
    const s = standInOf(name);
    if (!s) { dropped.push(name); continue; }
    const spare = roles[s];
    // the stand-in's fields under this role's own file names, so whatever looks the role up by name or by file finds it
    const r = { ...spare, standIn: s };
    delete r.spare;
    for (const k of ['file', 'body']) if (typeof role[k] === 'string' && typeof spare[k] === 'string') { r[k] = role[k]; if (!here(role[k])) alias.set(role[k], shipped(spare[k])); }
    // a role that lists others (player.coop → its seats) keeps the list
    if (Array.isArray(role.seats)) r.seats = role.seats;
    out[name] = r;
    resolved[name] = s;
  }
  // the original names the catalog's sections, the licences and the copies are read by
  const sections = {};
  for (const [sec, files] of Object.entries(catalog.sections ?? {})) {
    sections[sec] = { ...files };
    for (const [from, to] of alias) if (files[to] && !files[from]) sections[sec][from] = { ...files[to], standIn: to };
  }
  const lic = { ...licences };
  for (const [from, to] of alias) if (licences[to]) lic[from] = { ...licences[to], standIn: to, title: `a stand-in for ${from}: ${licences[to].title ?? to}` };
  return { catalog: { ...catalog, roles: out, small, sections }, licences: lic, alias, report: { resolved, dropped } };
}
