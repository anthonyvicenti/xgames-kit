// gf-three voxel world (research/worlds/PLAN.md; CONTRACT §9): a block world that players change and the play host
// keeps. config/world.json → { template: 'voxel', voxel: { size, blocks, textures, faces, paint, terrain, light, protect,
// floor, ... } }.
//
//   loadWorld(ctx, cfg)   generates the land (terrain.mjs: biomes, caves, ores, trees; deterministic from the seed),
//                         lays the saved world over it (kit/net/persist.js: the play host's snapshot and the edits after
//                         it), lights it (light.mjs: sunlight and coloured block light), meshes it in 16³ chunks on a few
//                         workers (mesh-worker.js: smooth light and AO per vertex, one texture array for every block
//                         face), draws the same land on past the edge as scenery fading into the haze, and gives it one
//                         Rapier voxel collider that follows every edit. → ctx.world, with the kit's world API (spawn,
//                         zone, bounds, raycast, update) plus world.voxel (below)
//   slotsFor(cfg)         the world's slots: one image slot per block texture, the paint colours, water and sign ink
//
// world.voxel:
//   grid, table, light    the cells (grid.mjs VoxelGrid), the block table (blocks.mjs) and the light (light.mjs)
//   apply(x, y, z, v, {text, face})   change one cell everywhere this copy shows it (mesh, light, collider, sign) → the
//                         old {v, sign}; the build mechanic decides who may (kit/mechanics/build)
//   pick(from, dir, max)  the cell and face a ray meets first (any block, plants and signs included)
//   lightAt(x, y, z)      { sun, r, g, b } 0-1 at a cell (a game can light its own things by it)
//   protectedAt(x, y, z)  inside a protect box or below the floor
//   remeshNow(x, y, z)    relight and re-mesh round a cell this frame (a player's own edit shows at once)
//   store                 the world store client (kit/net/persist.js); loaded: {seq, mode, missing, error}
//   onApply(fn)           fn(x, y, z, v, old) after every apply
//   setLight(partial)     the cave's own light, live: { cave, block, spread, caveLight: {color, strength}, caveFog } over
//                         config/world.json → voxel.light (the look judge's tuning loop moves them with the cave in view)
// world.place(setting)    a camera place that shows 'cave' or 'day' (places.mjs: the voxel bench's finders) → { eye,
//                         target, fov } | null (builder/look: a cave reference is judged against a frame in a cave)
//
// voxel.faces { size: 32, filter: 'pixel' | 'smooth' }: block faces drawn at `size` texels; 'pixel' keeps every texel a
// crisp square up close (the kit's own faces), 'smooth' filters them (painted faces; 512 on high, 256 on low).
// voxel.light { cave: 0.04 (how much of the sky's light reaches where no sun does), block: 1.6 (how bright lamps are),
// spread: 1.6 (block light 0-1 → this power of it: lower spreads it wider and softer), caveLight: { color, strength }
// (a cool, even glow where no sky reaches, so walls keep their shape in the dark),
// haze: [16, 1] (the scenery past the edge fades into the haze from 16 cells out to its far end), caveFog: '#07090d'
// (the haze's colour where the camera has no sky above it) }. world.lightAt(x, y, z) is the light a body takes there.
// Terrain is generator version `voxel.terrain.generator` (2): the play host keeps only the cells players changed, so the
// same seed and version must give the same land forever. A change to terrain.mjs's output is a new version.
import * as THREE from 'three';
import { VoxelGrid, CHUNK, chunkKey, FACES } from './grid.mjs';
import { blockTable, FACE_SIZES } from './blocks.mjs';
import { generateTerrain, landOutside } from './terrain.mjs';
import { VoxelLight } from './light.mjs';
import { meshChunk, mergeMeshes, BUCKETS } from './mesh.mjs';
import { createSigns } from './signs.js';
import { material } from '../../look/materials.js';
import { WORLD_GROUPS } from '../../core/util.js';
import { createWorldStore } from '../../net/persist.js';
import { placeFor } from './places.mjs';

export const templates = ['voxel'];
// The size a smooth block face is drawn at, by quality tier (blocks.mjs FACE_SIZES: 512 high, 256 low). 32 faces at 512
// with their mipmaps are about 43 MB of GPU memory, at 256 about 11 MB; pixel faces at 32 are a fraction of a megabyte.
const texSizeOf = (V, quality) => (V.faces?.filter === 'pixel' ? V.faces.size ?? 32 : FACE_SIZES[quality?.name ?? quality] ?? FACE_SIZES.high);
const DBG = typeof location !== 'undefined' && /gf-voxdbg=1/.test(location.search);
// how far chunks are drawn and how wide the scenery past the edge is, by quality tier (cells)
const VIEW = { high: { far: 200, skirt: 1, shadow: 44 }, low: { far: 110, skirt: 0.5, shadow: 28 } };

export function slotsFor(cfg) {
  const V = cfg.voxel ?? {};
  const out = [];
  const names = Object.keys(V.textures ?? {});
  const pixel = V.faces?.filter === 'pixel';
  names.forEach((name, i) => out.push({
    id: `world.voxel.texture.${name}`, label: `Block texture: ${name.replace(/-/g, ' ')}`, group: 'world', type: 'image', facet: 'look',
    tier: i < 12 ? 'main' : 'advanced', rank: 20 + i,
    source: { file: V.textures[name] }, constraints: { colorSpace: 'srgb', formats: ['png', 'jpg', 'webp'], square: true, tile: true },
    description: pixel
      ? `A square block face, drawn as ${V.faces.size ?? 32}×${V.faces.size ?? 32} crisp pixels (bigger pictures are shrunk to that). Faces with transparency (leaves, glass, plants) keep it; on solid faces half-transparent pixels take the biome's grass colour.`
      : `A square block face (${FACE_SIZES.high}×${FACE_SIZES.high} is drawn, ${FACE_SIZES.low}×${FACE_SIZES.low} on low graphics; other sizes are resampled, so give ${FACE_SIZES.high} or more for a sharp face). Faces with transparency (leaves, glass, plants) keep it.`,
    generate: { prompt: `a square, seamless ${pixel ? '32 × 32 pixel-art' : 'stylised'} voxel block face: ${name.replace(/-/g, ' ')}`, style: pixel ? 'pixel art, limited palette, no perspective, no lighting' : 'flat colours, soft shapes, no perspective, no lighting' },
  }));
  out.push(
    { id: 'world.voxel.blocks', label: 'Block list', group: 'world', type: 'json', facet: 'gameplay', tier: 'advanced', source: { file: 'config/world.json', pointer: '/voxel/blocks' }, description: 'Every block: id, label, kind, textures, light. Ids are numbered in order and saved worlds keep the numbers, so only add at the end.' },
    { id: 'world.voxel.paint', label: 'Paint colours', group: 'world', type: 'colors', facet: 'look', tier: 'main', rank: 40, source: { file: 'config/world.json', pointer: '/voxel/paint' } },
    { id: 'world.voxel.sign-ink', label: 'Sign writing colour', group: 'world', type: 'color', facet: 'look', tier: 'advanced', source: { file: 'config/world.json', pointer: '/voxel/signInk' } },
    { id: 'world.voxel.sign-paper', label: 'Sign panel colour', group: 'world', type: 'color', facet: 'look', tier: 'advanced', source: { file: 'config/world.json', pointer: '/voxel/signPaper' } },
    { id: 'world.voxel.terrain', label: 'Land shape', group: 'world', type: 'json', facet: 'gameplay', tier: 'advanced', source: { file: 'config/world.json', pointer: '/voxel/terrain' }, description: 'The generated land (seed, biomes, hills, mountains, caves, trees). Changing it changes the land under every saved build: only before a world is played.' },
  );
  return out;
}

