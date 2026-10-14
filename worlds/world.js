// gf-three world (track L), CONTRACT §4.3.
//   loadWorld(ctx, cfg, opts) -> places a layout: ground, props (instanced, one draw per prop part), colliders, spawns,
//                               zones and lamp points. Every visible mesh carries userData.gfSlot. Sets ctx.world.
//   templates                -> the template ids (recipes in kit/world/templates/*.json; generate.js expands one at a
//                               size class into a layout: templateLayout(id, { size, seed }))
//   slots / slotsFor(cfg)     -> world.<template>.* and prop.<id> slot templates (§2.2)
//
// Indoor worlds (a layout with `ceiling`, `rooms`, `doors`, `entries`; kit/world/generate.js): the ceiling is a kit
// primitive (slot world.<t>.ceiling.color, pattern world.<t>.ceiling.pattern) drawn as a cutaway: it faces down, so
// it shows from below and is culled from above, and it fades out as the camera rises to it (a third-person camera
// that looks down from over the player's head sees into the room, never a lid). It casts no shadow: the rooms keep
// the look's light. world.via(from, to) routes walkers through the doors (waves enemies, bots), world.entry(rng) is
// where an enemy comes in (a real door to the outside), world.roomAt(x, z) names the room.
//
// Layout JSON (config/world.json; agents edit it):
//   { template, label, size: [x, z], ground: { color, color2, outer, outerSize, tile, detail },
//     bounds: { walls: true, height }, props: [{ prop, at: [x,y,z], rot: deg | [x,y,z] deg, scale: n | [x,y,z] }],
//     scatter: [{ prop, count, area: [x0,z0,x1,z1], seed, clear: [[x,z,r]...], scale: [min,max] }],
//     spawns: [[x,y,z]...], zones: { name: { shape: 'circle'|'box', at: [x,y,z], size: [r] | [w,h,d] } } }
// Prop metadata (collider, size, material kinds, lamp point) comes from the prop catalog: library/props.json, or the
// game's config/props.json (CONTRACT-REQUEST: create copies the used entries there; see kit/world/README.md).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { adoptMaterials, material, setGroundPattern } from '../look/materials.js';
import { expandLayout, createRouter, entryPoint, roomAt } from './layout.js';
import { collidersOf, buildColliders, MATERIALS } from './colliders.js';
import { generateLayout } from './generate.js';
import { drawIslands } from './islands.js';
import { placeFor as seaPlace } from './sea-places.mjs';

export const templates = ['backyard', 'office', 'plaza', 'arena', 'store', 'sea-islands'];
const DEG = Math.PI / 180;

// ---------- slots ----------
export const slots = [
  { id: 'world.{template}.ground.color', label: 'Ground colour', group: 'world', type: 'color', facet: 'look', tier: 'main', source: { file: 'config/world.json', pointer: '/ground/color' } },
  { id: 'world.{template}.ground.color2', label: 'Ground second colour (patches)', group: 'world', type: 'color', facet: 'look', tier: 'main', source: { file: 'config/world.json', pointer: '/ground/color2' } },
  { id: 'world.{template}.ground.outer', label: 'Ground colour beyond the play area', group: 'world', type: 'color', facet: 'look', tier: 'advanced', source: { file: 'config/world.json', pointer: '/ground/outer' } },
  { id: 'world.{template}.layout', label: 'Prop layout', group: 'world', type: 'json', facet: 'gameplay', tier: 'advanced', source: { file: 'config/world.json', pointer: '/props' }, description: 'Every placed prop: { prop, at: [x,y,z] metres, rot: degrees, scale }' },
  { id: 'world.{template}.spawns', label: 'Spawn points', group: 'world', type: 'json', facet: 'gameplay', tier: 'advanced', source: { file: 'config/world.json', pointer: '/spawns' } },
  { id: 'world.{template}.zones', label: 'Zones', group: 'world', type: 'json', facet: 'gameplay', tier: 'advanced', source: { file: 'config/world.json', pointer: '/zones' } },
];

