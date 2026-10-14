// The style pass at load time (three runtime): every model and picture a slot loads is moved toward the game's look
// once, as it is parsed, so assets from different packs read as one game. The numbers are harmonize-core.js (shared with
// the library's bake, builder/art/harmonize.mjs); this file walks a GLB's materials, colours, vertex colours and
// textures, and a slot's picture.
//
//   kit/assets/assets.js calls harmonizeModel(gltf.scene, slotId, { look, slot }) once per parsed GLB (its clones share
//   the materials) and harmonizePicture(texture, slotId, { look, slot }) once per texture slot (flat games' pictures
//   too). A player's own file (a loadout) is never touched.
//   ctx.look.level(id) calls restyle(settings): every harmonised material and picture is redone from its originals.
//
// What it changes on a model: base colours (or the texture when the colour is a texture's, or the vertex colours),
// emissive colour and strength (capped by emissiveMax), roughness and metalness (toward the look's), the house toon
// material when the look is toon (adoptMaterials 'prop'; bodies are adopted by kit/character), an inverted-hull outline
// on still meshes when the look asks for 'hull' (an extra drawing sharing the geometry; the geometry itself is never
// changed), and a texture's texel density when it is much finer than the look's. Settings: config/look.json harmonize.
import * as THREE from 'three';
import * as H from './harmonize-core.js';
import { adoptMaterials } from './materials.js';

const state = { override: undefined, records: [], textures: new Map(), skipped: [], findings: [] };
const hide = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: false, configurable: true, writable: true });

/** The settings in force: a level's restyle, else the look's own (config/look.json harmonize, its level's over it). */
export function settingsFor(look) { return state.override !== undefined ? state.override : H.settingsOfLook(look); }

// ---- pixels in and out of a texture's image (an <img>, an ImageBitmap, a canvas, or a DataTexture's {data, w, h}) ----
function canvasOf(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = globalThis.document?.createElement('canvas'); if (!c) return null;
  c.width = w; c.height = h; return c;
}
/** A texture's pixels → { width, height, data: Uint8ClampedArray RGBA } or null (compressed, or no canvas here). */
export function pixelsOf(tex) {
  const img = tex?.image;
  if (!img || tex.isCompressedTexture) return null;
  if (img.data && img.width && img.height) {
    const d = img.data; if (!(d instanceof Uint8Array || d instanceof Uint8ClampedArray) || d.length !== img.width * img.height * 4) return null;
    return { width: img.width, height: img.height, data: new Uint8ClampedArray(d) };
  }
  const w = img.naturalWidth ?? img.videoWidth ?? img.width, h = img.naturalHeight ?? img.videoHeight ?? img.height;
  if (!w || !h) return null;
  const c = canvasOf(w, h); if (!c) return null;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return { width: w, height: h, data: g.getImageData(0, 0, w, h).data };
}
/** Pixels → the texture's image (a canvas; a DataTexture keeps its data array), same filters and wrapping. */
function putPixels(tex, pic) {
  if (tex.image?.data && !tex.image.getContext) { tex.image = { data: new Uint8Array(pic.data.buffer, pic.data.byteOffset, pic.data.length), width: pic.width, height: pic.height }; tex.needsUpdate = true; return; }
  const c = canvasOf(pic.width, pic.height);
  c.getContext('2d').putImageData(new ImageData(pic.data, pic.width, pic.height), 0, 0);
  tex.image = c; tex.needsUpdate = true;
}
const sample = (pic, u, v) => {
  u -= Math.floor(u); v -= Math.floor(v);
  const x = Math.min(pic.width - 1, (u * pic.width) | 0), y = Math.min(pic.height - 1, (v * pic.height) | 0), i = (y * pic.width + x) * 4;
  return [pic.data[i], pic.data[i + 1], pic.data[i + 2]];
};

