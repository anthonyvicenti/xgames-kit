// gf-vista: a gf-humanoid-1 character (research/gf-three/kit/character/RIG.md) drawn by the core's own skinning
// (core/src/engine/render/Skinning.js SkinnedModel: GPU skinning in the material's vertex hook, shadows and motion
// vectors included) and animated by the shared clips (research/gf-three/library/clips/gf-humanoid-1.glb), retargeted
// exactly as rig.js createRetarget does (kit/humanoid-rig.js). No core change: each clip is baked once per body into
// the body's own channels and played by SkinnedModel's crossfading layers.
//
//   import { loadHumanoid, everyFrame } from '../kit/humanoid.js';
//   const h = await loadHumanoid(app, { body: 'bodies/quaternius-casual-man.glb', clips: 'clips/gf-humanoid-1.glb',
//                                       height: 1.858, tint: '#ff7eb3' });
//   h.group                       the core Group (added to app.scene unless add: false)
//   h.play(name, { fade = 0.25, loop = the clip's own, speed = 1, from = 0 })   crossfade to a clip (any gf-humanoid-1
//                                 clip name: idle, walk, run, sprint, jump, … RIG.md §4; fade 0 cuts); returns h
//   h.rate(r)                     playback speed of the clip playing now (a gait matched to the ground speed)
//   h.update(dt)                  advance the animation and upload the joints (every frame, before the frame renders);
//                                 update(0) re-poses with no motion vectors (after a teleport)
//   h.hold()                      when it stops being updated (off screen): no stale motion vectors
//   h.setTransform(pos, yaw)      feet at pos ([x,y,z] or {x,y,z}), facing yaw (radians about +Y; 0 faces +Z)
//   h.bones()                     { name: [x, y, z] } world positions of the canonical bones (bones('model'): the body's
//                                 own space, before setTransform and the height scale)
//   h.speed(name)                 the clip's ground speed in m/s at this body's size (walk, run, sprint), for no foot slide
//   h.setTint(color)              gfTint materials toward color by gfTintMix (RIG.md §8); null puts them back
//   h.express(name | null)        a face from gfFaces (RIG.md §3: a bean's 'hurt'); null: the neutral face. h.faces
//   h.current  h.clips  h.height  h.scale  h.k  h.info   (h.model: the core SkinnedModel)
//   h.dispose()                   removes it from the scene and frees its GPU buffers
//
// Files: `body` and `clips` are paths read through the core's vistaFetch (core/src/vista-io.js, so a game reads them
// through gf-assets with setReader), or ArrayBuffers. The standard clip file and each body's retarget and baked clips
// are cached per path, so a second player of the same body costs only its GPU buffers and textures.
// Materials: the core's glTF PBR material (skinnedMaterial) with the GLB's base colour factor, vertex colours (COLOR_0),
// textures (base colour, metal-roughness, normal) and emissive factor; underwaterLighting 'lite', as the core does for
// its land characters (core/src/game/Vendor.js).
// Not yet: upper-body layers (aim, carry, throw: RIG.md's `layer: 'upper'`; SkinnedModel blends whole poses only),
// ragdolls, sockets, hats, nameplates, timed expressions (express() holds until called again).
import { SkinnedModel } from '../core/src/engine/render/Skinning.js';
import { BufferAttribute } from '../core/src/engine/geometry/BufferAttribute.js';
import { Color, Vector3 } from '../core/src/engine/math/index.js';
import { vistaFetch } from '../core/src/vista-io.js';
import { readGlb, prepareBody, standardFrom, createRetarget, bakeClip, isCanonical } from './humanoid-rig.js';

export { RIG } from './humanoid-rig.js';

const cache = new Map();   // path → Promise of parsed data (standard or body + retarget)
async function bytesOf(src) {
  if (src instanceof ArrayBuffer || ArrayBuffer.isView(src)) return src;
  const res = await vistaFetch(src);
  if (!res.ok) throw new Error(`gf-vista humanoid: ${src}: ${res.status}`);
  return res.arrayBuffer();
}
function once(key, make) {
  if (typeof key !== 'string') return make();
  if (!cache.has(key)) cache.set(key, make().catch(e => { cache.delete(key); throw e; }));
  return cache.get(key);
}
const loadStandard = src => once(typeof src === 'string' ? 'std:' + src : null, async () => standardFrom(await readGlb(await bytesOf(src))));
const loadBody = (src, std, stdKey) => once(typeof src === 'string' ? `body:${src}|${stdKey}` : null, async () => {
  const body = prepareBody(await readGlb(await bytesOf(src)));
  const rt = createRetarget(body, std);
  return { body, rt, baked: new Map() };
});

