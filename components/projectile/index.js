// mechanic: projectile (track K2). Discrete shots (a ball, a dart, a rocket) and a continuous stream (water gun, hose,
// paint, spray) with an arc, hit callbacks, knockback and splash. README.md has the network ownership and the API.
//
//   const prj = ctx.mechanics.get('projectile');
//   prj.fire(ctx.me);                      // discrete: an owned player throws at the crosshair point (kit/core/aim.js)
//   prj.stream(ctx.me, input.actions.primary.down);   // continuous: held
//   prj.onHit(h => { if (h.target) h.shooter.score += 1; });   // host only
//
// Fair play (kit/core/fair.js, CONTRACT §6c): a hit on a player who is down, out or protected, during the round's start
// grace, or from a bot when enough bots are already on that human, does nothing: no damage, no push, no knock, and
// onHit does not fire for it (onBlocked does), so rules that score in onHit never farm a helpless player (F8). Stream
// ticks push and never knock over (F6); a discrete hit or a splash knocks (for fair.downSeconds, F1).
//
// Aim (CONTRACT §6d, kit/core/aim.js): a player with a crosshair point (the local player in third or first person;
// friends through the pose's `ad`) shoots at it. The shot or stream leaves the muzzle on the arc that lands on that
// point at this mechanic's speed and gravity (a stream within its reach), or lands as far toward it as it can. So the
// shooter sees it land under the crosshair, clear of their own body, and every copy draws the same arc. Bots, the top
// camera and fire(p, dir) with a direction keep the old way: along the aim with the `arc` lob.
import * as THREE from 'three';
import { launchVelocity, step, sweepBody, segDist, knockImpulse, splashTargets, bounce, streamPath, cooldownGate, canHit, MAX_SPEED } from './logic.js';
import { physicsOf } from '../../core/util.js';
import { aimTarget, solveLaunch } from '../../core/aim.js';
import { restAimDistance } from '../../controller/camera-rig.js';

export const id = 'projectile';
export const examples = ['dodgeball throw', 'water-gun stream', 'paint sprayer', 'fire hose'];

const D = {
  kind: 'discrete', prop: '', color: '#ff6a3d', size: 0.22, speed: 18, arc: 0.25, gravity: 14, lifetime: 3, cooldown: 0.45, maxActive: 12,
  damage: 1, knockback: 6, knockUp: 3, knockSeconds: 1.2, splashRadius: 0, splashKnockback: 5, friendlyFire: true, selfHit: false,
  bounces: 0, bounceRestitution: 0.6, autoHealth: true, fireAnim: 'aim', soundFire: 'throw', soundHit: 'bonk',
  streamSpeed: 14, streamGravity: 9, streamReach: 9, streamWidth: 0.09, streamRate: 36, streamSpread: 0.05, streamDamage: 0.5,
  streamKnock: 1.2, streamHitInterval: 0.2, streamTank: 0, streamRefill: 0.4, surfaceHz: 10, bodyHeight: 1.7, muzzle: 'chest',
};
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum, extra = {}) => ({ type: 'number', description, minimum, maximum, ...extra });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    kind: { type: 'string', enum: ['discrete', 'continuous'], default: D.kind, description: 'discrete: one thrown shot per fire(); continuous: a held stream' },
    prop: { type: 'string', default: D.prop, description: 'Name of a prop.* slot to draw each shot with ("" draws a coloured ball)' },
    color: { type: 'string', default: D.color, description: 'Colour of the ball or the stream' },
    size: { ...num('Shot radius in metres', 0.05, 1), default: D.size },
    speed: { ...num('Launch speed in m/s (capped at 45)', 2, 45), default: D.speed },
    arc: { ...num('Upward bias of the launch direction: 0 flat, 0.25 a gentle lob', 0, 2), default: D.arc },
    gravity: { ...num('Gravity on a shot in m/s²', 0, 40), default: D.gravity },
    lifetime: { ...num('Seconds before a shot gives up', 0.5, 10), default: D.lifetime },
    cooldown: { ...num('Seconds between one player\'s shots', 0, 5), default: D.cooldown },
    maxActive: { type: 'integer', minimum: 1, maximum: 20, default: D.maxActive, description: 'Shots in flight at once (each costs about 45 bytes of the world message)' },
    damage: { ...num('Damage a hit passes to the health mechanic and onHit', 0, 100), default: D.damage },
    knockback: { ...num('Horizontal knock a hit gives (m/s)', 0, 40), default: D.knockback },
    knockUp: { ...num('Upward knock a hit gives (m/s)', 0, 20), default: D.knockUp },
    knockSeconds: { ...num('Seconds a knocked player is down', 0, 6), default: D.knockSeconds },
    splashRadius: { ...num('Splash radius in metres (0: none)', 0, 8), default: D.splashRadius },
    splashKnockback: { ...num('Knock at the centre of a splash (m/s)', 0, 40), default: D.splashKnockback },
    friendlyFire: { type: 'boolean', default: D.friendlyFire, description: 'Whether teammates (the teams mechanic) can hit each other' },
    selfHit: { type: 'boolean', default: D.selfHit, description: 'Whether a shot can hit its own shooter' },
    bounces: { type: 'integer', minimum: 0, maximum: 6, default: D.bounces, description: 'Bounces off the world before a shot ends' },
    bounceRestitution: { ...num('Speed kept after a bounce', 0, 1), default: D.bounceRestitution },
    autoHealth: { type: 'boolean', default: D.autoHealth, description: 'A hit calls health.damage when the health mechanic is present (else it knocks directly)' },
    fireAnim: { type: 'string', default: D.fireAnim, description: 'Animation word the shooter holds for a moment' },
    soundFire: { type: 'string', default: D.soundFire, description: 'Sound id played at the muzzle' },
    soundHit: { type: 'string', default: D.soundHit, description: 'Sound id played where a shot hits' },
    hitFx: { type: 'string', description: 'Name of a vfx preset (kit/vfx: spark-burst, impact-flash, smoke-puff, dust-kick, confetti, ...) drawn where a shot hits; unset: none. create copies the preset into config/game.json → vfx, where its colour, sprite and numbers are slots' },
    streamSpeed: { ...num('Stream speed in m/s', 3, 40), default: D.streamSpeed },
    streamGravity: { ...num('Gravity on the stream (its arc)', 0, 30), default: D.streamGravity },
    streamReach: { ...num('Longest stream in metres', 1, 30), default: D.streamReach },
    streamWidth: { ...num('Drop radius in metres', 0.02, 0.4), default: D.streamWidth },
    streamRate: { ...num('Drops per second', 5, 90), default: D.streamRate },
    streamSpread: { ...num('Random spread of the aim', 0, 0.4), default: D.streamSpread },
    streamDamage: { ...num('Damage per stream hit tick', 0, 100), default: D.streamDamage },
    streamKnock: { ...num('Push per stream hit tick (m/s, never knocks over)', 0, 20), default: D.streamKnock },
    streamHitInterval: { ...num('Seconds between stream hits on one target', 0.05, 2), default: D.streamHitInterval },
    streamTank: { ...num('Seconds of spraying one tank holds (0: unlimited)', 0, 60), default: D.streamTank },
    streamRefill: { ...num('Tank refilled per second while not spraying (fraction)', 0, 5), default: D.streamRefill },
    surfaceHz: { ...num('Surface hit callbacks per second while a stream touches the world', 1, 30), default: D.surfaceHz },
    bodyHeight: { ...num('Height of a player body for hit tests (m)', 0.5, 3), default: D.bodyHeight },
    muzzle: { type: 'string', enum: ['chest', 'hips'], default: D.muzzle, description: "Where shots and the stream leave the body: 'chest' (1.2 m up: a throw, a water gun, a hose) or 'hips' (the character's hip height, just ahead of the body: a pee stream)" },
  },
};

