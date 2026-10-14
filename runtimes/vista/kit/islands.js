// gf-vista's islands (research/super-scenic/WAVE3_PLACES.md, track H): a game of 1 to 5 islands to sail between. The
// creator, 2026-10-12, on Keys to the Cove: "we should work on unique setting every time. No island hop as well".
//
//   const trip = createTrip(app, islands, { words, decides, ask, seat, gate, emit })   (kit/game.js makes it)
//     islands   [recipe | { name, recipe } | { name, seed, words }]: island 0 is the one the core booted with
//     decides() true on the copy that owns the shared world (the host, or alone): it starts a hop; a joiner asks
//     ask(to)   a joiner's request to the host (sent at most every 2 s while its own gate passes)
//     seat()    this copy's seat (0-based): where its player stands aboard on arrival
//     gate(to, info) → true | false | 'why' | { ok, why }: the game's own condition (rules.js: "buy the boat keys first")
//     emit(name, data)  'hop-start' { from, to } and 'hop-done' { from, to, ms } (and 'hop-refused' { to, why })
//   trip.update(dt)        once a frame: the silhouettes' distances, the sail-out check, the curtain
//   trip.canHop(i) → { ok, why }      trip.hop(i, { force }) → Promise<{ ok, why?, ms? }>     trip.follow(i, serial)
//   trip.state() → { index, count, name, names, next: { index, name, distance } | null, refused, trip, visited }
//   trip.shared() → { i, s }: what the host's world message carries (the island, and a hop's serial number)
//
// The chart: island k + 1 lies LEG metres from island k, out of island k's harbour (the bearing its bay faces), turned
// round until no two islands are closer than 0.8 LEG. From island k every other island shows on the horizon where the
// chart puts it, as a far silhouette: a low-poly mesh of the recipe's own height function (TerrainData.probe, the
// same generator as the island, sampled coarsely), in the core's scene, lit by the same sky and hazed by the same air.
//
// The trip (the default gate): at the boat's helm, past the island's reach (its coast plus REACH_MARGIN), sailing
// toward an island. Then the screen eases out (a sea-spray curtain, FADE_MS), the core rebuilds the next island (core
// patch #7, App.rebuildPlace), the players arrive aboard the boat moored at its dock, and the curtain lifts.
import { BufferGeometry, Float32BufferAttribute, Mesh, Vector3 } from '../core/src/engine/index.js';
import { standard } from '../core/src/materials/Materials.js';
import { TerrainData } from '../core/src/world/TerrainData.js';
import { layoutFromRecipe } from '../core/src/world/Place.js';
import { placeRecipe, placeSeats } from './world/places.js';

export const MAX_ISLANDS = 5;
export const LEG = 3200;            // m between neighbouring islands on the chart
export const REACH_MARGIN = 380;    // m of sea past an island's coast before the open sea (where a trip can start)
export const FADE_MS = 1000;
const TOWARD = Math.cos(32 * Math.PI / 180);   // the boat heads within 32° of the island
const MIN_SPEED = 1.5;                          // m/s, moving ahead
const GRID = 80;                                // silhouette resolution (vertices a side)
// where each seat stands aboard on arrival, in the boat's frame (z forward, the cockpit from the transom at -3.9 to the
// wheelhouse at -0.7), and which way: 'aft' faces the island (the boat lies bow to the sea) and the friends at the
// transom; 'fwd' faces the friends by the wheelhouse. 2.6 m apart: near enough to talk, far enough to be in view
const DECK = [{ x: 0.3, z: -0.95, face: 'aft' }, { x: -0.45, z: -3.5, face: 'fwd' }, { x: 0.55, z: -3.5, face: 'fwd' }, { x: -0.5, z: -0.95, face: 'aft' }];

export const WORDS = {
  island: 'Island {n} of {count}',
  toward: '{name} · {distance}',
  sailing: 'Sailing to {name}…',
  arrived: '{name}',
  hopHelm: 'Take the helm to sail to {name}',
  hopReach: 'Sail out past the reef to reach {name}',
  hopSteer: 'Steer toward {name}',
  hopBusy: 'Already under way',
  hopNone: 'No island there',
  hopHere: 'You are at {name}',
  hopAsked: 'Waiting for the host to set sail…',
};
const fmt = (s, o = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in o ? o[k] : m));
const km = m => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

