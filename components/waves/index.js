// mechanic: waves (track K2). Host-owned enemies that come in waves, chase players or a target that has health, and can
// be hit by projectiles. Every copy draws them (a character body when the game has one, else a prop, else a capsule).
// README.md has ownership and API.
//
//   const waves = ctx.mechanics.get('waves');
//   waves.onKill(k => { if (k.from) k.from.score += 1; });        // host only
//   waves.state();                                                // every copy: { wave, alive, kills, targetHp, targetMax }
//
// Hits read (creator, live Studio "Hang Up On Them", 2026-10-07: "The zombies are instant killed to I couldn't even tell
// what was happened. There was no healthbar or anything."). On every copy, from the shared hit points alone:
//   - a hit that does not kill: the enemy flashes (flashColor over its own materials), flinches (the gf-humanoid-1 `hit`
//     clip and the hurt face, or a squash for a stand-in), is pushed back `hitKnock` m and staggers `stagger` s (host),
//     and a health bar shows over it (the kit's UI, like nameplates: never a model) from then on;
//   - a kill: the body falls (the `knockdown` clip, or a stand-in tips over), then sinks into the floor over
//     `deathSeconds`, with the `soundKill` sound; the killer's own screen shows "+killPoints" over it.
// A basic enemy takes 2–4 hits from the game's weapon (defaults: hp 2, projectile damage 1; tools/lib/spec-config.mjs
// keeps the spec's damage below hp). One-hit kills only when the spec asks for them (`oneHitKills`). verify check 16
// (tools/lib/hits-check.mjs) shoots enemies from the player's own screen and fails a game whose enemies drop in one hit.
//
// Enemy types (gf-scenic wave 1, track M; types.js): with params.types the enemies fight like an action game's: a
// behaviour each (chaser, lunger, ranged, brute, shielded), a readable windup with a telegraph on the ground (a kit
// primitive in the telegraph-color slot) and a red glow, attack tokens (at most a few swing at once), slow bolts
// (bolts.js), a guard that blocks from the front, and hits from the melee mechanic (each target once a swing). A spec
// with no `types` plays exactly as before. The levels mechanic runs encounters (startEncounter) on each level.
//
// QA only: `?gf-demo=waves.hit` stages the moment check 16 photographs: no waves, one enemy at a time standing still
// 6 m in front of the local player (the game's own wave-1 hit points), a new one shortly after each kill.
import * as THREE from 'three';
import { createDirector, waveStats, edgePoint, nearestOf, steer, rotate, clampTo, hurtEnemy, knockOf, flashAt, deathPose, demoSpot } from './logic.js';
import { normalizeTypes, pickType, tokenCap, stepEnemy, swingTargets, guardBlocks, arenaPoint, ST } from './types.js';
import { createBolts } from './bolts.js';
import { feelOf } from '../melee/feel.js';
import { hold, gripOf } from '../melee/held.js';
import { areaOf, physicsOf } from '../../core/util.js';

export const id = 'waves';
export const examples = ['zombies in waves', 'defend the core', 'enemy blobs chase the players', 'skeleton warriors, archers and a brute on each island'];

const D = {
  enemyRole: 'enemy', prop: '', color: '#7a5cff', height: 1.5, startCount: 3, growth: 2, maxAlive: 14, hp: 2, hpGrowth: 0.5, speed: 2.6, speedGrowth: 0.12,
  firstDelay: 3, restSeconds: 4, spawnEvery: 0.6, nextWave: 'clear', interval: 20, maxWaves: 0, aggro: 'nearest', attackRange: 1.2, attackInterval: 1.0, damage: 1, contactKnock: 5, hittable: true,
  target: '', targetHp: 20, killPoints: 1, banner: true, bannerText: 'Wave {n}', targetLabel: 'Core',
  oneHitKills: false, barColor: '#ff4d5e', flashColor: '#ffffff', hitKnock: 0.35, stagger: 0.3, deathSeconds: 1.6, soundKill: 'enemy-down',
  // enemy types (only with `types`)
  types: [], hpPerPlayer: 0.3, attackTokens: 2, tokenCooldown: 0.3, telegraphColor: '#ff4a3d', boltColor: '#ffa04a', shieldColor: '#8ea7c9', keepOff: 0.85,
  soundWindup: 'enemy-windup', soundSwing: 'enemy-swing',
};
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    enemyRole: { type: 'string', default: D.enemyRole, description: 'Character role whose body (character.body.<role>) draws the enemies when the game has one' },
    prop: { type: 'string', default: D.prop, description: 'Prop slot to draw enemies with when there is no character body ("": a coloured capsule)' },
    color: { type: 'string', default: D.color, description: 'Colour of the stand-in capsule and of the character tint' },
    height: { ...num('Enemy height in metres', 0.4, 4), default: D.height },
    startCount: { type: 'integer', minimum: 1, maximum: 30, default: D.startCount, description: 'Enemies in wave 1' },
    growth: { ...num('Extra enemies each wave', 0, 20), default: D.growth },
    maxAlive: { type: 'integer', minimum: 1, maximum: 24, default: D.maxAlive, description: 'Enemies alive at once (each costs about 25 bytes of the world message)' },
    hp: { type: 'integer', minimum: 1, maximum: 200, default: D.hp, description: 'Hit points in wave 1. Keep it above the weapon\'s damage: a basic enemy takes 2–4 hits (verify check 16 fails one-hit kills unless the spec sets oneHitKills)' },
    hpGrowth: { ...num('Extra hit points each wave', 0, 20), default: D.hpGrowth },
    speed: { ...num('Enemy speed in wave 1 (m/s)', 0.5, 8), default: D.speed },
    speedGrowth: { ...num('Speed gained each wave (fraction)', 0, 1), default: D.speedGrowth },
    firstDelay: { ...num('Seconds before wave 1', 0, 60), default: D.firstDelay },
    restSeconds: { ...num('Seconds between waves', 0, 60), default: D.restSeconds },
    spawnEvery: { ...num('Seconds between enemies of a wave coming out', 0.05, 10), default: D.spawnEvery },
    nextWave: { type: 'string', enum: ['clear', 'timer'], default: D.nextWave, description: 'clear: the next wave comes when all are dead; timer: after `interval` seconds either way' },
    interval: { ...num('Seconds a wave lasts at most in timer mode', 5, 300), default: D.interval },
    maxWaves: { type: 'integer', minimum: 0, maximum: 99, default: D.maxWaves, description: 'Waves in the round (0: endless); state().cleared is true after the last is beaten' },
    aggro: { type: 'string', enum: ['nearest', 'players', 'target'], default: D.aggro, description: 'Who enemies go for: the nearest of players and target, only players, or only the target' },
    attackRange: { ...num('Reach of an enemy attack (m)', 0.3, 4), default: D.attackRange },
    attackInterval: { ...num('Seconds between one enemy\'s attacks', 0.2, 10), default: D.attackInterval },
    damage: { ...num('Damage of an attack to a player or the target', 0, 100), default: D.damage },
    contactKnock: { ...num('Knock an attack gives a player (m/s)', 0, 20), default: D.contactKnock },
    hittable: { type: 'boolean', default: D.hittable, description: 'The projectile mechanic\'s shots and streams hit enemies' },
    target: { type: 'string', default: D.target, description: 'World zone that holds the thing to defend ("": no target, enemies only chase players)' },
    targetHp: { ...num('Hit points of the target', 1, 1000), default: D.targetHp },
    targetLabel: { type: 'string', default: D.targetLabel, description: 'HUD label of the target\'s health bar' },
    killPoints: { ...num('Score a player gets for a kill they caused', 0, 100), default: D.killPoints },
    banner: { type: 'boolean', default: D.banner, description: 'Show a banner when a wave starts' },
    bannerText: { type: 'string', default: D.bannerText, description: 'Banner text; {n} is the wave number' },
    oneHitKills: { type: 'boolean', default: D.oneHitKills, description: 'Any hit kills. Only when the creator asked for enemies that drop in one hit: verify check 16 honours it only when the game\'s locked spec sets it' },
    // (a spec value: a game's config/game.json gets the spec's number, else this default; verify reads the spec's)
    hitsPerKill: { type: 'integer', minimum: 1, maximum: 12, default: 2, description: 'The fewest hits a basic wave-1 enemy takes from the game\'s weapon (the median over the kills verify measures). A matter of taste, so a spec value: 2 when unset (the creator: "The zombies are instant killed to I couldn\'t even tell what was happened"); 1 allows one-hit kills (oneHitKills makes every hit kill). verify gate F (measure 39) holds the game to the locked spec\'s number, and create raises the enemies\' hit points to meet it' },
    barColor: { type: 'string', default: D.barColor, description: 'Colour of the health bar over a hit enemy' },
    flashColor: { type: 'string', default: D.flashColor, description: 'Colour a hit enemy flashes' },
    hitKnock: { ...num('How far a hit pushes an enemy back (m)', 0, 3), default: D.hitKnock },
    stagger: { ...num('Seconds a hit enemy stops before it comes on again', 0, 2), default: D.stagger },
    deathSeconds: { ...num('Seconds a downed enemy takes to fall and sink away', 0.6, 4), default: D.deathSeconds },
    soundKill: { type: 'string', default: D.soundKill, description: 'Sound id played where an enemy goes down ("" for none)' },
    types: { type: 'array', default: D.types, description: 'Enemy types (empty: the classic waves). Each {id, role (character.body.<role>), behaviour: chaser|lunger|ranged|brute|shielded, hp, speed, damage, reach, arc, windup, active, recover, cooldown, knock, knockdown, telegraph: sector|ring|lane|line, score, height, color, weight, from (first level)}; kit/mechanics/waves/types.js has each behaviour\'s defaults', items: { type: 'object' } },
    hpPerPlayer: { ...num('Typed enemies: extra hit points per player beyond the first (fraction; co-op stays a fight)', 0, 2), default: D.hpPerPlayer },
    attackTokens: { type: 'integer', minimum: 1, maximum: 12, default: D.attackTokens, description: 'Typed enemies winding up or swinging at once (plus half a token per extra player)' },
    tokenCooldown: { ...num('Seconds between two enemies starting an attack', 0, 3), default: D.tokenCooldown },
    telegraphColor: { type: 'string', default: D.telegraphColor, description: 'Colour of an enemy\'s windup on the ground and its glow' },
    boltColor: { type: 'string', default: D.boltColor, description: 'Colour of a ranged enemy\'s bolt' },
    shieldColor: { type: 'string', default: D.shieldColor, description: 'Colour of a shielded enemy\'s stand-in shield' },
    keepOff: { ...num('Typed enemies keep this far from a player\'s middle (m)', 0, 2), default: D.keepOff },
    soundWindup: { type: 'string', default: D.soundWindup, description: 'Sound id as a typed enemy winds up ("" for none)' },
    soundSwing: { type: 'string', default: D.soundSwing, description: 'Sound id as a typed enemy swings ("" for none)' },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.waves.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : 'gameplay', ...extra });
