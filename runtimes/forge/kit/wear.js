// gf-forge's bodies and what a fight draws beside the world and the enemies (CONTRACT §8 forge "Live co-op"),
// vendored as gf/forge/wear.js; pure (create and the slot tools import it in Node). Everything is a slot (CONTRACT
// §2, R1–R5), from research/gf-forge/library as tracks C2 and C3 left it (catalog.json):
//
//   the bodies friends see   the four co-op hunters (catalog `player.coop.seats`), one per seat: seat 1 the hooded
//                            hunter, 2 the templar, 3 the rogue, 4 the witchfinder, each with its `player_tint` cloth
//                            in the player's colour; animated by the forge clip file
//   a weapon's model         one file a weapons row (catalog `weapon.*`: the Meshy pistol, shotgun, repeating rifle,
//                            hand axe and focus): in a friend's fist, in your own first-person hand, lying as a pickup
//   the first-person rig     catalog `fp.arms` (wave 2: fp/rig.glb, weapon-only framing: no arms are drawn; its
//                            socket_grip says how the weapon in hand is turned and how large), and each weapon's hold
//                            in camera space (FP_HOLD: large in the lower right, its grip below the screen's edge)
//   a kill's pieces          catalog `debris.*`: the grim skeletons' own bones (a skull, a ribcage, a thigh bone, an arm
//                            bone, a shard: cut from one Meshy flat lay), or what the game's own chaser's catalog role
//                            says its kind sheds (shedsFor: the risen townsfolk's head, torso and stained bones); a
//                            caster's missile likewise (thrownFor); a small gold coin (catalog `fight.coin`); a
//                            target dummy's body (the game's own chaser: targetBodyFor; the grim chaser by default)
//   the effect pictures      catalog `fx.*`: one picture a particle kind
// A game ships the library's small variant of a body or a weapon where there is one (catalog.json `small`).
//
//   config/characters.json → forge: { body, bodies: [file per seat], heights, fists: [[x, y, z] per seat], clips,
//                                     clipNames, tintMix, height, held: { <weapon id>: <file> },
//                                     weapons: { <id>: {hold, twoHanded, melee?, grip: {quaternion, scale}} },
//                                     fp: { arms }, fight: { debris: {skull, ribcage, bone, short, chip}, coin, coinSize,
//                                     target, targetClip, fx: { <kind>: <file> } } }
//   wearConfig(tables, catalog)   create's characters.forge block for a game's filled tables
//   wearFiles(tables, catalog)    the library files it names: [{to, from (a library path), scenic?}]
//   slotsFor(cfg)                 the slots: the seat colours (a player look), each seat's body, the clips, each
//                                 weapon's model, the arms, the pieces, the coin, the effect pictures
//   heldFileFor(row, catalog)     the library weapon a weapons-table row is drawn as

export const TINT = 'character.tint.player';
export const BODY = 'character.body.player';
export const CLIPS = 'character.clips.player';
export const ARMS = 'character.arms.player';
export const COIN = 'fight.coin';
export const TARGET = 'fight.target';
export const heldSlot = id => `character.held.${id}`;
/** The body slot of a seat (0-based): seat 0 keeps `character.body.player`. */
export const bodySlot = seat => (seat > 0 ? `${BODY}.${seat + 1}` : BODY);
export const debrisSlot = piece => `fight.debris.${piece}`;
export const fxSlot = kind => `fx.${kind}`;
export const SEATS = 4;

/** The library files when create passes no catalog (the same roles' files as catalog.json names them). */
export const LIBRARY_BODY = 'bodies/hunter-hooded.glb';
export const LIBRARY_SEATS = ['bodies/hunter-hooded.glb', 'bodies/hunter-templar.glb', 'bodies/hunter-rogue.glb', 'bodies/hunter-witchfinder.glb'];
export const LIBRARY_CLIPS = 'clips/forge-humanoid-1.glb';
export const BODY_FILE = 'assets/models/body-player.glb';
export const CLIPS_FILE = 'assets/clips/forge-humanoid-1.glb';
/** The clips the others' bodies play (catalog `player.coop.clips`). */
export const CLIP_NAMES = { idle: 'idle', walk: 'walk', run: 'run', jump: 'jump', fall: 'fall', death: 'death', shoot: 'shoot', melee: 'slash_1', hit: 'hit' };