export async function loadWorld(ctx, cfg) {
  const V = cfg.voxel;
  if (!V?.size) throw new Error('gf-three voxel: config/world.json needs voxel.size');
  const tierName = ctx.quality?.name ?? ctx.quality ?? 'high';
  const tier = VIEW[tierName] ?? VIEW.high;
  const table = blockTable(V);
  const grid = new VoxelGrid({ size: V.size, info: table.info, tints: table.tints });
  const [sx, sy, sz] = grid.size;
  const t0 = performance.now();
  const T = generateTerrain(grid, table, V.terrain ?? {});
  grid.outside = landOutside(T.model);
  const genMs = Math.round(performance.now() - t0);
  const signN = V.signBlock ? table.byId.get(V.signBlock)?.n ?? 0 : 0;
  const floor = V.floor ?? 1;
  const protect = (V.protect ?? []).map(b => ({ min: b.min, max: b.max, why: b.why ?? '' }));
  const root = new THREE.Group(); root.name = 'gf-voxel-world';
  ctx.scene?.add(root);

  // ---- the saved world: the play host's snapshot, then every edit after it ----
  const signsData = new Map();
  if (T.sign && signN && V.terrain?.plaza?.signText) {
    grid.put(...T.sign.cell, signN);
    signsData.set(grid.index(...T.sign.cell), { text: V.terrain.plaza.signText, face: T.sign.face });
  }
  const store = createWorldStore({ fetchFn: ctx.worldFetch ?? globalThis.fetch?.bind(globalThis), slug: ctx.worldSlug !== undefined ? ctx.worldSlug : undefined });
  const loaded = { seq: 0, mode: store.mode, missing: false, error: null, cells: 0, edits: 0, ms: 0 };
  const welcome = new Map(signsData);
  /** Lay the play host's world over the generated land: its snapshot's cells and signs, then the edits after it. */
  async function loadSaved() {
    const ta = performance.now();
    try {
      const w = await store.load();
      loaded.mode = w.mode; loaded.missing = !!w.missing; loaded.seq = w.seq;
      for (const [i, v] of w.cells) { if (i >= 0 && i < grid.data.length) { grid.data[i] = v; if (v !== signN || !signN) signsData.delete(i); } }
      for (const [i, s] of w.signs) if (signN && (grid.data[i] & 255) === signN) signsData.set(i, s);
      for (const e of w.edits) {
        const [, , x, y, z, v, text, face] = e;
        if (!grid.inBounds(x, y, z)) continue;
        const i = grid.index(x, y, z);
        grid.data[i] = v;
        if (signN && (v & 255) === signN && typeof text === 'string') signsData.set(i, { text, face: face ?? 5 }); else signsData.delete(i);
      }
      loaded.cells = w.cells.length; loaded.edits = w.edits.length; loaded.error = null;
    } catch (e) {
      loaded.error = String(e.message ?? e);
      console.warn(`gf-three voxel: the saved world did not load (${loaded.error}); showing the land as generated`);
    }
    loaded.ms = Math.round(performance.now() - ta);
  }
  await loadSaved();

  // ---- light: the sky and every lamp, over the land as saved ----
  const light = new VoxelLight(grid);
  const tl = performance.now(); light.computeAll(); const lightMs = Math.round(performance.now() - tl);

  // ---- textures: every block face in one texture array (no atlas bleeding at a distance) ----
  const { texture: arrayTex, images: textureImages, averages } = await buildTextureArray(ctx, table.textures, V, tierName);
  const signTex = signN ? await ctx.assets?.texture?.(`world.voxel.texture.${table.list[signN - 1].tex.side}`).catch(() => null) : null;

  // ---- materials: one per kind; the house 'prop' lighting, the block light and the haze past the edge ----
  const LV = { cave: 0.06, block: 1.6, spread: 1.6, haze: [16, 1], caveLight: { color: '#4a5f86', strength: 0.1 }, ...(V.light ?? {}) };
  // the cave's own light: a cool, even glow where no sky reaches (as a player's eyes adjust), so walls keep their shape
  // in the dark; linear rgb, already times its strength
  const caveLight = new THREE.Color(LV.caveLight?.color ?? '#4a5f86').multiplyScalar(LV.caveLight?.strength ?? 0);
  const skirt = Math.round((V.terrain?.far ?? 48) * tier.skirt);
  const shared = {
    uGfBlocks: { value: arrayTex }, uGfCave: { value: LV.cave }, uGfBlockLight: { value: LV.block }, uGfSpread: { value: LV.spread }, uGfCaveLight: { value: caveLight },
    uGfBox: { value: new THREE.Vector4(0, 0, sx, sz) }, uGfHaze: { value: new THREE.Vector2(LV.haze[0], Math.max(LV.haze[0] + 1, skirt * LV.haze[1])) },
    uGfTexSize: { value: arrayTex.image.width }, uGfGlow: { value: V.glow ?? 1.6 },
  };
  const mats = Object.fromEntries(BUCKETS.map(k => [k, k === 'liquid' ? waterMaterial(shared) : voxelMaterial(k, shared, V)]));

  // ---- what a player holds (the build mechanic's first-person view): a block of the world's own, or a pick to break
  // with, drawn with the blocks' materials and lit by the light where it is (relight) ----
  const cubes = (parts, { tint = [0, 0, 0], biome = [255, 255, 255], glow = 0 } = {}) => {
    const P = [], N = [], C = [], UV = [], TI = [], L = [], BI = [], GL = [], I = [];
    for (const { size, at, layers } of parts) for (const F of FACES) {
      const base = P.length / 3;
      for (const { pos, uv } of F.corners) {
        P.push(at[0] + (pos[0] - 0.5) * size[0], at[1] + (pos[1] - 0.5) * size[1], at[2] + (pos[2] - 0.5) * size[2]);
        N.push(F.dir[0] * 127, F.dir[1] * 127, F.dir[2] * 127); C.push(255, 255, 255); UV.push(uv[0], uv[1], layers[F.layer]);
        TI.push(...tint); L.push(255, 0, 0, 0); BI.push(...(F.layer === 'bottom' ? [255, 255, 255] : biome)); GL.push(glow);
      }
      I.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
    return { count: P.length / 3, position: new Float32Array(P), normal: new Int8Array(N), color: new Uint8Array(C), uvl: new Uint8Array(UV), tint: new Uint8Array(TI), light: new Uint8Array(L), biome: new Uint8Array(BI), glow: new Uint8Array(GL), index: new Uint16Array(I) };
  };
  const plaza0 = (T.plaza.at[1] * sx + T.plaza.at[0]) * 6;
  /** A mesh of what a player holds: { block: cell value } or { tool: 'pick' }; mesh.userData.relight(x, y, z) lights it
   *  by the cells round a point (call it each frame with the hand's position). */
  function heldMesh(what) {
    let res, kind = 'solid';
    if (what?.tool === 'pick') {
      const L = n => table.layerOf.get(n) ?? 0, wood = L('log-side'), head = L('stone');
      res = cubes([{ size: [0.14, 1.0, 0.14], at: [0, -0.05, 0], layers: { side: wood, top: wood, bottom: wood } },
        { size: [0.8, 0.18, 0.2], at: [0, 0.48, 0], layers: { side: head, top: head, bottom: head } },
        { size: [0.2, 0.14, 0.16], at: [0.48, 0.38, 0], layers: { side: head, top: head, bottom: head } }, { size: [0.2, 0.14, 0.16], at: [-0.48, 0.38, 0], layers: { side: head, top: head, bottom: head } }]);
    } else {
      const v = what?.block ?? 0, b = v & 255, I = table.info[b]; if (!I) return null;
      const t = table.tints[v >> 8], tint = t ? t.map(c => Math.round(c * 255)) : [0, 0, 0];
      const bio = I.tint && grid.biome ? (I.tint === 'foliage' ? [...grid.biome.slice(plaza0 + 3, plaza0 + 6)] : [...grid.biome.slice(plaza0, plaza0 + 3)]) : [255, 255, 255];
      kind = I.kind === 'plant' || I.kind === 'sign' ? 'plant' : I.kind === 'liquid' ? 'glass' : I.kind;
      const glow = I.kind === 'glow' || I.emit ? 255 : 0;
      if (kind === 'plant') {
        const s = I.layers.side, q = cubes([{ size: [1, 1, 0.001], at: [0, 0, 0], layers: { side: s, top: s, bottom: s } }], { tint, biome: bio, glow });
        res = q;
      } else res = cubes([{ size: [1, 1, 1], at: [0, 0, 0], layers: I.layers }], { tint, biome: bio, glow });
    }
    const m = new THREE.Mesh(geometryOf(res), mats[kind] ?? mats.solid);
    m.name = 'held'; m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
    m.userData.gfSlot = 'world.voxel.blocks';
    const attr = m.geometry.getAttribute('gfLight');
    m.userData.relight = (x, y, z) => {
      const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5), z0 = Math.floor(z - 0.5);
      let S = 0, R = 0, Gn = 0, Bl = 0, n = 0;
      for (let k = 0; k < 8; k++) {
        const X = x0 + (k & 1), Y = y0 + ((k >> 1) & 1), Z = z0 + ((k >> 2) & 1);
        if (grid.inBounds(X, Y, Z) && table.info[grid.data[grid.index(X, Y, Z)] & 255]?.opaque) continue;
        const w = light.at(X, Y, Z); S += w >> 12; R += (w >> 8) & 15; Gn += (w >> 4) & 15; Bl += w & 15; n++;
      }
      const f = n ? 1 / (15 * n) : 0;   // the attribute is normalised: 0-1
      for (let i = 0; i < attr.count; i++) attr.setXYZW(i, S * f, R * f, Gn * f, Bl * f);
      attr.needsUpdate = true;
    };
    return m;
  }

  // ---- chunk meshes ----
  const chunks = new Map(), farMeshes = [];
  let cullAt = null;   // the camera cell the chunks were last culled for (null: cull again)
  const blockSlot = 'world.voxel.blocks';
  const geometryOf = (b, liquid = false) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(b.normal, 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(b.color, 3, true));
    g.setAttribute('gfUvl', new THREE.BufferAttribute(b.uvl, 3, false));
    g.setAttribute('gfTint', new THREE.BufferAttribute(b.tint, 3, true));
    g.setAttribute('gfLight', new THREE.BufferAttribute(b.light, 4, true));
    g.setAttribute('gfBiome', new THREE.BufferAttribute(b.biome, 3, true));
    g.setAttribute('gfGlow', new THREE.BufferAttribute(b.glow, 1, true));
    g.setIndex(new THREE.BufferAttribute(b.index, 1));
    if (liquid) {
      // the look's water material reads uv (its ripples are in world space)
      const uv = new Float32Array(b.count * 2);
      for (let i = 0; i < b.count; i++) { uv[i * 2] = b.position[i * 3]; uv[i * 2 + 1] = b.position[i * 3 + 2]; }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  };
  function meshesOf(res, key, far) {
    const out = [];
    for (const k of BUCKETS) {
      const b = res[k]; if (!b?.count) continue;
      const m = new THREE.Mesh(geometryOf(b, k === 'liquid'), mats[k]);
      m.name = `${far ? 'far ' : ''}chunk ${key} ${k}`;
      m.castShadow = !far && k !== 'glass' && k !== 'plant' && k !== 'liquid'; m.receiveShadow = !far;
      if (k === 'glass' || k === 'liquid') m.renderOrder = 1;
      // (the water's colours are the look's water slots: look.materials.water.shallow / deep)
      m.userData.gfSlot = k === 'liquid' ? 'look.materials.water.shallow' : blockSlot;
      m.userData.gfChunk = key;
      m.matrixAutoUpdate = false; m.updateMatrix();
      root.add(m); out.push(m);
    }
    return out;
  }
  // the play grid is drawn a column of chunks at a time (16 × 16 cells, every height): a few hundred draws for the whole
  // world, and one edit re-meshes one column (a few ms)
  const columnKey = (cx, cz) => `${cx},${cz}`;
  function setColumn(cx, cz, res) {
    const key = columnKey(cx, cz), old = chunks.get(key);
    if (old) for (const m of old) { m.geometry.dispose(); m.removeFromParent(); }
    const meshes = meshesOf(res, key, false);
    if (meshes.length) chunks.set(key, meshes); else chunks.delete(key);
    for (let cy = 0; cy < grid.cy; cy++) grid.dirty.delete(chunkKey(cx, cy, cz));
    cullAt = null;
  }
  const meshColumn = (cx, cz) => mergeMeshes(Array.from({ length: grid.cy }, (_, cy) => meshChunk(grid, light, cx, cy, cz)));
  const buildColumn = (cx, cz) => setColumn(cx, cz, meshColumn(cx, cz));

  // the first mesh of everything, and the scenery round the edge, on workers (the main thread when there are none)
  const tm = performance.now();
  const all = [];
  for (let cx = 0; cx < grid.cx; cx++) for (let cz = 0; cz < grid.cz; cz++) all.push([cx, cz]);
  const mid = [T.plaza.at[0] / CHUNK, T.plaza.at[1] / CHUNK];
  all.sort((a, b) => (a[0] - mid[0]) ** 2 + (a[1] - mid[1]) ** 2 - ((b[0] - mid[0]) ** 2 + (b[1] - mid[1]) ** 2));
  const strips = skirt > 0 ? [
    { ox: -skirt, oz: -skirt, w: sx + 2 * skirt, d: skirt }, { ox: -skirt, oz: sz, w: sx + 2 * skirt, d: skirt },
    { ox: -skirt, oz: 0, w: skirt, d: sz }, { ox: sx, oz: 0, w: skirt, d: sz },
  ] : [];
  const workers = await meshOnWorkers({ V, size: grid.size, grid, light, chunks: all, strips,
    onChunk: (c, res, far, strip) => {
      if (!far) { setColumn(c[0], c[1], res); return; }
      const key = `${strip.ox},${strip.oz}:${c.join(',')}`;
      farMeshes.push(...meshesOf(res, key, true));
    } });
  if (!workers.used) for (const c of all) buildColumn(...c);
  if (!workers.used && strips.length) console.warn('gf-three voxel: no mesh workers here; the scenery past the edge is left out');
  const meshMs = Math.round(performance.now() - tm);

  // ---- signs ----
  const signs = createSigns(ctx, { grid, boardTexture: signTex, boardSlot: signN ? `world.voxel.texture.${table.list[signN - 1].tex.side}` : blockSlot, ink: V.signInk ?? '#2b1d12', paper: V.signPaper ?? '#f6ecd6' });
  root.add(signs.group);
  for (const [i, s] of signsData) signs.set(i, s);

  // ---- physics: one voxel collider for the solid cells players can touch, kept in step with every edit; walls round
  // the world ----
  const RAPIER = ctx.RAPIER;
  const phys = ctx.physics;
  let collider = null; const colliders = [];
  // the sea's edge: an island's open sea (columns 2 or more below the water line, reached from the world's edge; not
  // a lake) is fenced where it meets the land, in the physics only (three cells from the water line up), so a player
  // wades into the shallows but never walks off down the seabed and out of sight (play-test 2026-10-09). Blocks still
  // go there; breaking one leaves the fence.
  const fence = new Set(), sea = new Uint8Array(sx * sz);
  if ((V.terrain?.kind ?? 'land') === 'island' && Number.isFinite(T.water) && T.heights) {
    const deep = (x, z) => T.heights[z * sx + x] <= T.water - 2, q = [];
    const visit = (x, z) => { if (x < 0 || z < 0 || x >= sx || z >= sz) return; const k = z * sx + x; if (sea[k] || !deep(x, z)) return; sea[k] = 1; q.push(k); };
    for (let x = 0; x < sx; x++) { visit(x, 0); visit(x, sz - 1); }
    for (let z = 0; z < sz; z++) { visit(0, z); visit(sx - 1, z); }
    while (q.length) { const k = q.pop(), x = k % sx, z = (k - x) / sx; visit(x + 1, z); visit(x - 1, z); visit(x, z + 1); visit(x, z - 1); }
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      if (!sea[z * sx + x]) continue;
      const shore = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const X = x + dx, Z = z + dz; return X >= 0 && Z >= 0 && X < sx && Z < sz && !sea[Z * sx + X]; });
      if (shore) for (let y = T.water; y < Math.min(sy, T.water + 3); y++) fence.add(grid.index(x, y, z));
    }
  }
  // only cells with an open side go in (a solid cell buried on all six sides can never be touched); when a cell opens,
  // its solid neighbours go in (apply below)
  const exposed = (x, y, z) => {
    for (const [dx, dy, dz] of SIX) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Z < 0 || X >= sx || Z >= sz || Y < 0) continue;
      if (Y >= sy || !grid.solidAt(X, Y, Z)) return true;
    }
    return false;
  };
  const solidCells = () => {
    const cells = [];
    for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      if ((grid.solidAt(x, y, z) && exposed(x, y, z)) || fence.has(grid.index(x, y, z))) cells.push(x, y, z);
    }
    return cells;
  };
  const tp = performance.now();
  const makeCollider = body => {
    const c = phys.createCollider(RAPIER.ColliderDesc.voxels(new Int32Array(solidCells()), { x: 1, y: 1, z: 1 }).setFriction(0.8).setCollisionGroups(WORLD_GROUPS), body);
    c.__gf = { tag: 'voxels' };
    return c;
  };
  if (RAPIER && phys?.createRigidBody) {
    const body = phys.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    collider = makeCollider(body);
    colliders.push(collider);
    const H = sy + 20, t = 2;
    for (const [hx, hy, hz, px, py, pz] of [[sx / 2 + t, H, t / 2, sx / 2, H, -t / 2], [sx / 2 + t, H, t / 2, sx / 2, H, sz + t / 2], [t / 2, H, sz / 2 + t, -t / 2, H, sz / 2], [t / 2, H, sz / 2 + t, sx + t / 2, H, sz / 2]]) {
      const c = phys.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(px, py, pz).setCollisionGroups(WORLD_GROUPS), body);
      c.__gf = { tag: 'bounds' }; colliders.push(c);
    }
  }
  const physMs = Math.round(performance.now() - tp);

  // ---- the look: shadows follow the camera over the land ----
  let topY = 0; for (let i = 0; i < T.heights.length; i++) topY = Math.max(topY, T.heights[i]);
  const shadowBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(sx, topY + 10, sz));
  let shadowAt = null;
  const fitShadowsAt = p => {
    // a box round the camera, moved in steps of 8 cells so the shadows hold still between steps
    const S = tier.shadow, cx = Math.round(p.x / 8) * 8, cy = Math.round(p.y / 8) * 8, cz = Math.round(p.z / 8) * 8;
    const key = `${cx},${cy},${cz}`; if (key === shadowAt) return; shadowAt = key;
    shadowBox.min.set(cx - S, Math.max(0, cy - 24), cz - S); shadowBox.max.set(cx + S, cy + 20, cz + S);
    ctx.look?.fitShadows?.(shadowBox);
  };
  fitShadowsAt(new THREE.Vector3(T.plaza.at[0], T.plaza.y, T.plaza.at[1]));
  const lampPoints = [];

  // ---- the world API ----
  const listeners = [];
  const protectedAt = (x, y, z) => y < floor || protect.some(b => x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2]);
  function apply(x, y, z, v, { text, face } = {}) {
    if (!grid.inBounds(x, y, z)) return null;
    const i = grid.index(x, y, z), was = grid.data[i], wasSign = signs.get(i);
    const isSign = signN && (v & 255) === signN;
    if (was === v && !isSign) return { v: was, sign: wasSign };
    grid.set(x, y, z, v);
    const I0 = table.info[was & 255], I1 = table.info[v & 255];
    if (!!I0?.opaque !== !!I1?.opaque || (I0?.emit ?? 0) !== (I1?.emit ?? 0) || (I0?.filter ?? 0) !== (I1?.filter ?? 0)) light.touch(x, z);
    const solidNow = !!I1?.solid, solidBefore = !!I0?.solid;
    if (collider && solidNow !== solidBefore) {
      collider.setVoxel(x, y, z, solidNow || fence.has(i));
      // a cell opened: the solid cells round it can be touched now
      if (!solidNow) for (const [dx, dy, dz] of SIX) { const X = x + dx, Y = y + dy, Z = z + dz; if (grid.inBounds(X, Y, Z) && grid.solidAt(X, Y, Z)) collider.setVoxel(X, Y, Z, true); }
    }
    if (isSign) signs.set(i, { text: String(text ?? wasSign?.text ?? ''), face: face ?? wasSign?.face ?? 5 }); else if (wasSign) signs.set(i, null);
    // a sign hangs on the block behind it: when that block comes or goes, the sign goes flat ↔ onto a post
    if (solidNow !== solidBefore) for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) { const j = grid.inBounds(x + d[0], y, z + d[2]) ? grid.index(x + d[0], y, z + d[2]) : -1; if (j >= 0 && signs.has(j)) signs.refresh(j); }
    for (const fn of listeners) { try { fn(x, y, z, v, { v: was, sign: wasSign }); } catch (e) { console.error(e); } }
    return { v: was, sign: wasSign };
  }
  function remeshNow(x, y, z) {
    light.flush();
    const C = CHUNK, keys = new Set();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (grid.inBounds(nx, ny, nz)) keys.add(chunkKey(Math.floor(nx / C), Math.floor(ny / C), Math.floor(nz / C)));
    }
    // the cell's own column now; the columns round it (their AO and light at the border) over the next frames
    const C0 = Math.floor(x / C), Z0 = Math.floor(z / C);
    if ([...keys].some(k => grid.dirty.has(k) && k.startsWith(`${C0},`) && k.endsWith(`,${Z0}`))) buildColumn(C0, Z0);
  }
  const camPos = new THREE.Vector3(), centre = new THREE.Vector3();
  function update() {
    const cam = ctx.look?.activeCamera ?? ctx.camera; if (cam) camPos.copy(cam.position);
    if (cam) { fitShadowsAt(camPos); fogFor(cam); }
    // draw only what is within the view distance (the haze hides the rest); checked again after moving 4 cells
    const ck = `${Math.round(camPos.x / 4)},${Math.round(camPos.y / 4)},${Math.round(camPos.z / 4)}`;
    if (ck !== cullAt) { cullAt = ck; cull(); }
    if (light.pending) light.flush();
    if (!grid.dirty.size) return;
    // the nearest dirty chunks first, at most ~4 ms a frame (a boom or a late joiner's catch-up spreads over frames)
    const cols = new Map();
    for (const k of grid.dirty) { const [a, , c] = k.split(',').map(Number); cols.set(columnKey(a, c), [a, c, (a * CHUNK + 8 - camPos.x) ** 2 + (c * CHUNK + 8 - camPos.z) ** 2]); }
    const list = [...cols.values()].sort((p, q) => p[2] - q[2]);
    const start = performance.now();
    for (const [a, c] of list) { buildColumn(a, c); if (performance.now() - start > 4) break; }
  }
  function cull() {
    const far2 = tier.far * tier.far;
    const each = m => { const s = m.geometry.boundingSphere, d = Math.max(0, centre.copy(s.center).distanceTo(camPos) - s.radius); m.visible = d * d < far2; };
    for (const list of chunks.values()) for (const m of list) each(m);
    for (const m of farMeshes) each(m);
  }
  // picking goes through water (a player reaches the block under it)
  const liquidN = new Uint8Array(256); table.info.forEach((I, b) => { if (I?.kind === 'liquid') liquidN[b] = 1; });
  const pick = (from, dir, max = 64) => grid.raycast(from, dir, max, b => !liquidN[b]);
  const lightAt = (x, y, z) => { const w = light.at(Math.floor(x), Math.floor(y), Math.floor(z)); return { sun: (w >> 12) / 15, r: ((w >> 8) & 15) / 15, g: ((w >> 4) & 15) / 15, b: (w & 15) / 15 }; };
  /** The world's light at a point, as a body standing there takes it (CONTRACT §9, kit/character): { sky (scales the
   *  sun and the sky, on the same curve the blocks use), ambient (what stays where no sky reaches), block: [r, g, b]
   *  (linear, added times the surface colour) }, blended over the eight cells round the point (open cells only), so a
   *  body moving through a cave fades in and out of a lamp's light rather than stepping. */
  const shown = { sky: 0, block: [0, 0, 0] };
  function worldLightAt(x, y, z) {
    const fx = x - 0.5, fy = y - 0.5, fz = z - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    let S = 0, R = 0, Gn = 0, Bl = 0, W = 0;
    for (let k = 0; k < 8; k++) {
      const X = x0 + (k & 1), Y = y0 + ((k >> 1) & 1), Z = z0 + ((k >> 2) & 1);
      if (grid.inBounds(X, Y, Z) && table.info[grid.data[grid.index(X, Y, Z)] & 255]?.opaque) continue;
      const w = (k & 1 ? fx - x0 : 1 - (fx - x0)) * ((k >> 1) & 1 ? fy - y0 : 1 - (fy - y0)) * ((k >> 2) & 1 ? fz - z0 : 1 - (fz - z0)) + 1e-4;
      const v = light.at(X, Y, Z);
      S += (v >> 12) * w; R += ((v >> 8) & 15) * w; Gn += ((v >> 4) & 15) * w; Bl += (v & 15) * w; W += w;
    }
    const n = W ? 15 * W : 15, s = S / n;
    shown.sky = s * s;
    // block light on the same curve the blocks use, plus the cave's own cool glow where no sky reaches
    const k = LV.block, e = LV.spread, dark = 1 - shown.sky;
    shown.block[0] = Math.pow(R / n, e) * k + caveLight.r * dark; shown.block[1] = Math.pow(Gn / n, e) * k + caveLight.g * dark; shown.block[2] = Math.pow(Bl / n, e) * k + caveLight.b * dark;
    return { sky: shown.sky, ambient: LV.cave, block: [...shown.block] };
  }
  // the fog underground: as the sky above the camera goes, the haze darkens to the cave's own colour and closes in, so a
  // tunnel's far end falls into the dark instead of a bright daytime haze
  const caveFog = new THREE.Color(LV.caveFog ?? '#07090d'), fogBase = new THREE.Color();
  /** The cave's own light, live (shared uniforms, the bodies' light and the fog underground follow at once). */
  function setLight(p = {}) {
    for (const k of ['cave', 'block', 'spread']) if (typeof p[k] === 'number') LV[k] = p[k];
    if (p.caveLight) LV.caveLight = { ...LV.caveLight, ...p.caveLight };
    if (typeof p.caveFog === 'string') LV.caveFog = p.caveFog;
    shared.uGfCave.value = LV.cave; shared.uGfBlockLight.value = LV.block; shared.uGfSpread.value = LV.spread;
    caveLight.set(LV.caveLight?.color ?? '#4a5f86').multiplyScalar(LV.caveLight?.strength ?? 0); shared.uGfCaveLight.value = caveLight;
    caveFog.set(LV.caveFog ?? '#07090d');
    return JSON.parse(JSON.stringify(LV));
  }
  let fogSky = null;
  function fogFor(cam) {
    const fog = ctx.scene?.fog, look = ctx.look?.values?.fog;
    if (!fog || !look) return;
    const s = worldLightAt(cam.position.x, cam.position.y, cam.position.z).sky;
    fogSky = fogSky === null ? Math.sqrt(s) : fogSky + (Math.sqrt(s) - fogSky) * 0.08;
    fogBase.set(look.color);
    fog.color.copy(caveFog).lerp(fogBase, fogSky);
    fog.near = look.near * (0.4 + 0.6 * fogSky); fog.far = Math.max(fog.near + 10, look.far * (0.55 + 0.45 * fogSky));
  }

  const spawns = T.spawns.map(s => { const p = new THREE.Vector3(s.x, s.y, s.z); p.yaw = Math.atan2(T.plaza.at[0] + 0.5 - s.x, T.plaza.at[1] + 0.5 - s.z) + Math.PI; return p; });
  const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(sx, sy, sz));
  bounds.half = Math.max(sx, sz) / 2;
  const zonePlaza = { name: 'plaza', shape: 'box', at: new THREE.Vector3(T.plaza.at[0] + 0.5, T.plaza.y, T.plaza.at[1] + 0.5), size: [T.plaza.max[0] - T.plaza.min[0] + 1, 4, T.plaza.max[2] - T.plaza.min[2] + 1],
    contains: p => p.x >= T.plaza.min[0] && p.x <= T.plaza.max[0] + 1 && p.z >= T.plaza.min[2] && p.z <= T.plaza.max[2] + 1,
    random: (r = Math.random) => new THREE.Vector3(T.plaza.min[0] + 1 + r() * (T.plaza.max[0] - T.plaza.min[0] - 1), T.plaza.y, T.plaza.min[2] + 1 + r() * (T.plaza.max[2] - T.plaza.min[2] - 1)) };
  const zones = { plaza: zonePlaza };
  const timings = { generate: genMs, light: lightMs, mesh: meshMs, physics: physMs, workers: workers.used, scenery: farMeshes.length };

  const world = {
    template: 'voxel', kind: 'outdoor', layout: cfg, root, group: root, bounds, shadowBounds: shadowBox, lampPoints,
    sizeClass: null, rooms: [], doors: [], entries: [], roomAt: () => null, via: () => null, entry: () => null,
    shapes: [], colliders, isWorld: c => colliders.includes(c), props: new Map(), catalog: {},
    spawns, spawn(i = 0) { const s = spawns[((i % spawns.length) + spawns.length) % spawns.length]; const p = s.clone(); p.yaw = s.yaw; return p; },
    zones, zone: name => zones[name] ?? null,
    raycast(from, dir, max = 100) {
      if (!RAPIER || !phys) return null;
      const d = dir.clone().normalize();
      const hit = phys.castRayAndGetNormal(new RAPIER.Ray(from, d), max, true, undefined, undefined, undefined, undefined, c => colliders.includes(c));
      if (!hit) return null;
      const t = hit.timeOfImpact ?? hit.toi;
      return { distance: t, point: new THREE.Vector3().copy(from).addScaledVector(d, t), normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z), collider: hit.collider };
    },
    update, lightAt: worldLightAt,
    place: setting => placeFor({ grid, light, terrain: T, table }, setting, { from: T.plaza?.at }),
    voxel: {
      setLight, lightValues: () => JSON.parse(JSON.stringify(LV)),
      grid, table, light, signs, store, loaded, apply, pick, lightAt, heldMesh, protectedAt, remeshNow, floor, protect, signN, terrain: T, water: T.water,
      /** Is the column at (x, z) the open sea (outside the fence)? */
      seaAt: (x, z) => x >= 0 && z >= 0 && x < sx && z < sz && !!sea[Math.floor(z) * sx + Math.floor(x)],
      textureImages, textureAverage: name => averages[name] ?? null,
      /** The operator restored the world (a reset on the play host): the land again, the saved world over it. */
      async reload() {
        grid.data.fill(0); signsData.clear();
        generateTerrain(grid, table, V.terrain ?? {});
        for (const [i, s] of welcome) { grid.data[i] = signN; signsData.set(i, s); }
        await loadSaved();
        for (const s of signs.list()) signs.set(s.index, null);
        for (const [i, s] of signsData) signs.set(i, s);
        light.computeAll();
        grid.markAll();
        if (collider) {
          const body = collider.parent();
          phys.removeCollider(collider, false);
          const c = makeCollider(body);
          colliders[colliders.indexOf(collider)] = c; collider = c;
        }
      },
      onApply(fn) { if (typeof fn === 'function') listeners.push(fn); },
      stats: () => ({ chunks: chunks.size, scenery: farMeshes.length, dirty: grid.dirty.size, meshMs, timings, signs: signs.size, fence: fence.size, loaded: { ...loaded }, store: { mode: store.mode, seq: store.seq, queued: store.queued, ...store.stats } }),
    },
    dispose() { for (const list of chunks.values()) for (const m of list) m.geometry.dispose(); for (const m of farMeshes) m.geometry.dispose(); signs.dispose(); root.removeFromParent(); arrayTex.dispose(); },
  };
  ctx.world = world;
  return world;
}

