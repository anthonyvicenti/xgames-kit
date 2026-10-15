// The look judge's sheet page for the three runtime's standard-3d profile (kinds silly, blocky, lofi). One kind, one
// shot a load: ?kind=<id>&shot=world|hero|bodies|props. It builds what a game on that kind would draw, through the
// runtime's own parts: the look (applyLook with the kind's preset, time and values), the kind's pass (lofi), the
// world family (loadWorld, or the voxel world for blocky), the body set (spawnCharacter on gf-humanoid-1, playing the
// shared clips) and the kind's props (the library's GLBs through the house materials). window.__sheet answers the
// tool: { ready, errors, info }.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { createRenderer, applyLook, adoptMaterials, material } from '/kit/look/look.js';
import { spawnCharacter } from '/kit/character/character.js';
import { loadWorld, templateLayout } from '/kit/world/world.js';
import { harmonizeModel, harmonizePicture } from '/kit/look/harmonize.js';
import { leanToward } from '/kit/world/compose.mjs';

const Q = new URLSearchParams(location.search);
const SHOT = Q.get('shot') ?? 'world';
const S = window.__sheet = { ready: false, errors: [], info: { shot: SHOT } };
addEventListener('error', e => S.errors.push(String(e.error?.stack ?? e.message)));
addEventListener('unhandledrejection', e => S.errors.push(String(e.reason?.stack ?? e.reason)));

const kind = await (await fetch(`/xk/kinds/${Q.get('kind')}.json`)).json();
// ?set={json}: look values over the kind's (a tuning run: kind-sheet.mjs --query 'set={"fog":{"far":20}}')
const merge = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge({ ...a[k] }, v) : v; return a; };
if (Q.get('set')) kind.look.three.values = merge({ ...(kind.look.three.values ?? {}) }, JSON.parse(Q.get('set')));
const sheet = { ...kind.sheet }, L3 = kind.look.three;
// ?game=1: a game's sheet (verify's check 9): its own look (config/look.json, the kind already folded in by create), its
// world's values and its bodies, served under /game/; the kind's props
const GAME = Q.has('game') ? { look: await (await fetch('/game/config/look.json')).json(), world: await (await fetch('/game/config/world.json')).json(), chars: await (await fetch('/game/config/characters.json')).json(), props: await fetch('/game/config/props.json').then(r => (r.ok ? r.json() : null)).catch(() => null), game: await fetch('/game/config/game.json').then(r => (r.ok ? r.json() : null)).catch(() => null) } : null;
const time = GAME ? GAME.look.time ?? 'day' : L3.time ?? 'day';
// the kind's values win over the preset's time of day too (a preset's times.night block would shadow them): the
// same fold create makes (kinds/apply.mjs)
const lookCfg = GAME ? GAME.look : { preset: L3.preset, ...(L3.values ?? {}), times: { [time]: L3.values ?? {} } };
if (GAME) {
  const W0 = sheet.world ?? {};
  sheet.world = { ...W0, template: GAME.world.template ?? W0.template };
  const roles = Object.keys(GAME.chars.roles ?? {});
  sheet.hero = roles.includes('player') ? 'game-player' : `game-${roles[0]}`;
  sheet.bodies = roles.length >= 4 ? roles.slice(0, 4).map(r => `game-${r}`) : [...roles.map(r => `game-${r}`), ...Array(4 - roles.length).fill(sheet.hero)];
  S.info.game = { roles, template: sheet.world.template };
}

const canvas = document.getElementById('view');
const renderer = createRenderer(canvas, lookCfg, 'high');
renderer.setSize(innerWidth, innerHeight, false);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 800);
const ctx = { scene, camera, renderer, quality: 'high', RAPIER };
const noise = await new THREE.TextureLoader().loadAsync('/lib3/textures/noise-soft.png');
noise.wrapS = noise.wrapT = THREE.RepeatWrapping; noise.colorSpace = THREE.NoColorSpace;
const look = applyLook(ctx, lookCfg, { quality: 'high', time, textures: { noise }, captureApi: false });
await RAPIER.init();
const pworld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
ctx.physics = pworld;

