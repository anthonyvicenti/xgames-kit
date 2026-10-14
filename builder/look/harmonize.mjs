// The style pass, builder side (looks wave 3): what the look target asks of mixed art, and the pass on files.
//
//   harmonizeValues(target, { style, groundTexels }) → the `harmonize` block of config/look.json (null: nothing to ask)
//   harmonizeLook(C, spec, { place })                → create's seam (apply.mjs applyTarget): C.look.harmonize, and each
//                                                      level's under C.look.levels.<id>.harmonize; spec look.harmonize wins
//   objectColours(target)                            → the look's colours of things (its sky, sea, clouds and ink left out)
//   harmonizePng(bytes, settings, opts)              → a picture through the pass (sharp in, sharp out)
//   harmonizeGlb(bytes, settings)                    → a GLB through the pass (gltf-transform): colours, textures, vertex
//                                                      colours, roughness, metalness, emissive; geometry byte for byte
//   distanceTo(palette, settings)                    → how far an asset's colours are from the look's (OKLab)
//
// The numbers are runtimes/three/kit/look/harmonize-core.js: the runtime runs the same pass at load time
// (kit/look/harmonize.js), and the library's bake (builder/art/harmonize.mjs) writes it into new assets.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as H from '../../runtimes/three/kit/look/harmonize-core.js';
import { targetOfLook } from './looks.mjs';
import { hexToOklab, paletteDistance } from './stats.mjs';

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const r3 = x => Math.round(x * 1000) / 1000;

/** Palette roles that are not things: the sky, the sea, clouds and smoke, the letterbox and the ink lines, the UI. */
export const NOT_THINGS = /\b(sky|skies|sea|ocean|water|waves?|cloud|clouds|smoke|haze|fog|mist|letterbox|bars?|ink|ui|hud|text|menu|outline|space|void|background)\b/i;

/**
 * The look's colours of things: the palette's swatches whose role names a surface or an object (grass, rock, wood,
 * foliage …); with no roles, the swatches that are neither near-black nor near-white greys. A look whose swatches are
 * all sky and sea keeps its ground region's colours. A target with looks (levels) adds the other looks' colours at a
 * smaller share: things travel between levels (a crate is a crate at dusk too), so a level's few frames do not decide
 * every hue a thing may keep; and the look's accents (ui.accent, vfx.palette). → [{hex, share}] (at most 12)
 */
export function objectColours(target, { looks = target?.looks ?? [] } = {}) {
  const own = colours(target?.palette?.colors ?? [], target?.regions?.ground?.colors ?? []);
  const rest = looks.filter(L => L.id !== target?.level?.id).map(L => colours(L.palette?.colors ?? [], []));
  // the look's accents (its HUD's and its effects' colours): small saturated things of the look (a red barrel, a yellow
  // fuse) have a colour to keep, though no frame's big areas show it
  const accents = colours([...(target?.ui?.accent ?? []).map(hex => ({ hex, share: 1, role: 'accent' })), ...(target?.vfx?.palette ?? []).map(hex => ({ hex, share: 1, role: 'fire explosion' }))], []).map(c => ({ ...c, share: 0.03 }));
  const all = [...own.map(c => ({ ...c, share: c.share * (rest.length ? 0.6 : 1) })), ...rest.flatMap(list => list.map(c => ({ ...c, share: (c.share * 0.4) / rest.length }))), ...accents];
  // near-duplicates merged (OKLab ΔE under 0.04), the biggest kept
  const out = [];
  for (const c of all.sort((x, y) => y.share - x.share)) {
    const lab = hexToOklab(c.hex), twin = out.find(o => Math.hypot(...o.lab.map((v, i) => v - lab[i])) < 0.04);
    if (twin) twin.share += c.share; else out.push({ ...c, lab });
  }
  const top = [...out.filter(c => c.share > 0.03).slice(0, 12 - Math.min(4, accents.length)), ...out.filter(c => c.share <= 0.03)].slice(0, 12), tot = top.reduce((s, c) => s + c.share, 0) || 1;
  return top.map(c => ({ hex: c.hex.toLowerCase(), share: r3(c.share / tot), role: c.role ?? '' }));
}
function colours(cols, ground) {
  let out = cols.filter(c => {
    if (c.role && NOT_THINGS.test(c.role)) return false;
    const [L, a, b] = hexToOklab(c.hex), C = Math.hypot(a, b);
    return !(L < 0.12 || (L > 0.92 && C < 0.03));
  });
  if (out.length < 2) out = [...out, ...ground.filter(c => { const [L] = hexToOklab(c.hex); return L > 0.12 && L < 0.95; })];
  const tot = out.reduce((s, c) => s + (c.share ?? 0), 0) || 1;
  return out.map(c => ({ hex: c.hex, share: (c.share ?? 0) / tot, role: c.role ?? '' }));
}

