// Checks a place recipe (kit/world/places.js) against the heightmap the core generates from it (core TerrainData with
// the recipe's layout, core patch #6): is the harbour where a harbour can be, the village on dry flat ground, the start
// on land, the reef in its depth range, the paths walkable and connected? The village's houses are tested on the
// ground before the core flattens their pads (it flattens to the mean, so a slope or a wet foot shows here).
//   node runtimes/vista/tools/place-check.mjs                         50 seeds × 5 word sets (and the reference)
//   node runtimes/vista/tools/place-check.mjs --seeds 1-50 --sets all --jobs 8 [--json out.json]
//   node runtimes/vista/tools/place-check.mjs --recipe file.json      one recipe
//   node runtimes/vista/tools/place-check.mjs --timings 101-112 [--json out.json]
//        the budget: the core's terrain generation (TerrainData.timings.total, best of 3, one at a time) and its typed
//        arrays for the reference and those seeds
// Exit 1 when any place fails a check.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

export const SETS = {
  seed: {},                                             // every word from the seed
  small: { size: 'small' },
  'large-town': { size: 'large', village: 'town', peaks: 'high' },
  'narrow-reef': { beach: 'narrow', reef: 'large', village: 'hamlet' },
  'low-lush': { peaks: 'low', plants: 'lush', bay: 'w', reef: 'small' },
};

// the harbour pieces the core always builds (game/FishStand.js STAND, game/Chandlery.js CHANDLERY, world/Village.js)
// (dry: their lowest ground at least `min` m above the sea; the boathouse is a slipway at the waterline, the reference's
// stands 0.4 m up; where they stand: the recipe's stalls and plan, or upstream's)
// a point inside a building's walls, porch or annex (its footprint circle is looser: the core's bounding radius)
const insideBuilding = (b, x, z) => {
  const c = Math.cos(b.yaw ?? 0), s = Math.sin(b.yaw ?? 0), dx = x - b.x, dz = z - b.z;
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  const w = (b.w ?? 3.2) / 2 + 0.3, front = (b.d ?? 3) / 2 + (b.porch?.depth ?? 0) + 0.3, back = (b.d ?? 3) / 2 + (b.annex ? b.annex.d ?? 2.2 : 0) + 0.3;   // the annex is a lean-to at the back (Buildings.js)
  return Math.abs(lx) < w && lz < front && lz > -back;
};

