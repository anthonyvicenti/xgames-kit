// mechanic: carry (track K2). Grab, carry, drop and throw props (and, optionally, friends). Items belong to the host;
// a player's copy asks and the host decides. README.md has the ownership and the API.
//
//   const carry = ctx.mechanics.get('carry');
//   if (me.actions.interact.pressed) carry.grab(me);       // or let `grabAction` do it for every owned player
//   const it = carry.held(me);                              // { id, prop } while holding something (every copy)
//
// Controls (CONTRACT §6d): near a free item the HUD shows "E: <controls.interact>" (when grabAction is interact), and a
// throw with no direction goes to the thrower's crosshair point (kit/core/aim.js: the arc that lands there).
import * as THREE from 'three';
import { nearestFree, heldBy, canGrab, throwVelocity, stepItem, wallBounce, scatter } from './logic.js';
import { areaOf, physicsOf } from '../../core/util.js';
import { aimTarget, solveLaunch } from '../../core/aim.js';

export const id = 'carry';
export const examples = ['pick up and hold a ball', 'carry crates and throw them', 'grab a friend and toss them'];

const D = { prop: '', count: -1, spawnZone: '', size: 0, color: '#ffc84a', maxHeld: 1, reach: 1.8, grabAction: 'interact', throwAction: '', throwSpeed: 11, throwArc: 0.45, gravity: 16, bounciness: 0.45, holdHeight: 1.0, socket: 'hand_r', grabPlayers: false, maxItems: 24, soundGrab: '', soundThrow: '' };
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    prop: { type: 'string', default: D.prop, description: 'Name of the prop.* slot to carry ("": the first gameplay prop of the game, else a coloured box)' },
    count: { type: 'integer', minimum: -1, maximum: 60, default: D.count, description: 'Items placed at the start (-1: the game prop\'s count; 0: none, rules spawn them)' },
    spawnZone: { type: 'string', default: D.spawnZone, description: 'World zone to scatter the start items in ("": around the play area)' },
    size: { ...num('Item size in metres (0: the game prop\'s size)', 0, 5), default: D.size },
    color: { type: 'string', default: D.color, description: 'Colour of the stand-in box' },
    maxHeld: { type: 'integer', minimum: 1, maximum: 4, default: D.maxHeld, description: 'Items one player can hold' },
    reach: { ...num('How close a player must be to grab (m)', 0.5, 6), default: D.reach },
    grabAction: { type: 'string', enum: ['', 'interact', 'primary', 'secondary'], default: D.grabAction, description: 'Input that grabs (or drops when nothing is in reach); "": the rules call grab()' },
    throwAction: { type: 'string', enum: ['', 'interact', 'primary', 'secondary'], default: D.throwAction, description: 'Input that throws what you hold; "": the rules call throw()' },
    throwSpeed: { ...num('Throw speed (m/s)', 1, 30), default: D.throwSpeed },
    throwArc: { ...num('Upward bias of a throw', 0, 2), default: D.throwArc },
    gravity: { ...num('Gravity on a thrown item', 0, 40), default: D.gravity },
    bounciness: { ...num('Bounce kept on landing', 0, 0.95), default: D.bounciness },
    holdHeight: { ...num('Height (m) above the feet an item is held at when the body has no hand socket', 0, 3), default: D.holdHeight },
    socket: { type: 'string', enum: ['hand_r', 'hand_l', 'head', 'back'], default: D.socket, description: 'Character socket the item is held at' },
    grabPlayers: { type: 'boolean', default: D.grabPlayers, description: 'Nothing in reach: grab the nearest friend instead (they are carried, then thrown)' },
    maxItems: { type: 'integer', minimum: 1, maximum: 40, default: D.maxItems, description: 'Items alive at once (each costs about 30 bytes of the world message)' },
    soundGrab: { type: 'string', default: D.soundGrab, description: 'Sound id when an item is picked up' },
    soundThrow: { type: 'string', default: D.soundThrow, description: 'Sound id when an item is thrown' },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.carry.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : 'gameplay', ...extra });