// the library's weapon role by a row's preset, else its kind (catalog.json `weapon.*`)
const ROLE_BY_PRESET = { pistol: 'weapon.pistol', shotgun: 'weapon.shotgun', repeater: 'weapon.mg', blade: 'weapon.melee' };
const ROLE_BY_KIND = { hitscan: 'weapon.pistol', projectile: 'weapon.focus', melee: 'weapon.melee', beam: 'weapon.focus', charge: 'weapon.focus' };
const FILE_BY_ROLE = { 'weapon.pistol': 'weapons/hunter-pistol.glb', 'weapon.shotgun': 'weapons/hunter-shotgun.glb', 'weapon.mg': 'weapons/hunter-mg.glb', 'weapon.melee': 'weapons/hunter-axe.glb', 'weapon.focus': 'weapons/hunter-focus.glb' };
/** The particle kinds with a library picture (forge-render particles.rs KINDS; catalog `fx.*`). */
export const FX_KINDS = { smoke: 'fx/smoke.png', sparks: 'fx/spark.png', embers: 'fx/ember.png', dust: 'fx/dust.png', bone: 'fx/bone-chip.png', blood: 'fx/blood-mist.png', muzzle: 'fx/muzzle-flash.png', impact: 'fx/impact-ring.png', orb: 'fx/orb.png' };
/** A kill's pieces: the slot's piece → the library file, and the forge-feel piece types drawn with it (kills.rs
 *  `piece`: 0 skull, 1 ribcage, 2 bone, 3 short bone, 4 chip) with each one's longest side in metres. */
export const DEBRIS = {
  skull: { role: 'debris.skull', file: 'ruins/grim-skull.glb', types: [[0, 0.22]], label: 'skull', slotLabel: 'the head' },
  ribcage: { role: 'debris.ribcage', file: 'ruins/grim-ribcage.glb', types: [[1, 0.3]], label: 'ribcage', slotLabel: 'the chest' },
  bone: { role: 'debris.bone', file: 'ruins/grim-femur.glb', types: [[2, 0.3]], label: 'long bone', slotLabel: 'a long piece' },
  short: { role: 'debris.bone.short', file: 'ruins/grim-armbone.glb', types: [[3, 0.2]], label: 'short bone', slotLabel: 'a short piece' },
  chip: { role: 'debris.chip', file: 'ruins/grim-shard.glb', types: [[4, 0.085]], label: 'shard', slotLabel: 'a small piece' },
};
const COIN_FILE = 'world/coin.glb';           // the forge library's own (wave 2: a small gold coin that glows)
/** How large a coin is drawn (metres across): small and bright, as a coin is. */
export const COIN_SIZE = 0.11;
/** Where each weapon's grip sits in camera space with no arms drawn (the eye at the origin looking down −Z): large in
 *  the lower right, the grip under the screen's lower edge. The catalog's own hold (a weapon's `hold.arm_r`) comes
 *  first; these are for a create with no catalog, by the library's weapon role. */
export const FP_HOLD = { 'weapon.pistol': [0.165, -0.2, -0.3], 'weapon.shotgun': [0.19, -0.24, -0.27], 'weapon.mg': [0.18, -0.225, -0.3], 'weapon.melee': [0.2, -0.27, -0.33], 'weapon.focus': [0.17, -0.21, -0.3] };

const roleFile = (catalog, role) => catalog?.roles?.[role]?.file ?? null;

/** The library's weapon role a weapons-table row is drawn as. */
export const heldRoleFor = row => ROLE_BY_PRESET[row?.preset] ?? ROLE_BY_KIND[row?.kind] ?? 'weapon.pistol';
/** The library weapon (a path in research/gf-forge/library) a weapons-table row is drawn as. */
export function heldFileFor(row, catalog = null) {
  const role = heldRoleFor(row);
  return roleFile(catalog, role) ?? FILE_BY_ROLE[role];
}
/** The library file a game ships for `rel`: its small variant (catalog.json `small`: the same model, a smaller picture). */
const shipped = (catalog, rel) => catalog?.small?.[rel] ?? rel;

/** The seats' library bodies: [{file, height, fist: [x, y, z]}] (catalog `player.coop.seats`; `fist`: where a handle
 *  passes through the body's closed right fist, on its hand_r socket). */
