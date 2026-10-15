// mechanic: aim. A ballistic aim any game can use: hold primary to charge the power, release to fire; the view's pitch
// sets the elevation; the wind (per turn or per round, on the HUD's wind strip) pushes every shell; a trajectory preview
// shows where it goes; weapons are data (speed, gravity, wind, a fuse and bounces, the blast), picked on the HUD's weapon
// wheel (secondary, or the number keys). A shell is the host's; where it ends it blasts: the knockback mechanic throws
// whoever is near, the carve mechanic bites the ground, the effect style draws the blast, ctx.juice shakes.
// README.md has the network ownership and the API.
//
// In a `turns` game it joins the flow (ctx.turns.drive): only the current player aims and the others hold still, the
// camera follows the shot on every screen, and the turn passes once the shell has gone off and everyone thrown has come
// to rest. In a real-time game each player fires on a cooldown.
//
//   const aim = ctx.mechanics.get('aim');
//   aim.onExplode(e => ...)          host: {shooter, at, weapon, thrown}
//   bot(ctx, p) { ctx.mechanics.get('aim').bot(p); }      // rules.bot: the part aims and fires for bots
import * as THREE from 'three';
import { launchDir, shellStep, predictPath, chargeAt, windFor, windAlong, solveShot, weaponsOf } from './logic.js';
import { physicsOf } from '../../core/util.js';

export const id = 'aim';
export const examples = ['turn-based artillery: angle, power and wind', 'lob grenades that bounce before they blow', 'pick a weapon from a wheel, fire, watch it fly'];

const WEAPONS = [
  { id: 'rocket', label: 'Rocket', icon: '🚀', speed: 32, gravity: 1, wind: 1, radius: 3.2, force: 17, damage: 30, crater: 1, color: '#e2553a' },
  { id: 'grenade', label: 'Grenade', icon: '💣', speed: 24, gravity: 1, wind: 0.2, fuse: 3, bounces: 8, restitution: 0.45, radius: 3, force: 16, damage: 30, crater: 1, color: '#3d5a2c' },
  { id: 'big-bomb', label: 'Big bomb', icon: '💥', speed: 26, gravity: 1.15, wind: 0.6, radius: 5, force: 24, damage: 50, crater: 1.35, ammo: 1, size: 0.34, color: '#2a2a33' },
];
const D = {
  weapons: WEAPONS, start: '', chargeSeconds: 1.3, charge: 'clamp', minPower: 0.12, gravity: 18, angleLift: 32, minAngle: -10, maxAngle: 85,
  wind: 5, windPer: 'turn', preview: 'full', previewSeconds: 1.1, previewColor: '#ffffff', cooldown: 1.2, follow: 'turns', shotsPerTurn: 1,
  holdOthers: true, settleSeconds: 1, lifetime: 12, carveScale: 0.85, botError: 0.12, botThink: 0.9, hud: true,
  explodeFx: '', splashFx: '', soundFire: 'throw', soundBoom: '', soundSplash: '', textCharge: 'Hold to charge, release to fire',
};
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum, d) => ({ type: 'number', description, minimum, maximum, default: d });
const str = (description, d) => ({ type: 'string', default: d, description });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    weapons: { type: 'array', default: WEAPONS, description: 'The weapons, each data: {id, label, icon, speed (m/s at full power), gravity (× the part\'s), wind (× the wind), fuse (s; 0 goes off where it lands), bounces, restitution, radius (blast m), force (throw m/s), damage, crater (× the radius), ammo (-1: unlimited), size, color, prop}', items: { type: 'object', required: ['id'] } },
    start: str('The weapon each player starts with ("": the first)', D.start),
    chargeSeconds: num('Seconds from no power to full while primary is held', 0.2, 6, D.chargeSeconds),
    charge: { type: 'string', enum: ['clamp', 'swing'], default: D.charge, description: 'Full power holds (clamp) or swings back down (swing)' },
    minPower: num('Power of a tap', 0, 0.9, D.minPower),
    gravity: num('Gravity on a shell (m/s², × each weapon\'s)', 1, 60, D.gravity),
    angleLift: num('Degrees the shot leaves above where the view looks', -30, 80, D.angleLift),
    minAngle: num('Lowest elevation (degrees)', -60, 60, D.minAngle),
    maxAngle: num('Highest elevation (degrees)', 0, 89, D.maxAngle),
    wind: num('Strongest wind (m/s² sideways on a shell; 0: none)', 0, 20, D.wind),
    windPer: { type: 'string', enum: ['turn', 'round', 'shot'], default: D.windPer, description: 'When the wind changes' },
    preview: { type: 'string', enum: ['full', 'short', 'none'], default: D.preview, description: 'The trajectory preview: the whole arc, its start (previewSeconds), or none' },
    previewSeconds: num('Seconds of flight a short preview shows', 0.2, 6, D.previewSeconds),
    previewColor: { type: 'string', default: D.previewColor, description: 'Colour of the preview dots' },
    cooldown: num('Seconds between one player\'s shots (real-time games)', 0, 20, D.cooldown),
    follow: { type: 'string', enum: ['turns', 'own', 'all', 'none'], default: D.follow, description: 'Whose shots the camera follows: in turn games (turns), your own, everyone\'s, none' },
    shotsPerTurn: { type: 'integer', minimum: 1, maximum: 5, default: D.shotsPerTurn, description: 'Shots a player fires on a turn' },
    holdOthers: { type: 'boolean', default: D.holdOthers, description: 'In a turn game the players whose turn it is not hold still' },
    settleSeconds: num('Seconds after everything has come to rest before the turn passes', 0, 6, D.settleSeconds),
    lifetime: num('Seconds before a shell that never lands is gone', 2, 30, D.lifetime),
    carveScale: num('Crater radius per metre of blast (with the carve mechanic)', 0, 3, D.carveScale),
    botError: num('How far a bot\'s aim is off (0 perfect, 0.3 wild)', 0, 0.6, D.botError),
    botThink: num('Seconds a bot thinks before it aims', 0, 6, D.botThink),
    hud: { type: 'boolean', default: D.hud, description: 'The angle, power and wind dials and the weapon wheel on the kit HUD' },
    explodeFx: str('A vfx preset at each blast as well as the effect style\'s (blast-puffs, fireball, ...); unset: the style alone', D.explodeFx),
    splashFx: str('A vfx preset where a shell lands in the water (water-splash); unset: none', D.splashFx),
    soundFire: str('Sound id when a shell leaves', D.soundFire),
    soundBoom: str('Sound id at a blast', D.soundBoom),
    soundSplash: str('Sound id when a shell lands in the water', D.soundSplash),
    textCharge: str('The hint on the first turn', D.textCharge),
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.aim.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: 'gameplay', ...extra });
export const slots = [
  vs('wind', 'Strongest wind', 'number', { tier: 'main', rank: 66, constraints: { min: 0, max: 20 } }),
  vs('chargeSeconds', 'Seconds to full power', 'number', { tier: 'main', rank: 62, constraints: { min: 0.2, max: 6, unit: 's' } }),
  vs('preview', 'Trajectory preview', 'text', { tier: 'main', rank: 60, constraints: { enum: ['full', 'short', 'none'] } }),
  vs('gravity', 'Shell gravity', 'number', { constraints: { min: 1, max: 60 } }),
  vs('angleLift', 'Shot above the view (degrees)', 'number', { constraints: { min: -30, max: 80 } }),
  vs('cooldown', 'Time between shots', 'number', { constraints: { min: 0, max: 20, unit: 's' } }),
  vs('botError', 'Bot aim error', 'number', { constraints: { min: 0, max: 0.6 } }),
  vs('previewColor', 'Preview colour', 'color', { facet: 'look' }),
];