const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * The first mesh of the play grid and the scenery strips, on up to four module workers (mesh-worker.js). Resolves when
 * every chunk has come back through onChunk(chunk, res, far, strip). → { used } (false: no workers here, nothing done:
 * the caller meshes on the main thread).
 */
async function meshOnWorkers({ V, size, grid, light, chunks, strips, onChunk }) {
  if (typeof Worker === 'undefined' || /gf-voxworkers=0/.test(globalThis.location?.search ?? '')) return { used: 0 };
  const n = Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1));
  let pool;
  try {
    pool = Array.from({ length: n }, () => new Worker(new URL('./mesh-worker.js', import.meta.url), { type: 'module' }));
  } catch (e) { console.warn(`gf-three voxel: mesh workers did not start (${e.message}); meshing on the main thread`); return { used: 0 }; }
  const plain = JSON.parse(JSON.stringify(V));
  try {
    for (const w of pool) w.postMessage({ type: 'init', V: plain, size, data: grid.data, light: light.data, biome: grid.biome });
    let job = 0;
    const jobs = [];
    const run = (w, msg, strip = null) => new Promise((resolve, reject) => {
      const id = ++job;
      const on = ({ data: m }) => {
        if (m.job !== id) return;
        if (m.type === 'chunk') onChunk(m.chunk, m.res, m.far, strip);
        else if (m.type === 'done') { w.removeEventListener('message', on); resolve(); }
        else if (m.type === 'error') { w.removeEventListener('message', on); reject(new Error(m.error)); }
      };
      w.addEventListener('message', on);
      w.addEventListener('error', e => reject(new Error(e.message ?? 'worker error')), { once: true });
      w.postMessage({ ...msg, job: id });
    });
    // the scenery first on its own workers (it takes longest), the play grid's chunks dealt round the rest
    strips.forEach((s, i) => jobs.push(run(pool[i % n], { type: 'far', V: plain, size, strip: s }, s)));
    const parts = Array.from({ length: n }, () => []);
    chunks.forEach((c, i) => parts[(i + strips.length) % n].push(c));
    parts.forEach((p, i) => { if (p.length) jobs.push(run(pool[i], { type: 'mesh', chunks: p })); });
    await Promise.all(jobs);
    return { used: n };
  } catch (e) {
    console.warn(`gf-three voxel: a mesh worker failed (${e.message}); meshing on the main thread`);
    return { used: 0 };
  } finally {
    for (const w of pool) w.terminate();
  }
}

