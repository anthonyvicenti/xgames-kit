// The library as the runtimes and the builder read it. The library (library/packs: one manifest per asset, the pack's
// sources.json for what a manifest leaves out) is the only art index; this file answers the questions the runtimes'
// own code asks, in the shapes that code reads:
//
//   findAsset(name, scope)    an asset by <pack>/<id>, or by its bare id in a runtime's packs (the names its templates,
//                             tables and defaults use), else anywhere in the library
//   assetFile(asset)          the bytes on this machine (the store, the kit's default set, a mirror, or rebuilt)
//   licenceOf(asset)          { spdx, author, url, title, credit, licenseUrl, modified } as a game's ATTRIBUTION needs
//   propEntry(asset)          a prop as the three runtime's worlds read it (config/props.json, gf-three-props/1)
//   bodyEntry(asset)          a body as create and the studio read it (id, label, height, tint, licence, …)
//
// A runtime's packs are named in one small file beside its code (runtimes/three/art.json, the scenic profile's
// art.json, the forge's cast.json): the order its bare names are looked up in. Plain JSON reads; no three.js.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, REPO_ROOT } from './config.mjs';
import { loadLibrary } from './library.mjs';
import { readSources } from './packs.mjs';
import { fetchAsset, localPath } from './store.mjs';

const readJson = f => JSON.parse(readFileSync(f, 'utf8'));

/** Where each runtime names its packs (the order its bare names resolve in). */
export const SCOPES = Object.freeze({
  three: 'runtimes/three/art.json',
  scenic: 'runtimes/three/profiles/scenic-3d/art.json',
  forge: 'runtimes/forge/cast.json',
});

let STATE = null;
/** The library, read once per process: { config, lib, packs: Map(id → {pack, assets, dir, sources}), byRef }. */
export function artLibrary({ fresh = false, config = null } = {}) {
  if (STATE && !fresh && !config) return STATE;
  const c = config ?? loadConfig();
  const lib = loadLibrary(c);
  const packs = new Map(), byRef = new Map();
  for (const p of lib) {
    packs.set(p.pack.id, { ...p, sources: readSources(p.dir).assets ?? {} });
    for (const a of p.assets) byRef.set(`${a.pack}/${a.id}`, a);
  }
  const state = { config: c, lib, packs, byRef };
  if (!config) STATE = state;
  return state;
}

const scopeCache = new Map();
/** A runtime's packs, in order: ['kenney-platformer-kit', …]. */
export function scopePacks(name, { root = REPO_ROOT } = {}) {
  if (Array.isArray(name)) return name;
  if (!scopeCache.has(name)) {
    const rel = SCOPES[name];
    if (!rel) throw new Error(`no art scope "${name}" (${Object.keys(SCOPES).join(', ')})`);
    const file = path.join(root, rel);
    scopeCache.set(name, existsSync(file) ? readJson(file).packs ?? [] : []);
  }
  return scopeCache.get(name);
}

export const refOf = a => `${a.pack}/${a.id}`;
export const packOf = (a, L = artLibrary()) => L.packs.get(a.pack)?.pack ?? null;
/** What the pack's sources.json keeps for an asset beside its manifest (the fields no manifest field holds). */
export const extraOf = (a, L = artLibrary()) => L.packs.get(a.pack)?.sources?.[a.id] ?? {};

/**
 * An asset by name. "<pack>/<id>" is exact; a bare id is looked up in the scope's packs in order (a runtime's own
 * names), then, with `anywhere` (the default), in every pack. A "library:" prefix is allowed. → manifest or null
 */
export function findAsset(name, scope = null, { anywhere = true, L = artLibrary() } = {}) {
  const n = String(name ?? '').replace(/^library:/, '');
  if (!n) return null;
  if (n.includes('/')) return L.byRef.get(n) ?? null;
  const order = scope ? scopePacks(scope) : [];
  for (const id of order) { const a = L.packs.get(id)?.assets.find(x => x.id === n); if (a) return a; }
  if (!anywhere) return null;
  for (const p of L.packs.values()) { const a = p.assets.find(x => x.id === n); if (a) return a; }
  return null;
}