// ---- a model's own colour numbers: its surface by area (a texture read at each triangle's UVs: an atlas's swatches
// count as much as the faces that use them, not as much of the atlas they fill) ----
function surfaceOf(root) {
  const samples = [], perMaterial = new Map(), pics = new Map();
  const picOf = t => { if (!t) return null; if (!pics.has(t)) pics.set(t, pixelsOf(t)); return pics.get(t); };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), s = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse(o => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const g = o.geometry, P = g.attributes.position, UV = g.attributes.uv, COL = g.attributes.color, idx = g.index;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    o.getWorldScale(s); const k = Math.abs(s.x * s.y * s.z) ** (2 / 3) || 1;
    const groups = g.groups.length ? g.groups : [{ start: 0, count: idx ? idx.count : P.count, materialIndex: 0 }];
    for (const gr of groups) {
      const m = mats[gr.materialIndex ?? 0]; if (!m) continue;
      const pic = picOf(m.map), base = m.color ?? new THREE.Color(1, 1, 1);
      const rec = perMaterial.get(m) ?? { area: 0, uvArea: 0, meshes: new Set() }; perMaterial.set(m, rec); rec.meshes.add(o);
      const tris = Math.floor(gr.count / 3), step = Math.max(1, Math.floor(tris / 1500));
      for (let t = 0; t < tris; t += step) {
        const v = j => (idx ? idx.getX(gr.start + t * 3 + j) : gr.start + t * 3 + j);
        const i0 = v(0), i1 = v(1), i2 = v(2);
        a.fromBufferAttribute(P, i0); b.fromBufferAttribute(P, i1); c.fromBufferAttribute(P, i2);
        const area = b.sub(a).cross(c.sub(a)).length() * 0.5 * k * step;
        if (!(area > 0)) continue;
        let r = base.r, gg = base.g, bb = base.b;     // linear
        if (pic && UV) {
          const u = (UV.getX(i0) + UV.getX(i1) + UV.getX(i2)) / 3, w = (UV.getY(i0) + UV.getY(i1) + UV.getY(i2)) / 3;
          const px = sample(pic, u, m.map.flipY ? 1 - w : w);
          r *= H.toLinearByte(px[0]); gg *= H.toLinearByte(px[1]); bb *= H.toLinearByte(px[2]);
          const du1 = UV.getX(i1) - UV.getX(i0), dv1 = UV.getY(i1) - UV.getY(i0), du2 = UV.getX(i2) - UV.getX(i0), dv2 = UV.getY(i2) - UV.getY(i0);
          rec.uvArea += Math.abs(du1 * dv2 - du2 * dv1) * 0.5 * step;
        }
        if (COL) { r *= (COL.getX(i0) + COL.getX(i1) + COL.getX(i2)) / 3; gg *= (COL.getY(i0) + COL.getY(i1) + COL.getY(i2)) / 3; bb *= (COL.getZ(i0) + COL.getZ(i1) + COL.getZ(i2)) / 3; }
        rec.area += area;
        samples.push([H.fromLinear(r), H.fromLinear(gg), H.fromLinear(bb), area]);
      }
    }
  });
  return { stats: H.statsOf(samples), clusters: H.clustersOf(samples), perMaterial, pics };
}

/** An asset's own words for the matter groups: its slot id, its slot's label and description, its materials' and
 *  meshes' names ("leafsGreen", "woodBark"). */
function wordsOf(root, id, slot) {
  const names = new Set([id, slot?.label, slot?.description]);
  root.traverse(o => { if (o.isMesh) { names.add(o.name); for (const m of [].concat(o.material)) names.add(m?.name); } });
  return [...names].filter(Boolean).join(' ');
}

