// tools/dressing.mjs --fix (track M2-C): the set-dressing faults (check 11's lint, tools/lib/dressing.mjs) that have one
// mechanical answer, repaired in config/world.json (and config/game.json). Nine kinds:
//   sunk              a prop below the ground            → at[1] = 0
//   floating          a prop hangs in the air            → at[1] = the top of what is under it (the lint's own number)
//   tilted            a prop is pitched or rolled        → yaw only
//   stretched         a prop is scaled unevenly          → one scale (its height's)
//   duplicate         the same prop twice in one spot    → the second is removed
//   looks-collectable scenery that looks like a pickup   → removed
//   scale-mixed       the same furniture at several sizes → the most common size for all
//   spawn-edge        a spawn at the play-area edge      → moved inside
//   pickup-size       pickups too small to read          → mechanics[pickup].params.size 0.6 (or 0.35 × the character scale)
// Only placements listed in /props (a scatter entry is a recipe, not a placement). It repeats until the lint has nothing
// more of these kinds (at most 5 passes), so a second run changes nothing, and it keeps a pass only if the lint's errors
// and warnings did not go up (a repair that makes things worse is put back and reported).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSubject, lintDressing } from './dressing.mjs';
import { openDocs } from './fix-lib.mjs';
import { placementScale } from '../../../worlds/layout.js';

export const FIXABLE = ['sunk', 'floating', 'tilted', 'stretched', 'duplicate', 'looks-collectable', 'scale-mixed', 'spawn-edge', 'pickup-size'];
const idx = pointer => { const m = /^\/props\/(\d+)$/.exec(pointer ?? ''); return m ? Number(m[1]) : null; };
const r2 = v => Math.round(v * 100) / 100;

/** → [{rule, file, pointer, before, after, why, remove?}] for one lint report, against the parsed world and game. */
export function plan(report, world, game, subject) {
  const out = [], seen = new Set();
  const edit = o => { const k = `${o.file}|${o.pointer}|${o.rule}`; if (!seen.has(k)) { seen.add(k); out.push(o); } };
  const props = world.props ?? [];
  for (const p of report.problems) {
    const i = idx(p.pointer), q = i !== null ? props[i] : null;
    switch (p.rule) {
      case 'sunk': if (q?.at) edit({ rule: 'sunk', file: 'config/world.json', pointer: `${p.pointer}/at/1`, before: q.at[1], after: 0, why: `${p.prop} was ${r2(-q.at[1])} m below the ground`, set: [q.at, 1, 0] }); break;
      case 'floating': {
        const y = /set its at\[1\] to (-?[\d.]+)/.exec(p.fix ?? '')?.[1];
        if (q?.at && y !== undefined) edit({ rule: 'floating', file: 'config/world.json', pointer: `${p.pointer}/at/1`, before: q.at[1], after: Number(y), why: `${p.prop} floated above the top of what is under it`, set: [q.at, 1, Number(y)] });
        break;
      }
      case 'tilted': if (Array.isArray(q?.rot)) edit({ rule: 'tilted', file: 'config/world.json', pointer: `${p.pointer}/rot`, before: q.rot.slice(), after: [0, q.rot[1] ?? 0, 0], why: `${p.prop} was pitched or rolled; props take a yaw only`, set: [q, 'rot', [0, q.rot[1] ?? 0, 0]] }); break;
      case 'stretched': if (q) { const s = placementScale(q)[1]; edit({ rule: 'stretched', file: 'config/world.json', pointer: `${p.pointer}/scale`, before: q.scale, after: s, why: `${p.prop} was scaled unevenly; it takes its height's scale`, set: [q, 'scale', s] }); } break;
      case 'duplicate': case 'looks-collectable': if (q) edit({ rule: p.rule, file: 'config/world.json', pointer: p.pointer, before: q, after: undefined, why: p.rule === 'duplicate' ? `${p.prop} was placed twice in the same spot` : `${p.prop} looked like a pickup but was scenery`, remove: i }); break;
      case 'scale-mixed': {
        const same = props.map((x, n) => ({ x, n })).filter(o => o.x.prop === p.prop);
        const count = new Map(); for (const o of same) { const k = JSON.stringify(o.x.scale ?? 1); count.set(k, (count.get(k) ?? 0) + 1); }
        const top = [...count.entries()].sort((a, b) => b[1] - a[1] || placementScale({ scale: JSON.parse(b[0]) })[1] - placementScale({ scale: JSON.parse(a[0]) })[1])[0][0];   // the most common; a tie keeps the smaller
        const to = JSON.parse(top);
        for (const o of same) if (JSON.stringify(o.x.scale ?? 1) !== top) edit({ rule: 'scale-mixed', file: 'config/world.json', pointer: `/props/${o.n}/scale`, before: o.x.scale ?? 1, after: to, why: `${p.prop} was placed at several sizes; all take the most common one`, set: [o.x, 'scale', to] });
        break;
      }
      case 'spawn-edge': {
        const m = /^\/spawns\/(\d+)$/.exec(p.pointer ?? ''); const s = m ? (world.spawns ?? [])[Number(m[1])] : null; if (!s) break;
        const [W, D] = world.size ?? [24, 24], lim = (h, v) => Math.max(-h, Math.min(h, v));
        const nx = r2(lim(W / 2 - 1.05, s[0])), nz = r2(lim(D / 2 - 1.05, s[2]));
        edit({ rule: 'spawn-edge', file: 'config/world.json', pointer: p.pointer, before: s.slice(), after: [nx, s[1], nz], why: `spawn ${m[1]} was at the play-area edge`, set: [world.spawns, Number(m[1]), [nx, s[1], nz]] });
        break;
      }
      case 'pickup-size': {
        const pk = (game?.mechanics ?? []).find(x => x.id === 'pickup'); if (!pk) break;
        const h = Object.values(subject.characters?.roles ?? {}).find(r => !r?.archetype || r.archetype === 'humanoid')?.height ?? 1.7, k = h / 1.75;   // a person's height (a creature is its own size)
        const to = Math.max(0.6, r2(0.35 * k));
        edit({ rule: 'pickup-size', file: 'config/game.json', pointer: '/mechanics/[id=pickup]/params/size', before: pk.params?.size, after: to, why: 'pickups were too small to read at play distance', set: [pk.params ??= {}, 'size', to] });
        break;
      }
    }
  }
  return out;
}

