// gf-three character (track C, CONTRACT §4.4): any gf-humanoid-1 body plays the shared clips, with locomotion
// blending, an upper-body layer, sockets, tint, a nameplate, and a Rapier ragdoll that gets back up.
//
//   const c = await spawnCharacter(ctx, { player, bodySlot: 'character.body.player', tint: '#ff7ab0', height: 1.7 });
//   scene.add(c.object3d);
//   every frame: c.locomotion(speed, grounded, vy); c.update(dt);
//   c.play('emote_wave')  c.play('aim', { loop: true })  c.stop('aim')  c.knock({x, y, z})  c.ragdoll(true|false)
//   c.ragdoll(false, { upSeconds })   get up at once, taking upSeconds (fair play F1; else once the ragdoll settles)
//   c.recover()   stand at once where object3d is (a respawn)   c.glow('#bff4ff', 0.4)   c.glow(null)   (protection shimmer)
//   c.socket('hand_r').add(item)  c.setTint('#47c')  c.nameplate('Ada', '#47c')  c.dispose()
//
// Bodies are GLB slots (any file that passes tools/rig-check.mjs); the clips come from the `character.clips` slot
// (library/clips/gf-humanoid-1.glb) and drive a hidden standard skeleton, which rig.js maps onto each body.
// A role whose archetype is not humanoid (config/characters.json → roles.<role>.archetype: worm, blob, quadruped,
// flyer; CREATURES.md) is a creature: creature.js poses it by procedural motion from the same words, with the same
// members, so nothing that drives a character needs to know.
// No DOM is touched at import (slot declarations are read in Node).
import * as THREE from 'three';
import * as rig from './rig.js';
import { createRagdoll, GROUPS } from './ragdoll.js';
import { physicsOf } from '../core/util.js';
import { RIG_OF, isCreature, archetypeOfModel } from './archetypes.js';
import { spawnCreature } from './creature.js';

export { CLIPS, RIG } from './rig.js';
export { GROUPS } from './ragdoll.js';
export { ARCHETYPES, RIG_OF, STANDARDS } from './archetypes.js';

// ------------------------------------------------------------------ slot declarations (CONTRACT §2.2)
const C = 'config/characters.json';
const human = r => (r === 'player' ? 'Player' : r.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase()));
/** Slots for every role in config/characters.json, plus the shared clip file. */
export function slotsFor(cfg = {}) {
  const roles = cfg.characters?.roles ?? { player: { body: 'assets/models/body-player.glb' } };
  const out = [];
  let humans = false;
  for (const [role, r] of Object.entries(roles)) {
    // the player role's body, hat and tint are player looks (CONTRACT §6e): each player's loadout may replace them
    const look = role === 'player' ? { scope: 'player' } : {};
    const arch = isCreature(r.archetype) ? r.archetype : 'humanoid';
    if (arch === 'humanoid') humans = true;
    const standard = RIG_OF[arch];
    const bodySlot = (id, file, pointer, label, rank, describe) => ({
      id, group: 'characters', label, type: 'model',
      source: { file, pathRef: { file: C, pointer } },
      constraints: arch === 'humanoid' ? { rigged: true, rig: rig.RIG, animations: rig.CLIPS, maxBytes: 6000000, scale: 1 }
        : { rigged: true, rig: standard, archetype: arch, maxBytes: 6000000, scale: 1 },
      tier: 'main', facet: 'look', rank, ...look,
      description: describe ?? (arch === 'humanoid' ? 'The body every player of this role wears. Any GLB that passes rig-check (gf-humanoid-1) works; the clips are shared.'
        : `The body every player of this role wears: a ${arch} on ${standard} (CREATURES.md). Any GLB that passes rig-check for ${standard} works (gamesfun art autorig <mesh.glb> --archetype ${arch} rigs a plain mesh); it moves by procedural motion, no clips.`),
      generate: arch === 'humanoid' ? { tool: 'research/gf-three/tools/meshy-character.mjs', prompt: r.describe ?? 'a friendly party-game character', style: 'full-body stylised game character, A-pose, front view' }
        : { tool: 'gamesfun art generate', archetype: arch, prompt: r.describe ?? `a friendly ${arch} creature`, style: 'a whole stylised game creature, neutral standing pose, three-quarter view' },
      ...(r.license ? { license: r.license } : {}),
    });
    out.push(bodySlot(`character.body.${role}`, r.body ?? `assets/models/body-${role}.glb`, `/roles/${role}/body`, `${human(role)} character`, 98, r.describe));
    // a body per seat (roles.<role>.seats: [{body, height, describe}]): seat 2 wears the first, and so on round
    for (const [i, x] of (Array.isArray(r.seats) ? r.seats : []).entries()) {
      const seat = typeof x === 'string' ? { body: x } : x ?? {};
      out.push(bodySlot(`character.body.${role}.seat${i + 2}`, seat.body ?? `assets/models/body-${role}-seat${i + 2}.glb`, `/roles/${role}/seats/${i}${typeof x === 'string' ? '' : '/body'}`, `${human(role)} character (seat ${i + 2})`, 97 - i, seat.describe ?? r.describe));
    }
    // seat colours live in config/characters.json → palette unless the look's palette owns them (look.palette.players)
    if (Array.isArray(cfg.characters?.palette) || !cfg.characters) out.push({ id: `character.tint.${role}`, group: 'characters', label: role === 'player' ? 'Player colours (one per seat)' : `${human(role)} colours`, type: 'colors',
      source: { file: C, pointer: '/palette' }, constraints: { min: 1, max: 8 }, tier: 'main', facet: 'look', rank: 90, ...look,
      description: 'Each player\'s body tint (materials named tint_*), ring and nameplate colour' });
    if (typeof r.height === 'number') out.push({ id: `character.height.${role}`, group: 'characters', label: `${human(role)} height`, type: 'number',
      source: { file: C, pointer: `/roles/${role}/height` }, constraints: arch === 'humanoid' ? { min: 0.5, max: 3, unit: 'm' } : { min: 0.1, max: 6, unit: 'm' }, tier: 'advanced', facet: 'gameplay', rank: 21 });
    if (r.hat) out.push({ id: `character.hat.${role}`, group: 'characters', label: `${human(role)} hat`, type: 'model', optional: true,
      source: { file: r.hat, pathRef: { file: C, pointer: `/roles/${role}/hat` } }, constraints: { maxBytes: 2000000, scale: 1 },
      tier: 'main', facet: 'look', rank: 84, ...look, description: 'Worn on the head socket; its origin sits on top of the head, +Z forward' });
    // a game without a player hat still has the slot, so a player's own hat (a loadout) has somewhere to go
    else if (role === 'player') out.push({ id: 'character.hat.player', group: 'characters', label: 'Player hat (players\' own)', type: 'model', optional: true,
      source: { file: 'assets/models/hat-player.glb' }, constraints: { maxBytes: 2000000, scale: 1 }, tier: 'advanced', facet: 'look', rank: 12, scope: 'player',
      editable: false, readonlyReason: 'This game gives its players no hat; a player who owns one (a loadout item) wears it on the head socket',
      description: 'Worn on the head socket; its origin sits on top of the head, +Z forward' });
  }
  // the shared clips, when a role is humanoid (a game of creatures only plays none)
  if (humans) out.push({ id: 'character.clips', group: 'characters', label: 'Character animations', type: 'model', source: { file: 'assets/clips/gf-humanoid-1.glb' },
    constraints: { rig: rig.RIG, animations: rig.CLIPS }, tier: 'advanced', facet: 'look', rank: 6, editable: false,
    readonlyReason: 'The shared gf-humanoid-1 clips every body plays; replaced as part of the character standard',
    license: { spdx: 'CC0-1.0', author: 'Quaternius (Universal Animation Library), retargeted and extended by games.fun', url: 'https://quaternius.itch.io/universal-animation-library' } });
  return out;
}
export const slots = slotsFor();

