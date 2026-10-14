// gf-forge lookdev (track R): the moonlit ruins arena from the art library (catalog.json `arenaMeshy`), drawn by the
// forge renderer: the grim skeletons playing their clips with their eyes lit and their weapons in hand, the
// first-person arms and a weapon, fires that flicker and throw embers, the moon, fog, bloom, and the retro pass on or
// off. Everything is loaded as a slot file's bytes through the kit (gf/forge/host.js, render.js, look.js), as a game
// loads it.
//
//   /?preset=moonlit-ruins|ember-crypt|ash-storm  &tier=high|medium|low  &retro=0  &shot=hero|wide|close|fight|moon|bodies|bench
//   &fx=0 (no shots and kills)  &fp=0 (no first-person layer)  &weapon=shotgun|pistol|mg|melee|focus  &hud=0
//   shot=poses&role=enemy.skeleton.chaser  one body in its catalog poses; shot=core  the core's own entities
//   wave 2 (track L1):
//   &set=exposure:0.9,ambient.intensity:0.5,fog.color:%23101820   look values over the preset's (dotted paths)
//   &ground=mud|deadgrass|cobble  &tile=3 (metres a repeat)  &walls=0 (no yard walls)  &wall=blocks|rubble
//   &backdrop=80 (trees beyond the walls, the backdrop layer; 0: none)  &pieces=400 (loose debris at rest)
//   shot=ground (the eye over the ground, for the texel measure), shot=pieces, shot=yard (the yard from its gate)
//
// window.__lookdev answers the capture tool (lookdev/capture.mjs): ready, stats(), frames, fire(), shot(name).
import { createHost, transform, linear } from '/kit/host.js';
import { createRender, FX_FILES } from '/kit/render.js';
import * as look from '/kit/look.js';

const Q = new URLSearchParams(location.search);
const PRESET = Q.get('preset') ?? 'moonlit-ruins';
const TIER = Q.get('tier') ?? 'high';
const RETRO = Q.get('retro') !== '0';
let SHOT = Q.get('shot') ?? 'hero';
const FX = Q.get('fx') !== '0';
const FP = Q.get('fp') !== '0';
const WEAPON = Q.get('weapon') ?? 'shotgun';
const ROLE = Q.get('role') ?? 'enemy.skeleton.chaser';
const hud = document.getElementById('hud');
if (Q.get('hud') === '0') hud.style.display = 'none';
const state = { ready: false, error: null, shots: 0, kills: 0, frames: { cost: [], at: [] } };

