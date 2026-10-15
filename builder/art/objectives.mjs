// The art of what a game is played for. An objective (a pickup, a carried item, a gate, a drop, a portal, the thing to
// defend) is what the HUD and the rules send a player to get, so its model must be that thing. The creator, 2026-10-14,
// on three composed levels: "We were supposed to collect berries, but there were no berries anywhere. I think in the
// ocean I saw some boxes": the berries were the kit's stand-in crate, and every gate passed.
//
//   objectiveProps(spec, catalog)       → [{ name, describe, by: ['pickup.prop', 'goal'], fill }]: the spec's props the
//                                          game's objectives draw (each mechanic manifest's `objectives`, and goal props)
//   whatModel(bytes, name, { lib })      → { is, standin, means: true | false | null, ref }: what a slot's file is, and
//                                          whether it means the thing the slot names (null: not a library file, unread;
//                                          a kit stand-in means it only when it is that shape: the stand-in ball for a ball)
//   objectiveArt(game, { yes, … })       → the art step: every objective prop's slot holds that thing, or says why not
//
// The art step's order for one objective prop (the art order: provided, library, connection, stand-ins):
//   1. what the spec names (fill.from library or provided) stays: the creator's choice
//   2. a file in the slot that is not a stand-in and does not mean something else stays
//   3. the library by meaning: the resolver's best whose id or tags name the thing (resolve.mjs `means`), in a shape the
//      look can take (coverage styleFit shape ≥ SHAPE_OK: the runtime's style pass moves colours, not shapes); the
//      look's own packs first
//   4. a maker (generateSlot: Meshy on the person's own key, under its ledger and the wave's cap), drawn from the look's
//      style anchor when the look has one; only with `yes` (with it, a library model off the look's shapes is made again)
//   5. without one: what already means the thing stays, else the library's model that means it in any shape
//   6. the stand-in stays, and game/generated.json says why with a delivery line that names it. Gate F (measure 14,
//      builder/tools/lib/looks-check.mjs) fails while it stays, unless a generation was tried and did not land.
// Nothing here names a game, a prop or a mechanic: the manifests say which params draw objectives.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { SHAPE_OK, styleFit } from './coverage.mjs';
import { generateSlot, MAKERS } from './generate.mjs';
import { allAssets, findBySha, loadLibrary } from './library.mjs';
import { loadPolicy } from './policy.mjs';
import { loadKind, means, needFromSlot, rank } from './resolve.mjs';
import { exportAsset, localPath, sha256 } from './store.mjs';
import { targetOfLook } from '../look/looks.mjs';
import { STANDIN_ASSETS } from '../tools/lib/paths.mjs';
import { readCatalog } from '../tools/lib/spec.mjs';

