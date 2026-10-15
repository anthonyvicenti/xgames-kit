// Gate D, measure 6's reach leg: a round can be won only when what the play is for is there and every player can get
// to it. On the solo page verify reads window.__game.objectives() (runtimes/three/kit/core/boot.js: each mechanic's
// objectives(), audited against every seat by the world's walk grid, worlds/placement.js) at the start of play and
// again mid-round (a pickup that came back, a spot moved by a crater), and fails on any objective a seat cannot reach,
// naming the thing, where it is and why (in water, under the ground, walled off, floating), on a part that put fewer
// in play than it was asked for, and on a seat with no ground under it.
//
// The same leg holds the world's areas (widened 2026-10-14, "making all area reachable"): every region of ground worth
// going to (a landmark, an objective, set dressing, or simply room to play) is reached from the seats, joined by the
// world's connectors (worlds/connect.mjs: bridges, shallows, ramps, launch pads), or kept apart by the game with a reason
// (config/world.json reach.apart); scenery out at sea stands well out. A failure names each region, where it is and why
// (water, a cliff, a wall, a drop). Read at the start of play only: a crater that splits the land mid-round is play.
//
// The creator, 2026-10-14 (the composed look test): "We were supposed to collect berries, but there were no berries
// anywhere. I think in the ocean I saw some boxes but those are impossible to get." The pickup part had put its spots
// at y = 0, sea level on island terrain; every gate passed.

import { judgeAreas } from '../../../worlds/connect.mjs';

/** Read the objectives report on a page (null when the kit has none), with the world's areas (window.__game.regions):
 *  the ground the seats cannot get to, what stands on it and why (worlds/walk.mjs, worlds/connect.mjs). */
export const readObjectives = page => page.evaluate(() => {
  if (typeof window.__game?.objectives !== 'function') return null;
  const r = window.__game.objectives();
  try { if (typeof window.__game.regions === 'function') r.areas = window.__game.regions(); } catch (e) { r.areas = { error: e.message }; }
  return r;
}).catch(() => null);

/** Wait until the parts have put their objectives in play (the first frames of a round), then read them. */
export async function objectivesAtStart(page, { ms = 6000 } = {}) {
  const t0 = Date.now(); let r = null;
  while (Date.now() - t0 < ms) {
    r = await readObjectives(page);
    if (r && (r.parts ?? []).every(p => !p.asked || p.count > 0 || p.shortfall)) return r;
    await new Promise(ok => setTimeout(ok, 250));
  }
  return r;
}

const f1 = v => (v == null || !Number.isFinite(+v) ? '?' : (+v).toFixed(1));
const where = o => `(${f1(o.x)}, ${f1(o.y)}, ${f1(o.z)})`;
/** One unreachable objective in words: what, where, why, and what the ground and water are there. */
export function objectiveLine(o) {
  const seats = (o.from ?? []).filter(f => !f.ok).map(f => f.seat + 1);
  const all = seats.length === (o.from ?? []).length;
  const ground = o.ground == null ? 'no ground' : `ground ${f1(o.ground)}`;
  return `${o.label ?? o.kind} ${o.id} at ${where(o)}: ${o.why ?? 'cannot be reached'} (${ground}${o.water != null ? `, water ${f1(o.water)}` : ''}) from ${all ? 'every seat' : `seat ${seats.join(', ')}`}`;
}

/**
 * reports: the objectives reports read on the solo page (start, mid-round). → { ok, detail, record }
 * ok: true when every report has every objective reachable from every seat, every part put in play what it was asked
 * for, and every seat stands on ground; a game whose parts have no objectives passes ("nothing to reach").
 */