// ------------------------------------------------------------------ the shared clips (one load per assets + slot)
const CLIPSETS = new WeakMap();
function clipsSlotOf(ctx, wanted) {
  if (wanted) return wanted;
  if (ctx.assets.has?.('character.clips')) return 'character.clips';
  const any = ctx.assets.ids?.('character.clips') ?? [];
  if (any.length) return any[0];
  throw new Error('gf-three character: no character.clips slot in assets.json (assets/clips/gf-humanoid-1.glb)');
}
async function clipSet(ctx, slot) {
  let per = CLIPSETS.get(ctx.assets);
  if (!per) CLIPSETS.set(ctx.assets, (per = new Map()));
  if (!per.has(slot)) per.set(slot, (async () => {
    const tree = await ctx.assets.model(slot);
    const std = rig.standardFrom(tree);
    const meta = tree.getObjectByName('gf_humanoid_1')?.userData?.gfClips ?? {};
    const clips = new Map((tree.animations ?? []).map(a => [a.name, a]));
    const missing = rig.CLIPS.filter(n => !clips.has(n));
    if (missing.length) throw new Error(`gf-three character: clip file lacks ${missing.join(', ')}`);
    return { tree, std, meta, clips };
  })());
  return per.get(slot).catch(e => { per.delete(slot); throw e; });
}

// ------------------------------------------------------------------ per-body measurements (cached per geometry)
const BODYINFO = new Map();
const smooth = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const TINT = /^tint/i;

function measureBody(model, found, rt) {
  const key = found.skinned.map(m => m.geometry.uuid).join();
  if (BODYINFO.has(key)) return BODYINFO.get(key);
  const has = n => found.bones.has(n);
  const torso = ['Spine01', 'Spine02', 'Spine'].find(has);
  const partOf = new Map();               // bone object → part name, by walking up to a part's main bone
  const mains = { pelvis: 'Hips', torso, head: 'Head', upperarm_l: 'LeftArm', forearm_l: 'LeftForeArm', upperarm_r: 'RightArm', forearm_r: 'RightForeArm',
    thigh_l: 'LeftUpLeg', shin_l: 'LeftLeg', thigh_r: 'RightUpLeg', shin_r: 'RightLeg' };
  const byBone = new Map(Object.entries(mains).map(([p, n]) => [found.bones.get(n), p]));
  for (const m of found.skinned) for (const b of m.skeleton.bones) {
    if (partOf.has(b)) continue;
    let x = b; while (x && !byBone.has(x)) x = x.parent;
    partOf.set(b, x ? byBone.get(x) : 'pelvis');
  }
  const bp = rt.bind;
  const P = n => bp.pos.get(n);
  const headPts = [], backPts = [], dists = new Map(Object.keys(mains).map(p => [p, []]));
  const segs = {
    pelvis: [P('Hips'), P(torso)], torso: [P(torso), P(has('neck') ? 'neck' : 'Head')], head: [P('Head'), null],
    upperarm_l: [P('LeftArm'), P('LeftForeArm')], forearm_l: [P('LeftForeArm'), P('LeftHand')], upperarm_r: [P('RightArm'), P('RightForeArm')], forearm_r: [P('RightForeArm'), P('RightHand')],
    thigh_l: [P('LeftUpLeg'), P('LeftLeg')], shin_l: [P('LeftLeg'), P('LeftFoot')], thigh_r: [P('RightUpLeg'), P('RightLeg')], shin_r: [P('RightLeg'), P('RightFoot')],
  };
  const spineY = P('Spine').y, h = rt.height;
  const tmp = new THREE.Vector3(), ab = new THREE.Vector3();
  rig.bindBox(model, found, (v, mesh, i) => {
    const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    let best = 0, bw = -1; for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
    const part = partOf.get(mesh.skeleton.bones[best]) ?? 'pelvis';
    if (part === 'head') headPts.push(v.clone());
    if ((part === 'torso' || part === 'pelvis') && Math.abs(v.y - spineY) < 0.08 * h) backPts.push(v.z);
    const [a, b] = segs[part];
    if (b) { ab.copy(b).sub(a); const t = THREE.MathUtils.clamp(tmp.copy(v).sub(a).dot(ab) / ab.lengthSq(), 0, 1); dists.get(part).push(tmp.copy(a).addScaledVector(ab, t).distanceTo(v)); }
  }, bp.frames);
  const pct = (arr, q) => { if (!arr.length) return null; arr.sort((x, y) => x - y); return arr[Math.min(arr.length - 1, Math.floor(arr.length * q))]; };
  const headBox = new THREE.Box3().setFromPoints(headPts.length ? headPts : [P('Head')]);
  const headTop = new THREE.Vector3((headBox.min.x + headBox.max.x) / 2, headBox.max.y, (headBox.min.z + headBox.max.z) / 2);
  const headCenter = headBox.getCenter(new THREE.Vector3());
  const headR = Math.max(0.06, Math.min(headBox.max.x - headBox.min.x, headBox.max.y - headBox.min.y) * 0.45);
  const radii = {};
  for (const [p, arr] of dists) radii[p] = THREE.MathUtils.clamp(pct(arr, 0.7) ?? 0.05 * h, 0.02, 0.3 * h);
  radii.head = headR;
  const backZ = backPts.length ? Math.min(...backPts) : P('Spine').z - 0.1 * h;
  const info = { torso, mains, radii, headTop, headCenter, backZ, key };
  BODYINFO.set(key, info);
  return info;
}

/** The role a body slot belongs to: character.body.<role> or a seat's character.body.<role>.seat<n>. */
export const roleOfSlot = slot => (String(slot).startsWith('character.body.') ? String(slot).slice(15).replace(/\.seat\d+$/, '') : null);
/** A role's archetype from config/characters.json (null when it names none: humanoid, or the body file decides). */
export function archetypeOfRole(ctx, role) {
  try { const a = ctx.assets.config?.('characters')?.roles?.[role]?.archetype; return typeof a === 'string' ? a : null; } catch { return null; }
}
/**
 * Which slot and height a player of a role wears in a seat (0-based): seat 0 the role's body, seat n its seats[n-1]
 * (roles.<role>.seats), round again when there are more seats than bodies. → { bodySlot, height, role, archetype }
 */