// ---- the asset library: the three and scenic packs' bodies, the three packs' props (served as /lib3/) ----
const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
const gltfs = new Map();
// a game's style pass (config/look.json harmonize: kit/look/harmonize.js) on every model and picture it draws, as the
// runtime's assets do; ?harm=0 draws them as they are (a before and after of the same game)
const HARM = GAME && Q.get('harm') !== '0' ? { look: GAME.look } : { settings: null };
const loadGltf = (url, slot = null) => { if (!gltfs.has(url)) gltfs.set(url, loader.loadAsync(url).then(g => { if (slot) harmonizeModel(g.scene, slot, HARM); return g; })); return gltfs.get(url); };
const lib = await (await fetch('/lib3/bodies.json')).json();
const bodies = new Map(lib.bodies.map(b => [b.id, { ...b, url: `/lib3/${b.file}` }]));
for (const [role, r] of Object.entries(GAME?.chars.roles ?? {})) bodies.set(`game-${role}`, { id: `game-${role}`, url: `/game/${r.body}`, height: r.height ?? null });
const props = new Map((await (await fetch('/lib3/props.json')).json()).props.map(p => [p.id, p]));
const clipsUrl = `/lib3/${typeof lib.clips === 'string' ? lib.clips : lib.clips?.file ?? 'clips/gf-humanoid-1.glb'}`;

// a small assets stand-in (slot → library file), as the runtime's lookdev bench has: bodies get the house character
// material, then the kit tints their tint_* materials per player
const assets = {
  has: id => id === 'character.clips' || bodies.has(id.replace('character.body.', '')),
  ids: (prefix = '') => ['character.clips', ...[...bodies.keys()].map(k => `character.body.${k}`)].filter(k => k.startsWith(prefix)),
  value: (id, fallback) => fallback, config: () => ({}),
  tag(o, id) { o.userData.gfSlot = id; o.traverse(x => { if (x.isMesh) x.userData.gfSlot ??= id; }); return o; },
  async model(id) {
    const body = bodies.get(id.replace('character.body.', ''));
    const g = await loadGltf(id === 'character.clips' ? clipsUrl : body.url, id === 'character.clips' ? null : id);
    let skinned = false; g.scene.traverse(o => { if (o.isSkinnedMesh) skinned = true; });
    const sc = skinned ? SkeletonUtils.clone(g.scene) : g.scene.clone(true);
    if (body) adoptMaterials(sc, 'character');
    const root = new THREE.Group(); root.name = id; root.add(sc); root.animations = g.animations;
    root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return assets.tag(root, id);
  },
  async texture(id) {
    // the voxel world's block faces: world.voxel.texture.<name> → its file in the library
    const name = id.replace('world.voxel.texture.', ''), file = voxelCfg?.voxel?.textures?.[name];
    if (!file) throw new Error(`no texture ${id}`);
    const t = await new THREE.TextureLoader().loadAsync(file.replace(/^library:/, '/lib3/'));
    t.colorSpace = THREE.SRGBColorSpace; return t;
  },
};