function seatsOf(catalog) {
  const roles = catalog?.roles?.['player.coop']?.seats ?? [];
  const out = [];
  for (let i = 0; i < SEATS; i++) {
    const r = catalog?.roles?.[roles[i]] ?? null, file = r?.body ?? LIBRARY_SEATS[i];
    out.push({ file, height: r?.height ?? 1.78, fist: catalog?.sections?.bodies?.[file]?.fist?.hand_r ?? r?.held?.hand_r?.grip?.position ?? [0, -0.04, -0.01] });
  }
  return out;
}

/** The library body a target dummy stands as: the game's own first chaser (else its first enemy), so a game whose
 *  enemies are the risen townsfolk practises on one of them; the library's grim chaser when the tables name no enemy,
 *  or a body the catalog does not have. */
export function targetBodyFor(forge = {}, catalog = null) {
  const rows = (forge.enemies ?? []).filter(r => r && typeof r.body === 'string' && r.body);
  const row = rows.find(r => (r.archetype ?? 'chaser') === 'chaser') ?? rows[0] ?? null;
  const rel = row ? `bodies/${row.body}.glb` : null;
  if (rel && catalog?.sections?.bodies?.[rel]) return rel;
  return catalog?.roles?.['enemy.skeleton.chaser']?.body ?? 'bodies/skeleton-grim-chaser.glb';
}

/** Is the target dummy's body a free stand-in for a role whose own art this machine does not have? */
export function targetStandIn(forge = {}, catalog = null) {
  const rel = targetBodyFor(forge, catalog);
  return !!Object.entries(catalog?.roles ?? {}).find(([k, v]) => k.startsWith('enemy.') && v?.body === rel)?.[1]?.standIn;
}

/** What a kill breaks into, by piece ({skull, ribcage, bone, short, chip} → a library file), when the catalog role of the
 *  game's own chaser says so (`sheds`: the risen townsfolk shed a head, a chunk of torso and stained bones, not the
 *  skeletons' skulls and ribcages). {}: the library's bones. */
export function shedsFor(forge = {}, catalog = null) {
  const rel = targetBodyFor(forge, catalog);
  const role = Object.entries(catalog?.roles ?? {}).find(([k, v]) => k.startsWith('enemy.') && v?.body === rel)?.[1];
  return role?.sheds && typeof role.sheds === 'object' ? role.sheds : {};
}

/** What a game's caster throws, when its body's catalog role says so (`throws`: a library file; the zombie Spitter's gob
 *  of bile): the first row that throws decides (a caster, or a row with a ranged attack). null: the library's default
 *  (a skull). `bodies`: [{row, body}] as gf/forge/world.js resolved each row's body. */
export function thrownFor(rows = [], bodies = [], catalog = null) {
  for (const b of bodies) {
    const r = rows[b.row] ?? {};
    if (!((r.archetype ?? 'chaser') === 'caster' || (r.ranged?.range ?? 0) > 0)) continue;
    const role = Object.entries(catalog?.roles ?? {}).find(([k, v]) => k.startsWith('enemy.') && v?.body === `bodies/${b.body}.glb`)?.[1];
    if (typeof role?.throws === 'string') return role.throws;
  }
  return null;
}

/** A weapon file's first-person hold (where the arms' right grip sits in camera space) and whether two hands hold it. */
function holdOf(catalog, file, role = null) {
  const s = catalog?.sections?.weapons?.[file] ?? null;
  return { hold: s?.hold?.arm_r ?? FP_HOLD[role] ?? [0.165, -0.2, -0.3], twoHanded: s?.hands === 2, ...(s?.weapon === 'melee' ? { melee: true } : {}),
    // in a friend's fist (third person): the weapon's own turn and scale on a body's hand_r; its place is the body's fist
    grip: { quaternion: s?.grip?.quaternion ?? [0, 0, -0.7071, 0.7071], scale: s?.grip?.scale ?? 1.15 } };
}