const TOON = new Set(['toon', 'soft-toon', 'flat', 'painterly', 'pixel']);
/** ART-STANDARD.md (flat-2d): texels a metre by art style. */
export const FLAT_TEXELS = { pixel: 16, drawn: 128 };

/**
 * A look target → the style pass's settings for config/look.json (harmonize-core.js documents each). style: a flat
 * game's art style ('pixel' | 'drawn'), null for 3D; groundTexels: the 3D ground picture's texels a metre (props match
 * it); looks: a whole target's looks when `target` is one of them (targetOfLook drops them). null when the target has
 * no colours of things and asks for no material change.
 */
export function harmonizeValues(target, { style = null, groundTexels = null, looks = undefined } = {}) {
  if (!target) return null;
  const cols = objectColours(target, looks ? { looks } : {});
  const M = target.materials ?? {}, E = target.edges ?? {};
  const out = {};
  out.strength = target.from === 'words' ? 0.55 : target.from === 'kind' ? 0.5 : 0.85;
  if (cols.length) {
    out.palette = cols.map(c => c.hex);
    out.weights = cols.map(c => c.share);
    if (cols.some(c => c.role)) out.roles = cols.map(c => c.role ?? '');
  }
  const pixel = style === 'pixel' || M.texture === 'pixel' || M.shading === 'pixel';
  if (!style) {
    if (M.roughness != null) out.roughness = r3(M.roughness);
    if (M.shading && M.shading !== 'pbr') { out.metalness = 0; out.emissiveMax = 1; }
    out.toon = TOON.has(M.shading);
  }
  const level = E.outline ?? 'none';
  out.outline = style ? (level === 'mid' || level === 'high' || (pixel && level !== 'none') ? 'ink' : 'none') : level === 'high' ? 'hull' : level === 'mid' ? 'post' : 'none';
  out.outlineColor = pixel && !E.outlineColor ? 'own' : (E.outlineColor ?? '#1a1a24');
  if (pixel) out.quantize = true;
  const tpm = style ? FLAT_TEXELS[style] : groundTexels;
  if (tpm) out.texelsPerMetre = Math.round(tpm);
  return out.palette || out.roughness != null || out.toon || out.outline !== 'none' ? out : null;
}

/**
 * The ground picture's texels a metre, when the spec's world names a library picture and the size it covers (the
 * terrain world: world.params.materials.top {from: 'library:<pack>/<id>', size}). The picture's side is read from its
 * manifest (budgets.textureMax). null otherwise.
 */
export function groundTexelsOf(spec, { packDirs = defaultPackDirs() } = {}) {
  const top = spec?.world?.params?.materials?.top;
  const m = /^library:([^/]+)\/(.+)$/.exec(top?.from ?? '');
  if (!m || !(top.size > 0)) return null;
  for (const dir of packDirs) {
    const f = path.join(dir, m[1], 'assets', `${m[2]}.json`);
    if (!existsSync(f)) continue;
    const px = JSON.parse(readFileSync(f, 'utf8')).budgets?.textureMax;
    return px ? px / top.size : null;
  }
  return null;
}
function defaultPackDirs() {
  const here = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../library/packs');
  const home = process.env.XGAMES_PRIVATE_PACKS ?? path.join(process.env.HOME ?? '', '.xgames/private-packs');
  return [here, path.join(home, 'packs')];
}

