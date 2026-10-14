// mechanic: boss (track M, gf-scenic wave 1). One big enemy with phases at hit-point thresholds and telegraphed
// attacks: slam (a ring that fills), charge (a lane), volley (a fan of slow bolts), summon (the waves mechanic's
// types). Its name and health are a big bar across the top of the HUD. It is hit by melee and by shots, and its hits
// read (a flash, a flinch when it is not attacking, the bar). README.md has the network ownership and the API.
//
//   const boss = ctx.mechanics.get('boss');
//   boss.begin({x, z});        // host: it comes (the levels mechanic calls this on the last level)
//   boss.state();              // every copy: {active, name, hp, max, phase, phases, attack, dead}
//   boss.onPhase(fn); boss.onDown(fn);   // host
//
// Creator, 2026-10-08 (the roguelike miss): "the boss was the same zombie as the minions". The boss has its own body
// role (character.body.boss) and scale, phases, and attacks a player can read and dodge.
import * as THREE from 'three';
import { BST, ACODE, ANAME, ATTACK_DEFAULTS, phaseFor, attacksFor, nextAttack, slamPoint, slamTargets, chargeTargets, volleyYaws } from './logic.js';
import { hurtEnemy, flashAt, deathPose } from '../waves/logic.js';
import { arenaPoint } from '../waves/types.js';
import { feelOf } from '../melee/feel.js';
import { hold, gripOf } from '../melee/held.js';

export const id = 'boss';
export const examples = ['a giant skeleton king on the last island', 'a boss with a slam, a charge and a volley', 'a final guardian that calls minions'];

const D = {
  name: 'The Warden', role: 'boss', height: 3.4, radius: 1.0, hp: 60, hpPerPlayer: 0.6, speed: 2.5, color: '#b8413a',
  phases: [0.6, 0.3], attacks: [['slam', 'charge'], ['slam', 'volley', 'charge', 'summon'], ['volley', 'slam', 'charge', 'summon']],
  slam: ATTACK_DEFAULTS.slam, charge: ATTACK_DEFAULTS.charge, volley: ATTACK_DEFAULTS.volley, summon: ATTACK_DEFAULTS.summon,
  cooldown: 1.3, phaseSpeed: 0.15, phaseWindup: 0.12, maxMinions: 4, introSeconds: 1.8, roarSeconds: 1.4, startDelay: 3, auto: 'auto',
  weapon: '', weaponGrip: null, killPoints: 100, barColor: '#ff5a4a', telegraphColor: '#ff3b2f', flashColor: '#ffffff', deathSeconds: 3,
  soundRoar: 'boss-roar', soundSlam: 'boss-slam', soundDown: 'boss-down', soundWindup: 'enemy-windup',
};
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
const ATK_SCHEMA = { type: 'object', additionalProperties: true };
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    name: { type: 'string', default: D.name, description: 'The boss\'s name on its HUD bar' },
    role: { type: 'string', default: D.role, description: 'Character role whose body (character.body.<role>) draws it; else the waves enemy body, scaled; else a stand-in' },
    height: { ...num('Height (m)', 1, 10), default: D.height },
    radius: { ...num('Body radius for hits (m)', 0.4, 4), default: D.radius },
    hp: { ...num('Hit points (alone)', 1, 2000), default: D.hp },
    hpPerPlayer: { ...num('Extra hit points per player beyond the first (fraction)', 0, 3), default: D.hpPerPlayer },
    speed: { ...num('Walking speed (m/s)', 0.3, 10), default: D.speed },
    color: { type: 'string', default: D.color, description: 'Tint (and the stand-in\'s colour)' },
    phases: { type: 'array', items: { type: 'number' }, default: D.phases, description: 'Hit-point shares where it changes phase (0.6, 0.3: three phases)' },
    attacks: { type: 'array', default: D.attacks, description: 'Each phase\'s attacks in order: slam, charge, volley, summon' },
    slam: { ...ATK_SCHEMA, default: D.slam, description: '{windup, radius, ahead, damage, knock, recover}' },
    charge: { ...ATK_SCHEMA, default: D.charge, description: '{windup, speed, length, width, damage, knock, recover}' },
    volley: { ...ATK_SCHEMA, default: D.volley, description: '{windup, count, spread (degrees), speed, damage, recover}' },
    summon: { ...ATK_SCHEMA, default: D.summon, description: '{windup, count, types (the waves mechanic\'s type ids), recover}' },
    cooldown: { ...num('Seconds between attacks', 0.2, 10), default: D.cooldown },
    phaseSpeed: { ...num('Speed gained each phase (fraction)', 0, 1), default: D.phaseSpeed },
    phaseWindup: { ...num('Windup shortened each phase (fraction)', 0, 0.5), default: D.phaseWindup },
    maxMinions: { type: 'integer', minimum: 0, maximum: 16, default: D.maxMinions, description: 'No summon while this many enemies are up' },
    introSeconds: { ...num('Seconds it stands before it fights', 0, 10), default: D.introSeconds },
    roarSeconds: { ...num('Seconds it roars (and takes no hits) as a phase begins', 0, 5), default: D.roarSeconds },
    startDelay: { ...num('Without the levels mechanic: seconds into the round before it comes', 0, 600), default: D.startDelay },
    auto: { type: ['string', 'boolean'], enum: ['auto', true, false], default: D.auto, description: 'auto: it comes by itself when the game has no levels mechanic' },
    killPoints: { ...num('Score for the player who brings it down', 0, 10000), default: D.killPoints },
    weapon: { type: 'string', default: D.weapon, description: 'A file in assets/models/ it holds on hand_r (slot mechanic.boss.weapon), e.g. a KayKit staff' },
    weaponGrip: { type: ['object', 'null'], default: D.weaponGrip, description: 'The weapon\'s place on the hand_r socket {position, quaternion} (research/gf-scenic/library/props.json)' },
    barColor: { type: 'string', default: D.barColor }, telegraphColor: { type: 'string', default: D.telegraphColor }, flashColor: { type: 'string', default: D.flashColor },
    deathSeconds: { ...num('Seconds it takes to fall and sink away', 1, 8), default: D.deathSeconds },
    soundRoar: { type: 'string', default: D.soundRoar }, soundSlam: { type: 'string', default: D.soundSlam }, soundDown: { type: 'string', default: D.soundDown }, soundWindup: { type: 'string', default: D.soundWindup },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.boss.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : type === 'text' ? 'text' : 'gameplay', ...extra });