const vs = (name, label, type, extra = {}) => ({ id: `mechanic.projectile.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : 'gameplay', ...extra });
export const slots = [
  // a player look (CONTRACT §6e): each shooter's shots and stream take that player's own colour when they have one
  vs('color', 'Shot or stream colour', 'color', { tier: 'main', rank: 70, scope: 'player' }),
  vs('speed', 'Throw speed', 'number', { tier: 'main', rank: 66, constraints: { min: 2, max: 45, unit: 'm/s' } }),
  vs('knockback', 'Knock on a hit', 'number', { tier: 'main', rank: 64, constraints: { min: 0, max: 40, unit: 'm/s' } }),
  vs('cooldown', 'Time between shots', 'number', { tier: 'main', rank: 62, constraints: { min: 0, max: 5, unit: 's' } }),
  vs('prop', 'Prop drawn for each shot', 'text', { constraints: { maxLength: 40 } }),
  vs('size', 'Shot radius', 'number', { constraints: { min: 0.05, max: 1, unit: 'm' } }),
  vs('arc', 'Arc (upward lob)', 'number', { constraints: { min: 0, max: 2 } }),
  vs('gravity', 'Shot gravity', 'number', { constraints: { min: 0, max: 40 } }),
  vs('damage', 'Damage per hit', 'number', { constraints: { min: 0, max: 100 } }),
  vs('knockUp', 'Upward knock', 'number', { constraints: { min: 0, max: 20, unit: 'm/s' } }),
  vs('knockSeconds', 'Seconds knocked down', 'number', { constraints: { min: 0, max: 6, unit: 's' } }),
  vs('splashRadius', 'Splash radius', 'number', { constraints: { min: 0, max: 8, unit: 'm' } }),
  vs('streamSpeed', 'Stream speed', 'number', { constraints: { min: 3, max: 40, unit: 'm/s' } }),
  vs('streamGravity', 'Stream arc (gravity)', 'number', { constraints: { min: 0, max: 30 } }),
  vs('streamReach', 'Stream reach', 'number', { constraints: { min: 1, max: 30, unit: 'm' } }),
  vs('streamWidth', 'Stream drop size', 'number', { constraints: { min: 0.02, max: 0.4, unit: 'm' } }),
  vs('streamDamage', 'Damage per stream tick', 'number', { constraints: { min: 0, max: 100 } }),
  vs('streamKnock', 'Stream push', 'number', { constraints: { min: 0, max: 20, unit: 'm/s' } }),
  vs('streamTank', 'Seconds of spray per tank', 'number', { constraints: { min: 0, max: 60, unit: 's' } }),
  vs('soundFire', 'Fire sound id', 'text', { constraints: { maxLength: 40 } }),
  vs('soundHit', 'Hit sound id', 'text', { constraints: { maxLength: 40 } }),
];

const r2 = v => Math.round(v * 100) / 100, r1 = v => Math.round(v * 10) / 10;
const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };

/** A ray from a to b against the world's fixed colliders (never a player). → {t, d, n, point} | null */
function rayFixed(ctx, a, b) {
  const { RAPIER: R, world: W } = physicsOf(ctx);   // ctx.physics is the bare World (K1) or {RAPIER, world}
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.hypot(dx, dy, dz);
  if (!R || !W || d < 1e-6) return null;
  const ray = new R.Ray({ x: a.x, y: a.y, z: a.z }, { x: dx / d, y: dy / d, z: dz / d });
  const h = W.castRayAndGetNormal(ray, d, true, undefined, undefined, undefined, undefined, c => { const p = c.parent(); return !p || p.isFixed(); });
  if (!h) return null;
  const toi = h.timeOfImpact ?? h.toi;
  return { t: toi / d, d: toi, n: [h.normal.x, h.normal.y, h.normal.z], point: { x: a.x + dx / d * toi, y: a.y + dy / d * toi, z: a.z + dz / d * toi } };
}

/**
 * Defaults that follow the game's own config (create calls it for the params the spec left unset; the spec's own value
 * always wins): a held stream reaches where the game's camera rests its crosshair, so on a camera set high and far (a
 * kind's framing) the stream still lands under the crosshair rather than short of it. → {param: value}
 */
export function derive(game = {}, params = {}) {
  if ((params.kind ?? D.kind) !== 'continuous') return {};
  const mode = game.camera ?? 'third', rest = restAimDistance(mode, game.controller?.camera?.[mode] ?? {});
  const want = rest ? Math.min(30, Math.ceil(rest * 1.05)) : 0;
  return want > (params.streamReach ?? D.streamReach) ? { streamReach: want } : {};
}

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.projectile.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  // a value for one player: their own (a loadout, CONTRACT §6e) when the slot is a player look, else the game's
  const VP = (k, p) => { if (!p) return V(k); const sid = `mechanic.projectile.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k], { player: p }) : P[k]; } catch { return P[k]; } };
  const L = { hit: [], end: [], surface: [], fire: [], blocked: [] };
  const targetProviders = [];
  const cool = cooldownGate(V('cooldown'));
  const root = new THREE.Group(); root.name = 'gf-projectiles'; ctx.scene.add(root);
  // a hit effect (the hitFx param): the vfx module is loaded only by a game that asks for it (it is not in every game's gf/three)
  let vfx = null;
  if (P.hitFx) import('../../vfx/index.js').then(m => { vfx = m.vfxOf(ctx); }).catch(e => console.warn(`gf-three projectile: hitFx "${P.hitFx}" needs the vfx module (${e.message})`));
  const prj = new Map();            // host: the shots {id, shooter, seat, x..vz, age, bounces, tag}
  const view = new Map();           // every copy: what is drawn {x, y, z, vx, vy, vz, obj, fresh}
  const lastPos = new Map();        // body key → feet position last frame (the previous raw sample)
  const tank = new Map(), pathCache = new Map(), hitGate = cooldownGate(V('streamHitInterval')), surfGate = cooldownGate(1 / V('surfaceHz'));
  const emitAcc = new Map(), landings = new Map();
  let lastFx = null, S = null, dtNow = 0.016, nextId = 1, lastList = null, tmpl = null, tmplFor = null, loading = false, disposed = false;

  // ---------- drawing: a prop slot or a coloured ball (a kit primitive whose material is the colour slot) ----------
  // The colour is a player look (CONTRACT §6e): tint(p) is that shooter's own colour when they have one, else the
  // game's; every copy draws each player's shots, drops and stream in it (a prop model keeps its own look).
  const tint = (p = null) => VP('color', p);
  const lookMat = (kind, o) => ctx.modules?.look?.material?.(kind, o) ?? null;
  const ballGeo = new THREE.SphereGeometry(1, 16, 12);
  const balls = new Map();          // colour → the ball drawn in it (one shared material per colour)
  function ballOf(color) {
    if (balls.has(color)) return balls.get(color);
    const m = lookMat('prop', { tint: color }) ?? new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    const mesh = new THREE.Mesh(ballGeo, m); mesh.scale.setScalar(V('size')); mesh.castShadow = true;
    ctx.assets.tag(mesh, 'mechanic.projectile.color'); mesh.userData.gfColor = color;
    balls.set(color, mesh); return mesh;
  }
  async function loadTemplate() {
    if (loading) return; loading = true;
    const name = V('prop');
    try {
      if (name && ctx.assets.has(`prop.${name}`)) { tmpl = await ctx.assets.model(`prop.${name}`, { fit: V('size') * 2 }); tmplFor = 'prop'; }
    } catch (e) { console.warn('projectile: prop model failed, drawing a ball', e); }
    if (!tmpl) { tmpl = ballOf(tint()); tmplFor = 'ball'; }
    loading = false;
  }
  const lastBall = new Map();       // shooter id → the colour of the last ball this copy drew for them (QA: lookOf)
  function objFor(shooter = null) {
    if (!tmpl) return null;
    const src = tmplFor === 'ball' ? ballOf(tint(shooter)) : tmpl;
    if (shooter && tmplFor === 'ball') lastBall.set(shooter.id, src.material?.userData?.gfTint ?? `#${src.material?.color?.getHexString?.()}`);
    const o = src.clone(true); o.visible = true; root.add(o); return o;
  }

  // ---------- particles: drops of a stream, splash bursts (one instanced mesh per colour) ----------
  const N = 256;
  const dropGeo = new THREE.IcosahedronGeometry(1, 1);
  const M4 = new THREE.Matrix4(), Q0 = new THREE.Quaternion(), V3 = new THREE.Vector3(), SC = new THREE.Vector3();
  const pools = new Map();          // colour → { mesh, pd, pi }: a shooter with their own colour gets their own drops
  function poolOf(color) {
    let P0 = pools.get(color);
    if (P0) return P0;
    const mat = lookMat('liquid', { tint: color, transparent: true, opacity: 0.9 }) ?? new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.9, roughness: 0.2 });
    const mesh = new THREE.InstancedMesh(dropGeo, mat, N);
    mesh.frustumCulled = false; mesh.name = 'gf-projectile-drops'; mesh.userData.gfColor = color; ctx.assets.tag(mesh, 'mechanic.projectile.color');
    SC.setScalar(0); M4.compose(V3.set(0, -50, 0), Q0, SC); for (let i = 0; i < N; i++) mesh.setMatrixAt(i, M4);
    root.add(mesh);
    P0 = { mesh, pi: 0, pd: Array.from({ length: N }, () => ({ life: 0, max: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s: 0.1, g: 9 })) };
    pools.set(color, P0); return P0;
  }
  poolOf(tint());
  let seedv = 7; const rnd = () => ((seedv = (seedv * 16807) % 2147483647) / 2147483647);     // cosmetic jitter only, never gameplay
  function emit(x, y, z, vx, vy, vz, life, s, g, color = tint()) { const P0 = poolOf(color), p = P0.pd[P0.pi]; P0.pi = (P0.pi + 1) % N; Object.assign(p, { life: 0, max: life, x, y, z, vx, vy, vz, s, g }); }
  function burst(pt, n, speed, size, color = tint()) { for (let i = 0; i < n; i++) { const a = rnd() * 6.283, u = 0.3 + rnd() * 0.7; emit(pt.x, pt.y, pt.z, Math.cos(a) * speed * u, speed * (0.4 + rnd() * 0.8), Math.sin(a) * speed * u, 0.35 + rnd() * 0.3, size * (0.5 + rnd() * 0.6), 14, color); } }
  function stepParticles(dt) {
    for (const { mesh, pd } of pools.values()) {
      for (let i = 0; i < N; i++) {
        const p = pd[i];
        if (p.life >= p.max) { SC.setScalar(0); M4.compose(V3.set(0, -50, 0), Q0, SC); mesh.setMatrixAt(i, M4); continue; }
        p.life += dt; p.vy -= p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.y < 0.03 && p.vy < 0) p.life = p.max;
        const k = Math.max(0, 1 - p.life / p.max * 0.6);
        SC.setScalar(p.s * k); M4.compose(V3.set(p.x, p.y, p.z), Q0, SC); mesh.setMatrixAt(i, M4);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------- helpers ----------
  const players = () => ctx.players.list();
  const ffOn = () => V('friendlyFire') && (ctx.mechanics?.get('teams')?.friendlyFire ?? true);
  const teamOf = p => ctx.mechanics?.get('teams')?.teamOf?.(p) ?? -1;
  const dirOf = p => { const a = p.aim ?? [0, 0, 1]; const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  // where a shot leaves the body (`muzzle`): 1.2 m up and 0.5 m ahead, or ('hips') at this character's hip height and 0.3 m ahead
  const muzzle = (p, d) => {
    const h = Math.hypot(d[0], d[2]) || 1, hips = V('muzzle') === 'hips';
    const up = hips ? (p.character?.hipHeight ?? bodyH() * 0.3) : 1.2, ahead = hips ? 0.3 : 0.5;
    return { x: p.position.x + d[0] / h * ahead, y: p.position.y + up, z: p.position.z + d[2] / h * ahead };
  };
  /** Toward the player's crosshair point: {o (muzzle), d (launch direction), reach, target} or null (no crosshair point). */
  // lift: the shot's centre aims this far above the point, so a ball of that radius touches down on it
  function aimedLaunch(p, speed, gravity, maxTime, lift = 0) {
    const A = aimTarget(p); if (!A) return null;
    const T = { x: A.x, y: A.y + lift, z: A.z };
    let hx = T.x - p.position.x, hz = T.z - p.position.z, R = Math.hypot(hx, hz);
    if (R < 1e-3) { const a = dirOf(p); hx = a[0]; hz = a[2]; R = Math.hypot(hx, hz) || 1; }
    const head = [hx / R, 0, hz / R];
    // a point at the shooter's feet is pushed out to 1.2 m: a shot never turns back into its own shooter
    const tgt = R < 1.2 ? { x: p.position.x + head[0] * 1.2, y: T.y, z: p.position.z + head[2] * 1.2 } : T;
    const o = muzzle(p, head), sol = solveLaunch(o, tgt, speed, gravity, { maxTime });
    return { o, d: sol.dir, reach: sol.reach, target: tgt };
  }
  const bodyH = () => V('bodyHeight');
  function bodies() {
    // a body is where this copy has it: an owned player (the host's own, every bot) is simulated here, a friend is placed
    // from their pose (`drawn`). K1 never sets `drawn` on owned players (kit/net/players.js), so filtering on `drawn`
    // alone dropped the host and every bot: shots flew through them (the 2-player fixture only threw at a joiner).
    const out = players().filter(p => p.alive !== false && (p.owned || p.drawn !== false)).map(p => ({ key: p.id, id: p.id, player: p, cur: { x: p.position.x, y: p.position.y, z: p.position.z }, h: p.character?.height ?? bodyH(), r: 0.45 }));
    for (const pr of targetProviders) for (const t of pr.list()) out.push({ key: `t:${t.id}`, id: t.id, provider: pr, cur: { x: t.x, y: t.y ?? 0, z: t.z }, h: t.height ?? 1.2, r: t.radius ?? 0.5 });
    for (const b of out) b.prev = lastPos.get(b.key) ?? b.cur;
    return out;
  }
  const centre = b => ({ x: b.cur.x, y: b.cur.y + b.h * 0.55, z: b.cur.z });
  const fx = (data) => { ctx.net.send('projectile:fx', data, 'all'); fxLocal(data); };
  function fxLocal(d) {
    lastFx = { k: d.k, p: d.p, t: r2(ctx.time.now) };
    const pt = { x: d.p[0], y: d.p[1], z: d.p[2] };
    const c = tint(typeof d.o === 'string' ? ctx.players?.get?.(d.o) ?? null : null);      // the shooter's colour (`o`: their id)
    if (d.k === 'h' || d.k === 'w') { burst(pt, d.k === 'h' ? 14 : 8, 3.2, V('size') * 0.5 + 0.04, c); ctx.audio?.play(V('soundHit'), { at: pt, optional: true }); }
    if (vfx && (d.k === 'h' || d.k === 'w')) vfx.fx(V('hitFx') || P.hitFx, { at: pt, scale: d.k === 'h' ? 1 : 0.6 });
    if (d.k === 'h' && d.t != null) ctx.players?.get?.(d.t)?.character?.express?.('hurt', 0.7);     // the hit body winces
    if (d.k === 's') burst(pt, 20, 5, 0.1, c);
  }

  // ---------- the host: firing, flight, hits ----------
  function hostFire(shooter, o, d, extra = {}) {
    if (!shooter || shooter.alive === false || V('kind') === 'continuous' && !extra.force) return false;
    if (prj.size >= V('maxActive')) return false;
    if (!cool.ok(shooter.id, ctx.time.now)) return false;
    const v = launchVelocity(d, Math.min(extra.speed ?? V('speed'), MAX_SPEED), extra.arc ?? V('arc'));
    const b = { id: nextId++, shooter, seat: shooter.seat, x: o.x, y: o.y, z: o.z, vx: v[0], vy: v[1], vz: v[2], age: 0, bounces: 0, tag: extra.tag ?? null, meta: extra.meta ?? null, dir: d };
    prj.set(b.id, b);
    for (const fn of L.fire.slice()) try { fn({ shooter, projectile: b, point: o }); } catch (e) { console.error(e); }
    return true;
  }
  const hurt = (shooter, target, amount, impulse, secs, point, source, push) => {
    const hm = ctx.mechanics?.get('health');
    if (V('autoHealth') && hm?.damage && !hm.standin) return hm.damage(target, amount, { from: shooter, impulse, knockSeconds: secs, point, source, push });
    if (impulse) { if (push && ctx.fair?.on) target.push?.(impulse); else target.knock?.(impulse, secs); }
    ctx.fair?.noteHit(target, shooter);
    return true;
  };
  function applyHit(info, b) {
    const { shooter, target, point } = info;
    const pr = b ? { id: b.id, tag: b.tag, meta: b.meta } : null;
    if (info.provider) { try { info.provider.hit?.({ ...info, target: info.targetId }); } catch (e) { console.error(e); } }
    else if (target) {
      // fair play: a hit that can't count does nothing at all, and only onBlocked hears of it
      const why = ctx.fair?.on ? ctx.fair.blocked(target, { from: shooter }) : null;
      if (why) { ctx.fair.refuse(why); for (const fn of L.blocked.slice()) try { fn({ ...info, why, projectile: pr }); } catch (e) { console.error(e); } return false; }
      const stream = info.kind === 'stream';
      const imp = info.impulse ?? knockImpulse(info.dir, stream ? V('streamKnock') : V('knockback'), stream ? 0 : V('knockUp'));
      if (hurt(shooter, target, info.damage, (imp.x || imp.y || imp.z) ? imp : null, stream ? 0 : V('knockSeconds'), point, 'projectile', stream) === false) return false;
    }
    for (const fn of L.hit.slice()) try { fn({ ...info, counted: true, projectile: pr }); } catch (e) { console.error(e); }
    return true;
  }
  function endShot(b, reason, point) {
    prj.delete(b.id);
    if (b.shooter && point) landings.set(b.shooter.id, { x: point.x, y: point.y, z: point.z, at: ctx.time.now, reason });
    for (const fn of L.end.slice()) try { fn({ projectile: { id: b.id, tag: b.tag, meta: b.meta }, shooter: b.shooter, reason, point }); } catch (e) { console.error(e); }
  }
  function hostFlight(dt, list) {
    for (const b of [...prj.values()]) {
      const a0 = { x: b.x, y: b.y, z: b.z };
      b.age += dt; step(b, dt, V('gravity'));
      const a1 = { x: b.x, y: b.y, z: b.z };
      const wall = rayFixed(ctx, a0, a1) ?? (a1.y <= V('size') && a0.y > V('size') ? { t: (a0.y - V('size')) / Math.max(1e-6, a0.y - a1.y), n: [0, 1, 0], point: { x: a1.x, y: V('size'), z: a1.z } } : null);
      // the earliest contact on this step: a body (swept against where it was and where it is) or the world
      let best = null;
      for (const t of list) {
        if (t.player && (b.age < 0.2 && t.player === b.shooter || !canHit(b.shooter, t.player, { friendlyFire: ffOn(), selfHit: V('selfHit'), teamOf }))) continue;
        const h = sweepBody(a0, a1, t.prev, t.cur, t.h, V('size') + t.r);
        if (h && (!best || h.t < best.h.t)) best = { t, h };
      }
      const speed = Math.hypot(b.vx, b.vy, b.vz), dir = [b.vx / (speed || 1), b.vy / (speed || 1), b.vz / (speed || 1)];
      if (best && (!wall || best.h.t <= wall.t)) {
        const pt = { x: a0.x + (a1.x - a0.x) * best.h.t, y: a0.y + (a1.y - a0.y) * best.h.t, z: a0.z + (a1.z - a0.z) * best.h.t };
        const T = best.t;
        applyHit({ kind: 'discrete', shooter: b.shooter, target: T.player ?? null, targetId: T.id, provider: T.provider ?? null, point: pt, dir, speed, damage: V('damage'), splash: false }, b);
        if (V('splashRadius') > 0) splash(b, pt, dir, T.id, list);
        fx({ k: 'h', p: [r2(pt.x), r2(pt.y), r2(pt.z)], t: T.id, ...(b.shooter ? { o: b.shooter.id } : {}) });
        endShot(b, 'hit', pt);
      } else if (wall) {
        for (const fn of L.surface.slice()) try { fn({ kind: 'discrete', shooter: b.shooter, point: wall.point, normal: wall.n, projectile: { id: b.id, tag: b.tag } }); } catch (e) { console.error(e); }
        if (b.bounces < V('bounces')) {
          b.bounces++; const v = bounce([b.vx, b.vy, b.vz], wall.n, V('bounceRestitution'));
          [b.vx, b.vy, b.vz] = v; b.x = wall.point.x + wall.n[0] * 0.02; b.y = wall.point.y + wall.n[1] * 0.02; b.z = wall.point.z + wall.n[2] * 0.02;
          fx({ k: 'w', p: [r2(wall.point.x), r2(wall.point.y), r2(wall.point.z)], ...(b.shooter ? { o: b.shooter.id } : {}) });
        } else {
          if (V('splashRadius') > 0) splash(b, wall.point, dir, null, list);
          fx({ k: 'w', p: [r2(wall.point.x), r2(wall.point.y), r2(wall.point.z)], ...(b.shooter ? { o: b.shooter.id } : {}) });
          endShot(b, 'world', wall.point);
        }
      } else if (b.age > V('lifetime') || Math.abs(b.x) > 200 || Math.abs(b.z) > 200 || b.y < -20) endShot(b, 'expired', a1);
    }
  }
  function splash(b, pt, dir, skipId, list) {
    const cand = list.filter(t => t.id !== skipId && !(t.player && !canHit(b.shooter, t.player, { friendlyFire: ffOn(), selfHit: true, teamOf })));
    for (const s of splashTargets(pt, V('splashRadius'), cand.map(t => { const c = centre(t); return { id: t.id, x: c.x, y: c.y, z: c.z }; }))) {
      const t = cand.find(x => x.id === s.id), c = centre(t);
      const away = [c.x - pt.x, 0, c.z - pt.z]; const dd = Math.hypot(away[0], away[2]) < 0.05 ? dir : away;
      const imp = knockImpulse(dd, V('splashKnockback') * s.falloff, V('knockUp') * s.falloff);
      applyHit({ kind: 'splash', shooter: b.shooter, target: t.player ?? null, targetId: t.id, provider: t.provider ?? null, point: pt, dir, speed: 0, damage: V('damage') * s.falloff, impulse: imp, splash: true, falloff: s.falloff }, b);
    }
  }

  // ---------- continuous: the stream's path (the same on every copy: position + aim), hits on the host ----------
  const streaming = p => (p.owned ? (p.poseExtra?.st ?? 0) > 0.5 : p.isBot ? !!S?.st?.includes(p.id) : (p.pose?.extra?.st ?? 0) > 0.5);
  function pathOf(p) {
    const c = pathCache.get(p.id);
    if (c && ctx.time.now - c.at < 0.05) return c;
    // toward the crosshair point when the player has one (the arc that lands on it within the reach), else along the aim
    const A = aimedLaunch(p, V('streamSpeed'), V('streamGravity'), V('streamReach') / V('streamSpeed'));
    const d = A ? A.d : dirOf(p), o = A ? A.o : muzzle(p, d);
    const pa = streamPath(o, d, V('streamSpeed'), V('streamGravity'), V('streamReach'));
    let end = pa.points[pa.points.length - 1], hit = null, dur = pa.duration;
    for (let i = 1; i < pa.points.length; i++) {
      const w = rayFixed(ctx, pa.points[i - 1], pa.points[i]);
      if (w) { hit = w; end = w.point; dur = (i - 1 + w.t) * (V('streamReach') / V('streamSpeed') / 14); pa.points.length = i; pa.points.push(w.point); break; }
    }
    const out = { at: ctx.time.now, o, d, points: pa.points, end, hit, duration: dur };
    pathCache.set(p.id, out); return out;
  }
  function hostStreams(list) {
    for (const p of players()) {
      if (p.alive === false || !streaming(p)) continue;
      const pa = pathOf(p);
      let best = null;
      for (const t of list) {
        if (t.player === p || t.player && !canHit(p, t.player, { friendlyFire: ffOn(), selfHit: false, teamOf })) continue;
        const c = centre(t);
        for (let i = 1; i < pa.points.length; i++) { const dist = segDist(pa.points[i - 1], pa.points[i], c); if (dist <= t.r + V('streamWidth') + t.h * 0.2) { if (!best || i < best.i) best = { t, i, c }; break; } }
      }
      if (best && hitGate.ok(`${p.id}>${best.t.id}`, ctx.time.now)) {
        applyHit({ kind: 'stream', shooter: p, target: best.t.player ?? null, targetId: best.t.id, provider: best.t.provider ?? null, point: best.c, dir: pa.d, speed: V('streamSpeed'), damage: V('streamDamage'), splash: false }, null);
      }
      if (!best && pa.hit && surfGate.ok(p.id, ctx.time.now)) for (const fn of L.surface.slice()) try { fn({ kind: 'stream', shooter: p, point: pa.hit.point, normal: pa.hit.n, projectile: null }); } catch (e) { console.error(e); }
    }
  }
  // The stream reads as one liquid arc: the look's createStream (a tapered tube on the ballistic arc, in the house
  // 'liquid' material, with droplets that peel off and splash where it lands), one per streaming player, tinted by the
  // colour slot. Without a look module (stand-in, Node) the drops below are the whole stream. Cosmetic only: every copy
  // draws it from the same position + aim (the stream's on/off rides the pose), so nothing new goes on the wire.
  // The front leaves the nozzle at the stream's speed, and on release the tail keeps flying along the same arc and
  // drains into where it was going (a ballistic arc is time-shift invariant, so the segment [t0, t1] is the arc fired
  // from its point at t0 with its velocity at t0).
  const arcs = new Map();           // player id → { s (look stream), live, t (s since on), tail (s since off), o, v, full, groundY, splash }
  const lookMod = () => ctx.modules?.look ?? null;
  const AV = new THREE.Vector3(), AO = new THREE.Vector3();
  function arcFor(p) {
    if (arcs.has(p.id)) return arcs.get(p.id);
    let a = null;
    const make = lookMod()?.createStream;
    if (typeof make === 'function') {
      try {
        const s = make({ tint: tint(p), width: V('streamWidth') * 0.7, droplets: 24, dropScale: 1.1, slot: 'mechanic.projectile.color' });
        s.object3d.name = `gf-projectile-stream:${p.id}`; s.on = false; root.add(s.object3d);
        a = { s, live: false, t: 0, tail: 0, tint: tint(p), o: null, v: null, full: 0, groundY: 0, splash: null };
      } catch (e) { console.warn('projectile: no liquid arc (drops only)', e); }
    }
    arcs.set(p.id, a);
    return a;
  }
  /** Where this copy draws the stream meeting another body (cosmetic: the host's hit test decides the hit). → {T, point} | null */
  function bodyCut(p, pa, segT) {
    let best = null;
    for (const q of players()) {
      if (q === p || q.alive === false || (!q.owned && !q.drawn)) continue;
      const h = q.character?.height ?? bodyH(), c = { x: q.position.x, y: q.position.y + h * 0.55, z: q.position.z }, r = 0.45 + V('streamWidth') + h * 0.2;
      for (let i = 1; i < pa.points.length; i++) {
        const A = pa.points[i - 1], B = pa.points[i];
        if (segDist(A, B, c) > r) continue;
        const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z, l2 = dx * dx + dy * dy + dz * dz;
        const u = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((c.x - A.x) * dx + (c.y - A.y) * dy + (c.z - A.z) * dz) / l2));
        const T = (i - 1 + u) * segT;
        if (!best || T < best.T) best = { T, q, point: { x: A.x + dx * u, y: A.y + dy * u, z: A.z + dz * u } };
        break;
      }
    }
    return best;
  }
  function drawArc(a, t0, t1) {
    if (t1 - t0 < 0.004) { a.s.on = false; return; }
    const g = V('streamGravity'), [vx, vy, vz] = a.v;
    AO.set(a.o.x + vx * t0, a.o.y + vy * t0 - 0.5 * g * t0 * t0, a.o.z + vz * t0);
    AV.set(vx, vy - g * t0, vz);
    a.s.fire(AO, AV, { gravity: g, ground: a.groundY, maxTime: t1 - t0 });
    a.s.on = true;
  }
  function drawStreams(dt) {
    const sp = V('streamSpread'), speed = V('streamSpeed'), segT = V('streamReach') / speed / 14;
    for (const p of players()) {
      const on = streaming(p) && p.alive !== false && (p.owned || p.drawn);
      const a = on ? arcFor(p) : arcs.get(p.id);
      const c = tint(p);                     // this player's stream colour (their own, or the game's)
      if (a && a.tint !== c) { a.tint = c; a.s.setTint(c); }     // a loadout changed: the arc follows at once
      if (!on) {
        emitAcc.delete(p.id);
        if (a?.live) {                       // released: the tail follows the front down the same arc, then it is gone
          a.t += dt; a.tail += dt;
          if (a.tail >= a.full) { a.live = false; a.s.on = false; } else drawArc(a, a.tail, Math.min(a.full, a.t));
          a.s.update(dt);
        }
        continue;
      }
      const pa = pathOf(p);
      const cut = bodyCut(p, pa, segT);
      const end = cut ? cut.point : pa.end;
      const surface = !!cut || !!pa.hit || end.y < 0.15;      // a mid-air end (the reach ran out) does not splash
      // the soaked body winces (its hurt face) once the stream's front reaches it, every copy the same
      if (cut && (!a || a.t >= cut.T)) cut.q.character?.express?.('hurt', 0.35);
      if (a) {
        if (!a.live) { a.live = true; a.t = 0; a.tail = 0; }
        a.t += dt;
        a.o = pa.o; a.v = [pa.d[0] * speed, pa.d[1] * speed, pa.d[2] * speed];
        a.full = Math.max(0.02, cut ? Math.min(cut.T, pa.duration) : pa.duration);
        a.groundY = Math.min(0, end.y) - 0.01;
        a.s.width = V('streamWidth') * 0.7;
        drawArc(a, 0, Math.min(a.full, a.t));
        a.s.update(dt);
      }
      // spray: finer drops along the arc (the whole stream when there is no look module)
      let acc = (emitAcc.get(p.id) ?? 0) + dt * V('streamRate') * (a ? 0.35 : 1);
      for (; acc >= 1; acc -= 1) {
        const d = [pa.d[0] + (rnd() - 0.5) * sp * 2, pa.d[1] + (rnd() - 0.5) * sp * 2, pa.d[2] + (rnd() - 0.5) * sp * 2], l = Math.hypot(d[0], d[1], d[2]) || 1, s = speed * (0.92 + rnd() * 0.16);
        emit(pa.o.x, pa.o.y, pa.o.z, d[0] / l * s, d[1] / l * s, d[2] / l * s, Math.max(0.1, a ? a.full : pa.duration), V('streamWidth') * (a ? 0.45 : 1), V('streamGravity'), c);
      }
      emitAcc.set(p.id, acc);
      // the splash where it lands, once the front has got there
      if (surface && (!a || a.t >= a.full) && rnd() < dt * (a ? 14 : 9)) burst(end, a ? 3 : 2, 2.4, V('streamWidth') * (a ? 0.6 : 0.8), c);
    }
  }

  // ---------- every copy: draw the shots from the host's snapshot ----------
  function syncView(dt) {
    const list = S.l;
    if (list !== lastList) {                        // a new snapshot arrived (a new object per receipt)
      lastList = list;
      const seen = new Set();
      for (const e of list ?? []) {
        seen.add(e[0]);
        let v = view.get(e[0]);
        if (!v) {
          const who = players().find(p => p.seat === e[7]);       // the edge: a new shot appeared
          v = { x: e[1], y: e[2], z: e[3], vx: e[4], vy: e[5], vz: e[6], obj: null, spin: rnd() * 6, who: who ?? null }; view.set(e[0], v);
          if (!ctx.host && who && !who.local) { ctx.audio?.play(V('soundFire'), { at: { x: e[1], y: e[2], z: e[3] }, optional: true }); }
          if (!ctx.host) for (const fn of L.fire.slice()) try { fn({ shooter: who ?? null, projectile: { id: e[0] }, point: { x: e[1], y: e[2], z: e[3] } }); } catch (er) { console.error(er); }
        } else { v.x += (e[1] - v.x) * 0.6; v.y += (e[2] - v.y) * 0.6; v.z += (e[3] - v.z) * 0.6; v.vx = e[4]; v.vy = e[5]; v.vz = e[6]; }
      }
      for (const [k, v] of view) if (!seen.has(k)) { v.obj?.removeFromParent(); view.delete(k); }
    }
    for (const v of view.values()) {
      if (!ctx.host) { v.vy -= V('gravity') * dt; v.x += v.vx * dt; v.y += v.vy * dt; v.z += v.vz * dt; }
      if (!v.obj) v.obj = objFor(v.who);
      if (v.obj) { v.obj.position.set(v.x, v.y, v.z); v.spin += dt * 9; v.obj.rotation.set(v.spin, v.spin * 0.7, 0); }
    }
  }
  function hostView() {                              // the host draws its own simulation directly
    const seen = new Set();
    for (const b of prj.values()) {
      seen.add(b.id);
      let v = view.get(b.id); if (!v) { v = { obj: null, spin: rnd() * 6 }; view.set(b.id, v); }
      Object.assign(v, { x: b.x, y: b.y, z: b.z });
      if (!v.obj) v.obj = objFor(b.shooter);
      if (v.obj) { v.obj.position.set(b.x, b.y, b.z); v.spin += 0.15; v.obj.rotation.set(v.spin, v.spin * 0.7, 0); }
    }
    for (const [k, v] of view) if (!seen.has(k)) { v.obj?.removeFromParent(); view.delete(k); }
  }

  const api = {
    id, params: P,
    /** An aimed mechanic: the kit shows the crosshair and turns the shooter to the aim while firing (CONTRACT §6d). */
    aimed: true,
    /** Throw at the player's crosshair point (default; the arc that lands there), or along `dir` with the `arc` lob. An
     *  owned player, or any bot on the host. → true when a shot left. opts: {speed, tag, meta (host only)} */
    fire(p, dir = null, opts = {}) {
      if (!S || !p || !(p.owned || ctx.host) || p.alive === false) return false;
      const speed = Math.min(opts.speed ?? V('speed'), MAX_SPEED);
      const A = dir ? null : aimedLaunch(p, speed, V('gravity'), V('lifetime'), V('size'));
      const d = A ? A.d : dir ? (Array.isArray(dir) ? dir : [dir.x, dir.y, dir.z]) : dirOf(p), o = A ? A.o : muzzle(p, d);
      if (ctx.host) {
        if (!hostFire(p, o, d, A ? { ...opts, arc: 0 } : opts)) return false;
      } else {
        if (!cool.ok(`local:${p.id}`, ctx.time.now)) return false;
        ctx.net.send('projectile:fire', { o: p.id, p: [r2(o.x), r2(o.y), r2(o.z)], d: d.map(v => Math.round(v * 1000) / 1000), ...(A ? { a: 0 } : {}), ...(opts.tag !== undefined ? { tag: opts.tag } : {}), ...(opts.speed ? { sp: opts.speed } : {}) }, 'host');
      }
      p.act?.(V('fireAnim'), 0.35);
      if (p.owned) ctx.audio?.play(V('soundFire'), { at: o, optional: true });
      return true;
    },
    /** Continuous: hold the stream on or off for an owned player (call every frame; costs nothing on the wire but the pose). */
    stream(p, on) {
      if (!p?.owned) return false;
      let t = tank.get(p.id) ?? 1; const T = V('streamTank');
      const want = on && p.alive !== false && (T <= 0 || t > 0.001) ? 1 : 0;
      if (T > 0) { const dt = dtNow; t = want ? Math.max(0, t - dt / T) : Math.min(1, t + dt * V('streamRefill')); tank.set(p.id, t); }
      p.poseExtra.st = want;
      return want === 1;
    },
    /** Is this player's stream running (on any copy). */
    streaming: p => !!S && streaming(p),
    /** Tank level 0..1 of an owned player (1 when unlimited). */
    tankOf: p => (V('streamTank') > 0 ? (tank.get(p.id) ?? 1) : 1),
    /** What this copy draws a player's shots in (CONTRACT §6e, QA): {color: their own or the game's, stream: the colour
     *  of the liquid arc drawn for them (its material's tint; null before they first stream), drops: the colour of their
     *  spray drops' material when this copy has drawn any, ball: the last ball's material colour (null before one flew)}. */
    lookOf(p) {
      const a = arcs.get(p?.id), c = tint(p);
      let stream = null;
      a?.s?.object3d?.traverse?.(o => { const m = Array.isArray(o.material) ? o.material[0] : o.material; if (stream === null && m?.userData && 'gfTint' in m.userData) stream = m.userData.gfTint; });
      const pool = pools.get(c);
      return { color: c, stream: a ? (stream ?? a.tint) : null, drops: pool ? (pool.mesh.material.userData?.gfTint ?? '#' + pool.mesh.material.color.getHexString()) : null, ball: lastBall.get(p?.id) ?? null };
    },
    /** The last hit effect this copy showed {k: 'h'|'w'|'s', p: [x, y, z]}: the same on every copy (for tests and sounds). */
    get lastFx() { return lastFx; },
    /** Where a player's stream ends right now (this copy's computation from position and aim) or null. */
    pathEnd: p => (S && streaming(p) ? { ...pathOf(p).end } : null),
    /** Where this player's shots land: the stream's end while it runs, else (host) where their last shot ended {x, y, z, at}. */
    landing: p => (S && streaming(p) ? { ...pathOf(p).end, at: ctx.time.now } : landings.get(p?.id) ?? null),
    /** Shots in flight (host: the simulation; others: what is drawn). */
    active: () => (ctx.host ? prj.size : view.size),
    /** Host: listen for hits that counted {kind, shooter, target|null, targetId, point, dir, damage, splash, counted: true, projectile:{id, tag, meta}}.
     *  A hit fair play refused (the target down, protected or out; the start grace; too many bots on one human) never comes here. → unsubscribe */
    onHit(fn) { L.hit.push(fn); return unsub(L.hit, fn); },
    /** Host: hits fair play refused {…the hit, why: 'out'|'down'|'protected'|'grace'|'busy'} (a "protected!" effect, QA). Never score these. */
    onBlocked(fn) { L.blocked.push(fn); return unsub(L.blocked, fn); },
    /** Host: a shot ended {projectile, shooter, reason: 'hit'|'world'|'expired', point}. */
    onEnd(fn) { L.end.push(fn); return unsub(L.end, fn); },
    /** Host: the world was hit {kind, shooter, point, normal, projectile}; a stream reports about surfaceHz times a second. */
    onSurface(fn) { L.surface.push(fn); return unsub(L.surface, fn); },
    /** Every copy: a shot appeared {shooter, projectile, point} (sounds, muzzle flashes). */
    onFire(fn) { L.fire.push(fn); return unsub(L.fire, fn); },
    /** Host: make other things hittable (enemies). provider: {list() → [{id, x, y, z, radius, height}], hit(info)}. */
    addTargets(provider) { targetProviders.push(provider); return unsub(targetProviders, provider); },
    clear() { prj.clear(); },
    reset() { prj.clear(); view.forEach(v => v.obj?.removeFromParent()); view.clear(); lastList = null; cool.reset(); hitGate.reset(); surfGate.reset(); tank.clear(); lastPos.clear(); landings.clear(); for (const a of arcs.values()) if (a) { a.live = false; a.s.on = false; a.s.update(0); } },
    update(dt) {
      dtNow = Math.min(0.1, dt);
      if (!S) { if (!(ctx.shared && ctx.players && ctx.me)) return; S = ctx.shared.register('prj', { l: [], st: [] }); loadTemplate(); }
      if (!tmpl && !loading) loadTemplate();
      const playing = ctx.round?.phase === 'playing';
      if (ctx.host) {
        if (playing) {
          const list = bodies();
          hostFlight(Math.min(dt, 0.05), list);
          hostStreams(list);
          for (const b of list) lastPos.set(b.key, b.cur);
        } else prj.clear();
        S.l = [...prj.values()].map(b => [b.id, r2(b.x), r2(b.y), r2(b.z), r1(b.vx), r1(b.vy), r1(b.vz), b.seat]);
        S.st = players().filter(p => p.isBot && p.owned && (p.poseExtra?.st ?? 0) > 0.5).map(p => p.id);
        hostView();
      } else syncView(dt);
      drawStreams(dt);
      stepParticles(dt);
    },
    /** `projectile:fire` (a player's copy asks the host) and `projectile:fx` (the host tells everyone a hit happened). */
    event(name, data, from) {
      if (name === 'fx' && !ctx.host) fxLocal(data);
      else if (name === 'fire' && ctx.host && S) {
        const sh = ctx.players.get(data?.o);
        if (!sh || sh.isBot || (ctx.net.active && from !== undefined && from !== sh.id)) return;
        const d = Array.isArray(data.d) && data.d.length === 3 && data.d.every(Number.isFinite) ? data.d : dirOf(sh);
        let o = Array.isArray(data.p) && data.p.length === 3 && data.p.every(Number.isFinite) ? { x: data.p[0], y: data.p[1], z: data.p[2] } : muzzle(sh, d);
        if (Math.hypot(o.x - sh.position.x, o.z - sh.position.z) > 3) o = muzzle(sh, d);
        hostFire(sh, o, d, { tag: data.tag, speed: Number.isFinite(data.sp) ? data.sp : undefined, ...(data.a === 0 ? { arc: 0 } : {}) });
      }
    },
    dispose() { disposed = true; for (const a of arcs.values()) a?.s.dispose(); arcs.clear(); root.removeFromParent(); },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs MANIFEST lists the fields): what `create` composes and refuses by, what the
// catalog tells a pitch, the handlers and traps of the rules.js stub, and verify check 15's sign of life. The tools
// read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, examples, params,
  describe: 'Discrete and continuous streams, arcs, hits, splash',
  rank: 10,
  needs: { parts: [], world: [] },
  uses: ['health', 'teams', 'paint', 'waves', 'boss', 'carry'],
  // its thing (kit/assets/items.js): one kind of shot or stream, the mechanic's own params
  items: [{ single: true, noun: 'shot', fields: ['damage', 'speed', 'cooldown', 'knockback', 'size', 'arc', 'splashRadius', 'streamDamage', 'streamReach', 'streamTank', 'color'], front: ['damage', 'speed', 'cooldown'],
    picture: p => (p.prop ? `prop.${p.prop}` : 'mechanic.projectile.color') }],
  owns: () => [],
  state: { key: 'prj', fields: { l: '[[id, x, y, z, vx, vy, vz, seat]] shots in flight', st: 'bots that are streaming' } },
  events: [
    { name: 'onHit', on: 'host', args: '{ kind: \'discrete\' | \'stream\' | \'splash\', shooter, target | null, point, dir, damage, counted, projectile }', when: 'a hit that counted (fair play let it through)' },
    // quiet: nothing on screen answers it by itself (verify gate C, measure 38, does not look for an answer): a refused
    // hit is fair play's, and a shot's end and its touch of the world are answered by the hit or the paint they make
    { name: 'onBlocked', on: 'host', args: '{ kind, shooter, target, why, projectile }', when: 'fair play refused a hit', quiet: true },
    { name: 'onEnd', on: 'host', args: '{ projectile: { id, tag, meta }, shooter, reason, point }', when: 'a shot ended (hit, wall, lifetime)', quiet: true },
    { name: 'onSurface', on: 'host', args: '{ kind: \'discrete\' | \'stream\', shooter, point, normal, projectile }', when: 'the world was hit (paint listens)', quiet: true },
    { name: 'onFire', on: 'every copy', args: '{ shooter, projectile, point }', when: 'a shot left a muzzle' },
  ],
  sync: { owner: 'host', how: 'the host owns every shot and every hit; a copy owns its own aim, trigger and tank' },
  note: [
    'Nothing fires by itself: rules.js calls prj.fire(p) on a press, or prj.stream(p, down) every frame for a stream, for the player and for each bot.',
    'Shots land on the crosshair point. With the health mechanic a hit damages and knocks; waves and the boss register themselves as targets.',
    'Score in onHit (host): it hears counted hits only, so a helpless player is never farmed.',
  ],
  stub: {
    as: 'prj',
    worked: 'update(ctx) { if (ctx.me.actions.primary.pressed) prj.fire(ctx.me); }   // continuous: prj.stream(ctx.me, ctx.me.actions.primary.down)',
    traps: [
      'prj.stream(p, on) is called every frame for an owned player, with on false too: a stream nobody turns off keeps running',
      'a bot fires only when the rules make it: in bot(ctx, p) use ctx.bots.attack(p, target)',
    ],
  },
  signs: {
    sample: sh => (sh.prj ? { prj: [(sh.prj.l ?? []).length, (sh.prj.st ?? []).length] } : null),
    judge: v => {
      const o = v.others, w = v.waves;
      const hit = w?.enemyHpDrop || w?.kills > 0 || o.hpFell || o.down || o.paintChanged;
      if (!o.fired) v.add('shots fly', 'dead', 'shared.prj.l and .st', `no shot or stream was ever in flight on any page (${v.names})`, 'rules must fire: prj.fire(p) on primary for the player, and for bots in rules.bot (or ctx.bots.attack)');
      else if (hit) v.add('a hit lands', 'ok', 'enemy hp, shared.hp.h, players down, paint', [w?.kills ? 'enemies killed' : '', o.hpFell ? 'hit points fell' : '', o.down ? 'players knocked down' : '', o.paintChanged ? 'paint changed' : ''].filter(Boolean).join(', ') || 'enemies hurt');
      else v.add('a hit lands', 'dead', 'enemy hp, shared.hp.h, players down, paint', `shots flew but nothing they hit changed on any page (${v.names}): no hit points fell, nobody went down${v.has('paint') ? ', no paint changed' : ''}`, 'check damage and knockback in mechanics[projectile].params and that rules.bot aims at someone (ctx.bots.attack)');
    },
  },
};