/** Load a body and the shared clips and make one character. See the top of this file. */
export async function loadHumanoid(app, { body, clips, height = null, tint = null, add = true, initial = 'idle' } = {}) {
  if (!body || !clips) throw new Error('gf-vista humanoid: body and clips are required');
  const std = await loadStandard(clips);
  const data = await loadBody(body, std, typeof clips === 'string' ? clips : 'buffer');
  const { body: b, rt } = data;
  const gltf = { ...b.gltf, animations: [] };
  const prims = gltf.meshes[0];
  const model = await SkinnedModel.create(gltf, {
    materials: info => {
      const gm = info.gltfMaterial, f = gm.pbrMetallicRoughness?.baseColorFactor, e = gm.emissiveFactor;
      const o = {};
      if (f) o.color = new Color(f[0], f[1], f[2]);
      if (e && (e[0] || e[1] || e[2])) o.emissive = new Color(e[0], e[1], e[2]);
      return o;
    },
  });
  // vertex colours (three's GLTFLoader turns them on for a primitive with COLOR_0; SkinnedModel does not read them)
  model.meshes.forEach((m, i) => {
    const c = prims[i]?.color;
    if (!c) return;
    m.geometry.setAttribute('color', new BufferAttribute(c.array, c.itemSize));
    m.material.vertexColors = true;
  });
  for (const m of model.materials) m.underwaterLighting = 'lite';
  const group = model.group;
  group.name = 'gf-humanoid:' + (b.extras.gfBody ?? 'body');
  const scale = height ? height / rt.height : 1;
  group.scale.set(scale, scale, scale);
  if (add && app?.scene) app.scene.add(group);

  // tint (RIG.md §8): gfTint (or tint_*) materials move toward the colour by gfTintMix
  const tintNames = new Set(b.extras.gfTint ?? []);
  const tinted = model.materials.filter(m => { const n = m.name.replace(/^skinned-/, ''); return tintNames.has(n) || n.startsWith('tint_'); });
  const tintBase = new Map(tinted.map(m => [m, m.color.clone()]));
  const tintMix = b.extras.gfTintMix ?? 1;

  // faces (RIG.md §3 gfFaces): the meshes an expression shows stay hidden until express(name)
  const faces = b.extras.gfFaces ?? {};
  const matName = m => m.name.replace(/^skinned:/, '');
  const showOnly = new Set(Object.values(faces).flatMap(f => f.show ?? []));
  let face = null;
  const express = name => {
    const f = name ? faces[name] : null;
    if (name && !f) return;
    face = name || null;
    for (const m of model.meshes) {
      const n = matName(m);
      m.visible = f ? (f.show?.includes(n) || (!showOnly.has(n) && !f.hide?.includes(n))) : !showOnly.has(n);
    }
  };
  express(null);

  const nodes = b.gltf.nodes;
  const canon = [...b.rig.bones].filter(([n]) => isCanonical(n));
  const _v = new Vector3();
  const clipOf = name => {
    let c = data.baked.get(name);
    if (!c) {
      const src = std.clips.get(name);
      if (!src) throw new Error(`gf-vista humanoid: no clip ${name} in the clip file`);
      c = bakeClip(rt, std, src);
      data.baked.set(name, c);
    }
    if (model.clips.get(name) !== c) model.clips.set(name, c);
    return c;
  };

  const h = {
    group, model, height: rt.height * scale, scale, k: rt.k,
    info: { body: b.extras.gfBody ?? null, joints: b.gltf.skins[0].joints.length, primitives: prims.length, materials: model.materials.length, spread: b.rig.spread, fingers: rt.fingers, spineBend: rt.spineBend, warnings: b.warn },
    get current() { return model.current; },
    get clips() { return [...std.clips.keys()]; },
    play(name, { fade = 0.25, loop = std.meta[name]?.loop ?? true, speed = 1, from = 0 } = {}) {
      clipOf(name);
      if (!(fade > 0)) model.layers.length = 0;   // fade 0: this clip alone, from now on
      model.play(name, { fade, loop, speed, from });
      return h;
    },
    rate(r) { for (const l of model.layers) if (l.target === 1) l.speed = r; return h; },
    update(dt) { model.update(dt); },
    hold() { model.hold(); },
    setTransform(pos, yaw = null) {
      if (Array.isArray(pos)) group.position.set(pos[0], pos[1], pos[2]); else if (pos) group.position.set(pos.x, pos.y, pos.z);
      if (yaw !== null) group.rotation.y = yaw;
      group.updateMatrixWorld(true);
      return h;
    },
    bones(space = 'world') {
      const out = {}, W = model.world;
      if (space !== 'model') group.updateMatrixWorld(true);
      for (const [name, i] of canon) {
        _v.set(W[i * 16 + 12], W[i * 16 + 13], W[i * 16 + 14]);
        if (space !== 'model') _v.applyMatrix4(group.matrixWorld);
        out[name] = [_v.x, _v.y, _v.z];
      }
      return out;
    },
    speed(name) { return (std.meta[name]?.speed ?? 0) * rt.k * scale; },
    setTint(color) {
      for (const m of tinted) {
        const base = tintBase.get(m);
        if (color == null) { m.color = base; continue; }
        const c = new Color(color);
        m.color = new Color(base.r + (c.r - base.r) * tintMix, base.g + (c.g - base.g) * tintMix, base.b + (c.b - base.b) * tintMix);
      }
      return h;
    },
    express(name) { express(name); return h; },
    get face() { return face; },
    get faces() { return Object.keys(faces); },
    dispose() { group.parent?.remove(group); model.dispose(); },
    _nodes: nodes,
  };
  if (tint != null) h.setTint(tint);
  if (initial) { h.play(initial, { fade: 0 }); model.update(0); }
  return h;
}

/** Run fn(dt) every frame of the core's loop, after the player and the game and before the frame renders (wraps
 *  app.game.update: the core has no hook of its own yet). Returns a function that stops it. */
export function everyFrame(app, fn) {
  const target = app.game;
  const prev = target.update;
  let on = true;
  target.update = function (dt) { const r = prev.call(this, dt); if (on) fn(dt); return r; };
  return () => { on = false; };
}