/** A licence that asks for credit (CC BY x.y): the title, the record's credit line, the licence's page and what was
 *  changed, so the game's credits (ATTRIBUTION.md, How to play) can say it in full. Anything else: nothing. */
const creditOf = lic => {
  const v = /^CC-BY-(\d\.\d)$/.exec(lic?.spdx ?? '')?.[1];
  return v ? { ...(lic.title ? { title: lic.title } : {}), ...(lic.credit ? { credit: lic.credit } : {}), licenseUrl: `https://creativecommons.org/licenses/by/${v}/`, ...(lic.modified ? { modified: lic.modified } : {}) } : {};
};

/** Concrete slots for a layout: the world slots plus one model slot per prop it uses. catalog = props.json. */
export function slotsFor(cfg, catalog, licences = null) {
  const t = cfg.template;
  const out = slots.map(s => ({ ...s, id: s.id.replace('{template}', t) }));
  // the ground's pattern (paving, carpet tiles, mowing stripes): a picture slot, baked offline (lookdev/tools/bake-patterns.mjs)
  const pat = cfg.ground?.pattern;
  if (pat?.file) {
    const lic = licences?.files?.[`textures/${pat.file.split('/').pop()}`];
    out.push({
      id: `world.${t}.ground.pattern`, label: 'Ground pattern', group: 'world', type: 'image', facet: 'look', tier: 'main', rank: 30,
      source: { file: pat.file }, constraints: { tile: true, colorSpace: 'srgb', formats: ['png', 'jpg', 'webp'], tileMetres: pat.size ?? 4 },
      description: `A seamless greyscale pattern multiplied over the ground colour, ${pat.size ?? 4} m per tile (paving slabs, carpet tiles, mowing stripes). Light = the ground colour, dark = grout or seams.`,
      generate: { prompt: `seamless top-down ${t} ground pattern, greyscale, light with darker joints`, style: 'tileable, flat, no lighting, no perspective' },
      ...(lic?.spdx || lic?.generated ? { license: { spdx: lic.spdx ?? 'CC0-1.0', author: lic.author ?? 'games.fun', url: lic.page ?? 'https://games.fun' } } : {}),
    });
  }
  // the sea-islands world's cliffs (the ground cut open: a strata picture over coloured bands), beaches and clouds
  if (cfg.islands?.length) {
    out.push({ id: `world.${t}.cliffs.color`, label: 'Cliff colour', group: 'world', type: 'color', facet: 'look', tier: 'advanced', source: { file: 'config/world.json', pointer: '/cliffs/color' } });
    out.push({ id: `world.${t}.ground.beach`, label: 'Beach colour', group: 'world', type: 'color', facet: 'look', tier: 'advanced', source: { file: 'config/world.json', pointer: '/ground/beach' } });
    out.push({ id: `world.${t}.clouds.color`, label: 'Cloud colour', group: 'world', type: 'color', facet: 'look', tier: 'advanced', source: { file: 'config/world.json', pointer: '/sky/clouds/color' } });
    const cp = cfg.cliffs?.pattern;
    if (cp?.file) {
      const lic = licences?.files?.[`textures/${cp.file.split('/').pop()}`];
      out.push({
        id: `world.${t}.cliffs.pattern`, label: 'Cliff face', group: 'world', type: 'image', facet: 'look', tier: 'main',
        source: { file: cp.file }, constraints: { tile: true, colorSpace: 'srgb', formats: ['png', 'jpg', 'webp'], tileMetres: cp.size ?? 5 },
        description: `A seamless picture of the ground cut open (soil and rock in layers), ${cp.size ?? 5} m per tile, wrapped round the islands' cliffs over their coloured bands.`,
        generate: { prompt: 'seamless cross-section of layered soil and rock strata, side view', style: 'tileable, painted, no perspective' },
        ...(lic?.spdx || lic?.generated ? { license: { spdx: lic.spdx ?? 'CC0-1.0', author: lic.author ?? 'games.fun', url: lic.page ?? 'https://games.fun' } } : {}),
      });
    }
  }
  // an indoor world's ceiling (a kit primitive, drawn as a cutaway): its colours and its tile pattern
  if (cfg.ceiling?.height) {
    out.push({ id: `world.${t}.ceiling.color`, label: 'Ceiling colour', group: 'world', type: 'color', facet: 'look', tier: 'advanced', source: { file: 'config/world.json', pointer: '/ceiling/color' } });
    out.push({ id: `world.${t}.ceiling.band`, label: 'Wall colour above the doors and windows', group: 'world', type: 'color', facet: 'look', tier: 'advanced', source: { file: 'config/world.json', pointer: '/ceiling/band' } });
    const cp = cfg.ceiling.pattern;
    if (cp?.file) {
      const lic = licences?.files?.[`textures/${cp.file.split('/').pop()}`];
      out.push({
        id: `world.${t}.ceiling.pattern`, label: 'Ceiling pattern', group: 'world', type: 'image', facet: 'look', tier: 'advanced',
        source: { file: cp.file }, constraints: { tile: true, colorSpace: 'srgb', formats: ['png', 'jpg', 'webp'], tileMetres: cp.size ?? 2.4 },
        description: `A seamless greyscale pattern multiplied over the ceiling colour, ${cp.size ?? 2.4} m per tile (ceiling tiles, planks). Light = the ceiling colour, dark = the grid.`,
        generate: { prompt: `seamless ${t} ceiling pattern seen from below, greyscale, light tiles with a darker grid`, style: 'tileable, flat, no lighting, no perspective' },
        ...(lic?.spdx || lic?.generated ? { license: { spdx: lic.spdx ?? 'CC0-1.0', author: lic.author ?? 'games.fun', url: lic.page ?? 'https://games.fun' } } : {}),
      });
    }
  }
  const used = [...new Set([...(cfg.props ?? []).map(p => p.prop), ...(cfg.scatter ?? []).map(s => s.prop)])];
  const byId = new Map((catalog?.props ?? []).map(p => [p.id, p]));
  for (const id of used) {
    const p = byId.get(id);
    const lic = licences?.files?.[p?.file];
    out.push({
      id: `prop.${id}`, label: p?.describe ? p.describe.replace(/^an? /, '').replace(/^./, c => c.toUpperCase()) : id,
      group: 'props', type: 'model', facet: 'look', tier: 'advanced',
      source: { file: `assets/models/${id}.glb` },
      constraints: { scale: 1, ...(p?.size ? { size: p.size } : {}) },
      description: `A ${t} prop. Metres, Y up, base at y=0, centred; a replacement is fitted to ${p?.size?.map(n => n.toFixed(1)).join(' x ') ?? 'the same'} m.`,
      generate: { prompt: p?.describe ?? id, style: 'soft stylised low-poly, chunky shapes, flat pastel colours, game-ready' },
      ...(lic ? { license: { spdx: lic.spdx, author: lic.author, url: lic.page, ...creditOf(lic) } } : {}),
    });
  }
  return out;
}