export const slots = [
  vs('name', 'Boss name', 'text', { tier: 'main', rank: 72, constraints: { maxLength: 32 } }),
  vs('hp', 'Boss hit points', 'number', { tier: 'main', rank: 70, constraints: { min: 1, max: 2000 } }),
  vs('height', 'Boss height', 'number', { tier: 'main', rank: 62, constraints: { min: 1, max: 10, unit: 'm' } }),
  vs('color', 'Boss tint', 'color', { tier: 'main', rank: 58 }),
  vs('barColor', 'Boss health bar colour', 'color', { rank: 44 }),
  vs('telegraphColor', 'Boss attack warning colour', 'color', { rank: 42 }),
  vs('flashColor', 'Boss hit flash colour', 'color', { rank: 20 }),
  vs('speed', 'Boss speed', 'number', { constraints: { min: 0.3, max: 10, unit: 'm/s' } }),
  vs('cooldown', 'Seconds between boss attacks', 'number', { constraints: { min: 0.2, max: 10, unit: 's' } }),
  vs('killPoints', 'Score for the boss', 'number', { constraints: { min: 0, max: 10000 } }),
  vs('roarSeconds', 'Boss roar between phases', 'number', { constraints: { min: 0, max: 5, unit: 's' } }),
  ...['soundRoar', 'soundSlam', 'soundDown'].map(k => vs(k, `Boss ${k.slice(5).toLowerCase()} sound id`, 'text', { constraints: { maxLength: 40 } })),
];
/** The base slots, plus one per attack number the game's config holds (mechanic.boss.<attack>.<field>), and its weapon. */
export function slotsFor(m = {}, cfg = {}) {
  const P = m.params ?? {}, out = [...slots];
  if (typeof P.weapon === 'string' && P.weapon && (cfg.files ?? []).includes(`assets/models/${P.weapon}`)) out.push({ id: 'mechanic.boss.weapon', label: 'Boss weapon', group: 'mechanics', type: 'model', source: { file: `assets/models/${P.weapon}` }, tier: 'advanced', rank: 50, facet: 'look', constraints: { maxBytes: 4194304 }, generate: { prompt: 'the weapon the boss holds', style: 'stylised low-poly game prop, clean silhouette' } });
  for (const a of ['slam', 'charge', 'volley', 'summon']) for (const [k, v] of Object.entries(P[a] ?? {})) if (typeof v === 'number') out.push({ id: `mechanic.boss.${a}.${kebab(k)}`, label: `Boss ${a}: ${k}`, group: 'mechanics', type: 'number', source: { pointer: `{base}/${a}/${k}` }, tier: 'advanced', facet: 'gameplay', constraints: { min: 0, max: Math.max(100, v) } });
  return out;
}