export const slots = [
  vs('throwSpeed', 'Throw speed', 'number', { tier: 'main', rank: 56, constraints: { min: 1, max: 30, unit: 'm/s' } }),
  vs('reach', 'Grab reach', 'number', { tier: 'main', rank: 52, constraints: { min: 0.5, max: 6, unit: 'm' } }),
  vs('maxHeld', 'Items held at once', 'integer', { rank: 50, constraints: { min: 1, max: 4 } }),
  vs('color', 'Stand-in item colour', 'color', { rank: 30 }),
  vs('prop', 'Carried prop', 'text', { constraints: { maxLength: 40 } }),
  vs('count', 'Items at the start', 'integer', { constraints: { min: -1, max: 60 } }),
  vs('size', 'Item size', 'number', { constraints: { min: 0, max: 5, unit: 'm' } }),
  vs('throwArc', 'Throw arc', 'number', { constraints: { min: 0, max: 2 } }),
  vs('gravity', 'Item gravity', 'number', { constraints: { min: 0, max: 40 } }),
  vs('bounciness', 'Bounciness', 'number', { constraints: { min: 0, max: 0.95 } }),
  vs('holdHeight', 'Hold height without a hand', 'number', { constraints: { min: 0, max: 3, unit: 'm' } }),
  vs('grabPlayers', 'Can grab friends', 'boolean'),
  vs('soundGrab', 'Pick-up sound id', 'text', { constraints: { maxLength: 40 } }),
  vs('soundThrow', 'Throw sound id', 'text', { constraints: { maxLength: 40 } }),
];

