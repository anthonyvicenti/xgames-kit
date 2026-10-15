// verify check 14, looks honoured (CONTRACT §5; no browser, runs in --quick and alone with --check 14).
//
// Creator, 2026-10-07, on the live game Hang Up On Them ("First the final assets look nothing like the reference image";
// research/foundations/evidence/studio-v2-live-hang-up-on-them-creator-feedback-2026-10-07.json): the spec asked for a
// generated zombie and a generated gold-coin token. The zombie's body file was byte for byte the player's jelly bean
// (tinted purple), the token a 3 KB stand-in crate, verify passed 13/13 and the delivery never said so.
//
//   const r = await checkLooks(gameDir);   // { ok, detail, record: { items, pairs }, notes }
//
// It fails when
//   1. a character or prop the spec asks to be generated or made from a reference (`from: 'generate' | 'reference'`) is
//      still a stand-in: its file is byte-identical to a library bean or a kit stand-in file (tools/lib/standin-assets),
//      or to the placeholder create put in that slot (gf-three.json bodies/props), or its GLB says it is a bean (gfBody
//      extras); or the file is missing;
//   2. two roles the spec describes differently (the player and an enemy) share one body file, so they differ only by tint;
//   3. an objective's prop (what a mechanic's objectives() draw, by its manifest's `objectives`, or a goal prop:
//      builder/art/objectives.mjs objectiveProps) is a stand-in, or a library model whose id and tags never name the
//      thing the slot draws (a barrel in the berry slot), whatever the spec asked. The creator, 2026-10-14, on the composed
//      levels: "We were supposed to collect berries, but there were no berries anywhere. I think in the ocean I saw some
//      boxes": the berries were the kit's stand-in crate. A prop the spec names exactly (fill.from library or provided)
//      is the creator's choice. The art step (builder/art/objectives.mjs, `gamesfun art objectives`) fills these slots.
// Library files are the asset library's, in both 3D profiles' packs (builder/art/views.mjs).
// The only excuse is a recorded generation failure: the worker's game/generated.json lists the item with a state that
// is not 'placed' and a reason, and its `delivery` line (what the worker adds to the delivery summary) names the role or
// prop and the file. An item still 'running' (the build agent's own verify while the worker generates) is pending, not a
// failure, and so is one 'queued' (a change job: the worker starts it after the agent, with the look the agent's spec
// gives it); the worker rewrites the record with the outcome before its own verify.
//
// game/generated.json (gf-three-generated/1, written by research/foundations/studio-worker/lib/v2.mjs):
//   { schema, about, items: [{ kind: 'body' | 'prop', key (role or prop name), slot, file, from, asked, reference?,
//     state: 'queued' | 'running' | 'done' | 'placed' | 'failed' | 'refused' | 'timeout' | 'skipped' | 'unplaced', why?, sha256?,
//     license?, attempts: [{ n, started, finished, state, exit?, why? }] }], delivery: "<the stand-in line>" | null }
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { STANDIN_ASSETS, sha256 } from './paths.mjs';
import { assetsIn, findAsset } from '../../art/views.mjs';
import { objectiveProps, triedAndFailed, whatModel } from '../../art/objectives.mjs';
import { readCatalog } from './spec.mjs';

// The asset library's bodies and props in both 3D profiles' packs (runtimes/three/art.json, then the scenic-3d
// profile's): a scenic library body is a real body, never a stand-in, and a game may wear one on any three profile. The
// library names every file by its sha256, so nothing is hashed here.
const libraryAssets = category => { const seen = new Set(); return [...assetsIn('three', { category }), ...assetsIn('scenic', { category })].filter(a => !seen.has(a.sha256) && seen.add(a.sha256)); };

