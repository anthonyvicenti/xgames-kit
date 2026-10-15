// World connectors (the gameplay layer, 2026-10-14): every area of a world worth going to is joined to the seats'
// ground. The creator, after the composed look test: "still some flags we talked about before, like making all area
// reachable". The composed levels showed islands, castle ruins and cliffs a player sees and wants to explore and cannot
// get to: a third island with no bridge, a ruin on a plateau higher than a jump.
//
// One rule for every world, in two halves:
//   the walk grid (worlds/walk.mjs walk.regions) finds the ground the seats cannot get to, in regions, with what stands
//   on each (landmarks, objectives, set dressing) and the nearest way across (how far, how high, what is under it);
//   this file decides which regions are worth going to, which the game keeps apart on purpose (with a reason), and the
//   cheapest connector that fits each gap among those the world family can build. A world's own builder makes it
//   (worlds/terrain/connect.mjs: bridges, shallows and ramps in the ground's distance field; worlds/pads.js: launch
//   pads on any world), the grid is read again, and the next region is joined, nearest first, until none is left.
//
// Connectors, cheapest first (connectorsFor), each tried in turn until one joins the region (a connector that does not
// join it is taken away again):
//   shallows   a sandbar at the sea's surface between two low shores (water between, both ends near the sea)
//   ramp       ground laid from rim to rim over a short gap (a step, a slot, a narrow strait: a causeway), or a slope
//              cut into a cliff and built out from its foot (a short way across, a rise higher than a jump)
//   bridge     a deck across water or a gorge between rims at about the same height, too long for a causeway (the
//              look's bridge model when the level has one, else the ground's own: a land bridge)
//   pad        a launch pad at each end that flings a body across along a fixed arc (any gap a pad can throw across;
//              fits physical-chaos games, and any world can build it)
//   (ladders and climbable faces: no world's controller climbs yet, so none is offered)
//
// The config (config/world.json → reach; spec world.reach): { connect: true | false, kinds: [...] (the connectors this
// world may use; the look's), apart: [{ what, why }] }. `what`: 'seats' (the seats stay on their own grounds: an
// artillery duel across water), a thing's id (a landmark, a prop, an objective: the region holding it), or [x, z] (the
// region there). `why` is required: a region kept apart says why, and the gate reads it.
//
// Pure: no three.js, no physics. Every copy of a game plans the same connectors from the same ground.

export const CONNECT_DEFAULTS = {
  minArea: 24,          // m² of ground that is worth going to by itself (room for a few players to meet)
  minCore: 6,           // m² of it at least 1.2 m in from its edges (a plateau, not a ribbon of beach under a cliff)
  minCave: 8,           // m² of a trap under the ground (a cave, a tunnel) a body gets into and not out of: worth a way out
  minDressing: 2,       // pieces of set dressing on a region that make it a place (a ruin and a palm, two crates)
  bridgeMin: 5,         // the shortest gap a bridge is stood over (a shorter one is ground laid across: a ramp)
  bridgeMax: 30,        // the longest a bridge spans (m)
  sandbarHigh: 3,       // how far above the sea both shores may stand for a sandbar (m)
  rampRise: 14,         // the highest cliff a ramp climbs (m)
  rampAcross: 8,        // the widest gap at a cliff's foot a ramp crosses (m)
  padMax: 48,           // the farthest a pad throws (m)
  padRise: 16,          // the highest a pad throws up (m)
  rounds: 10,           // connectors made at most (one per round)
  attempts: 6,          // places (and ways) tried for each kind of connector before the next kind
};
export const KINDS = ['shallows', 'ramp', 'bridge', 'pad'];
const r1 = v => Math.round(v * 10) / 10;

/** The reach config of a world (config/world.json → reach), with defaults. */
export function reachConfig(cfg = {}) {
  const R = cfg ?? {};
  return { connect: R.connect !== false, kinds: Array.isArray(R.kinds) ? R.kinds.filter(k => KINDS.includes(k)) : null, apart: Array.isArray(R.apart) ? R.apart.filter(a => a && a.what != null) : [], ...CONNECT_DEFAULTS, ...(R.numbers ?? {}) };
}