/**
 * create's seam (apply.mjs applyTarget, after the target's values): the target's harmonize settings into the game's look,
 * each level's own when the look has levels, the spec's look.harmonize over them (false: off). Changes C.look in place.
 * → { on, notes }
 */
export function harmonizeLook(C, spec, { place = {} } = {}) {
  const notes = [];
  if (!C?.look) return { on: false, notes };
  const own = spec?.look?.harmonize, t = spec?.look?.target;
  if (own === false) { delete C.look.harmonize; notes.push('style pass: off (spec look.harmonize false)'); return { on: false, notes }; }
  const style = place.profile === 'flat-2d' ? (C.look.style ?? spec?.look?.style ?? null) : null;
  const opts = { style, groundTexels: style ? null : groundTexelsOf(spec) };
  // the look's own picks are what it looks like: the world's pictures the look chose from the library (world.mjs puts
  // them in world.params.materials as library: refs) are left as they are, not moved toward frame colours
  const picked = Object.entries(spec?.world?.params?.materials ?? {}).filter(([, m]) => /^library:/.test(m?.from ?? '')).map(([k]) => `world.terrain.${k}`);
  const withSkip = v => (v && picked.length ? { ...v, skip: [...new Set([...(v.skip ?? []), ...picked])] } : v);
  const merge = v => withSkip(isObj(own) ? { ...(v ?? {}), ...own } : v);
  const base = merge(harmonizeValues(t, opts));
  if (!base) return { on: false, notes };
  C.look.harmonize = base;
  if (t?.looks?.length >= 2 && isObj(C.look.levels)) {
    for (const id of Object.keys(C.look.levels)) {
      const v = merge(harmonizeValues(targetOfLook(t, id), { ...opts, looks: t.looks }));
      if (v) C.look.levels[id].harmonize = v;
    }
  }
  notes.push(`style pass: models and pictures moved toward ${base.palette?.length ?? 0} look colours at strength ${base.strength}${base.toon ? ', toon materials' : ''}${base.outline !== 'none' ? `, ${base.outline} outline` : ''}${base.texelsPerMetre ? `, ${base.texelsPerMetre} texels a metre` : ''}${C.look.levels ? ' (each level its own)' : ''}`);
  return { on: true, notes };
}

/** How far a set of colours is from the look's colours of things: palette transport (OKLab ×100), and the gaps in mean
 *  lightness and chroma. palette: [{hex|colour, share}] (a signature's top colours). */
export function distanceTo(palette, settings) {
  const P = (palette ?? []).map(c => ({ lab: hexToOklab(c.hex ?? c.colour), share: c.share ?? 1 })).filter(c => c.share > 0);
  const Q = (settings?.palette ?? []).map((hex, i) => ({ lab: hexToOklab(hex), share: settings.weights?.[i] ?? 1 }));
  if (!P.length || !Q.length) return null;
  const mean = (xs, f) => xs.reduce((s, c) => s + f(c) * c.share, 0) / xs.reduce((s, c) => s + c.share, 0);
  const chroma = c => Math.hypot(c.lab[1], c.lab[2]);
  return { palette: +paletteDistance(P, Q).toFixed(2), lightness: +Math.abs(mean(P, c => c.lab[0]) - mean(Q, c => c.lab[0])).toFixed(3), chroma: +Math.abs(mean(P, chroma) - mean(Q, chroma)).toFixed(3) };
}

// ---- the pass on files ----
let depsP = null;
const deps = () => (depsP ??= import('../art/deps.mjs'));

/**
 * A picture (PNG, JPEG, WebP) through the pass → { bytes (PNG), did, stats }. opts.style ('pixel' | 'drawn': the
 * picture's own art style), opts.texelsPerMetre (the picture's own: a picture much finer than the look's is pixelated
 * to it, same size), opts.edges (false for a texture wrapped on a model).
 */