/** Every asset in a scope's packs, in order (a bare id the first pack has hides the same id in a later one). */
export function assetsIn(scope, { L = artLibrary(), category = null } = {}) {
  const out = [], seen = new Set();
  for (const id of scopePacks(scope)) for (const a of L.packs.get(id)?.assets ?? []) {
    if (seen.has(a.id) || (category && a.category !== category)) continue;
    seen.add(a.id); out.push(a);
  }
  return out;
}

const variantOf = (a, use) => (use ? (a.variants ?? []).find(v => v.use === use) ?? null : null);
/** The asset's bytes on this machine now, without fetching (the store or the kit's default set), or null. */
export function localFile(a, { variant = null, L = artLibrary() } = {}) {
  const v = variantOf(a, variant);
  return localPath(L.config, v?.sha256 ?? a.sha256);
}
/** The asset's bytes on this machine, fetched when they are not here yet (a mirror, or rebuilt from the pinned source). */
export async function assetFile(a, { variant = null, L = artLibrary() } = {}) {
  const v = variantOf(a, variant);
  const r = await fetchAsset(L.config, v ? { ...a, sha256: v.sha256, source: null } : a, packOf(a, L));
  return r.path;
}

/** The licence page of a Creative Commons licence that asks for credit (CC-BY-3.0 → …/by/3.0/), else null. */
export function licenceUrl(spdx) {
  const m = /^CC-BY(-SA|-NC|-ND|-NC-SA|-NC-ND)?-(\d\.\d)$/.exec(String(spdx ?? ''));
  return m ? `https://creativecommons.org/licenses/by${(m[1] ?? '').toLowerCase()}/${m[2]}/` : null;
}

/** An asset's licence as a game carries it: { spdx, author, url, (CC BY:) title, credit, licenseUrl, modified }. */
export function licenceOf(a, L = artLibrary()) {
  const p = packOf(a, L), l = a.licence ?? p?.licence ?? {};
  const out = { spdx: l.spdx ?? 'LicenseRef-Unknown', author: l.author ?? a.source?.author ?? '', url: a.source?.page ?? l.url ?? '' };
  const legal = licenceUrl(out.spdx);
  if (legal) Object.assign(out, { title: extraOf(a, L).title ?? /^"([^"]+)"/.exec(l.credit ?? '')?.[1] ?? a.describe, ...(l.credit ? { credit: l.credit } : {}), licenseUrl: legal, ...(a.source?.modified ? { modified: a.source.modified } : {}) });
  return out;
}

// ---- the three runtime's prop entries (gf-three-props/1, the shape worlds/world.js and the scenic world read) -------
const colliderOut = c => (!c ? null : c.shape === 'none' ? 'none' : { ...c });

/**
 * A prop as the three runtime reads it. `file` is "<pack>/<file>" (the library's name for it); create gives the game
 * its own copy under assets/models/ and writes that path into the game's catalog.
 */
export function propEntry(a, L = artLibrary()) {
  const x = extraOf(a, L), u = { ...(a.use ?? {}), ...(x.use ?? {}) };
  const e = { id: a.id, ref: refOf(a), file: `${a.pack}/${a.file}`, describe: a.describe, tags: a.tags ?? [], collider: colliderOut(u.collider), scale: 1, size: u.size ?? null, tris: a.budgets?.triangles ?? null, bytes: a.bytes, licence: (a.licence ?? packOf(a, L)?.licence)?.spdx };
  if (u.origin && u.origin !== 'feet') e.origin = u.origin;
  if (u.min) e.min = u.min;
  if (x.kind) e.kind = x.kind;
  if (u.hands) e.hands = u.hands;
  if (u.grip) e.grip = { ...(x.gripSocket ? { socket: x.gripSocket } : {}), ...u.grip, ...(x.gripFrom ? { from: x.gripFrom } : {}) };
  if (u.real) e.real = u.real;
  if (x.shadow !== undefined) e.shadow = x.shadow;
  if (u.light) e.light = { at: u.light.at, radius: u.light.range ?? u.light.radius, ...(u.light.color || x.lightColour ? { color: u.light.color ?? x.lightColour } : {}), ...(u.light.intensity !== undefined ? { intensity: u.light.intensity } : {}) };
  if (Array.isArray(u.parts)) e.parts = Object.fromEntries(u.parts.map(p => [p.name ?? p.node, { node: p.node, ...(p.hinge ? { hinge: p.hinge } : {}), ...(p.axis ? { axis: p.axis } : {}), ...(p.range ? { open: p.range[1] } : {}) }]));
  else if (u.parts) e.parts = u.parts;
  if (x.door) e.door = x.door;
  if (x.hosts) e.hosts = x.hosts;
  if (u.materials) e.materials = u.materials;
  return e;
}