const r2 = v => Math.round(v * 100) / 100;
const DEG = Math.PI / 180;
const qaParam = name => { try { return new URLSearchParams(globalThis.location?.search ?? '').get(name); } catch { return null; } };
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.boss.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const A = name => { const base = { ...ATTACK_DEFAULTS[name], ...(P[name] ?? {}) }; for (const k of Object.keys(base)) { const sid = `mechanic.boss.${name}.${kebab(k)}`; if (typeof base[k] === 'number') try { if (ctx.assets?.has(sid)) base[k] = Number(ctx.assets.value(sid, base[k])); } catch {} } return base; };
  const L = { phase: [], down: [], hit: [] };
  const feel = feelOf(ctx);
  const root = new THREE.Group(); root.name = 'gf-boss'; ctx.scene.add(root);
  const M = id => { const m = ctx.mechanics?.get?.(id); return m && !m.standin ? m : null; };
  // host
  const b = { active: false, x: 0, z: 0, hp: 0, max: 0, phase: 0, st: BST.idle, t: 0, atk: 0, atkYaw: 0, tx: 0, tz: 0, cd: 1, pat: 0, facing: 0, hits: 0, runD: 0, hitIds: new Set(), killer: null, autoAt: null };
  let S = null, hitsSeen = 0, phasesSeen = 0, lastHit = null, attacksDone = 0;
  // every copy's view
  const v = { obj: null, character: null, making: false, x: 0, z: 0, yaw: 0, hp: 0, max: 0, st: BST.idle, phase: 0, atk: 0, tx: 0, tz: 0, atkYaw: 0, hitT: 9, deadT: 0, teleT: 0, freezeT: 0, predAt: -9, tele: null, born: 0, shown: false };

  const row = () => (ctx.host ? [b.active ? 1 : 0, r2(b.x), r2(b.z), Math.round(b.hp * 10) / 10, b.max, b.phase, b.st, b.atk, Math.round(b.facing / DEG), r2(b.tx), r2(b.tz), Math.round(b.atkYaw / DEG)] : S?.a ?? null);
  const playersUp = () => ctx.players.list().filter(p => p.alive !== false && (p.owned || p.drawn));
  const phaseCount = () => (V('phases')?.length ?? 0) + 1;
  const levelCircle = () => { const lv = ctx.world?.levels?.[ctx.world.level ?? 0]; return lv ? { x: lv.at?.[0] ?? 0, z: lv.at?.[2] ?? 0, r: Math.max(3, (lv.radius ?? 12) - 1.4) } : null; };
  const keepIn = (x, z) => { const c = levelCircle(); if (!c) { const h = ctx.world?.half ?? 20; return { x: Math.max(-h, Math.min(h, x)), z: Math.max(-h, Math.min(h, z)) }; } const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz); return d > c.r ? { x: c.x + dx / d * c.r, z: c.z + dz / d * c.r, edge: true } : { x, z }; };

  // ---------- host ----------
  function begin(at = null) {
    if (!ctx.host) return;
    const zone = ctx.world?.zone?.('boss') ?? ctx.world?.zone?.('arena') ?? ctx.world?.zone?.('centre');
    const p = at ?? (zone ? { x: zone.at?.x ?? zone.at?.[0] ?? 0, z: zone.at?.z ?? zone.at?.[2] ?? 0 } : { x: 0, z: 0 });
    const hp = Math.round(V('hp') * (1 + V('hpPerPlayer') * Math.max(0, ctx.players.list().length - 1)));
    // QA's staged moment ?gf-demo=boss.phase (verify check 15): it comes with its hit points just above its first phase
    // threshold, so a few real hits change its phase
    const start = qaParam('gf-demo') === 'boss.phase' && V('phases')?.length ? Math.ceil(hp * Math.min(1, Math.max(...V('phases')) + 0.05)) : hp;
    Object.assign(b, { active: true, x: p.x, z: p.z, hp: start, max: hp, phase: 0, st: BST.intro, t: 0, atk: 0, cd: V('cooldown'), pat: 0, hits: 0, runD: 0, killer: null });
    const t = playersUp()[0]; b.facing = t ? Math.atan2(t.position.x - b.x, t.position.z - b.z) : 0;
    b.hitIds.clear();
  }
  function hitPlayer(p, { damage, knock, dir, knockdown = true }) {
    if (M('melee')?.dodging?.(p)) return false;
    const l = Math.hypot(dir.x, dir.z) || 1, imp = { x: dir.x / l * knock, y: knockdown ? 4.5 : 1, z: dir.z / l * knock };
    const hm = M('health');
    if (hm?.damage) return hm.damage(p, damage, { from: null, impulse: imp, source: 'boss', push: !knockdown }) !== false;
    if (ctx.fair?.on) { const why = ctx.fair.blocked(p); if (why) { ctx.fair.refuse(why); return false; } }
    if (knockdown) p.knock?.(imp, 0.8); else p.push?.(imp);
    return true;
  }
  function startAttack(target) {
    const list = attacksFor(V('attacks'), b.phase);
    const minions = M('waves')?.state?.().alive ?? 0;
    const d = target ? Math.hypot(target.x - b.x, target.z - b.z) : 6;
    const n = nextAttack(list, b.pat, { minions, maxMinions: V('maxMinions'), distance: d });
    b.pat = n.index; b.atk = ACODE[n.attack]; b.st = BST.windup; b.t = 0;
    b.atkYaw = target ? Math.atan2(target.x - b.x, target.z - b.z) : b.facing;
    const s = slamPoint(b, b.atkYaw, A('slam').ahead); b.tx = s.x; b.tz = s.z;
  }
  const windupOf = name => A(name).windup * Math.max(0.5, 1 - V('phaseWindup') * b.phase);
  function hostStep(dt) {
    if (!b.active) return;
    b.t += dt;
    if (b.st === BST.dead) return;
    const ups = playersUp();
    let target = null, bd = Infinity;
    for (const p of ups) { const d = Math.hypot(p.position.x - b.x, p.position.z - b.z); if (d < bd) { bd = d; target = { x: p.position.x, z: p.position.z, id: p.id }; } }
    const toT = target ? Math.atan2(target.x - b.x, target.z - b.z) : b.facing;
    const turn = (yaw, rate) => { b.facing += wrap(yaw - b.facing) * Math.min(1, dt * rate); };
    const speed = V('speed') * (1 + V('phaseSpeed') * b.phase);
    switch (b.st) {
      case BST.intro: turn(toT, 3); if (b.t >= V('introSeconds')) { b.st = BST.chase; b.t = 0; } break;
      case BST.roar: if (b.t >= V('roarSeconds')) { b.st = BST.chase; b.t = 0; b.cd = 0.4; } break;
      case BST.chase: {
        turn(toT, 5);
        b.cd -= dt;
        if (target && bd > A('slam').ahead + 0.8) { const c = keepIn(b.x + Math.sin(b.facing) * speed * dt, b.z + Math.cos(b.facing) * speed * dt); b.x = c.x; b.z = c.z; }
        if (b.cd <= 0 && target) startAttack(target);
        break;
      }
      case BST.windup: {
        const name = ANAME[b.atk], w = windupOf(name);
        if (target && b.t < w * 0.55) { b.atkYaw = toT; const s = slamPoint(b, b.atkYaw, A('slam').ahead); b.tx = s.x; b.tz = s.z; }
        turn(b.atkYaw, 10);
        if (b.t >= w) { b.st = BST.attack; b.t = 0; b.runD = 0; b.hitIds.clear(); attacksDone++; fire(name, ups); }
        break;
      }
      case BST.attack: {
        const name = ANAME[b.atk];
        if (name === 'charge') {
          const C = A('charge'), step = C.speed * dt, a = { x: b.x, z: b.z };
          const c = keepIn(b.x + Math.sin(b.atkYaw) * step, b.z + Math.cos(b.atkYaw) * step);
          b.x = c.x; b.z = c.z; b.runD += step; b.facing = b.atkYaw;
          for (const pid of chargeTargets(a, c, C.width, ups.map(p => ({ id: p.id, x: p.position.x, z: p.position.z })))) {
            if (b.hitIds.has(pid)) continue; b.hitIds.add(pid);
            const p = ctx.players.get(pid); if (p) hitPlayer(p, { damage: C.damage, knock: C.knock, dir: { x: Math.sin(b.atkYaw), z: Math.cos(b.atkYaw) } });
          }
          if (b.runD >= C.length || c.edge) { b.st = BST.recover; b.t = 0; }
        } else if (b.t >= 0.25) { b.st = BST.recover; b.t = 0; }
        break;
      }
      case BST.recover: {
        const rec = A(ANAME[b.atk] ?? 'slam').recover ?? 0.8;
        if (b.t >= rec) { b.st = BST.chase; b.t = 0; b.cd = V('cooldown') * Math.max(0.5, 1 - 0.12 * b.phase); }
        break;
      }
    }
  }
  function fire(name, ups) {
    const targets = ups.map(p => ({ id: p.id, x: p.position.x, z: p.position.z }));
    if (name === 'slam') {
      const S0 = A('slam');
      for (const pid of slamTargets({ x: b.tx, z: b.tz }, S0.radius, targets)) { const p = ctx.players.get(pid); if (p) hitPlayer(p, { damage: S0.damage, knock: S0.knock, dir: { x: p.position.x - b.tx, z: p.position.z - b.tz } }); }
    } else if (name === 'volley') {
      const Vo = A('volley'), waves = M('waves');
      for (const y of volleyYaws(b.atkYaw, Math.round(Vo.count), Vo.spread)) waves?.fireBolt?.({ x: b.x + Math.sin(y) * (V('radius') + 0.3), z: b.z + Math.cos(y) * (V('radius') + 0.3) }, y, { speed: Vo.speed, damage: Vo.damage, radius: 0.34 });
    } else if (name === 'summon') {
      const Su = A('summon'), waves = M('waves');
      const types = (Array.isArray(Su.types) && Su.types.length ? Su.types : (waves?.types ?? []).slice(0, 1).map(t => t.id));
      for (let i = 0; i < Math.round(Su.count); i++) {
        const at = arenaPoint({ at: [b.x, 0, b.z], size: [4.5] }, () => ctx.rng(), { inner: 0.5, outer: 1, avoid: targets, away: 2.5 });
        const c = keepIn(at.x, at.z);
        waves?.spawnType?.(types[i % Math.max(1, types.length)] ?? 0, { x: c.x, z: c.z }, { hpScale: 1 });
      }
    }
  }
  /** Host: hurt the boss (melee, shots, rules). → true when it counted. opts {from, impulse, kind, heavy} */
  function damage(n, opts = {}) {
    if (!ctx.host || !b.active || b.st === BST.dead || b.st === BST.intro || b.st === BST.roar) return false;
    const r = hurtEnemy(b, n, { now: ctx.time.now });
    if (r.hit) b.hits++;
    for (const fn of L.hit.slice()) try { fn({ amount: n, from: opts.from ?? null, hp: b.hp }); } catch (e) { console.error(e); }
    if (b.hp <= 0) {
      b.st = BST.dead; b.t = 0; b.killer = opts.from ?? null;
      if (opts.from && opts.from.score !== undefined) opts.from.score += V('killPoints');
      for (const fn of L.down.slice()) try { fn({ from: opts.from ?? null, x: b.x, z: b.z }); } catch (e) { console.error(e); }
      return true;
    }
    const ph = Math.min(phaseCount() - 1, phaseFor(b.hp, b.max, V('phases')));
    if (ph > b.phase) {
      b.phase = ph; b.st = BST.roar; b.t = 0; b.pat = 0;
      for (const fn of L.phase.slice()) try { fn({ phase: ph }); } catch (e) { console.error(e); }
    } else if (opts.heavy && (b.st === BST.chase || b.st === BST.recover)) b.t = Math.max(0, b.t - 0.3);
    return true;
  }

  // ---------- every copy: the body, telegraphs, hit reading ----------
  async function makeObj() {
    v.making = true;
    try {
      const role = ctx.assets.has(`character.body.${V('role')}`) ? V('role') : (() => { const w = ctx.mechanics?.get?.('waves'); const r = w?.params?.enemyRole ?? 'enemy'; return ctx.assets.has(`character.body.${r}`) ? r : null; })();
      if (role && ctx.modules?.character?.spawnCharacter) {
        const c = await ctx.modules.character.spawnCharacter(ctx, { player: { id: 'boss', name: '', color: V('color') }, bodySlot: `character.body.${role}`, tint: V('color'), local: false, height: V('height') });
        v.character = c; v.obj = c.object3d;
        if (ctx.assets.has('mechanic.boss.weapon')) { try { const w = await ctx.assets.model('mechanic.boss.weapon'); hold(c.socket('hand_r'), w, { grip: gripOf(V('weaponGrip')) }); } catch (e) { console.warn('boss: weapon', e); } }
      } else {
        const h = V('height'), m = ctx.modules?.look?.material?.('prop', { tint: V('color') }) ?? new THREE.MeshStandardMaterial({ color: V('color'), roughness: 0.6 });
        v.obj = new THREE.Mesh(new THREE.CapsuleGeometry(h * 0.3, h * 0.4, 8, 16).translate(0, h * 0.5, 0), m); v.obj.castShadow = true;
        ctx.assets.tag(v.obj, 'mechanic.boss.color');
      }
      v.obj.rotation.order = 'YXZ'; root.add(v.obj); v.obj.visible = false;
    } catch (e) { console.warn('boss: body failed', e); }
    v.making = false;
  }
  let teleMats = null;
  function tele() {
    if (v.tele) return v.tele;
    const c = V('telegraphColor');
    const mk = o => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending });
    teleMats ??= { fill: mk(0.3), edge: mk(0.85) };
    const g = new THREE.Group(); g.name = 'gf-boss-telegraph';
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), teleMats.fill);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64).rotateX(-Math.PI / 2), teleMats.edge);
    const lane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5), teleMats.fill);
    const laneEdge = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5), teleMats.fill);
    const fan = new THREE.Group(); for (let i = 0; i < 9; i++) { const l = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5), teleMats.edge); fan.add(l); }
    for (const m of [disc, ring, lane, laneEdge, ...fan.children]) { m.renderOrder = 2; ctx.assets.tag(m, 'mechanic.boss.telegraph-color'); }
    g.add(disc, ring, lane, laneEdge, fan); root.add(g);
    v.tele = g; g.userData = { disc, ring, lane, laneEdge, fan };
    return g;
  }
  function drawTele(dt) {
    const showing = v.st === BST.windup && v.atk;
    if (!showing) { if (v.tele) v.tele.visible = false; return; }
    const g = tele(), u = g.userData, name = ANAME[v.atk];
    g.visible = true; v.teleT += v.freezeT > 0 ? 0 : dt;
    const share = smooth(Math.min(1, v.teleT / Math.max(0.2, A(name).windup * Math.max(0.5, 1 - V('phaseWindup') * v.phase))));
    for (const k of ['disc', 'ring', 'lane', 'laneEdge', 'fan']) u[k].visible = false;
    if (name === 'slam' || name === 'summon') {
      const R = name === 'slam' ? A('slam').radius : 4.5;
      const at = name === 'slam' ? { x: v.tx, z: v.tz } : { x: v.x, z: v.z };
      g.position.set(at.x, 0.06, at.z); g.rotation.set(0, 0, 0);
      u.ring.visible = u.disc.visible = true; u.ring.scale.setScalar(R); u.disc.scale.setScalar(Math.max(0.05, R * share));
    } else if (name === 'charge') {
      const C = A('charge');
      g.position.set(v.x, 0.06, v.z); g.rotation.set(0, v.atkYaw, 0);
      u.lane.visible = u.laneEdge.visible = true; u.laneEdge.scale.set(C.width, 1, C.length); u.lane.scale.set(C.width * 0.94, 1, Math.max(0.05, C.length * share));
    } else if (name === 'volley') {
      const Vo = A('volley'), ys = volleyYaws(0, Math.min(9, Math.round(Vo.count)), Vo.spread);
      g.position.set(v.x, 0.06, v.z); g.rotation.set(0, v.atkYaw, 0); u.fan.visible = true;
      u.fan.children.forEach((l, i) => { l.visible = i < ys.length; if (i < ys.length) { l.rotation.set(0, ys[i], 0); l.scale.set(1, 1, Math.max(0.05, 9 * share)); } });
    }
  }
  function flashBody(k, color) {
    if (v.character?.glow) { if (k > 0 || v.flashOn) v.character.glow(k > 0 ? color : null, k * 0.32); v.flashOn = k > 0; return; }
    if (!v.obj?.material?.emissive) return;
    if (!v.ownMat) { v.obj.material = v.obj.material.clone(); v.ownMat = true; v.base = v.obj.material.emissive.clone(); }
    v.obj.material.emissive.copy(v.base).lerp(new THREE.Color(color), k * 0.32);
  }
  function edges(r) {
    const [active, x, z, hp, max, phase, st, atk, yawDeg, tx, tz, atkDeg] = r;
    if (active && !v.shown) { v.shown = true; v.x = x; v.z = z; v.born = 0; v.deadT = 0; if (v.obj) v.obj.visible = true; ctx.ui?.banner?.(V('name'), 2); ctx.audio?.play(V('soundRoar'), { optional: true }); }
    if (!active && v.shown) { v.shown = false; if (v.obj) v.obj.visible = false; if (v.tele) v.tele.visible = false; }
    v.tx = tx; v.tz = tz; v.atkYaw = (atkDeg ?? 0) * DEG; v.srvYaw = (yawDeg ?? 0) * DEG; v.max = max;
    if (hp < v.hp - 1e-6 && active && st !== BST.dead) {
      hitsSeen++;
      if (ctx.time.now - v.predAt > 0.4) v.hitT = 0;
      if (v.character && (st === BST.chase || st === BST.recover)) v.character.play?.('hit', { fade: 0.05, layer: 'upper' });
      lastHit = { hp, max, t: r2(ctx.time.now) };
    }
    v.hp = hp;
    if (phase !== v.phase) { if (phase > v.phase) { phasesSeen++; ctx.ui?.banner?.(`${V('name')}: phase ${phase + 1}`, 1.8); feel.shake(0.5); ctx.audio?.play(V('soundRoar'), { optional: true }); } v.phase = phase; }
    if (st !== v.st) {
      const was = v.st; v.st = st;
      if (st === BST.windup) { v.teleT = 0; ctx.audio?.play(V('soundWindup'), { at: { x, y: 1, z }, optional: true }); }
      if (st === BST.attack) {
        v.atk = atk;
        const name = ANAME[atk], c = v.character, has = n => c?.clips?.includes?.(n);
        // track C's clips (all in body-judge ENEMY_CLIPS): the slam is the heavy chop, the charge attack_enemy, a volley
        // or a summon a cast; punch on an older clip file
        if (c?.play) { const want = name === 'slam' ? 'heavy' : name === 'charge' ? 'attack_enemy' : 'cast'; const clip = has(want) ? want : 'punch'; const dur = c.meta?.[clip]?.duration ?? 0.7; c.play(clip, { rate: Math.max(1, dur / 0.45), fade: 0.04 }); }
        if (name === 'slam') { ctx.audio?.play(V('soundSlam'), { at: { x: tx, y: 0, z: tz }, optional: true }); feel.sparks({ x: tx, y: 0.2, z: tz }, { count: 26, color: V('telegraphColor'), slot: 'mechanic.boss.telegraph-color', speed: 9, up: 1.2, size: 0.12, life: 0.45 }); if (ctx.me) { const d = Math.hypot(ctx.me.position.x - tx, ctx.me.position.z - tz); feel.shake(Math.max(0, 0.7 * (1 - d / 14))); } }
      }
      if (st === BST.dead && was !== BST.dead) { v.deadT = 0; ctx.audio?.play(V('soundDown'), { at: { x, y: 1, z }, optional: true }); if (v.character) { flashBody(0); v.character.play?.(v.character.clips?.includes?.('death') ? 'death' : 'knockdown', { hold: true, fade: 0.1 }); } feel.shake(0.6); }
    }
    if (st === BST.windup && atk) v.atk = atk;
    v.tgx = x; v.tgz = z;
  }
  function syncView(dt) {
    const r = row(); if (!r) return;
    if (!v.obj && !v.making) makeObj();
    edges(r);
    if (!v.obj || !v.shown) return;
    const frozen = v.freezeT > 0; if (frozen) v.freezeT -= dt;
    const k = ctx.host ? 1 : Math.min(1, dt * 9), px = v.x, pz = v.z;
    if (!frozen) { v.x += (v.tgx - v.x) * k; v.z += (v.tgz - v.z) * k; }
    const sp = Math.hypot(v.x - px, v.z - pz) / Math.max(dt, 1e-3);
    const face = v.st === BST.windup || v.st === BST.attack ? v.atkYaw : v.srvYaw;
    if (!frozen) v.yaw += wrap(face - v.yaw) * Math.min(1, dt * 10);
    v.born = Math.min(1, v.born + dt * 1.5);
    v.hitT += dt;
    v.obj.position.set(v.x, 0, v.z); v.obj.rotation.y = v.yaw;
    if (v.st === BST.dead) {
      v.deadT += dt;
      const pose = deathPose(v.deadT, V('deathSeconds'), 0.45);
      if (!v.character) v.obj.rotation.x = -Math.PI / 2 * smooth(pose.fall);
      v.obj.position.y = -1.6 * smooth(pose.sink);
      if (pose.done) v.obj.visible = false;
    } else {
      v.obj.scale.setScalar(0.4 + 0.6 * smooth(v.born));
      const hf = flashAt(v.hitT);
      if (hf > 0) flashBody(hf, V('flashColor'));
      else if (v.st === BST.windup || v.st === BST.roar) flashBody(0.5 + 0.35 * Math.sin(ctx.time.now * (v.st === BST.roar ? 40 : 24)), V('telegraphColor'));
      else flashBody(0);
      if (!v.character && v.st === BST.windup) v.obj.rotation.x = -0.15;
      else if (!v.character) v.obj.rotation.x *= 0.8;
    }
    if (v.character) { v.character.locomotion?.(v.st === BST.dead ? 0 : Math.min(sp, 8), true); v.character.update?.(frozen ? 0 : dt); }
    drawTele(dt);
  }

  // ---------- melee and projectile targets ----------
  const provider = {
    key: 'b',
    list: () => (v.shown && v.obj && v.st !== BST.dead && v.st !== BST.intro ? [{ id: 1, x: v.x, z: v.z, radius: V('radius'), height: V('height') }] : []),
    hostFind: () => (b.active && b.st !== BST.dead ? { x: b.x, z: b.z, radius: V('radius') } : null),
    hit({ damage: n, attacker, dir, move }) { const before = b.hp; const ok = damage(n, { from: attacker, kind: 'melee', heavy: !!(move?.knockdown || move?.guardBreak) }); return { counted: ok, killed: b.st === BST.dead, damage: before - b.hp }; },
    feel(id, { hitStop = 0.05 } = {}) { v.freezeT = Math.max(v.freezeT, hitStop); v.hitT = 0; v.predAt = ctx.time.now; },
  };

  const api = {
    id, params: P,
    begin,
    /** Every copy: {active, name, hp, max, phase (0-based), phases, attack ('slam' | ...|null), state, dead, x, z}. */
    state() {
      const r = row() ?? [0, 0, 0, 0, 0, 0, BST.idle, 0, 0, 0, 0, 0];
      const st = r[6];
      return { active: !!r[0], name: V('name'), hp: r[3], max: r[4], phase: r[5], phases: phaseCount(), attack: st === BST.windup || st === BST.attack ? ANAME[r[7]] ?? null : null, state: Object.keys(BST).find(k => BST[k] === st), dead: !!r[0] && st === BST.dead, x: r[1], z: r[2] };
    },
    /** Host: hurt it (rules, other mechanics). */
    damage,
    onPhase(fn) { L.phase.push(fn); return unsub(L.phase, fn); },
    onDown(fn) { L.down.push(fn); return unsub(L.down, fn); },
    onHit(fn) { L.hit.push(fn); return unsub(L.hit, fn); },
    get stats() {
      const s = api.state();
      let sc = null;
      if (ctx.camera && v.shown) { ctx.camera.updateMatrixWorld(); const q = new THREE.Vector3(v.x, V('height') * 0.5, v.z).project(ctx.camera); sc = { x: r2((q.x * 0.5 + 0.5) * (globalThis.innerWidth ?? 0)), y: r2((-q.y * 0.5 + 0.5) * (globalThis.innerHeight ?? 0)), front: q.z > -1 && q.z < 1 }; }
      return { ...s, hitsSeen, phasesSeen, lastHit, attacks: ctx.host ? attacksDone : null, telegraph: !!v.tele?.visible, shown: v.shown, screen: sc };
    },
    setup() {},
    reset() { Object.assign(b, { active: false, st: BST.idle, hp: 0, max: 0, phase: 0, t: 0, atk: 0, autoAt: null }); v.shown = false; v.hp = 0; v.phase = 0; v.st = BST.idle; if (v.obj) { v.obj.visible = false; v.obj.position.y = 0; v.obj.rotation.x = 0; } if (v.character) v.character.recover?.(); if (v.tele) v.tele.visible = false; },
    update(dt) {
      if (!S) {
        if (!(ctx.shared && ctx.players && ctx.me)) return;
        S = ctx.shared.register('boss', { a: [0, 0, 0, 0, 0, 0, BST.idle, 0, 0, 0, 0, 0] });
        if (M('melee')) (ctx.meleeTargets ??= []).push(provider);
        const prj = M('projectile');
        if (prj?.addTargets) prj.addTargets({ list: () => (ctx.host && b.active && b.st !== BST.dead ? [{ id: 'boss', x: b.x, y: 0, z: b.z, radius: V('radius'), height: V('height') }] : []), hit: h => damage(h.damage ?? 1, { from: h.shooter, kind: h.kind }) });
        (ctx.aimBodies ??= []).push(() => (v.shown && v.st !== BST.dead ? [{ id: 'boss', x: v.x, z: v.z, height: V('height'), radius: V('radius') }] : []));
      }
      if (ctx.host) {
        const playing = ctx.round?.phase === 'playing';
        const auto = V('auto') === true || (V('auto') === 'auto' && !M('levels'));
        if (playing && auto && !b.active) { b.autoAt ??= ctx.time.round + V('startDelay'); if (ctx.time.round >= b.autoAt) begin(null); }
        if (playing) hostStep(Math.min(dt, 0.05));
        S.a = row();
      }
      syncView(dt);
    },
    dispose() { root.removeFromParent(); if (ctx.meleeTargets) { const i = ctx.meleeTargets.indexOf(provider); if (i >= 0) ctx.meleeTargets.splice(i, 1); } },
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
  describe: 'A boss with phases and telegraphed attacks (slam, charge, volley, summon) and its health bar on the HUD',
  rank: 130,
  needs: { parts: [], world: [] },
  // melee swings and projectile shots hurt it by themselves; waves gives it the volley's bolts and the minions it
  // summons; levels brings it on the last level (without levels it comes startDelay s into the round)
  uses: ['melee', 'projectile', 'waves', 'levels', 'health', 'loot'],
  owns: () => [],
  state: { key: 'boss', fields: { a: '[active, x, z, hp, max, phase, state, attack, yaw°, tx, tz, attack yaw°]' } },
  events: [
    { name: 'onPhase', on: 'host', args: '{ phase }', when: 'its hit points crossed a phase threshold' },
    { name: 'onDown', on: 'host', args: '{ from, x, z }', when: 'it went down (from: the player who did it, or null)' },
    { name: 'onHit', on: 'host', args: '{ amount, from, hp }', when: 'it was hurt' },
  ],
  sync: { owner: 'host', how: 'the host owns the boss; every copy draws it, its telegraphs and its bar from the shared row' },
  note: [
    'Give it its own body: a character role "boss" in the spec (else it wears the minions\' body, which the creator rejected).',
    'Melee swings and shots hurt it by themselves, its name and health are a bar across the top of the HUD, and bringing it down already scores killPoints.',
    'With the levels mechanic it comes on the last level; without one it comes startDelay s into the round.',
  ],
  stub: {
    as: 'boss',
    worked: 'boss.onDown(() => ctx.round.end(\'won\', ctx.players.list().map(p => p.id)));   // only without the levels mechanic, which ends the run itself',
    traps: [
      'a game with neither melee nor projectile has nothing that hurts it: the rules must call boss.damage(n, { from }) on the host',
      'its attacks are telegraphed on the ground for a reason: do not shorten windups until nobody can step out',
    ],
  },
  signs: {
    sample: sh => { if (!sh.boss) return null; const a = sh.boss.a ?? []; return { boss: [a[0] ?? 0, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0, a[6] ?? 0] }; },
    judge: v => {
      const a = v.action;
      if (a.bossPhase >= 1) v.add('the boss comes and changes phase', 'ok', 'shared.boss.a (active, hp, max, phase)', `it came and reached phase ${a.bossPhase + 1} (hit points down to ${a.bossHpMin} of ${a.bossMax})`);
      else v.add('the boss comes and changes phase', a.bossActive ? 'dead' : 'unmeasured', 'shared.boss.a (active, hp, max, phase)', a.bossActive ? `it came but never changed phase (hit points down to ${a.bossHpMin} of ${a.bossMax}) on the staged page (?gf-demo=boss.phase: it starts just above its first threshold) or any other` : 'the boss never came on any page (the staged page starts the run on the boss level)',
        a.bossActive ? 'check the boss\'s phases (hit-point shares) and that melee and shots reach it (hittable, its radius)' : 'check that the levels mechanic\'s last level is the boss\'s (bossLevel "last") or boss auto, and startDelay');
    },
  },
};