export const slots = [
  vs('startCount', 'Enemies in the first wave', 'integer', { tier: 'main', rank: 62, constraints: { min: 1, max: 30 } }),
  vs('growth', 'Extra enemies per wave', 'number', { tier: 'main', rank: 58, constraints: { min: 0, max: 20 } }),
  vs('speed', 'Enemy speed', 'number', { tier: 'main', rank: 56, constraints: { min: 0.5, max: 8, unit: 'm/s' } }),
  vs('hp', 'Enemy hit points', 'integer', { rank: 50, constraints: { min: 1, max: 200 } }),
  vs('color', 'Stand-in enemy colour', 'color', { rank: 30 }),
  vs('targetHp', 'Target hit points', 'number', { rank: 44, constraints: { min: 1, max: 1000 } }),
  vs('bannerText', 'Wave banner text', 'text', { facet: 'text', constraints: { maxLength: 40 } }),
  vs('targetLabel', 'Target health label', 'text', { facet: 'text', constraints: { maxLength: 24 } }),
  vs('height', 'Enemy height', 'number', { constraints: { min: 0.4, max: 4, unit: 'm' } }),
  vs('damage', 'Enemy attack damage', 'number', { constraints: { min: 0, max: 100 } }),
  vs('restSeconds', 'Rest between waves', 'number', { constraints: { min: 0, max: 60, unit: 's' } }),
  vs('maxAlive', 'Most enemies alive', 'integer', { constraints: { min: 1, max: 24 } }),
  vs('maxWaves', 'Waves in the round (0 endless)', 'integer', { constraints: { min: 0, max: 99 } }),
  vs('interval', 'Wave length in timer mode', 'number', { constraints: { min: 5, max: 300, unit: 's' } }),
  vs('contactKnock', 'Attack knock', 'number', { constraints: { min: 0, max: 20, unit: 'm/s' } }),
  vs('prop', 'Enemy prop', 'text', { constraints: { maxLength: 40 } }),
  vs('barColor', 'Enemy health bar colour', 'color', { rank: 28 }),
  vs('flashColor', 'Enemy hit flash colour', 'color', { rank: 26 }),
  vs('hitKnock', 'Enemy push-back on a hit', 'number', { constraints: { min: 0, max: 3, unit: 'm' } }),
  vs('stagger', 'Enemy stagger on a hit', 'number', { constraints: { min: 0, max: 2, unit: 's' } }),
  vs('deathSeconds', 'Enemy fall and sink time', 'number', { constraints: { min: 0.6, max: 4, unit: 's' } }),
  vs('soundKill', 'Enemy down sound id', 'text', { constraints: { maxLength: 40 } }),
];
const TYPE_FIELDS = [['hp', 'hit points', 1, 500], ['speed', 'speed', 0.3, 10, 'm/s'], ['damage', 'damage', 0, 50], ['reach', 'reach', 0.4, 30, 'm'], ['windup', 'wind-up', 0.15, 3, 's'], ['recover', 'recovery', 0.1, 4, 's'], ['cooldown', 'rest between attacks', 0, 10, 's'], ['score', 'score', 0, 1000], ['height', 'height', 0.4, 6, 'm'], ['weight', 'how often', 0, 100]];
/** The classic slots; with `types`, also the typed enemies' colours and tokens, and each type's numbers the config holds. */
export function slotsFor(m = {}, cfg = {}) {
  const P = m.params ?? {};
  if (!Array.isArray(P.types) || !P.types.length) return slots;
  const out = [...slots,
    vs('telegraphColor', 'Enemy windup colour (telegraph)', 'color', { tier: 'main', rank: 57 }),
    vs('boltColor', 'Enemy bolt colour', 'color', { rank: 36 }), vs('shieldColor', 'Enemy shield colour', 'color', { rank: 30 }),
    vs('attackTokens', 'Enemies attacking at once', 'integer', { tier: 'main', rank: 55, constraints: { min: 1, max: 12 } }),
    vs('hpPerPlayer', 'Enemy toughness per extra player', 'number', { constraints: { min: 0, max: 2 } }),
    vs('tokenCooldown', 'Pause between enemy attacks', 'number', { constraints: { min: 0, max: 3, unit: 's' } }),
    vs('soundWindup', 'Enemy windup sound id', 'text', { constraints: { maxLength: 40 } }), vs('soundSwing', 'Enemy swing sound id', 'text', { constraints: { maxLength: 40 } }),
  ];
  P.types.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const tid = String(t.id ?? `type-${i + 1}`).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 24);
    for (const [f, fl, min, max, unit] of TYPE_FIELDS) if (typeof t[f] === 'number') out.push({ id: `mechanic.waves.${tid}.${f}`, label: `${t.name ?? tid}: ${fl}`, group: 'mechanics', type: 'number', source: { pointer: `{base}/types/${i}/${f}` }, tier: f === 'hp' && i < 3 ? 'main' : 'advanced', rank: 48 - i, facet: 'gameplay', constraints: { min, max, ...(unit ? { unit } : {}) } });
    if (typeof t.color === 'string') out.push({ id: `mechanic.waves.${tid}.color`, label: `${t.name ?? tid}: colour`, group: 'mechanics', type: 'color', source: { pointer: `{base}/types/${i}/color` }, tier: 'advanced', facet: 'look' });
    // what it holds: a weapon on hand_r, a shield on hand_l (files in assets/models/, e.g. KayKit's skeleton axe)
    for (const k of ['weapon', 'shield']) if (typeof t[k] === 'string' && (cfg.files ?? []).includes(`assets/models/${t[k]}`))
      out.push({ id: `mechanic.waves.${tid}.${k}`, label: `${t.name ?? tid}: ${k}`, group: 'mechanics', type: 'model', source: { file: `assets/models/${t[k]}` }, tier: 'advanced', rank: 40, facet: 'look', constraints: { maxBytes: 4194304 }, generate: { prompt: `the ${k} a ${t.name ?? tid} holds`, style: 'stylised low-poly game prop, clean silhouette' } });
  });
  return out;
}