/** Why a region is worth going to (a line), or null: what stands on it, or simply its size. */
export function worthOf(region, { minArea = CONNECT_DEFAULTS.minArea, minCore = CONNECT_DEFAULTS.minCore, minCave = CONNECT_DEFAULTS.minCave, minDressing = CONNECT_DEFAULTS.minDressing } = {}) {
  const t = region.things ?? [];
  const objectives = t.filter(x => x.kind === 'objective'), marks = t.filter(x => x.kind === 'landmark'), props = t.filter(x => x.kind === 'prop');
  if (objectives.length) return `holds ${objectives.length === 1 ? `the objective ${objectives[0].id}` : `${objectives.length} objectives`}`;
  // the top of a wall, a stall or a crate is not a place to go to (only for an objective on it)
  if (region.on === 'things') return null;
  // a bridge's own deck is a way across, not a place: it is worth going to only for what stands on it
  if (t.some(x => x.kind === 'bridge' && (x.share ?? 1) > 0.5) && !marks.length) return null;
  if (marks.length) return `holds the landmark ${marks[0].id}`;
  const seats = t.filter(x => x.kind === 'seat');
  if (seats.length) return `holds seat ${seats.map(s => s.id).join(', ')}`;
  if (props.length >= minDressing) { const names = [...new Set(props.map(p => p.id))]; return `set dressing (${props.length}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})`; }
  // ground under the land nobody gets into (a hollow inside a hill): not a place for its size alone
  if (!region.trap && (region.covered ?? 0) >= 0.6) return null;
  if (region.area >= minArea && (region.core ?? Infinity) >= minCore) return `${Math.round(region.area)} m² of ground`;
  // a cave a body drops into and cannot climb out of: a player stuck there for the rest of the round
  if (region.trap && (region.covered ?? 0) >= 0.6 && region.area >= minCave) return `a ${Math.round(region.area)} m² cave`;
  return null;
}

/** The apart entry that keeps a region apart, or null. what: a thing's id, [x, z], or 'seats' (never a region). */
export function apartOf(region, apart = []) {
  for (const a of apart) {
    if (a.what === 'seats') { if ((region.things ?? []).some(t => t.kind === 'seat')) return a; continue; }
    if (Array.isArray(a.what)) {
      const [x, z] = a.what, [x0, z0, x1, z1] = region.box ?? [];
      if (x >= x0 - 2 && x <= x1 + 2 && z >= z0 - 2 && z <= z1 + 2) return a;
    } else if ((region.things ?? []).some(t => t.id === a.what || String(t.id).startsWith(`${a.what}#`))) return a;
  }
  return null;
}

/**
 * The connectors that fit a gap, cheapest first, among `kinds` (what the world can build and the look allows).
 * gap: {from (the seats' side), to (the region's side), across, rise, why}; numbers: the walk's (jumpUp, jumpAcross);
 * sea: the water's level (null: none). → [{kind, why}]
 */
export function connectorsFor(gap, { kinds = KINDS, numbers = {}, sea = null, limits = CONNECT_DEFAULTS } = {}) {
  if (!gap) return [];
  const L = { ...CONNECT_DEFAULTS, ...limits };
  const up = numbers.jumpUp ?? 1, d = gap.across, rise = gap.out ? -gap.rise : gap.rise, lo = Math.min(gap.from[1], gap.to[1]), hi = Math.max(gap.from[1], gap.to[1]);
  const out = [];
  const add = (kind, why) => { if (kinds.includes(kind)) out.push({ kind, why }); };
  if (gap.why === 'water' && sea != null && hi - sea <= L.sandbarHigh && d <= L.bridgeMax + 6) add('shallows', `water ${r1(d)} m across between low shores (${r1(lo - sea)}–${r1(hi - sea)} m over the sea)`);
  if (d <= L.rampAcross && Math.abs(rise) <= L.rampRise) add('ramp', rise > up ? `a ${r1(rise)} m rise over ${r1(d)} m (a jump climbs ${r1(up)} m)` : `${r1(d)} m of ${gap.why === 'water' ? 'water' : gap.why === 'wall' ? 'wall' : gap.why === 'void' ? 'drop' : 'broken ground'} between rims ${r1(Math.abs(rise))} m apart in height`);
  if (d >= L.bridgeMin && d <= L.bridgeMax && Math.abs(rise) <= Math.max(2.5, d * 0.3)) add('bridge', `${r1(d)} m of ${gap.why === 'water' ? 'water' : gap.why === 'void' ? 'drop' : 'gap'} between rims ${r1(Math.abs(rise))} m apart in height`);
  if (d <= L.padMax && rise <= L.padRise) add('pad', `${r1(d)} m across and ${rise >= 0 ? `${r1(rise)} m up` : `${r1(-rise)} m down`}: thrown across`);
  return out;
}

/** The arc from a to b ({x, y, z}): the time it takes and where a body is at t seconds (feet, with its velocity). */
export function padArc(a, b, { gravity = 20 } = {}) {
  const dx = b.x - a.x, dz = b.z - a.z, d = Math.sqrt(dx * dx + dz * dz);
  // over the higher end by a few metres and more for a long throw, so the arc clears the rims it crosses
  const apex = Math.max(a.y, b.y) + 2.2 + d * 0.12;
  const up = Math.sqrt(2 * gravity * (apex - a.y)), down = Math.sqrt(2 * gravity * (apex - b.y));
  const T = up / gravity + down / gravity;
  const vx = dx / T, vz = dz / T;
  const at = t => {
    const s = Math.min(Math.max(t, 0), T);
    return { x: a.x + vx * s, y: a.y + up * s - 0.5 * gravity * s * s, z: a.z + vz * s, vx, vy: up - gravity * s, vz, done: t >= T };
  };
  return { T, apex, d, at };
}

