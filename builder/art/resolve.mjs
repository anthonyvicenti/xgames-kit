// The resolver: a slot asks by need, the library answers by fit (DESIGN "The asset library").
//
//   need   { category, dimension, rig, words, tags, size, tile, style, role, colorSpace }
//   opts   { kind (id or preset), runtime, devices, policy, paid, used (Set of refs), includeFailed, limit }
//
// Hard limits first: the category, the dimension and the rig must match; an asset that failed its validator or whose
// licence the policy does not allow is not offered (it is listed under `refused` with why). The rest is ranked:
//   1. the kind: an asset in the kind's packs or named by its preset (bodies, props), then one the judge found fits
//   (an asset another slot of the same game already took goes after the free ones of its kind rank)
//   2. the words: the slot's words against the asset's id, tags and description (rarer words weigh more; words.json
//      adds families: an archer's weapon finds a crossbow), with a relevance floor so a kind pack never wins on noise
//   3. budgets for the target devices (a phone: triangles, texture size, bytes; a small variant counts)
//   4. the licence policy (own, CC0 and MIT first; CC-BY with its credit line; a paid maker's only with a key and a yes)
// A mix the creator asks for (an asset outside the kind) is allowed and shown as a finding, never refused.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LIBRARY_ROOT } from './config.mjs';
import { allAssets, refOf } from './library.mjs';
import { usable } from './policy.mjs';

let WORDS = null;
export function loadWords(file = path.join(process.env.XGAMES_LIBRARY ?? LIBRARY_ROOT, 'words.json')) {
  if (!WORDS) WORDS = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { stop: [], also: {} };
  return WORDS;
}

const stem = w => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);
export function tokens(text, words = loadWords()) {
  const stop = new Set(words.stop);
  return [...new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !/^\d+$/.test(w) && !stop.has(w)).map(stem))];
}

/** Device budgets: what one asset may cost on each target (phone is the tightest). */
export const DEVICE_BUDGETS = {
  phone: { body: { triangles: 30000, textureMax: 1024, bytes: 2.5e6 }, prop: { triangles: 15000, textureMax: 1024, bytes: 2e6 }, picture: { textureMax: 2048, bytes: 2e6 } },
  'x-post': { body: { triangles: 30000, textureMax: 1024, bytes: 2.5e6 }, prop: { triangles: 15000, textureMax: 1024, bytes: 2e6 }, picture: { textureMax: 2048, bytes: 2e6 } },
  tablet: { body: { triangles: 40000, textureMax: 2048, bytes: 4e6 }, prop: { triangles: 30000, textureMax: 2048, bytes: 4e6 }, picture: { textureMax: 2048, bytes: 4e6 } },
  laptop: { body: { triangles: 60000, textureMax: 2048, bytes: 6e6 }, prop: { triangles: 60000, textureMax: 2048, bytes: 8e6 }, picture: { textureMax: 4096, bytes: 8e6 } },
  desktop: { body: { triangles: 60000, textureMax: 4096, bytes: 6e6 }, prop: { triangles: 100000, textureMax: 4096, bytes: 12e6 }, picture: { textureMax: 4096, bytes: 12e6 } },
};

/** Does an asset fit the target devices? → { ok, over: [plain words], variant } (a small variant may make it fit). */
export function budgetFit(asset, devices = ['desktop']) {
  const cls = asset.category === 'body' ? 'body' : asset.dimension === '3d' ? 'prop' : 'picture';
  const check = (b, bytes, texMax) => {
    const over = [];
    for (const d of devices) {
      const lim = DEVICE_BUDGETS[d]?.[cls];
      if (!lim) continue;
      if (lim.triangles && (b.triangles ?? 0) > lim.triangles) over.push(`${b.triangles} triangles (a ${d} takes ${lim.triangles})`);
      if (lim.textureMax && (texMax ?? 0) > lim.textureMax) over.push(`${texMax} px textures (a ${d} takes ${lim.textureMax})`);
      if (lim.bytes && (bytes ?? 0) > lim.bytes) over.push(`${(bytes / 1e6).toFixed(1)} MB (a ${d} takes ${(lim.bytes / 1e6).toFixed(1)})`);
    }
    return [...new Set(over)];
  };
  const b = asset.budgets ?? {};
  const over = check(b, asset.bytes, b.textureMax);
  if (!over.length) return { ok: true, over: [], variant: null };
  for (const v of asset.variants ?? []) {
    if (check(b, v.bytes, v.textureMax ?? Math.min(b.textureMax ?? 0, 512)).length === 0) return { ok: true, over: [], variant: v.use };
  }
  return { ok: false, over, variant: null };
}

