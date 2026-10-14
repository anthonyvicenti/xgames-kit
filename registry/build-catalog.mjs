#!/usr/bin/env node
// The registry: manifests in, one catalog out, and every question about what the kit has answered from that data.
//
//   node registry/build-catalog.mjs                       write registry/catalog.json from the manifests
//   node registry/build-catalog.mjs --check               build it and fail on any manifest problem (writes nothing)
//   node registry/build-catalog.mjs --matrix              print the runtime x kind matrix
//   node registry/build-catalog.mjs --can calm forge      can this kind run on this runtime (or runtime/profile)?
//   node registry/build-catalog.mjs --which devices=phone camera=first [graphics=photoreal] [dimension=3d] [needs=a,b]
//   node registry/build-catalog.mjs --spec game/spec.json check a spec v2 against the registry
//   (--root <dir> reads another tree; --out <file> writes elsewhere; --json prints answers as JSON)
//
// The manifests (each validated against its schema in registry/schema/):
//   runtimes/<id>/runtime.json   loops/<id>/loop.json   components/<id>/mechanic.json   kinds/<id>.json
//   registry/capabilities.json   (what a profile can do and a mechanic gives)
// Nothing here names a runtime, a loop or a kind: every answer reads the manifests. The registry assists and never
// refuses an idea: what a runtime lacks is a build item (a finding), and only hard limits rule a runtime out.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { loadSchemas, SCHEMA, ROOT } from './schemas.mjs';

export const GATES = ['A', 'B', 'C', 'D', 'E', 'F'];
const SOURCES = [
  { dir: 'runtimes', file: 'runtime.json', type: 'runtime' },
  { dir: 'loops', file: 'loop.json', type: 'loop' },
  { dir: 'components', file: 'mechanic.json', type: 'mechanic' },
];
const MEETS = new Set(['tested', 'emulated', 'untested']);   // a device a runtime does not call unsupported

// ── reading ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every manifest under root, with its path. → {runtime: [{path, data}], loop, mechanic, kind, capabilities} */
export async function readManifests(root = ROOT) {
  const out = { runtime: [], loop: [], mechanic: [], kind: [], capabilities: null };
  const json = async p => ({ path: relative(root, p), data: JSON.parse(await readFile(p, 'utf8')) });
  for (const s of SOURCES) {
    if (!existsSync(join(root, s.dir))) continue;
    for (const e of (await readdir(join(root, s.dir), { withFileTypes: true })).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(root, s.dir, e.name, s.file);
      if (existsSync(p)) out[s.type].push(await json(p));
    }
  }
  if (existsSync(join(root, 'kinds'))) for (const f of (await readdir(join(root, 'kinds'))).filter(f => f.endsWith('.json')).sort()) out.kind.push(await json(join(root, 'kinds', f)));
  const caps = join(root, 'registry/capabilities.json');
  if (existsSync(caps)) out.capabilities = await json(caps);
  return out;
}

// ── building ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const openOn = impl => Object.entries(impl ?? {}).filter(([, v]) => v.state?.open).map(([rt]) => rt);
/** A profile's limits: the runtime's, with the profile's own fields over them. */
export const profileLimits = (rt, p) => ({ ...(rt.limits ?? {}), ...(p?.limits ?? {}), devices: { ...(rt.limits?.devices ?? {}), ...(p?.limits?.devices ?? {}) } });
/** The rows of the matrix and of compat answers: one per profile, or the runtime itself when it has none. */
export const rowsOf = rt => (rt.profiles?.length ? rt.profiles.map(p => ({ runtime: rt.id, profile: p.id, p })) : [{ runtime: rt.id, profile: null, p: null }]);
const rowKey = r => (r.profile ? `${r.runtime}/${r.profile}` : r.runtime);
const rowOpen = (rt, r) => !!rt.state?.open && (!r.p || !!r.p.state?.open);

/** Where a kind is proven: '<runtime>' or '<runtime>/<profile>' for each runtime entry whose state is tested. */
export function provenOf(kind) {
  return Object.entries(kind.runtimes ?? {}).filter(([, v]) => v.state?.tested).map(([rt, v]) => (v.profile ? `${rt}/${v.profile}` : rt));
}

/** Pairs of mechanics that claim one resource without sharing it (default params; claims with `when` depend on params). */
export function conflictsOf(mechanics) {
  const out = [];
  const claims = mechanics.map(m => ({ id: m.id, owns: (m.owns ?? []).filter(o => !o.when) }));
  for (let i = 0; i < claims.length; i++) for (let j = i + 1; j < claims.length; j++) {
    for (const a of claims[i].owns) for (const b of claims[j].owns) {
      if (a.res === b.res && !(a.shared && b.shared)) out.push({ a: claims[i].id, b: claims[j].id, res: a.res });
    }
  }
  return out;
}