const r2 = v => Math.round(v * 100) / 100;
const DEG = Math.PI / 180;
const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
const smooth = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const qaParam = name => { try { return new URLSearchParams(globalThis.location?.search ?? '').get(name); } catch { return null; } };
function rayFixed(ctx, a, b) {
  const { RAPIER: R, world: W } = physicsOf(ctx);   // ctx.physics is the bare World (K1) or {RAPIER, world}
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.hypot(dx, dy, dz);
  if (!R || !W || d < 1e-6) return null;
  const ray = new R.Ray({ x: a.x, y: a.y, z: a.z }, { x: dx / d, y: dy / d, z: dz / d });
  const h = W.castRay(ray, d, true, undefined, undefined, undefined, undefined, c => { const p = c.parent(); return !p || p.isFixed(); });
  return h ? (h.timeOfImpact ?? h.toi) : null;
}
/** A stand-in's own copies of its materials (so one enemy's flash never lights the others), with their base emissive. */
function ownMaterials(obj) {
  const out = [], own = new Map();
  obj.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const next = mats.map(m => {
      if (!m || !m.emissive) return m;
      if (!own.has(m)) { const c = m.clone(); c.userData = { ...m.userData, gfFlashBase: m.emissive.clone() }; own.set(m, c); out.push(c); }
      return own.get(m);
    });
    o.material = Array.isArray(o.material) ? next : next[0];
  });
  return out;
}

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.waves.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  let A = areaOf(ctx.world);
  const demo = qaParam('gf-demo') === 'waves.hit';
  const stats = () => ({ startCount: V('startCount'), growth: V('growth'), maxAlive: V('maxAlive'), hp: V('hp'), hpGrowth: V('hpGrowth'), speed: V('speed'), speedGrowth: V('speedGrowth') });
  let director = createDirector({ firstDelay: V('firstDelay'), restSeconds: V('restSeconds'), interval: V('interval'), mode: V('nextWave'), spawnEvery: V('spawnEvery'), maxWaves: V('maxWaves'), stats: stats() });
  const L = { kill: [], spawn: [], playerHit: [], targetHit: [], targetDown: [] };
  const root = new THREE.Group(); root.name = 'gf-waves'; ctx.scene.add(root);
  const enemies = new Map();        // host: id → {id, x, z, hp, max, speed, wave, atk, side, hits, shots, stun}
  const view = new Map();           // every copy: id → {x, z, tx, tz, hp, max, yaw, obj, character, ...}
  const dying = [];
  const killLog = [];               // host: the last kills {id, hits, shots, max, from, t} (QA: verify check 16)
  const recentKills = [];           // host: [enemy id, killer id] of the last kills (shared as `k`: the "+1" on the killer's screen)
  let S = null, nextId = 1, kills = 0, targetHp = V('targetHp'), targetDownFired = false, started = false, lastWave = 0, lastList = null, meter = null, ring = null;
  let templ = null, loading = false, demoT = 0, hitsSeen = 0, deathsSeen = 0, lastHit = null, aimSrc = null;
  const now = () => ctx.time.now;
  const targetPos = () => { const z = V('target') && ctx.world.zone?.(V('target')); if (!z) return null; const a = z.at; return { x: a.x ?? a[0], z: a.z ?? a[2] }; };

  // ---------- enemy types (types.js): only when params.types is set ----------
  const TYPES = normalizeTypes(V('types'), { enemyRole: V('enemyRole'), color: V('color') }).map(t => {
    const val = (f, d) => { const sid = `mechanic.waves.${t.id}.${f}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, d) : d; } catch { return d; } };
    const o = { ...t }; for (const [f] of TYPE_FIELDS) o[f] = Number(val(f, t[f])); o.color = val('color', t.color); return o;
  });
  const typed = TYPES.length > 0;
  let managed = false;              // the levels mechanic runs encounters: no waves until startEncounter
  let enc = { level: 1, active: false, waves: 0, hpScale: 1, speedScale: 1, mix: null, done: false };
  let lastGrant = -9, worldLevel = ctx.world?.level ?? null, tokensUsed = 0, attacks = 0, dodged = 0;
  const feel = typed ? feelOf(ctx) : null;
  const typeOf = e => (typed ? TYPES[e.ty ?? 0] ?? TYPES[0] : null);
  const heightOf = v => (typed ? (TYPES[v.ty ?? 0]?.height ?? V('height')) : V('height'));
  const radiusOf = v => (typed ? 0.45 * Math.max(0.8, Math.min(1.8, heightOf(v) / 1.7)) : 0.45);
  // the current level's circle (scenic worlds, CONTRACT §8): enemies keep on its island
  const levelCircle = () => { const lv = ctx.world?.levels?.[ctx.world.level ?? 0]; return lv ? { x: lv.at?.[0] ?? 0, z: lv.at?.[2] ?? 0, r: Math.max(2, (lv.radius ?? 10) - 0.9) } : null; };
  const keepIn = (x, z) => {
    const c = typed ? levelCircle() : null;
    if (c) { const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz); if (d > c.r) return { x: c.x + dx / d * c.r, z: c.z + dz / d * c.r }; return { x, z }; }
    return clampTo(A, x, z);
  };
  const bolts = typed ? createBolts(ctx, { key: 'wb', slot: 'mechanic.waves.bolt-color', color: V('boltColor'), onHit: (p, b) => hitPlayer(null, p, { damage: b.damage, knock: b.knock ?? 3, dir: { x: b.vx, z: b.vz }, knockdown: false, source: 'bolt' }) }) : null;
  const melee = () => { const m = ctx.mechanics?.get?.('melee'); return m && !m.standin ? m : null; };

  // ---------- drawing ----------
  const hasBody = () => ctx.assets.has(`character.body.${V('enemyRole')}`) && ctx.modules?.character?.spawnCharacter;
  const roleOf = v => { const T = typed ? TYPES[v.ty ?? 0] : null; return T && ctx.assets.has(`character.body.${T.role}`) ? T.role : V('enemyRole'); };
  const typeTempl = new Map();      // typed stand-ins: one capsule per type (its own height and colour)
  async function loadTemplate() {
    if (loading || templ) return; loading = true;
    const name = V('prop');
    try { if (!hasBody() && name && ctx.assets.has(`prop.${name}`)) templ = { obj: await ctx.assets.model(`prop.${name}`, { fit: V('height'), fitAxis: 'y' }) }; } catch (e) { console.warn('waves: prop model failed', e); }
    if (!templ && !hasBody()) {
      const m = ctx.modules?.look?.material?.('prop', { tint: V('color') }) ?? new THREE.MeshStandardMaterial({ color: V('color'), roughness: 0.6 });
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(V('height') * 0.28, V('height') * 0.44, 6, 12).translate(0, V('height') * 0.5, 0), m); mesh.castShadow = true;
      ctx.assets.tag(mesh, 'mechanic.waves.color'); templ = { obj: mesh };
    }
    loading = false;
  }
  function typedStandin(v) {
    const T = TYPES[v.ty ?? 0], k = T.id;
    if (!typeTempl.has(k)) {
      const h = T.height, m = ctx.modules?.look?.material?.('prop', { tint: T.color }) ?? new THREE.MeshStandardMaterial({ color: T.color, roughness: 0.6 });
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(h * 0.28, h * 0.44, 6, 12).translate(0, h * 0.5, 0), m); mesh.castShadow = true;
      ctx.assets.tag(mesh, ctx.assets.has(`mechanic.waves.${T.id}.color`) ? `mechanic.waves.${T.id}.color` : 'mechanic.waves.color'); typeTempl.set(k, mesh);
    }
    return typeTempl.get(k).clone(true);
  }
  let shieldMat = null;
  const heldCache = new Map();
  async function heldModel(T, k) {
    const sid = `mechanic.waves.${T.id}.${k}`;
    if (!ctx.assets.has(sid)) return null;
    if (!heldCache.has(sid)) heldCache.set(sid, ctx.assets.model(sid).catch(e => { console.warn(`waves: ${sid}`, e); return null; }));
    const m = await heldCache.get(sid); return m ? m.clone(true) : null;
  }
  /** What a typed enemy holds: its weapon (hand_r) and shield (hand_l) models by their grips; a shielded type with no
   *  shield model gets the kit's stand-in disc in the shield-color slot. */
  async function arm(v) {
    const T = TYPES[v.ty ?? 0]; if (!T || !v.character?.socket) return;
    const w = await heldModel(T, 'weapon');
    if (w) hold(v.character.socket('hand_r'), w, { grip: gripOf(T.weaponGrip) });
    const sh = await heldModel(T, 'shield');
    if (sh) { hold(v.character.socket('hand_l'), sh, { grip: gripOf(T.shieldGrip) }); return; }
    if (T.behaviour !== 'shielded') return;
    shieldMat ??= ctx.modules?.look?.material?.('prop', { tint: V('shieldColor') }) ?? new THREE.MeshStandardMaterial({ color: V('shieldColor'), roughness: 0.4, metalness: 0.5 });
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.06, 20).rotateX(Math.PI / 2), shieldMat); s.castShadow = true;
    ctx.assets.tag(s, 'mechanic.waves.shield-color'); v.character.socket('hand_l').add(s);
  }
  async function makeObj(v) {
    v.making = true;
    try {
      const role = typed ? roleOf(v) : V('enemyRole');
      if (ctx.assets.has(`character.body.${role}`) && ctx.modules?.character?.spawnCharacter) {
        const T = typed ? TYPES[v.ty ?? 0] : null;
        const c = await ctx.modules.character.spawnCharacter(ctx, { player: { id: `enemy:${v.id}`, name: '', color: T?.color ?? V('color') }, bodySlot: `character.body.${role}`, tint: T?.color ?? V('color'), local: false, height: T?.height ?? V('height') });
        v.character = c; v.obj = c.object3d;
        if (typed) await arm(v);
      } else if (typed) v.obj = typedStandin(v);
      else if (templ) v.obj = templ.obj.clone(true);
      if (v.obj) { v.obj.rotation.order = 'YXZ'; root.add(v.obj); v.obj.position.set(v.x, 0, v.z); }
      if (v.gone && v.obj) { v.obj.removeFromParent(); v.character?.dispose?.(); }      // it died while its body loaded
    } catch (e) { console.warn('waves: enemy body failed', e); }
    v.making = false;
  }
  // a hit's flash over this enemy's own materials: the character's glow, or a stand-in's own material copies
  // (typed enemies flash softer: the scenic engine's bloom turns a full-strength flash into a white silhouette)
  const flashMax = typed ? 0.32 : 0.85;
  function flash(v, k, color = null) {
    if (v.character?.glow) { if (k > 0 || v.flashOn) v.character.glow(k > 0 ? (color ?? V('flashColor')) : null, k * flashMax); v.flashOn = k > 0; return; }
    if (!v.obj || (k <= 0 && !v.flashOn)) return;
    v.flashOn = k > 0;
    if (!v.mats) v.mats = ownMaterials(v.obj);
    const c = new THREE.Color(color ?? V('flashColor'));
    for (const m of v.mats) m.emissive.copy(m.userData.gfFlashBase).lerp(c, k * flashMax);
  }

  // ---------- telegraphs (typed): a kit primitive on the ground in the telegraph-color slot, every copy ----------
  let teleMats = null;
  function teleMaterials() {
    if (teleMats) return teleMats;
    const c = V('telegraphColor');
    const mk = o => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending });
    teleMats = { fill: mk(0.32), edge: mk(0.85) };
    return teleMats;
  }
  function makeTelegraph(T) {
    const M = teleMaterials(), g = new THREE.Group(); g.name = 'gf-telegraph';
    let fill, edge;
    if (T.telegraph === 'lane' || T.telegraph === 'line') {
      const w = T.telegraph === 'lane' ? 1.0 : 0.16;
      fill = new THREE.Mesh(new THREE.PlaneGeometry(w, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5), M.fill);
      edge = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.25, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5), M.edge); edge.scale.set(1, 1, 1); edge.material = M.fill;
    } else {
      const half = T.telegraph === 'ring' ? Math.PI : Math.min(Math.PI, (T.arc * DEG) / 2);
      fill = new THREE.Mesh(new THREE.CircleGeometry(1, 40, -Math.PI / 2 - half, 2 * half).rotateX(-Math.PI / 2), M.fill);
      edge = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 48, 1, -Math.PI / 2 - half, 2 * half).rotateX(-Math.PI / 2), M.edge);
    }
    for (const m of [fill, edge]) { m.renderOrder = 2; ctx.assets.tag(m, 'mechanic.waves.telegraph-color'); g.add(m); }
    g.userData = { fill, edge, kind: T.telegraph };
    g.visible = false; root.add(g);
    return g;
  }
  function drawTelegraph(v, T, share, show) {
    if (!show) { if (v.tele) v.tele.visible = false; return; }
    v.tele ??= makeTelegraph(T);
    const g = v.tele, { fill, edge, kind } = g.userData;
    g.visible = true;
    const s = Math.max(0.02, smooth(share));
    if (kind === 'lane' || kind === 'line') {
      const len = kind === 'lane' ? T.lungeSpeed * T.active * 0.62 + 1 : Math.min(T.reach, v.aimLen ?? T.reach);
      g.position.set(v.x, 0.05, v.z); g.rotation.set(0, v.atkYaw ?? v.yaw, 0);
      edge.scale.set(1, 1, len); fill.scale.set(1, 1, len * s);
    } else {
      const R = kind === 'ring' ? T.reach + 0.4 : T.reach + 0.35;
      g.position.set(v.x, 0.05, v.z); g.rotation.set(0, v.atkYaw ?? v.yaw, 0);
      edge.scale.setScalar(R); fill.scale.setScalar(R * s);
    }
  }

  // ---------- host ----------
  const live = () => [...enemies.values()];
  function spawn(st, at = null, opts = {}) {
    // in through a real door when the world has entries (an indoor world's doors to the street, a park's gates)
    let p = at;
    if (!p && typed && ctx.world?.levels?.length) {
      const zone = ctx.world.zone?.('arena');
      if (zone) p = arenaPoint({ at: zone.at, size: zone.size }, () => ctx.rng(), { avoid: ctx.players.list().filter(q => q.alive !== false).map(q => ({ x: q.position.x, z: q.position.z })), away: 6 });
    }
    p ??= ctx.world.entry?.(() => ctx.rng()) ?? edgePoint(A, () => ctx.rng());
    if (typed) {
      const ty = Number.isInteger(opts.ty) ? opts.ty : pickType(TYPES, enc.level, () => ctx.rng(), enc.mix);
      const crowd = opts.still ? 1 : 1 + V('hpPerPlayer') * Math.max(0, ctx.players.list().length - 1);
      const T = TYPES[ty], hp = Math.max(1, Math.round(T.hp * (opts.hpScale ?? enc.hpScale) * crowd * (1 + V('hpGrowth') * 0.25 * Math.max(0, director.wave - 1))));
      const c = keepIn(p.x, p.z);
      const e = { id: nextId++, x: c.x, z: c.z, hp, max: hp, speed: at && opts.still ? 0 : T.speed * (0.92 + ctx.rng() * 0.16) * enc.speedScale, wave: director.wave, atk: 0, side: ctx.rng() < 0.5 ? 1 : -1, hits: 0, shots: 0, stun: 0, demo: !!opts.still,
        ty, st: ST.move, t: 0, cd: 0.6 + ctx.rng() * 0.9, token: false, facing: Math.atan2(-c.x, -c.z), atkYaw: 0, hitDone: false, broken: false, summoned: !!opts.summoned };
      enemies.set(e.id, e);
      for (const fn of L.spawn.slice()) try { fn({ enemy: pub(e) }); } catch (er) { console.error(er); }
      return e;
    }
    const e = { id: nextId++, x: p.x, z: p.z, hp: st.hp, max: st.hp, speed: at ? 0 : st.speed * (0.9 + ctx.rng() * 0.2), wave: director.wave, atk: 0, side: ctx.rng() < 0.5 ? 1 : -1, hits: 0, shots: 0, stun: 0, demo: !!at };
    enemies.set(e.id, e);
    for (const fn of L.spawn.slice()) try { fn({ enemy: pub(e) }); } catch (er) { console.error(er); }
    return e;
  }
  const pub = e => ({ id: e.id, x: e.x, z: e.z, hp: e.hp, wave: e.wave, ...(typed ? { type: TYPES[e.ty]?.id, behaviour: TYPES[e.ty]?.behaviour, max: e.max, score: TYPES[e.ty]?.score } : {}) });
  function kill(e, from) {
    if (!enemies.delete(e.id)) return;
    kills++;
    if (e.token) { e.token = false; tokensUsed = Math.max(0, tokensUsed - 1); }
    const pts = typed ? (TYPES[e.ty]?.score ?? V('killPoints')) : V('killPoints');
    if (from && from.score !== undefined && pts) from.score += pts;
    killLog.push({ id: e.id, hits: e.hits, shots: e.shots, max: e.max, from: from?.id ?? null, t: r2(now()), ...(typed ? { type: TYPES[e.ty]?.id } : {}) }); if (killLog.length > 24) killLog.shift();
    recentKills.push(typed ? [e.id, from?.id ?? '', pts] : [e.id, from?.id ?? '']); if (recentKills.length > 6) recentKills.shift();
    for (const fn of L.kill.slice()) try { fn({ enemy: pub(e), from: from ?? null }); } catch (er) { console.error(er); }
  }
  function hostStep(dt) {
    const players = ctx.players.list().filter(p => p.alive !== false);
    const tp = targetPos();
    const list = live();
    for (const e of list) {
      if (e.demo) continue;                                           // QA's staged enemy stands still and never attacks
      if (e.stun > 0) { e.stun -= dt; continue; }                     // staggered by a hit
      const goals = [];
      if (V('aggro') !== 'target') for (const p of players) goals.push({ x: p.position.x, z: p.position.z, player: p });
      if (tp && targetHp > 0 && V('aggro') !== 'players') goals.push({ x: tp.x, z: tp.z, target: true });
      const n = nearestOf(e.x, e.z, goals);
      if (!n) continue;
      let goal = n.target;
      // a player who is in the way still gets attacked when the goal is the target
      if (goal.target && V('aggro') === 'target') { const q = nearestOf(e.x, e.z, players.map(p => ({ x: p.position.x, z: p.position.z, player: p }))); if (q && q.dist < V('attackRange')) goal = q.target; }
      // through the doors when the goal is in another room (world.via; null in one room or outdoors)
      const wp = ctx.world.via?.(e, goal) ?? null;
      let h = steer(e, wp ?? goal, list, { separation: 0.9 });
      const dGoal = wp ? Math.hypot(goal.x - e.x, goal.z - e.z) : h.dist;
      const reach = V('attackRange') * 0.8;
      if (dGoal > reach) {
        // look ahead for a wall or prop; turn away from it
        const ahead = { x: e.x + h.x * 0.9, y: 0.6, z: e.z + h.z * 0.9 };
        if (rayFixed(ctx, { x: e.x, y: 0.6, z: e.z }, ahead) !== null) { const t = rotate(h, 1.0 * e.side); const t2 = rotate(h, -1.0 * e.side); const a2 = { x: e.x + t.x * 0.9, y: 0.6, z: e.z + t.z * 0.9 }; h = rayFixed(ctx, { x: e.x, y: 0.6, z: e.z }, a2) === null ? t : t2; }
        const c = clampTo(A, e.x + h.x * e.speed * dt, e.z + h.z * e.speed * dt);
        e.x = c.x; e.z = c.z;
      }
      e.atk -= dt;
      if (dGoal <= V('attackRange') && e.atk <= 0) {
        e.atk = V('attackInterval');
        if (goal.player) attackPlayer(e, goal.player); else if (goal.target) attackTarget(e);
      }
    }
  }
  // typed enemies: windups, attack tokens, behaviours (types.js stepEnemy); hits on players through fair play
  function typedStep(dt) {
    const players = ctx.players.list().filter(p => p.alive !== false && (p.owned || p.drawn));
    const list = live();
    tokensUsed = list.filter(e => e.token).length;
    const cap = tokenCap(V('attackTokens'), players.length);
    const grant = () => { if (tokensUsed >= cap || now() - lastGrant < V('tokenCooldown')) return false; tokensUsed++; lastGrant = now(); return true; };
    const release = () => { tokensUsed = Math.max(0, tokensUsed - 1); };
    const avoid = (e, vx, vz) => {
      let sx = 0, sz = 0;
      for (const o of list) { if (o === e) continue; const dx = e.x - o.x, dz = e.z - o.z, d = Math.hypot(dx, dz); if (d > 1e-4 && d < 1.05) { const k = (1.05 - d) / 1.05; sx += dx / d * k; sz += dz / d * k; } }
      let x = vx + sx * dt * 2.4, z = vz + sz * dt * 2.4;
      const l = Math.hypot(x, z);
      if (l > 1e-4) {
        const ahead = { x: e.x + x / l * 0.9, y: 0.6, z: e.z + z / l * 0.9 };
        if (rayFixed(ctx, { x: e.x, y: 0.6, z: e.z }, ahead) !== null) { const t = rotate({ x: x / l, z: z / l }, 1.1 * e.side); x = t.x * l; z = t.z * l; }
      }
      return { x, z };
    };
    for (const e of list) {
      if (e.demo) continue;
      const T = TYPES[e.ty] ?? TYPES[0];
      let best = null, bd = Infinity;
      for (const p of players) { const d = Math.hypot(p.position.x - e.x, p.position.z - e.z); if (d < bd) { bd = d; best = p; } }
      const target = best ? { id: best.id, x: best.position.x, z: best.position.z } : null;
      const was = e.st;
      const acts = stepEnemy(e, T, { target, dt, now: now(), grant, release, avoid, clamp: keepIn, rng: () => ctx.rng() });
      for (const a of acts) {
        if (a.type === 'attack') attacks++;
        if (a.type === 'hit') {
          for (const pid of swingTargets(e, a.yaw, a.arc, a.reach, players.map(p => ({ id: p.id, x: p.position.x, z: p.position.z })))) {
            const p = ctx.players.get(pid); if (p) hitPlayer(e, p, { damage: a.damage, knock: a.knock, knockdown: a.knockdown, dir: { x: p.position.x - e.x, z: p.position.z - e.z } });
          }
        } else if (a.type === 'lunge-hit') {
          for (const p of players) if (Math.hypot(p.position.x - e.x, p.position.z - e.z) <= a.radius) { e.hitDone = true; hitPlayer(e, p, { damage: a.damage, knock: a.knock, knockdown: a.knockdown, dir: { x: Math.sin(a.yaw), z: Math.cos(a.yaw) } }); break; }
        } else if (a.type === 'bolt') bolts?.fire({ x: e.x + Math.sin(a.yaw) * 0.6, z: e.z + Math.cos(a.yaw) * 0.6 }, a.yaw, { speed: a.speed, radius: a.radius, damage: a.damage, from: e.id });
      }
      if (was !== e.st && e.st === ST.move && e.token) { e.token = false; release(); }
      // keep off the players' bodies (enemies are kinematic: a player never walks into one, or one into a player)
      const ko = V('keepOff');
      if (ko > 0) for (const p of players) { const dx = e.x - p.position.x, dz = e.z - p.position.z, d = Math.hypot(dx, dz); if (d < ko && d > 1e-4) { const c = keepIn(p.position.x + dx / d * ko, p.position.z + dz / d * ko); e.x = c.x; e.z = c.z; } }
    }
  }
  /** Host: a typed enemy's (or a bolt's) hit on a player, through fair play and a dash's invulnerable frames. → counted */
  function hitPlayer(e, p, { damage, knock, knockdown, dir, source = 'enemy' }) {
    if (melee()?.dodging?.(p)) { dodged++; return false; }
    const l = Math.hypot(dir.x, dir.z) || 1, imp = { x: dir.x / l * knock, y: knockdown ? 4 : 1, z: dir.z / l * knock };
    const hm = ctx.mechanics?.get('health');
    const F = ctx.fair?.on ? ctx.fair : null;
    let counted = true;
    if (hm?.damage && !hm.standin) counted = hm.damage(p, damage, { from: null, impulse: imp, source, push: !knockdown }) !== false;
    else if (F) { const why = F.blocked(p); if (why) { F.refuse(why); counted = false; } else if (knockdown) p.knock?.(imp, 0.8); else p.push?.(imp); }
    else if (knockdown) p.knock?.(imp, 0.8); else p.push?.(imp);
    if (!counted) return false;
    for (const fn of L.playerHit.slice()) try { fn({ enemy: e ? pub(e) : null, player: p, source }); } catch (er) { console.error(er); }
    return true;
  }
  // QA's staged moment (?gf-demo=waves.hit): one enemy at a time, 6 m in front of the local player, standing still
  function demoStep(dt) {
    if (enemies.size > 0) return;
    demoT -= dt;
    const me = ctx.me;
    if (demoT > 0 || !me || me.alive === false) return;
    const a = me.aim, yaw = me.yaw ?? 0;
    const heading = a && Math.hypot(a[0] ?? a.x ?? 0, a[2] ?? a.z ?? 0) > 0.1 ? { x: a[0] ?? a.x, z: a[2] ?? a.z } : { x: Math.sin(yaw), z: Math.cos(yaw) };
    let dist = 6, at = demoSpot(me.position, heading, A, dist);
    const from = { x: me.position.x, y: 0.6, z: me.position.z };
    // a melee player must reach it: turn until the way is clear (a projectile game keeps the spot straight ahead)
    if (melee()) {
      for (const turn of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
        const h = rotate({ x: heading.x / (Math.hypot(heading.x, heading.z) || 1), z: heading.z / (Math.hypot(heading.x, heading.z) || 1) }, turn);
        const t = demoSpot(me.position, h, A, 5.5);
        if (rayFixed(ctx, from, { x: t.x, y: 0.6, z: t.z }) === null && rayFixed(ctx, { x: me.position.x, y: 1.6, z: me.position.z }, { x: t.x, y: 1.6, z: t.z }) === null) { at = t; dist = 5.5; break; }
      }
    }
    const wall = rayFixed(ctx, from, { x: at.x, y: 0.6, z: at.z });
    if (wall !== null) { dist = Math.max(3, wall - 0.8); at = demoSpot(me.position, heading, A, dist); }
    if (typed) { const c = keepIn(at.x, at.z); at = { x: c.x, z: c.z }; }
    spawn(waveStats(1, stats()), at, { still: true, ty: 0, hpScale: 1 });
    demoT = 0.8;
  }
  function attackPlayer(e, p) {
    const hm = ctx.mechanics?.get('health'), away = { x: p.position.x - e.x, z: p.position.z - e.z }, l = Math.hypot(away.x, away.z) || 1;
    const imp = { x: away.x / l * V('contactKnock'), y: 2.5, z: away.z / l * V('contactKnock') };
    // fair play (CONTRACT §6c): contact damage is a continuous attack: it shoves and never knocks over (F6); a player who
    // is down, out or protected takes nothing, and onPlayerHit hears only of hits that counted (F2, F8)
    const F = ctx.fair?.on ? ctx.fair : null;
    let counted = true;
    if (hm?.damage && !hm.standin) counted = hm.damage(p, V('damage'), { from: null, impulse: imp, source: 'enemy', push: !!F }) !== false;
    else if (F) { const why = F.blocked(p); if (why) { F.refuse(why); counted = false; } else p.push?.(imp); }
    else p.knock?.(imp, 0.8);
    if (!counted) return;
    for (const fn of L.playerHit.slice()) try { fn({ enemy: pub(e), player: p }); } catch (er) { console.error(er); }
  }
  function attackTarget(e) {
    targetHp = Math.max(0, targetHp - V('damage'));
    for (const fn of L.targetHit.slice()) try { fn({ enemy: pub(e), hp: targetHp }); } catch (er) { console.error(er); }
    if (targetHp <= 0 && !targetDownFired) { targetDownFired = true; for (const fn of L.targetDown.slice()) try { fn({}); } catch (er) { console.error(er); } }
  }
  function damageEnemy(id, amount, opts = {}) {
    const e = enemies.get(id); if (!e) return false;
    const r = hurtEnemy(e, amount, { now: now(), oneHit: !!V('oneHitKills') });
    // a hit you can see: pushed back along the shot and a short stagger (a stream's ticks push a little, never stop it)
    if (r.hit && !r.dead) {
      const stream = opts.kind === 'stream';
      if (typed) {
        const T = TYPES[e.ty];
        const dist = opts.push ?? V('hitKnock') * (stream ? 0.25 : 1);
        if (opts.impulse) { const k = knockOf(opts.impulse, dist * (1 - T.knockRes)); const c = keepIn(e.x + k.x, e.z + k.z); e.x = c.x; e.z = c.z; }
        if (opts.heavy) { e.broken = true; e.stun = Math.max(e.stun, 0.6); }
        else if (!stream && !(T.poise && (e.st === ST.windup || e.st === ST.attack))) e.stun = Math.max(e.stun, V('stagger'));
      } else {
        if (opts.impulse) { const k = knockOf(opts.impulse, V('hitKnock') * (stream ? 0.25 : 1)); const c = clampTo(A, e.x + k.x, e.z + k.z); e.x = c.x; e.z = c.z; }
        if (!stream) e.stun = Math.max(e.stun, V('stagger'));
      }
    }
    if (r.dead) kill(e, opts.from ?? null);
    return true;
  }

  // ---------- every copy ----------
  const pv = new THREE.Vector3();
  /** Screen px of a world point on this copy's camera: {x, y, front}. */
  const screen = (x, y, z) => { pv.set(x, y, z).project(ctx.camera); const W = globalThis.innerWidth ?? 0, H = globalThis.innerHeight ?? 0; return { x: (pv.x * 0.5 + 0.5) * W, y: (-pv.y * 0.5 + 0.5) * H, front: pv.z > -1 && pv.z < 1, ndc: [pv.x, pv.y] }; };
  function hitEdge(v) {
    hitsSeen++;
    const predicted = v.predAt !== undefined && now() - v.predAt < 0.4;     // this copy's own swing already showed it
    if (!predicted) v.hitT = 0;
    v.barHit = true;
    let clip = null;
    if (v.character) { if (v.character.play?.('hit', { fade: 0.05 })) clip = 'hit'; v.character.express?.('hurt', 0.5); }
    else clip = 'squash';
    lastHit = { id: v.id, hp: v.hp, max: v.max, t: r2(now()), flash: true, clip };
  }
  function deathEdge(v) {
    deathsSeen++;
    const d = { v, t: 0 };
    dying.push(d);
    if (v.tele) v.tele.visible = false;
    if (V('soundKill')) ctx.audio?.play(V('soundKill'), { at: { x: v.x, y: 1, z: v.z }, optional: true });
    // "+1" over it on the killer's own screen
    const k = (ctx.host ? recentKills : (S?.k ?? [])).find(x => x[0] === v.id);
    const pts = k?.[2] ?? V('killPoints');
    if (k && ctx.me && k[1] === ctx.me.id && pts && ctx.ui?.pop && ctx.camera) {
      ctx.camera.updateMatrixWorld();
      const s = screen(v.x, heightOf(v) + 0.5, v.z);
      if (s.front) ctx.ui.pop(`+${pts}`, s.x, s.y, ctx.me.color ?? null);
    }
    if (v.character) {
      flash(v, 0);
      // a typed enemy falls with the death clip when the clip file has it (track C); else the knockdown
      const clip = typed && v.character.clips?.includes?.('death') ? 'death' : 'knockdown';
      const kd = v.character.meta?.[clip]?.duration ?? 1.2, fallT = V('deathSeconds') * 0.55;
      v.character.locomotion?.(0, true);
      v.character.play?.(clip, { hold: true, rate: Math.max(1, kd / fallT), fade: 0.08 });
    }
  }
  // the attack clip (gf-humanoid-1, track C's melee clips: every one in body-judge ENEMY_CLIPS, so check 19 judges it):
  // a ranged enemy casts, a brute's blow is the heavy chop, the rest attack_enemy; punch on an older clip file
  const attackClip = (v, T) => { const c = v.character; if (!c) return null; const has = n => c.clips?.includes?.(n); const want = T.behaviour === 'ranged' ? 'cast' : T.behaviour === 'brute' ? 'heavy' : 'attack_enemy'; return has(want) ? want : has('slash_1') ? 'slash_1' : 'punch'; };
  function typedEdges(v, st, T) {
    if (st === v.st) return;
    const was = v.st; v.st = st;
    if (st === ST.windup) {
      v.teleT = 0;
      if (V('soundWindup')) ctx.audio?.play(V('soundWindup'), { at: { x: v.x, y: 1, z: v.z }, optional: true });
    }
    if (st === ST.attack) {
      const clip = attackClip(v, T);
      if (clip && v.character?.play) { const dur = v.character.meta?.[clip]?.duration ?? 0.6; v.character.play(clip, { rate: Math.max(1, dur / Math.max(0.2, T.active + 0.25)), fade: 0.04 }); }
      v.lungeT = 0;
      if (V('soundSwing')) ctx.audio?.play(V('soundSwing'), { at: { x: v.x, y: 1, z: v.z }, optional: true });
      // a heavy blow lands: the camera of anyone near it shakes (this copy's feel)
      if (T.knockdown && ctx.me) { const d = Math.hypot(ctx.me.position.x - v.x, ctx.me.position.z - v.z); if (d < T.reach + 4) feel?.shake(0.35 * (1 - d / (T.reach + 4))); }
    }
    if (was === ST.windup && st !== ST.attack) v.teleT = null;      // interrupted
  }
  function syncView(dt) {
    const list = ctx.host ? live().map(e => (typed ? [e.id, e.x, e.z, e.hp, e.max, e.ty, e.st, Math.round((e.st === ST.windup || e.st === ST.attack ? e.atkYaw : e.facing) / DEG)] : [e.id, e.x, e.z, e.hp, e.max])) : S.e;
    if (ctx.host || list !== lastList) {
      lastList = list;
      const seen = new Set();
      for (const e of list ?? []) {
        seen.add(e[0]);
        let v = view.get(e[0]);
        if (!v) { v = { id: e[0], x: e[1], z: e[2], yaw: 0, obj: null, character: null, making: false, born: 0, hitT: 9, hp: e[3], max: e[4] ?? e[3], ty: e[5] ?? 0, st: 0 }; view.set(e[0], v); }
        v.tx = e[1]; v.tz = e[2];
        const hp = e[3], max = e[4] ?? Math.max(v.max ?? hp, hp);
        if (hp < v.hp - 1e-6) { v.hp = hp; v.max = max; hitEdge(v); }        // a hit that did not kill (the same on every copy)
        v.hp = hp; v.max = max;
        if (typed) { v.ty = e[5] ?? 0; v.srvYaw = (e[7] ?? 0) * DEG; if (e[6] === ST.windup || e[6] === ST.attack) v.atkYaw = v.srvYaw; typedEdges(v, e[6] ?? 0, TYPES[v.ty] ?? TYPES[0]); }
      }
      for (const [k, v] of view) if (!seen.has(k)) { view.delete(k); v.gone = true; deathEdge(v); }     // the edge: it is gone (killed)
    }
    const me = ctx.me;
    for (const v of view.values()) {
      if (!v.obj && !v.making && (templ || hasBody() || typed)) makeObj(v);
      // hit-stop: a body this copy's player just struck holds still for a moment (this copy only)
      const frozen = (v.freezeT ?? 0) > 0; if (frozen) v.freezeT -= dt;
      const px = v.x, pz = v.z, k = ctx.host ? 1 : Math.min(1, dt * 9);
      if (!frozen) { v.x += (v.tx - v.x) * k; v.z += (v.tz - v.z) * k; }
      const mx = v.x - px, mz = v.z - pz, sp = Math.hypot(mx, mz) / Math.max(dt, 1e-3);
      let face = null;
      if (typed && (v.st === ST.windup || v.st === ST.attack) && v.atkYaw !== undefined) face = v.atkYaw;
      else if (sp > 0.3 && v.hitT > 0.25) face = typed && v.srvYaw !== undefined && sp < 1.2 ? v.srvYaw : Math.atan2(mx, mz);   // a knock back does not turn it round
      else if (demo && me) face = Math.atan2(me.position.x - v.x, me.position.z - v.z);   // QA's staged enemy faces the player
      else if (typed && v.srvYaw !== undefined) face = v.srvYaw;
      if (face !== null && !frozen) { let d = face - v.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); v.yaw += d * Math.min(1, dt * (typed ? 14 : 10)); }
      v.hitT += dt;
      if (v.obj) {
        v.born = Math.min(1, v.born + dt * 4);
        const s = 0.3 + 0.7 * v.born, q = v.character ? 0 : Math.max(0, 1 - v.hitT / 0.22);      // a stand-in squashes on a hit
        v.obj.position.set(v.x, 0, v.z); v.obj.rotation.y = v.yaw;
        v.obj.scale.set(s * (1 + 0.14 * q), s * (1 - 0.2 * q), s * (1 + 0.14 * q));
        if (typed) {
          const T = TYPES[v.ty] ?? TYPES[0];
          // the windup reads: it leans back and glows in the telegraph colour while its mark fills on the ground
          if (v.st === ST.windup) { v.teleT = (v.teleT ?? 0) + (frozen ? 0 : dt); const share = Math.min(1, v.teleT / T.windup); v.obj.rotation.x = -0.18 * smooth(share); drawTelegraph(v, T, share, true); }
          else { v.obj.rotation.x *= 0.7; drawTelegraph(v, T, 0, false); if (v.st === ST.attack && !v.character) v.obj.rotation.x = 0.22; }
          const hf = flashAt(v.hitT);
          if (hf > 0) flash(v, hf);
          else if (v.st === ST.windup) flash(v, 0.45 + 0.3 * Math.sin((v.teleT ?? 0) * 26), V('telegraphColor'));
          else flash(v, 0);
        } else flash(v, flashAt(v.hitT));
        if (v.character) { v.character.locomotion?.(Math.min(sp, 6), true); v.character.update?.(frozen ? 0 : dt); }
      }
    }
    // deaths: the fall (knockdown, or a stand-in tipping over), then a sink into the floor
    for (let i = dying.length - 1; i >= 0; i--) {
      const d = dying[i]; d.t += dt;
      const pose = deathPose(d.t, V('deathSeconds'));
      const o = d.v.obj;
      if (o) {
        if (d.v.character) d.v.character.update?.(dt);
        else { o.rotation.x = -Math.PI / 2 * smooth(pose.fall); flash(d.v, 0); }
        o.position.y = -0.9 * smooth(pose.sink);
        if (pose.sink > 0.6) o.scale.setScalar((0.3 + 0.7 * d.v.born) * (1 - 0.4 * smooth((pose.sink - 0.6) / 0.4)));
      }
      if (pose.done || (!o && d.t > 0.3)) { o?.removeFromParent(); d.v.character?.dispose?.(); d.v.tele?.removeFromParent(); dying.splice(i, 1); }
    }
    // health bars over every enemy that has been hit, from the shared hit points (so the same on every copy)
    if (ctx.ui?.bars && ctx.camera) {
      ctx.camera.updateMatrixWorld();
      const rows = [];
      for (const v of view.values()) {
        if (!v.obj || !(v.hp < v.max - 1e-6) || v.hp <= 0) continue;
        const s = screen(v.x, heightOf(v) + 0.32, v.z);
        rows.push({ id: v.id, x: s.x, y: s.y, value: v.hp, max: v.max, color: V('barColor'), visible: s.front && Math.abs(s.ndc[0]) < 1.05 && Math.abs(s.ndc[1]) < 1.05, hit: !!v.barHit });
        v.barHit = false;
      }
      ctx.ui.bars('waves', rows);
    }
  }

  // ---------- the melee mechanic's targets (kit/mechanics/melee: ctx.meleeTargets) ----------
  const meleeProvider = {
    key: 'w',
    list: () => [...view.values()].filter(v => v.obj && v.hp > 0).map(v => ({ id: v.id, x: v.x, z: v.z, radius: radiusOf(v), height: heightOf(v) })),
    hostFind: id => { const e = enemies.get(id); return e ? { x: e.x, z: e.z, radius: radiusOf(e) } : null; },
    /** The host applies a swing's hit: guard, damage (each swing once: melee dedupes), push and stagger. */
    hit({ id, attacker, damage, dir, move }) {
      const e = enemies.get(id); if (!e) return { counted: false };
      const T = typeOf(e);
      if (T && guardBlocks(e, T, attacker.position, move)) {
        // blocked: no damage; the attacker is pushed back a little and the enemy turns to them
        if (attacker.owned && attacker.controller?.capsule) attacker.controller.capsule.push({ x: -dir.x * 3, y: 0, z: -dir.z * 3 }, 0.15); else attacker.push?.({ x: -dir.x * 3, y: 0, z: -dir.z * 3 });
        e.blocks = (e.blocks ?? 0) + 1;
        return { counted: false, blocked: true };
      }
      const before = e.hp;
      damageEnemy(id, damage, { from: attacker, kind: 'melee', impulse: { x: dir.x * move.knockback, z: dir.z * move.knockback }, push: 0.07 * move.knockback, heavy: !!(move.knockdown || move.guardBreak) });
      e.shots++;
      return { counted: true, killed: !enemies.has(id), damage: before - Math.max(0, enemies.get(id)?.hp ?? 0) };
    },
    /** This copy's swing struck it: the flash and a short freeze at once, before the host's hit points arrive. */
    feel(id, { hitStop = 0.05, blocked = false } = {}) {
      const v = view.get(id); if (!v) return;
      v.freezeT = Math.max(v.freezeT ?? 0, hitStop);
      if (!blocked) { v.hitT = 0; v.predAt = now(); }
    },
    /** Would its guard stop this swing (as this copy draws it)? */
    guards(id, attacker, move) { const v = view.get(id); const T = v && typed ? TYPES[v.ty] : null; return !!T && guardBlocks({ x: v.x, z: v.z, facing: v.yaw, st: v.st }, T, attacker.position, move); },
  };

  const api = {
    id, params: P,
    /** The game's enemy types (empty: the classic waves). */
    types: TYPES,
    /** Every copy: {wave, alive, kills, targetHp, targetMax, phase, cleared, hasTarget}. */
    state() {
      const w = ctx.host ? [director.wave, kills, Math.round(targetHp * 10) / 10, director.phase] : (S?.w ?? [0, 0, V('targetHp'), 'wait']);
      const alive = ctx.host ? enemies.size : (S?.e?.length ?? 0);
      const base = { wave: w[0], kills: w[1], targetHp: w[2], targetMax: V('targetHp'), phase: w[3], alive, cleared: w[3] === 'done' && alive === 0, hasTarget: !!targetPos() };
      if (!typed && !managed) return base;
      return { ...base, typed, level: ctx.host ? enc.level : (w[4] ?? 1), encounter: ctx.host ? enc.active : !!w[5], encounterCleared: ctx.host ? api.encounterCleared() : !!w[6], tokens: ctx.host ? tokensUsed : (w[7] ?? 0) };
    },
    /** Host: hurt enemy `id` (opts {from: player, impulse, kind}). A kill scores killPoints for `from`. */
    damageEnemy,
    /** Host: hurt every enemy within `radius` of {x, z}. → how many were hit. */
    damageNear(point, radius, amount, opts = {}) { let n = 0; for (const e of live()) if (Math.hypot(e.x - point.x, e.z - point.z) <= radius) { damageEnemy(e.id, amount, { ...opts, impulse: opts.impulse ?? { x: (e.x - point.x) * 4, z: (e.z - point.z) * 4 } }); n++; } return n; },
    /** Host: spawn one enemy now (outside the wave plan). */
    spawnOne() { if (ctx.host && enemies.size < V('maxAlive')) spawn(waveStats(Math.max(1, director.wave), stats())); },
    /** Host: one enemy of a type (id or index) at {x, z} (or a spot in the arena): the boss's summons. → its id or null */
    spawnType(type, at = null, opts = {}) {
      if (!ctx.host || !typed || enemies.size >= V('maxAlive')) return null;
      const ty = typeof type === 'number' ? type : Math.max(0, TYPES.findIndex(t => t.id === type));
      return spawn(null, at, { ...opts, ty, summoned: true })?.id ?? null;
    },
    /** Host: a slow bolt (the boss's volley uses the same bolts). */
    fireBolt(at, yaw, opts = {}) { return bolts?.fire(at, yaw, opts) ?? false; },
    /** Host: skip to the next wave now. */
    nextWave() { if (ctx.host) { director.phase = 'rest'; director.t = 0; } },
    /** The levels mechanic runs the waves: no wave starts until startEncounter. */
    manage(on = true) { managed = !!on; },
    get managed() { return managed; },
    /** Host: a level's encounter: `waves` waves of a type mix that grows with `level` (1-based). */
    startEncounter({ level = 1, waves = 2, startCount = V('startCount'), growth = V('growth'), hpScale = 1, speedScale = 1, mix = null, firstDelay = 1.2, restSeconds = Math.min(3, V('restSeconds')) } = {}) {
      if (!ctx.host) return;
      enc = { level, active: true, waves, hpScale, speedScale, mix, done: false };
      director = createDirector({ firstDelay, restSeconds, interval: V('interval'), mode: 'clear', spawnEvery: V('spawnEvery'), maxWaves: Math.max(1, waves), stats: { ...stats(), startCount, growth } });
      A = areaOf(ctx.world);
    },
    /** Host: no more waves (the boss level, a won run). */
    endEncounter() { if (ctx.host) { enc = { ...enc, active: false }; director.done = true; director.phase = 'done'; } },
    /** Host: every enemy and bolt gone at once (a level left behind); no kills counted. */
    clearAll() { if (!ctx.host) return; enemies.clear(); bolts?.clear(); tokensUsed = 0; },
    /** Host: this level's encounter is over: its last wave is out and every enemy is down. */
    encounterCleared() { return enc.active && director.wave >= enc.waves && (director.phase === 'rest' || director.phase === 'done') && director.left === 0 && enemies.size === 0; },
    /** Enemies now on this copy: [{id, x, z, hp, max}] (for bots and rules). */
    enemies: () => (ctx.host ? live().map(e => ({ ...pub(e), max: e.max, ...(typed ? { st: e.st } : {}) })) : (S?.e ?? []).map(e => ({ id: e[0], x: e[1], z: e[2], hp: e[3], max: e[4] ?? e[3], ...(typed ? { type: TYPES[e[5]]?.id, behaviour: TYPES[e[5]]?.behaviour, st: e[6] } : {}) }))),
    /** This copy only: hold an enemy's drawn body still for `secs` (hit-stop). */
    freeze(id, secs) { const v = view.get(id); if (v) v.freezeT = Math.max(v.freezeT ?? 0, secs); },
    /** Host: {enemy, from} / {enemy} / {enemy, player} / {enemy, hp} / {}. → unsubscribe */
    onKill(fn) { L.kill.push(fn); return unsub(L.kill, fn); },
    onSpawn(fn) { L.spawn.push(fn); return unsub(L.spawn, fn); },
    onPlayerHit(fn) { L.playerHit.push(fn); return unsub(L.playerHit, fn); },
    onTargetHit(fn) { L.targetHit.push(fn); return unsub(L.targetHit, fn); },
    onTargetDown(fn) { L.targetDown.push(fn); return unsub(L.targetDown, fn); },
    /** QA (verify check 16, through window.__game.controls()): what this copy shows of hits and kills. */
    get stats() {
      const cam = ctx.camera;
      if (cam) cam.updateMatrixWorld();
      return {
        demo, oneHitKills: !!V('oneHitKills'), hitsSeen, deathsSeen, dying: dying.length, lastHit,
        kills: killLog.slice(-16),
        ...(typed ? { typed: true, tokens: tokensUsed, attacks, dodged, bolts: bolts?.stats ?? null, telegraphs: [...view.values()].filter(v => v.tele?.visible).length } : {}),
        enemies: [...view.values()].filter(v => v.obj).map(v => ({ id: v.id, x: r2(v.x), z: r2(v.z), hp: v.hp, max: v.max, bar: v.hp < v.max - 1e-6, ...(typed ? { type: TYPES[v.ty]?.id, st: v.st } : {}),
          ...(cam ? { body: (({ x, y, front }) => ({ x: r2(x), y: r2(y), front }))(screen(v.x, heightOf(v) * 0.55, v.z)), head: (({ x, y, front }) => ({ x: r2(x), y: r2(y), front }))(screen(v.x, heightOf(v) + 0.32, v.z)), feet: (({ x, y }) => ({ x: r2(x), y: r2(y) }))(screen(v.x, 0, v.z)) } : {}) })),
      };
    },
    reset() { enemies.clear(); director.reset(); kills = 0; targetHp = V('targetHp'); targetDownFired = false; started = false; view.forEach(v => { v.obj?.removeFromParent(); v.character?.dispose?.(); v.tele?.removeFromParent(); }); view.clear(); dying.forEach(d => { d.v.obj?.removeFromParent(); d.v.character?.dispose?.(); d.v.tele?.removeFromParent(); }); dying.length = 0; lastList = null; lastWave = 0; recentKills.length = 0; demoT = 0; ctx.ui?.bars?.('waves', []); bolts?.clear(); tokensUsed = 0; lastGrant = -9; attacks = 0; dodged = 0; if (managed) enc = { level: 1, active: false, waves: 0, hpScale: 1, speedScale: 1, mix: null, done: false }; },
    update(dt) {
      if (!S) {
        if (!(ctx.shared && ctx.players && ctx.me)) return;
        S = ctx.shared.register('waves', { e: [], w: [0, 0, V('targetHp'), 'wait'], k: [] });
        loadTemplate();
        const prj = ctx.mechanics.get('projectile');
        if (V('hittable') && prj && !prj.standin && prj.addTargets) prj.addTargets({ list: () => (ctx.host ? live().map(e => ({ id: `e${e.id}`, x: e.x, y: 0, z: e.z, radius: radiusOf(e), height: typed ? (TYPES[e.ty]?.height ?? V('height')) : V('height') })) : []), hit: h => { const id = Number(String(h.target ?? h.targetId).replace(/^e/, '')); const e = enemies.get(id); if (e) e.shots++; damageEnemy(id, h.damage ?? 1, { from: h.shooter, kind: h.kind, impulse: h.dir ? { x: h.dir[0] * 4, z: h.dir[2] * 4 } : null }); } });
        // the crosshair stops on an enemy where this copy draws it (kit/core/aim.js), so a shot lands on the one under it
        if (V('hittable') && ((prj && !prj.standin) || melee())) { aimSrc = () => [...view.values()].filter(v => v.obj).map(v => ({ id: `e${v.id}`, x: v.x, z: v.z, height: heightOf(v), radius: radiusOf(v) })); (ctx.aimBodies ??= []).push(aimSrc); }
        // swings hit enemies (kit/mechanics/melee)
        if (V('hittable') && melee()) (ctx.meleeTargets ??= []).push(meleeProvider);
      }
      if (!templ && !loading && !hasBody()) loadTemplate();
      // a scenic world's level changed: the play area follows it
      if ((ctx.world?.level ?? null) !== worldLevel) { worldLevel = ctx.world?.level ?? null; A = areaOf(ctx.world); }
      if (ctx.host) {
        if (ctx.round?.phase === 'playing') {
          if (!started) { started = true; }
          if (demo) demoStep(dt);
          else if (!managed || enc.active) { const n = director.update(dt, enemies.size); for (let i = 0; i < n; i++) spawn(director.stats); }
          if (typed) typedStep(Math.min(dt, 0.05)); else hostStep(Math.min(dt, 0.05));
        }
        S.e = typed ? live().map(e => [e.id, r2(e.x), r2(e.z), e.hp, e.max, e.ty, e.st, Math.round((e.st === ST.windup || e.st === ST.attack ? e.atkYaw : e.facing) / DEG)]) : live().map(e => [e.id, r2(e.x), r2(e.z), e.hp, e.max]);
        S.w = typed || managed ? [director.wave, kills, Math.round(targetHp * 10) / 10, director.phase, enc.level, enc.active ? 1 : 0, api.encounterCleared() ? 1 : 0, tokensUsed] : [director.wave, kills, Math.round(targetHp * 10) / 10, director.phase];
        S.k = recentKills.slice();
      }
      bolts?.update(dt);
      syncView(dt);
      // edges every copy: the wave banner
      const w = api.state();
      if (w.wave !== lastWave) { if (w.wave > lastWave && w.wave > 0 && V('banner')) ctx.ui?.banner(V('bannerText').replace('{n}', w.wave), 1.6); lastWave = w.wave; }
      // the target: a ring on the ground and a HUD bar
      if (api.state().hasTarget) {
        const tp = targetPos();
        if (!ring) { ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: V('color'), transparent: true, opacity: 0.6, depthWrite: false })); ring.position.set(tp.x, 0.04, tp.z); ctx.assets.tag(ring, 'mechanic.waves.color'); root.add(ring); }
        if (ctx.ui?.meter) { if (!meter) meter = ctx.ui.meter('target', { label: V('targetLabel'), value: w.targetHp, max: V('targetHp'), color: V('color') }); meter.set(w.targetHp, V('targetHp')); }
      }
    },
    dispose() {
      root.removeFromParent(); meter?.remove(); ctx.ui?.bars?.('waves', []); bolts?.dispose();
      if (aimSrc && ctx.aimBodies) { const i = ctx.aimBodies.indexOf(aimSrc); if (i >= 0) ctx.aimBodies.splice(i, 1); }
      if (ctx.meleeTargets) { const i = ctx.meleeTargets.indexOf(meleeProvider); if (i >= 0) ctx.meleeTargets.splice(i, 1); }
    },
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
  describe: 'Host-owned enemies, spawners, a target to defend',
  rank: 60,
  needs: { parts: [], world: [] },
  uses: ['projectile', 'melee', 'health', 'levels', 'boss', 'loot'],
  owns: () => [],
  state: { key: 'waves', fields: { e: '[[id, x, z, hp, max]] per enemy (a typed row adds type, state, yaw)', w: '[wave, kills, targetHp, phase] (levels add level, encounter on, cleared, tokens)', k: '[[enemyId, killerId]] the last 6 kills' } },
  events: [
    { name: 'onKill', on: 'host', args: '{ enemy: { id, x, z, hp, wave }, from }', when: 'an enemy went down (from: the player who did it, or null)' },
    { name: 'onSpawn', on: 'host', args: '{ enemy }', when: 'an enemy came in' },
    { name: 'onPlayerHit', on: 'host', args: '{ enemy, player }', when: 'an enemy hit a player' },
    { name: 'onTargetHit', on: 'host', args: '{ enemy, hp }', when: 'an enemy hit the target' },
    { name: 'onTargetDown', on: 'host', args: '{}', when: 'the target ran out of health' },
  ],
  sync: { owner: 'host', how: 'the host owns every enemy, the wave plan and the target\'s health; copies draw from the shared rows' },
  note: [
    'target is the name of a zone in config/world.json (never a prop\'s name): the enemies go for it and the HUD shows its health; put the thing to defend in that zone.',
    'A kill already scores killPoints for the player who did it, and shots and swings already hurt enemies: nothing to wire.',
    'A basic enemy takes 2 to 4 hits; one-hit kills only when the spec sets oneHitKills.',
  ],
  stub: {
    as: 'waves',
    worked: 'check(ctx) { return waves.state().targetHp <= 0 ? { winners: [], reason: \'lost\' } : null; }',
    traps: [
      'adding score in onKill counts every kill twice (killPoints is already added): set killPoints to 0 first, or score something else there',
      'with aggro "target" and a target that is not a zone, the enemies stand where they came in',
    ],
  },
  signs: {
    sample: sh => (sh.waves ? { waves: { e: sh.waves.e ?? [], w: sh.waves.w ?? null } } : null),
    judge: v => {
      const W = v.goal.waves, L = v.limits, r1 = v.r1, aim = v.aim, names = v.names;
      const page = v.alive ?? null;
      const ws = page ? v.wavesOn(page) : v.waves, wAll = v.waves;
      const where = page ? `undefended for ${v.secs(page)} s (no bots, the player standing still)` : `on ${names}`;
      if (!ws.seen) { v.add('enemies come', 'unmeasured', 'snapshot().shared.waves', `no waves state ${where}`); return; }
      if (!ws.maxAlive) v.add('enemies come', 'dead', 'shared.waves.e', `no enemy came ${where} (firstDelay ${W.firstDelay} s, startCount ${W.startCount})`, 'check mechanics[waves].params (firstDelay, startCount, maxWaves) and that rules do not remove enemies');
      else {
        v.add('enemies come', 'ok', 'shared.waves.e', `${ws.maxAlive} at once, the first at ${r1(ws.firstAt)} s`);
        const goalWords = W.aggro === 'target' ? (W.zone ? `the target zone "${W.zone.name}"` : 'a target that does not exist') : W.aggro === 'players' ? 'the nearest player' : `the nearest player${W.zone ? ` or zone "${W.zone.name}"` : ''}`;
        if (ws.closed >= L.APPROACH_M || ws.reached) v.add('enemies go for their goal', 'ok', 'shared.waves.e positions', `they closed ${ws.closed} m on ${goalWords}${ws.reached ? ' and reached it' : ''}`);
        else v.add('enemies go for their goal', 'dead', 'shared.waves.e positions', `${W.aggro === 'target' && !W.zone ? 'the enemies had no goal (their target does not exist)' : `the enemies did not go for ${goalWords}`} ${where}: the most any closed on a goal was ${ws.closed} m, the farthest any moved ${ws.moved} m`,
          W.zone || W.aggro !== 'target' ? 'check waves speed and that walls or props do not box the spawn edges in' : 'give waves a target zone (above), or set aggro "nearest" so they come for the players');
      }
      if (W.zone) {
        if (!page) v.add('an idle player loses the target', 'unmeasured', 'shared.waves.w[2] (target health), undefended', 'the undefended page did not run');
        else {
          const drop = ws.hp0 > 0 && ws.hpMin !== null ? (ws.hp0 - ws.hpMin) / ws.hp0 : 0;
          if (ws.hp0 === null) v.add('an idle player loses the target', 'unmeasured', 'shared.waves.w[2]', 'the target\'s health was never reported');
          else if (drop >= L.TARGET_DROP || ws.hpMin <= 0) v.add('an idle player loses the target', 'ok', 'shared.waves.w[2] (target health)', `nobody defended it: ${W.label} ${r1(ws.hp0)} → ${r1(ws.hpMin)} in ${v.secs(page)} s`);
          else v.add('an idle player loses the target', 'dead', 'shared.waves.w[2] (target health)', `nobody defended the ${W.label} for ${v.secs(page)} s and its health went ${r1(ws.hp0)} → ${r1(ws.hpMin)} (needs a ${L.TARGET_DROP * 100}% drop): ${ws.reached ? 'enemies reached it but did not hurt it' : `no enemy got within attackRange ${W.attackRange} m (+${L.REACH_SLACK})`}`,
            ws.reached ? 'check waves damage and attackInterval, and that rules do not refill targetHp' : 'check attackRange against the size of what stands in the zone (enemies stop at its collider), and waves speed');
        }
      } else if (page && W.aggro !== 'target' && v.has('health')) {
        // no target: the goal is the player's own skin, and an idle player alone must get hurt
        const me = v.othersOn(page);
        if (me.hpFell || me.down) v.add('an idle player is hurt', 'ok', 'shared.hp.h, players down (undefended)', `the enemies reached the idle player and ${me.hpFell ? `hurt them (hit points down to ${me.hpMin})` : 'knocked them down'}`);
        else v.add('an idle player is hurt', 'dead', 'shared.hp.h, players down (undefended)', `the player stood still for ${v.secs(page)} s with no bots and was never hurt (the closest an enemy came: ${ws.reached ? 'in reach' : `${ws.closed} m closer than where it came in`})`,
          'check waves damage, attackRange and aggro ("nearest" or "players"), and that rules do not protect the player');
      }
      // a player's shot hurts an enemy
      if (W.hittable && v.has('projectile')) {
        if (aim?.hit) v.add('a shot hurts an enemy', 'ok', 'shared.waves.e hp and w[1] kills, while the player fired', `the player aimed at an enemy ${aim.distance} m away and fired: ${aim.kill ? 'it died' : `its hit points went ${aim.hpBefore} → ${aim.hpAfter}`}`);
        else if (wAll.kills > 0 || wAll.enemyHpDrop) v.add('a shot hurts an enemy', 'ok', 'shared.waves.w[1] kills', `${wAll.kills} killed on the pages with bots${aim ? `; the aimed shot did not land (${aim.why})` : ''}`);
        else v.add('a shot hurts an enemy', aim?.measured ? 'dead' : 'unmeasured', 'shared.waves.e hp and w[1] kills', `no enemy was hurt or killed on any page (${names})${aim ? `; the aimed player: ${aim.why}` : ''}`,
          'check that waves.hittable is on and the shots reach the enemies (projectile speed, lifetime, the aim at the crosshair), and that rules.bot makes bots shoot them');
      }
    },
  },
};