/** config/characters.json → forge for a game whose filled tables are `forge` (create). */
export function wearConfig(forge = {}, catalog = null) {
  const seats = seatsOf(catalog);
  const held = {}, weapons = {};
  for (const w of forge.weapons ?? []) if (w?.id) { held[w.id] = `assets/models/held-${w.id}.glb`; weapons[w.id] = holdOf(catalog, heldFileFor(w, catalog), heldRoleFor(w)); }
  const fights = (forge.weapons ?? []).length > 0;
  return {
    body: BODY_FILE, bodies: seats.map((_, i) => (i ? `assets/models/body-player-${i + 1}.glb` : BODY_FILE)), heights: seats.map(s => s.height), fists: seats.map(s => s.fist),
    clips: CLIPS_FILE, height: seats[0].height, tintMix: 0.9, clipNames: { ...CLIP_NAMES }, held, weapons,
    // the first-person layer and a fight's pieces: only in a game with weapons
    ...(fights ? {
      fp: { arms: 'assets/models/fp-arms.glb' },
      fight: { debris: Object.fromEntries(Object.keys(DEBRIS).map(k => [k, `assets/models/debris-${k}.glb`])), coin: 'assets/models/coin.glb', coinSize: COIN_SIZE, target: 'assets/models/target.glb', targetClip: 'idle_combat',
        // a free stand-in body (tools/stand-ins.mjs) keeps the dummy's own hit regions: shots never landed on a stand-in
        // whose regions rode its bones (measure 16's staged target, 2026-10-13)
        ...(targetStandIn(forge, catalog) ? { targetHurt: false } : {}),
        fx: Object.fromEntries(Object.keys(FX_KINDS).map(k => [k, `assets/fx/${k}.png`])) },
    } : {}),
  };
}

/** The library files `wearConfig` names: [{to, from, scenic}] (from: a path in research/gf-forge/library, or in
 *  research/gf-scenic/library when `scenic`). */
export function wearFiles(forge = {}, catalog = null) {
  const cfg = wearConfig(forge, catalog), seats = seatsOf(catalog), out = [];
  cfg.bodies.forEach((to, i) => out.push({ to, from: shipped(catalog, seats[i].file), what: `the body friends see in seat ${i + 1}` }));
  out.push({ to: cfg.clips, from: roleFile(catalog, 'clips.humanoid') ?? LIBRARY_CLIPS, what: 'the players\' animations' });
  for (const w of forge.weapons ?? []) if (w?.id) out.push({ to: cfg.held[w.id], from: shipped(catalog, heldFileFor(w, catalog)), what: `the ${w.id}` });
  if (cfg.fp) {
    out.push({ to: cfg.fp.arms, from: roleFile(catalog, 'fp.arms') ?? 'fp/rig.glb', what: 'the first-person rig (weapon-only framing)' });
    const sheds = shedsFor(forge, catalog);
    for (const [k, d] of Object.entries(DEBRIS)) out.push({ to: cfg.fight.debris[k], from: (typeof sheds[k] === 'string' ? sheds[k] : null) ?? roleFile(catalog, d.role) ?? d.file, what: `a kill's ${d.label} pieces` });
    out.push({ to: cfg.fight.coin, from: roleFile(catalog, 'fight.coin') ?? COIN_FILE, what: 'a coin' });
    out.push({ to: cfg.fight.target, from: shipped(catalog, targetBodyFor(forge, catalog)), what: 'a target dummy' });
    for (const [k, f] of Object.entries(FX_KINDS)) out.push({ to: cfg.fight.fx[k], from: f, what: `the ${k} effect's picture` });
  }
  return out;
}

const SEAT_LABEL = ['hooded hunter', 'templar', 'rogue', 'witchfinder'];