export function bodyFor(cfg = {}, role = 'player', seat = 0) {
  const r = cfg.roles?.[role] ?? {}, seats = Array.isArray(r.seats) ? r.seats : [];
  const k = seats.length && Number.isInteger(seat) && seat > 0 ? seat % (seats.length + 1) : 0;
  const x = k ? (typeof seats[k - 1] === 'string' ? { body: seats[k - 1] } : seats[k - 1] ?? {}) : r;
  return { bodySlot: k ? `character.body.${role}.seat${k + 1}` : `character.body.${role}`, height: x.height ?? r.height ?? (isCreature(r.archetype) ? null : 1.7), role, archetype: r.archetype ?? 'humanoid' };
}

/** The game's hat for a role is worn when config/characters.json gives the role one (the slot is always declared for
 *  the player role, so a loadout's hat has somewhere to go, but the game's file may not exist). */
function roleHasHat(ctx, role) {
  try { const r = ctx.assets.config?.('characters')?.roles?.[role]; return r ? !!r.hat : !!ctx.assets.has?.(`character.hat.${role}`); }
  catch { return !!ctx.assets.has?.(`character.hat.${role}`); }
}
/** The hat a player wears: their own (a loadout) when it loads, else the game's (when the role has one), else none. */
export async function loadHat(ctx, role, player = null) {
  const A = ctx.assets, slot = `character.hat.${role}`;
  if (!role || !A.has?.(slot)) return null;
  if (player && A.ownFile?.(slot, player)) { const own = await A.model(slot, { player, ownOnly: true }); if (own) return own; }
  return roleHasHat(ctx, role) ? A.model(slot) : null;
}
/** The file a player's hat comes from (their own, the game's, or null): what loadHat would load. */
export function hatFileFor(ctx, role, player = null) {
  const A = ctx.assets, slot = `character.hat.${role}`;
  if (!role || !A.has?.(slot)) return null;
  return (player && A.ownFile?.(slot, player)) || (roleHasHat(ctx, role) ? A.slot?.(slot)?.source?.file ?? null : null);
}

// How far (radians, each way) a ragdoll's ball joints turn from the pose it was knocked in. A free neck spun the head
// round until it looked torn off the body; a free spine folded beans in half.
const SWING = { head: 0.35, torso: 0.4, upperarm: 1.1, thigh: 0.9 };

// ------------------------------------------------------------------ spawn
/**
 * opts: { player, bodySlot, tint, local, height (metres; scales the body to it), clipsSlot, plate: 'sprite' | null,
 *         onState(state, info) — 'ragdoll' | 'getup' {position, yaw} | 'up' }
 */