export async function checkRecipe(recipe, { TerrainData, layoutFromRecipe, houseRadius, polyDist, HARBOUR, harbourFrame }) {
  const L = layoutFromRecipe(recipe);
  const t0 = performance.now();
  const td = new TerrainData(L.terrainSeed, L);
  const genMs = Math.round(performance.now() - t0);
  const h = (x, z) => td.heightAt(x, z);
  const out = [];
  const check = (name, ok, detail) => out.push({ name, ok: !!ok, detail });
  const ring = (x, z, r, n = 12) => { const a = [[x, z]]; for (let k = 0; k < n; k++) a.push([x + Math.cos(k / n * 6.2832) * r, z + Math.sin(k / n * 6.2832) * r]); return a; };
  const span = pts => { const v = pts.map(([x, z]) => h(x, z)); return { min: Math.min(...v), max: Math.max(...v), mean: v.reduce((s, q) => s + q, 0) / v.length }; };
  const r1 = v => Math.round(v * 10) / 10;
  // the harbour frame: the pier, its head and the bay are laid out there (upstream's coordinates)
  const F = harbourFrame(recipe), hl = (lx, lz) => h(...F.tw(lx, lz));

  // the pier (timber pier, dock or jetty): foot on sand above the water, head over its depth, the berth deep enough
  const P = recipe.pier, kind = P.kind ?? 'pier';
  const [ftx, ftz] = F.tw(P.x, P.zStart + 4);
  const foot = hl(P.x, P.zStart + 2), footSand = td.sand[Math.floor(ftz - td.origin) * td.res + Math.floor(ftx - td.origin)] / 255;
  check('pier foot on sand above the water', foot > 0.25 && foot < 4 && footSand > 0.3, { h: r1(foot), sand: r1(footSand), kind });
  // (a dock, or any pier on a reef flat, berths in shallower water)
  const flat = recipe.words?.water === 'flat';
  const head = [], [dMin, dMid] = flat ? [1.4, 1.5] : kind === 'dock' ? [2.0, 2.3] : [2.6, 3];
  for (let x = P.x - P.headWidth / 2; x <= P.x + P.headWidth / 2 + 0.01; x += P.headWidth / 4) for (let z = P.zEnd - P.headDepth; z <= P.zEnd + 0.01; z += P.headDepth / 2) head.push(-hl(x, z));
  const mid = -hl(P.x, P.zEnd - P.headDepth / 2);
  check(`${kind} head over ${dMid} - 6 m of water`, Math.min(...head) >= dMin && Math.max(...head) <= 6.5 && mid >= dMid && mid <= 6, { mid: r1(mid), min: r1(Math.min(...head)), max: r1(Math.max(...head)) });
  const D = recipe.boatDock, [dlx, dlz] = F.tl(D.x, D.z), berth = [];
  for (let dx = -2; dx <= 2; dx += 1) for (let dz = -5; dz <= 5; dz += 2.5) berth.push(-hl(dlx + dx, dlz + dz));
  // (the boat draws about 1.1 m: on a reef flat it lies in 1.4 m and more)
  check('boat berth at the pier head, deep enough', Math.min(...berth) >= (flat ? 1.3 : 2.0) && Math.abs(dlz - (P.zEnd - P.headDepth / 2)) < 4 && Math.abs(dlx - P.x) < P.headWidth && Math.abs(Math.sin((D.heading ?? 0) - (recipe.harbour?.heading ?? 0))) < 0.05, { min: r1(Math.min(...berth)) });
  // the pier's line crosses the shore once, square to it
  let crossings = 0, prev = hl(P.x, P.zStart);
  for (let z = P.zStart + 1; z <= P.zEnd; z += 1) { const c = hl(P.x, z); if ((prev > 0) !== (c > 0)) crossings++; prev = c; }
  check(`${kind} runs from the beach straight out to sea`, crossings === 1, { crossings });

  // the harbour pieces on dry, even ground (the place's stalls and boathouse, or upstream's)
  const planObj = recipe.village.plan && typeof recipe.village.plan === 'object' ? recipe.village.plan : null;
  const STALLS = [
    { name: 'fish stand', r: 2.2, min: 0.9, ...(recipe.stalls?.fish ?? HARBOUR.fishStand) },
    { name: 'chandlery', r: 1.8, min: 0.5, ...(recipe.stalls?.chandlery ?? HARBOUR.chandlery) },
    { name: 'boathouse', min: 0.05, ...(planObj?.boathouse ?? HARBOUR.boathouse), r: 4.5 },
  ];
  // the route up from the pier and the plaza: the place's, or upstream's
  const FOOT = F.tw(55, -66.5);
  const WALK = planObj ? (planObj.boardwalk ? [FOOT, ...planObj.boardwalk] : [FOOT, F.tw(55, -69)]) : HARBOUR.boardwalk;
  const PLAZA = planObj ? (planObj.plaza ? { x: planObj.plaza.x, z: planObj.plaza.z, r: 6 } : null) : HARBOUR.plaza;
  for (const s of STALLS) {
    const g = span(ring(s.x, s.z, s.r));
    check(`${s.name} on dry ground`, g.min > s.min && g.max - g.min < 1.4, { min: r1(g.min), range: r1(g.max - g.min) });
  }

  // the village: pads dry and flat (before the core levels them), clear of each other, the paths and the boardwalk
  const plan = recipe.village.plan;
  const builds = [];
  if (plan && typeof plan === 'object') {
    for (const b of plan.houses) builds.push({ ...b, r: houseRadius(b), kind: 'house' });
    for (const b of plan.sheds) builds.push({ ...b, r: 2.6, kind: 'shed' });
    let bad = [];
    for (const b of builds) {
      const g = span(ring(b.x, b.z, b.r - 0.6, 16));
      if (!(g.min > 2.2 && g.max - g.min < 2.2)) bad.push({ name: b.name, min: r1(g.min), range: r1(g.max - g.min) });
    }
    check('village pads dry and flat', bad.length === 0, bad.length ? bad : { buildings: builds.length });
    bad = [];
    for (let i = 0; i < builds.length; i++) for (let j = i + 1; j < builds.length; j++) {
      const a = builds[i], b = builds[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r - 0.8) bad.push([a.name, b.name]);
    }
    for (const b of builds) {
      for (const p of recipe.paths) if (polyDist(p.pts, b.x, b.z) < b.r + p.w - 0.8) bad.push([b.name, 'path']);
      if (polyDist(WALK, b.x, b.z) < b.r + 0.6) bad.push([b.name, 'boardwalk']);
      if (PLAZA && Math.hypot(b.x - PLAZA.x, b.z - PLAZA.z) < b.r + PLAZA.r) bad.push([b.name, 'plaza']);
      for (const s of STALLS) if (Math.hypot(b.x - s.x, b.z - s.z) < b.r + s.r + 1) bad.push([b.name, s.name]);
    }
    check('buildings clear of each other, the paths, the boardwalk, the plaza and the stalls', bad.length === 0, bad.length ? bad.slice(0, 8) : undefined);
    const huts = plan.huts.map(u => ({ name: u.name, g: h(u.x, u.z) }));
    check('stilt huts above the waterline', huts.every(u => u.g > 0.5), huts.map(u => [u.name, r1(u.g)]));
    if (PLAZA) { const g = span(ring(PLAZA.x, PLAZA.z, 5)); check('market plaza on dry ground', g.min > 2 && g.max - g.min < 1.8, { min: r1(g.min), range: r1(g.max - g.min) }); }
    const props = (plan.props || []).flatMap(p => p.kind === 'fence' ? p.pts : p.kind === 'laundry' ? [p.a, p.b] : p.kind === 'clutter' ? p.items.map(i => [i[1], i[2]]) : [[p.x, p.z]]);
    const wet = props.filter(([x, z]) => h(x, z) < 1.5), inside = props.filter(([x, z]) => builds.some(b => insideBuilding(b, x, z)));
    check('yard props on dry ground, outside the buildings', wet.length === 0 && inside.length === 0, { props: props.length, wet: wet.length, inside: inside.length });
    for (const sp of plan.sidePaths || []) {
      const ends = [sp[0], sp[sp.length - 1]];
      const toHouse = builds.some(b => b.kind === 'house' && Math.hypot(ends[1][0] - b.x, ends[1][1] - b.z) < b.r + 3);
      const toWalk = polyDist(WALK, ...ends[0]) < 3 || (PLAZA && Math.hypot(ends[0][0] - PLAZA.x, ends[0][1] - PLAZA.z) < PLAZA.r + 2);
      check('side path joins the boardwalk or plaza to a house', toHouse && toWalk, { from: ends[0], to: ends[1] });
    }
    // the core keeps the ground calm (no outcrops) within the village's reach: every building inside it
    const vc = recipe.village.center, vr = recipe.village.radius;
    check('village reach covers its buildings', builds.every(b => Math.hypot(b.x - vc[0], b.z - vc[1]) + b.r <= vr + 8), { radius: vr });
  }

  // the start: dry land, even, looking at the pier
  const S = recipe.start, g0 = span(ring(S.x, S.z, 1.5));
  const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw);   // forward for the core's yaw (π: +z)
  const look = Math.atan2(fx, fz);
  let off = Infinity;
  for (let z = P.zStart; z <= P.zEnd; z += 2) { const [px, pz] = F.tw(P.x, z), a = Math.atan2(px - S.x, pz - S.z); off = Math.min(off, Math.abs(Math.atan2(Math.sin(a - look), Math.cos(a - look)))); }
  const blocked = builds.some(b => Math.hypot(b.x - S.x, b.z - S.z) < b.r + 1.5) || (plan?.huts || []).some(u => Math.hypot(u.x - S.x, u.z - S.z) < 4)
    || (plan?.beach || []).some(it => it.kind !== 'clutter' && Math.hypot(it.x - S.x, it.z - S.z) < (it.kind === 'wreck' ? 5 : it.kind === 'buoy' || it.kind === 'rope' ? 0.8 : 3))
    || STALLS.some(s => Math.hypot(s.x - S.x, s.z - S.z) < s.r + 1.2);
  check('start on dry land, clear, facing the pier', g0.min > 1.2 && g0.max - g0.min < 1.2 && off < 0.5 && !blocked, { h: r1(g0.min), facingOff: r1(off), from: S.from, blocked });
  if (plan && typeof plan === 'object' && plan.beach) {
    const bad = plan.beach.flatMap(it => it.kind === 'clutter' ? it.items.map(i => ({ kind: i[0], x: i[1], z: i[2] })) : [it])
      .filter(it => h(it.x, it.z) < (it.kind === 'wreck' ? -0.6 : 0.3) || builds.some(b => Math.hypot(b.x - it.x, b.z - it.z) < b.r));
    check('boats and gear on the beach, out of the sea', bad.length === 0, bad.length ? bad.slice(0, 6).map(b => [b.kind, r1(h(b.x, b.z))]) : { items: plan.beach.length });
  }
  const SP = recipe.spawn, gs = span(ring(SP.x, SP.z, 2));
  check('spawn clear', gs.min > 0.6 && gs.max - gs.min < 1.2 && !builds.some(b => Math.hypot(b.x - SP.x, b.z - SP.z) < b.r + 4), { h: r1(gs.min) });

  // the reef: 1.5 - 12 m deep across most of it (none: out of every view, in deep water)
  const RF = recipe.reef;
  if (RF.none) check('no reef', RF.radius === 0, { radius: RF.radius });
  else {
    const pts = [];
    for (const f of [0, 0.3, 0.6]) pts.push(...ring(RF.center[0], RF.center[1], RF.radius * f, 10));
    const lim = recipe.words?.water === 'deep' ? -18 : -14;   // a drop-off's reef slope runs deeper
    const inRange = pts.filter(([x, z]) => h(x, z) <= -1.2 && h(x, z) >= lim).length / pts.length;
    check('reef in its depth range (1.2 - 14 m)', inRange >= 0.85 && h(RF.center[0], RF.center[1]) <= -1.3 && h(RF.center[0], RF.center[1]) >= -11, { inRange: r1(inRange), center: r1(h(RF.center[0], RF.center[1])) });
    const gap = Math.abs(F.tl(...RF.center)[0] - P.x) - RF.radius;
    check('reef clear of the pier channel', gap > 6, { gap: r1(gap) });
  }

  // paths on land, walkable, joined to the harbour
  const plaza = PLAZA ? [PLAZA.x, PLAZA.z] : [1e6, 1e6], bh = STALLS[2];
  // grades over 8 m windows: the hiking trail (w 0.6) as steep as the reference's (median 0.52, 90th percentile 1.06),
  // every other path a gentle walk
  recipe.paths.forEach((p, i) => {
    const samples = [];
    for (let k = 0; k < p.pts.length - 1; k++) {
      const [ax, az] = p.pts[k], [bx, bz] = p.pts[k + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
      for (let s = 0; s < n; s++) samples.push([ax + (bx - ax) * s / n, az + (bz - az) * s / n, k]);
    }
    samples.push([...p.pts.at(-1), p.pts.length - 1]);
    const grades = [];
    for (let s = 0; s + 8 < samples.length; s += 4) { const [x0, z0] = samples[s], [x1, z1] = samples[s + 8]; grades.push(Math.abs(h(x1, z1) - h(x0, z0)) / Math.max(1, Math.hypot(x1 - x0, z1 - z0))); }
    grades.sort((a, b) => a - b);
    const med = grades[grades.length >> 1] ?? 0, p90 = grades[Math.floor(grades.length * 0.9)] ?? 0;
    // (a path's first leg may start on the wet sand: the spawn's and the boathouse slipway's do in the reference)
    const wet = samples.filter(([x, z, k]) => h(x, z) < (k === 0 ? 0.2 : 0.8)).length;
    const trail = p.w <= 0.6;
    const walk = trail ? med <= 0.62 && p90 <= 1.25 : p90 <= 0.3;
    const first = p.pts[0];
    // joined: an end (or, for a lane, any point) at the plaza, the route up from the pier, the spawn, the boathouse, the
    // pier foot or another path
    const ends = [first, p.pts.at(-1)];
    const near = ([x, z]) => Math.hypot(x - plaza[0], z - plaza[1]) < 14 || polyDist(WALK, x, z) < 4 || Math.hypot(x - recipe.spawn.x, z - recipe.spawn.z) < 6
      || Math.hypot(x - bh.x, z - bh.z) < 10 || Math.hypot(x - FOOT[0], z - FOOT[1]) < 8 || recipe.paths.some((q, j) => j !== i && polyDist(q.pts, x, z) < 4);
    const joined = (!planObj && (i === 0 || i === 2)) || ends.some(near) || p.pts.some(q => Math.hypot(q[0] - plaza[0], q[1] - plaza[1]) < 10);
    check(`path ${i + 1} on land, walkable, joined`, walk && wet === 0 && joined, { points: p.pts.length, median: r1(med * 10) / 10, p90: r1(p90 * 10) / 10, wet, joined });
  });

  // the island inside the core's scans (vegetation, rocks, debris cover x ±640, z -880..330)
  let outside = 0;
  for (let z = -1000; z < 1000; z += 8) for (let x = -1000; x < 1000; x += 8) if ((x < -660 || x > 660 || z < -900 || z > 340) && h(x, z) > 0.5) outside++;
  check('island inside the core\'s scans', outside === 0, { landOutside: outside });

  return { ok: out.every(c => c.ok), checks: out, genMs, timings: td.timings };
}