const fail = e => { state.error = String(e?.message ?? e); const d = document.getElementById('err'); d.style.display = 'block'; d.textContent = `lookdev: ${state.error}`; console.error(e); };
const bytes = async path => { const r = await fetch(`/library/${path}`); if (!r.ok) throw new Error(`${path}: ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
const mul = (a, b) => { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
const deg = r => (r * 180) / Math.PI;
const lookAt = (eye, at) => { const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]]; const h = Math.hypot(d[0], d[2]); return { yaw: Math.atan2(-d[0], -d[2]), pitch: Math.atan2(d[1], h) }; };

/** One GLB from positions, normals, UVs (flat arrays) and 16-bit indices. */
function glbOf(pos, nrm, uv, idx, name) {
  const n = pos.length / 3, vb = n * 32, ib = (idx.length * 2 + 3) & ~3;
  const bin = new Uint8Array(vb + ib);
  const f = new Float32Array(bin.buffer, 0, n * 8); f.set(pos, 0); f.set(nrm, n * 3); f.set(uv, n * 6);
  new Uint16Array(bin.buffer, vb, idx.length).set(idx);
  let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i * 3 + k]); max[k] = Math.max(max[k], pos[i * 3 + k]); }
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: n * 12 }, { buffer: 0, byteOffset: n * 12, byteLength: n * 12 }, { buffer: 0, byteOffset: n * 24, byteLength: n * 8 }, { buffer: 0, byteOffset: vb, byteLength: idx.length * 2 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min, max }, { bufferView: 1, componentType: 5126, count: n, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: n, type: 'VEC2' }, { bufferView: 3, componentType: 5123, count: idx.length, type: 'SCALAR' }] });
  const enc = new TextEncoder().encode(json); const jl = (enc.length + 3) & ~3; const bl = bin.length;
  const out = new Uint8Array(12 + 8 + jl + 8 + bl); const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true); out.fill(0x20, 20, 20 + jl); out.set(enc, 20);
  dv.setUint32(20 + jl, bl, true); dv.setUint32(24 + jl, 0x004e4942, true); out.set(bin, 28 + jl);
  return out;
}

/** A box w × h × d metres standing on the ground at its centre (a wall slab): its picture is laid by the renderer in
 *  world space (render.surface), so its UVs are only a fallback. */
function boxGlb(w, h, d) {
  const x = w / 2, z = d / 2, pos = [], nrm = [], uv = [], idx = [];
  const face = (a, b, c, e, n) => { const k = pos.length / 3; pos.push(...a, ...b, ...c, ...e); for (let i = 0; i < 4; i++) nrm.push(...n); uv.push(0, 1, 1, 1, 1, 0, 0, 0); idx.push(k, k + 1, k + 2, k, k + 2, k + 3); };
  face([-x, 0, z], [x, 0, z], [x, h, z], [-x, h, z], [0, 0, 1]);
  face([x, 0, -z], [-x, 0, -z], [-x, h, -z], [x, h, -z], [0, 0, -1]);
  face([x, 0, z], [x, 0, -z], [x, h, -z], [x, h, z], [1, 0, 0]);
  face([-x, 0, -z], [-x, 0, z], [-x, h, z], [-x, h, -z], [-1, 0, 0]);
  face([-x, h, z], [x, h, z], [x, h, -z], [-x, h, -z], [0, 1, 0]);
  return glbOf(pos, nrm, uv, idx, 'wall');
}

/** A flat ground: a square of `size` metres with its UVs repeating `repeat` times (a GLB built here). */
function planeGlb(size, repeat) {
  const s = size / 2;
  const pos = [-s, 0, -s, s, 0, -s, s, 0, s, -s, 0, s], nrm = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], uv = [0, 0, repeat, 0, repeat, repeat, 0, repeat], idx = [0, 3, 2, 0, 2, 1];
  const bin = new Uint8Array(48 + 48 + 32 + 12 + 4);
  const f = new Float32Array(bin.buffer, 0, 32); f.set(pos, 0); f.set(nrm, 12); f.set(uv, 24);
  new Uint16Array(bin.buffer, 128, 6).set(idx);
  // no picture of its own: the ground texture slot is drawn over it (host.modelTexture)
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'ground', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 48 }, { buffer: 0, byteOffset: 96, byteLength: 32 }, { buffer: 0, byteOffset: 128, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-s, 0, -s], max: [s, 0, s] }, { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' }, { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' }] });
  const full = bin;
  const enc = new TextEncoder().encode(json); const jl = (enc.length + 3) & ~3; const bl = (full.length + 3) & ~3;
  const out = new Uint8Array(12 + 8 + jl + 8 + bl); const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true); out.fill(0x20, 20, 20 + jl); out.set(enc, 20);
  dv.setUint32(20 + jl, bl, true); dv.setUint32(24 + jl, 0x004e4942, true); out.set(full, 28 + jl);
  return out;
}

const SHOTS = {
  // wave 2: the eye over open ground (the texel measure), the pieces at rest, the yard from inside its gate
  ground: { eye: [3.2, 1.75, 6.5], at: [5.5, 0, 2.5], fp: false },
  pieces: { eye: [0, 1.75, 9], at: [0, 0.4, 1.5], fp: true },
  yard: { eye: [0, 1.75, 12], at: [0, 1.5, 0], fp: true },
  hero: { eye: [0, 1.75, 9], at: [0, 1.3, 0], fp: true },
  fight: { eye: [0, 1.75, 6.2], at: [-0.6, 1.3, 1.5], fp: true },
  wide: { eye: [9.5, 6.5, 11], at: [0, 0.8, -2], fp: false },
  close: { eye: [-0.55, 1.62, 4.15], at: [-1.4, 1.5, 2.6], fp: false },
  moon: { eye: [0, 1.7, 7], at: [2.5, 6.3, -9], fp: false },
  bodies: { eye: [0, 1.45, 6.6], at: [0, 1.15, 0], fp: false },
  bench: { eye: [0, 1.75, 9], at: [0, 1.2, -1], fp: true },
  core: { eye: [0, 1.75, 9], at: [0, 1.2, 0], fp: true },
};

async function main() {
  const canvas = document.getElementById('c');
  const size = () => { const dpr = Math.min(devicePixelRatio || 1, 2); canvas.width = Math.round(innerWidth * dpr); canvas.height = Math.round(innerHeight * dpr); host?.resize(canvas.width, canvas.height); };
  let host = null;
  size();
  host = await createHost(canvas);
  size();
  addEventListener('resize', size);
  const r = createRender(host);
  // this page poses the first-person layer itself (a game's follows the core's feel view: forge-web glue.rs)
  r.fp.auto(false);
  const cat = await (await fetch('/library/catalog.json')).json();
  // the look: the preset, the tier, the retro pass on or off
  const lookCfg = look.lookConfig(PRESET);
  // &set=path:value,…: look values over the preset's (a number, true/false, or a string such as a #colour)
  for (const pair of (Q.get('set') ?? '').split(',').filter(Boolean)) {
    const at = pair.indexOf(':'), path = pair.slice(0, at).split('.'), raw = pair.slice(at + 1);
    const value = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    let o = lookCfg; for (const k of path.slice(0, -1)) o = (o[k] ??= {});
    o[path.at(-1)] = value;
  }
  if (!RETRO) lookCfg.retro = { ...lookCfg.retro, texels: false, grain: 0, dither: 0, steps: 0, snap: 0 };
  state.look = lookCfg;
  host.setLook(look.pack(lookCfg, TIER));
  host.lens(68, 0.05, 200);
  host.eyes(false);
  const torch = look.torch(lookCfg);
  // the slot table (each library file a slot, as a game's assets.json would make it)
  const slots = new Map();
  const slotOf = f => { if (!slots.has(f)) slots.set(f, slots.size); return slots.get(f); };
  const models = new Map();
  const modelOf = f => { if (!models.has(f)) models.set(f, (async () => host.model(await bytes(f)))()); return models.get(f); };
  // the fx pictures (fx.* slots)
  await r.fxPictures(Object.fromEntries(await Promise.all(Object.entries(FX_FILES).map(async ([k, f]) => [k, await bytes(f)]))));
  // the ground: a textured plane (texture.ground)
  // the arena as the art library lays it out now (track C3's Meshy props and the hunters; C2's when a catalog lacks it)
  const A = cat.arenaMeshy ?? cat.arenaGrim;
  // the catalog's 60 m square at its texel density, made four times wider so the fog, not an edge, ends the world
  const ground = await host.model(planeGlb(A.ground.size * 4, A.ground.repeat * 4));
  const gfile = Q.get('ground') ? `textures/ground-${Q.get('ground')}.jpg` : A.ground.texture;
  const TILE = Number(Q.get('tile')) || A.ground.size / A.ground.repeat;
  const gtex = await host.texture(await bytes(gfile), 'image/jpeg');
  // a surface as the world gives it (kit/render.js `surface`): a tiling picture laid in world space, so the look's
  // texel density draws it as square texels whatever its resolution
  r.surface(ground.id, { texture: gtex, tile: TILE, space: 'world' });
  host.instance(ground.id, slotOf(gfile), { at: [0, 0, 0] });
  state.surfaces = { ground: gfile, tile: TILE };
  // the ruins: every piece, and a fire light at each socket_flame
  const fires = [];
  const inArena = !['bodies', 'poses'].includes(SHOT);
  // the poses row: walls behind it (+Z), a fire either side
  const prole = cat.roles[ROLE] ?? cat.roles['enemy.skeleton.chaser'];
  const pspan = (((prole.poses ?? [0]).length - 1) / 2) * (prole.height ?? 1.75) * 0.85 + 1.4;
  const posesLayout = [{ file: 'ruins/torch-standing.glb', at: [-pspan, 0, 1.2] }, { file: 'ruins/torch-standing.glb', at: [pspan, 0, 1.2] }, { file: 'ruins/wall.glb', at: [-1.5, 0, 3.6], rot: 180 }, { file: 'ruins/wall-broken.glb', at: [1.5, 0, 3.6], rot: 180 }];
  const pieces = inArena ? A.models : SHOT === 'poses' ? posesLayout : [{ file: 'ruins/torch-standing.glb', at: [-2.6, 0, 3.4] }, { file: 'ruins/torch-standing.glb', at: [2.6, 0, 3.4] }, { file: 'ruins/brazier.glb', at: [0, 0, -1.6] }, { file: 'ruins/wall.glb', at: [-1.5, 0, -3.2] }, { file: 'ruins/wall-broken.glb', at: [1.5, 0, -3.2] }];
  for (const p of pieces) {
    const m = await modelOf(p.file);
    const place = transform({ at: p.at, rot: p.rot ?? 0 });
    host.instance(m.id, slotOf(p.file), { at: p.at, rot: p.rot ?? 0 });
    const flame = r.node(m.id, 'socket_flame');
    if (flame) { const w = mul(place, flame); fires.push({ at: [w[12], w[13], w[14]], seed: fires.length + 1 }); }
  }
  // the yard's walls (wave 2): slabs round the arena with a tiling wall picture laid in world space, as the world's
  // walls will be; and beyond them a ring of dead trees in the backdrop layer (no shadow, the moon and the ambient
  // light only, the look's backdrop fog: silhouettes)
  const YARD = 15;
  if (inArena && Q.get('walls') !== '0') {
    const wfile = `textures/wall-${Q.get('wall') ?? 'blocks'}.jpg`;
    const wtex = await host.texture(await bytes(wfile), 'image/jpeg');
    const slab = await host.model(boxGlb(YARD * 2 + 1, 3.4, 1));
    r.surface(slab.id, { texture: wtex, tile: TILE, space: 'world' });
    // (the far wall leaves the arch its gap)
    for (const [at, rot] of [[[0, 0, YARD], 0], [[-YARD, 0, 0], 90], [[YARD, 0, 0], 90]]) host.instance(slab.id, slotOf(wfile), { at, rot });
    const half = await host.model(boxGlb(YARD - 2.2, 3.4, 1));
    r.surface(half.id, { texture: wtex, tile: TILE, space: 'world' });
    for (const x of [-(YARD + 2.2) / 2 - 0.4, (YARD + 2.2) / 2 + 0.4]) host.instance(half.id, slotOf(wfile), { at: [x, 0, -YARD], rot: 0 });
    state.surfaces.wall = wfile;
  }
  const NBACK = inArena ? Number(Q.get('backdrop') ?? 80) : 0;
  state.backdrop = [];
  if (NBACK > 0) {
    const tree = await modelOf(Q.get('tree') ?? 'ruins/grim-tree.glb').catch(() => null);
    const stone = await modelOf('ruins/wall-broken.glb').catch(() => null);
    let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < NBACK; i++) {
      const a = rnd() * Math.PI * 2, d = YARD + 4 + rnd() * rnd() * 46, m = i % 7 === 6 ? stone : tree;
      if (!m) continue;
      const id = host.instance(m.id, slotOf(m === tree ? 'backdrop/tree' : 'backdrop/ruin'), { at: [Math.sin(a) * d, 0, Math.cos(a) * d], rot: rnd() * 360, scale: m === tree ? 1.6 + rnd() * 1.8 : 1 + rnd() });
      if (Q.get('backdrop-layer') !== '0') r.backdrop(id);
      state.backdrop.push(id);
    }
  }
  // loose pieces at rest (wave 2): the debris models a fight registers (kit/wear.js DEBRIS), then `pieces` of them laid
  // as kills leave them (forge-web debug_pieces: each a core entity the renderer draws by its class and type)
  const NPIECES = Number(Q.get('pieces') ?? (SHOT === 'pieces' ? 400 : 0));
  const layPieces = async n => {
    if (!state.debris) {
      const { fitTo } = await import('/kit/render.js');
      for (const [file, types] of [['ruins/skull.glb', [[0, 0.22]]], ['ruins/ribcage.glb', [[1, 0.3]]], ['ruins/bone-a.glb', [[2, 0.26], [3, 0.16], [4, 0.07]]]]) {
        const m = await modelOf(file);
        for (const [type, size] of types) r.entityModel(4, type, m.id, slotOf(file), { fit: fitTo(m.bounds, { size, alongZ: type >= 2 }) });
      }
      state.debris = true;
    }
    return r.pieces(n, { at: [0, 1.5], radius: 9 });
  };
  if (NPIECES > 0) state.pieces = await layPieces(NPIECES);
  // the clips and the bodies
  const clips = await host.animClips(await bytes(cat.roles['clips.humanoid'].file));
  const bodies = new Map();
  const bodyOf = f => { if (!bodies.has(f)) bodies.set(f, (async () => r.body(await bytes(f), slotOf(f)))()); return bodies.get(f); };
  const actors = [];
  const spawn = async (role, at, rot, clip, t, { loop = true, rate = 1 } = {}) => {
    const b = await bodyOf(role.body);
    const id = r.puppet(b.body, clips, { at, rot });
    r.pose(id, clip, { t, loop, rate });
    if (role.eyes) r.glow(id, role.eyes.color, role.eyes.rest, 0);
    // a co-op hunter: its player_tint cloth in its seat's colour
    if (role.tint) r.cloth(id, role.tint);
    for (const h of Object.values(role.held ?? {})) {
      const m = await modelOf(h.file);
      r.attach(id, m.id, slotOf(h.file), h.grip.socket, h.grip);
    }
    actors.push({ id, role, at, rot, clip, alive: true });
    return id;
  };
  // shot=core: the core's own entities, drawn by the renderer as a game draws them (forge-ai's spawn command walks
  // each enemy to the player; the core's HIT flashes it, its KILL puts its eyes out)
  const core = { on: SHOT === 'core', enemies: new Map(), spawnT: 0.2, hitT: 1 };
  if (core.on) {
    host.loadTables({ enemies: [{ id: 'chaser', health: 30, speed: 2.2 }, { id: 'soldier', health: 30, speed: 1.6 }] });
    host.cmd.box([-60, -1, -60], [60, 0, 60]);
    host.cmd.spawn(1, { x: 0, y: 0.05, z: 9 }, 0, true);
    const roles = [cat.roles['enemy.skeleton.chaser'], cat.roles['enemy.skeleton.shield']];
    const kinds = await Promise.all(roles.map(async role => ({ role, b: await bodyOf(role.body) })));
    host.on('spawn', e => {
      if (e.entityKind !== 2) return;
      const k = kinds[e.type % kinds.length];
      host.animate(e.id, k.b.body, clips, { hurt: true });
      host.animPlay(e.id, k.role.clips.move ?? 'walk', { loop: true, fade: 0 });
      if (k.role.eyes) r.glow(e.id, k.role.eyes.color, k.role.eyes.rest, 0);
      core.enemies.set(e.id, { id: e.id, role: k.role, hp: 30 });
    });
    host.on('kill', e => { const x = core.enemies.get(e.target); if (!x) return; r.burst('dust', { at: e.point, count: 12 }); r.burst('bone', { at: e.point, count: 14 }); setTimeout(() => { host.cmd.despawn(e.target); core.enemies.delete(e.target); }, 600); });
    core.step = dt => {
      core.spawnT -= dt; core.hitT -= dt;
      if (core.spawnT <= 0 && core.enemies.size < 6) { core.spawnT = 1.4; const a = Math.random() * 2 - 1; host.cmd.raw(96, [core.enemies.size % 2], [a * 5, 0.05, -6 - Math.random() * 3, 0]); }
      if (core.hitT <= 0 && core.enemies.size) { core.hitT = 0.8; const id = [...core.enemies.keys()][0]; host.cmd.damage(id, 10, 1, [0, 0, -1]); }
    };
  }
  if (SHOT === 'core') {
    // no puppets: every body here is a core entity
  } else if (SHOT === 'body') {
    // one body file three ways: as a static model (its file pose), bound at the standard rest, and playing idle
    const file = Q.get('file') ?? 'bodies/hunter-hooded.glb';
    const m = await modelOf(file);
    host.instance(m.id, slotOf(file), { at: [-1.6, 0, 0] });
    const b = await bodyOf(file);
    const a = r.puppet(b.body, clips, { at: [0, 0, 0] }); r.rest(a);
    const c = r.puppet(b.body, clips, { at: [1.6, 0, 0] }); r.pose(c, 'idle', { t: 0.5, rate: 0 });
    SHOTS.body = { eye: [0, 1.0, 4.2], at: [0, 0.9, 0], fp: false };
  } else if (SHOT === 'poses') {
    // one role's body in its catalog poses, side by side (the library's bodies sheets, drawn by forge)
    const role = cat.roles[ROLE] ?? cat.roles['enemy.skeleton.chaser'];
    const poses = role.poses ?? [{ clip: 'idle', at: 0.5 }];
    const gap = (role.height ?? 1.75) * 0.85;
    // the row faces −Z and the camera looks back along +Z: the moon (toward −Z) is behind it and lights their fronts
    for (const [i, p] of poses.entries()) await spawn(role, [-(i - (poses.length - 1) / 2) * gap, 0, 0], 180, p.clip, r.poseTime(clips, p.clip, p.at), { loop: false, rate: 0 });
    const half = ((poses.length - 1) / 2) * gap + gap * 0.6, h = role.height ?? 1.75;
    const d = Math.max(half / Math.tan((50 * Math.PI) / 180) * 1.05, h * 1.2);
    SHOTS.poses = { eye: [0, h * 0.62, -d], at: [0, h * 0.5, 0], fp: false };
    state.posed = poses.map(p => `${p.clip} @ ${typeof p.at === 'number' ? `${p.at}s` : p.at}`);
  } else if (SHOT === 'bodies') {
    const ids = ['enemy.skeleton.chaser', 'enemy.skeleton.ranged', 'enemy.skeleton.shield', 'enemy.skeleton.brute', 'enemy.skeleton.boss'];
    for (const [i, k] of ids.entries()) await spawn(cat.roles[k], [-4.4 + i * 2.2, 0, 0], 0, 'idle_combat', 0.4 + i * 0.3);
  } else {
    for (const b of A.bodies.filter(b => !b.compare)) await spawn(b.role, b.at, b.rot ?? 0, b.clip ?? 'idle_combat', b.t ?? 0);
    if (SHOT === 'bench') {
      // the PLAN §5 budget scene: 20 skinned bodies in all
      const roles = ['enemy.skeleton.chaser', 'enemy.skeleton.ranged', 'enemy.skeleton.shield', 'enemy.skeleton.brute'];
      for (let i = actors.length; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2, rr = 3 + (i % 3) * 1.6;
        await spawn(cat.roles[roles[i % roles.length]], [Math.sin(a) * rr, 0, -2 + Math.cos(a) * rr * 0.7], deg(a) + 180, i % 2 ? 'run' : 'walk', i * 0.13);
      }
    }
  }
  // the first-person layer: the arms and a weapon (its catalog hold)
  // the art library's first-person weapons (catalog roles weapon.*: the Meshy ones since track C3)
  const WEAPONS = { shotgun: cat.roles['weapon.shotgun'].file, pistol: cat.roles['weapon.pistol'].file, mg: cat.roles['weapon.mg'].file, melee: cat.roles['weapon.melee'].file, focus: cat.roles['weapon.focus'].file };
  const wfile = WEAPONS[WEAPON] ?? WEAPONS.shotgun, wsec = cat.sections.weapons[wfile];
  const arms = await modelOf(cat.roles['fp.arms'].file);
  const gun = await modelOf(wfile);
  r.fp.arms(arms.id, slotOf(cat.roles['fp.arms'].file));
  r.fp.weapon(0, gun.id, slotOf(wfile), wsec.hold.arm_r, wsec.hands === 2);
  r.fp.sleeve('#3a5a3c');
  const shot = SHOTS[SHOT] ?? SHOTS.hero;
  const setShot = name => {
    SHOT = name; const s = SHOTS[name] ?? SHOTS.hero; const { yaw, pitch } = lookAt(s.eye, s.at);
    host.pose(s.eye[0], s.eye[1], s.eye[2], yaw, pitch);
    r.fp.visible(FP && s.fp);
    state.eye = s.eye;
  };
  setShot(SHOT);
  // the core's shot looks from the core's own player (its body is not drawn while the camera is its eyes)
  if (core.on) host.eyes(true);
  // ---- effects: shots, hits, kills, the eyes' tell ----
  const kick = { a: 0, v: 0 };
  const target = () => actors.find(a => a.alive && a.role.body.includes('chaser')) ?? actors[0];
  const fire = () => {
    state.shots++;
    const s = r.fp.sockets();
    const eye = state.eye, { yaw, pitch } = lookAt(SHOTS[SHOT].eye, SHOTS[SHOT].at);
    const fwd = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    // the muzzle light: warm, 3.4 m, ~1 m in front of the eye, 4 frames (feel targets 6 and 8)
    r.light({ at: [eye[0] + fwd[0], eye[1] + fwd[1] - 0.15, eye[2] + fwd[2]], color: [1, 0.48, 0.13], radius: 3.4, intensity: 1.8, frames: 4 });
    const t0 = target();
    if (s.muzzle && Q.get('tracers') !== '0') {
      // a streak from the muzzle to what it hits (a scattergun: a fan of pellets, thinner and paler)
      const end = t0 ? [t0.at[0], 1.25, t0.at[2]] : [eye[0] + fwd[0] * 30, eye[1] + fwd[1] * 30, eye[2] + fwd[2] * 30];
      const pellets = WEAPON === 'shotgun' ? 7 : 1;
      for (let k = 0; k < pellets; k++) {
        const j = pellets > 1 ? [(Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.1, (Math.random() - 0.5) * 1.6] : [0, 0, 0];
        r.tracer({ from: s.muzzle.world, to: [end[0] + j[0], end[1] + j[1], end[2] + j[2]], color: pellets > 1 ? [1, 0.82, 0.55] : [1, 0.33, 0.05], width: pellets > 1 ? 0.012 : 0.02, seconds: 0.05 });
      }
    }
    if (s.muzzle) {
      r.burst('muzzle', { at: s.muzzle.world, count: 1 });
      r.burst('smoke', { at: s.muzzle.world, dir: fwd, count: 3 });
      r.burst('sparks', { at: s.muzzle.world, dir: fwd, count: 4, speed: 4 });
    }
    kick.v += 22;
    const t = target();
    if (t) {
      const hit = [t.at[0], 1.25, t.at[2]];
      const back = [eye[0] - hit[0], 0, eye[2] - hit[2]];
      r.burst('sparks', { at: hit, dir: back, count: 8 });
      r.burst('impact', { at: hit, count: 1 });
      r.light({ at: hit, color: [1, 0.32, 0.06], radius: 2.5, intensity: 1.17, frames: 4 });
      r.flash(t.id, '#ffffff', 1, 0.05);
      if (state.shots % 4 === 0 && SHOT !== 'bench') kill(t);
    }
  };
  const kill = t => {
    state.kills++;
    t.alive = false; r.show(t.id, false);
    const at = [t.at[0], 1.0, t.at[2]];
    r.burst('dust', { at, count: 12 }); r.burst('bone', { at, count: 16 }); r.burst('sparks', { at, count: 10, speed: 5, spread: 3.2 });
    r.light({ at, color: [1, 0.32, 0.06], radius: 2.5, intensity: 1.4, frames: 4 });
    setTimeout(() => { t.alive = true; r.show(t.id, true); r.pose(t.id, 'emerge', { loop: false }); setTimeout(() => r.pose(t.id, t.clip, { loop: true, fade: 0.25 }), 1000); }, 1800);
  };
  const teller = actors.find(a => a.clip === 'windup');
  let tellT = 0, fireT = 0.6, benchT = 0;
  // the bench's 8 fire lights: the arena's four and four lanterns around the crowd
  if (SHOT === 'bench') for (const at of [[-5, 1.6, 2], [5, 1.6, 2], [-5, 1.6, -5], [5, 1.6, -5]]) fires.push({ at, seed: fires.length + 1 });
  // ---- the frame ----
  let last = null, t = 0;
  const frame = now => {
    const c0 = performance.now();
    try {
      const dt = last === null ? 0 : Math.min(0.1, (now - last) / 1000); last = now; t += dt;
      if (FX && ['hero', 'fight', 'bench'].includes(SHOT)) {
        fireT -= dt; if (fireT <= 0) { fire(); fireT = SHOT === 'bench' ? 0.25 : 1.1; }
        // the bench: 30 bursts a second over the crowd (with the shots' own, about 30 alive at once)
        if (SHOT === 'bench') { benchT += dt * 30; while (benchT >= 1) { benchT -= 1; const a = actors[(Math.random() * actors.length) | 0]; r.burst(['sparks', 'dust', 'bone', 'smoke', 'blood'][(Math.random() * 5) | 0], { at: [a.at[0], 1 + Math.random(), a.at[2]] }); } }
        if (teller && teller.role.eyes) {
          tellT += dt;
          if (tellT > 1.6) { tellT = 0; r.glow(teller.id, teller.role.eyes.color, teller.role.eyes.rest, 0); r.pose(teller.id, 'windup', { t: 0, loop: false }); r.glow(teller.id, teller.role.eyes.color, teller.role.eyes.tell, 0.3); }
          else if (tellT > 0.3 && tellT - dt <= 0.3) { r.glow(teller.id, teller.role.eyes.color, teller.role.eyes.rest, 0); r.pose(teller.id, 'lunge', { loop: false }); }
        }
      }
      // the weapon's kick: a fast spring (the viewmodel snaps up and is back in ~0.1 s)
      const w0 = 2 * Math.PI * 4;
      kick.v += (-(w0 * w0) * kick.a - 2 * 0.75 * w0 * kick.v) * dt; kick.a += kick.v * dt;
      r.fp.pose({ at: [0, kick.a * 0.012, kick.a * 0.03], rot: [kick.a * 6, 0, 0] });
      if (core.on) { core.step(dt); host.tick(dt); host.route({}, null, { local: 1 }); }
      host.setLights(fires.map(f => ({ x: f.at[0], y: f.at[1], z: f.at[2], range: torch.range, color: torch.color, intensity: torch.intensity * look.flicker(t, f.seed, torch.flicker) })));
      host.render(t);
      if (++state.drawn >= 4) state.ready = true;
      if (hud.style.display !== 'none' && state.drawn % 15 === 0) { const s = r.stats(); hud.textContent = `${PRESET} · ${TIER} · retro ${RETRO ? 'on' : 'off'} · ${SHOT}\n${s.width}×${s.height} · ${s.draws} draws · ${s.passes} passes · ${s.actors} bodies · ${s.particles} particles · ${s.lights} lights · shadow ${s.shadow}`; }
    } catch (e) { fail(e); return; }
    const f = state.frames; f.cost.push(performance.now() - c0); f.at.push(c0); if (f.at.length > 2000) { f.cost.splice(0, 1000); f.at.splice(0, 1000); }
    requestAnimationFrame(frame);
  };
  state.drawn = 0;
  requestAnimationFrame(frame);
  window.__lookdev = { look: () => state.look, surfaces: () => state.surfaces, pieces: layPieces, backdropIds: () => state.backdrop, posed: () => state.posed ?? null, get ready() { return state.ready; }, get error() { return state.error; }, preset: PRESET, tier: TIER, retro: RETRO, get shot() { return SHOT; }, stats: () => r.stats(), frames: state.frames, fire, shotTo: setShot, info: () => host.info(), slots: () => [...slots.keys()], coverage: () => host.report(), sight: ids => host.sight(ids), render: r, host };
}

main().catch(fail);