/** The runtime x kind view: a row per runtime profile, a column per kind. */
export function matrixOf(runtimes, kinds) {
  const rows = runtimes.flatMap(rt => rowsOf(rt).map(r => ({ key: rowKey(r), runtime: r.runtime, ...(r.profile ? { profile: r.profile } : {}), open: rowOpen(rt, r) })));
  const cells = {};
  for (const row of rows) {
    cells[row.key] = {};
    for (const k of kinds) {
      const look = k.look?.[row.runtime], proof = k.runtimes?.[row.runtime];
      const fits = x => x && (!x.profile || !row.profile || x.profile === row.profile);
      const cell = fits(proof) && proof.state?.tested ? 'proven' : fits(look) ? 'look' : 'empty';
      cells[row.key][k.id] = { cell, ...(fits(look) ? { preset: look.preset } : {}), ...(cell === 'proven' && proof.state.evidence?.[0] ? { example: proof.state.evidence[0].what } : {}) };
    }
  }
  return { rows, cols: kinds.map(k => k.id), cells };
}

/** What the manifests get wrong with each other (schema problems come first, from validation). */
export function crossProblems({ runtimes, loops, mechanics, kinds, capabilities }) {
  const out = [];
  const rt = new Map(runtimes.map(r => [r.id, r])), loopIds = new Set(loops.map(l => l.id)), mechIds = new Set(mechanics.map(m => m.id));
  const capIds = capabilities ? new Set(capabilities.map(c => c.id)) : null, kindIds = new Set(kinds.map(k => k.id));
  const profileOk = (r, p) => !p || (rt.get(r)?.profiles ?? []).some(x => x.id === p);
  const caps = (where, list) => { if (capIds) for (const c of list ?? []) if (!capIds.has(c)) out.push(`${where}: capability "${c}" is not in registry/capabilities.json`); };
  for (const r of runtimes) {
    if (!kindIds.has(r.defaultKind)) out.push(`runtimes/${r.id}: defaultKind "${r.defaultKind}" is not a kind`);
    caps(`runtimes/${r.id}`, r.limits?.capabilities);
    for (const p of r.profiles ?? []) caps(`runtimes/${r.id}/${p.id}`, p.limits?.capabilities);
    for (const x of [...(r.worlds ?? []), ...(r.looks ?? [])]) for (const p of x.profiles ?? []) if (!profileOk(r.id, p)) out.push(`runtimes/${r.id}: ${x.id} names profile "${p}" the runtime has not got`);
    for (const x of r.worlds ?? []) for (const l of x.loops ?? []) if (!loopIds.has(l)) out.push(`runtimes/${r.id}: world ${x.id} names loop "${l}" that is not a loop`);
    if (r.state?.open && GATES.some(g => !(r.measures?.build?.[g]?.length))) out.push(`runtimes/${r.id}: open, but supplies no build measure for gate ${GATES.filter(g => !(r.measures?.build?.[g]?.length)).join(', ')}`);
  }
  for (const l of loops) {
    for (const [r, v] of Object.entries(l.impl ?? {})) {
      if (!rt.has(r)) out.push(`loops/${l.id}: impl on "${r}", which is not a runtime`);
      for (const p of v.profiles ?? []) if (!profileOk(r, p)) out.push(`loops/${l.id}: impl on ${r} names profile "${p}" the runtime has not got`);
    }
    for (const n of l.near ?? []) if (!loopIds.has(n)) out.push(`loops/${l.id}: near "${n}" is not a loop`);
    for (const m of l.needs?.mechanics ?? []) if (!mechIds.has(m)) out.push(`loops/${l.id}: needs mechanic "${m}" that is not a mechanic`);
  }
  const acts = new Map();
  for (const l of loops) { if (acts.has(l.acts)) out.push(`loops/${l.id}: acts "${l.acts}" is also ${acts.get(l.acts)}'s (one loop per word)`); acts.set(l.acts, l.id); }
  for (const m of mechanics) {
    for (const [r, v] of Object.entries(m.impl ?? {})) {
      if (!rt.has(r)) out.push(`components/${m.id}: impl on "${r}", which is not a runtime`);
      for (const p of v.profiles ?? []) if (!profileOk(r, p)) out.push(`components/${m.id}: impl on ${r} names profile "${p}" the runtime has not got`);
    }
    for (const n of [...(m.needs?.mechanics ?? []).map(x => x.id), ...(m.uses ?? [])]) if (!mechIds.has(n)) out.push(`components/${m.id}: names mechanic "${n}" that is not a mechanic`);
    caps(`components/${m.id}`, m.capabilities); caps(`components/${m.id} gives`, m.gives);
  }
  for (const k of kinds) {
    for (const r of new Set([...Object.keys(k.look ?? {}), ...Object.keys(k.runtimes ?? {})])) if (!rt.has(r)) out.push(`kinds/${k.id}: "${r}" is not a runtime (a profile goes inside: {"profile": "flat-2d"})`);
    for (const [r, v] of Object.entries(k.look ?? {})) {
      if (!rt.has(r)) continue;
      if (!profileOk(r, v.profile)) out.push(`kinds/${k.id}: look on ${r} names profile "${v.profile}" the runtime has not got`);
      const looks = rt.get(r).looks ?? [];
      for (const pr of [v.preset, ...(v.alternates ?? []).map(a => a.preset)]) if (looks.length && !looks.some(x => x.id === pr)) out.push(`kinds/${k.id}: look "${pr}" is not one of ${r}'s looks`);
    }
    for (const [r, v] of Object.entries(k.runtimes ?? {})) if (rt.has(r) && !profileOk(r, v.profile)) out.push(`kinds/${k.id}: runtimes.${r} names profile "${v.profile}" the runtime has not got`);
    for (const m of k.mechanics?.suggested ?? []) if (!mechIds.has(m)) out.push(`kinds/${k.id}: suggests mechanic "${m}" that is not a mechanic`);
  }
  return out;
}