/** [{ name, recipe }] from what a game lists (1 to MAX_ISLANDS; recipes, { name, recipe } or { name, seed, words }). */
export function normalizeIslands(list = []) {
  const arr = (Array.isArray(list) ? list : [list]).filter(Boolean).slice(0, MAX_ISLANDS);
  return arr.map((it, i) => {
    const recipe = it.schema ? it : it.recipe ?? (it.seed != null ? placeRecipe(it.seed, it.words ?? {}) : null);
    if (!recipe) throw new Error(`islands[${i}]: a place recipe, { name, recipe } or { name, seed, words }`);
    return { name: String(it.name ?? recipe.title ?? `Island ${i + 1}`), recipe };
  });
}

/** An island's middle and size in the world (its massif's ellipses: the land and its islets). */
export function islandExtent(recipe) {
  const E = recipe.massif?.length ? recipe.massif : [recipe.coast?.body ?? [0, -442, 565, 400]];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [cx, cz, rx, rz] of E) { x0 = Math.min(x0, cx - rx); x1 = Math.max(x1, cx + rx); z0 = Math.min(z0, cz - rz); z1 = Math.max(z1, cz + rz); }
  const [bx, bz, brx, brz] = recipe.coast?.body ?? E[0];
  return { cx: bx, cz: bz, r: Math.max(brx, brz), box: [x0, x1, z0, z1] };
}

/** Each island's place on the chart (metres, x east, z south), island 0 at the origin. */
export function chart(islands) {
  const P = [[0, 0]];
  for (let k = 1; k < islands.length; k++) {
    const facing = Number(islands[k - 1].recipe.facing ?? 180);
    let best = null;
    for (let t = 0; t < 9; t++) {
      const b = (facing + [0, 40, -40, 80, -80, 120, -120, 160, -160][t]) * Math.PI / 180;
      const p = [P[k - 1][0] + Math.sin(b) * LEG, P[k - 1][1] - Math.cos(b) * LEG];
      if (P.every(q => Math.hypot(q[0] - p[0], q[1] - p[1]) >= LEG * 0.8)) { best = p; break; }
      best ??= p;
    }
    P.push(best);
  }
  return P;
}

/** A far island's mesh geometry, in its own frame (its middle at the origin), from the recipe's height function. */
export function silhouetteGeometry(recipe, n = GRID) {
  const probe = TerrainData.probe(layoutFromRecipe(recipe));
  const ext = islandExtent(recipe), [x0, x1, z0, z1] = ext.box, pad = 60;
  const ax = x0 - pad, az = z0 - pad, sx = (x1 - x0 + 2 * pad) / (n - 1), sz = (z1 - z0 + 2 * pad) / (n - 1);
  const pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 4), H = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) H[j * n + i] = probe.heightFn(ax + i * sx, az + j * sz).h;
  const nat = recipe.nature ?? {}, sand = nat.sand ?? [1, 1, 1], rock = nat.rock ?? [1, 1, 1];
  const veg = recipe.words?.vegetation === 'scrub' ? [0.36, 0.34, 0.2] : recipe.words?.vegetation === 'cliffs' ? [0.3, 0.36, 0.22] : [0.16, 0.27, 0.12];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, h = H[k];
    pos.set([ax + i * sx - ext.cx, Math.max(h, -6), az + j * sz - ext.cz], k * 3);
    const gx = (H[j * n + Math.min(n - 1, i + 1)] - H[j * n + Math.max(0, i - 1)]) / (2 * sx), gz = (H[Math.min(n - 1, j + 1) * n + i] - H[Math.max(0, j - 1) * n + i]) / (2 * sz);
    const steep = Math.min(1, Math.hypot(gx, gz) * 1.4);
    const beach = h < 2.5 ? 1 : 0;
    // land seen from kilometres off is dark under its haze: the albedo of wet sand and forest, never the sand's own white
    const c = (beach ? [0.42 * sand[0], 0.4 * sand[1], 0.34 * sand[2]] : [0, 1, 2].map(q => veg[q] * (1 - steep) + 0.22 * Math.min(1, rock[q]) * steep)).map(v => v * 0.8);
    col.set([...c, 1], k * 4);
  }
  const idx = [];
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    if (Math.max(H[a], H[b], H[c], H[d]) < -4) continue;   // open sea: no triangles
    idx.push(a, c, b, b, c, d);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere?.();
  return g;
}