const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.aim.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const weapons = () => { const w = weaponsOf(V('weapons')); return w.length ? w : weaponsOf(WEAPONS); };
  const L = { fire: [], explode: [], turnDone: [] };
  const shells = new Map();         // host: {id, shooter, w (weapon), x..vz, age, bounces, fuse}
  const view = new Map();           // every copy: what is drawn {x, y, z, vx, vy, vz, w, obj, trail, seen}
  const mine = new Map();           // owned players: {held, charging, weapon, last (fire time)}
  const ammo = new Map();           // host: player id → {weaponId: shots left}
  const stats = { fired: 0, exploded: 0, splashes: 0, turnsDone: 0, refused: 0 };
  const root = new THREE.Group(); root.name = 'gf-aim'; ctx.scene.add(root);
  let S = null, vfx = null, nextId = 1, lastList = null, resolving = null, turnKey = '', shots = 0, wheel = null, dials = null, hinted = false, lastBoom = null, linked = false, moveL = [];
  let followUntil = 0, followAt = null, botPlan = null;
  if (P.explodeFx || P.splashFx || ctx.config?.fx) import('../../vfx/index.js').then(m => { vfx = m.vfxOf(ctx); }).catch(e => console.warn(`gf-three aim: effects need the vfx module (${e.message})`));
  const now = () => ctx.time.now;
  const turns = () => (ctx.turns && ctx.flow?.id === 'turns' ? ctx.turns : null);
  const playing = () => ctx.round?.phase === 'playing';
  const sea = () => (Number.isFinite(ctx.world?.seaLevel) ? ctx.world.seaLevel : null);
  const W = () => S?.w ?? [0, 0];
  const windV = () => ({ x: W()[0], z: W()[1] });
  const weaponById = wid => weapons().find(w => w.id === wid) ?? weapons()[0];
  const stateOf = p => { let m = mine.get(p.id); if (!m) mine.set(p.id, m = { held: 0, charging: false, weapon: weaponById(V('start')).id, last: -99, power: 0 }); return m; };

  // ---------- may this player act ----------
  function mayFire(p) {
    if (!p || p.alive === false || !playing()) return false;
    if (ctx.mechanics?.get('hazards')?.isOut?.(p)) return false;
    if (ctx.mechanics?.get('knockback')?.flying?.(p)) return false;
    const T = turns();
    if (T) return T.isTurn(p) && !resolving && shots < V('shotsPerTurn');
    return now() - stateOf(p).last >= V('cooldown');
  }
  const ammoLeft = (p, w) => { if (w.ammo < 0) return Infinity; const a = ammo.get(p.id) ?? {}; return a[w.id] ?? w.ammo; };

  // ---------- the muzzle and the launch ----------
  const muzzleOf = (p, d) => { const h = Math.hypot(d[0], d[2]) || 1, up = (p.character?.height ?? 1.4) * 0.7; return { x: p.position.x + d[0] / h * 0.6, y: p.position.y + up, z: p.position.z + d[2] / h * 0.6 }; };
  /** The aim of an owned player now: {yaw, elevation}: the camera's heading and pitch for the local player, a bot's plan. */
  function aimOf(p) {
    const rig = p.controller?.rig;
    if (p.local && rig) {
      const pitchDeg = (rig.pitch ?? 0) * 180 / Math.PI;
      return { yaw: rig.yaw, elevation: clamp(-pitchDeg + V('angleLift'), V('minAngle'), V('maxAngle')) };
    }
    if (botPlan && botPlan.id === p.id) return { yaw: botPlan.yaw, elevation: botPlan.elevation };
    const a = p.aim ?? [0, 0, 1];
    return { yaw: Math.atan2(a[0], a[2]), elevation: clamp(Math.asin(clamp(a[1], -1, 1)) * 180 / Math.PI + V('angleLift'), V('minAngle'), V('maxAngle')) };
  }
  function launch(p, power, a, w) {
    const d = launchDir(a.yaw, a.elevation), s = w.speed * clamp(power, 0, 1);
    return { o: muzzleOf(p, d), v: [d[0] * s, d[1] * s, d[2] * s] };
  }

  // ---------- the world a shell meets (host and the preview) ----------
  function hitWorld(a, b) {
    const { RAPIER: R, world: Wd } = physicsOf(ctx);
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.hypot(dx, dy, dz);
    if (R && Wd && d > 1e-6) {
      const h = Wd.castRayAndGetNormal(new R.Ray(a, { x: dx / d, y: dy / d, z: dz / d }), d, true, undefined, undefined, undefined, undefined, c => { const q = c.parent(); return !q || q.isFixed(); });
      if (h) return { t: (h.timeOfImpact ?? h.toi) / d, normal: [h.normal.x, h.normal.y, h.normal.z] };
    }
    const s = sea();
    if (s !== null && b.y <= s && a.y > s) return { t: (a.y - s) / Math.max(1e-6, a.y - b.y), normal: [0, 1, 0], water: true };
    return null;
  }

  // ---------- firing ----------
  /** Fire for an owned player (the local one, or a bot on the host). opts: {power, yaw, elevation, weapon}. → true when it went. */
  function fire(p, opts = {}) {
    if (!S || !p || !(p.owned || ctx.host) || !mayFire(p)) { stats.refused++; return false; }
    const st = stateOf(p), w = weaponById(opts.weapon ?? st.weapon);
    if (ammoLeft(p, w) <= 0) { if (p.local) ctx.ui?.toast?.(`No ${w.label} left`); stats.refused++; return false; }
    const a = { ...aimOf(p), ...(Number.isFinite(opts.yaw) ? { yaw: opts.yaw } : {}), ...(Number.isFinite(opts.elevation) ? { elevation: opts.elevation } : {}) };
    const power = clamp(opts.power ?? st.power ?? 0.6, 0, 1);
    st.last = now();
    p.act?.('throw', 0.4);
    p.controller?.faceTo?.(a.yaw, 0.6);
    if (ctx.host) return hostFire(p, power, a, w);
    ctx.net.send('aim:fire', { w: w.id, pw: r3(power), y: r3(a.yaw), e: r2(a.elevation) }, 'host');
    if (V('soundFire')) ctx.audio?.play(V('soundFire'), { optional: true });
    return true;
  }
  function hostFire(p, power, a, w) {
    if (!mayFire(p) || ammoLeft(p, w) <= 0) { stats.refused++; return false; }
    if (w.ammo >= 0) { const m = ammo.get(p.id) ?? {}; m[w.id] = ammoLeft(p, w) - 1; ammo.set(p.id, m); S.a = Object.fromEntries([...ammo].map(([k, v]) => [k, v])); }
    const { o, v } = launch(p, power, a, w);
    const b = { id: nextId++, shooter: p, w, x: o.x, y: o.y, z: o.z, vx: v[0], vy: v[1], vz: v[2], age: 0, bounces: 0 };
    shells.set(b.id, b);
    stats.fired++; S.n = (S.n ?? 0) + 1;
    if (turns()) { shots++; resolving = { by: p.id, since: now(), quiet: 0 }; }
    if (V('windPer') === 'shot') S.w = newWind();
    for (const fn of L.fire.slice()) try { fn({ shooter: p, weapon: w.id, power, yaw: a.yaw, elevation: a.elevation, point: o }); } catch (e) { console.error(e); }
    return true;
  }

  // ---------- the host: shells in flight ----------
  function bodiesNear() { return ctx.players.list().filter(p => p.alive !== false && !ctx.mechanics?.get('hazards')?.isOut?.(p)).map(p => ({ p, x: p.position.x, y: p.position.y + (p.character?.height ?? 1.2) * 0.5, z: p.position.z, r: Math.max(0.35, (p.character?.height ?? 1.2) * 0.4) })); }
  function hostShells(dt) {
    const g = V('gravity'), wind = windV(), list = bodiesNear();
    for (const b of [...shells.values()]) {
      const n = 4, h = dt / n;
      for (let i = 0; i < n && shells.has(b.id); i++) {
        const a = { x: b.x, y: b.y, z: b.z };
        shellStep(b, h, g * b.w.gravity, { x: wind.x * b.w.wind, z: wind.z * b.w.wind });
        b.age += h;
        const c = { x: b.x, y: b.y, z: b.z };
        // a body in the way (never the shooter in its first quarter second)
        let hitBody = null;
        for (const q of list) {
          if (q.p === b.shooter && b.age < 0.25) continue;
          const ex = c.x - a.x, ey = c.y - a.y, ez = c.z - a.z, l2 = ex * ex + ey * ey + ez * ez;
          const u = l2 < 1e-9 ? 0 : clamp(((q.x - a.x) * ex + (q.y - a.y) * ey + (q.z - a.z) * ez) / l2, 0, 1);
          if (Math.hypot(a.x + ex * u - q.x, a.y + ey * u - q.y, a.z + ez * u - q.z) <= q.r + b.w.size) { hitBody = { u, q }; break; }
        }
        const hw = hitWorld(a, c);
        if (hitBody && (!hw || hitBody.u <= hw.t)) { const k = hitBody.u; explode(b, { x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k, z: a.z + (c.z - a.z) * k }, false); break; }
        if (hw) {
          const pt = { x: a.x + (c.x - a.x) * hw.t, y: a.y + (c.y - a.y) * hw.t, z: a.z + (c.z - a.z) * hw.t };
          if (hw.water) { explode(b, pt, true); break; }
          if (b.w.fuse > 0 && b.age < b.w.fuse && b.bounces < b.w.bounces) {
            const [nx, ny, nz] = hw.normal, vn = b.vx * nx + b.vy * ny + b.vz * nz, e = b.w.restitution;
            b.vx = (b.vx - vn * nx) * 0.8 - vn * nx * e; b.vy = (b.vy - vn * ny) * 0.8 - vn * ny * e; b.vz = (b.vz - vn * nz) * 0.8 - vn * nz * e;
            b.x = pt.x + nx * 0.05; b.y = pt.y + ny * 0.05; b.z = pt.z + nz * 0.05; b.bounces++;
            continue;
          }
          if (b.w.fuse > 0 && b.age < b.w.fuse) { b.x = pt.x + hw.normal[0] * 0.05; b.y = pt.y + hw.normal[1] * 0.05; b.z = pt.z + hw.normal[2] * 0.05; b.vx = b.vy = b.vz = 0; continue; }
          explode(b, pt, false); break;
        }
        if (b.w.fuse > 0 && b.age >= b.w.fuse) { explode(b, c, false); break; }
        if (b.age > V('lifetime') || b.y < (sea() ?? 0) - 30) { shells.delete(b.id); break; }
      }
    }
  }
  function explode(b, at, water) {
    shells.delete(b.id);
    const w = b.w, kb = ctx.mechanics?.get('knockback'), carve = ctx.mechanics?.get('carve');
    const msg = { p: [r2(at.x), r2(at.y), r2(at.z)], r: w.radius, w: w.id, ...(water ? { s: 1 } : {}), o: b.shooter?.id ?? null };
    ctx.net.send('aim:x', msg);
    boom(msg);
    let thrown = [];
    if (kb && !kb.standin) thrown = kb.blast(at, { radius: water ? w.radius * 0.6 : w.radius, force: water ? w.force * 0.6 : w.force, damage: w.damage, from: b.shooter, source: 'aim' });
    else {
      // no knockback part: the old way, a knock through the health mechanic for whoever is near
      const hm = ctx.mechanics?.get('health');
      for (const q of bodiesNear()) {
        const d = Math.hypot(q.x - at.x, q.y - at.y, q.z - at.z); if (d > w.radius) continue;
        const k = 1 - d / w.radius, h = Math.hypot(q.x - at.x, q.z - at.z) || 1, imp = { x: (q.x - at.x) / h * w.force * k, y: w.force * 0.6 * k + 2, z: (q.z - at.z) / h * w.force * k };
        if (hm?.damage && !hm.standin) hm.damage(q.p, Math.round(w.damage * k), { from: b.shooter, impulse: imp, source: 'aim' }); else q.p.knock?.(imp, 1.2);
      }
    }
    if (!water && carve && !carve.standin && w.crater > 0 && V('carveScale') > 0) carve.carve(at, w.radius * w.crater * V('carveScale'), b.shooter?.id ?? null);
    stats.exploded++;
    if (S) S.x = (S.x ?? 0) + 1;
    for (const fn of L.explode.slice()) try { fn({ shooter: b.shooter, at, weapon: w.id, water: !!water, thrown }); } catch (e) { console.error(e); }
  }
  /** Every copy: a blast where a shell went off (the effect style's blast, the weapon's own effect, the sound). */
  function boom(m) {
    const at = { x: m.p[0], y: m.p[1], z: m.p[2] }, w = weaponById(m.w);
    lastBoom = { at, t: now(), w: m.w, water: !!m.s, by: m.o ?? null };
    if (m.s) {
      stats.splashes++;
      if (vfx && V('splashFx')) vfx.fx(V('splashFx'), { at: { x: at.x, y: sea() ?? at.y, z: at.z }, scale: 1.6 });
      if (V('soundSplash')) ctx.audio?.play(V('soundSplash'), { at, optional: true });
    } else {
      if (vfx) { if (ctx.config?.fx) vfx.blast(at, { radius: w.radius }); if (V('explodeFx')) vfx.fx(V('explodeFx'), { at, scale: Math.max(0.8, w.radius / 2.5) }); }
      if (V('soundBoom')) ctx.audio?.play(V('soundBoom'), { at, optional: true });
    }
    // the camera stays on the blast a moment, then on whoever it threw farthest
    if (followUntil > now()) followUntil = Math.max(followUntil, now() + 2.6);
  }

  // ---------- every copy: draw the shells ----------
  const geo = new THREE.SphereGeometry(1, 14, 10);
  const mats = new Map();
  const matOf = color => { if (!mats.has(color)) mats.set(color, ctx.modules?.look?.material?.('prop', { color }) ?? new THREE.MeshStandardMaterial({ color, roughness: 0.5 })); return mats.get(color); };
  function objFor(w) { const m = new THREE.Mesh(geo, matOf(w.color)); m.scale.setScalar(w.size); m.castShadow = true; m.userData.gfSlot = 'mechanic.aim.weapons'; root.add(m); return m; }
  function drawShells(dt) {
    const g = V('gravity'), wind = windV();
    if (ctx.host) {
      // the shell's place before newShell reads it (its sound and the fire listeners are at the muzzle)
      for (const b of shells.values()) { let v = view.get(b.id); if (!v) { v = { obj: objFor(b.w), w: b.w, by: b.shooter?.id, x: b.x, y: b.y, z: b.z }; view.set(b.id, v); newShell(v, b.shooter); } Object.assign(v, { x: b.x, y: b.y, z: b.z }); }
      for (const [k, v] of view) if (!shells.has(k)) dropView(k, v);
    } else if (S.s !== lastList) {
      lastList = S.s;
      const seen = new Set();
      for (const e of S.s ?? []) {
        seen.add(e[0]);
        let v = view.get(e[0]);
        if (!v) { const w = weaponById(e[7]); v = { x: e[1], y: e[2], z: e[3], vx: e[4], vy: e[5], vz: e[6], w, obj: objFor(w), by: e[8] }; view.set(e[0], v); newShell(v, ctx.players.get(e[8]) ?? null); }
        else { v.x += (e[1] - v.x) * 0.6; v.y += (e[2] - v.y) * 0.6; v.z += (e[3] - v.z) * 0.6; v.vx = e[4]; v.vy = e[5]; v.vz = e[6]; }
      }
      for (const [k, v] of view) if (!seen.has(k)) dropView(k, v);
    }
    for (const v of view.values()) {
      if (!ctx.host) shellStep(v, dt, g * v.w.gravity, { x: wind.x * v.w.wind, z: wind.z * v.w.wind });
      v.obj.position.set(v.x, v.y, v.z); v.obj.rotation.x += dt * 8; v.obj.rotation.y += dt * 5;
    }
  }
  function newShell(v, shooter) {
    if (vfx && ctx.config?.fx) v.trail = vfx.trail(v.obj);
    if (shooter && !shooter.local && V('soundFire')) ctx.audio?.play(V('soundFire'), { at: { x: v.x, y: v.y, z: v.z }, optional: true });
    if (!ctx.host) for (const fn of L.fire.slice()) try { fn({ shooter: shooter ?? null, weapon: v.w.id, point: { x: v.x, y: v.y, z: v.z } }); } catch (e) { console.error(e); }
    // the camera follows the shot (turn games: on every screen)
    const f = V('follow'), follow = f === 'all' || (f === 'turns' && !!turns()) || (f === 'own' && shooter?.local);
    if (follow && ctx.juice?.follow) {
      followUntil = now() + V('lifetime');
      const from = shooter?.position ? { x: shooter.position.x, y: shooter.position.y, z: shooter.position.z } : null;
      ctx.juice.follow(() => followPoint(), { seconds: V('lifetime') + 4, distance: 14, height: 6.5, from });
    }
  }
  function dropView(k, v) { v.trail?.stop?.(); v.obj.removeFromParent(); view.delete(k); }
  /** What the follow camera looks at: the shell, then the blast, then the body it threw farthest; null when done. */
  function followPoint() {
    if (now() > followUntil) return null;
    for (const v of view.values()) return { x: v.x, y: v.y, z: v.z };
    const kb = ctx.mechanics?.get('knockback');
    if (kb && lastBoom) {
      let best = null;
      for (const p of ctx.players.list()) { const q = kb.pathAt?.(p); if (q && !q.done) { const d = Math.hypot(q.x - lastBoom.at.x, q.z - lastBoom.at.z); if (!best || d > best.d) best = { d, q }; } }
      if (best) { followUntil = Math.max(followUntil, now() + 0.6); return { x: best.q.x, y: best.q.y, z: best.q.z, distance: 7.5, height: 3 }; }
    }
    return lastBoom && now() - lastBoom.t < 2.4 ? { ...lastBoom.at, distance: 10, height: 4.5 } : null;
  }

  // ---------- the trajectory preview (this screen's player, while they aim) ----------
  const DOTS = 40;
  const dotMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: P.previewColor, transparent: true, opacity: 0.85, depthWrite: false }), DOTS);
  dotMesh.frustumCulled = false; dotMesh.count = 0; dotMesh.name = 'gf-aim-preview'; dotMesh.userData.gfSlot = 'mechanic.aim.preview-color'; root.add(dotMesh);
  const M4 = new THREE.Matrix4(), Q0 = new THREE.Quaternion(), V3 = new THREE.Vector3(), SC = new THREE.Vector3();
  let previewInfo = null;
  function drawPreview(p, power) {
    const mode = V('preview');
    if (mode === 'none' || !p) { dotMesh.count = 0; previewInfo = null; return; }
    const w = weaponById(stateOf(p).weapon), { o, v } = launch(p, power, aimOf(p), w);
    const path = predictPath(o, v, { gravity: V('gravity') * w.gravity, wind: { x: windV().x * w.wind, z: windV().z * w.wind }, seconds: mode === 'short' ? V('previewSeconds') : 6, dt: 1 / 30, floor: (sea() ?? 0) - 2, hit: hitWorld });
    const pts = path.points, step = Math.max(1, Math.ceil(pts.length / DOTS));
    let k = 0;
    for (let i = step; i < pts.length && k < DOTS; i += step, k++) { const q = pts[i], s = 1 - (k / DOTS) * 0.5; M4.compose(V3.set(q.x, q.y, q.z), Q0, SC.setScalar(s)); dotMesh.setMatrixAt(k, M4); }
    dotMesh.count = k; dotMesh.instanceMatrix.needsUpdate = true;
    previewInfo = { power: r2(power), end: { x: r2(path.end.x), y: r2(path.end.y), z: r2(path.end.z) }, hit: path.hit, dots: k };
  }

  // ---------- the HUD ----------
  // the charge, at the crosshair: a ring round it fills as primary is held (where the player looks while aiming)
  let ring = null;
  function chargeRing(power) {
    const root = ctx.ui?.root; if (!root || !globalThis.document) return;
    if (!ring) {
      const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '-24 -24 48 48'); svg.dataset.widget = 'aim-charge';
      svg.style.cssText = 'position:absolute;left:50%;top:50%;width:48px;height:48px;margin:-24px;pointer-events:none;overflow:visible;display:none;filter:drop-shadow(0 0 1.5px #000c)';
      const track = document.createElementNS(NS, 'circle'), fill = document.createElementNS(NS, 'circle');
      for (const c of [track, fill]) { c.setAttribute('r', '15'); c.setAttribute('fill', 'none'); c.setAttribute('stroke-width', '7'); }
      track.setAttribute('stroke', '#0006'); fill.setAttribute('stroke', 'var(--gf-accent,#ff7a59)'); fill.setAttribute('transform', 'rotate(-90)'); fill.setAttribute('stroke-linecap', 'round');
      svg.append(track, fill); root.append(svg);
      ring = { svg, fill, len: 2 * Math.PI * 15 };
    }
    const on = power > 0;
    ring.svg.style.display = on ? 'block' : 'none';
    if (on) ring.fill.setAttribute('stroke-dasharray', `${(ring.len * clamp(power, 0, 1)).toFixed(1)} ${ring.len.toFixed(1)}`);
    ring.svg.dataset.value = String(r2(power));
  }
  function hud(p, on, power) {
    chargeRing(on && V('hud') ? power : 0);
    if (!V('hud') || !ctx.ui?.dial) return;
    if (!on) { if (dials) { dials.aim.remove(); dials.power.remove(); dials = null; } }
    else {
      const a = aimOf(p);
      if (!dials) dials = { aim: ctx.ui.dial('aim', { kind: 'aim', value: a.elevation, label: 'Angle', where: 'bl' }), power: ctx.ui.dial('power', { kind: 'power', value: power, label: 'Power', where: 'bl' }) };
      dials.aim.set(Math.round(a.elevation)); dials.power.set(power);
    }
    // the wind is everyone's (and a viewer's): a strip along the camera's heading
    if (V('wind') > 0) {
      const yaw = p?.controller?.rig?.yaw ?? 0;
      if (!dials?.wind && !hud.wind) hud.wind = ctx.ui.dial('wind', { kind: 'wind', value: 0, label: 'Wind', where: 'tl' });
      hud.wind?.set(r2(windAlong(windV(), yaw, V('wind'))));
    }
  }
  function weaponWheel(p) {
    if (!V('hud') || !ctx.ui?.weapons || !p?.local) return;
    const st = stateOf(p);
    const items = () => weapons().map(w => ({ id: w.id, label: w.label, icon: w.icon || undefined, count: w.ammo < 0 ? undefined : ammoLeft(p, w) }));
    if (!wheel) wheel = ctx.ui.weapons({ items: items(), pick: st.weapon, layout: 'wheel', title: 'Weapons', onPick: id => { st.weapon = id; } });
    return { refresh() { const open = wheel.isOpen; wheel.remove(); wheel = ctx.ui.weapons({ items: items(), pick: st.weapon, layout: 'wheel', title: 'Weapons', onPick: id => { st.weapon = id; } }); if (open) wheel.open(); } };
  }
  // the number keys pick a weapon (the wheel shows it), whatever the pointer is doing
  const onKey = e => {
    if (!/^Digit[1-9]$/.test(e.code) || !ctx.me || !playing()) return;
    const w = weapons()[Number(e.code.slice(5)) - 1]; if (!w) return;
    stateOf(ctx.me).weapon = w.id; wheel?.set(w.id); wheel?.open(); clearTimeout(onKey.t); onKey.t = setTimeout(() => wheel?.close(), 900);
  };
  globalThis.addEventListener?.('keydown', onKey);

  // ---------- turns: the part plays its own moves ----------
  function link() {
    if (linked) return; linked = true;
    const T = turns();
    if (T?.drive) T.drive({
      seated: () => true,
      // a player out of the play (in the water, thrown into it) has no move: their turn passes at once; when nobody has
      // one (everyone in the water at once) the turn waits for them to come back
      canAct: p => { const ok = q => q.alive !== false && !ctx.mechanics?.get('hazards')?.isOut?.(q); return ok(p) || !ctx.players.list().some(ok); },
      onMove: fn => moveL.push(fn),
      // the turn clock ran out: a shell still in the air (or bodies still flying) finishes the turn itself
      timeout: () => !!resolving,
      bots: true, shows: false,
    });
  }
  function newWind() { const w = windFor(() => (ctx.rng?.() ?? Math.random()), V('wind')); return [w.x, w.z]; }
  /** Host: the turn's shot has gone off and everything thrown has come to rest: the turn passes. */
  function hostResolve(dt) {
    if (!resolving) return;
    const kb = ctx.mechanics?.get('knockback');
    const busy = shells.size > 0 || (kb && !kb.standin && ctx.players.list().some(p => kb.flying(p)));
    resolving.quiet = busy ? 0 : resolving.quiet + dt;
    if (resolving.quiet < V('settleSeconds') && now() - resolving.since < V('lifetime') + 8) return;
    const p = ctx.players.get(resolving.by);
    resolving = null;
    if (shots < V('shotsPerTurn') && p && mayFire(p)) return;
    stats.turnsDone++;
    for (const fn of moveL.slice()) try { fn({ player: p, move: { aim: true } }); } catch (e) { console.error(e); }
    for (const fn of L.turnDone.slice()) try { fn({ player: p }); } catch (e) { console.error(e); }
  }

  // ---------- bots ----------
  /** rules.bot: aim and fire for a bot when it may (turn games: its turn). → true while it is busy aiming. */
  function bot(p, dt = ctx.time.dt) {
    if (!ctx.host || !p?.isBot) return false;
    p.bot?.stop?.();
    if (!mayFire(p)) { if (botPlan?.id === p.id) botPlan = null; return false; }
    if (!botPlan || botPlan.id !== p.id) {
      const foes = ctx.players.list().filter(q => q !== p && q.alive !== false && !(ctx.mechanics?.get('hazards')?.isOut?.(q)));
      if (!foes.length) return false;
      const t = foes.reduce((a, q) => (Math.hypot(q.x - p.x, q.z - p.z) < Math.hypot(a.x - p.x, a.z - p.z) ? q : a));
      const w = weaponById(stateOf(p).weapon), rnd = () => (ctx.rng?.() ?? Math.random());
      const o = muzzleOf(p, launchDir(Math.atan2(t.x - p.x, t.z - p.z), 45));
      const sol = solveShot(o, { x: t.x, y: t.y + 0.4, z: t.z }, { speed: w.speed, gravity: V('gravity') * w.gravity, wind: { x: windV().x * w.wind, z: windV().z * w.wind }, minPower: V('minPower') });
      const err = V('botError');
      botPlan = { id: p.id, t: now() + V('botThink'), yaw: sol.yaw + (rnd() - 0.5) * err * 0.6, elevation: clamp(sol.elevation + (rnd() - 0.5) * err * 30, V('minAngle'), V('maxAngle')), power: clamp(sol.power * (1 + (rnd() - 0.5) * err), V('minPower'), 1), held: 0 };
    }
    p.input.face = botPlan.yaw;
    if (now() < botPlan.t) return true;
    // charge in plain view (the power dial on the others' screens rises), then fire
    const st = stateOf(p);
    botPlan.held += dt; st.power = Math.min(botPlan.power, chargeAt(botPlan.held, V('chargeSeconds'), 'clamp', V('minPower')));
    st.charging = true;
    if (st.power >= botPlan.power - 1e-3) { st.charging = false; fire(p, { power: botPlan.power, yaw: botPlan.yaw, elevation: botPlan.elevation }); botPlan = null; }
    return true;
  }

  const api = {
    id, params: P, stats, aimed: true,
    fire, bot,
    /** The weapons (each with every field). */
    weapons,
    /** Every copy, for an owned player: their weapon id; set it with select. */
    weaponOf: p => stateOf(p).weapon,
    select(p, wid) { if (weapons().some(w => w.id === wid)) { stateOf(p).weapon = wid; if (p.local) wheel?.set(wid); return true; } return false; },
    /** The wind now {x, z} (m/s²). */
    get wind() { return windV(); },
    /** Host: set the wind ({x, z}) or roll a new one (no argument). */
    setWind(w) { if (ctx.host && S) S.w = w ? [r2(w.x ?? 0), r2(w.z ?? 0)] : newWind(); },
    mayFire,
    /** Shells in flight on this copy. */
    active: () => (ctx.host ? shells.size : view.size),
    get resolving() { return !!resolving; },
    onFire(fn) { L.fire.push(fn); return unsub(L.fire, fn); },
    onExplode(fn) { L.explode.push(fn); return unsub(L.explode, fn); },
    onTurnDone(fn) { L.turnDone.push(fn); return unsub(L.turnDone, fn); },
    reset() {
      shells.clear(); for (const [k, v] of view) dropView(k, v); lastList = null; resolving = null; shots = 0; turnKey = ''; ammo.clear(); botPlan = null;
      for (const m of mine.values()) { m.held = 0; m.charging = false; m.last = -99; }
      if (ctx.host && S) { S.w = newWind(); S.a = {}; }
    },
    update(dt) {
      if (!S) { if (!(ctx.shared && ctx.players && ctx.me)) return; S = ctx.shared.register('aim', { w: [0, 0], s: [], n: 0, x: 0, a: {}, c: null }); if (ctx.host) S.w = newWind(); }
      if (!linked) link();
      const T = turns(), me = ctx.me;
      if (ctx.host) {
        // a new turn: its shots, its wind
        const key = T && playing() ? `${ctx.round?.number}:${T.number}:${T.current()?.id ?? ''}` : '';
        if (key !== turnKey) { turnKey = key; shots = 0; if (T && V('windPer') === 'turn') S.w = newWind(); }
        if (playing()) { hostShells(Math.min(dt, 0.05)); hostResolve(dt); } else shells.clear();
        S.s = [...shells.values()].map(b => [b.id, r2(b.x), r2(b.y), r2(b.z), r2(b.vx), r2(b.vy), r2(b.vz), b.w.id, b.shooter?.id ?? null]);
        for (const [k] of ammo) if (!ctx.players.get(k)) ammo.delete(k);
      } else if (S.a) { ammo.clear(); for (const [k, v] of Object.entries(S.a)) ammo.set(k, { ...v }); }
      // others hold still on someone else's turn
      if (T && V('holdOthers')) for (const p of ctx.players.owned()) if (p.controller) p.controller.enabled = !playing() || T.isTurn(p);
      // this screen's player: charge while primary is held, fire on release; the wheel on secondary
      if (me?.controller && playing()) {
        const st = stateOf(me), may = mayFire(me), acts = me.actions;
        if (acts?.secondary?.pressed && may) { const h = weaponWheel(me); if (wheel) { wheel.set(st.weapon); wheel.toggle(); } void h; }
        if (may && acts?.primary?.pressed && !wheel?.isOpen) { st.charging = true; st.held = 0; }
        if (st.charging) {
          st.held += dt; st.power = chargeAt(st.held, V('chargeSeconds'), V('charge'), V('minPower'));
          me.input.face = aimOf(me).yaw;
          if (!acts?.primary?.down || !may) { st.charging = false; if (may) fire(me, { power: st.power }); }
        } else if (!may) st.power = 0;
        if (may && !hinted && T && V('textCharge')) { hinted = true; ctx.ui?.toast?.(V('textCharge')); }
        // the arc while aiming: at the power being charged, or at a middle power before the press
        drawPreview(may ? me : null, st.charging ? st.power : 0.6);
        hud(me, may, st.charging ? st.power : 0);
        if (may) weaponWheel(me);
        // the others see the shooter's charge on their power dial (shared, by the host for its own players)
        if (ctx.host) { const c = ctx.players.owned().find(p => stateOf(p).charging); S.c = c ? [c.id, r2(stateOf(c).power)] : null; }
      } else { drawPreview(null, 0); hud(me, false, 0); }
      drawShells(dt);
    },
    /** 'aim:fire' (a player's copy asks the host) and 'aim:x' (the host tells everyone where a shell went off). */
    event(name, d, from) {
      if (!d) return;
      if (name === 'x' && !ctx.host && Array.isArray(d.p) && d.p.length === 3 && d.p.every(Number.isFinite)) { boom(d); return; }
      if (name === 'fire' && ctx.host && S) {
        const p = ctx.players.get(from); if (!p || p.isBot) return;
        const w = weaponById(d.w), a = { yaw: Number(d.y) || 0, elevation: clamp(Number(d.e) || 0, V('minAngle'), V('maxAngle')) };
        if (hostFire(p, clamp(Number(d.pw) || 0, 0, 1), a, w)) { stateOf(p).last = now(); }
      }
    },
    observe: () => ({ host: !!ctx.host, wind: windV(), shells: ctx.host ? shells.size : view.size, fired: S?.n ?? 0, exploded: S?.x ?? 0, resolving: !!resolving, last: lastBoom ? { at: { x: r2(lastBoom.at.x), y: r2(lastBoom.at.y), z: r2(lastBoom.at.z) }, w: lastBoom.w, water: lastBoom.water, by: lastBoom.by, t: r2(lastBoom.t) } : null, preview: previewInfo, me: ctx.me ? { weapon: stateOf(ctx.me).weapon, power: r2(stateOf(ctx.me).power), charging: stateOf(ctx.me).charging, may: mayFire(ctx.me), ...aimOf(ctx.me), muzzle: (m => ({ x: r3(m.x), y: r3(m.y), z: r3(m.z) }))(muzzleOf(ctx.me, launchDir(aimOf(ctx.me).yaw, aimOf(ctx.me).elevation))) } : null, following: !!ctx.juice?.following, stats: { ...stats } }),
    dispose() { globalThis.removeEventListener?.('keydown', onKey); root.removeFromParent(); wheel?.remove(); ring?.svg.remove(); },
  };
  return api;
}