// ---- the hull outline: a back-face copy pushed out along its normals by a share of the distance (about the same
// width in pixels near and far), in the look's ink; it shares the mesh's geometry and is never hit by a ray ----
const hulls = new Map();
function hullMaterial(color, width) {
  const key = `${color}|${width}`;
  if (hulls.has(key)) return hulls.get(key);
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, fog: true });
  m.onBeforeCompile = sh => {
    sh.uniforms.uGfHull = { value: width };
    sh.vertexShader = 'uniform float uGfHull;\n' + sh.vertexShader.replace('#include <project_vertex>', `
      vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
      vec3 gfN = normalize( normalMatrix * objectNormal );
      mvPosition.xyz += gfN * uGfHull * max( 0.5, -mvPosition.z );
      gl_Position = projectionMatrix * mvPosition;`);
  };
  m.customProgramCacheKey = () => 'gf-hull';
  m.userData.gfHull = true;
  hulls.set(key, m);
  return m;
}
function addHulls(root, settings) {
  const width = 0.0012 * Math.max(0.5, Number(settings.outlineWidth) || 1);
  const ink = settings.outlineColor && settings.outlineColor !== 'own' ? settings.outlineColor : '#1a1a24';
  const list = [];
  root.traverse(o => { if (o.isMesh && !o.isSkinnedMesh && !o.userData.gfHull && !o.children.some(x => x.userData.gfHull) && o.geometry?.attributes?.normal) list.push(o); });
  for (const o of list) {
    const h = new THREE.Mesh(o.geometry, hullMaterial(ink, width));
    h.name = `${o.name || 'mesh'}-outline`; h.userData.gfHull = true; h.castShadow = false; h.receiveShadow = false;
    h.raycast = () => {};
    o.add(h);
  }
  return list.length;
}

// ---- one material, from its originals ----
function originals(m) {
  if (!m.userData.gfHarm) hide(m.userData, 'gfHarm', {
    color: m.color?.clone() ?? null, emissive: m.emissive?.clone() ?? null, emissiveIntensity: m.emissiveIntensity ?? 1,
    roughness: m.roughness, metalness: m.metalness, copies: [], clusters: null, slot: null,
  });
  return m.userData.gfHarm;
}
const mapLinear = (P, plan, col) => { const o = H.mapColor(P, plan, H.fromLinear(col.r), H.fromLinear(col.g), H.fromLinear(col.b)); return new THREE.Color(H.toLinearByte(o[0]), H.toLinearByte(o[1]), H.toLinearByte(o[2])); };
const lerp = (a, b, t) => a + (b - a) * t;

function styleMaterial(m, P, settings, clusters, words = '') {
  const o = originals(m);
  o.clusters = clusters; o.words = words;
  const st = H.planOf(P, clusters, { words });
  const s = P?.s ?? 0, textured = !!m.map || !!m.vertexColors;   // a texture's or the vertices' colours are recoloured there
  const colour = o.color && !textured && P ? mapLinear(P, st, o.color) : o.color;
  if (colour) { m.color.copy(colour); m.userData.gfBaseColor?.copy?.(colour); }
  if (o.emissive && m.emissive) {
    const lit = o.emissive.r + o.emissive.g + o.emissive.b > 0.01;
    m.emissive.copy(lit && P ? mapLinear(P, st, o.emissive) : o.emissive);
    const cap = settings?.emissiveMax;
    m.emissiveIntensity = cap != null && lit ? Math.min(o.emissiveIntensity, lerp(o.emissiveIntensity, cap, s)) : o.emissiveIntensity;
  }
  if (settings?.roughness != null && 'roughness' in m) m.roughness = lerp(o.roughness, settings.roughness, s);
  else if ('roughness' in m) m.roughness = o.roughness;
  if (settings?.metalness != null && 'metalness' in m) m.metalness = lerp(o.metalness, settings.metalness, s);
  else if ('metalness' in m) m.metalness = o.metalness;
  // house copies made from this material (adoptMaterials keeps them on o.copies): the same colour under their tint
  for (const c of o.copies) {
    if (!colour) continue;
    c.userData.gfBaseColor?.copy?.(colour);
    c.color.copy(colour); if (c.userData.gfTint != null) c.color.multiply(new THREE.Color(c.userData.gfTint));
  }
}