/** A kind preset by id from the kinds folder, or the preset itself. */
export function loadKind(kind, kindsDir) {
  if (!kind) return null;
  if (typeof kind === 'object') return kind;
  const file = path.join(kindsDir, `${kind}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { id: kind, packs: [], missing: true };
}

// a kind names an asset by its id (or <pack>/<id>); underscores and case are the source's spelling, not the library's
const normId = id => String(id).split('/').pop().toLowerCase().replace(/_/g, '-');
const asList = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v).flat() : []);
/** The asset ids a kind names for a need: its bodies (player or enemies by role) and its props, for the runtime. */
function namedByKind(kind, need, runtime) {
  if (!kind) return new Set();
  const out = new Set();
  const enemyRole = need.role && !/^(player|hero|you)$/.test(need.role);
  if (need.category === 'body') {
    const b = kind.bodies ?? {};
    for (const id of enemyRole ? asList(b.enemies) : asList(b[runtime] ?? b.three)) out.add(normId(id));
  } else {
    for (const id of asList(kind.props?.[runtime] ?? kind.props?.three)) out.add(normId(id));
  }
  return out;
}

/** idf weights from the library's own text, so a rare word (crossbow) weighs more than a common one (wooden). */
function idfOf(assets) {
  const df = new Map();
  for (const a of assets) for (const t of a._tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const n = assets.length || 1;
  return t => Math.log(1 + n / (1 + (df.get(t) ?? 0)));
}

function prepared(a, words = loadWords()) {
  const idT = tokens(a.id.replace(/-/g, ' '), words), tagT = tokens((a.tags ?? []).join(' '), words), descT = tokens(a.describe, words);
  return { ...a, _idT: new Set(idT), _tagT: new Set(tagT), _descT: new Set(descT), _tokens: [...new Set([...idT, ...tagT, ...descT])] };
}
function prepare(lib) {
  const words = loadWords();
  return allAssets(lib).map(a => prepared(a, words));
}

/**
 * Does an asset mean what a slot names? The thing named is the last meaningful word of `name` ("berry" in "Berry",
 * "coin" in "gold-coin"); the asset means it when that word, or a word of its family (words.json), is in its id or its
 * tags. Its description alone is not enough: "a bush with berries" is a bush. → true | false
 */
export function means(asset, name, words = loadWords()) {
  const head = tokens(String(name ?? '').replace(/[-_.]/g, ' '), words).at(-1);
  if (!head || !asset?.id) return false;
  const a = prepared(asset, words), named = t => a._idT.has(t) || a._tagT.has(t);
  return named(head) || (words.also[head] ?? []).some(w => named(stem(w)));
}

/** Does the asset answer one word (itself, or a word of its family)? 1, 0.6 or 0 (0.7 / 0.45 from the description). */
function matchOf(a, t, words) {
  if (a._idT.has(t) || a._tagT.has(t)) return 1;
  let m = a._descT.has(t) ? 0.7 : 0;
  if (!m) for (const s of words.also[t] ?? []) { const ss = stem(s); if (a._idT.has(ss) || a._tagT.has(ss)) return 0.6; if (a._descT.has(ss)) m = Math.max(m, 0.45); }
  return m;
}

/**
 * How well an asset's text answers the need's words: 0..1, rarer words weighing more. The head word (the thing the
 * slot names: "cloud" in "Puffy low-poly cloud") weighs most: an asset that does not answer it keeps half its score.
 */
function wordScore(a, needT, idf, words, head = null) {
  if (!needT.length) return 0;
  const base = bagScore(a, needT, idf, words);
  if (!head) return base;
  const h = matchOf(a, head, words);
  return h ? 0.6 * base + 0.4 * h : 0.5 * base;
}

function bagScore(a, needT, idf, words) {
  let got = 0, total = 0;
  for (const t of needT) {
    const w = idf(t);
    total += w;
    got += w * matchOf(a, t, words);
  }
  return total ? got / total : 0;
}

const sizeFit = (a, size) => {
  const s = a.use?.size;
  if (!size || !s) return 0;
  const ratio = Math.max(...size) / Math.max(1e-6, Math.max(...s));
  return Math.abs(Math.log(ratio));
};

/**
 * Rank the library for one need. → { candidates: [{ ref, asset, kindRank, words, budget, licence, scale, why }], refused, findings }
 */
export function rank(lib, need, opts = {}) {
  const words = loadWords();
  const { runtime = 'three', devices = ['desktop'], policy, paid = null, includeFailed = false, used = new Set() } = opts;
  const kind = opts.kindPreset ?? null;
  const packs = new Set(kind?.packs ?? []);
  const named = namedByKind(kind, need, runtime);
  const all = opts.prepared ?? prepare(lib);
  const idf = idfOf(all);
  const needT = tokens([need.words ?? '', ...(need.tags ?? [])].join(' '), words);
  const head = need.head ? tokens(need.head, words).at(-1) ?? null : null;
  const refused = [], findings = [], out = [];
  for (const a of all) {
    if (need.category && a.category !== need.category) continue;
    if (need.dimension && a.dimension !== need.dimension) continue;
    if (need.rig && a.category === 'body' && a.use?.rig !== need.rig) { refused.push({ ref: refOf(a), why: `rig ${a.use?.rig ?? 'none'}, the slot needs ${need.rig}` }); continue; }
    if (need.rig && a.category === 'clip' && a.use?.rig !== need.rig) continue;
    if (need.style && a.dimension === '2d' && a.use?.style && a.use.style !== need.style) continue;
    if (need.tile && a.dimension === '2d' && a.use?.tile === false) continue;
    const failed = (a.validated ?? []).filter(v => v.ok === false);
    if (failed.length && !includeFailed) { refused.push({ ref: refOf(a), why: `failed ${failed.map(v => v.by).join(', ')}` }); continue; }
    const lic = usable(policy, a.licence ?? a._pack.licence, { paid });
    if (!lic.ok) { refused.push({ ref: refOf(a), why: lic.why }); continue; }
    const inPack = packs.has(a.pack), isNamed = named.has(a.id);
    const judged = (a.fits?.kinds ?? []).find(k => k.kind === kind?.id);
    const kindRank = !kind ? 0 : inPack || isNamed ? 2 : judged?.fits === 'yes' || judged?.fits === 'with-bridge' ? 1 : judged?.fits === 'no' ? -1 : 0;
    const budget = budgetFit(a, devices);
    out.push({ ref: refOf(a), asset: a, kindRank, named: isNamed, words: wordScore(a, needT, idf, words, head), budget, licence: lic, size: sizeFit(a, need.size), used: used.has(refOf(a)) });
  }
  // the relevance floor: with words given, only candidates near the best match compete on kind
  const best = Math.max(0, ...out.map(c => c.words));
  const floor = needT.length ? Math.max(0.15, best * 0.7) : 0;
  const relevant = needT.length ? out.filter(c => c.words >= floor) : out;
  const pool = relevant.length ? relevant : out;
  if (needT.length && !relevant.length && out.length) findings.push(`nothing in the library matches the words "${need.words}" well; the closest of its kind is offered`);
  const bucket = w => Math.round(w * 10) / 10; // words within a tenth compete on the next criteria
  pool.sort((x, y) =>
    (y.kindRank - x.kindRank) ||
    ((x.used ? 1 : 0) - (y.used ? 1 : 0)) ||
    (bucket(y.words) - bucket(x.words)) ||
    ((y.budget.ok ? 1 : 0) - (x.budget.ok ? 1 : 0)) ||
    (x.licence.rank - y.licence.rank) ||
    ((y.named ? 1 : 0) - (x.named ? 1 : 0)) ||
    (y.words - x.words) ||
    (x.size - y.size) ||
    x.ref.localeCompare(y.ref));
  for (const c of pool) {
    const why = [];
    if (c.kindRank === 2) why.push(c.named ? `the ${kind.id} kind names it` : `in a ${kind.id} pack`);
    else if (c.kindRank === 1) why.push(`judged to fit ${kind.id}`);
    else if (kind) why.push(`outside the ${kind.id} kind's packs (a mix: shown as a finding)`);
    if (needT.length) why.push(`words ${Math.round(c.words * 100)}%`);
    if (!c.budget.ok) why.push(`over budget: ${c.budget.over.join('; ')}`);
    else if (c.budget.variant) why.push(`fits ${devices.join(', ')} with its ${c.budget.variant} copy`);
    if (c.licence.duty === 'credit') why.push('needs its credit line in the game');
    if (c.licence.duty === 'key-and-yes') why.push('a paid maker\'s output (key and yes given)');
    if (c.used) why.push('already used by another slot');
    c.why = why;
    c.scale = need.size && c.asset.use?.size ? +(Math.max(...need.size) / Math.max(...c.asset.use.size)).toFixed(3) : null;
  }
  return { candidates: pool, refused, findings };
}