const r2 = v => Math.round(v * 100) / 100, r1 = v => Math.round(v * 10) / 10;
const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
function rayFixed(ctx, a, b) {
  const { RAPIER: R, world: W } = physicsOf(ctx);   // ctx.physics is the bare World (K1) or {RAPIER, world}
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.hypot(dx, dy, dz);
  if (!R || !W || d < 1e-6) return null;
  const ray = new R.Ray({ x: a.x, y: a.y, z: a.z }, { x: dx / d, y: dy / d, z: dz / d });
  const h = W.castRayAndGetNormal(ray, d, true, undefined, undefined, undefined, undefined, c => { const p = c.parent(); return !p || p.isFixed(); });
  if (!h) return null;
  const toi = h.timeOfImpact ?? h.toi;
  return { n: [h.normal.x, h.normal.y, h.normal.z], point: { x: a.x + dx / d * toi, y: a.y + dy / d * toi, z: a.z + dz / d * toi } };
}

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.carry.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const gameProp = () => { const list = ctx.config?.props ?? []; return list.find(p => p.name === V('prop')) ?? (V('prop') ? null : list[0]) ?? null; };
  const propName = () => V('prop') || gameProp()?.name || '';
  const itemSize = () => V('size') || gameProp()?.size || 0.5;
  const L = { grab: [], drop: [], throw: [] };
  const root = new THREE.Group(); root.name = 'gf-carry'; ctx.scene.add(root);
  const items = new Map();          // host: id → {id, x,y,z, vx,vy,vz, holder, mode}
  const view = new Map();           // every copy: id → {x,y,z,vx,vy,vz,mode,holder(seat),obj}
  const lastHolder = new Map();
  const carried = new Map();        // host: carrier id → carried player id (grabPlayers)
  const wasHeld = new Set();        // every copy: am I being carried (edge for the controller)
  let S = null, nextId = 1, needSpawn = true, tmpl = null, loading = false, lastList = null, carryTick = 0, promptOn = false;
  const now = () => ctx.time.now;
  const v3 = new THREE.Vector3();
  const player = x => (typeof x === 'string' ? ctx.players.get(x) : x);
  const seatOf = id => ctx.players.get(id)?.seat ?? -1;
  const byBySeat = seat => ctx.players.list().find(p => p.seat === seat) ?? null;

  async function loadTemplate() {
    if (loading) return; loading = true;
    const name = propName();
    try { if (name && ctx.assets.has(`prop.${name}`)) tmpl = await ctx.assets.model(`prop.${name}`, { fit: itemSize() }); } catch (e) { console.warn('carry: prop model failed, drawing a box', e); }
    if (!tmpl) {
      const s = itemSize(), m = ctx.modules?.look?.material?.('prop', { tint: V('color') }) ?? new THREE.MeshStandardMaterial({ color: V('color'), roughness: 0.7 });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), m); mesh.castShadow = true;
      ctx.assets.tag(mesh, 'mechanic.carry.color'); tmpl = mesh;
    }
    loading = false;
  }
  const objFor = () => { if (!tmpl) return null; const o = tmpl.clone(true); root.add(o); return o; };

  // ---------- host ----------
  const live = () => [...items.values()];
  function spawnItem(x, y, z, extra = {}) {
    if (items.size >= V('maxItems')) return null;
    const it = { id: nextId++, x, y, z, vx: 0, vy: 0, vz: 0, holder: '', mode: 'rest', ...extra };
    items.set(it.id, it); return it;
  }
  function hostSpawnStart() {
    needSpawn = false;
    const supplied = (ctx.config?.mechanics ?? []).some(m => m.id === 'pickup');   // a pickup mechanic owns the supply
    const n = V('count') >= 0 ? V('count') : supplied ? 0 : (gameProp()?.count ?? 0);
    if (n <= 0) return;
    const zone = V('spawnZone') && ctx.world.zone?.(V('spawnZone')), A = areaOf(ctx.world);
    const sp = scatter(n, () => ctx.rng(), zone ? { cx: zone.at.x ?? zone.at[0], cz: zone.at.z ?? zone.at[2], hx: Array.isArray(zone.size) ? zone.size[0] / 2 : 3, hz: Array.isArray(zone.size) ? (zone.size[2] ?? zone.size[0]) / 2 : 3, margin: 0.3 }
      : { cx: A.cx, cz: A.cz, hx: A.hx, hz: A.hz, margin: 2.5, keepClear: ctx.world.spawns ? ctx.world.spawns.map(s => ({ x: s.x ?? s[0], z: s.z ?? s[2], r: 2 })) : [] });
    for (const q of sp) spawnItem(q.x, itemSize() / 2, q.z);
  }
  function hostGrab(p) {
    const list = live();
    const g = canGrab(list, p.id, V('maxHeld'));
    const it = g.ok ? nearestFree(list, p.position, V('reach') + 0.6) : null;
    if (it) { it.mode = 'held'; it.holder = p.id; for (const fn of L.grab.slice()) try { fn({ player: p, item: pub(it) }); } catch (e) { console.error(e); } p.act?.('interact', 0.4); return true; }
    if (g.ok && V('grabPlayers') && !carried.has(p.id)) {
      let best = null, bd = V('reach');
      for (const o of ctx.players.list()) { if (o === p || [...carried.values()].includes(o.id) || carried.has(o.id)) continue; const d = Math.hypot(o.position.x - p.position.x, o.position.z - p.position.z); if (d <= bd) { best = o; bd = d; } }
      if (best) { carried.set(p.id, best.id); ctx.net.send('carry:held', { id: best.id, on: 1 }, best.isBot ? 'host' : best.id); setControl(best, false); return true; }
    }
    return false;
  }
  function hostDrop(p, vel = null) {
    const c = carried.get(p.id);
    if (c) { const t = ctx.players.get(c); carried.delete(p.id); if (t) { ctx.net.send('carry:held', { id: t.id, on: 0 }, t.isBot ? 'host' : t.id); setControl(t, true); if (vel) t.knock({ x: vel[0], y: vel[1], z: vel[2] }, 1.2); } return true; }
    const it = heldBy(live(), p.id)[0]; if (!it) return false;
    it.mode = 'fly'; it.holder = '';
    const h = handPos(p, false) ?? { x: p.position.x, y: p.position.y + V('holdHeight'), z: p.position.z };
    it.x = h.x; it.y = h.y; it.z = h.z;
    it.vx = vel ? vel[0] : 0; it.vy = vel ? vel[1] : 0; it.vz = vel ? vel[2] : 0;
    for (const fn of L[vel ? 'throw' : 'drop'].slice()) try { fn({ player: p, item: pub(it) }); } catch (e) { console.error(e); }
    return true;
  }
  const pub = it => ({ id: it.id, prop: propName(), x: it.x, y: it.y, z: it.z });
  function hostThrow(p, d, speed, arc = null) {
    const dir = Array.isArray(d) && d.length === 3 && d.every(Number.isFinite) ? d : (p.aim ?? [0, 0, 1]);
    const v = throwVelocity(dir, Math.min(Math.max(1, speed ?? V('throwSpeed')), 30), arc ?? V('throwArc'));
    if (hostDrop(p, v)) { p.act?.('aim', 0.35); return true; }
    return false;
  }
  function hostSim(dt) {
    const r = itemSize() / 2;
    for (const it of items.values()) {
      if (it.mode === 'fly') {
        const a0 = { x: it.x, y: it.y, z: it.z };
        stepItem(it, dt, { gravity: V('gravity'), radius: r, restitution: V('bounciness') });
        if (it.mode === 'fly') {
          const w = rayFixed(ctx, a0, { x: it.x, y: it.y, z: it.z });
          if (w && Math.abs(w.n[1]) < 0.7) { wallBounce(it, w.n, V('bounciness')); it.x = w.point.x + w.n[0] * r; it.z = w.point.z + w.n[2] * r; }
        }
      }
      if (it.mode === 'held' && !ctx.players.get(it.holder)) { it.mode = 'fly'; it.holder = ''; }   // the holder left
    }
    for (const [cid, tid] of carried) {
      const c = ctx.players.get(cid), t = ctx.players.get(tid);
      if (!c || !t) { carried.delete(cid); if (t) setControl(t, true); continue; }
    }
    if ((carryTick -= dt) <= 0 && carried.size) {
      carryTick = 0.1;
      for (const [cid, tid] of carried) { const c = ctx.players.get(cid), t = ctx.players.get(tid); t.teleport({ x: c.position.x + Math.sin(c.yaw) * 0.2, y: c.position.y + 1.7, z: c.position.z + Math.cos(c.yaw) * 0.2 }, t.yaw); }
    }
  }
  function setControl(p, on) { if (p.owned && p.controller) p.controller.enabled = on && ctx.round?.phase === 'playing'; }

  // ---------- drawing (every copy) ----------
  function handPos(p, fallbackOk = true) {
    const sock = p.character?.socket?.(V('socket'));
    if (sock && sock !== p.character.object3d) { sock.getWorldPosition(v3); return { x: v3.x, y: v3.y, z: v3.z }; }
    if (!fallbackOk) return null;
    return { x: p.position.x + Math.sin(p.yaw) * 0.4, y: p.position.y + V('holdHeight'), z: p.position.z + Math.cos(p.yaw) * 0.4 };
  }
  function placeViews(dt) {
    for (const [id, v] of view) {
      if (!v.obj) { v.obj = objFor(); if (!v.obj) continue; }
      if (v.mode === 'held') { const p = byBySeat(v.holder); if (p) { const h = handPos(p); v.x = h.x; v.y = h.y; v.z = h.z; v.obj.rotation.set(0, p.yaw, 0); } }
      else if (v.mode === 'fly') { v.vy -= V('gravity') * dt; v.x += v.vx * dt; v.y += v.vy * dt; v.z += v.vz * dt; v.obj.rotation.x += dt * 6; v.obj.rotation.z += dt * 4; }
      v.obj.position.set(v.x, v.y, v.z);
    }
  }
  function syncFromSnapshot() {
    const list = S.i; if (list === lastList) return; lastList = list;
    const seen = new Set();
    for (const e of list ?? []) {
      const [id, x, y, z, h, f] = e; seen.add(id);
      let v = view.get(id);
      if (!v) { v = { x, y, z, vx: 0, vy: 0, vz: 0, mode: 'rest', holder: -1, obj: null }; view.set(id, v); }
      v.mode = h >= 0 ? 'held' : f === 1 ? 'fly' : 'rest'; v.holder = h;
      if (v.mode === 'fly') { v.vx = e[6]; v.vy = e[7]; v.vz = e[8]; v.x += (x - v.x) * 0.6; v.y += (y - v.y) * 0.6; v.z += (z - v.z) * 0.6; }
      else if (v.mode === 'rest') { v.x = x; v.y = y; v.z = z; }
    }
    for (const [id, v] of view) if (!seen.has(id)) { v.obj?.removeFromParent(); view.delete(id); }
  }
  function edges() {                  // every copy: sounds on the change of hands
    for (const [id, v] of view) {
      const was = lastHolder.get(id);
      if (was !== undefined && was !== v.holder) {
        const at = { x: v.x, y: v.y, z: v.z };
        if (v.holder >= 0 && V('soundGrab')) ctx.audio?.play(V('soundGrab'), { at, optional: true });
        if (v.holder < 0 && was >= 0 && v.mode === 'fly' && V('soundThrow')) ctx.audio?.play(V('soundThrow'), { at, optional: true });
      }
      lastHolder.set(id, v.holder);
    }
    for (const id of lastHolder.keys()) if (!view.has(id)) lastHolder.delete(id);
  }

  // ---------- input for owned players ----------
  function inputs() {
    const g = V('grabAction'), t = V('throwAction');
    for (const p of ctx.players.owned()) {
      if (p.alive === false || ctx.round?.phase !== 'playing') continue;
      if (t && p.actions?.[t]?.pressed && api.held(p)) api.throw(p);
      else if (g && p.actions?.[g]?.pressed) {
        if (api.held(p) && !(api.heldCount(p) < V('maxHeld') && nearFree(p))) api.drop(p); else api.grab(p);
      }
    }
  }
  const nearFree = p => { const list = ctx.host ? live() : [...view.values()].map(v => ({ ...v, holder: v.mode === 'held' ? 'x' : '' })); return !!nearestFree(list, p.position, V('reach') + 0.2); };

  const api = {
    id, params: P,
    /** Ask to grab the nearest free item in reach (an owned player, or a bot on the host). → true when asked. */
    grab(p) { if (!S || !p || !(p.owned || ctx.host)) return false; if (ctx.host) return hostGrab(p); ctx.net.send('carry:grab', { p: p.id }, 'host'); return true; },
    /** Put down what you hold (or the friend you carry). */
    drop(p) { if (!S || !p || !(p.owned || ctx.host)) return false; if (ctx.host) return hostDrop(p); ctx.net.send('carry:drop', { p: p.id }, 'host'); return true; },
    /** Throw what you hold at your crosshair point (default; the arc that lands there), or along `dir` with the throwArc lob. opts {speed}. */
    throw(p, dir = null, opts = {}) {
      if (!S || !p || !(p.owned || ctx.host)) return false;
      const speed = Math.min(Math.max(1, opts.speed ?? V('throwSpeed')), 30), T = dir ? null : aimTarget(p);
      const from = T ? (handPos(p, false) ?? { x: p.position.x, y: p.position.y + V('holdHeight'), z: p.position.z }) : null;
      const d = T ? solveLaunch(from, T, speed, V('gravity'), { maxTime: 4 }).dir : dir ? (Array.isArray(dir) ? dir : [dir.x, dir.y, dir.z]) : (p.aim ?? [0, 0, 1]);
      if (ctx.host) return hostThrow(p, d, opts.speed, T ? 0 : null);
      ctx.net.send('carry:throw', { p: p.id, d: d.map(v => Math.round(v * 1000) / 1000), ...(T ? { a: 0 } : {}), ...(opts.speed ? { s: opts.speed } : {}) }, 'host'); return true;
    },
    /** An aimed mechanic when it throws on an input (the kit shows the crosshair); an interact one when it grabs on one. */
    get aimed() { return !!V('throwAction'); },
    get interacts() { return !!V('grabAction'); },
    /** What a player can grab (QA, verify check 13): free items, with the grab distance. */
    interactables: () => (V('grabAction') ? api.items().map(i => ({ kind: 'carry', id: `carry:${i.id}`, x: i.x, y: i.y, z: i.z, reach: V('reach'), touch: 0, action: V('grabAction') })) : []),
    /** What this player holds, on any copy: {id, prop} or null. */
    held(p) {
      if (!S || !p) return null;
      const it = ctx.host ? heldBy(live(), p.id)[0] : [...view.entries()].find(([, v]) => v.mode === 'held' && v.holder === p.seat);
      if (!it) return null;
      return ctx.host ? { id: it.id, prop: propName() } : { id: it[0], prop: propName() };
    },
    heldCount(p) { if (!S || !p) return 0; return ctx.host ? heldBy(live(), p.id).length : [...view.values()].filter(v => v.mode === 'held' && v.holder === p.seat).length; },
    /** Host: put a new item straight into a player's hands (e.g. from a pickup). → the item or null */
    give(p, opts = {}) { if (!ctx.host || !S) return null; if (heldBy(live(), p.id).length >= V('maxHeld')) return null; const it = spawnItem(p.position.x, p.position.y + 1, p.position.z, { mode: 'held', holder: p.id }); if (it) for (const fn of L.grab.slice()) try { fn({ player: p, item: pub(it), given: true }); } catch (e) { console.error(e); } return it ? pub(it) : null; },
    /** Remove the item a player holds (thrown by another mechanic, eaten, delivered). From a non-host copy it asks the host. → true */
    consume(p) {
      if (!S || !p) return false;
      if (!ctx.host) { ctx.net.send('carry:consume', { p: p.id }, 'host'); return true; }
      const it = heldBy(live(), p.id)[0]; if (!it) return false; items.delete(it.id); return true;
    },
    /** Host: a new free item lying at pos {x, z, y?}. */
    spawn(pos) { if (!ctx.host || !S) return null; const it = spawnItem(pos.x, pos.y ?? itemSize() / 2, pos.z); return it ? pub(it) : null; },
    /** Host: a new thrown item from `pos` with velocity [x, y, z]. */
    toss(pos, vel) { if (!ctx.host || !S) return null; const it = spawnItem(pos.x, pos.y ?? 1, pos.z, { mode: 'fly', vx: vel[0], vy: vel[1], vz: vel[2] }); return it ? pub(it) : null; },
    /** Free items now (every copy, drawn state): [{id, x, y, z}]. */
    items: () => (ctx.host ? live().filter(i => i.mode !== 'held').map(pub) : [...view].filter(([, v]) => v.mode !== 'held').map(([id, v]) => ({ id, prop: propName(), x: v.x, y: v.y, z: v.z }))),
    /** The nearest free item to pos (for bots). */
    nearest(pos) { const l = api.items(); let b = null, bd = Infinity; for (const i of l) { const d = Math.hypot(i.x - pos.x, i.z - pos.z); if (d < bd) { b = i; bd = d; } } return b; },
    /** Host: {player, item} on a grab / a drop / a throw. → unsubscribe */
    onGrab(fn) { L.grab.push(fn); return unsub(L.grab, fn); },
    onDrop(fn) { L.drop.push(fn); return unsub(L.drop, fn); },
    onThrow(fn) { L.throw.push(fn); return unsub(L.throw, fn); },
    reset() { items.clear(); view.forEach(v => v.obj?.removeFromParent()); view.clear(); lastList = null; lastHolder.clear(); carried.clear(); needSpawn = true; },
    update(dt) {
      if (!S) { if (!(ctx.shared && ctx.players && ctx.me)) return; S = ctx.shared.register('carry', { i: [], cp: {} }); loadTemplate(); }
      if (!tmpl && !loading) loadTemplate();
      if (ctx.host) {
        if (needSpawn) hostSpawnStart();
        if (ctx.round?.phase === 'playing') { inputs(); hostSim(Math.min(dt, 0.05)); }
        S.i = live().map(it => { const h = it.mode === 'held' ? seatOf(it.holder) : -1; const e = [it.id, r2(it.x), r2(it.y), r2(it.z), h, it.mode === 'fly' ? 1 : 0]; if (it.mode === 'fly') e.push(r1(it.vx), r1(it.vy), r1(it.vz)); return e; });
        S.cp = Object.fromEntries(carried);
        // the host draws from its own items
        const seen = new Set();
        for (const it of items.values()) { seen.add(it.id); let v = view.get(it.id); if (!v) { v = { obj: null }; view.set(it.id, v); } v.x = it.x; v.y = it.y; v.z = it.z; v.mode = it.mode; v.holder = it.mode === 'held' ? seatOf(it.holder) : -1; }
        for (const [k, v] of view) if (!seen.has(k)) { v.obj?.removeFromParent(); view.delete(k); }
      } else { syncFromSnapshot(); if (ctx.round?.phase === 'playing') inputs(); }
      // being carried: a copy that owns the carried player holds their controls off (an edge)
      for (const p of ctx.players.owned()) {
        const heldNow = Object.values(S.cp ?? {}).includes(p.id);
        if (heldNow !== wasHeld.has(p.id)) { heldNow ? wasHeld.add(p.id) : wasHeld.delete(p.id); setControl(p, !heldNow); }
      }
      if (ctx.host) placeViewsHost(dt); else placeViews(dt);
      edges();
      // the hint: a free item within reach of the local player, who could hold one more
      const me = ctx.me, g = V('grabAction');
      if (g && ctx.ui?.prompt && me) {
        const near = ctx.round?.phase === 'playing' && me.alive !== false && api.heldCount(me) < V('maxHeld') && nearFree(me);
        if (near !== promptOn) { promptOn = near; ctx.ui.prompt(near ? `${g === 'interact' ? 'E' : g === 'primary' ? 'Click' : 'Right click'}: ${ctx.config?.controls?.[g] ?? 'pick up'}` : null, 'carry'); }
      }
    },
    event(name, d, from) {
      if (name === 'held') { const p = ctx.players.get(d?.id); if (p?.owned) setControl(p, !d.on); return; }
      if (!ctx.host || !S) return;
      const p = ctx.players.get(d?.p); if (!p || p.isBot || (ctx.net.active && from !== undefined && from !== p.id)) return;
      if (name === 'grab') hostGrab(p); else if (name === 'drop') hostDrop(p);
      else if (name === 'throw') hostThrow(p, d.d, Number.isFinite(d.s) ? d.s : undefined, d.a === 0 ? 0 : null);
      else if (name === 'consume') { const it = heldBy(live(), p.id)[0]; if (it) items.delete(it.id); }
    },
    dispose() { root.removeFromParent(); },
  };
  function placeViewsHost(dt) {
    for (const [id, v] of view) {
      if (!v.obj) { v.obj = objFor(); if (!v.obj) continue; }
      if (v.mode === 'held') { const p = byBySeat(v.holder); if (p) { const h = handPos(p); v.x = h.x; v.y = h.y; v.z = h.z; v.obj.rotation.set(0, p.yaw, 0); } }
      else if (v.mode === 'fly') { v.obj.rotation.x += dt * 6; v.obj.rotation.z += dt * 4; }
      v.obj.position.set(v.x, v.y, v.z);
    }
  }
  return api;
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs MANIFEST lists the fields): what `create` composes and refuses by, what the
// catalog tells a pitch, the handlers and traps of the rules.js stub, and verify check 15's sign of life. The tools
// read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, examples, params,
  describe: 'Grab, carry and throw props or players',
  rank: 50,
  needs: { parts: [], world: [] },
  uses: ['pickup', 'projectile'],
  // its thing (kit/assets/items.js): the one kind of thing players carry and throw, the mechanic's own params
  items: [{ single: true, noun: 'thing to carry', fields: ['throwSpeed', 'reach', 'maxHeld', 'count', 'size', 'throwArc', 'bounciness', 'color'], front: ['throwSpeed', 'count', 'maxHeld'],
    picture: (p, game) => { const n = p.prop || (game?.props ?? [])[0]?.name; return n ? `prop.${n}` : 'mechanic.carry.color'; } }],
  owns: p => [
    { res: `player.socket.${p.socket}`, why: `the held item sits on the ${p.socket} socket (params.socket)`, free: 'set carry params.socket to another socket (hand_l, head, back)' },
    ...(p.grabAction ? [{ res: `input.${p.grabAction}`, shared: true, why: `${p.grabAction} grabs an item in reach (params.grabAction)`, free: 'set carry params.grabAction to "" and call carry.grab(p) from rules.js' }] : []),
    ...(p.throwAction ? [{ res: `input.${p.throwAction}`, why: `${p.throwAction} throws what is held (params.throwAction)`, free: 'set carry params.throwAction to "" and call carry.throw(p) from rules.js' }] : []),
    ...(p.grabPlayers ? [{ res: 'player.control', why: 'a carried friend\'s controls are held off (params.grabPlayers)', free: 'set carry params.grabPlayers to false' }] : []),
  ],
  state: { key: 'carry', fields: { i: '[[id, x, y, z, holderSeat | -1, flying, vx, vy, vz]] per item', cp: '{ carrierId: carriedPlayerId }' } },
  events: [
    { name: 'onGrab', on: 'host', args: '{ player, item: { id, prop } }', when: 'a player picked an item up (or was given one)' },
    { name: 'onDrop', on: 'host', args: '{ player, item }', when: 'a player put an item down' },
    { name: 'onThrow', on: 'host', args: '{ player, item }', when: 'a player threw what they held' },
  ],
  sync: { owner: 'host', how: 'the host owns every item and who holds it; a copy asks' },
  note: [
    'interact (E) grabs an item in reach and drops it when nothing is in reach; throwing is the rules\' unless throwAction is set.',
    'carry.held(p) says what a player holds on every copy; the pickup mechanic (effect auto) hands out carried items.',
    'To throw the held thing as a shot: prj.fire(p) then carry.consume(p).',
  ],
  stub: {
    as: 'carry',
    worked: 'update(ctx) { const me = ctx.me; if (me.actions.primary.pressed && carry.held(me)) carry.throw(me); }',
    traps: [
      'carry.throw(p) with no direction goes to the crosshair point: pass a direction only for bots and the top camera',
      'bots grab only when the rules make them: in bot(ctx, p) seek carry.nearest(p.position) and call carry.grab(p)',
    ],
  },
  signs: {
    sample: sh => (sh.carry ? { carry: (sh.carry.i ?? []).map(e => e[4]) } : null),
    judge: v => {
      const ok = v.others.carried;
      v.add('an item is held', ok ? 'ok' : 'dead', 'shared.carry.i[…][4]', ok ? 'yes' : `nobody picked an item up on any page (${v.names})`, ok ? '' : 'make bots grab items (rules.bot) and check carry grabAction and reach');
    },
  },
};