/** Build the catalog from the manifests under root. → catalog (registry/schema/catalog.schema.json) */
export async function buildCatalog(root = ROOT) {
  const { validate } = await loadSchemas();
  const read = await readManifests(root);
  const problems = [];
  const files = [];
  const take = (list, schema) => list.filter(({ path, data }) => {
    files.push(path);
    const p = validate(schema, data);
    for (const x of p) problems.push(`${path}${x.startsWith('/') ? ' ' : ': '}${x}`);
    return !p.length;
  }).map(x => x.data);
  const runtimes = take(read.runtime, SCHEMA.runtime).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const loops = take(read.loop, SCHEMA.loop);
  const mechanics = take(read.mechanic, SCHEMA.mechanic).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.id.localeCompare(b.id));
  const kinds = take(read.kind, SCHEMA.kind);
  const capabilities = read.capabilities?.data?.capabilities ?? null;
  if (read.capabilities) files.push(read.capabilities.path);
  problems.push(...crossProblems({ runtimes, loops, mechanics, kinds, capabilities }));
  const hash = createHash('sha256');
  for (const f of files.sort()) hash.update(f + '\n' + (await readFile(join(root, f))));
  return {
    catalogVersion: 1,
    inputs: { sha256: hash.digest('hex'), files },
    runtimes,
    loops: loops.map(l => ({ ...l, openOn: openOn(l.impl) })),
    mechanics: mechanics.map(m => ({ ...m, openOn: openOn(m.impl) })),
    kinds: kinds.map(k => ({ ...k, proven: provenOf(k) })),
    capabilities: capabilities ?? [],
    conflicts: conflictsOf(mechanics),
    matrix: matrixOf(runtimes, kinds),
    problems,
  };
}

// ── answers (data only) ──────────────────────────────────────────────────────────────────────────────────────────────

const byId = (list, id) => list.find(x => x.id === id) ?? null;
const words = s => [s].flat().filter(x => x != null).join(', ') || 'none';

/**
 * Can this kind run on this runtime (and profile)? → {answer, why: [...]} where answer is
 *   proven   a verified example on it
 *   look     the kind has a look there, no game proves it yet (allowed, said as a finding)
 *   unproven no look there: allowed; the game builds the look (a build item with this kind) and proves it
 *   closed   the runtime (or profile) is not open to pitches
 *   unknown  no such kind, runtime or profile
 */
export function can(catalog, { kind, runtime, profile = null }) {
  const k = byId(catalog.kinds, kind), rt = byId(catalog.runtimes, runtime);
  if (!k) return { answer: 'unknown', why: [`no kind "${kind}" (kinds: ${catalog.kinds.map(x => x.id).join(', ')})`] };
  if (!rt) return { answer: 'unknown', why: [`no runtime "${runtime}" (runtimes: ${catalog.runtimes.map(x => x.id).join(', ')})`] };
  const p = profile ? byId(rt.profiles ?? [], profile) : null;
  if (profile && !p) return { answer: 'unknown', why: [`${runtime} has no profile "${profile}" (${(rt.profiles ?? []).map(x => x.id).join(', ') || 'no profiles'})`] };
  const where = profile ? `${runtime}/${profile}` : runtime;
  if (!rt.state?.open || (p && !p.state?.open)) return { answer: 'closed', why: [`${where} is not open to pitches${rt.state?.note ? ` (${rt.state.note})` : ''}`] };
  const rows = profile ? [{ key: where }] : rowsOf(rt).map(r => ({ key: rowKey(r) }));
  const cells = rows.map(r => ({ key: r.key, ...catalog.matrix.cells[r.key]?.[kind] }));
  const best = ['proven', 'look'].find(c => cells.some(x => x.cell === c));
  if (best === 'proven') { const c = cells.find(x => x.cell === 'proven'); return { answer: 'proven', why: [`${kind} is proven on ${c.key}${c.example ? `: ${c.example}` : ''}`], on: cells.filter(x => x.cell === 'proven').map(x => x.key) }; }
  if (best === 'look') { const c = cells.find(x => x.cell === 'look'); return { answer: 'look', why: [`${kind} has a look on ${c.key} (${c.preset}); no game proves it yet: the first one does, and the look judge's contact sheet is its check`], on: cells.filter(x => x.cell === 'look').map(x => x.key) }; }
  const proven = k.proven.length ? `; it is proven on ${k.proven.join(', ')}` : '';
  return { answer: 'unproven', why: [`${kind} has no look on ${where}${proven}. Allowed: the game builds the look (a build item with kind "${kind}") and proves it; a kind never changes play`] };
}