let sharedMaterial = null;
const farMaterial = () => (sharedMaterial ??= standard({ name: 'farIsland', vertexColors: true, roughness: 0.95, metalness: 0 }));

/** The sea-spray curtain: eases the screen out and in (CSS only, over everything but the shared menu). */
function curtain() {
  if (typeof document === 'undefined') return { close: async () => {}, open: async () => {}, text() {}, remove() {}, el: null };
  const el = document.createElement('div');
  el.id = 'gf-vista-curtain';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = `position:fixed;inset:0;z-index:60;pointer-events:none;opacity:0;transition:opacity ${FADE_MS}ms ease-in-out;display:flex;align-items:center;justify-content:center;`
    + 'background:radial-gradient(ellipse at 30% 70%,#ffffffee 0%,#e8f6f8dd 30%,transparent 62%),radial-gradient(ellipse at 75% 30%,#ffffffdd 0%,#d4eef2cc 28%,transparent 60%),linear-gradient(180deg,#bfe3ea 0%,#e9f6f6 45%,#a9d3dc 100%);'
    + 'font:600 clamp(18px,2.4vw,30px)/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#24505e;letter-spacing:.02em;text-shadow:0 1px 0 #fff8';
  const label = document.createElement('span');
  el.append(label);
  document.body.append(el);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return {
    el,
    text(t) { label.textContent = t ?? ''; },
    async close() { el.style.opacity = '1'; await wait(FADE_MS + 40); await frames(); },
    async open() { await frames(); el.style.opacity = '0'; await wait(FADE_MS); },
    remove() { el.remove(); },
  };
}