/** → { repairs, written, passes, remaining: {errors, warnings}, reverted } */
export async function fixDressing(dir, { apply = true, maxPasses = 5 } = {}) {
  const repairs = [], written = [];
  let reverted = null, passes = 0, report = null;
  const score = r => r.errors * 100 + r.warnings;
  for (; passes < maxPasses; passes++) {
    const docs = openDocs(dir);
    const subject = await loadSubject(dir);
    report = lintDressing(subject);
    const world = await docs.get('config/world.json'), game = await docs.get('config/game.json');
    const edits = plan(report, world, game, subject);
    if (!edits.length) break;
    const note = () => edits.map(e => ({ fix: `dressing:${e.rule}`, file: e.file, pointer: e.pointer, before: e.before, after: e.after, why: e.why }));
    if (!apply) { repairs.push(...note()); break; }
    for (const e of edits) if (e.set) { const [o, k, v] = e.set; o[k] = v; }
    for (const i of [...new Set(edits.filter(e => e.remove !== undefined).map(e => e.remove))].sort((a, b) => b - a)) world.props.splice(i, 1);
    // try the pass on disk; keep it only when the lint is no worse, else put the files back byte for byte
    const raw = new Map();
    for (const f of ['config/world.json', 'config/game.json']) raw.set(f, await readFile(join(dir, f)).catch(() => null));
    const files = await docs.save();
    const after = lintDressing(await loadSubject(dir));
    if (score(after) > score(report)) {
      for (const [f, b] of raw) if (b) await writeFile(join(dir, f), b);
      reverted = `a pass of ${edits.length} repair(s) made the lint worse (${score(report)} → ${score(after)}); put back`;
      break;
    }
    for (const f of files) if (!written.includes(f)) written.push(f);
    repairs.push(...note());
  }
  const last = apply && !reverted ? lintDressing(await loadSubject(dir)) : report;
  return { repairs, written, passes, reverted, remaining: last ? { errors: last.errors, warnings: last.warnings } : null };
}