export const GENERATED_FILE = 'generated.json';
export const GENERATED_SCHEMA = 'gf-three-generated/1';
const ASKED = new Set(['generate', 'reference']);
const PENDING = new Set(['queued', 'running', 'done']);   // done: finished, the worker places it next
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const short = (s, n = 60) => { const t = clean(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const readJson = async p => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };

/** The node extras of a GLB (gf_body / gf_prop root and any other node with extras), read from its JSON chunk. */
export function glbExtras(buf) {
  try {
    if (buf.readUInt32LE(0) !== 0x46546c67) return {};
    const len = buf.readUInt32LE(12);
    const j = JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
    return Object.assign({}, ...(j.nodes ?? []).map(n => n.extras ?? {}));
  } catch { return {}; }
}

let libCache = null;
/** sha256 → what it is, for every library body, library prop and kit stand-in file. */
async function libraryIndex() {
  if (libCache) return libCache;
  const bySha = new Map();
  for (const b of libraryAssets('body')) {
    const bean = /^bean-/.test(b.id) || (b.tags ?? []).includes('bean');
    bySha.set(b.sha256, { what: bean ? `the library bean ${b.id}` : `the library body ${b.id}`, standin: bean, id: b.id });
  }
  for (const p of libraryAssets('prop')) if (!bySha.has(p.sha256)) bySha.set(p.sha256, { what: `the library prop ${p.id}`, standin: false, id: p.id, prop: true });
  for (const n of (await readdir(STANDIN_ASSETS).catch(() => [])).filter(n => n.endsWith('.glb')))
    bySha.set(sha256(await readFile(join(STANDIN_ASSETS, n))), { what: `the kit stand-in ${n}`, standin: true, id: n.replace(/\.glb$/, '') });
  libCache = { bySha };
  return libCache;
}

/** The file create put in a slot (gf-three.json → bodies / props `from`: 'library:<id>' | 'standin:<name>') → its sha. */
async function placeholderSha(from) {
  const m = /^(library|standin):(.+)$/.exec(String(from ?? ''));
  if (!m) return null;
  if (m[1] === 'standin') { const f = join(STANDIN_ASSETS, `${m[2]}.glb`); return existsSync(f) ? sha256(await readFile(f)) : null; }
  return (findAsset(m[2], 'three', { anywhere: false }) ?? findAsset(m[2], 'scenic'))?.sha256 ?? null;
}

/** What a game asked to look a certain way: every character, and every prop to generate. */
async function asks(dir) {
  const spec = (await readJson(join(dir, 'spec.json'))) ?? {};
  const record = (await readJson(join(dir, 'gf-three.json'))) ?? {};
  const assets = (await readJson(join(dir, 'assets.json'))) ?? {};
  const chars = (await readJson(join(dir, 'config/characters.json'))) ?? {};
  const gen = await readJson(join(dir, GENERATED_FILE));
  const slotFile = id => assets.slots?.find(s => s.id === id)?.source?.file ?? null;
  const items = [];
  for (const c of spec.characters ?? []) {
    const slot = `character.body.${c.role}`;
    items.push({ kind: 'body', key: c.role, slot, from: c.body?.from ?? 'bean', body: c.body ?? null, describe: clean(c.describe), hat: c.hat ?? null,
      file: slotFile(slot) ?? chars.roles?.[c.role]?.body ?? `assets/models/body-${c.role}.glb`, placeholder: record.bodies?.[c.role]?.from ?? null });
  }
  for (const p of spec.world?.props ?? []) {
    if (!ASKED.has(p.from)) continue;
    const slot = record.named?.[p.name] ?? `prop.${p.name}`;
    const key = slot.replace(/^prop\./, '');
    items.push({ kind: 'prop', key: p.name, slot, from: p.from, describe: clean(p.describe), file: slotFile(slot) ?? `assets/models/${key}.glb`, placeholder: record.props?.[key]?.from ?? record.props?.[p.name]?.from ?? null });
  }
  // what the game's objectives draw (a pickup, a carried item, a goal): held to what it is, whatever the spec asked
  const catalog = await readCatalog().catch(() => null);
  for (const o of objectiveProps(spec, catalog)) {
    if (o.fill?.from === 'library' || o.fill?.from === 'provided') continue;
    const slot = record.named?.[o.name] ?? `prop.${o.name}`;
    const key = slot.replace(/^prop\./, '');
    items.push({ kind: 'objective', key: o.name, slot, from: o.fill?.from ?? 'kind', by: o.by, describe: clean(o.describe), file: slotFile(slot) ?? `assets/models/${key}.glb`, placeholder: null });
  }
  // a revision may ask for a look the game's spec.json predates: the worker's record lists what it was asked to make
  for (const g of gen?.items ?? []) {
    const it = items.find(x => x.kind === g.kind && x.key === g.key);
    if (it) { if (ASKED.has(g.from)) it.from = g.from; continue; }
    if (ASKED.has(g.from)) items.push({ kind: g.kind, key: g.key, slot: g.slot, from: g.from, describe: clean(g.asked), file: g.file ?? slotFile(g.slot), placeholder: null });
  }
  // a prop the spec (or a revision) asks to be made is held by the leg above, which knows the worker's progress
  const made = new Set(items.filter(i => i.kind === 'prop' && ASKED.has(i.from)).map(i => i.key));
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'objective' && made.has(items[i].key)) items.splice(i, 1);
  return { items, gen };
}