/**
 * Is a pad's arc from a to b in the open air? solidAt(x, y, z) → true where something solid is (the field, or a column
 * with a surface over the point). Samples every half metre of the way, past the take-off and before the landing.
 */
export function arcClearOf(a, b, solidAt) {
  const A = padArc(a, b), n = Math.max(6, Math.ceil(A.d / 0.5));
  for (let k = 1; k < n; k++) { const t = (k / n) * A.T, p = A.at(t); if ((k / n) < 0.08 || (k / n) > 0.92) continue; if (solidAt(p.x, p.y + 0.9, p.z)) return false; }
  return true;
}

/** A region's key across rounds (its place, rounded), so a region a connector failed to join is not tried for ever. */
const keyOf = r => `${Math.round(r.at[0] / 4)},${Math.round(r.at[2] / 4)}`;

/**
 * Join every region worth going to, nearest first. world: {
 *   analyse() → walk.regions({things, rims: true}) over the world as it is now (the seats' ground and the rest)
 *   build(kind, region, analysis) → a connector record {at, ends, ...} when it made one, else null
 *   joined(region) → is the region reached now (the walk read again)?
 *   undo() → take the last connector away again (it did not join the region)
 *   mark() → remember the world as it is now (before a build)
 * }. opts: reachConfig + {can (the kinds this world builds), numbers, sea}. → {made: [...], kept: [...] (apart, with
 * why), left: [{at, area, box, worth, gap}] (worth going to and still out of reach), small: n (regions not worth it),
 * analysis (the last)}
 */
export function connectRegions(world, opts = {}) {
  const C = { ...CONNECT_DEFAULTS, ...opts }, kinds = (C.kinds ?? KINDS).filter(k => (opts.can ?? KINDS).includes(k));
  const made = [], given = new Set(), tries = [];
  let A = world.analyse();
  const rate = r => ({ r, worth: worthOf(r, C), apart: apartOf(r, C.apart) });
  for (let round = 0; C.connect !== false && round < C.rounds; round++) {
    const todo = A.regions.map(rate).filter(x => x.worth && !x.apart && !given.has(keyOf(x.r)))
      .sort((a, b) => (a.r.gap?.across ?? 1e9) - (b.r.gap?.across ?? 1e9) || b.r.area - a.r.area);
    if (!todo.length) break;
    const { r, worth } = todo[0];
    let c = null;
    // each fitting kind in turn, and of each a few places to stand it (the builder's next best ends each attempt)
    // the kinds the nearest gap fits first; then the rest, each builder looking for a place of its own along the rims (a
    // cliff a ramp climbs may be beside the gap a bridge would have to cross)
    const fits = connectorsFor(r.gap, { kinds, numbers: C.numbers, sea: C.sea, limits: C });
    for (const k of kinds) if (!fits.some(f => f.kind === k)) fits.push({ kind: k, why: `${k === 'pad' ? 'thrown' : 'joined'} where the rims allow (the nearest gap fits no ${k})` });
    // a cave nothing leads out of, on a world that can close it: filled (no one gets stuck there)
    if (r.trap && (r.covered ?? 0) >= 0.6 && (opts.can ?? []).includes('fill')) fits.push({ kind: 'fill', why: `a cave under the ground nothing leads out of: closed` });
    for (const f of fits) {
      for (let attempt = 0; attempt < C.attempts && !c; attempt++) {
        world.mark?.();
        const got = world.build(f.kind, r, A, attempt);
        if (!got) { world.undo?.(); if (!attempt) tries.push({ kind: f.kind, region: r.at, result: 'no place for it' }); break; }
        if (got.none) { world.undo?.(); continue; }      // not at this place: the builder's next
        if (world.joined && !world.joined(r, f.kind)) { world.undo?.(); tries.push({ kind: f.kind, region: r.at, attempt, result: 'built, did not join: taken away' }); continue; }
        tries.push({ kind: f.kind, region: r.at, attempt, result: 'joined' });
        c = { ...got, kind: f.kind, for: { at: r.at, area: r.area, worth }, why: f.why };
      }
      if (c) break;
    }
    if (c) made.push(c); else given.add(keyOf(r));
    A = world.analyse();
  }
  const all = A.regions.map(rate);
  return {
    made,
    kept: all.filter(x => x.worth && x.apart).map(x => ({ at: x.r.at, area: x.r.area, worth: x.worth, why: x.apart.why, what: x.apart.what })),
    left: all.filter(x => x.worth && !x.apart).map(x => ({ at: x.r.at, area: x.r.area, box: x.r.box, worth: x.worth, gap: x.r.gap })),
    small: all.filter(x => !x.worth).length,
    tries,
    analysis: A,
  };
}