/** How one runtime profile stands against a set of hard limits. → {runtime, profile, misses: [{limit, need, has}], lacks: [capability], findings} */
export function judgeRow(rt, r, limits = {}) {
  const L = profileLimits(rt, r.p), misses = [], findings = [];
  const status = d => L.devices?.[d]?.status ?? 'untested';
  const devices = [limits.devices ?? []].flat();
  const badDev = devices.filter(d => !MEETS.has(status(d)));
  if (badDev.length) misses.push({ limit: 'devices', need: devices, has: Object.keys(L.devices ?? {}).filter(d => MEETS.has(status(d))) });
  for (const d of devices.filter(d => MEETS.has(status(d)) && status(d) !== 'tested')) findings.push(`${d}: ${status(d)}${L.devices?.[d]?.note ? ` (${L.devices[d].note})` : ''}`);
  if (limits.camera && !(L.cameraRigs ?? []).includes(limits.camera)) misses.push({ limit: 'camera', need: limits.camera, has: L.cameraRigs ?? [] });
  if (limits.dimension && L.dimension && L.dimension !== limits.dimension) misses.push({ limit: 'dimension', need: limits.dimension, has: L.dimension });
  if (limits.graphics && !(L.graphics?.fidelity ?? []).includes(limits.graphics)) misses.push({ limit: 'graphics', need: limits.graphics, has: L.graphics?.fidelity ?? [] });
  if (limits.api && !(L.graphics?.apis ?? []).includes(limits.api)) misses.push({ limit: 'api', need: limits.api, has: L.graphics?.apis ?? [] });
  if (limits.players && L.players && limits.players > L.players.max) misses.push({ limit: 'players', need: limits.players, has: L.players.max });
  const have = new Set(L.capabilities ?? []);
  const lacks = [limits.needs ?? []].flat().filter(c => !have.has(c));
  return { runtime: r.runtime, profile: r.profile, misses, lacks, findings };
}

/**
 * Which open runtimes (and profiles) meet these hard limits? limits = {devices, camera, dimension, graphics, api, players,
 * needs}. → {meets: [{runtime, profile, lacks, findings}], ruledOut: [{runtime, profile, misses}]}. A capability a
 * profile lacks never rules it out (the game builds it); a device it calls unsupported, a camera rig, a dimension, a
 * graphics fidelity or API or a player count it has not got do.
 */
export function which(catalog, limits = {}, { includeClosed = false } = {}) {
  const meets = [], ruledOut = [];
  for (const rt of catalog.runtimes) for (const r of rowsOf(rt)) {
    if (!includeClosed && !rowOpen(rt, r)) continue;
    const j = judgeRow(rt, r, limits);
    (j.misses.length ? ruledOut : meets).push(j.misses.length ? { runtime: j.runtime, profile: j.profile, misses: j.misses } : { runtime: j.runtime, profile: j.profile, lacks: j.lacks, findings: j.findings });
  }
  const rank = x => byId(catalog.runtimes, x.runtime)?.rank ?? 99;
  meets.sort((a, b) => a.lacks.length - b.lacks.length || rank(a) - rank(b));
  return { meets, ruledOut };
}

/**
 * A spec v2 held to the registry. → {problems, findings}. Problems are what create cannot boot (an unknown id, a hard
 * limit the runtime breaks, a mechanic listed on a runtime it does not run on, params its schema refuses); findings
 * are said plainly and never stop a build (an unproven kind, an untested device, a loop or world the game builds).
 */