/** One need → { status, pick, alternates, findings, refused, next } */
export function resolveNeed(lib, need, opts = {}) {
  const { candidates, refused, findings } = rank(lib, need, opts);
  const limit = opts.limit ?? 5;
  if (!candidates.length) {
    return { status: 'none', need, pick: null, alternates: [], refused: refused.slice(0, limit), findings: [...findings, `the library has no ${need.dimension ?? ''} ${need.category ?? 'asset'}${need.rig ? ` on ${need.rig}` : ''} for this slot`], next: 'connection' };
  }
  const top = candidates[0];
  const f = [...findings];
  if (opts.kindPreset && top.kindRank <= 0) f.push(`the pick ${top.ref} is outside the ${opts.kindPreset.id} kind's packs: a style mix`);
  if (!top.budget.ok) f.push(`the pick ${top.ref} is over budget for ${(opts.devices ?? ['desktop']).join(', ')}: ${top.budget.over.join('; ')}`);
  return { status: 'found', need, pick: summary(top), alternates: candidates.slice(1, limit).map(summary), refused: refused.slice(0, limit), findings: f, next: null };
}

function summary(c) {
  const a = c.asset, licence = a.licence ?? a._pack.licence;
  return {
    ref: c.ref, pack: a.pack, id: a.id, file: a.file, sha256: a.sha256, describe: a.describe, category: a.category,
    licence: { spdx: licence.spdx, author: licence.author, ...(licence.credit ? { credit: licence.credit } : {}) },
    credit: c.licence.duty === 'credit' ? licence.credit : null,
    variant: c.budget.variant, scale: c.scale, preview: `${a.pack}/${a.preview}`, score: { kind: c.kindRank, words: +c.words.toFixed(3), budget: c.budget.ok, licence: c.licence.rank }, why: c.why,
  };
}