export async function spawnCharacter(ctx, opts = {}) {
  const { player = null, bodySlot = 'character.body.player', tint = player?.color ?? null, local = false, height = null, plate = null, onState = null } = opts;
  const A = ctx.assets;
  const role = roleOfSlot(bodySlot);
  // a creature (CREATURES.md): the role's archetype says so, or (no archetype written) the body file itself does
  const arch = archetypeOfRole(ctx, role) ?? (opts.archetype ?? null);
  if (isCreature(arch)) return spawnCreature(ctx, { ...opts, archetype: arch, role, loadHat });
  // no archetype written: the body file says (its gf_body extras); the model loaded to ask is the one worn
  let first = null;
  if (!arch) {
    first = await A.model(bodySlot).catch(() => null);
    const own = first && archetypeOfModel(first);
    if (isCreature(own)) return spawnCreature(ctx, { ...opts, archetype: own, role, loadHat, model: first });
  }
  const cs = await clipSet(ctx, clipsSlotOf(ctx, opts.clipsSlot));
  // Player looks (CONTRACT §6e): a player's own body (their loadout) when it loads, fits the slot's budget and is a
  // gf-humanoid-1 rig; anything else is dropped for that player (never fatal) and the game's body is used.
  const prepare = (model, file) => {
    if (!model) throw new Error(`gf-three character: body slot ${bodySlot} is empty`);
    const found = rig.findRig(model);
    if (!found.skinned.length) throw new Error(`gf-three character: ${bodySlot} is not rigged (run tools/rig-check.mjs)`);
    const missing = rig.REQUIRED.filter(n => !found.bones.has(n));
    if (missing.length && file) throw new Error(`not a gf-humanoid-1 body (no ${missing.slice(0, 3).join(', ')})`);
    // the look's house character material (jelly gloss, rim, subsurface: track L), before the tint clones below; names
    // are kept, so tint_* materials still take the tint. Without a look (stand-in, Node tests) the GLB's own materials stay.
    try { ctx.look?.adoptMaterials?.(model, 'character'); } catch (e) { console.warn(`gf-three character: house material for ${bodySlot}: ${e.message}`); }
    const rt = rig.createRetarget(model, cs.std, { rig: found });
    return { model, found, rt, info: measureBody(model, found, rt) };
  };
  const ownBody = player && A.ownFile ? A.ownFile(bodySlot, player) : null;
  let body = null;
  if (ownBody) {
    try { const m = await A.model(bodySlot, { player, ownOnly: true }); if (m) body = prepare(m, ownBody); }
    catch (e) { A.reject?.(player, bodySlot, e.message); }
  }
  body ??= prepare(first ?? await A.model(bodySlot), null);
  const { model, found, rt, info } = body;
  const bodyFile = model.userData?.gfFile ?? null;
  const k = rt.k;

  // object3d (placed by the controller) → offset (get-up drift) → holder (height scale, feet at 0) → model
  const object3d = new THREE.Group(); object3d.name = `character:${player?.id ?? bodySlot}`;
  const offset = new THREE.Group(); offset.name = 'gf_offset';
  const holder = new THREE.Group(); holder.name = 'gf_holder';
  const scale = height ? height / rt.height : 1;
  holder.scale.setScalar(scale);
  model.position.y = -rt.ground;
  holder.add(model); offset.add(holder); object3d.add(offset);
  object3d.userData.gfSlot = bodySlot;
  model.traverse(o => { if (o.isSkinnedMesh) o.frustumCulled = false; });

  // tint: materials named tint_* (or listed in the body root's gfTint) are cloned per character. gfTintMix (0–1, on the
  // body root's extras; default 1) is how far the colour moves toward the tint: 1 for beans, lower for detailed bodies.
  const bodyExtras = model.getObjectByName('gf_body')?.userData ?? {};
  const tintNames = new Set(bodyExtras.gfTint ?? []);
  const tintMix = typeof bodyExtras.gfTintMix === 'number' ? bodyExtras.gfTintMix : 1;
  const tinted = [];
  const cloned = new Map();
  let gameTint = null, lookTint = null;
  const paintTint = () => { const c = lookTint ?? gameTint; if (c == null) return; const t = new THREE.Color(c); for (const m of tinted) if (m.color) m.color.copy(m.userData.gfBase ?? m.color).lerp(t, tintMix); };
  model.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map(m => {
      if (!(TINT.test(m.name) || tintNames.has(m.name))) return m;
      if (!cloned.has(m)) { const c = m.clone(); c.userData.gfBase = c.color?.clone(); cloned.set(m, c); tinted.push(c); }
      return cloned.get(m);
    });
    o.material = Array.isArray(o.material) ? out : out[0];
  });

  // the world's light (CONTRACT §9: a world that lights its own cells offers world.lightAt(x, y, z) → { sky, ambient,
  // block: [r, g, b] }): every material of this body is its own and reads one pair of uniforms, set each frame from the
  // light where the body stands, so a body goes dark in a cave and takes a lamp's colour beside it. A world without
  // lightAt changes nothing (its bodies keep the materials they share).
  const worldU = typeof ctx.world?.lightAt === 'function' ? ctx.look?.worldLightUniforms?.() ?? null : null;
  const owned = [];
  const lightMaterials = root => root.traverse(o => {
    if (!o.isMesh || !worldU) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map(m => {
      if (!m) return m;
      let c = m;
      if (!tinted.includes(m) && !owned.includes(m)) { c = cloned.get(m) ?? m.clone(); cloned.set(m, c); if (!owned.includes(c)) owned.push(c); }
      ctx.look.setWorldLight(c, worldU);
      return c;
    });
    o.material = Array.isArray(o.material) ? out : out[0];
  });
  lightMaterials(model);
  const lit = { sky: 1, ambient: 1, r: 0, g: 0, b: 0, at: null };
  function sampleWorldLight(p, dt) {
    const L = ctx.world?.lightAt;
    if (!worldU || typeof L !== 'function') return;
    const h = (rt.height ?? 1.7) * scale;
    const w = L.call(ctx.world, p.x, p.y + h * 0.6, p.z);
    if (!w) return;
    // eased, so stepping into shade or past a lamp is a short fade, not a pop
    const k = lit.at === null ? 1 : 1 - Math.exp(-dt * 10);
    lit.at = true;
    lit.sky += (w.sky - lit.sky) * k; lit.ambient += ((w.ambient ?? 1) - lit.ambient) * k;
    lit.r += ((w.block?.[0] ?? 0) - lit.r) * k; lit.g += ((w.block?.[1] ?? 0) - lit.g) * k; lit.b += ((w.block?.[2] ?? 0) - lit.b) * k;
    worldU.uGfWorldLight.value.set(lit.sky, lit.ambient);
    worldU.uGfWorldBlock.value.set(lit.r, lit.g, lit.b);
  }

  // faces (RIG.md §3, gfFaces on the body root): an expression shows its own meshes and hides the neutral face's while it
  // lasts. Meshes are found by material name (house materials keep the names). A body without gfFaces has one face.
  const faces = {};
  for (const [name, f] of Object.entries(bodyExtras.gfFaces ?? {})) {
    const pick = names => { const out = []; model.traverse(o => { const m = Array.isArray(o.material) ? o.material[0] : o.material; if (o.isMesh && names?.includes(m?.name)) out.push(o); }); return out; };
    faces[name] = { show: pick(f.show), hide: pick(f.hide) };
    for (const o of faces[name].show) o.visible = false;
  }
  let face = null, faceWant = null, faceT = 0;
  const setFace = name => {
    if (name === face) return;
    if (face) { for (const o of faces[face].show) o.visible = false; for (const o of faces[face].hide) o.visible = true; }
    face = name && faces[name] ? name : null;
    if (face) { for (const o of faces[face].hide) o.visible = false; for (const o of faces[face].show) o.visible = true; }
  };

  // the standard skeleton: one copy for the base layer, one for the upper-body layer
  const makeProxy = () => {
    const root = cs.tree.clone(true);
    const bones = new Map(); root.traverse(o => { if (cs.std.bones.has(o.name) && !bones.has(o.name)) bones.set(o.name, o); });
    const mixer = new THREE.AnimationMixer(root);
    const acts = new Map();
    for (const [name, clip] of cs.clips) { const a = mixer.clipAction(clip); a.play(); a.setEffectiveWeight(0); a.timeScale = 0; acts.set(name, a); }
    return { root, bones, mixer, acts };
  };
  const base = makeProxy(), over = makeProxy();
  const meta = name => cs.meta[name] ?? {};
  const dur = name => cs.clips.get(name)?.duration ?? 1;
  const hasClip = name => cs.clips.has(name);

  // ---------------- sockets (RIG.md §5): frames aligned with the character at the standard rest pose
  const sockets = {};
  const bp = rt.bind;
  const mkSocket = (name, boneName, pointChar, restRot) => {
    const bone = found.bones.get(boneName);
    const s = new THREE.Object3D(); s.name = `socket_${name}`;
    const bindW = bp.bind.get(bone) ?? rig.relMatrix(bone, model);
    s.position.copy(pointChar.clone().applyMatrix4(bindW.clone().invert()));
    // at the standard rest the bone's world rotation is C = R·B; the socket wants `restRot` there
    s.quaternion.copy(rt.C.get(boneName).clone().invert().multiply(restRot));
    const bs = new THREE.Vector3(); bindW.decompose(new THREE.Vector3(), new THREE.Quaternion(), bs);
    s.scale.setScalar(1 / bs.x);
    bone.add(s); sockets[name] = s;
  };
  const fileSocket = n => model.getObjectByName(`socket_${n}`);
  const I = new THREE.Quaternion();
  if (!fileSocket('head')) mkSocket('head', 'Head', info.headTop, I); else sockets.head = fileSocket('head');
  if (!fileSocket('back')) mkSocket('back', 'Spine', new THREE.Vector3(0, bp.pos.get('Spine').y, info.backZ), I); else sockets.back = fileSocket('back');
  for (const [name, bone, sgn] of [['hand_r', 'RightHand', -1], ['hand_l', 'LeftHand', 1]]) {
    if (fileSocket(name)) { sockets[name] = fileSocket(name); continue; }
    const hand = bp.pos.get(bone), fore = bp.pos.get(sgn > 0 ? 'LeftForeArm' : 'RightForeArm');
    const dir = hand.clone().sub(fore).normalize();
    const mid = rig.BONE_NAMES.find(n => n === `${sgn > 0 ? 'Left' : 'Right'}HandMiddle1` && bp.pos.has(n));
    const reach = mid ? bp.pos.get(mid).distanceTo(hand) * 0.9 : fore.distanceTo(hand) * 0.3;
    // +Z along the (standard) hand, +Y up: a held item points where the hand points
    mkSocket(name, bone, hand.clone().addScaledVector(dir, reach), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sgn * Math.PI / 2));
  }

  // ---------------- state
  const S = {
    speed: 0, grounded: true, vy: 0, airT: 0, jumped: false, landT: 9, phase: 0, idleT: 0,
    action: null,          // { name, t, loop, rate, hold, fade, cancel }
    over: null,            // { name, t, loop, rate, w, target, fade }
    aimPitch: 0,
    mode: 'anim',          // 'anim' | 'ragdoll' | 'getup'
    weights: new Map(), fade: 0.15,
  };
  let rag = null, ragT = 0, wantUp = false, upIn = null, getup = null, plateSprite = null, plateInfo = { text: player?.name ?? '', color: tint ?? '#ffffff' };
  // vel: how fast object3d (the capsule, or a friend's pose) moves, so a ragdoll keeps the body's momentum. Only real
  // time steps (dt > 0) sample it, and a jump faster than TELEPORT m/s or longer than TELEPORT_M between two samples is a
  // placement (spawn, respawn, a get-up, a pose snapping in), not motion: it resets vel. Before this, spawnCharacter's
  // update(0) at the origin followed by the kit placing the body at its spawn point read as ~300 m/s, and a knock in
  // the next few frames launched the ragdoll hundreds of metres. What a ragdoll inherits is capped at MAX_CARRY.
  const lastPos = new THREE.Vector3(), vel = new THREE.Vector3(), _step = new THREE.Vector3();
  let glowMats = null; const glowColor = new THREE.Color();
  let havePos = false;
  const TELEPORT = 40, TELEPORT_M = 2.5, MAX_CARRY = 14;
  const carried = () => vel.clone().clampLength(0, MAX_CARRY);
  const { RAPIER, world: pworld } = physicsOf(ctx);

  const LOOPED_EMOTE = n => /^emote_|^sit|^crouch$/.test(n);
  function startAction(name, { loop, rate = 1, hold = false, fade, from = 0 } = {}) {
    S.action = { name, t: from * dur(name), loop: loop ?? !!meta(name).loop, rate, hold, cancel: LOOPED_EMOTE(name) || name === 'emote_talk' };
    if (fade !== undefined) S.fade = fade;
  }
  function startOverlay(name, { loop, rate = 1, fade = 0.12 } = {}) {
    if (S.over && S.over.name === name && S.over.target === 1) { S.over.loop = loop ?? S.over.loop; return; }
    S.over = { name, t: 0, loop: loop ?? !!meta(name).loop, rate, w: S.over?.w ?? 0, target: 1, fade };
  }

  // base layer targets
  const target = new Map();
  function baseTargets(dt) {
    target.clear();
    if (S.mode === 'getup' && getup) { target.set(getup.clip, 1); return; }
    const a = S.action;
    if (a) {
      if (a.cancel && (S.speed > 0.6 || !S.grounded)) S.action = null;
      else { target.set(a.name, 1); return; }
    }
    if (!S.grounded) {
      if (S.jumped && hasClip('jump') && hasClip('fall')) { const f = smooth((S.airT - 0.28) / 0.3); target.set('jump', 1 - f); target.set('fall', f); }
      else target.set('fall', 1);
      return;
    }
    if (S.landT < 0.32 && hasClip('land')) { const f = smooth(S.landT / 0.32); target.set('land', 1 - f * 0.6); }
    // locomotion: idle / walk / run / sprint by speed, at this body's stride
    const sp = S.speed;
    const ws = (meta('walk').speed ?? 1.0) * k * scale, rs = (meta('run').speed ?? 3.9) * k * scale, ss = hasClip('sprint') ? (meta('sprint').speed ?? 6.6) * k * scale : Infinity;
    let wI = 0, wW = 0, wR = 0, wS = 0;
    if (sp < 0.05) wI = 1;
    else if (sp < ws * 0.6) { const a2 = sp / (ws * 0.6); wI = 1 - a2; wW = a2; }
    else if (sp < ws) wW = 1;
    else if (sp < rs) { const b = smooth((sp - ws) / (rs - ws)); wW = 1 - b; wR = b; }
    else if (sp < ss) { const c = smooth((sp - rs) / (ss - rs)); wR = 1 - c; wS = c; }
    else wS = 1;
    const rest = 1 - (target.get('land') ?? 0);
    for (const [n, w] of [['idle', wI], ['walk', wW], ['run', wR], ['sprint', wS]]) if (w > 0 && hasClip(n)) target.set(n, (target.get(n) ?? 0) + w * rest);
  }
  function advance(dt) {
    baseTargets(dt);
    // gait: one phase for walk/run/sprint so feet never pop between them; rate matches the stride to the speed
    const g = ['walk', 'run', 'sprint'].filter(hasClip);
    let wsum = 0, cyc = 0, spd = 0;
    for (const n of g) { const w = target.get(n) ?? 0; wsum += w; cyc += w * dur(n); spd += w * (meta(n).speed ?? 1) * k * scale; }
    if (wsum > 1e-3) { cyc /= wsum; spd /= wsum; const rate = THREE.MathUtils.clamp(S.speed / Math.max(0.2, spd), 0.55, 2.4); S.phase = (S.phase + dt * rate / cyc) % 1; }
    S.idleT += dt;
    // weights ease toward their targets
    const ease = Math.min(1, dt / Math.max(0.03, S.fade));
    for (const n of new Set([...S.weights.keys(), ...target.keys()])) {
      const w = (S.weights.get(n) ?? 0) + ((target.get(n) ?? 0) - (S.weights.get(n) ?? 0)) * ease;
      if (w < 1e-3 && !target.has(n)) S.weights.delete(n); else S.weights.set(n, w);
    }
    let total = 0; for (const w of S.weights.values()) total += w;
    // clip times
    const a = S.action;
    if (a) {
      a.t += dt * a.rate;
      if (a.t >= dur(a.name)) {
        if (a.loop) a.t %= dur(a.name);
        else if (a.then && hasClip(a.then)) startAction(a.then);
        else if (a.hold) a.t = dur(a.name);
        else { S.action = null; S.fade = 0.2; }
      }
    }
    if (!S.grounded) {
      S.airT += dt;
      if (S.jumped) jumpT = Math.min(dur('jump') * 0.74, jumpT + dt * 1.6);
    }
    if (S.landT < 9) S.landT += dt;
    for (const [n, act] of base.acts) {
      const w = S.weights.get(n) ?? 0;
      act.setEffectiveWeight(total > 0 ? w / total : 0);
      if (w <= 0) continue;
      if (g.includes(n)) act.time = S.phase * dur(n);
      else if (n === 'idle') act.time = S.idleT % dur(n);
      else if (n === 'fall') act.time = S.airT % dur(n);
      else if (n === 'jump') act.time = jumpT;
      else if (n === 'land') act.time = Math.min(dur(n), dur(n) * 0.12 + S.landT * 1.8);
      else if (a && n === a.name) act.time = Math.min(a.t, dur(n) - 1e-4);
      else if (getup && n === getup.clip) act.time = Math.min(getup.t, dur(n) - 1e-4);
    }
    base.mixer.update(0);
    // upper-body layer
    const o = S.over;
    if (o) {
      o.t += dt * o.rate;
      if (o.t >= dur(o.name)) { if (o.loop) o.t %= dur(o.name); else { o.t = dur(o.name) - 1e-4; o.target = 0; } }
      o.w += (o.target - o.w) * Math.min(1, dt / Math.max(0.03, o.fade));
      if (o.target === 0 && o.w < 0.01) S.over = null;
    }
    for (const act of over.acts.values()) act.setEffectiveWeight(0);
    if (S.over) {
      const pitchSet = S.over.name === 'aim' && hasClip('aim_up') && hasClip('aim_down');
      if (pitchSet) {
        const p = THREE.MathUtils.clamp(S.aimPitch, -1, 1);
        over.acts.get('aim').setEffectiveWeight(1 - Math.abs(p));
        over.acts.get(p > 0 ? 'aim_up' : 'aim_down').setEffectiveWeight(Math.abs(p));
        for (const n of ['aim', 'aim_up', 'aim_down']) over.acts.get(n).time = 0;
      } else {
        const act = over.acts.get(S.over.name); act.setEffectiveWeight(1); act.time = Math.min(S.over.t, dur(S.over.name) - 1e-4);
      }
      over.mixer.update(0);
      const w = smooth(S.over.w);
      for (const n of rig.UPPER) { const b = base.bones.get(n), c = over.bones.get(n); if (b && c) b.quaternion.slerp(c.quaternion, w); }
    }
  }
  let jumpT = 0;

  // ---------------- get up after a ragdoll
  const fwd = new THREE.Vector3(0, 0, 1);
  function worldYaw(o) { const q = o.getWorldQuaternion(new THREE.Quaternion()); const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q); return Math.atan2(f.x, f.z); }
  // seconds (fair play F1): the get-up takes this long: the clip starts a little in (past the flat-on-the-ground
  // start) and plays faster, blending from the ragdoll's pose. Without it, the whole clip at its own speed.
  const GETUP_FROM = 0.2;
  function beginGetUp(seconds = null) {
    const pel = rag.pose('pelvis'), hd = rag.pose('head') ?? rag.pose('torso'), tor = rag.pose('torso') ?? pel;
    const chestFwd = rag.parts.get('torso') ? fwd.clone().applyQuaternion(tor.quaternion) : fwd.clone();
    const onBack = chestFwd.dot(new THREE.Vector3(0, 1, 0)) > 0;
    const hdir = hd.position.clone().sub(pel.position).setY(0);
    if (hdir.lengthSq() < 1e-6) hdir.set(0, 0, onBack ? -1 : 1);
    hdir.normalize();
    const clip = onBack || !hasClip('getup_front') ? 'getup' : 'getup_front';
    const yaw = clip === 'getup' ? Math.atan2(-hdir.x, -hdir.z) : Math.atan2(hdir.x, hdir.z);
    const start = meta(clip).start ?? [0, 0.11, -0.5];
    const startXZ = new THREE.Vector3(start[0] * k * scale, 0, start[2] * k * scale).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    let groundY = object3d.getWorldPosition(new THREE.Vector3()).y;
    if (RAPIER && pworld) {
      const ray = new RAPIER.Ray({ x: pel.position.x, y: pel.position.y + 0.2, z: pel.position.z }, { x: 0, y: -1, z: 0 });
      const hit = pworld.castRay(ray, 6, true, undefined, (GROUPS.WORLD << 16) | GROUPS.WORLD);
      if (hit) groundY = pel.position.y + 0.2 - (hit.timeOfImpact ?? hit.toi);
    }
    const target = new THREE.Vector3(pel.position.x - startXZ.x, groundY, pel.position.z - startXZ.z);
    // snapshot the ragdoll pose in the new frame, then hand the bones back to the clips
    const hips = found.bones.get('Hips');
    hips.updateWorldMatrix(true, false);
    const hipsWorld = hips.matrixWorld.clone();
    const d0 = dur(clip), quick = typeof seconds === 'number' && seconds > 0;
    const from = quick ? Math.min(GETUP_FROM, Math.max(0, 1 - seconds / d0)) : 0;
    getup = { clip, t: from * d0, el: 0, rate: quick ? Math.max(1, (d0 * (1 - from)) / seconds) : 1, target, yaw, from: null, blend: quick ? Math.min(0.38, seconds * 0.4) : 0.38 };
    onState?.('getup', { position: target.clone(), yaw });
    placeOffset(1);
    hips.parent.updateWorldMatrix(true, false);
    new THREE.Matrix4().copy(hips.parent.matrixWorld).invert().multiply(hipsWorld).decompose(hips.position, hips.quaternion, new THREE.Vector3());
    getup.from = new Map(rt.order.map(n => [n, found.bones.get(n).quaternion.clone()]));
    getup.fromHips = hips.position.clone();
    rag.dispose(); rag = null;
    S.mode = 'getup'; S.action = null; S.weights.clear(); S.weights.set(clip, 1); S.fade = 0.2;
  }
  // the model sits at the get-up spot, then drifts onto object3d (the controller's capsule) while standing up
  function placeOffset(stay) {
    object3d.updateWorldMatrix(true, false);
    const objPos = object3d.getWorldPosition(new THREE.Vector3()), objYaw = worldYaw(object3d);
    const pos = getup.target.clone().lerp(objPos, 1 - stay);
    let dy = getup.yaw - objYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    offset.position.copy(object3d.worldToLocal(pos.clone()));
    offset.rotation.set(0, dy * stay, 0);
    offset.updateMatrixWorld(true);
  }

  // ---------------- the character
  const ch = {
    object3d, model, sockets, player, local,
    get height() { return rt.height * scale; },
    /** Height of the hips above the feet at the rest pose (m): where a 'hips' muzzle starts. */
    get hipHeight() { return (bp.pos.get('Hips').y - rt.ground) * scale; },
    get state() { return S.mode; },
    get anim() { let best = null, bw = 0; for (const [n, w] of S.weights) if (w > bw) { bw = w; best = n; } return S.over?.target ? S.over.name : best; },
    clips: [...cs.clips.keys()],
    meta: cs.meta,
    bones: found.bones,
    retarget: rt,
    plate: plateInfo,

    /** Play a clip by name. Upper-body clips (meta layer 'upper': aim, carry, hit, interact, throw, punch) layer over
     *  locomotion; the rest replace it until they end. {loop, fade, hold, rate, layer: 'base'|'upper'} */
    play(name, o = {}) {
      if (!hasClip(name)) return false;
      if (S.mode !== 'anim') return false;
      if (name === 'land' && !o.loop) { S.landT = 0; return true; }           // the controller's 'land' word
      if (name === 'jump' && !o.loop) { S.jumped = true; jumpT = dur('jump') * 0.28; return true; }
      const layer = o.layer ?? meta(name).layer ?? 'base';
      if (layer === 'upper') startOverlay(name, o);
      else if (['idle', 'walk', 'run', 'sprint', 'fall'].includes(name) && !o.hold && !o.loop) { S.action = null; }
      else startAction(name, o);
      return true;
    },
    /** Stop a clip (or a layer: 'upper' / 'base'). */
    stop(name = 'upper', { fade = 0.15 } = {}) {
      if (S.over && (name === 'upper' || name === S.over.name)) { S.over.target = 0; S.over.fade = fade; }
      if (S.action && (name === 'base' || name === S.action.name)) { S.action = null; S.fade = fade; }
    },
    /** Every frame: ground speed (m/s), on the ground or not, vertical speed. */
    locomotion(speed = 0, grounded = true, vy = 0) {
      if (S.grounded && !grounded) { S.airT = 0; S.jumped = vy > 0.5 || S.vy > 0.5; jumpT = dur('jump') * 0.28; }
      // kit/controller passes no vy; its anim word says whether this is a jump (driveCharacter sets __word after us)
      if (!grounded && !S.jumped && S.airT < 0.2 && ch.__word === 'jump') { S.jumped = true; jumpT = dur('jump') * 0.28; }
      if (!S.grounded && grounded && S.airT > 0.3) S.landT = 0;
      S.speed = speed; S.grounded = grounded; S.vy = vy;
    },
    /** Aim pitch for the aim clip, -1 (down) .. 1 (up). */
    setAim(pitch) { S.aimPitch = pitch; },
    socket(name) { return sockets[name] ?? object3d; },
    /** Make a face for `seconds` (RIG.md §3 gfFaces): 'hurt' while being hit (projectile calls this; calling again keeps
     *  it), null for the neutral face. A knocked-down body shows 'hurt' by itself. False when this body has no such face. */
    express(name, seconds = 0.3) {
      if (name == null) { faceWant = null; faceT = 0; return true; }
      if (!faces[name]) return false;
      if (faceWant !== name) faceT = 0;
      faceWant = name; faceT = Math.max(faceT, seconds); return true;
    },
    get face() { return face; },
    faces: Object.keys(faces),
    /** Knocked: ragdoll with this velocity (world m/s), then get up by itself. Without physics: knockdown, getup. */
    knock(impulse = { x: 0, y: 2, z: -3 }, { getUp = true } = {}) {
      const v = new THREE.Vector3(impulse.x ?? 0, impulse.y ?? 0, impulse.z ?? 0).add(carried());
      if (!(RAPIER && pworld)) { startAction('knockdown', { hold: !getUp }); if (getUp) S.action.then = 'getup'; return; }
      // knocked again while already down: shove the ragdoll it is (rebuilding it from a settling pose once called
      // beginGetUp on a disposed ragdoll and threw)
      if (rag && S.mode === 'ragdoll') { rag.push(new THREE.Vector3(impulse.x ?? 0, impulse.y ?? 0, impulse.z ?? 0).clampLength(0, 30)); ragT = Math.min(ragT, 0.2); wantUp = getUp; return; }
      startRagdoll(v); wantUp = getUp;
    },
    /** Where the body's middle is now (the ragdoll's pelvis while down, else the hips over object3d): {x, y, z}. */
    centre() { const p = rag?.pose('pelvis')?.position; if (p) return { x: p.x, y: p.y, z: p.z }; const o = object3d.getWorldPosition(new THREE.Vector3()); return { x: o.x, y: o.y + (bp.pos.get('Hips').y - rt.ground) * scale, z: o.z }; },
    /** While ragdolled: pull the body onto a path someone else simulates (the knockback mechanic's flight, the same on
     *  every screen): its middle toward `target` at velocity `vel`. → false when not ragdolled. */
    steer(target, vel) { if (!rag || S.mode !== 'ragdoll') return false; rag.steer(target, vel); ragT = Math.min(ragT, 0.3); return true; },
    /** Ragdoll on (stays down) or off (gets up once it has settled). The controller's 'knockdown' word uses this. */
    ragdoll(on, { upSeconds = null } = {}) {
      if (on) { if (!rag && RAPIER && pworld) startRagdoll(carried()); else if (!rag) startAction('knockdown', { hold: true }); wantUp = false; upIn = null; }
      else if (rag) { wantUp = true; upIn = typeof upSeconds === 'number' && upSeconds > 0 ? upSeconds : null; }
      else if (S.action?.name === 'knockdown') startAction(hasClip('getup') ? 'getup' : 'idle', upSeconds > 0 && hasClip('getup') ? { rate: Math.max(1, dur('getup') / upSeconds) } : {});
    },
    /** Stand up at once where object3d is (a respawn or a round reset): no ragdoll, no get-up left. */
    recover() {
      if (S.mode === 'anim' && !rag && !getup && S.action?.name !== 'knockdown') return;
      rag?.dispose(); rag = null; ragT = 0; wantUp = false; upIn = null; getup = null;
      S.mode = 'anim'; S.action = null; S.over = null; S.weights.clear(); S.weights.set('idle', 1);
      offset.position.set(0, 0, 0); offset.rotation.set(0, 0, 0);
      havePos = false; vel.set(0, 0, 0);
      onState?.('up', {});
    },
    /** A glow over this body's own materials (fair play's protection shimmer): a colour and 0–1, or null to clear.
     *  The first call gives this character its own copies of its materials, so other bodies never light up. */
    glow(color, amount = 0.4) {
      if (!glowMats) {
        if (color == null) return;
        glowMats = [];
        const own = new Map();
        model.traverse(o => {
          if (!o.isMesh) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          const out = mats.map(m => {
            if (!m || !m.emissive) return m;
            if (!own.has(m)) { const c = tinted.includes(m) ? m : m.clone(); if (c !== m) { c.userData = { ...m.userData }; } c.userData.gfGlowBase = c.emissive.clone(); own.set(m, c); glowMats.push(c); }
            return own.get(m);
          });
          o.material = Array.isArray(o.material) ? out : out[0];
        });
      }
      const k = color == null ? 0 : Math.max(0, Math.min(1, amount));
      if (color != null) glowColor.set(color);
      for (const m of glowMats) m.emissive.copy(m.userData.gfGlowBase).lerp(glowColor, k);
    },
    /** The gameplay tint (the seat or team colour): the nameplate's colour, and the body's unless the player wears their
     *  own (setLookTint). */
    setTint(c) { if (c == null) return; gameTint = typeof c === 'string' ? c : '#' + new THREE.Color(c).getHexString(); paintTint(); plateInfo.color = gameTint; },
    /** The player's own body colour (a loadout, CONTRACT §6e), or null for the gameplay tint. It wins on the body; the
     *  ring, the nameplate and everything gameplay keep the seat or team colour. */
    setLookTint(c) { lookTint = c == null ? null : typeof c === 'string' ? c : '#' + new THREE.Color(c).getHexString(); paintTint(); },
    get tint() { return gameTint; },
    /** What this character wears: { body (file drawn), hat (file or null), tint (the player's own or null), bodyTint
     *  (the colour the tint materials were set to), material (a tint material's colour now, '#rrggbb' or null), mix }. */
    get look() { return { body: bodyFile, hat: ch.hat?.userData?.gfFile ?? null, tint: lookTint, bodyTint: lookTint ?? gameTint, material: tinted[0]?.color ? '#' + tinted[0].color.getHexString() : null, mix: tintMix }; },
    /** Wear a hat (a model on the head socket) or none (null); the old one is removed. */
    setHat(obj) {
      if (ch.hat) { ch.hat.removeFromParent(); ch.hat = null; }
      if (!obj) return;
      try { ctx.look?.adoptMaterials?.(obj, 'prop'); } catch (e) { console.warn(`gf-three character: hat material: ${e.message}`); }
      lightMaterials(obj);
      sockets.head.add(obj); ch.hat = obj;
    },
    /** Name and colour for the nameplate. The kit's UI draws it (character.plate); plate:'sprite' draws one here. */
    nameplate(text, color) {
      plateInfo.text = text ?? ''; if (color) plateInfo.color = color;
      if (plate === 'sprite' && globalThis.document) drawPlate();
    },
    update(dt) {
      dt = Math.min(Math.max(dt, 0), 0.1);
      object3d.updateWorldMatrix(true, false);
      const p = object3d.getWorldPosition(new THREE.Vector3());
      sampleWorldLight(p, dt);
      if (dt > 1e-4) {
        if (havePos) {
          _step.copy(p).sub(lastPos);
          const d = _step.length();
          if (!(d <= TELEPORT_M && d / dt <= TELEPORT)) vel.set(0, 0, 0); else vel.lerp(_step.divideScalar(dt), 0.5);
        }
        havePos = true; lastPos.copy(p);
      }
      faceT = Math.max(0, faceT - dt);
      const down = S.mode !== 'anim' || S.action?.name === 'knockdown' || S.action?.name === 'getup';
      setFace(down && faces.hurt ? 'hurt' : faceT > 0 ? faceWant : null);
      if (S.mode === 'ragdoll') {
        if (!rag) return;
        ragT += dt; rag.update();
        if (wantUp && (upIn !== null ? ragT > 0.05 : ragT > 0.7 && (rag.speed() < 0.35 || ragT > 4))) beginGetUp(upIn);
        return;
      }
      if (S.mode === 'getup') {
        getup.t += dt * getup.rate; getup.el += dt;
        const d = dur(getup.clip);
        placeOffset(1 - smooth((getup.t - d * 0.45) / (d * 0.55 + 0.25)));
        if (getup.t >= d) { S.mode = 'anim'; S.weights.clear(); S.weights.set('idle', 1); getup.done = true; }
      }
      advance(dt);
      rt.apply(base.bones);
      if (getup) {
        const w = smooth(getup.el / getup.blend);
        if (w < 1 && getup.from) {
          for (const n of rt.order) found.bones.get(n).quaternion.slerpQuaternions(getup.from.get(n), found.bones.get(n).quaternion.clone(), w);
          const hips = found.bones.get('Hips'); hips.position.lerpVectors(getup.fromHips, hips.position.clone(), w);
        }
        if (getup.done) { getup = null; offset.position.set(0, 0, 0); offset.rotation.set(0, 0, 0); onState?.('up', {}); }
      }
    },
    dispose() {
      rag?.dispose(); rag = null;
      object3d.removeFromParent();
      base.mixer.stopAllAction(); over.mixer.stopAllAction();
      for (const m of tinted) m.dispose();
      for (const m of owned) m.dispose();
      if (plateSprite) { plateSprite.material.map?.dispose(); plateSprite.material.dispose(); }
    },
  };

  function startRagdoll(v) {
    if (rag) { rag.dispose(); rag = null; }
    ch.update(0);
    object3d.updateWorldMatrix(true, true);
    const P = n => found.bones.get(n);
    const end = n => () => P(n).getWorldPosition(new THREE.Vector3());
    const headTop = () => sockets.head.getWorldPosition(new THREE.Vector3());
    const r = info.radii, s = scale;
    const neck = found.bones.has('neck') ? 'neck' : 'Head';
    const parts = [
      { name: 'pelvis', bone: P('Hips'), end: end(info.torso), radius: r.pelvis * s },
      { name: 'torso', bone: P(info.torso), end: end(neck), radius: r.torso * s, parent: 'pelvis', swing: SWING.torso },
      { name: 'head', bone: P('Head'), end: headTop, radius: r.head * s, parent: 'torso', ball: true, swing: SWING.head },
      { name: 'upperarm_l', bone: P('LeftArm'), end: end('LeftForeArm'), radius: r.upperarm_l * s, parent: 'torso', swing: SWING.upperarm },
      { name: 'forearm_l', bone: P('LeftForeArm'), end: end('LeftHand'), radius: r.forearm_l * s, parent: 'upperarm_l', hinge: 'elbow' },
      { name: 'upperarm_r', bone: P('RightArm'), end: end('RightForeArm'), radius: r.upperarm_r * s, parent: 'torso', swing: SWING.upperarm },
      { name: 'forearm_r', bone: P('RightForeArm'), end: end('RightHand'), radius: r.forearm_r * s, parent: 'upperarm_r', hinge: 'elbow' },
      { name: 'thigh_l', bone: P('LeftUpLeg'), end: end('LeftLeg'), radius: r.thigh_l * s, parent: 'pelvis', swing: SWING.thigh },
      { name: 'shin_l', bone: P('LeftLeg'), end: end('LeftFoot'), radius: r.shin_l * s, parent: 'thigh_l', hinge: 'knee' },
      { name: 'thigh_r', bone: P('RightUpLeg'), end: end('RightLeg'), radius: r.thigh_r * s, parent: 'pelvis', swing: SWING.thigh },
      { name: 'shin_r', bone: P('RightLeg'), end: end('RightFoot'), radius: r.shin_r * s, parent: 'thigh_r', hinge: 'knee' },
    ];
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(object3d.getWorldQuaternion(new THREE.Quaternion()));
    rag = createRagdoll(RAPIER, pworld, parts, { velocity: v, forward: facing });
    ragT = 0; S.mode = 'ragdoll'; S.action = null; S.over = null; getup = null;
    offset.position.set(0, 0, 0); offset.rotation.set(0, 0, 0);
    onState?.('ragdoll', {});
  }

  function drawPlate() {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
    const g = cv.getContext('2d');
    g.font = '600 30px system-ui, sans-serif';
    const w = Math.min(248, g.measureText(plateInfo.text).width + 34);
    g.fillStyle = 'rgba(20,22,34,0.72)'; g.beginPath(); g.roundRect((256 - w) / 2, 10, w, 44, 22); g.fill();
    g.fillStyle = plateInfo.color; g.beginPath(); g.arc((256 - w) / 2 + 18, 32, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(plateInfo.text, (256 - w) / 2 + 30, 33);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    if (!plateSprite) {
      plateSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
      plateSprite.userData.gfSlot = 'character.nameplate';
      plateSprite.renderOrder = 10; plateSprite.scale.set(1.0, 0.25, 1);
      object3d.add(plateSprite);
    } else { plateSprite.material.map?.dispose(); plateSprite.material.map = tex; }
    plateSprite.position.set(0, rt.height * scale + 0.32, 0);
  }

  // a hat: the optional character.hat.<role> slot, worn on the head socket (its origin on top of the head, +Z forward);
  // a player's own hat (their loadout) first, else the game's when the role has one
  try { ch.setHat(await loadHat(ctx, role, player)); }
  catch (e) { console.warn(`gf-three character: hat for ${role}: ${e.message}`); }
  if (tint) ch.setTint(tint);
  // the player's own body colour (CONTRACT §6e): only a loadout's; without one the gameplay tint shows, as before
  const own = player && role && A.own ? A.own(`character.tint.${role}`, player) : undefined;
  if (own != null) ch.setLookTint(own);
  if (player?.name) ch.nameplate(player.name, tint ?? undefined);
  ch.update(0);
  return ch;
}