// ---------- helpers ----------
const v3 = (a, d = 0) => new THREE.Vector3(a?.[0] ?? d, a?.[1] ?? d, a?.[2] ?? d);
// expandLayout (scatter → placements) lives in layout.js, pure, so the set-dressing lint (tools/dressing.mjs) expands
// a layout exactly as the browser does
export { expandLayout };

function matrixOf(p) {
  const rot = Array.isArray(p.rot) ? p.rot : [0, p.rot ?? 0, 0];
  const sc = Array.isArray(p.scale) ? p.scale : [p.scale ?? 1, p.scale ?? 1, p.scale ?? 1];
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG, 'YXZ'));
  return new THREE.Matrix4().compose(v3(p.at), q, v3(sc, 1));
}

const loaders = new Map();
function gltfLoader() {
  if (!loaders.has('gltf')) { const l = new GLTFLoader(); l.setMeshoptDecoder(MeshoptDecoder); loaders.set('gltf', l); }
  return loaders.get('gltf');
}
const glbCache = new Map();
async function loadModel(url) {
  if (!glbCache.has(url)) glbCache.set(url, gltfLoader().loadAsync(url).then(g => g.scene));
  return (await glbCache.get(url)).clone(true);
}

// the ground pattern: through the game's slot (ctx.assets), else the picture of the same name where opts.library is
// served (a bench outside a game: the asset library's files by name)
async function groundPattern(ctx, template, pat, opts, part = 'ground') {
  const slot = `world.${template}.${part}.pattern`;
  let tex = null;
  if (ctx.assets?.texture && (ctx.assets.has?.(slot) ?? false)) tex = await ctx.assets.texture(slot);
  else {
    const base = libraryBase(opts);
    tex = await new THREE.TextureLoader().loadAsync(new URL(`textures/${pat.file.split('/').pop()}`, base).href);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.userData.gfSlot = slot;
  }
  if (!tex) return null;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = Math.max(tex.anisotropy ?? 1, ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
  tex.needsUpdate = true;
  return tex;
}

/** Outside a game (no ctx.assets) the props and pictures come from where opts.library serves the asset library. */
function libraryBase(opts) {
  if (!opts.library) throw new Error('gf-three world: outside a game, opts.library must say where the asset library is served (props.json, <pack>/<file>, textures/<file>)');
  return opts.library;
}

async function catalogOf(ctx, opts) {
  if (opts.catalog && typeof opts.catalog === 'object') return opts.catalog;
  if (ctx.assets?.config) { try { const c = ctx.assets.config('props'); if (c?.props) return c; } catch { /* not in this game */ } }
  const url = typeof opts.catalog === 'string' ? opts.catalog : new URL('props.json', libraryBase(opts)).href;
  return (await fetch(url)).json();
}

/** The layout of a template at a size class (its recipe, kit/world/templates/<id>.json, expanded by generate.js). */
export async function templateLayout(id, { size = 'small', seed = null } = {}) {
  if (!templates.includes(id)) throw new Error(`gf-three world: unknown template "${id}" (${templates.join(', ')})`);
  const recipe = await (await fetch(new URL(`./templates/${id}.json`, import.meta.url))).json();
  return generateLayout(recipe, { size, seed });
}

// ---------- loadWorld ----------
/**
 * ctx: { scene, look?, assets?, physics?, RAPIER? }. cfg: a layout (config/world.json) or { template } for the default.
 * opts: { library: URL where the asset library is served (a bench outside a game), catalog, textures: { noise }, quality }.
 */
export async function loadWorld(ctx, cfg, opts = {}) {
  if (!cfg?.props && cfg?.template) {
    const sizeClass = typeof cfg.size === 'string' ? cfg.size : cfg.sizeClass ?? 'small';
    const { size: _s, ...rest } = cfg;
    cfg = { ...(await templateLayout(cfg.template, { size: sizeClass, seed: cfg.seed ?? null })), ...(typeof cfg.size === 'string' ? rest : cfg) };
  }
  const catalog = await catalogOf(ctx, opts);
  const byId = new Map(catalog.props.map(p => [p.id, p]));
  const root = new THREE.Group();
  root.name = `gf-world-${cfg.template}`;
  const size = cfg.size ?? [24, 24];
  const placements = expandLayout(cfg);

  // ground: a kit primitive whose material and colours are world slots
  const g = cfg.ground ?? {};
  // the ground's patches use the look's noise texture (look.textures.noise, shared by the house 'ground' material);
  // its pattern (world.<t>.ground.pattern) multiplies on top, in world space
  const pat = g.pattern?.file ? g.pattern : null;
  const groundMat = material('ground', { color: g.color ?? '#9fd86b', color2: g.color2 ?? g.color ?? '#9fd86b', ...(pat ? { patternSize: pat.size ?? 4, patternStrength: pat.strength ?? 1 } : {}) });
  if (pat) {
    const tex = await groundPattern(ctx, cfg.template, pat, opts).catch(e => { console.warn(`gf-three world: ground pattern ${pat.file} did not load (${e.message}); plain ground`); return null; });
    if (tex) setGroundPattern(groundMat, tex);
  }
  // islands in a sea (sea.js lays them out, islands.js draws them): the tops, cliffs, beaches, the sea and the clouds in
  // place of the flat ground
  let isles = null, groundGeo = null;
  if (cfg.islands?.length) {
    const cp = cfg.cliffs?.pattern?.file ? cfg.cliffs.pattern : null;
    const cliffTexture = cp ? await groundPattern(ctx, cfg.template, cp, opts, 'cliffs').catch(e => { console.warn(`gf-three world: cliff pattern ${cp.file} did not load (${e.message}); coloured bands only`); return null; }) : null;
    isles = drawIslands(root, cfg, { groundMat, cliffTexture, template: cfg.template });
  } else {
    groundGeo = new THREE.PlaneGeometry(size[0] + (g.margin ?? 0), size[1] + (g.margin ?? 0));
    groundGeo.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.name = 'ground'; ground.receiveShadow = true;
    ground.userData.gfSlot = `world.${cfg.template}.ground.color`;
    root.add(ground);
  }
  if (g.outer && !isles) {
    const outerMat = material('ground', { color: g.outer, color2: g.outer2 ?? g.color2 ?? g.outer });
    const outerGeo = new THREE.CircleGeometry(g.outerSize ?? 220, 48);
    outerGeo.rotateX(-Math.PI / 2);
    const outer = new THREE.Mesh(outerGeo, outerMat);
    outer.name = 'ground-outer'; outer.position.y = -0.02; outer.receiveShadow = true;
    outer.userData.gfSlot = `world.${cfg.template}.ground.outer`;
    root.add(outer);
  }
  // the ceiling of an indoor world: a cutaway (faces down; fades out as the camera rises to it; no shadow)
  let ceiling = null;
  if (cfg.ceiling?.height) {
    const c = cfg.ceiling, cp = c.pattern?.file ? c.pattern : null;
    // seen from below the sun never reaches it: `glow` lifts it to read as a lit room's ceiling (an emissive share of its colour)
    const ceilMat = material('ground', { color: c.color ?? '#f3f0ea', color2: c.color2 ?? c.color ?? '#ebe7de', transparent: true, opacity: 1, emissive: c.color ?? '#f3f0ea', emissiveIntensity: c.glow ?? 0.35, ...(cp ? { patternSize: cp.size ?? 2.4, patternStrength: cp.strength ?? 1 } : {}) });
    if (cp) {
      const tex = await groundPattern(ctx, cfg.template, cp, opts, 'ceiling').catch(e => { console.warn(`gf-three world: ceiling pattern ${cp.file} did not load (${e.message}); plain ceiling`); return null; });
      if (tex) setGroundPattern(ceilMat, tex);
    }
    const ceilGeo = new THREE.PlaneGeometry(size[0], size[1]);
    ceilGeo.rotateX(Math.PI / 2);                    // the face looks down: seen from inside the rooms, culled from above
    ceiling = new THREE.Mesh(ceilGeo, ceilMat);
    ceiling.name = 'ceiling'; ceiling.position.y = c.height; ceiling.castShadow = false; ceiling.receiveShadow = false;
    ceiling.userData.gfSlot = `world.${cfg.template}.ceiling.color`;
    ceiling.userData.cutaway = { height: c.height, fade: c.fade ?? 0.6 };
    root.add(ceiling);
  }

  // props: one InstancedMesh per (prop, mesh part); materials adopted into house materials
  const groups = new Map();
  placements.forEach((p, i) => { if (!groups.has(p.prop)) groups.set(p.prop, []); groups.get(p.prop).push({ ...p, index: i }); });
  const propsMap = new Map();
  const fits = new Map();                                       // each model's fit to its catalog size (fitScale)
  const lampPoints = [];
  const drifting = [];
  const libBase = ctx.assets?.model ? null : libraryBase(opts);
  await Promise.all([...groups.entries()].map(async ([id, list]) => {
    const meta = byId.get(id);
    if (!meta) throw new Error(`gf-three world: prop "${id}" is not in the prop catalog`);
    let model;
    if (ctx.assets?.model) model = await ctx.assets.model(`prop.${id}`);
    else model = await loadModel(new URL(meta.file, libBase).href);
    // a replacement model is fitted to the catalog size (swap anything: an uploaded GLB in any unit still fits)
    const fit = fitScale(model, meta);
    fits.set(id, fit);
    adoptMaterials(model, 'prop', { materials: meta.materials });
    model.updateMatrixWorld(true);
    const parts = [];
    model.traverse(o => { if (o.isMesh) parts.push(o); });
    const instMats = list.map(p => matrixOf(p).multiply(new THREE.Matrix4().makeScale(fit, fit, fit)));
    const meshes = [];
    for (const part of parts) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, list.length);
      const local = part.matrixWorld;
      instMats.forEach((m, k) => im.setMatrixAt(k, m.clone().multiply(local)));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = meta.shadow !== false && meta.shadow !== 'receive';
      im.receiveShadow = meta.shadow !== false;
      im.name = `prop:${id}`;
      im.userData.gfSlot = `prop.${id}`;
      im.userData.gfProp = id;
      root.add(im); meshes.push(im);
    }
    propsMap.set(id, list.map((p, k) => ({ ...p, matrix: instMats[k], meshes, instance: k })));
    if ((meta.tags ?? []).includes('cloud')) drifting.push({ meshes, mats: instMats, locals: parts.map(p => p.matrixWorld.clone()), speed: 0.4 });
    for (const [k, p] of list.entries()) {
      if (meta.light) lampPoints.push({ prop: id, position: new THREE.Vector3(...meta.light.at).multiplyScalar(fit).applyMatrix4(instMats[k] ?? matrixOf(p)), radius: meta.light.radius ?? 1 });
    }
  }));
  // an indoor world's walls reach the ceiling: a band (a kit primitive, slot world.<t>.ceiling.band) closes the gap from
  // the top of each wall piece to the ceiling, so the rooms are closed and the pieces keep their proportions
  const hung = [];
  let band = null;
  if (ceiling) {
    const H = cfg.ceiling.height, mats = [];
    for (const p of placements) {
      const meta = byId.get(p.prop), tags = meta?.tags ?? [];
      if (!tags.includes('wall') || !meta.size) continue;
      const sc = Array.isArray(p.scale) ? p.scale : [p.scale ?? 1, p.scale ?? 1, p.scale ?? 1];
      const y1 = (p.at?.[1] ?? 0) + meta.size[1] * sc[1];
      if (y1 >= H - 0.02) continue;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (Array.isArray(p.rot) ? p.rot[1] : p.rot ?? 0) * DEG);
      mats.push(new THREE.Matrix4().compose(new THREE.Vector3(p.at[0], (y1 + H) / 2, p.at[2]), q, new THREE.Vector3(meta.size[0] * sc[0], H - y1, Math.max(0.12, meta.size[2] * sc[2]))));
    }
    if (mats.length) {
      band = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0), material('prop', { color: cfg.ceiling.band ?? '#efe6da' }), mats.length);
      mats.forEach((m, k) => band.setMatrixAt(k, m));
      band.instanceMatrix.needsUpdate = true; band.computeBoundingSphere();
      band.name = 'wall-band'; band.castShadow = true; band.receiveShadow = true;
      band.userData.gfSlot = `world.${cfg.template}.ceiling.band`;
      root.add(band);
    }
    // what hangs from the ceiling (lamps) goes with it in the cutaway
    for (const c of root.children) if (c.isInstancedMesh && (byId.get(c.userData.gfProp)?.tags ?? []).includes('ceiling')) hung.push(c);
  }
  // the colliders: one list (kit/world/colliders.js, open builder wave 10): the ground, every placement's catalog
  // collider (a doorway: two posts and a lintel) at its model's fit, the invisible walls round the play area
  const colliders = collidersOf(cfg, catalog, { fit: id => fits.get(id) ?? 1 });
  ctx.scene?.add(root);

  // ctx.physics is the Rapier world (CONTRACT §3) or K1's { RAPIER, world } (kit/core/boot.js); both work
  const phys = ctx.physics?.createRigidBody ? ctx.physics : ctx.physics?.world;
  const RAPIER = ctx.RAPIER ?? ctx.physics?.RAPIER ?? (phys ? (await import('@dimforge/rapier3d-compat')).default : null);
  const rapierColliders = phys ? buildColliders(RAPIER, phys, colliders, MATERIALS.party) : [];

  const box = new THREE.Box3(new THREE.Vector3(-size[0] / 2, 0, -size[1] / 2), new THREE.Vector3(size[0] / 2, cfg.bounds?.height ?? 4, size[1] / 2));
  box.half = Math.max(size[0], size[1]) / 2;   // K1's stand-in API (world.bounds.half)
  const shadowBox = new THREE.Box3().setFromObject(root.children.find(o => o.name === 'ground'));
  // the sun's shadows cover the play island and what stands on it (the islands toward the horizon cast none worth the map)
  for (const c of root.children) if (c.isInstancedMesh && !(byId.get(c.userData.gfProp)?.tags ?? []).includes('cloud') && c.name !== 'clouds') { c.computeBoundingBox?.(); if (c.boundingBox) shadowBox.union(c.boundingBox); }
  if (isles) shadowBox.intersect(new THREE.Box3().setFromObject(isles.ground).expandByScalar(4));
  // an indoor world's street and skyline reach far out: the sun's shadows only need the building and its sidewalk
  if (cfg.ceiling?.height) shadowBox.intersect(new THREE.Box3(new THREE.Vector3(-size[0] / 2 - 6, -1, -size[1] / 2 - 6), new THREE.Vector3(size[0] / 2 + 6, cfg.ceiling.height + 1, size[1] / 2 + 6)));
  shadowBox.min.y = Math.min(shadowBox.min.y, 0);
  if (ctx.look) { ctx.look.fitShadows(shadowBox); ctx.look.setLamps(lampPoints); }

  // spawn points face the centre of the play area (yaw, radians; 0 = +z), like K1's stand-in; in a world with rooms,
  // the main room's middle (the centre zone), so nobody starts facing a wall
  const mid = (cfg.rooms?.length && cfg.zones?.centre?.at) || [0, 0, 0];
  const spawns = (cfg.spawns ?? [[0, 0, 0]]).map(s => { const p = v3(s); p.yaw = Math.atan2(mid[0] - p.x, mid[2] - p.z); return p; });
  const zones = Object.fromEntries(Object.entries(cfg.zones ?? {}).map(([name, z]) => [name, zoneOf(name, z)]));
  const raycaster = new THREE.Raycaster();
  const via = createRouter(cfg);
  const entries = (cfg.entries ?? []).map(e => ({ ...e }));
  const world = {
    template: cfg.template, layout: cfg, root, group: root, bounds: box, shadowBounds: shadowBox, lampPoints,
    kind: cfg.kind ?? (cfg.ceiling ? 'indoor' : 'outdoor'), sizeClass: cfg.sizeClass ?? null, ceiling,
    rooms: cfg.rooms ?? [], doors: cfg.doors ?? [], entries,
    /** A camera place that shows one kind of view (a sea-islands world: sea-places.mjs; seat, day, cliff-edge, beach,
     *  sea-view) or null (a yard or a building has none: the camera frames the player). */
    place: where => (cfg.islands?.length ? seaPlace(cfg, where) : null),
    /** The room that holds (x, z), or null. */
    roomAt: (x, z) => roomAt(cfg, x, z),
    /** The next point to walk to from `from` toward `to` ({x, z}): a door when they are in different rooms, else null. */
    via,
    /** Where an enemy comes in: just inside a real door to the outside (null when the world has none). rng() → 0..1 */
    entry(rng = Math.random) { if (!entries.length) return null; const e = entries[Math.floor(rng() * entries.length) % entries.length]; return entryPoint(e, rng); },
    shapes: colliders,                                           // collider descriptors (always)
    colliders: phys ? rapierColliders : colliders,              // Rapier colliders when there is physics
    isWorld: (c) => rapierColliders.includes(c),
    props: propsMap, catalog,
    spawn(i = 0) { const s = spawns[((i % spawns.length) + spawns.length) % spawns.length]; const p = s.clone(); p.yaw = s.yaw; return p; },
    spawns,
    zone(name) { return zones[name] ?? null; },
    zones,
    raycast(from, dir, max = 100) {
      if (phys && RAPIER) {
        const d = dir.clone().normalize();
        const hit = phys.castRayAndGetNormal(new RAPIER.Ray(from, d), max, true, undefined, undefined, undefined, undefined, (c) => rapierColliders.includes(c));
        if (!hit) return null;
        const t = hit.timeOfImpact ?? hit.toi;
        return { distance: t, point: new THREE.Vector3().copy(from).addScaledVector(d, t), normal: hit.normal ? new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z) : null, collider: hit.collider };
      }
      raycaster.set(from, dir.clone().normalize()); raycaster.far = max;
      const h = raycaster.intersectObject(root, true)[0];
      return h ? { distance: h.distance, point: h.point, object: h.object } : null;
    },
    update(dt) {
      // the cutaway: the ceiling shows while the camera is under it and fades as the camera rises to it
      const cam = ctx.look?.activeCamera ?? ctx.camera;           // a contact-sheet shot renders through its own camera
      if (ceiling && cam) {
        const { height, fade } = ceiling.userData.cutaway;
        const a = Math.max(0, Math.min(1, (height - 0.08 - cam.position.y) / fade));
        ceiling.material.opacity = a; ceiling.visible = a > 0.02; ceiling.material.depthWrite = a > 0.98;
        for (const m of hung) m.visible = a > 0.5;
      }
      isles?.update(dt);
      for (const d of drifting) {
        d.mats.forEach((m, k) => {
          m.elements[12] += d.speed * dt;
          if (m.elements[12] > size[0] * 2.5) m.elements[12] = -size[0] * 2.5;
          d.meshes.forEach((im, j) => { im.setMatrixAt(k, m.clone().multiply(d.locals[j])); im.instanceMatrix.needsUpdate = true; });
        });
      }
    },
    dispose() { ctx.scene?.remove(root); root.traverse(o => { if (o.isInstancedMesh) o.dispose(); }); groundGeo?.dispose(); for (const m of isles?.meshes ?? []) m.geometry.dispose(); ceiling?.geometry.dispose(); },
  };
  ctx.world = world;
  return world;
}