/** The character slots of a forge game (CONTRACT §2.2). */
export function slotsFor(cfg) {
  const ch = cfg?.characters ?? {}, f = ch.forge ?? null, out = [];
  if (Array.isArray(ch.palette)) out.push({ id: TINT, group: 'characters', label: 'Player colours (one per seat)', type: 'colors', scope: 'player', source: { file: 'config/characters.json', pointer: '/palette' }, constraints: { min: 1, max: 8 }, tier: 'main', facet: 'look', rank: 90,
    description: 'Each player\'s colour: the cloth of the body friends see, their name on the HUD and in the friends room' });
  if (!f) return out;
  const bodies = Array.isArray(f.bodies) && f.bodies.length ? f.bodies : [f.body ?? BODY_FILE];
  bodies.forEach((file, i) => out.push({ id: bodySlot(i), group: 'characters', label: i ? `Player body, seat ${i + 1} (${SEAT_LABEL[i] ?? 'hunter'})` : 'Player body (what friends see)', type: 'model', source: { file }, constraints: { maxBytes: 8388608, rig: 'gf-humanoid-1' }, tier: i ? 'advanced' : 'main', facet: 'look', rank: i ? 60 - i : 88,
    description: `The body other players see ${i ? `the player in seat ${i + 1}` : 'you'} as (first person: never on your own screen). A gf-humanoid-1 body; its player_tint (or tint_*) material takes the player's colour`,
    generate: { prompt: `a ${SEAT_LABEL[i] ?? 'monster hunter'} in dark leather and cloth, game character, full body`, style: 'stylised, hand-painted, dark fantasy' } }));
  out.push({ id: CLIPS, group: 'characters', label: 'Player animations', type: 'model', source: { file: f.clips ?? CLIPS_FILE }, constraints: { maxBytes: 8388608, animations: Object.values(f.clipNames ?? CLIP_NAMES) }, tier: 'advanced', facet: 'look', rank: 20, editable: false,
    description: 'The gf-humanoid-1 clips the others\' bodies play (idle, walk, run, jump, fall, death)' });
  for (const [id, file] of Object.entries(f.held ?? {})) out.push({ id: heldSlot(id), group: 'characters', label: `Weapon: ${id}`, type: 'model', source: { file }, constraints: { maxBytes: 4194304 }, tier: 'main', facet: 'look', rank: 70,
    description: `The ${id}: in your first-person hand, in a friend's fist, and lying where it can be picked up (origin at the grip, +Z where it points; socket_muzzle or socket_tip; a hidden flash_muzzle node shows for a shot)` });
  if (f.fp?.arms) out.push({ id: ARMS, group: 'characters', label: 'First-person rig (hands)', type: 'model', source: { file: f.fp.arms }, constraints: { maxBytes: 4194304 }, tier: 'advanced', facet: 'look', rank: 42,
    description: 'How the weapon in hand is framed, and your hands if a file draws any (camera space: arm_r with socket_grip, arm_l with socket_grip_l; a tint_sleeve material takes your colour). The default draws no arms: the weapon alone, large in the lower right' });
  for (const [k, file] of Object.entries(f.fight?.debris ?? {})) out.push({ id: debrisSlot(k), group: 'models', label: `Kill debris: ${DEBRIS[k]?.slotLabel ?? DEBRIS[k]?.label ?? k}`, type: 'model', source: { file }, constraints: { maxBytes: 1048576 }, tier: 'advanced', facet: 'look', rank: 22,
    description: `A piece a kill bursts into (${DEBRIS[k]?.label ?? k}); keep it under a few hundred triangles: hundreds lie on the ground` });
  if (f.fight?.coin) out.push({ id: COIN, group: 'models', label: 'Coin', type: 'model', source: { file: f.fight.coin }, constraints: { maxBytes: 1048576 }, tier: 'advanced', facet: 'look', rank: 21, description: 'The coin that flies to whoever made a kill (drawn small; a glow_gold material glows)' });
  if (Number.isFinite(f.fight?.coinSize)) out.push({ id: `${COIN}.size`, group: 'models', label: 'Coin size', type: 'number', source: { file: 'config/characters.json', pointer: '/forge/fight/coinSize' }, constraints: { min: 0.04, max: 0.5, unit: 'm' }, tier: 'advanced', facet: 'look', rank: 20, description: 'How large a coin is drawn (metres across)' });
  if (f.fight?.target) out.push({ id: TARGET, group: 'models', label: 'Target dummy', type: 'model', source: { file: f.fight.target }, constraints: { maxBytes: 8388608, rig: 'gf-humanoid-1' }, tier: 'advanced', facet: 'look', rank: 23,
    description: 'The body a target dummy stands as (forge-feel\'s dummies: a test room, the staged hit of verify check 16)' });
  for (const [k, file] of Object.entries(f.fight?.fx ?? {})) out.push({ id: fxSlot(k), group: 'look', label: `Effect picture: ${k}`, type: 'image', source: { file }, constraints: { maxBytes: 262144 }, tier: 'advanced', facet: 'look', rank: 10,
    description: `The picture every ${k} particle is drawn with (white is tinted by look.particles.${k}.color)` });
  return out;
}