export function createTrip(app, list, { words = {}, decides = () => true, ask = null, seat = () => 0, gate = null, emit = () => {}, arrive = 'aboard' } = {}) {
  const W = { ...WORDS, ...words };
  const islands = normalizeIslands(list);
  const P = chart(islands);
  const ext = islands.map(it => islandExtent(it.recipe));
  let index = 0, serial = 0, phase = null, trip = null, refused = null, next = null, lastAsk = 0, rulesGate = gate;
  const visited = new Set([0]);
  const curt = curtain();
  const far = new Map();   // island → { mesh, geometry }

  /** Where island j's middle is in this world while island `index` is the one built. */
  const worldOf = j => [ext[index].cx + P[j][0] - P[index][0], ext[index].cz + P[j][1] - P[index][1]];
  function placeSilhouettes() {
    for (let j = 0; j < islands.length; j++) {
      let f = far.get(j);
      if (j === index) { if (f) f.mesh.visible = false; continue; }
      if (!f) {
        const geometry = silhouetteGeometry(islands[j].recipe);
        const mesh = new Mesh(geometry, farMaterial());
        mesh.name = 'FarIsland:' + j;
        mesh.userData.gfSlot = `world.island.${j + 1}.words`;   // drawn from that island's words (kit/coverage.js reads the tag)
        mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = false;
        app.scene.add(mesh);
        far.set(j, f = { mesh, geometry });
      }
      const [x, z] = worldOf(j);
      f.mesh.position.set(x, 0, z);
      f.mesh.visible = true;
      f.mesh.updateMatrixWorld?.(true);
    }
  }
  if (islands.length > 1) placeSilhouettes();

  const reach = () => ext[index].r + REACH_MARGIN;
  const boatState = () => {
    const b = app.boatCtl, f = b.forward(new Vector3());
    const v = b.velocity, speed = v.x * f.x + v.z * f.z;
    const l = Math.hypot(f.x, f.z) || 1;
    return { x: b.position.x, z: b.position.z, fx: f.x / l, fz: f.z / l, speed };
  };
  /** Each other island from the boat (or the walker): its distance to the coast, and how straight ahead it lies. */
  function bearings() {
    const p = app.player.mode === 'boat' || app.player.mode === 'deck' ? app.boatCtl.position : app.player.position;
    const b = boatState();
    return islands.map((it, j) => {
      if (j === index) return null;
      const [x, z] = worldOf(j), dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz) || 1;
      return { index: j, name: it.name, distance: Math.max(0, d - ext[j].r), ahead: (dx * b.fx + dz * b.fz) / d };
    }).filter(Boolean);
  }
  const out = (ok, why = null) => (ok ? { ok: true } : { ok: false, why });
  function normalize(r, to) {
    if (r === undefined || r === null || r === true) return out(true);
    if (r === false) return out(false, fmt(W.hopNone, { name: islands[to]?.name ?? '' }));
    if (typeof r === 'string') return out(false, r);
    return r.ok === false ? out(false, String(r.why ?? '')) : out(true);
  }
  /** The default trip gate (at the helm, out past the reach, heading for it), then the game's own. */
  function canHop(to, { trip: withTrip = true, info = {} } = {}) {
    to = Number(to);
    if (!Number.isInteger(to) || to < 0 || to >= islands.length) return out(false, W.hopNone);
    const name = islands[to].name;
    if (to === index) return out(false, fmt(W.hopHere, { name }));
    if (phase) return out(false, W.hopBusy);
    if (withTrip) {
      if (app.player.mode !== 'boat') return out(false, fmt(W.hopHelm, { name }));
      const b = boatState();
      if (Math.hypot(b.x - ext[index].cx, b.z - ext[index].cz) < reach()) return out(false, fmt(W.hopReach, { name }));
      const [x, z] = worldOf(to), d = Math.hypot(x - b.x, z - b.z) || 1;
      if ((x - b.x) / d * b.fx + (z - b.z) / d * b.fz < TOWARD || b.speed < MIN_SPEED) return out(false, fmt(W.hopSteer, { name }));
    }
    if (rulesGate) {
      try { return normalize(rulesGate(to, { from: index, name, ...info }), to); } catch (e) { console.error('vista islands: the gate failed', e); return out(false, String(e.message ?? e)); }
    }
    return out(true);
  }

  async function travel(to, by) {
    const from = index, t0 = performance.now();
    phase = 'out'; trip = { from, to, by: by ?? null, phase };
    serial++;
    refused = null;
    emit('hop-start', { from, to, name: islands[to].name, by: by ?? null });
    curt.text(fmt(W.sailing, { name: islands[to].name }));
    try {
      await curt.close();
      phase = trip.phase = 'build';
      const r = await app.rebuildPlace(islands[to].recipe);
      index = to;
      visited.add(to);
      arriveAt(to);
      placeSilhouettes();
      phase = trip.phase = 'in';
      curt.text(fmt(W.arrived, { name: islands[to].name }));
      await curt.open();
      const ms = Math.round(performance.now() - t0);
      const done = { from, to, name: islands[to].name, ms, rebuild: r };
      phase = null; trip = null;
      emit('hop-done', done);
      return { ok: true, ms, rebuild: r };
    } catch (e) {
      console.error('vista islands: the hop failed', e);
      phase = null; trip = null;
      await curt.open().catch(() => {});
      return { ok: false, why: String(e.message ?? e) };
    }
  }

  /** This copy's player at the new island: aboard the moored boat (the seat's spot), or at a start place's seat. */
  function arriveAt(to) {
    const p = app.player, s = Math.max(0, seat() | 0);
    if (app.freeCam) app.setFreeCam?.(false);
    if (p.mode === 'boat') p.leaveHelm();   // the engine stops, the helm is let go
    const b = app.boatCtl;
    b.driven = false; b.throttle = 0; b.steer = 0;
    if (arrive === 'aboard') {
      p.mode = 'walk';
      p.velocity?.set?.(0, 0, 0);
      p.boardBoat();
      const d = DECK[s % DECK.length], ring = Math.floor(s / DECK.length) * 0.35;
      p.deckPos.set(d.x + (d.x >= 0 ? ring : -ring), p.deckPos.y, d.z);
      p.deckYaw = d.face === 'aft' ? Math.PI : 0;
      p.pitch = -0.04;
      p.deckToWorld();
      return;
    }
    const seats = placeSeats(islands[to].recipe)[arrive] ?? placeSeats(islands[to].recipe).pier;
    const at = seats[s % seats.length];
    p.mode = 'walk';
    p.velocity?.set?.(0, 0, 0);
    p.position.set(at.x, Math.max(app.terrainData.heightAt(at.x, at.z), app.colliders.groundHeightAt(at.x, at.z, 50)), at.z);
    p.yaw = at.yaw; p.pitch = -0.05; p.grounded = false;
  }

  const api = {
    islands, chart: P, words: W,
    get index() { return index; },
    get busy() { return !!phase; },
    canHop: (to, o) => canHop(to, o),
    /** Start a hop: the trip gate and the game's gate must pass (force: the game's gate only). */
    async hop(to, { force = false, by = null } = {}) {
      const c = canHop(to, { trip: !force, info: { by } });
      if (!c.ok) { emit('hop-refused', { to: Number(to), why: c.why }); return c; }
      return travel(Number(to), by);
    },
    /** A joiner's copy follows the host's world (the host decided: no gate here). serial: the host's hop number. */
    follow(to, s = null) {
      to = Number(to);
      if (phase || !Number.isInteger(to) || to < 0 || to >= islands.length || to === index) return false;
      if (s !== null) serial = Math.max(serial, s - 1);
      travel(to, 'host');
      return true;
    },
    setGate(fn) { rulesGate = typeof fn === 'function' ? fn : null; },
    shared: () => ({ i: trip ? trip.to : index, s: serial }),
    update() {
      if (islands.length < 2) return;
      const list = bearings();
      // aboard: the island the bow points at; ashore: the next one on the chart
      const aboard = app.player.mode === 'boat' || app.player.mode === 'deck';
      next = !list.length ? null : aboard ? [...list].sort((a, b) => (b.ahead - a.ahead) || (a.distance - b.distance))[0] : list.find(x => x.index === (index + 1) % islands.length) ?? list[0];
      if (phase) return;
      // the trip: out past the reach at the helm, sailing toward an island
      const b = boatState();
      const atSea = app.player.mode === 'boat' && Math.hypot(b.x - ext[index].cx, b.z - ext[index].cz) >= reach() && b.speed >= MIN_SPEED;
      if (!atSea || !next || next.ahead < TOWARD) { refused = null; return; }
      const c = canHop(next.index);
      if (!c.ok) { if (refused?.why !== c.why) emit('hop-refused', { to: next.index, why: c.why }); refused = { to: next.index, name: next.name, why: c.why }; return; }
      if (decides()) { travel(next.index, 'me'); return; }
      refused = { to: next.index, name: next.name, why: W.hopAsked, asked: true };
      const now = performance.now();
      if (ask && now - lastAsk > 2000) { lastAsk = now; ask(next.index); }
    },
    state() {
      const it = islands[index];
      return {
        index, count: islands.length, name: it.name, names: islands.map(x => x.name),
        label: fmt(W.island, { n: index + 1, count: islands.length }),
        next: next ? { index: next.index, name: next.name, distance: Math.round(next.distance), text: fmt(W.toward, { name: next.name, distance: km(next.distance) }) } : null,
        refused: refused ? { ...refused } : null,
        trip: trip ? { ...trip } : null,
        visited: [...visited].sort((a, b) => a - b),
        reach: Math.round(reach()),
      };
    },
    /** The silhouettes (QA): where each other island shows from here. */
    silhouettes: () => [...far.entries()].map(([j, f]) => ({ index: j, name: islands[j].name, x: Math.round(f.mesh.position.x), z: Math.round(f.mesh.position.z), visible: f.mesh.visible })),
    /** QA: where island j shows from here (world x, z). */
    worldOf,
    dispose() {
      for (const f of far.values()) { app.scene.remove(f.mesh); f.geometry.dispose(); }
      far.clear();
      curt.remove();
    },
  };
  return api;
}