/**
 * The verdict on a world's areas (gate D, measure 6's reach leg): every region worth going to is reached from the seats
 * or kept apart with a reason; backdrop scenery stands well out (`clear` m of open water from the seats' ground), so it
 * never reads as a place to go. report: window.__game.regions(). → {ok, problems: [lines], kept: [lines], record}
 */
export function judgeAreas(report, { clear = 30 } = {}) {
  if (!report || report.placement === false) return { ok: true, problems: [], kept: [], record: null, none: true };
  const C = { ...CONNECT_DEFAULTS, ...(report.limits ?? {}) }, apart = report.apart ?? [];
  const problems = [], kept = [];
  const f1 = v => (Number.isFinite(+v) ? (+v).toFixed(1) : '?');
  // a part that lets players make their own way (it says how: building blocks, a grapple) reaches what walking cannot
  const ways = (report.ways ?? []).filter(w => w?.how);
  let byWay = 0;
  const caves = [];
  const where = a => `(${a.map(f1).join(', ')})`;
  for (const r of report.regions ?? []) {
    const worth = worthOf(r, C); if (!worth) continue;
    const a = apartOf(r, apart);
    if (a) { kept.push(`the region at ${where(r.at)} (${worth}) is kept apart: ${a.why}`); continue; }
    if (ways.length) { byWay++; continue; }
    // a cave (a trap under the ground): the generator closes the caves it sees in the ground's own field; the walk grid
    // read from the colliders sees each collider once down a column, so its caves are reported, not failed
    if (r.trap && (r.covered ?? 0) >= 0.6) { caves.push(`a ${Math.round(r.area)} m² cave at ${where(r.at)}`); continue; }
    if (r.trap) { const g = r.gap; problems.push(`an area at ${where(r.at)} (${worth}, ${Math.round(r.area)} m²) is a trap: players get in and cannot get back to the seats${g ? ` (${g.why === 'cliff' ? `a cliff ${f1(-g.rise)} m high` : g.why === 'water' ? `${f1(g.across)} m of water` : g.why === 'wall' ? 'walled in' : `${f1(g.across)} m across and ${f1(-g.rise)} m up`}, the way out nearest at ${where(g.from)})` : ''}`); continue; }
    const g = r.gap, how = !g ? 'no way there' : g.why === 'water' ? `${f1(g.across)} m of water from the seats' ground` : g.why === 'void' ? `a ${f1(g.across)} m drop between it and the seats' ground` : g.why === 'cliff' ? `a cliff ${f1(g.rise)} m high (a jump climbs ${f1(report.numbers?.jumpUp ?? 1)} m)` : g.why === 'wall' ? 'walled off' : `${f1(g.across)} m across and ${f1(g.rise)} m up: out of a jump`;
    problems.push(`an area at ${where(r.at)} (${worth}, ${Math.round(r.area)} m²) cannot be reached: ${how}${g ? `, nearest from ${where(g.from)}` : ''}`);
  }
  if (byWay) kept.push(`${byWay} area${byWay > 1 ? 's' : ''} the walk cannot get to: ${ways.map(w => `${w.part}: ${w.how}`).join('; ')}`);
  // 'seats' apart: an artillery duel's seats on their own grounds is the game's call; seats split without it is not
  if (report.split && !apart.some(a => a.what === 'seats')) problems.push(`the seats stand on ground that does not join (${(report.seatsReach ?? []).map(s => `seat ${s.seat + 1} gets to ${s.reaches?.length ? s.reaches.map(j => `seat ${j + 1}`).join(', ') : 'no other seat'}`).join('; ')}) and nothing says they are kept apart`);
  for (const a of apart) if (!a.why || String(a.why).trim().length < 8) problems.push(`reach.apart ${JSON.stringify(a.what)} gives no reason (a region kept apart says why)`);
  for (const b of report.backdrop ?? []) if (b.water < clear) problems.push(`the backdrop island ${b.id} at (${b.at.map(f1).join(', ')}) stands ${f1(Math.max(0, b.water))} m of water from the seats' ground: it reads as a place to go (push it out past ${clear} m or join it)`);
  if (caves.length) kept.push(`${caves.length} cave${caves.length > 1 ? 's' : ''} the walk reads as a trap, reported (${caves.slice(0, 3).join('; ')})`);
  const record = { caves, regions: (report.regions ?? []).length, worth: (report.regions ?? []).filter(r => worthOf(r, C)).length, connectors: (report.connectors ?? []).map(c => ({ kind: c.kind, at: c.at, why: c.why })), kept, backdrop: report.backdrop ?? [], problems };
  return { ok: !problems.length, problems, kept, record };
}