const named = it => (it.kind === 'body' ? `the ${it.key}` : it.kind === 'objective' ? `the objective "${it.key}"` : `the prop "${it.key}"`);

/** Check 14. → { ok, detail, record: { items, pairs }, notes } */
export async function checkLooks(gameDir) {
  const dir = gameDir;
  const lib = await libraryIndex();
  const { items, gen } = await asks(dir);
  const delivery = clean(gen?.delivery);
  const notes = [], fails = [], oks = [];
  const recordOf = it => (gen?.items ?? []).find(g => g.kind === it.kind && g.key === it.key) ?? null;
  // a recorded generation that did not land, named (role or prop and file) in the line the delivery gets
  const excuse = it => {
    const g = recordOf(it);
    if (!g) return { ok: false, why: `no record of a generation (game/${GENERATED_FILE} does not list it)` };
    if (PENDING.has(g.state)) return { ok: true, pending: true, why: g.state === 'queued' ? 'the worker generates it after the agent (queued)' : `the worker is still generating it (${g.state})` };
    if (g.state === 'placed') return { ok: false, why: `game/${GENERATED_FILE} says the generated model was placed, but the file is not it` };
    if (!clean(g.why)) return { ok: false, why: `game/${GENERATED_FILE} records state ${g.state} with no reason` };
    if (!delivery || !delivery.includes(it.key) || !delivery.includes(it.file)) return { ok: false, why: `generation ${g.state} (${short(g.why, 100)}), but the delivery line in game/${GENERATED_FILE} does not name ${it.key} and ${it.file}` };
    return { ok: true, why: `generation ${g.state}: ${short(g.why, 100)}; the delivery says so` };
  };

  for (const it of items.filter(i => i.kind === 'objective')) {
    const p = join(dir, it.file ?? '');
    if (!it.file || !existsSync(p)) { it.state = 'missing'; fails.push(`${named(it)} (${it.slot}, drawn by ${it.by.join(', ')}): ${it.file ?? 'no file'} is missing`); continue; }
    const w = await whatModel(await readFile(p), it.key);
    it.sha256 = w.sha256; it.is = w.is;
    if (w.means !== false) { it.state = w.means ? 'means' : 'own'; oks.push(`${it.key} (objective): ${it.file} is ${w.is}`); if (w.means === null) notes.push(`check 14: ${named(it)} is ${w.is} (not in the library, so what it is was not read)`); continue; }
    const g = (gen?.items ?? []).find(x => x.kind === 'prop' && x.key === it.key);
    // a stand-in stays only when making the thing was tried and did not land, and the delivery says so
    if (w.standin && triedAndFailed(g) && delivery.includes(it.key) && delivery.includes(it.file)) { it.state = 'excused'; notes.push(`check 14: ${named(it)} is still ${w.is} (${it.file}); generation ${g.state}: ${short(g.why, 100)}; the delivery says so`); oks.push(`${it.key} (objective): stand-in, excused`); continue; }
    it.state = w.standin ? 'standin' : 'other';
    fails.push(w.standin
      ? `${named(it)} (${it.slot}, drawn by ${it.by.join(', ')}: "${short(it.describe)}") is ${w.is}: ${it.file}; what the player is sent to get must look like it (the art step fills it from the library by meaning or makes it: gamesfun art objectives <game> --yes${g ? `; game/${GENERATED_FILE}: ${g.state}${g.why ? `, ${short(g.why, 100)}` : ''}` : ''})`
      : `${named(it)} (${it.slot}, drawn by ${it.by.join(', ')}: "${short(it.describe)}") is ${w.is}, which is not a ${it.key}: its id and tags never name it (the art step fills it from the library by meaning or makes it: gamesfun art objectives <game> --yes)`);
  }

  for (const it of items.filter(i => i.kind !== 'objective')) {
    const p = join(dir, it.file ?? '');
    if (!it.file || !existsSync(p)) { it.state = 'missing'; if (ASKED.has(it.from)) fails.push(`${named(it)} (${it.slot}, from ${it.from}): ${it.file ?? 'no file'} is missing`); continue; }
    const buf = await readFile(p);
    it.sha256 = sha256(buf);
    const ex = glbExtras(buf);
    const known = lib.bySha.get(it.sha256);
    it.is = known?.what ?? (ex.gfSource === 'meshy' ? 'a generated model (Meshy)' : 'its own model');
    if (!ASKED.has(it.from)) continue;
    let standin = null;
    if (known?.standin) standin = known.what;
    else if (/^bean/.test(String(ex.gfBody ?? '')) || /bean\.mjs$/.test(String(ex.gfGenerator ?? ''))) standin = `a library bean (gfBody ${ex.gfBody ?? '?'})`;
    else if (it.placeholder && it.sha256 === await placeholderSha(it.placeholder)) standin = `the placeholder create put there (${it.placeholder})`;
    if (!standin) { oks.push(`${it.key}: ${it.file} is ${it.is}`); it.state = 'own'; continue; }
    it.standin = standin;
    const e = excuse(it);
    if (e.ok) { it.state = e.pending ? 'pending' : 'excused'; notes.push(`check 14: ${named(it)} is still ${standin} (${it.file}); ${e.why}`); oks.push(`${it.key}: stand-in, ${e.pending ? 'pending' : 'excused'}`); continue; }
    it.state = 'standin';
    fails.push(`${named(it)} (${it.slot}, from ${it.from}: "${short(it.describe)}") is still ${standin}: ${it.file}; ${e.why}`);
  }

  // two roles described differently must not wear one body that differs only by tint
  const pairs = [];
  const bodies = items.filter(i => i.kind === 'body' && i.sha256);
  for (let a = 0; a < bodies.length; a++) for (let b = a + 1; b < bodies.length; b++) {
    const A = bodies[a], B = bodies[b];
    const differ = A.describe.toLowerCase() !== B.describe.toLowerCase() || JSON.stringify(A.body) !== JSON.stringify(B.body);
    if (!differ || A.sha256 !== B.sha256) continue;
    const excused = [A, B].filter(x => ['pending', 'excused'].includes(x.state));
    pairs.push({ roles: [A.key, B.key], files: [A.file, B.file], is: A.is, excused: excused.map(x => x.key) });
    if (excused.length) { notes.push(`check 14: the ${A.key} and the ${B.key} share one body (${A.is}) while the ${excused[0].key}'s generation is ${excused[0].state}`); continue; }
    fails.push(`the ${A.key} and the ${B.key} are described differently ("${short(A.describe, 40)}" / "${short(B.describe, 40)}") but share one body file (${A.file} = ${B.file}, ${A.is}) and differ only by tint; give the ${B.key} its own body (generated, or a library body that fits it)`);
  }

  const asked = items.filter(i => ASKED.has(i.from) || i.kind === 'objective');
  const ok = fails.length === 0;
  const detail = ok
    ? (asked.length || bodies.length > 1 ? `looks honoured: ${[...oks, ...(bodies.length > 1 ? [`${bodies.length} roles, ${new Set(bodies.map(b => b.sha256)).size} body files`] : [])].join('; ')}` : 'nothing to judge: no generated or reference looks, no objective props, one character role')
    : `${fails.length} look${fails.length > 1 ? 's' : ''} not honoured: ${fails.join(' | ')}. A stand-in passes only when the generation failed and game/${GENERATED_FILE} records why with the delivery line naming it (the Studio worker writes it)`;
  return { ok, detail, notes, record: { items: items.map(({ body, placeholder, ...i }) => i), pairs, generated: gen ? { items: (gen.items ?? []).length, delivery: gen.delivery ?? null } : null } };
}