export function checkSpec(catalog, spec) {
  const problems = [], findings = [], build = Array.isArray(spec?.build) ? spec.build : [];
  const rt = byId(catalog.runtimes, spec?.runtime);
  if (!rt) return { problems: [`runtime: "${spec?.runtime}" is not a runtime (${catalog.runtimes.map(x => x.id).join(', ')})`], findings };
  if (!rt.state?.open) problems.push(`runtime: ${rt.id} is not open to pitches${rt.state?.note ? ` (${rt.state.note})` : ''}`);
  let p = null;
  if (rt.profiles?.length) {
    p = byId(rt.profiles, spec.profile);
    if (!p) problems.push(`profile: ${rt.id} needs one of ${rt.profiles.map(x => x.id).join(', ')}`);
    else if (!p.state?.open) problems.push(`profile: ${rt.id}/${p.id} is not open to pitches`);
  } else if (spec.profile) problems.push(`profile: ${rt.id} has no profiles (leave profile out)`);
  const where = p ? `${rt.id}/${p.id}` : rt.id;
  const L = profileLimits(rt, p);
  const inProfile = x => !x.profiles || !p || x.profiles.includes(p.id);
  // the loop: open here, or built on its closest
  const loop = byId(catalog.loops, spec.loop);
  if (!loop) problems.push(`loop: "${spec.loop}" is not a loop (${catalog.loops.map(x => x.id).join(', ')})`);
  else {
    const impl = loop.impl?.[rt.id];
    const here = impl?.state?.open && (!impl.profiles || !p || impl.profiles.includes(p.id));
    if (!here && !build.some(b => b.closest)) problems.push(`loop: ${loop.id} is not open on ${where}: build it on its closest open loop (a build item with closest${loop.near?.length ? `, e.g. ${loop.near[0]}` : ''})`);
    else if (!here) findings.push(`${loop.id} is built in this game on ${build.find(b => b.closest).closest}`);
    const secs = spec.round?.seconds;
    if (loop.clock === 'required' && secs == null) problems.push(`round.seconds: the ${loop.id} loop needs a clock`);
    if (loop.clock === 'none' && secs != null) problems.push(`round.seconds: the ${loop.id} loop has no clock`);
    if (spec.round?.params) for (const x of paramsProblems(loop.params, spec.round.params)) problems.push(`round.params${x}`);
    for (const m of loop.needs?.mechanics ?? []) if (here && !(spec.mechanics ?? []).some(x => x.id === m)) problems.push(`mechanics: the ${loop.id} loop needs the ${m} mechanic${loop.needs.why ? ` (${loop.needs.why})` : ''}`);
  }
  // the kind: proven, a look, or proven by this game
  const k = byId(catalog.kinds, spec.kind);
  if (!k) problems.push(`kind: "${spec.kind}" is not a kind (${catalog.kinds.map(x => x.id).join(', ')})`);
  else {
    const c = can(catalog, { kind: k.id, runtime: rt.id, profile: p?.id ?? null });
    if (c.answer === 'look') findings.push(c.why[0]);
    if (c.answer === 'unproven' && !build.some(b => b.kind === k.id)) problems.push(`build: ${c.why[0]}`);
    else if (c.answer === 'unproven') findings.push(`${k.id} is proven on ${where} by this game`);
  }
  // hard limits
  if (spec.camera && !(L.cameraRigs ?? []).includes(spec.camera)) problems.push(`camera: ${where} has no "${spec.camera}" rig (${words(L.cameraRigs)}): a hard limit (another runtime, or another camera)`);
  for (const d of spec.devices?.targets ?? []) {
    const s = L.devices?.[d]?.status ?? 'untested';
    if (!MEETS.has(s)) problems.push(`devices: ${where} does not run on ${d}${L.devices?.[d]?.note ? ` (${L.devices[d].note})` : ''}`);
    else if (s !== 'tested') findings.push(`${d} on ${where}: ${s}`);
  }
  if (spec.players?.max != null && L.players && spec.players.max > L.players.max) problems.push(`players.max: ${where} takes at most ${L.players.max}`);
  if (spec.players && spec.players.min > spec.players.max) problems.push('players: min is more than max');
  if (spec.multiplayer?.watch !== false && L.watch === false) findings.push(`no Go live on ${where}: friends can play, viewers cannot watch`);
  if (spec.multiplayer?.voice !== false && L.voice === false) findings.push(`no voice chat on ${where}`);
  // the world and the look
  if (spec.world?.template && (rt.worlds ?? []).length && !(rt.worlds ?? []).some(w => w.id === spec.world.template && inProfile(w))) {
    if (!build.some(b => b.closest)) problems.push(`world.template: "${spec.world.template}" is not a world of ${where} (${(rt.worlds ?? []).filter(inProfile).map(w => w.id).join(', ')}): use one, or build it on the closest (a build item with closest)`);
  }
  // the world the game is made on: its template when the runtime has it, else the world its build item builds it on
  const madeOn = (rt.worlds ?? []).some(x => x.id === spec.world?.template && inProfile(x)) ? spec.world.template
    : build.map(b => b.closest).find(c => (rt.worlds ?? []).some(x => x.id === c)) ?? spec.world?.template;
  const loopWorlds = byId(catalog.loops, spec.loop)?.needs?.worlds ?? [];
  if (loopWorlds.length && madeOn && !loopWorlds.includes(madeOn)) problems.push(`world.template: the ${spec.loop} loop plays on ${loopWorlds.map(x => `the ${x} world`).join(' or ')} today (another world is built on it: a build item with closest ${loopWorlds.map(x => `"${x}"`).join(' or ')})`);
  const w = (rt.worlds ?? []).find(x => x.id === madeOn);
  if (w?.loops && spec.loop && !w.loops.includes(spec.loop)) problems.push(`world.template: ${w.id} is played only with loop ${w.loops.join(' or ')}`);
  if (spec.look?.preset && (rt.looks ?? []).length && !(rt.looks ?? []).some(x => x.id === spec.look.preset && inProfile(x))) problems.push(`look.preset: "${spec.look.preset}" is not a look of ${where}`);
  // mechanics: each on this runtime and profile, params by its schema, no unshared claim twice
  const chosen = [];
  for (const [i, m] of (spec.mechanics ?? []).entries()) {
    const man = byId(catalog.mechanics, m.id);
    if (!man) { problems.push(`mechanics[${i}]: "${m.id}" is not a mechanic`); continue; }
    const impl = man.impl?.[rt.id];
    if (!impl?.state?.open || (impl.profiles && p && !impl.profiles.includes(p.id))) { problems.push(`mechanics[${i}]: ${m.id} does not run on ${where}: take it out and add a build item that writes it for this game`); continue; }
    if (m.params) for (const x of paramsProblems(man.params, m.params)) problems.push(`mechanics[${i}].params${x}`);
    for (const n of man.needs?.mechanics ?? []) if (!n.when && !(spec.mechanics ?? []).some(x => x.id === n.id)) problems.push(`mechanics[${i}]: ${m.id} needs ${n.id}${n.why ? ` (${n.why})` : ''}`);
    for (const n of man.needs?.worlds ?? []) if (madeOn !== n.id) problems.push(`mechanics[${i}]: ${m.id} needs the ${n.id} world${n.why ? ` (${n.why})` : ''}`);
    for (const c of man.capabilities ?? []) if (!(L.capabilities ?? []).includes(c)) problems.push(`mechanics[${i}]: ${m.id} needs ${c}, which ${where} has not got`);
    chosen.push(man);
  }
  for (const c of conflictsOf(chosen)) problems.push(`mechanics: ${c.a} and ${c.b} both claim ${c.res}; change one's params (its action) so they do not`);
  // the build seam
  build.forEach((b, i) => { if (b.kind && !byId(catalog.kinds, b.kind)) problems.push(`build[${i}].kind: "${b.kind}" is not a kind`); if (b.closest && !byId(catalog.loops, b.closest) && !(rt.worlds ?? []).some(x => x.id === b.closest)) problems.push(`build[${i}].closest: "${b.closest}" is not a loop or world of ${where}`); });
  const ids = new Set(build.map((_, i) => `build.${i + 1}`));
  for (const [f, list] of [['src', spec.src], ['overrides', spec.overrides], ['slots', spec.slots]]) for (const [i, x] of (list ?? []).entries()) for (const id of x.for ?? []) if (!ids.has(id)) problems.push(`${f}[${i}].for: "${id}" is not a build item (build has ${build.length})`);
  const never = rt.core?.neverOverride ?? [];
  for (const [i, o] of (spec.overrides ?? []).entries()) if (never.some(n => (n.startsWith('*') ? o.file.endsWith(n.slice(1)) : n.endsWith('/') ? o.file.startsWith(n) : o.file === n))) problems.push(`overrides[${i}]: ${o.file} is never overridable on ${rt.id}`);
  return { problems, findings };
}