export const manifest = {
  id, examples, params,
  describe: 'A ballistic aim: charge the power, set the angle with the view, wind, a trajectory preview, weapons on a wheel; joins turn games (one acts, the camera follows the shot)',
  rank: 12,
  needs: { parts: [], world: [] },
  uses: ['knockback', 'carve', 'health', 'hazards'],
  owns: () => [
    { res: 'input.primary', why: 'hold to charge the power, release to fire', free: 'the aim is always on primary' },
    { res: 'input.secondary', why: 'opens the weapon wheel', free: 'the wheel is always on secondary (the number keys pick too)' },
  ],
  items: [{ key: 'weapons', noun: 'weapon', nouns: 'weapons', min: 1, max: 9, id: 'id', name: 'label', front: ['damage', 'radius', 'ammo'],
    schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', title: 'Id' }, label: { type: 'string', title: 'Name' }, icon: { type: 'string', title: 'Icon (a picture or a character)' },
      speed: { type: 'number', title: 'Speed at full power', minimum: 4, maximum: 60, unit: 'm/s', default: 30 }, gravity: { type: 'number', title: 'Gravity (× the part\'s)', minimum: 0, maximum: 4, default: 1 },
      wind: { type: 'number', title: 'Wind (× the wind)', minimum: 0, maximum: 3, default: 1 }, fuse: { type: 'number', title: 'Fuse (0: goes off where it lands)', minimum: 0, maximum: 10, unit: 's', default: 0 },
      bounces: { type: 'integer', title: 'Bounces before the fuse', minimum: 0, maximum: 20, default: 0 }, radius: { type: 'number', title: 'Blast radius', minimum: 0, maximum: 12, unit: 'm', default: 3 },
      force: { type: 'number', title: 'Blast throw', minimum: 0, maximum: 32, unit: 'm/s', default: 16 }, damage: { type: 'number', title: 'Damage', minimum: 0, maximum: 1000, default: 25 },
      crater: { type: 'number', title: 'Crater (× the radius)', minimum: 0, maximum: 3, default: 1 }, ammo: { type: 'integer', title: 'Shots (-1: unlimited)', minimum: -1, maximum: 99, default: -1 },
      color: { type: 'string', title: 'Colour', default: '#3a3a44' },
    } } }],
  state: { key: 'aim', fields: { w: '[x, z] the wind (m/s²)', s: '[[id, x, y, z, vx, vy, vz, weapon, shooter]] shells in flight', n: 'shots fired', x: 'shells gone off', a: '{ player: { weapon: left } } ammunition', c: '[player, power] who is charging now' } },
  events: [
    { name: 'onFire', on: 'every copy', args: '{ shooter, weapon, power, yaw, elevation, point }', when: 'a shell left a muzzle', play: 'attempt' },
    { name: 'onExplode', on: 'host', args: '{ shooter, at, weapon, water, thrown }', when: 'a shell went off (thrown: the bodies the blast threw)', play: 'blast' },
    { name: 'onTurnDone', on: 'host', args: '{ player }', when: 'a turn\'s shot went off and everything came to rest (the turn passes)', quiet: true },
  ],
  sync: { owner: 'host', how: 'a player\'s copy sends its aim, power and weapon when it fires; the host flies every shell (wind, bounces, fuse), blasts where it ends and tells everyone; the wind and ammunition are shared' },
  note: [
    'The part fires by itself on primary (hold to charge, release) for this screen\'s player; rules.bot calls aim.bot(p) so bots aim and fire too.',
    'A blast throws through the knockback mechanic and carves through the carve mechanic when the game has them; score in their events or aim.onExplode (host).',
    'In a turns game the turn passes by itself once the shot has gone off and everything has settled: never call ctx.turns.done for it.',
  ],
  stub: {
    as: 'aim',
    worked: 'bot(ctx, p) { ctx.mechanics.get(\'aim\').bot(p); }',
    traps: ['rules.bot must call aim.bot(p) (or bots never fire)', 'a blast already throws and carves through the knockback and carve parts: do not do it again in onExplode'],
  },
  signs: {
    sample: sh => (sh.aim ? { aim: [sh.aim.n ?? 0, sh.aim.x ?? 0] } : null),
    judge: v => {
      const seen = new Set();
      for (const p of v.pages ?? []) for (const s of p.samples ?? []) if (Array.isArray(s.sh?.aim)) seen.add(String(s.sh.aim[1] ?? 0));
      const ok = seen.size > 1;
      v.add('shells go off', ok ? 'ok' : 'dead', 'shared.aim.x', ok ? 'yes' : `no shell went off on any page (${v.names})`, ok ? '' : 'players fire on primary (hold and release); rules.bot must call aim.bot(p)');
    },
  },
};