export function judgeReach(reports) {
  const got = reports.filter(Boolean);
  if (!got.length) return { ok: false, detail: 'the game reports no objectives (window.__game.objectives is missing: a kit copy older than the placement API)', record: null };
  const problems = [], seen = new Set();
  for (const r of got) {
    for (const s of r.seats ?? []) if (!s.ok && !seen.has(`seat${s.seat}`)) { seen.add(`seat${s.seat}`); problems.push(`seat ${s.seat + 1} at (${s.at.map(f1).join(', ')}) has no ground to stand on: ${s.why}`); }
    for (const p of r.parts ?? []) {
      if (p.error && !seen.has(`err${p.id}`)) { seen.add(`err${p.id}`); problems.push(`${p.id}.objectives() threw: ${p.error}`); }
      if (p.shortfall && !seen.has(`short${p.id}`)) { seen.add(`short${p.id}`); problems.push(`${p.id} was asked for ${p.shortfall.asked} and put ${p.shortfall.placed} in play (${p.shortfall.why})`); }
      else if (p.asked > 0 && !p.count && !seen.has(`none${p.id}`)) { seen.add(`none${p.id}`); problems.push(`${p.id} was asked for ${p.asked} and none is in play`); }
    }
    if (r.placement === false && (r.objectives ?? []).length && !seen.has('placement')) { seen.add('placement'); problems.push('the world has no placement (world.reach): nothing can say the objectives are reachable'); }
    // an objective a part marks not required (a loose prop a blast threw) is reported, never failed
    for (const o of r.objectives ?? []) if (o.ok === false && o.required !== false && !seen.has(o.id)) { seen.add(o.id); problems.push(objectiveLine(o)); }
  }
  // the world's areas, as play starts (the first read that has them)
  const first = got.find(r => r.areas && !r.areas.error && r.areas.placement !== false);
  const areas = first ? judgeAreas(first.areas) : null;
  if (got.some(r => r.areas?.error)) problems.push(`window.__game.regions() threw: ${got.find(r => r.areas?.error).areas.error}`);
  for (const line of areas?.problems ?? []) problems.push(line);
  const last = got.at(-1), objs = last.objectives ?? [];
  const kinds = [...new Set(objs.map(o => o.label ?? o.kind))];
  const loose = objs.filter(o => o.required === false), lost = loose.filter(o => o.ok === false);
  const record = { reads: got.length, ...(areas ? { areas: areas.record } : {}), loose: loose.length, lostLoose: lost.map(o => ({ id: o.id, why: o.why, at: [o.x, o.y, o.z] })), walk: last.walk ?? null, split: !!last.split, seats: last.seats ?? [], parts: last.parts ?? [], objectives: objs.map(o => ({ id: o.id, kind: o.kind, label: o.label, at: [o.x, o.y, o.z], ok: o.ok, ...(o.ok ? {} : { why: o.why, ground: o.ground, water: o.water }) })), problems };
  if (problems.length) return { ok: false, detail: `${problems.length} reach problem${problems.length > 1 ? 's' : ''}: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}`, record };
  // seats whose ground does not join (an island each, no way across) share nothing: then a thing some seat reaches is
  // fair (worlds/placement.js), and the detail says so
  const apart = last.split ? `; the seats' ground is split (${(last.seats ?? []).map(q => `seat ${q.seat + 1} gets to ${q.reaches?.length ? q.reaches.map(j => `seat ${j + 1}`).join(', ') : 'no other seat'}`).join('; ')}), so each objective is held to the seats that can get to it` : '';
  const looseLine = loose.length ? `; ${loose.length} thrown prop${loose.length > 1 ? 's' : ''} where blasts left ${loose.length > 1 ? 'them' : 'it'}${lost.length ? `, ${lost.length} out of reach (${lost.slice(0, 3).map(o => `${o.id}: ${o.why}`).join(', ')}): reported, not required` : ', all within reach'}` : '';
  // the areas: how many regions the world holds out of the seats' reach, what joins them, what is kept apart and why
  const conn = areas?.record?.connectors ?? [];
  const areaLine = areas?.record ? `; every area worth going to is reached${conn.length ? ` (${conn.length} connector${conn.length > 1 ? 's' : ''}: ${Object.entries(conn.reduce((m, c) => ({ ...m, [c.kind]: (m[c.kind] ?? 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}${areas.kept.length ? `; ${areas.kept.join('; ')}` : ''}` : '';
  return { ok: true, detail: (objs.length ? `${objs.length} objective${objs.length > 1 ? 's' : ''} (${kinds.join(', ')}) on ground ${last.split ? 'a seat' : 'every seat'} reaches${last.walk?.nodes ? ` (walk grid ${last.walk.cell} m, ${last.walk.nodes} places)` : ''}${apart}${looseLine}` : 'nothing to reach (no part puts objectives in play)') + areaLine, record };
}