let paramsAjv = null;
/** Params against a part's params schema (a JSON Schema written for create: lenient about formats). → ['/x: …'] */
function paramsProblems(schema, params) {
  paramsAjv ??= new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  let v;
  try { v = paramsAjv.compile(schema ?? {}); } catch (e) { return [`: its params schema does not compile (${e.message})`]; }
  return v(params) ? [] : v.errors.map(e => `${e.instancePath}: ${e.message}`);
}

// ── compat: one answer shape for every caller ───────────────────────────────────────────────────────────────────────

/** The hard limits a ledger sets (its devices, perspective and graphics rows, and every row's needs). */
export function limitsOfLedger(ledger) {
  const live = (ledger?.rows ?? []).filter(r => !r.cut);
  const dev = live.find(r => r.about === 'devices'), persp = live.find(r => r.about === 'perspective'), gfx = live.find(r => r.graphics);
  return { devices: dev?.devices ?? [], camera: persp?.camera ?? null, dimension: persp?.dimension ?? null, graphics: gfx?.graphics ?? null, needs: [...new Set(live.flatMap(r => r.needs ?? []))] };
}
/** The hard limits a spec sets. */
export const limitsOfSpec = spec => ({ devices: spec?.devices?.targets ?? [], camera: spec?.camera ?? null, players: spec?.players?.max ?? null });

/**
 * Compatibility, for the loop's foundation and for Studio alike. input: a hard-limits object {devices, camera, dimension,
 * graphics, api, players, needs}, a requirements ledger (gf-ledger/1), or a spec v2. →
 *   {ok, problems: [...], findings: [...], limits, runtimes: {'<runtime>' | '<runtime>/<profile>': {runtime, profile,
 *    open, fits, misses: [{limit, need, has}], lacks: [capability], findings: [...]}}}
 * Every runtime row is answered, open or not (open says which a pitch may use). fits: no hard limit missed. lacks: the
 * capabilities the game would build there. For a spec, problems and findings are checkSpec's and ok means none; for
 * limits or a ledger, ok means some open row fits, and the ledger's registry references are checked.
 */
export function compat(catalog, input = {}) {
  const kind = input?.specVersion != null ? 'spec' : input?.schema === 'gf-ledger/1' || Array.isArray(input?.rows) ? 'ledger' : 'limits';
  const limits = kind === 'spec' ? limitsOfSpec(input) : kind === 'ledger' ? limitsOfLedger(input) : input;
  const runtimes = {};
  for (const rt of catalog.runtimes) for (const r of rowsOf(rt)) {
    const j = judgeRow(rt, r, limits);
    runtimes[rowKey(r)] = { runtime: r.runtime, profile: r.profile, open: rowOpen(rt, r), fits: !j.misses.length, misses: j.misses, lacks: j.lacks, findings: j.findings };
  }
  let problems = [], findings = [];
  if (kind === 'spec') ({ problems, findings } = checkSpec(catalog, input));
  else {
    if (kind === 'ledger') for (const [i, row] of (input.rows ?? []).entries()) {
      const m = /^(mechanic|loop|runtime|kind|capability|pack):(.+)$/.exec(row.by ?? '');
      if (!m || m[1] === 'pack') continue;
      const list = m[1] === 'capability' ? catalog.capabilities : catalog[`${m[1]}s`];
      if (!list.some(x => x.id === m[2])) problems.push(`rows[${i}].by: the registry has no ${m[1]} "${m[2]}"`);
    }
    const open = Object.entries(runtimes).filter(([, v]) => v.open);
    if (!open.some(([, v]) => v.fits)) problems.push(`no open runtime meets every hard limit: ${open.map(([k, v]) => `${k} misses ${v.misses.map(x => x.limit).join(', ')}`).join('; ')}`);
    for (const [k, v] of open.filter(([, v]) => v.fits)) for (const c of v.lacks) findings.push(`${k} has no ${c}: a game there builds it`);
  }
  return { ok: !problems.length, problems, findings, limits, runtimes };
}