// ---- the world family ----
let world = null, voxelCfg = null;
const W = sheet.world ?? {};
if (W.template === 'voxel') {
  const base = await (await fetch('/kit/world/voxel/default.json')).json();
  const preset = W.preset ? await (await fetch(`/xk/${W.preset}`)).json() : { voxel: {} };
  voxelCfg = { template: 'voxel', voxel: { ...base, ...preset.voxel, textures: { ...base.textures, ...(preset.voxel?.textures ?? {}) }, terrain: { ...base.terrain, ...(preset.voxel?.terrain ?? {}), plaza: { ...base.terrain.plaza, ...(preset.voxel?.terrain?.plaza ?? {}) } } } };
  ctx.worldSlug = '';                                  // no saved world: the island as generated
  const { loadWorld: loadVoxel } = await import('/kit/world/voxel/world.js');
  world = await loadVoxel({ ...ctx, assets }, voxelCfg);       // the voxel world reads its block faces through assets
  for (let i = 0; i < 400 && world.voxel.grid.dirty.size; i++) world.update?.(1 / 60);
} else if (GAME?.world?.template === 'terrain') {
  // a game's terrain world (worlds/terrain: smooth ground blasts carve, its scenery) with the game's own pictures and
  // the scenery's prop models, served under /game/
  const W0 = GAME.world, loader = new THREE.TextureLoader();
  const gameAssets = {
    ...assets,
    has: id => (/^world\.terrain\.(top|soil|cliff)$/.test(id) ? !!W0.materials?.[id.split('.')[2]]?.file : /^prop\./.test(id) ? [...(W0.scenery?.props ?? []), ...(W0.terrain?.compose?.landmarks ?? []), ...(W0.terrain?.compose?.bridges ?? [])].includes(id.slice(5)) : assets.has(id)),
    async texture(id) { const t = await loader.loadAsync(`/game/${W0.materials[id.split('.')[2]].file}`); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; harmonizePicture(t, id, HARM); return t; },
    async model(id) { if (!id.startsWith('prop.')) return assets.model(id); const g = await loadGltf(`/game/assets/models/${id.slice(5)}.glb`, id); return g.scene.clone(true); },
    // the game's prop catalog: the scenery reads each prop's size (a set piece stands back from the seats) and collider
    config: name => (name === 'props' ? GAME.props ?? {} : {}),
  };
  const { loadWorld: loadTerrain } = await import('/kit/world/terrain/world.js');
  world = await loadTerrain({ ...ctx, assets: gameAssets }, W0);
} else {
  // the kind's world values over the template's layout (its ceiling, its ground), as create writes config/world.json
  const wv = GAME ? Object.fromEntries(['ground', 'ceiling'].filter(k => GAME.world[k]).map(k => [k, GAME.world[k]])) : kind.world?.three?.values;
  // a game whose world is generated from parameters (a sea-islands world: its islands, sea and clouds) is drawn as the
  // game has it; a yard's small layout stands in for the others, with the game's ground
  const own = GAME?.world?.islands?.length ? GAME.world : null;
  const wcfg = own ?? (wv ? merge(await templateLayout(W.template ?? 'backyard', { size: 'small' }), wv) : { template: W.template ?? 'backyard' });
  // the game's own textures (a ground or cliff pattern under assets/textures/) are served from the game
  if (own) for (const part of [own.ground, own.cliffs]) if (part?.pattern?.file) part.pattern = { ...part.pattern };
  world = await loadWorld(ctx, wcfg, { library: new URL('/lib3/', location.href).href, textures: { noise } });
}
S.info.world = W.template;

// ---- where things stand: the world's first spawn, facing the middle (a terrain world's flattest seat: its seats
// stand on hills and slopes, and a sheet is drawn on level ground) ----
let spawn = world.spawn?.(0) ?? new THREE.Vector3();
// a composed level's seats are placed and turned for play (a partner and a landmark in view): its first seat, as is
if (world.landmarks?.length && world.spawns?.length) S.info.composed = { seat: [spawn.x, spawn.y, spawn.z], yaw: spawn.yaw, landmarks: world.landmarks.map(l => l.id) };
else if (world.terrain && world.spawns?.length) {
  const rough = p => { let m = 0; for (let a = 0; a < 8; a++) { const y = world.groundAt(p.x + Math.cos(a * 0.785) * 3, p.z + Math.sin(a * 0.785) * 3); m = Math.max(m, Math.abs(y - p.y)); } return m; };
  const best = world.spawns.reduce((a, b) => (rough(b) < rough(a) ? b : a));
  spawn = best.clone(); spawn.yaw = best.yaw;
}
const yaw = Number.isFinite(spawn.yaw) ? spawn.yaw : 0;
const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), side = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
// a flat world's spawns sit near its edge: the stage moves toward the middle, so every camera stays inside the fence
const mid = world.bounds?.getCenter?.(new THREE.Vector3()) ?? new THREE.Vector3();
const stage = new THREE.Vector3(spawn.x, spawn.y ?? 0, spawn.z);
// a terrain world's seats stand on its islands: the stage is the seat itself
if (!world.voxel && !world.terrain) { stage.lerp(new THREE.Vector3(mid.x, 0, mid.z), Number(W.toward ?? 0.5)); stage.y = 0; }
const seaHeight = world.layout?.islands?.length ? (await import('/kit/world/sea.js')).heightAt : null;
const groundAt = (x, z, near = stage.y) => {
  // the voxel world's top cell under (x, z); an island's top (worlds/sea.js); a flat world's ground is y = 0
  if (seaHeight) return seaHeight(world.layout, x, z) ?? 0;
  if (world.terrain) return world.groundAt(x, z);
  if (!world.voxel) return 0;
  const hit = world.voxel.pick(new THREE.Vector3(x, near + 6, z), new THREE.Vector3(0, -1, 0), 20);
  return hit ? hit.cell[1] + 1 : near;
};

