// What the kit can build, for `gamesfun catalog` and the MCP tool gamesfun_catalog: the registry (registry/catalog.json,
// computed from the manifests by registry/build-catalog.mjs: runtimes and their profiles, loops, mechanics, kinds, which
// exist, are tested and are open, and the runtime x kind matrix), with the kit's parts in detail beside it
// (builder/tools/catalog.mjs: each mechanic's params, the worlds, looks, bodies, props and clips of each runtime row).
// Bodies whose file is not on this machine (a private pack's, e.g. generated output) are dropped, so a spec never
// names one. The catalog assists and never narrows an idea: what no part has is a build item in the spec.
import { readFile } from 'node:fs/promises';
import { findAsset, localFile } from '../art/views.mjs';
import { CATALOG } from './paths.mjs';
import { runToolJson } from './run-tool.mjs';

/** registry/catalog.json as it is on disk. */
export async function registry() {
  return JSON.parse(await readFile(CATALOG, 'utf8'));
}

/** The registry and the kit's parts. → {registry, runtimes, kinds, matrix, loops, mechanics, worlds, looks, bodies, props, clips, fair, rows, spec} */
export async function catalog() {
  const reg = await registry();
  const r = await runToolJson('catalog');
  if (!r.data) throw new Error(`the kit's parts catalog failed (exit ${r.code}): ${r.stderr.trim().split('\n').slice(-2).join(' | ')}`);
  const c = r.data;
  c.bodies = (c.bodies ?? []).filter(b => !b.ref || (findAsset(b.ref) && localFile(findAsset(b.ref))));
  return { ...c, registry: { catalogVersion: reg.catalogVersion, inputs: reg.inputs }, runtimes: reg.runtimes, kinds: reg.kinds, matrix: reg.matrix, capabilities: reg.capabilities };
}

export const SECTIONS = ['runtimes', 'kinds', 'matrix', 'loops', 'mechanics', 'worlds', 'looks', 'bodies', 'props', 'clips', 'fair'];
/** What a call with no section prints: what runs a game, how it is played, how it feels, what moves. */
export const DEFAULT_SECTIONS = ['runtimes', 'loops', 'kinds', 'mechanics'];

const rowsOf = rt => (rt.profiles?.length ? rt.profiles.map(p => ({ key: `${rt.id}/${p.id}`, p })) : [{ key: rt.id, p: null }]);
const state = s => (s?.open ? 'open' : s?.exists ? 'not open' : 'not built');
const devicesOf = (rt, p) => Object.entries({ ...(rt.limits?.devices ?? {}), ...(p?.limits?.devices ?? {}) }).map(([d, v]) => `${d} ${v.status}`).join(', ');