// ---- slots ---------------------------------------------------------------------------------------------------------
const BOILER = /^(a|an) [a-z ]*prop\. metres.*$|metres, y up.*$|a replacement is fitted.*$/i;
/** What a gf-assets slot asks for, from its declaration. null for a slot the library does not fill (numbers, colours, text). */
export function needFromSlot(slot) {
  const id = slot.id, c = slot.constraints ?? {};
  const desc = String(slot.description ?? '').split(/(?<=\.)\s+/).filter(s => !BOILER.test(s.trim())).join(' ');
  const tail = id.split('.').slice(1).join(' ').replace(/-/g, ' ');
  const base = [slot.label, desc, slot.generate?.prompt].filter(Boolean).join(' ');
  const head = slot.label ?? null; // its last meaningful word is the thing the slot names
  if (slot.type === 'model') {
    // a body: its rig standard (gf-humanoid-1, or a creature's: CREATURES.md) and role (a seat's body is its role's)
    if (id.startsWith('character.body.')) { const role = id.slice(15).replace(/\.seat\d+$/, ''); return { slot: id, category: 'body', dimension: '3d', rig: c.rig ?? 'gf-humanoid-1', ...(c.archetype ? { archetype: c.archetype } : {}), role, words: `${base} ${role}` }; }
    if (id === 'character.clips' || /\.clips$/.test(id)) return { slot: id, category: 'clip', dimension: '3d', rig: c.rig ?? 'gf-humanoid-1', words: 'clips animation' };
    if (id.startsWith('character.hat')) return { slot: id, category: 'prop', dimension: '3d', words: `hat cap ${base}`, tags: ['wearable'] };
    return { slot: id, category: 'prop', dimension: '3d', words: `${base} ${tail}`, head, size: Array.isArray(c.size) ? c.size : null };
  }
  if (slot.type === 'image') {
    const flat = c.tile?.standard ? c.tile : null;
    // a game's tile kind is drawn in every cell of its kind, so it repeats: a piece (use.tile false) never fills it
    if (flat) return { slot: id, category: 'tile', dimension: '2d', style: flat.style, tile: true, words: `${base} ${tail}`, head };
    return { slot: id, category: 'texture', dimension: '2d', tile: !!c.tile, words: `${base} ${tail}`, head };
  }
  if (slot.type === 'audio' || slot.type === 'sound') return { slot: id, category: 'sound', dimension: 'audio', words: `${base} ${tail}` };
  return null;
}

/**
 * Fill every file slot of a game's slot list. slots: assets.json → slots (array or map). → { filled, none, skipped, findings }
 * Each pick avoids an asset another slot already took when an equally good one is free.
 */
export function fillSlots(lib, slots, opts = {}) {
  const list = Array.isArray(slots) ? slots : Object.values(slots);
  const used = new Set(), filled = [], none = [], skipped = [];
  const prepared = prepare(lib);
  for (const s of list) {
    const need = needFromSlot(s);
    if (!need) { skipped.push(s.id); continue; }
    const r = resolveNeed(lib, need, { ...opts, used, prepared });
    if (r.status === 'found') { used.add(r.pick.ref); filled.push({ slot: s.id, optional: !!s.optional, current: s.source?.file ?? null, ...r }); }
    else none.push({ slot: s.id, optional: !!s.optional, ...r });
  }
  return { filled, none, skipped };
}

/** art find: free words and a few switches → the ranked list. */
export function find(lib, query, opts = {}) {
  const need = { words: query, head: query, ...(opts.dimension ? { dimension: opts.dimension } : {}), ...(opts.category ? { category: opts.category } : {}), ...(opts.rig ? { rig: opts.rig } : {}) };
  const r = rank(lib, need, opts);
  return { need, results: r.candidates.slice(0, opts.limit ?? 10).map(summary), refused: r.refused.slice(0, opts.limit ?? 10), findings: r.findings };
}