// ── the registry the loop library calls (staging/loop/builder/loop/registry.mjs lists the calls) ────────────────────

/** Vocabulary the ledger may use, from the manifests and the spec schema. */
export function vocabularyOf(catalog) {
  const all = catalog.runtimes.flatMap(rt => rowsOf(rt).map(r => profileLimits(rt, r.p)));
  const uniq = xs => [...new Set(xs)].sort();
  return {
    devices: ['desktop', 'laptop', 'tablet', 'phone', 'x-post'],
    graphics: uniq(all.flatMap(l => l.graphics?.fidelity ?? [])),
    cameras: uniq(all.flatMap(l => l.cameraRigs ?? [])),
    dimensions: uniq(all.map(l => l.dimension).filter(Boolean)),
    together: ['versus', 'coop', 'teams', 'turns', 'own-board', 'solo'],
    bodies: ['character', 'board', 'vehicle', 'cursor', 'cards', 'boat', 'other'],
    defaultDevices: ['desktop', 'phone'],
  };
}

/** The registry object the loop library takes: every call answered from the catalog. */
export function createRegistry(catalog) {
  const gatesOf = rt => Object.fromEntries(GATES.map(g => [g, { measures: rt.measures?.build?.[g] ?? [], skips: (rt.measures?.skipped ?? []).filter(s => gateOfMeasure(rt, s.measure) === g).map(s => `${s.measure} ${s.why}`) }]));
  return {
    runtimes: async () => catalog.runtimes.map(rt => ({
      id: rt.id, rank: rt.rank, status: { exists: !!rt.state.exists, tested: !!rt.state.tested, open: !!rt.state.open }, defaultKind: rt.defaultKind, limits: rt.says,
      profiles: rowsOf(rt).map(r => { const L = profileLimits(rt, r.p); return { id: r.profile, dimension: L.dimension ?? null, cameras: L.cameraRigs ?? [], devices: Object.keys(L.devices ?? {}).filter(d => MEETS.has(L.devices[d].status)), deviceStatus: Object.fromEntries(Object.entries(L.devices ?? {}).map(([d, v]) => [d, v.status])), graphics: L.graphics?.fidelity ?? [], capabilities: L.capabilities ?? [], open: rowOpen(rt, r) }; }),
    })),
    compat: async input => compat(catalog, input),
    loops: async () => catalog.loops.map(l => ({ id: l.id, acts: l.acts, describe: l.describe, status: { exists: !!l.state.exists, tested: !!l.state.tested, open: !!l.state.open }, near: l.near ?? [], runtimes: l.openOn })),
    kinds: async () => catalog.kinds.map(k => ({ id: k.id, describe: k.feel, proven: k.proven, packs: k.packs ?? [], status: { exists: !!k.state.exists, tested: !!k.state.tested, open: !!k.state.open } })),
    mechanics: async () => catalog.mechanics.map(m => ({ id: m.id, describe: m.describe, runtimes: m.openOn, capabilities: [...new Set([...(m.capabilities ?? []), ...(m.gives ?? [])])], needs: m.capabilities ?? [], gives: m.gives ?? [] })),
    capabilities: async () => catalog.capabilities.map(c => ({ id: c.id, describe: c.describe })),
    vocabulary: async () => vocabularyOf(catalog),
    async manifest(type, id) {
      if (type === 'runtime') {
        const [r, prof] = String(id).split('/'), rt = byId(catalog.runtimes, r);
        if (!rt) return null;
        const p = prof ? byId(rt.profiles ?? [], prof) : null;
        if (prof && !p) return null;
        return { id, describe: p?.describe ?? rt.describe, note: [rt.says, rt.play?.rules, rt.play?.loops].filter(Boolean), traps: (rt.core?.neverOverride ?? []).map(f => `never override ${f}`), gates: gatesOf(rt), limits: profileLimits(rt, p) };
      }
      if (type === 'loop') { const l = byId(catalog.loops, id); return l && { id, describe: l.describe, note: l.notes ?? [], events: l.hooks ?? [], promise: l.promise, clock: l.clock, params: l.params }; }
      if (type === 'mechanic') { const m = byId(catalog.mechanics, id); return m && { id, describe: m.describe, note: m.notes?.lines ?? [], traps: m.notes?.stub?.traps ?? [], stub: m.notes?.stub ?? null, events: m.events, sync: { owner: m.host.owner, how: m.host.how ?? '' }, params: m.params }; }
      if (type === 'kind') { const k = byId(catalog.kinds, id); return k && { id, describe: k.feel, note: [], packs: k.packs ?? [], look: k.look, camera: k.camera }; }
      return null;   // packs are the library's: its resolver answers for them
    },
  };
}