/** Plain-text lines for the sections asked for. */
export function catalogLines(c, sections = DEFAULT_SECTIONS) {
  const L = [];
  const want = s => sections.includes(s);
  if (want('runtimes') && c.runtimes) {
    L.push('RUNTIMES (spec runtime and profile: what runs the game, chosen by hard limits: devices, graphics, camera)');
    for (const rt of c.runtimes) {
      if (rt.profiles?.length && rt.says) L.push(`  ${rt.id}: ${rt.says}`);
      for (const { key, p } of rowsOf(rt)) {
        const s = p ? (rt.state?.open && p.state?.open ? p.state : { ...p.state, open: false }) : rt.state;
        const lim = { ...(rt.limits ?? {}), ...(p?.limits ?? {}) };
        L.push(`  ${key.padEnd(18)} [${state(s)}] ${p?.describe ?? rt.describe ?? ''}`);
        if (lim.cameraRigs?.length) L.push(`${' '.repeat(21)}cameras ${lim.cameraRigs.join(', ')} · ${lim.dimension ?? ''} · graphics ${(lim.graphics?.apis ?? []).join('/')}`);
        const dev = devicesOf(rt, p);
        if (dev) L.push(`${' '.repeat(21)}devices: ${dev}`);
      }
      if (!rt.profiles?.length && rt.says) L.push(`${' '.repeat(21)}${rt.says}`);
    }
    L.push('');
  }
  if (want('kinds') && c.kinds) {
    L.push('KINDS (spec kind: how it feels; it never changes play. proven: a verified example on that runtime)');
    for (const k of c.kinds) L.push(`  ${k.id.padEnd(9)} ${k.feel ?? ''}${k.proven?.length ? `\n${' '.repeat(12)}proven on ${k.proven.join(', ')}` : ''}`);
    L.push('');
  }
  if (want('matrix') && c.matrix) {
    L.push('RUNTIME x KIND (proven: a verified example · look: a look, no game proves it yet · ·: none; a game that wants it builds it)');
    const w = Math.max(...c.matrix.rows.map(r => r.key.length)) + 3;
    L.push(''.padEnd(w) + c.matrix.cols.map(k => k.padEnd(8)).join(''));
    for (const r of c.matrix.rows) L.push(`${r.key}${r.open ? '' : '*'}`.padEnd(w) + c.matrix.cols.map(k => ({ proven: 'proven', look: 'look', empty: '·' })[c.matrix.cells[r.key][k].cell].padEnd(8)).join(''));
    L.push('  *: not open', '');
  }
  if (want('loops') && c.loops?.length) {
    L.push('LOOPS (spec loop: how the game is played, by who acts when)');
    for (const l of c.loops) {
      L.push(`  ${String(l.id).padEnd(9)} ${l.status === 'ready' ? '' : `[${l.status}] `}${l.label ?? ''}: ${l.describe ?? ''}`);
      if (l.pick) L.push(`${' '.repeat(12)}pick when: ${l.pick}`);
      if (l.runtimes?.length) L.push(`${' '.repeat(12)}open on: ${l.runtimes.join(', ')}`);
    }
    L.push('');
  }
  if (want('mechanics')) {
    L.push('MECHANICS (spec mechanics[].id; params checked against each one\'s schema)');
    for (const m of c.mechanics ?? []) {
      L.push(`  ${m.id.padEnd(11)} ${m.status === 'ready' ? '' : `[${m.status}] `}${m.describe ?? ''}`);
      if (m.examples?.length) L.push(`${' '.repeat(14)}as: ${m.examples.join(' · ')}`);
      if (m.runs?.length) L.push(`${' '.repeat(14)}runs on: ${m.runs.join(', ')}`);
      const ps = Object.entries(m.params ?? {});
      if (ps.length) L.push(`${' '.repeat(14)}params: ${ps.map(([k, p]) => `${k}${p && 'default' in p ? `=${JSON.stringify(p.default)}` : ''}`).join(', ')}`);
    }
    L.push('');
  }
  const where = x => (x.profile ? `${x.runtime}/${x.profile}` : x.runtime ?? '');
  if (want('worlds')) {
    L.push('WORLDS (spec world.template and world.size; each names its runtime row)');
    for (const w of c.worlds ?? []) {
      L.push(`  ${w.id.padEnd(11)} ${w.label ? `${w.label}: ` : ''}${w.describe ?? ''}${w.kind ? ` [${w.kind}]` : ''} (${where(w)})`);
      for (const [k, z] of Object.entries(w.sizes ?? {})) L.push(`${' '.repeat(14)}${k.padEnd(7)} ${(z.size ?? []).join(' x ')} m${z.rooms?.length ? `, rooms: ${z.rooms.join(', ')}` : ''}${z.entries?.length ? `; enemies come in at ${z.entries.join(', ')}` : ''}`);
    }
    if (c.worldSizes) L.push(`  sizes: ${Object.entries(c.worldSizes).map(([k, v]) => `${k} ${v.area?.[0]}–${v.area?.[1]} m²`).join(' · ')}`);
    L.push('');
  }
  if (want('looks')) { L.push('LOOKS (spec look.preset, look.time; left out, the kind\'s look on the runtime)'); for (const l of c.looks ?? []) L.push(`  ${l.id.padEnd(14)} ${l.label ?? ''}${l.describe ? `: ${l.describe}` : ''} (${(l.times ?? []).join(', ')}) (${where(l)})`); L.push(''); }
  if (want('bodies')) {
    L.push('BODIES (spec characters[].body: {"from": "library", "asset": "<pack>/<id>"}, {"from": "kind"} or a made one)');
    for (const b of c.bodies ?? []) L.push(`  ${String(b.id).padEnd(28)} ${b.describe ?? ''}${b.tags?.length ? ` [${b.tags.join(', ')}]` : ''}`);
    if (c.bodyGuide?.length) { L.push('  how to pick:'); for (const g of c.bodyGuide) L.push(`    ${g}`); }
    L.push('');
  }
  if (want('props')) { L.push(`PROPS (${(c.props ?? []).length}; spec world.props[].name picks the library prop by name and describe)`); L.push(`  ${(c.props ?? []).map(p => p.id).join(', ')}`); L.push(''); }
  if (want('clips')) { L.push('CLIPS (gf-humanoid-1)'); L.push(`  ${(c.clips ?? []).join(', ')}`); L.push(''); }
  if (want('fair')) { L.push('FAIR PLAY (every game; config/game.json → fair)'); L.push(`  ${Object.entries(c.fair?.defaults ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`); for (const d of c.fair?.does ?? []) L.push(`  - ${d}`); L.push(''); }
  return L;
}