const readJson = async f => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } };
const json = v => JSON.stringify(v, null, 2) + '\n';
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const short = (s, n = 120) => { const t = clean(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export const GENERATED_FILE = 'generated.json';

/**
 * The props a game's objectives draw. A mechanic's manifest (components/<id>/mechanic.json → objectives.props) names the
 * params that hold a prop's name; an empty one is the game's first gameplay prop when the manifest says so. A prop the
 * spec marks `goal` (the thing to defend) is one too. Only props the spec has count: a param naming no prop of the game
 * draws the part's own model. → [{ name, describe, by, fill }]
 */
export function objectiveProps(spec, catalog) {
  const props = spec?.world?.props ?? [];
  const byName = new Map(props.map(p => [p.name, p]));
  const firstGameplay = props.find(p => p.kind === 'gameplay') ?? null;
  const manifests = new Map((catalog?.mechanics ?? []).map(m => [m.id, m]));
  const out = new Map();
  const add = (name, by) => {
    const p = byName.get(name);
    if (!p) return;
    const o = out.get(name) ?? { name, describe: clean(p.describe), by: [], fill: p.fill ?? null };
    if (!o.by.includes(by)) o.by.push(by);
    out.set(name, o);
  };
  for (const m of spec?.mechanics ?? []) {
    const man = manifests.get(m.id);
    for (const o of man?.objectives?.props ?? []) {
      const given = m.params?.[o.param] ?? man.params?.properties?.[o.param]?.default ?? '';
      const name = given || (o.empty === 'first-gameplay-prop' ? firstGameplay?.name : null);
      if (name) add(name, `${m.id}.${o.param}`);
    }
  }
  for (const p of props) if (p.goal) add(p.name, 'goal');
  return [...out.values()];
}

let standins = null;
/** sha256 → the kit stand-in file's name (builder/tools/lib/standin-assets). */
async function standinIndex() {
  if (standins) return standins;
  standins = new Map();
  for (const n of (await readdir(STANDIN_ASSETS).catch(() => [])).filter(n => n.endsWith('.glb'))) standins.set(sha256(await readFile(path.join(STANDIN_ASSETS, n))), n);
  return standins;
}

/**
 * What a model file is, held to the name of the thing its slot draws. A kit stand-in file or a library bean is a
 * stand-in; a library asset (public, private or a game's generated pack) means the thing when its id or tags name it;
 * any other file is the game's own (its meaning is not read here). → { is, standin, means, ref }
 */
export async function whatModel(bytes, name, { lib = loadLibrary(loadConfig()) } = {}) {
  const sha = sha256(bytes);
  const kit = (await standinIndex()).get(sha);
  const hit = findBySha(lib, sha);
  // a kit stand-in is a plain shape: it is the thing only when it is that shape (the stand-in ball in a ball's slot)
  if (kit) return { is: `the kit stand-in ${kit}`, standin: true, means: means(hit?.asset ?? { id: kit.replace(/\.glb$/, '') }, name), ref: `standin:${kit.replace(/\.glb$/, '')}`, sha256: sha };
  if (hit) {
    const a = hit.asset, ref = `${a.pack}/${a.id}`;
    const bean = a.category === 'body' && (/^bean-/.test(a.id) || (a.tags ?? []).includes('bean'));
    if (bean) return { is: `the library bean ${ref}`, standin: true, means: false, ref, sha256: sha };
    return { is: `the library ${a.category} ${ref} ("${clean(a.describe).slice(0, 60)}")`, standin: false, means: means(a, name), ref, sha256: sha };
  }
  return { is: 'its own model', standin: false, means: null, ref: null, sha256: sha };
}

/** The look's style anchor (a picture tagged `anchor` in the look's own packs, the level's when it has levels) or null. */
export function anchorOf(spec, lib) {
  const packs = new Set(spec?.look?.packs ?? []);
  if (!packs.size) return null;
  const level = spec.look?.target?.level?.id ?? null;
  const pics = allAssets(lib).filter(a => packs.has(a.pack) && a.dimension === '2d' && (a.tags ?? []).includes('anchor') && !(a.validated ?? []).some(v => v.ok === false));
  return (level && pics.find(a => a.id.endsWith(level))) ?? pics.find(a => !level || !spec.look.target?.looks?.some(L => a.id.endsWith(L.id))) ?? null;
}

/** The look target an objective's art is held to: the game's level when its target has looks. */
export const lookTargetOf = spec => { const t = spec?.look?.target ?? null; return t?.looks?.length && t.level?.id ? targetOfLook(t, t.level.id) : t; };

/**
 * The library's model for an objective slot, by meaning: candidates the resolver ranks for the slot's need whose id or
 * tags name the thing, inside the device budgets; the look's own packs first. `inStyle` keeps only a shape the look
 * takes (coverage styleFit shape ≥ SHAPE_OK: surfaces and detail; the runtime's style pass moves colours, not shapes).
 * → candidate | null
 */
export function libraryPick(lib, slot, name, { spec = {}, policy, kindPreset = null, paid = null, inStyle = true, config = null } = {}) {
  const need = { ...needFromSlot(slot), head: name };
  const { candidates } = rank(lib, need, { kindPreset, runtime: 'three', devices: ['phone', 'desktop'], policy, paid });
  const own = new Set(spec.look?.packs ?? []);
  // only bytes this machine has (the store or the kit's default set): a pick is copied into the game now
  const here = c => !config || !!localPath(config, c.asset.sha256);
  const ok = candidates.filter(c => means(c.asset, name) && c.budget.ok && here(c) && (!inStyle || !offShape(c.asset, spec)));
  return ok.find(c => own.has(c.asset.pack)) ?? ok[0] ?? null;
}

/** Is a library asset off the look's shapes (its surfaces or detail, which no style pass changes)? false without a target. */
export function offShape(asset, spec) {
  const t = lookTargetOf(spec);
  return !!(t && asset && (styleFit(asset, t).shape ?? 1) < SHAPE_OK);
}

const licenceOfAsset = a => { const l = a.licence ?? a._pack?.licence ?? {}; return { spdx: l.spdx, author: l.author ?? null, url: l.url ?? l.page ?? null, ...(l.credit ? { credit: l.credit } : {}) }; };

/**
 * The art step for a game's objectives (see the top of this file). Writes the slot files, gf-three.json (props and the
 * note), assets.json (assembled again), ATTRIBUTION.md and game/generated.json (what stayed a stand-in, and why).
 *   yes        a maker may run (paid, on the person's own key); without it nothing is spent
 *   generate   generateSlot (a test passes its own)
 *   attribution  create's ATTRIBUTION.md writer (create passes it; others import it)
 * → { items: [{ name, slot, file, by, was, now: 'kept' | 'spec' | 'library' | 'generated' | 'standin', ref?, credits?, why? }],
 *     credits, notes, wrote }
 */
export async function objectiveArt(game, { yes = false, maker = 'meshy', generate = generateSlot, config = null, catalog = null, attribution = null, log = () => {}, write = true } = {}) {
  const dir = path.resolve(game);
  const spec = await readJson(path.join(dir, 'spec.json'));
  const record = await readJson(path.join(dir, 'gf-three.json'));
  const assets = await readJson(path.join(dir, 'assets.json'));
  if (!spec || !record || !assets) throw new Error(`objective art: ${game} has no spec.json, gf-three.json or assets.json`);
  const notes = [], items = [];
  if (spec.runtime !== 'three') return { items, credits: 0, notes: [`objective art: the ${spec.runtime} runtime places its own props`], wrote: [] };
  config ??= loadConfig();
  catalog ??= await readCatalog();
  const paid = yes ? { yes: true, keys: Object.keys(MAKERS) } : null;
  const lib = loadLibrary(config);
  const policy = loadPolicy(config.policyFile), kindPreset = loadKind(spec.kind ?? null, config.kindsDir);
  const gen = (await readJson(path.join(dir, GENERATED_FILE))) ?? { schema: 'gf-three-generated/1', about: 'What a build asked a maker to make, and how it went (builder/tools/lib/looks-check.mjs reads it).', items: [], delivery: null };
  const wrote = new Set();
  let credits = 0;

  for (const o of objectiveProps(spec, catalog)) {
    const slotId = record.named?.[o.name] ?? `prop.${o.name}`;
    const slot = (assets.slots ?? []).find(s => s.id === slotId);
    const it = { name: o.name, slot: slotId, by: o.by, file: slot?.source?.file ?? null };
    items.push(it);
    if (!slot || slot.type !== 'model' || !it.file) { it.now = 'kept'; it.why = slot ? `${slotId} is a ${slot.type} slot (a picture): the build fills it` : `${slotId} is not a slot of the game`; continue; }
    if (o.fill?.from === 'library' || o.fill?.from === 'provided') { it.now = 'spec'; it.why = `the spec names it (fill.from ${o.fill.from})`; continue; }
    const file = path.join(dir, it.file);
    const was = existsSync(file) ? await whatModel(await readFile(file), o.name, { lib }) : { is: 'missing', standin: true, means: false };
    it.was = was.is;
    // a library model that means the thing stays, unless a maker may run and its shape is off the look's
    const current = was.ref && !was.standin ? findBySha(lib, was.sha256)?.asset ?? null : null;
    const outOfLook = !!current && offShape(current, spec);
    if (!was.standin && was.means !== false && !(yes && outOfLook)) { it.now = 'kept'; if (outOfLook) it.why = `${was.is} is off the look's shapes; a maker could make one in its style (yes)`; continue; }

    // the library, by meaning, in the look's shapes
    const put = (pick, why) => {
      it.now = 'library'; it.ref = pick.ref; if (why) it.why = why;
      record.props = { ...record.props, [o.name]: { file: it.file, from: `library:${pick.ref}`, license: licenceOfAsset(pick.asset) } };
      wrote.add(it.file);
      log(`${o.name}: the library's ${pick.ref} (${[...pick.why, ...(why ? [why] : [])].join('; ')})`);
      return write ? exportAsset(config, pick.asset, file) : null;
    };
    const pick = libraryPick(lib, slot, o.name, { spec, policy, kindPreset, paid, config });
    if (pick && pick.ref !== was.ref) { await put(pick); continue; }
    // a maker, drawn from the look's anchor
    const words = clean(o.fill?.prompt ?? o.describe ?? o.name);
    const attempt = { n: ((gen.items.find(g => g.kind === 'prop' && g.key === o.name)?.attempts ?? []).length) + 1, started: new Date().toISOString() };
    let state = 'skipped', why = `no library model in the look's shapes means "${o.name}", and no maker was allowed to make one (run the art step with yes: gamesfun art objectives ${path.basename(dir)} --yes)`;
    if (yes && write) {
      if (generate === generateSlot) await makerEnv();
      const anchor = anchorOf(spec, lib);
      const tmp = anchor ? await mkdtemp(path.join(os.tmpdir(), 'objective-art-')) : null;
      try {
        // a thing players get (not the goal they defend) is loose: made with no base or plinth under it
        const style = anchor ? { anchor: await exportAsset(config, anchor, path.join(tmp, `${anchor.id}.png`)), target: lookTargetOf(spec), loose: !o.by.includes('goal') } : null;
        const size = Number(spec.world?.props?.find(p => p.name === o.name)?.size) || 1;
        const r = await generate({ game: dir, slot: slotId, words, maker, yes: true, size, style, config, log });
        credits += Number(r.credits) || 0;
        if (r.ok) {
          it.now = 'generated'; it.ref = r.ref; it.credits = r.credits ?? null; it.anchor = anchor ? `${anchor.pack}/${anchor.id}` : null;
          record.props = { ...record.props, [o.name]: { file: it.file, from: `generated:${r.ref}`, license: { spdx: r.licence?.spdx, author: r.licence?.author ?? null, url: r.licence?.url ?? null } } };
          wrote.add(it.file);
          upsert(gen, { kind: 'prop', key: o.name, slot: slotId, file: it.file, from: 'objective', asked: words, state: 'placed', sha256: sha256(await readFile(file)), license: r.licence ?? null, attempts: [...attemptsOf(gen, o.name), { ...attempt, finished: new Date().toISOString(), state: 'placed' }] });
          log(`${o.name}: made by ${maker}${anchor ? ` from the anchor ${anchor.id}` : ''} (${r.ref}, ${r.credits ?? '?'} credits)`);
          continue;
        }
        state = 'failed'; why = clean((r.problems ?? []).join('; ') || r.next || 'the maker made nothing');
      } catch (e) {
        state = /Meshy cap|MESHY_API_KEY|no ledger/i.test(e.message) ? 'refused' : 'failed'; why = clean(e.message).slice(0, 300);
      } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
    }
    // nothing made: what already means the thing stays (a stand-in of its shape, or a library model off the look's),
    // else the library's model that means it in any shape (the style pass moves its colours), else the stand-in
    if (was.means) { it.now = 'kept'; it.why = `${was.is} stays (${state === 'skipped' ? 'nothing in the look\'s shapes, and no maker allowed' : `the maker: ${why}`})`; continue; }
    const any = libraryPick(lib, slot, o.name, { spec, policy, kindPreset, paid, config, inStyle: false });
    if (any) { await put(any, `off the look's shapes; ${state === 'skipped' ? 'no maker allowed' : `the maker: ${short(why)}`}`); continue; }
    it.now = 'standin'; it.why = why;
    upsert(gen, { kind: 'prop', key: o.name, slot: slotId, file: it.file, from: 'objective', asked: words, state, why, attempts: [...attemptsOf(gen, o.name), { ...attempt, finished: new Date().toISOString(), state, why }] });
  }

  // the build record's note for each objective, in place of create's line about it
  const said = items.filter(i => ['library', 'generated', 'standin'].includes(i.now));
  if (said.length) {
    record.notes = (record.notes ?? []).filter(n => !said.some(i => n.startsWith(`prop "${i.name}":`)));
    for (const i of said) record.notes.push(i.now === 'library' ? `prop "${i.name}": an objective (${i.by.join(', ')}); the library's ${i.ref} means it (the art step)`
      : i.now === 'generated' ? `prop "${i.name}": an objective (${i.by.join(', ')}); made for it (${i.ref}${i.anchor ? `, from the look's anchor ${i.anchor}` : ''})`
      : `prop "${i.name}": an objective (${i.by.join(', ')}) still drawn by a stand-in: ${i.why}`);
  }
  const left = items.filter(i => i.now === 'standin');
  // the delivery line: the worker's own (made looks that did not land) and this step's, which names each objective left
  const OURS = 'Objectives still drawn by stand-ins';
  const theirs = clean(String(gen.delivery ?? '').split(OURS)[0]);
  gen.delivery = [theirs, left.length ? `${OURS}: ${left.map(i => `"${i.name}" (${i.file}): ${i.why}`).join('; ')}.` : ''].filter(Boolean).join(' ') || null;
  if (write && (said.length || left.length)) {
    await writeFile(path.join(dir, 'gf-three.json'), json(record));
    const { assembleManifest } = await import('../tools/lib/slots-lib.mjs');
    const A = await assembleManifest(dir, { sounds: assets.sounds ?? null });
    await writeFile(path.join(dir, 'assets.json'), json(A.manifest));
    // create passes its own (importing create.mjs from inside its run would wait on itself)
    attribution ??= (await import('../tools/create.mjs')).attribution;
    await writeFile(path.join(dir, 'ATTRIBUTION.md'), attribution(spec, record));
    if (gen.items.length) await writeFile(path.join(dir, GENERATED_FILE), json(gen));
    notes.push(...A.warnings ?? []);
  }
  return { items, credits, notes, wrote: [...wrote] };
}

const attemptsOf = (gen, key) => gen.items.find(g => g.kind === 'prop' && g.key === key)?.attempts ?? [];
function upsert(gen, item) {
  const i = gen.items.findIndex(g => g.kind === item.kind && g.key === item.key);
  if (i >= 0) gen.items[i] = { ...gen.items[i], ...item }; else gen.items.push(item);
}

/**
 * A maker's settings as `gamesfun meshy` keeps them, put in the environment before the maker's client loads (it reads
 * them once): the key from the environment or the checkout's .env, every paid task counted in .gamesfun/meshy-ledger.jsonl,
 * the wave's cap (GF_MESHY_CAP, 150 credits unless set). Values already set win. → is a key there
 */
export async function makerEnv(env = process.env) {
  const [{ loadDotEnv }, { STATE }] = await Promise.all([import('../commands/meshy.mjs'), import('../lib/paths.mjs')]);
  const file = loadDotEnv();
  env.MESHY_API_KEY ||= file.MESHY_API_KEY ?? '';
  env.GF_MESHY_LEDGER ||= path.join(STATE, 'meshy-ledger.jsonl');
  env.GF_MESHY_WAVE ||= 'gamesfun-kit';
  return !!env.MESHY_API_KEY;
}

/** True when an objective's record in game/generated.json is a try that did not land (a failure, a refusal, a timeout). */
export const triedAndFailed = g => !!g && ['failed', 'refused', 'timeout'].includes(g.state) && !!clean(g.why);