function fitScale(model, meta) {
  if (!meta.size) return 1;
  const b = new THREE.Box3().setFromObject(model);
  const s = b.getSize(new THREE.Vector3());
  const want = Math.max(...meta.size), have = Math.max(s.x, s.y, s.z);
  if (!(have > 0)) return 1;
  const r = want / have;
  return r > 0.67 && r < 1.5 ? 1 : r;   // the library's own models are within a few %; only a foreign replacement is rescaled
}

function zoneOf(name, z) {
  const at = v3(z.at), size = z.size ?? [1];
  return {
    name, shape: z.shape ?? 'circle', at, size,
    contains(p) {
      if ((z.shape ?? 'circle') === 'circle') return (p.x - at.x) ** 2 + (p.z - at.z) ** 2 <= size[0] ** 2;
      return Math.abs(p.x - at.x) <= size[0] / 2 && Math.abs(p.y - at.y) <= (size[1] ?? 1e9) / 2 && Math.abs(p.z - at.z) <= (size[2] ?? size[0]) / 2;
    },
    random(r = Math.random) {
      if ((z.shape ?? 'circle') === 'circle') { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * size[0]; return at.clone().add(new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d)); }
      return at.clone().add(new THREE.Vector3((r() - 0.5) * size[0], 0, (r() - 0.5) * (size[2] ?? size[0])));
    },
  };
}