// ---- characters ----
const palette = look.values.palette.players;
const cctx = { ...ctx, assets, time: { now: 0 }, look };
async function spawnBody(id, i) {
  if (!bodies.has(id)) throw new Error(`no body ${id} in the library`);
  let c;
  try { c = await spawnCharacter(cctx, { player: { id: `p${i}`, name: `P${i + 1}`, color: palette[i % palette.length] }, bodySlot: `character.body.${id}`, tint: palette[i % palette.length], plate: null }); }
  catch (e) {
    // a body with no gf-humanoid-1 rig (a blob, a critter: no rig standard yet) stands as a static model, at its role's
    // height, in the house character material: the look can be judged before its archetype is rigged
    if (!/not rigged|body is missing/.test(String(e.message))) throw e;
    const o = await assets.model(`character.body.${id}`), b = bodies.get(id);
    const size = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
    const h = b.height ?? size.y; o.scale.setScalar(size.y ? h / size.y : 1);
    S.info.static = [...(S.info.static ?? []), id];
    c = { object3d: o, height: h, clips: [], play() {}, update() {} };
  }
  scene.add(c.object3d);
  return c;
}
function hold(c, clip, t) {
  // a clip at a fixed moment: the same picture on every run
  c.play(clip, { loop: true, fade: 0 });
  for (let k = 0; k < Math.round(t * 60); k++) c.update(1 / 60);
}
const has = (c, n) => (c.clips ?? []).includes(n);

let cam = camera;
// a camera never stands inside the ground, nor looks through a hill: on a terrain world (hills rise round its seats) it
// rises until its line of sight to what it frames is clear
const clearOf = (pos, target) => { for (let k = 1; k < 16; k++) { const p = pos.clone().lerp(target, k / 16); if (groundAt(p.x, p.z) > p.y - 0.3) return false; } return true; };
const lookAt = (pos, target, fov = 40) => {
  cam.fov = fov; cam.position.copy(pos);
  if (world.terrain) {
    cam.position.y = Math.max(cam.position.y, groundAt(pos.x, pos.z) + 1.2);
    for (let k = 0; k < 24 && !clearOf(cam.position, target); k++) cam.position.y += 0.75;
    // set dressing standing where the camera is (a pine's canopy round the lens) is left out of this shot
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const list of world.props?.values?.() ?? []) for (const p of list) if (p.meshes && Math.hypot(p.at[0] - cam.position.x, p.at[2] - cam.position.z) < 3) p.meshes.forEach(m => { m.setMatrixAt(p.instance, zero); m.instanceMatrix.needsUpdate = true; });
  }
  cam.lookAt(target); cam.updateProjectionMatrix();
};
const P = (o, a = 0, f = 0, up = 0) => o.clone().addScaledVector(side, a).addScaledVector(fwd, f).add(new THREE.Vector3(0, up, 0));