/** The gate a measure belongs to, from the runtime's own lists (build or release), else the shared table. */
const MEASURE_GATE = { 1: 'A', 2: 'A', 4: 'A', 8: 'A', 18: 'A', 19: 'A', 3: 'B', 9: 'B', 20: 'B', 22: 'B', 24: 'B', 31: 'B', 32: 'B', 33: 'B', 36: 'B', 7: 'C', 10: 'C', 13: 'C', 15: 'C', 16: 'C', 21: 'C', 30: 'C', 38: 'C', 6: 'D', 12: 'D', 26: 'D', 5: 'E', 25: 'E', 27: 'E', 28: 'E', 29: 'E', 34: 'E', 11: 'F', 14: 'F', 17: 'F', 35: 'F', 37: 'F', 39: 'F' };
export function gateOfMeasure(rt, n) {
  for (const run of ['build', 'release']) for (const g of GATES) if (rt.measures?.[run]?.[g]?.includes(n)) return g;
  return MEASURE_GATE[n] ?? null;
}

// ── the command line ─────────────────────────────────────────────────────────────────────────────────────────────────

function printMatrix(m) {
  const w = Math.max(...m.rows.map(r => r.key.length)) + 2, cw = Math.max(8, ...m.cols.map(c => c.length + 2));
  const mark = { proven: 'proven', look: 'look', empty: '·' };
  console.log(''.padEnd(w) + m.cols.map(c => c.padEnd(cw)).join(''));
  for (const r of m.rows) console.log(`${r.key}${r.open ? '' : '*'}`.padEnd(w) + m.cols.map(c => mark[m.cells[r.key][c].cell].padEnd(cw)).join(''));
  console.log('\nproven: a verified example · look: the kind has a look there, unproven · ·: no look (a game that wants it builds it) · *: not open');
}

async function main(argv) {
  const arg = k => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1]; };
  const root = resolve(arg('--root') ?? ROOT), json = argv.includes('--json');
  const catalog = await buildCatalog(root);
  const say = (x, text) => console.log(json ? JSON.stringify(x, null, 2) : text);
  if (argv.includes('--can')) {
    const [kind, where] = [argv[argv.indexOf('--can') + 1], argv[argv.indexOf('--can') + 2]], [runtime, profile] = String(where).split('/');
    const a = can(catalog, { kind, runtime, profile: profile ?? null });
    return say(a, `${a.answer}: ${a.why.join(' ')}`);
  }
  if (argv.includes('--which')) {
    const limits = {};
    for (const kv of argv.slice(argv.indexOf('--which') + 1).filter(x => x.includes('='))) {
      const [k, v] = kv.split('=');
      limits[k] = k === 'devices' || k === 'needs' ? v.split(',') : k === 'players' ? Number(v) : v;
    }
    const a = which(catalog, limits);
    return say(a, [...a.meets.map(m => `meets   ${m.profile ? `${m.runtime}/${m.profile}` : m.runtime}${m.lacks.length ? `  builds: ${m.lacks.join(', ')}` : ''}${m.findings.length ? `  (${m.findings.join('; ')})` : ''}`),
      ...a.ruledOut.map(m => `out     ${m.profile ? `${m.runtime}/${m.profile}` : m.runtime}  ${m.misses.map(x => `${x.limit} ${words(x.need)} (has ${words(x.has)})`).join('; ')}`)].join('\n') || 'no open runtime');
  }
  if (argv.includes('--spec')) {
    const spec = JSON.parse(await readFile(resolve(arg('--spec')), 'utf8'));
    const a = checkSpec(catalog, spec);
    say(a, [...a.problems.map(p => `PROBLEM ${p}`), ...a.findings.map(f => `finding ${f}`)].join('\n') || 'ok');
    return a.problems.length ? 1 : 0;
  }
  if (argv.includes('--matrix')) return printMatrix(catalog.matrix);
  if (catalog.problems.length) console.error(catalog.problems.map(p => `problem: ${p}`).join('\n'));
  if (argv.includes('--check')) { console.log(`${catalog.problems.length ? 'FAIL' : 'ok'}: ${catalog.runtimes.length} runtimes, ${catalog.loops.length} loops, ${catalog.mechanics.length} mechanics, ${catalog.kinds.length} kinds`); return catalog.problems.length ? 1 : 0; }
  const out = resolve(arg('--out') ?? join(root, 'registry/catalog.json'));
  await writeFile(out, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`wrote ${relative(process.cwd(), out)}: ${catalog.runtimes.length} runtimes, ${catalog.loops.length} loops, ${catalog.mechanics.length} mechanics, ${catalog.kinds.length} kinds, ${catalog.conflicts.length} conflicts, ${catalog.problems.length} problems`);
  return catalog.problems.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2)) ?? 0;