/** Every block texture slot, drawn at the face size into one THREE.DataArrayTexture (row order flipped: v = 0 at the
 *  bottom). Pixel faces are drawn nearest-neighbour and magnified the same way (every texel a crisp square). */
async function buildTextureArray(ctx, names, V, tierName) {
  const TEX = texSizeOf(V, tierName), pixel = V.faces?.filter === 'pixel';
  const L = names.length, data = new Uint8Array(TEX * TEX * 4 * L), images = {}, averages = {};
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = TEX;
  const c2 = canvas.getContext('2d', { willReadFrequently: true });
  for (let l = 0; l < L; l++) {
    let img = null;
    try { img = (await ctx.assets.texture(`world.voxel.texture.${names[l]}`))?.image ?? null; }
    catch (e) { console.warn(`gf-three voxel: texture ${names[l]}: ${e.message}`); }
    c2.clearRect(0, 0, TEX, TEX);
    if (img) { c2.imageSmoothingEnabled = !pixel; c2.imageSmoothingQuality = 'high'; c2.drawImage(img, 0, 0, TEX, TEX); }
    else { c2.fillStyle = '#ff00ff'; c2.fillRect(0, 0, TEX, TEX); }
    const px = c2.getImageData(0, 0, TEX, TEX).data;
    for (let y = 0; y < TEX; y++) data.set(px.subarray((TEX - 1 - y) * TEX * 4, (TEX - y) * TEX * 4), (l * TEX * TEX + y * TEX) * 4);
    images[names[l]] = img;
    // the face's average colour (its opaque pixels): debris and the like
    let r = 0, g = 0, b = 0, n = 0;
    for (let k = 0; k < px.length; k += 4) if (px[k + 3] > 100) { r += px[k]; g += px[k + 1]; b += px[k + 2]; n++; }
    averages[names[l]] = n ? `#${[r, g, b].map(c => Math.round(c / n).toString(16).padStart(2, '0')).join('')}` : '#999999';
  }
  const t = new THREE.DataArrayTexture(data, TEX, TEX, L);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = pixel ? THREE.NearestFilter : THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = Math.min(8, ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
  t.needsUpdate = true;
  return { texture: t, images, averages };
}

/**
 * A house 'prop' material that samples the block texture array (attribute gfUvl = u, v, layer) and is lit by the
 * voxel light: the sun and sky scaled by the cell's sunlight (dark in caves, soft under trees), the block light added
 * in its own colour. The biome's colour (gfBiome) tints grass and leaves; paint (gfTint) recolours a face. Past the
 * play area's edge the scenery fades into the haze.
 */
function hazeFog(pos) {
  return `#ifdef USE_FOG
\t{
\t\t#ifdef FOG_EXP2
\t\t\tfloat fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
\t\t#else
\t\t\tfloat fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
\t\t#endif
\t\t// the scenery past the play area's edge fades into the haze, wherever the camera is
\t\tvec2 gfOut = max( max( uGfBox.xy - ${pos}.xz, ${pos}.xz - uGfBox.zw ), 0.0 );
\t\tfogFactor = max( fogFactor, smoothstep( uGfHaze.x, uGfHaze.y, length( gfOut ) ) );
\t\tgl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
\t}
#endif`;
}

/** The look's water material on the water cells, with the haze past the edge. */
function waterMaterial(shared) {
  const m = material('water', { transparent: true, opacity: 0.86 });
  m.depthWrite = false;
  const house = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    house(sh, r);
    sh.uniforms.uGfBox = shared.uGfBox; sh.uniforms.uGfHaze = shared.uGfHaze;
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec4 uGfBox; uniform vec2 uGfHaze;').replace('#include <fog_fragment>', hazeFog('vGfWorld'));
  };
  const houseKey = m.customProgramCacheKey;
  m.customProgramCacheKey = () => `${houseKey()}-voxel2-water`;
  m.name = 'gf-voxel-water';
  return m;
}