async function load() {
  const base = new URL('../', import.meta.url);
  const { TerrainData } = await import(new URL('core/src/world/TerrainData.js', base));
  const { layoutFromRecipe } = await import(new URL('core/src/world/Place.js', base));
  const places = await import(new URL('kit/world/places.js', base));
  return { TerrainData, layoutFromRecipe, houseRadius: places.houseRadius, polyDist: places.polyDist, HARBOUR: places.HARBOUR, harbourFrame: places.harbourFrame, placeRecipe: places.placeRecipe, REFERENCE: places.REFERENCE };
}

if (!isMainThread && workerData?.placeCheck) {
  const lib = await load();
  parentPort.on('message', async job => {
    if (job === null) { process.exit(0); }
    const recipe = job.recipe ?? (job.seed === 'reference' ? lib.REFERENCE : lib.placeRecipe(job.seed, job.words));
    const res = await checkRecipe(recipe, lib);
    parentPort.postMessage({ ...job, recipe: undefined, words: recipe.words, ...res });
  });
} else if (isMainThread && process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--timings')) {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] ?? true); };
  const lib = await load();
  const [a, b] = String(arg('timings', '101-112')).split('-').map(Number);
  const bytes = td => ['heights', 'rock', 'sand', 'path', 'gully', 'seagrass', 'rubble', 'scarp'].reduce((s, k) => s + td[k].byteLength, 0) + td.mmLevels.reduce((s, l) => s + l.min.byteLength + l.max.byteLength, 0);
  const measure = recipe => {
    const L = lib.layoutFromRecipe(recipe);
    let best = Infinity, td = null, recipeMs = null;
    for (let k = 0; k < 3; k++) { td = new lib.TerrainData(L.terrainSeed, L); best = Math.min(best, td.timings.total); }
    return { terrainMs: best, terrainMB: Math.round(bytes(td) / 1048576 * 10) / 10, recipeMs };
  };
  const rows = [{ id: 'reference', ...measure(lib.REFERENCE) }];
  for (let s = a; s <= b; s++) { const t0 = performance.now(); const r = lib.placeRecipe(s); const ms = performance.now() - t0; rows.push({ id: `seed-${s}`, words: r.words, ...measure(r), recipeMs: Math.round(ms) }); }
  const gen = rows.slice(1), ref = rows[0];
  const out = { schema: 'gf-vista-place-timings/1', at: new Date().toISOString(), tool: 'runtimes/vista/tools/place-check.mjs --timings', budget: 'within 20 % of the reference', rows,
    reference: { terrainMs: ref.terrainMs, terrainMB: ref.terrainMB }, generated: { meanMs: Math.round(gen.reduce((s, r) => s + r.terrainMs, 0) / gen.length), maxMs: Math.max(...gen.map(r => r.terrainMs)), maxMB: Math.max(...gen.map(r => r.terrainMB)) } };
  out.within = out.generated.maxMs <= ref.terrainMs * 1.2 && out.generated.maxMB <= ref.terrainMB * 1.2;
  if (arg('json')) writeFileSync(arg('json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`terrain: reference ${ref.terrainMs} ms ${ref.terrainMB} MB; generated mean ${out.generated.meanMs} ms, max ${out.generated.maxMs} ms, max ${out.generated.maxMB} MB → ${out.within ? 'within' : 'OVER'} budget`);
  process.exit(out.within ? 0 : 1);
} else if (isMainThread && process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] ?? true); };
  const jobs = [];
  if (arg('recipe')) jobs.push({ id: arg('recipe'), recipe: JSON.parse(readFileSync(arg('recipe'), 'utf8')) });
  else {
    const [a, b] = String(arg('seeds', '1-50')).split('-').map(Number);
    const sets = String(arg('sets', 'all')) === 'all' ? Object.keys(SETS) : String(arg('sets')).split(',');
    jobs.push({ id: 'reference', seed: 'reference' });
    for (const set of sets) for (let s = a; s <= (b || a); s++) jobs.push({ id: `${s}/${set}`, seed: s, set, words: SETS[set] });
  }
  const n = Math.max(1, Math.min(Number(arg('jobs', Math.max(1, Math.min(12, availableParallelism() - 2)))), jobs.length));
  const results = [];
  const t0 = Date.now();
  await new Promise(done => {
    let next = 0, live = 0;
    for (let w = 0; w < n; w++) {
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { placeCheck: true } });
      live++;
      const feed = () => { if (next < jobs.length) worker.postMessage(jobs[next++]); else worker.postMessage(null); };
      worker.on('message', r => {
        results.push(r);
        const failed = r.checks.filter(c => !c.ok);
        if (failed.length) console.log(`FAIL ${r.id} ${JSON.stringify(r.words)}\n  ${failed.map(c => `${c.name}: ${JSON.stringify(c.detail)}`).join('\n  ')}`);
        feed();
      });
      worker.on('exit', () => { if (--live === 0) done(); });
      worker.on('error', e => { console.error(e); });
      feed();
    }
  });
  results.sort((x, y) => jobs.findIndex(j => j.id === x.id) - jobs.findIndex(j => j.id === y.id));
  const passed = results.filter(r => r.ok).length;
  const ref = results.find(r => r.id === 'reference');
  const gen = results.filter(r => r.id !== 'reference');
  const avg = k => Math.round(gen.reduce((s, r) => s + r.timings[k], 0) / Math.max(1, gen.length));
  const summary = {
    schema: 'gf-vista-place-check/1', at: new Date().toISOString(), tool: 'runtimes/vista/tools/place-check.mjs',
    places: results.length, passed, failed: results.length - passed, checksPerPlace: Math.round(results.reduce((s, r) => s + r.checks.length, 0) / Math.max(1, results.length)),
    terrainMs: { reference: ref?.timings.total, generatedMean: avg('total'), generatedMax: Math.max(...gen.map(r => r.timings.total)), note: 'TerrainData.timings.total per place (workers in parallel: compare with the reference measured the same way)' },
    seconds: Math.round((Date.now() - t0) / 1000),
    results: results.map(r => ({ id: r.id, ok: r.ok, words: r.words, failed: r.checks.filter(c => !c.ok).map(c => ({ name: c.name, detail: c.detail })), terrainMs: r.timings.total })),
  };
  if (arg('json')) writeFileSync(arg('json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`${passed}/${results.length} places pass every check (${summary.checksPerPlace} checks each) in ${summary.seconds} s; terrain ms: reference ${summary.terrainMs.reference}, generated mean ${summary.terrainMs.generatedMean}, max ${summary.terrainMs.generatedMax}`);
  process.exit(passed === results.length ? 0 : 1);
}