// ---- textures: each recoloured once per settings, from its own original pixels ----
function styleTexture(tex, P, settings, clusters, { edges = false, density = null, pixelLook = false, words = '' } = {}) {
  let rec = state.textures.get(tex);
  if (!rec) {
    const pic = pixelsOf(tex);
    if (!pic) { state.findings.push(`${tex.userData?.gfSlot ?? tex.name ?? 'a texture'}: not recoloured (${tex.isCompressedTexture ? 'a compressed KTX2 texture: bake a harmonised variant with art harmonize' : 'its pixels cannot be read here'})`); return false; }
    rec = { orig: pic, image: tex.image, key: null };
    state.textures.set(tex, rec);
  }
  const key = `${H.keyOf(settings)}|${clusters?.length ?? 'own'}|${density ?? ''}`;
  if (rec.key === key) return true;
  rec.key = key;
  if (!P) { tex.image = rec.image; tex.needsUpdate = true; return true; }
  let pic = { width: rec.orig.width, height: rec.orig.height, data: new Uint8ClampedArray(rec.orig.data) };
  // much finer than the look's texels a metre: down to it (a pixel look keeps the size and shows whole texels)
  if (density && settings.texelsPerMetre && density > settings.texelsPerMetre * 1.8) {
    const k = Math.min(8, 2 ** Math.floor(Math.log2(density / settings.texelsPerMetre)));
    if (k >= 2 && Math.min(pic.width, pic.height) / k >= 8) {
      const small = H.downsample(pic, k, { hard: pixelLook });
      pic = pixelLook ? H.upsample(small, k, pic.width, pic.height) : small;
    }
  }
  H.harmonizePicture(pic, settings, { clusters, edges, P, words });
  putPixels(tex, pic);
  if (pixelLook) { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; }
  return true;
}

/**
 * A parsed GLB's scene through the pass, in place, once (assets.js: before it is cloned, so every copy shares it).
 * opts: { look (config/look.json), slot (its assets.json slot), settings (instead of the look's) }. → a short report
 */
export function harmonizeModel(root, id, { look = null, slot = null, settings = settingsFor(look) } = {}) {
  if (!root || !settings || !H.slotTaken(settings, id, slot)) { if (root && settings) state.skipped.push(id); return null; }
  const P = H.prepare(settings);
  const { stats, clusters, perMaterial } = surfaceOf(root);
  if (!perMaterial.size) return null;
  const words = wordsOf(root, id, slot);
  const did = new Set();
  for (const [m, rec] of perMaterial) {
    styleMaterial(m, P, settings, clusters, words); did.add('materials');
    originals(m).slot = id;
    if (m.map) {
      const density = settings.texelsPerMetre && rec.area > 0 && rec.uvArea > 0 && m.map.image ? Math.sqrt((rec.uvArea * (m.map.image.width ?? 0) * (m.map.image.height ?? 0)) / rec.area) : null;
      if (styleTexture(m.map, P, settings, clusters, { density, pixelLook: !!settings.quantize, words })) did.add('texture');
    }
  }
  root.traverse(o => {
    const col = o.isMesh && !o.userData.gfHull ? o.geometry?.attributes?.color : null;
    if (!col || !P) return;
    if (!o.geometry.userData.gfHarmColors) hide(o.geometry.userData, 'gfHarmColors', col.array.slice());
    recolourVertices(col, o.geometry.userData.gfHarmColors, P, H.planOf(P, clusters, { words })); did.add('vertex colours');
  });
  if (settings.toon && !/^character\./.test(id)) { adoptMaterials(root, 'prop'); did.add('toon'); }
  if (settings.outline === 'hull') { if (addHulls(root, settings)) did.add('hull outline'); }
  const r = { id, stats, plan: H.planOf(P, clusters, { words }), did: [...did] };
  state.records.push({ root, id, clusters, words, perMaterial: [...perMaterial.keys()] });
  return r;
}