function voxelMaterial(kind, shared, V) {
  const opts = { vertexColors: true };
  if (kind === 'cutout' || kind === 'plant') { opts.alphaTest = 0.45; opts.side = kind === 'plant' ? THREE.DoubleSide : THREE.FrontSide; }
  if (kind === 'glass') { opts.transparent = true; opts.opacity = 1; }
  const m = material('prop', opts);
  if (kind === 'glass') m.depthWrite = false;
  const house = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    house(sh, r);
    Object.assign(sh.uniforms, shared);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 gfUvl;\nattribute vec3 gfTint;\nattribute vec4 gfLight;\nattribute vec3 gfBiome;\nattribute float gfGlow;\nvarying float vGfGlow;\nvarying vec3 vGfUvl;\nvarying vec3 vGfTint;\nvarying vec4 vGfLight;\nvarying vec3 vGfBiome;\nvarying vec3 vGfPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvGfUvl = gfUvl; vGfTint = gfTint; vGfLight = gfLight; vGfBiome = pow( gfBiome, vec3( 2.2 ) ); vGfGlow = gfGlow;   // the biome colours are sRGB')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n\tvGfPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    const cut = kind === 'cutout' || kind === 'plant';
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform highp sampler2DArray uGfBlocks; uniform float uGfCave; uniform float uGfBlockLight; uniform float uGfSpread; uniform vec3 uGfCaveLight; uniform vec4 uGfBox; uniform vec2 uGfHaze; uniform float uGfTexSize; uniform float uGfGlow;
varying float vGfGlow; varying vec3 vGfUvl; varying vec3 vGfTint; varying vec4 vGfLight; varying vec3 vGfBiome; varying vec3 vGfPos;`)
      .replace('#include <map_fragment>', `\tvec4 gfTex = texture( uGfBlocks, vec3( vGfUvl.xy, floor( vGfUvl.z + 0.5 ) ) );
${kind === 'solid' || kind === 'glow' ? `\t// half-transparent texels of a solid face take the biome's colour (the grass top and lip), then the face is opaque
\tgfTex.rgb *= mix( vec3( 1.0 ), vGfBiome, clamp( ( 1.0 - gfTex.a ) * 2.0, 0.0, 1.0 ) ); gfTex.a = 1.0;` : cut ? `\tgfTex.rgb *= vGfBiome;
\t// keep leaves full at a distance: the mip's alpha is lifted by how far down the mip chain it is
\t{ vec2 gfT = vGfUvl.xy * uGfTexSize; float gfMip = max( 0.0, 0.5 * log2( max( dot( dFdx( gfT ), dFdx( gfT ) ), dot( dFdy( gfT ), dFdy( gfT ) ) ) ) ); gfTex.a *= 1.0 + gfMip * 0.3; }` : ''}
\tif ( vGfTint.r + vGfTint.g + vGfTint.b > 0.0 ) { float gfL = dot( gfTex.rgb, vec3( 0.299, 0.587, 0.114 ) ); gfTex.rgb = vGfTint * ( 0.42 + 0.95 * gfL ); }
\tdiffuseColor *= gfTex;${DBG ? '\n\tgl_FragColor = vec4( gfTex.rgb, 1.0 ); return;' : ''}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
\t{
\t\t// the voxel light: sunlight (0-15 → a curve) scales the sun and the sky; block light adds its own colour
\t\tfloat gfSky = vGfLight.x * vGfLight.x;
\t\tvec3 gfBlock = pow( vGfLight.yzw, vec3( uGfSpread ) ) * uGfBlockLight;
\t\treflectedLight.directDiffuse *= gfSky; reflectedLight.directSpecular *= gfSky;
\t\treflectedLight.indirectDiffuse *= mix( uGfCave, 1.0, gfSky ); reflectedLight.indirectSpecular *= mix( uGfCave, 1.0, gfSky );
\t\treflectedLight.indirectDiffuse += diffuseColor.rgb * ( gfBlock + uGfCaveLight * ( 1.0 - gfSky ) );
\t}`)
      .replace('#include <fog_fragment>', hazeFog('vGfPos'));
    // what gives off light glows in the dark (lamps, crystals, glowcaps): bright enough for the look's bloom
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * vGfGlow * uGfGlow;');
  };
  const houseKey = m.customProgramCacheKey;
  m.customProgramCacheKey = () => `${houseKey()}-voxel2-${kind}`;
  m.name = `gf-voxel-${kind}`;
  return m;
}