export async function harmonizePng(bytes, settings, { style = null, texelsPerMetre = null, edges = true, words = '' } = {}) {
  const { sharp } = await deps();
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let pic = { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
  const did = [];
  const s = { ...settings, quantize: settings.quantize ?? (style === 'pixel' && !!settings.palette?.length) };
  if (settings.texelsPerMetre && texelsPerMetre && texelsPerMetre > settings.texelsPerMetre * 1.8) {
    const k = Math.min(8, Math.floor(texelsPerMetre / settings.texelsPerMetre));
    if (k >= 2 && Math.min(pic.width, pic.height) / k >= 4) { pic = H.upsample(H.downsample(pic, k, { hard: style === 'pixel' || !!s.quantize }), k, pic.width, pic.height); did.push(`texels ${texelsPerMetre} → ${Math.round(texelsPerMetre / k)} a metre`); }
  }
  const r = H.harmonizePicture(pic, s, { edges, words });
  return { bytes: await sharp(Buffer.from(pic.data.buffer, pic.data.byteOffset, pic.data.length), { raw: { width: pic.width, height: pic.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer(), did: [...did, ...r.did], plan: r.plan };
}

/**
 * A GLB through the pass → { bytes, did, stats, findings }. The asset's own numbers are its surface by area (a texture
 * read at each triangle's UVs); base colours, emissive and vertex colours are mapped, textures recoloured through one
 * lookup table, roughness and metalness moved toward the look's. Positions, normals, UVs, indices, skins and
 * animations are written back as they were read.
 */
export async function harmonizeGlb(bytes, settings, { words = '' } = {}) {
  const { sharp, io } = await deps();
  const IO = await io();
  const doc = await IO.readBinary(new Uint8Array(bytes));
  const root = doc.getRoot();
  const P = H.prepare(settings), s = P?.s ?? 0, findings = [], did = new Set();
  // the textures' pixels, decoded once
  const pics = new Map();
  const picOf = async tex => {
    if (!tex) return null;
    if (!pics.has(tex)) {
      const mime = tex.getMimeType();
      if (!/png|jpeg|webp/.test(mime)) { findings.push(`texture ${tex.getName() || tex.getURI() || '(unnamed)'} is ${mime}: left as it is`); pics.set(tex, null); }
      else { const { data, info } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); pics.set(tex, { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), mime }); }
    }
    return pics.get(tex);
  };
  // the surface, by area
  const samples = [], painted = new Set();   // painted: materials drawn with vertex colours (their colours are the vertices')
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION'), uv = prim.getAttribute('TEXCOORD_0'), col = prim.getAttribute('COLOR_0'), idx = prim.getIndices(), mat = prim.getMaterial();
    if (!pos) continue;
    if (col && mat) painted.add(mat);
    const bc = mat?.getBaseColorFactor() ?? [1, 1, 1, 1], pic = await picOf(mat?.getBaseColorTexture());
    const n = idx ? idx.getCount() : pos.getCount(), tris = Math.floor(n / 3), step = Math.max(1, Math.floor(tris / 1500));
    const A = [0, 0, 0], B = [0, 0, 0], Cc = [0, 0, 0], t2 = [0, 0], c4 = [0, 0, 0, 0];
    for (let t = 0; t < tris; t += step) {
      const v = j => (idx ? idx.getScalar(t * 3 + j) : t * 3 + j);
      const i0 = v(0), i1 = v(1), i2 = v(2);
      pos.getElement(i0, A); pos.getElement(i1, B); pos.getElement(i2, Cc);
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = Cc[0] - A[0], vy = Cc[1] - A[1], vz = Cc[2] - A[2];
      const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) * step;
      if (!(area > 0)) continue;
      let r = bc[0], g = bc[1], b = bc[2];
      if (pic && uv) {
        let u = 0, w = 0; for (const i of [i0, i1, i2]) { uv.getElement(i, t2); u += t2[0] / 3; w += t2[1] / 3; }
        u -= Math.floor(u); w -= Math.floor(w);
        const k = (Math.min(pic.height - 1, (w * pic.height) | 0) * pic.width + Math.min(pic.width - 1, (u * pic.width) | 0)) * 4;
        r *= H.toLinearByte(pic.data[k]); g *= H.toLinearByte(pic.data[k + 1]); b *= H.toLinearByte(pic.data[k + 2]);
      }
      if (col) { let cr = 0, cg = 0, cb = 0; for (const i of [i0, i1, i2]) { col.getElement(i, c4); cr += c4[0] / 3; cg += c4[1] / 3; cb += c4[2] / 3; } r *= cr; g *= cg; b *= cb; }
      samples.push([H.fromLinear(r), H.fromLinear(g), H.fromLinear(b), area]);
    }
  }
  const stats = H.statsOf(samples), clusters = H.clustersOf(samples);
  if (!P) return { bytes: Buffer.from(bytes), did: [], stats, findings };
  // the asset's own words (the caller's: its id, tags, description) and its materials' and meshes' names
  const allWords = [words, ...root.listMaterials().map(m => m.getName()), ...root.listMeshes().map(m => m.getName())].join(' ');
  const plan = H.planOf(P, clusters, { words: allWords });
  const mapLinear = ([r, g, b]) => H.mapColor(P, plan, H.fromLinear(r), H.fromLinear(g), H.fromLinear(b)).map(H.toLinearByte);
  const lerp = (a, b, t) => a + (b - a) * t;
  const done = new Set();
  for (const mat of root.listMaterials()) {
    const tex = mat.getBaseColorTexture(), bc = mat.getBaseColorFactor();
    if (!tex && !painted.has(mat)) { mat.setBaseColorFactor([...mapLinear(bc), bc[3]]); did.add('colours'); }
    else if (!done.has(tex)) {
      done.add(tex);
      const pic = await picOf(tex);
      if (pic) {
        H.harmonizePicture(pic, { ...settings, outline: 'none' }, { clusters, edges: false, P, words: allWords });
        const raw = sharp(Buffer.from(pic.data.buffer, pic.data.byteOffset, pic.data.length), { raw: { width: pic.width, height: pic.height, channels: 4 } });
        tex.setImage(new Uint8Array(pic.mime.includes('jpeg') ? await raw.jpeg({ quality: 92 }).toBuffer() : await raw.png({ compressionLevel: 9 }).toBuffer()));
        tex.setMimeType(pic.mime.includes('jpeg') ? 'image/jpeg' : 'image/png');
        did.add('textures');
      }
    }
    const em = mat.getEmissiveFactor();
    if (em[0] + em[1] + em[2] > 0.01) { mat.setEmissiveFactor(mapLinear(em)); did.add('emissive'); }
    if (settings.roughness != null) { mat.setRoughnessFactor(+lerp(mat.getRoughnessFactor(), settings.roughness, s).toFixed(3)); did.add('roughness'); }
    if (settings.metalness != null) { mat.setMetallicFactor(+lerp(mat.getMetallicFactor(), settings.metalness, s).toFixed(3)); did.add('metalness'); }
  }
  const seen = new Set();
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
    const col = prim.getAttribute('COLOR_0');
    if (!col || seen.has(col)) continue;
    seen.add(col);
    const e = [0, 0, 0, 0];
    for (let i = 0; i < col.getCount(); i++) { col.getElement(i, e); const m = mapLinear(e); e[0] = m[0]; e[1] = m[1]; e[2] = m[2]; col.setElement(i, e); }
    did.add('vertex colours');
  }
  if (settings.outline === 'hull' || settings.toon) findings.push('the toon material and the hull outline are the runtime\'s (kit/look/harmonize.js at load time), not baked');
  return { bytes: Buffer.from(await IO.writeBinary(doc)), did: [...did], stats, plan, findings };
}