function recolourVertices(col, orig, P, plan) {
  const n = col.count, size = col.itemSize, norm = col.normalized, arr = col.array;
  const max = norm ? (arr instanceof Uint8Array ? 255 : arr instanceof Uint16Array ? 65535 : 1) : 1;
  for (let i = 0; i < n; i++) {
    const r = orig[i * size] / max, g = orig[i * size + 1] / max, b = orig[i * size + 2] / max;   // linear (glTF COLOR_0)
    const o = H.mapColor(P, plan, H.fromLinear(r), H.fromLinear(g), H.fromLinear(b));
    arr[i * size] = H.toLinearByte(o[0]) * max; arr[i * size + 1] = H.toLinearByte(o[1]) * max; arr[i * size + 2] = H.toLinearByte(o[2]) * max;
  }
  col.needsUpdate = true;
}

/**
 * A texture slot's picture through the pass (a flat game's sprite or tile, a world's ground picture), in place, once
 * per settings. opts: { look, slot, settings, style ('pixel' | 'drawn': a flat game's art style) }. → true when it
 * was recoloured.
 */
export function harmonizePicture(tex, id, { look = null, slot = null, settings = settingsFor(look), style = look?.style ?? null } = {}) {
  if (!tex || !settings || !H.slotTaken(settings, id, slot)) return false;
  const rec = { texture: tex, id, style, density: slot?.constraints?.texelsPerMetre ?? null, words: [id, slot?.label, slot?.description].filter(Boolean).join(' ') };
  const ok = stylePicture(rec, settings);
  if (ok) state.records.push(rec);
  return ok;
}
// a picture's own pass: a pixel look's art keeps to the look's ramp and shows whole texels
function stylePicture(rec, settings) {
  const pixel = rec.style === 'pixel' || !!settings?.quantize;
  const s = settings ? { ...settings, quantize: settings.quantize ?? (rec.style === 'pixel' && !!settings.palette?.length) } : null;
  return styleTexture(rec.texture, H.prepare(s), s ?? {}, null, { edges: true, density: settings?.texelsPerMetre ? rec.density : null, pixelLook: pixel, words: rec.words });
}

/**
 * Another look's settings for everything already harmonised (ctx.look.level(id)): materials from their originals,
 * pictures from their original pixels. settings null puts every asset back as it was loaded.
 */
export function restyle(settings) {
  const key = H.keyOf(settings);
  if (state.override !== undefined && H.keyOf(state.override) === key) return 0;
  state.override = settings ?? null;
  const P = H.prepare(settings);
  let n = 0;
  for (const rec of state.records) {
    if (rec.texture) { stylePicture(rec, settings); n++; continue; }
    for (const m of rec.perMaterial) { styleMaterial(m, P, settings, rec.clusters, rec.words); if (m.map) styleTexture(m.map, P, settings ?? {}, rec.clusters, { words: rec.words }); n++; }
    rec.root.traverse(o => { const col = o.isMesh ? o.geometry?.attributes?.color : null; if (col && o.geometry.userData.gfHarmColors) { if (P) recolourVertices(col, o.geometry.userData.gfHarmColors, P, H.planOf(P, rec.clusters, { words: rec.words })); else { col.array.set(o.geometry.userData.gfHarmColors); col.needsUpdate = true; } } });
  }
  return n;
}

/** What the pass did in this page: harmonised slots, skipped slots, findings (QA: window.__gfHarmony.report()). */
export function report() {
  return { settings: state.override !== undefined ? (state.override ? 'restyled' : 'off') : 'the look', assets: state.records.map(r => r.id), skipped: [...new Set(state.skipped)], findings: [...new Set(state.findings)] };
}
if (typeof window !== 'undefined') window.__gfHarmony = { report, restyle };