// ---- bodies (gf-humanoid-1) -----------------------------------------------------------------------------------------
/** A body as create, the catalog and the studio read it. */
export function bodyEntry(a, L = artLibrary()) {
  const x = extraOf(a, L), u = a.use ?? {}, lic = licenceOf(a, L);
  const judge = (a.validated ?? []).find(v => v.by === 'rig-check');
  // the standing height rig-check measured on the standard (a hat or a raised weapon is not the body's height)
  return {
    id: a.id, ref: refOf(a), label: x.label ?? a.id, file: `${a.pack}/${a.file}`, describe: x.describeFull ?? a.describe, tags: a.tags ?? [],
    from: x.kind ?? (/^bean-/.test(a.id) ? 'bean' : 'library'), rig: u.rig ?? 'gf-humanoid-1', height: judge?.report?.facts?.height ?? u.height ?? u.size?.[1] ?? null, tint: u.tint ?? [],
    ...(x.color ? { color: x.color } : {}), ...(x.default ? { default: true } : {}), bytes: a.bytes, sha256: a.sha256,
    triangles: a.budgets?.triangles ?? null, joints: a.budgets?.joints ?? null,
    license: { spdx: lic.spdx, author: lic.author, url: lic.url, ...(lic.credit ? { credit: lic.credit, title: lic.title } : {}) },
    preview: `library/packs/${a.pack}/${a.preview}`, judge: { ok: judge ? judge.ok !== false : null },
  };
}

/** Bodies in a scope that pass their validator (a body the model judge fails is never offered), a pack's default first. */
export function bodiesIn(scope, { L = artLibrary(), all = false } = {}) {
  const list = assetsIn(scope, { L, category: 'body' }).filter(a => all || (a.validated ?? []).every(v => v.ok !== false)).map(a => bodyEntry(a, L));
  return [...list.filter(b => b.default), ...list.filter(b => !b.default)];
}

/** A runtime's props as one catalog (gf-three-props/1): what the world checks read when no game's own catalog is there. */
export function propsCatalog(scope = 'three', { L = artLibrary() } = {}) {
  return { schema: 'gf-three-props/1', about: `The asset library's props in the ${scope} packs (builder/art/views.mjs).`, props: assetsIn(scope, { L, category: 'prop' }).map(a => propEntry(a, L)) };
}

/** A runtime's picture by its file name ("noise-soft.png"): the local file, or null. */
export function pictureFile(name, scope = 'three', { L = artLibrary() } = {}) {
  const a = findAsset(String(name).split('/').pop().replace(/\.[^.]+$/, ''), scope, { anywhere: false, L });
  return a && a.dimension === '2d' ? localFile(a, { L }) : null;
}

/**
 * One asset's file on this machine by its ref ("humanoid-clips/gf-humanoid-1"), reading only that manifest (cheap: for
 * a module's default, e.g. the clip file rig-check plays). null when the asset or its bytes are not here.
 */
export function refFile(ref, { config = null } = {}) {
  const c = config ?? STATE?.config ?? loadConfig();
  const [pack, id] = String(ref).split('/');
  for (const dir of [c.packsDir, path.join(c.privatePacks, 'packs')]) {
    const f = path.join(dir, pack, 'assets', `${id}.json`);
    if (existsSync(f)) return localPath(c, readJson(f).sha256);
  }
  return null;
}

/** A library file by bare id in a runtime's packs (or by ref), on this machine: an absolute path or null. */
export function libraryFile(name, scope = 'three', { L = artLibrary() } = {}) {
  const a = findAsset(name, scope, { L });
  return a ? localFile(a, { L }) : null;
}