if (SHOT === 'hero' || SHOT === 'world' || SHOT === 'hud') {
  const ids = SHOT === 'hero' ? [sheet.hero] : sheet.bodies;
  const chars = [];
  for (const [i, id] of ids.entries()) chars.push(await spawnBody(id, i));
  const spots = SHOT === 'hero' ? [[0, 0]] : [[-1.1, 0.4], [0.9, 0.1], [-2.6, -0.8], [2.4, -0.9]];
  // a composed level: the first player at its seat, the partner at the partner's seat, two friends between them (the
  // action as the seats frame it, the landmark in view); a place over the sea or off a piece's edge falls back to the seat
  const partner = S.info.composed && world.spawns[1] ? world.spawns[1] : null;
  const composedAt = i => {
    if (i === 0 || !partner) return stage.clone();
    if (i === 1) return partner.clone();
    const p = stage.clone().lerp(partner, i === 2 ? 0.3 : 0.62), y = groundAt(p.x, p.z);
    return y == null || Math.abs(y - stage.y) > 3 ? P(stage, i === 2 ? -1.2 : 1.2, 1.2) : p;
  };
  chars.forEach((c, i) => {
    const p = S.info.composed && SHOT !== 'hero' ? composedAt(i) : P(stage, spots[i][0], spots[i][1]); p.y = groundAt(p.x, p.z);
    c.object3d.position.copy(p); c.object3d.rotation.y = yaw + Math.PI + (SHOT === 'hero' ? 0.45 : [0.3, -0.35, 0.5, -0.5][i]);
    hold(c, SHOT === 'hero' ? 'idle' : ['emote_wave', 'idle', 'run', 'emote_cheer'][i] ?? 'idle', [0.6, 0.4, 0.3, 0.9][i] ?? 0.5);
  });
  const h = chars[0].height ?? 1.7;
  if (SHOT === 'hero') {
    const target = P(stage, 0, 0, h * 0.62);
    lookAt(P(stage, 0.7 * h, -2.0 * h, h * 0.78), target, 32);
  } else {
    if (W.camera === 'eye') {
      // a first-person kind: the room at eye height, the group ahead
      lookAt(P(stage, 0.8, -7.5, 1.65), P(stage, 0, 1.5, 1.2), 70);
    } else if (GAME?.game?.camera === 'third' || GAME?.game?.camera === 'orbit') {
      // the game's own camera rig (config/game.json controller.camera, the look target's numbers when it set them):
      // behind the last of the group at its pivot height, pitched and pulled back as a player first sees the world
      const R0 = { third: { distance: 5.2, height: 1.7, pitchDeg: 16, fov: 60 }, orbit: { distance: 8, height: 1.45, pitchDeg: 26, fov: 55 } }[GAME.game.camera];
      const C = { ...R0, ...(GAME.game.controller?.camera?.[GAME.game.camera] ?? {}) };
      // the camera follows the last of the group (a composed level: the first player, at its seat)
      const feet = S.info.composed ? stage.clone() : P(stage, 0.4, -3.2); if (!S.info.composed) feet.y = groundAt(feet.x, feet.z);
      const pivot = feet.clone().add(new THREE.Vector3(0, C.height, 0)), pitch = C.pitchDeg * Math.PI / 180;
      const eye = pivot.clone().addScaledVector(fwd, -Math.cos(pitch) * C.distance).add(new THREE.Vector3(0, Math.sin(pitch) * C.distance, 0));
      lookAt(eye, pivot, C.fov);
      // the rig leans toward a landmark in view, as it does in play (kit/controller/camera-rig.js)
      if (world.landmarks?.length) { const p = leanToward(cam.position.toArray(), pivot.toArray(), world.landmarks, { fov: C.fov, aspect: cam.aspect }); cam.lookAt(...p); cam.updateProjectionMatrix(); }
      S.info.camera = { rig: GAME.game.camera, ...C };
    } else {
      // the world: the group in the foreground, the place behind them, the sky above
      const target = P(stage, 0, -6, h * 1.6);
      const eye = P(stage, 2.5, -9.5, h * 2.6); eye.y = Math.max(eye.y, groundAt(eye.x, eye.z) + 2);
      lookAt(eye, target, 58);
    }
  }
  S.info.bodies = ids; S.info.height = +h.toFixed(2);
} else if (SHOT === 'bodies') {
  const chars = [];
  for (const [i, id] of sheet.bodies.entries()) chars.push(await spawnBody(id, i));
  const n = chars.length, gap = 1.25 * Math.max(...chars.map(c => c.height ?? 1.7)) * 0.62;
  chars.forEach((c, i) => {
    const p = P(stage, (i - (n - 1) / 2) * gap, 0); p.y = groundAt(p.x, p.z);
    c.object3d.position.copy(p); c.object3d.rotation.y = yaw + Math.PI + (i - (n - 1) / 2) * 0.12;
    hold(c, ['idle', 'emote_wave', 'emote_cheer', 'idle'][i % 4], 0.5 + i * 0.37);
  });
  const H = Math.max(...chars.map(c => c.height ?? 1.7));
  lookAt(P(stage, 0, -((n - 1) * gap + 1.6) * 1.5, H * 0.75), P(stage, 0, 0, H * 0.52), 34);
  S.info.bodies = sheet.bodies;
} else if (SHOT === 'props') {
  // the kind's props in two rows on the world's own ground, biggest at the back
  const list = [];
  // a game's own props for its look (config/look-sheet.json {props: [{id, file, height}]}, a look option's art:
  // builder/look/pitch.mjs) in place of the kind's
  const own = GAME ? await fetch('/game/config/look-sheet.json').then(r => (r.ok ? r.json() : null)).catch(() => null) : null;
  for (const id of own?.props?.length ? own.props.map(p => p.id) : sheet.props) {
    const p = own?.props?.find(x => x.id === id) ?? props.get(id); if (!p) { S.errors.push(`no prop ${id}`); continue; }
    const g = await loadGltf(own?.props?.length ? `/game/${p.file}` : `/lib3/${p.file}`, `prop.${id}`);
    const o = g.scene.clone(true); adoptMaterials(o, 'prop');
    if (p.height) { const y = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()).y; o.scale.setScalar(y ? p.height / y : 1); } else o.scale.setScalar(p.scale ?? 1);
    o.traverse(x => { if (x.isMesh) { x.castShadow = true; x.receiveShadow = true; } });
    const size = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
    list.push({ id, o, size });
  }
  list.sort((a, b) => b.size.y - a.size.y);
  const back = list.slice(0, Math.ceil(list.length / 2)), front = list.slice(back.length);
  let maxH = 0, span = 0;
  const lay = (row, f) => {
    const width = row.reduce((s, x) => s + Math.max(x.size.x, x.size.z) + 0.5, 0);
    let a = -width / 2;
    for (const x of row) {
      const w = Math.max(x.size.x, x.size.z) + 0.5; a += w / 2;
      const p = P(stage, a, f); p.y = groundAt(p.x, p.z);
      x.o.position.copy(p); x.o.rotation.y = yaw + Math.PI + 0.35;
      scene.add(x.o); a += w / 2; maxH = Math.max(maxH, x.size.y);
    }
    span = Math.max(span, width);
  };
  lay(back, 1.6); lay(front, -1.4);
  const dist = Math.max(span * 0.95, maxH * 1.9, 6);
  lookAt(P(stage, 0, -dist, Math.max(2.2, maxH * 0.95)), P(stage, 0, 0.2, Math.min(maxH * 0.42, 2)), 38);
  S.info.props = list.map(x => x.id);
}

// ---- the kind's pass: the look attaches it itself when its values carry post.lofi (kit/look/lofi.js) ----
if (look.lofi) { look.lofi.adopt(scene); S.info.lofi = { ...look.lofi.scale }; }

// draw a few frames (the post stack's history, the voxel chunks), then hold still for the screenshot
look.render(cam);
for (let i = 0; i < 6; i++) { world.update?.(1 / 60); look.render(cam); await new Promise(r => requestAnimationFrame(r)); }
S.info.stats = look.stats?.();
S.ready = true;
