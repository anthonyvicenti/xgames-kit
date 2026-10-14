// mechanic: loot (track M, gf-scenic wave 1). Kills drop coins and sometimes a heal potion; chests open on a press of
// interact (E) and spill more; weapon drops swap the melee mechanic's weapon, in a rarity colour; between levels every
// player picks one of three upgrade cards. Coins count on the HUD. README.md has the network ownership and the API.
//
//   const loot = ctx.mechanics.get('loot');
//   loot.coinsOf(p); loot.modsOf(p);           // every copy: a player's coins, and their upgrades as melee mods
//   loot.drop('coin', x, z); loot.placeChests(n, zone); loot.offerUpgrades();   // host
//
// Creator, 2026-10-08 (the roguelike miss): a roguelike "like Lost Castle and Rampage Knights" lives on what you pick
// up between fights. The host owns every drop; a player's copy takes what its player walks over (or presses E at) and
// tells the host, which checks the distance and applies it.
import * as THREE from 'three';
import { KIND, KIND_NAME, rollDrops, chestDrops, pickUpgrades, scatter, canTake } from './logic.js';
import { UPGRADES, modsOf, NO_MODS } from '../melee/logic.js';
import { arenaPoint } from '../waves/types.js';
import { physicsOf, WORLD_GROUPS } from '../../core/util.js';
import { forSlot } from '../../assets/items.js';

export const id = 'loot';
export const examples = ['coins and potions from every kill', 'chests to open between fights', 'weapon drops in rarity colours', 'pick an upgrade between levels'];

const D = {
  potionChance: 0.12, potionHeal: 2, weaponChance: 0.06, chestWeapon: 0.5, bossDrops: true,
  touch: 0.9, magnet: 2.6, reach: 1.8, maxDrops: 20, dropSeconds: 45,
  upgrades: ['sharper', 'quicker', 'fleet', 'reach', 'heavy', 'mend'], upgradeCount: 3, botPickSeconds: 2,
  coinColor: '#ffd23f', potionColor: '#ff4d6a', chestColor: '#8a5a2b', chestTrim: '#e0b04a',
  coinProp: 'coin', potionProp: 'potion', chestProp: 'chest', chestLid: 'chest_lid', chestHinge: [0, 0.375, -0.441], chestOpen: -110,
  label: 'Coins', upgradeTitle: 'Choose an upgrade', chestPrompt: 'open the chest', weaponPrompt: 'take the {name}',
  soundCoin: 'loot-coin', soundPotion: 'loot-potion', soundChest: 'loot-chest', soundWeapon: 'loot-weapon', soundUpgrade: 'loot-upgrade',
};
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    potionChance: { ...num('Chance a kill drops a heal potion', 0, 1), default: D.potionChance },
    potionHeal: { ...num('Hit points a potion gives back', 0, 100), default: D.potionHeal },
    weaponChance: { ...num('Chance a kill drops a weapon (the melee mechanic\'s)', 0, 1), default: D.weaponChance },
    chestWeapon: { ...num('Chance a chest holds a weapon', 0, 1), default: D.chestWeapon },
    bossDrops: { type: 'boolean', default: D.bossDrops, description: 'The boss drops a pile of coins, a potion and an epic weapon' },
    touch: { ...num('Coins and potions are taken within this distance (m)', 0.3, 3), default: D.touch },
    magnet: { ...num('Coins and potions drift toward a player within this distance (m)', 0, 8), default: D.magnet },
    reach: { ...num('Chests and weapons are taken with E within this distance (m)', 0.5, 4), default: D.reach },
    maxDrops: { type: 'integer', minimum: 4, maximum: 30, default: D.maxDrops, description: 'Drops on the ground at once (each about 25 bytes of the world message)' },
    dropSeconds: { ...num('Seconds a drop stays before it fades', 5, 600), default: D.dropSeconds },
    upgrades: { type: 'array', items: { type: 'string', enum: Object.keys(UPGRADES) }, default: D.upgrades, description: 'Upgrade cards to draw from (kit/mechanics/melee/logic.js UPGRADES)' },
    upgradeCount: { type: 'integer', minimum: 1, maximum: 4, default: D.upgradeCount, description: 'Cards offered between levels' },
    botPickSeconds: { ...num('Seconds before a bot picks its card', 0, 30), default: D.botPickSeconds },
    coinColor: { type: 'string', default: D.coinColor }, potionColor: { type: 'string', default: D.potionColor }, chestColor: { type: 'string', default: D.chestColor }, chestTrim: { type: 'string', default: D.chestTrim },
    coinProp: { type: 'string', default: D.coinProp, description: 'A prop.<name> model drawn as a coin when the game has it (else the kit\'s)' },
    potionProp: { type: 'string', default: D.potionProp }, chestProp: { type: 'string', default: D.chestProp },
    chestLid: { type: 'string', default: D.chestLid, description: 'The node of the chest model that opens (research/gf-scenic/library/props.json parts.lid)' },
    chestHinge: { type: 'array', items: { type: 'number' }, default: D.chestHinge, description: 'Where the lid turns, in the chest model (m)' },
    chestOpen: { ...num('How far the lid opens (degrees about x)', -180, 180), default: D.chestOpen },
    label: { type: 'string', default: D.label, description: 'The HUD\'s coin line' }, upgradeTitle: { type: 'string', default: D.upgradeTitle },
    chestPrompt: { type: 'string', default: D.chestPrompt }, weaponPrompt: { type: 'string', default: D.weaponPrompt, description: '{name}: the weapon\'s name and rarity' },
    soundCoin: { type: 'string', default: D.soundCoin }, soundPotion: { type: 'string', default: D.soundPotion }, soundChest: { type: 'string', default: D.soundChest }, soundWeapon: { type: 'string', default: D.soundWeapon }, soundUpgrade: { type: 'string', default: D.soundUpgrade },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.loot.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : type === 'text' ? 'text' : 'gameplay', ...extra });
export const slots = [
  vs('coinColor', 'Coin colour', 'color', { tier: 'main', rank: 52 }), vs('potionColor', 'Potion colour', 'color', { rank: 40 }),
  vs('chestColor', 'Chest colour', 'color', { rank: 38 }), vs('chestTrim', 'Chest trim colour', 'color', { rank: 30 }),
  vs('potionChance', 'Potion drop chance', 'number', { tier: 'main', rank: 46, constraints: { min: 0, max: 1 } }),
  vs('weaponChance', 'Weapon drop chance', 'number', { constraints: { min: 0, max: 1 } }),
  vs('potionHeal', 'Potion heal', 'number', { constraints: { min: 0, max: 100 } }),
  vs('chestWeapon', 'Chest weapon chance', 'number', { constraints: { min: 0, max: 1 } }),
  vs('magnet', 'Pickup pull distance', 'number', { constraints: { min: 0, max: 8, unit: 'm' } }),
  vs('label', 'Coins label', 'text', { constraints: { maxLength: 24 } }), vs('upgradeTitle', 'Upgrade card title', 'text', { constraints: { maxLength: 40 } }),
  vs('chestPrompt', 'Chest prompt', 'text', { constraints: { maxLength: 40 } }), vs('weaponPrompt', 'Weapon prompt', 'text', { constraints: { maxLength: 40 } }),
  ...['soundCoin', 'soundPotion', 'soundChest', 'soundWeapon', 'soundUpgrade'].map(k => vs(k, `${k.slice(5)} sound id`, 'text', { constraints: { maxLength: 40 } })),
];

/** The upgrade cards offered between levels, as an item (kit/assets/items.js): a list of the kit's card ids, each once;
 *  a card's name and words are the kit's (melee/logic.js UPGRADES), so a page turns cards on and off. */
export const UPGRADE_ITEM = {
  key: 'upgrades', noun: 'upgrade card', nouns: 'upgrade cards', min: 1, max: Object.keys(UPGRADES).length, unique: true,
  schema: { type: 'string', enum: Object.keys(UPGRADES), title: 'Upgrade card' },
  words: Object.fromEntries(Object.entries(UPGRADES).map(([k, u]) => [k, { name: u.name, text: u.text }])),
};

/** The base slots, plus a model slot for each loot model the game has under assets/models/ (loot-chest.glb, loot-coin.glb,
 *  loot-potion.glb: e.g. KayKit's dungeon chest and coin from research/gf-scenic/library), and the upgrade cards' list. */
export function slotsFor(m = {}, cfg = {}) {
  const out = [...slots], files = new Set(cfg.files ?? []);
  if (Object.prototype.hasOwnProperty.call(m.params ?? {}, 'upgrades')) out.push({ id: 'mechanic.loot.upgrades', label: 'Upgrade cards offered', group: 'mechanics', type: 'json', source: { pointer: '{base}/upgrades' }, tier: 'advanced', rank: 12, facet: 'gameplay',
    description: `The cards a player may be offered between levels (${Object.entries(UPGRADES).map(([k, u]) => `${k}: ${u.name}, ${u.text}`).join('; ')})`, constraints: { item: forSlot(UPGRADE_ITEM) } });
  for (const [k, label] of [['chest', 'Chest model'], ['coin', 'Coin model'], ['potion', 'Potion model']]) if (files.has(`assets/models/loot-${k}.glb`))
    out.push({ id: `mechanic.loot.${k}`, label, group: 'mechanics', type: 'model', source: { file: `assets/models/loot-${k}.glb` }, tier: k === 'chest' ? 'main' : 'advanced', rank: 48, facet: 'look', constraints: { maxBytes: 4194304 }, generate: { prompt: { chest: 'a treasure chest whose lid opens', coin: 'a gold coin', potion: 'a small red heal potion' }[k], style: 'stylised low-poly game prop, clean silhouette' } });
  return out;
}

const r2 = v => Math.round(v * 100) / 100;

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.loot.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const M = id => { const m = ctx.mechanics?.get?.(id); return m && !m.standin ? m : null; };
  const root = new THREE.Group(); root.name = 'gf-loot'; ctx.scene.add(root);
  const host = new Map();        // host: id → {id, kind, x, z, w (weapon index), r (rarity), age}
  const view = new Map();        // every copy: id → {id, kind, x, z, obj, ox, oz, t}
  const pending = new Map();     // drop id → time a take was asked for (no spam)
  const rnd = () => ctx.rng();
  let S = null, lastE, nextId = 1, lastList = null, taken = 0, dropped = 0, opened = 0, picks = 0, offerSerial = 0, botPickAt = new Map(), cardsH = null, shownSerial = 0, promptOn = null;
  const stats = { coins: 0, potions: 0, weapons: 0, chests: 0 };

  // ---------- host ----------
  function add(kind, x, z, extra = {}) {
    if (!ctx.host) return null;
    while (host.size >= V('maxDrops')) { const old = [...host.values()].find(d => d.kind === KIND.coin) ?? [...host.values()][0]; host.delete(old.id); }
    const d = { id: nextId++, kind, x: r2(x), z: r2(z), w: extra.weapon ?? 0, r: extra.rarity ?? 0, age: 0 };
    host.set(d.id, d); dropped++;
    return d.id;
  }
  const keepIn = (x, z) => { const lv = ctx.world?.levels?.[ctx.world.level ?? 0]; if (!lv) return { x, z }; const cx = lv.at?.[0] ?? 0, cz = lv.at?.[2] ?? 0, R = (lv.radius ?? 12) - 1.2, dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz); return d > R ? { x: cx + dx / d * R, z: cz + dz / d * R } : { x, z }; };
  function spill(x, z, list) {
    const pts = scatter(x, z, list.length, rnd);
    list.forEach((it, i) => { const c = keepIn(pts[i].x, pts[i].z); add(it.kind, c.x, c.z, it); });
  }
  const weaponsCount = () => M('melee')?.weapons?.length ?? 0;
  function dropFor(enemy, { boss = false } = {}) {
    if (!enemy) return;
    spill(enemy.x, enemy.z, rollDrops(rnd, { score: enemy.score ?? 10, potionChance: V('potionChance'), weaponChance: V('weaponChance'), weapons: weaponsCount(), boss }));
  }
  /** Host: apply a take: the player is near enough, the drop is still there. → true */
  function take(p, id, { press = false } = {}) {
    const d = host.get(id); if (!d || !p || p.alive === false) return false;
    const dist = Math.hypot(d.x - p.position.x, d.z - p.position.z);
    if (!canTake(d.kind, dist, { touch: V('magnet') + 0.6, reach: V('reach'), slack: 1.2 })) return false;
    if ((d.kind === KIND.weapon || d.kind === KIND.chest) && !press) return false;
    const S2 = S;
    if (d.kind === KIND.coin) { S2.c = { ...S2.c, [p.id]: (S2.c?.[p.id] ?? 0) + 1 }; stats.coins++; host.delete(id); }
    else if (d.kind === KIND.potion) { M('health')?.heal?.(p, V('potionHeal')); stats.potions++; host.delete(id); }
    else if (d.kind === KIND.weapon) {
      const melee = M('melee');
      if (melee?.setWeapon) {
        // swap: the old weapon lies where the new one was
        const was = melee.weaponOf(p), wi = melee.weapons.indexOf(melee.weapons.find(w => w.id === was.id));
        melee.setWeapon(p, d.w, d.r);
        host.delete(id);
        if (wi >= 0) add(KIND.weapon, d.x, d.z, { weapon: wi, rarity: was.rarity });
      } else host.delete(id);
      stats.weapons++;
    } else if (d.kind === KIND.chest) { d.kind = KIND.open; opened++; stats.chests++; spill(d.x, d.z, chestDrops(rnd, { weaponChance: V('chestWeapon'), weapons: weaponsCount() })); }
    else return false;
    taken++;
    S2.e = [d.kind === KIND.open ? KIND.chest : d.kind, id, p.id, Math.round(ctx.time.now * 10)];   // the last take (every copy plays its sound)
    return true;
  }
  /** Host: offer every player the same cards (one pick each). */
  function offerUpgrades() {
    if (!ctx.host || !S) return;
    const ids = pickUpgrades(rnd, V('upgrades').filter(u => UPGRADES[u]), V('upgradeCount'));
    if (!ids.length) return;
    offerSerial++;
    S.o = [offerSerial, ids];
    const at = ctx.time.now;
    for (const p of ctx.players.list()) if (p.isBot) botPickAt.set(p.id, at + V('botPickSeconds') * (0.6 + rnd() * 0.8));
  }
  function pick(p, serial, i) {
    if (!ctx.host || !S || !p || !Array.isArray(S.o) || S.o[0] !== serial) return false;
    if ((S.p?.[p.id] ?? 0) >= serial) return false;
    const id = S.o[1]?.[i]; if (!id || !UPGRADES[id]) return false;
    S.p = { ...S.p, [p.id]: serial };
    S.u = { ...S.u, [p.id]: [...(S.u?.[p.id] ?? []), id] };
    if (UPGRADES[id].heal) M('health')?.heal?.(p, 999);
    picks++;
    return true;
  }

  // ---------- every copy: the drops ----------
  const mats = new Map();
  const mat = (key, color, o = {}) => { if (!mats.has(key)) mats.set(key, ctx.modules?.look?.material?.('prop', { tint: color }) ?? new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: o.metal ?? 0.2, emissive: o.glow ? color : 0x000000, emissiveIntensity: o.glow ?? 0 })); return mats.get(key); };
  // a chest is solid: every copy gives the chests it draws a fixed box collider the size of the model (players walk
  // round it, not through it; each copy simulates its own players against it)
  function solid(v) {
    const { RAPIER: R, world: W } = physicsOf(ctx);
    if (!R || !W || !v.obj || v.collider) return;
    const box = new THREE.Box3().setFromObject(v.obj), sz = box.getSize(new THREE.Vector3());
    if (!(sz.x > 0.05 && sz.z > 0.05)) return;
    const body = W.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(v.x, Math.max(0.2, sz.y / 2), v.z));
    W.createCollider(R.ColliderDesc.cuboid(sz.x / 2 * 0.9, Math.max(0.2, sz.y / 2), sz.z / 2 * 0.9).setCollisionGroups(WORLD_GROUPS), body);
    v.collider = body;
  }
  function unsolid(v) { if (!v.collider) return; try { physicsOf(ctx).world?.removeRigidBody(v.collider); } catch {} v.collider = null; }
  const propModels = new Map();
  // a loot model: the mechanic's own slot (mechanic.loot.<kind>) at its own size, else the game's prop of that name fitted
  async function propModel(name, fit, kind) {
    const own = kind && ctx.assets.has(`mechanic.loot.${kind}`) ? `mechanic.loot.${kind}` : null;
    const sid = own ?? (name && ctx.assets.has(`prop.${name}`) ? `prop.${name}` : null);
    if (!sid) return null;
    if (!propModels.has(sid)) propModels.set(sid, ctx.assets.model(sid, own ? {} : { fit, fitAxis: 'y' }).catch(() => null));
    const m = await propModels.get(sid); return m ? m.clone(true) : null;
  }
  /** A chest model's lid on a pivot at its hinge, so it opens like a lid. → the pivot or null */
  function lidPivot(model) {
    const lid = model.getObjectByName(V('chestLid')); if (!lid?.parent) return null;
    const h = V('chestHinge') ?? [0, 0, 0], pivot = new THREE.Group(); pivot.name = 'lid-hinge';
    model.updateMatrixWorld(true);
    const hingeWorld = model.localToWorld(new THREE.Vector3(h[0] ?? 0, h[1] ?? 0, h[2] ?? 0));
    lid.parent.add(pivot); pivot.position.copy(lid.parent.worldToLocal(hingeWorld.clone())); pivot.updateMatrixWorld(true);
    pivot.attach(lid);
    return pivot;
  }
  async function makeObj(d) {
    const g = new THREE.Group(); g.name = `gf-loot-${KIND_NAME[d.kind]}`;
    const tag = (o, slot) => { o.traverse(x => { if (x.isMesh) { ctx.assets.tag(x, slot); x.castShadow = true; } }); return o; };
    if (d.kind === KIND.coin) {
      const m = await propModel(V('coinProp'), 0.34, 'coin');
      g.add(m ?? tag(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.045, 20).rotateX(Math.PI / 2), mat('coin', V('coinColor'), { metal: 0.85, glow: 0.25 })), 'mechanic.loot.coin-color'));
    } else if (d.kind === KIND.potion) {
      const m = await propModel(V('potionProp'), 0.42, 'potion');
      if (m) g.add(m);
      else { const body = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), mat('potion', V('potionColor'), { glow: 0.35 })); const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.12, 10), mat('potion', V('potionColor'), { glow: 0.35 })); neck.position.y = 0.17; g.add(tag(body, 'mechanic.loot.potion-color'), tag(neck, 'mechanic.loot.potion-color')); }
    } else if (d.kind === KIND.weapon) {
      const melee = M('melee');
      const w = melee ? await melee.makeWeapon(d.w) : null;
      if (w) { w.rotation.set(Math.PI / 2, 0, 0.6); w.position.y = 0.12; g.add(w); }
      const color = melee?.rarityColor?.(d.r) ?? '#ffffff';
      const ringM = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.55, 32).rotateX(-Math.PI / 2), ringM); ring.position.y = 0.03;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.22, 2.4, 10, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending })); beam.position.y = 1.2;
      for (const o of [ring, beam]) { ctx.assets.tag(o, melee ? 'mechanic.melee.rarity-colors' : 'mechanic.loot.coin-color'); g.add(o); }
    } else {
      const m = await propModel(V('chestProp'), 0.8, 'chest');
      if (m) { g.add(m); const pv = lidPivot(m); if (pv) g.userData.lid = pv; }
      else {
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.6), mat('chest', V('chestColor'))); body.position.y = 0.25;
        const lidPivot = new THREE.Group(); lidPivot.position.set(0, 0.5, -0.3); lidPivot.name = 'lid';
        const lid = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.18, 0.62), mat('chest', V('chestColor'))); lid.position.set(0, 0.09, 0.3); lidPivot.add(lid);
        const band = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.08, 0.64), mat('trim', V('chestTrim'), { metal: 0.8 })); band.position.y = 0.42;
        const lock = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.06), mat('trim', V('chestTrim'), { metal: 0.8 })); lock.position.set(0, 0.42, 0.32);
        tag(body, 'mechanic.loot.chest-color'); tag(lid, 'mechanic.loot.chest-color'); tag(band, 'mechanic.loot.chest-trim'); tag(lock, 'mechanic.loot.chest-trim');
        g.add(body, lidPivot, band, lock); g.userData.lid = lidPivot;
      }
    }
    return g;
  }
  function syncView(dt) {
    const list = S.d;
    if (list !== lastList) {
      lastList = list;
      const seen = new Set();
      for (const e of list ?? []) {
        const [id, kind, x, z, w, r] = e; seen.add(id);
        let v = view.get(id);
        if (!v) {
          v = { id, kind, x, z, ox: x, oz: z, w, r, obj: null, t: 0, making: true }; view.set(id, v);
          makeObj(v).then(o => { v.obj = o; v.making = false; if (view.get(id) !== v) return; o.position.set(v.x, 0, v.z); root.add(o); if (v.kind === KIND.chest || v.kind === KIND.open) solid(v); }).catch(err => { v.making = false; console.warn('loot: drop', err); });
        }
        if (v.kind !== kind) { v.kind = kind; if (kind === KIND.open) v.openT = 0; }
        v.ox = x; v.oz = z;
      }
      for (const [k, v] of view) if (!seen.has(k)) { v.obj?.removeFromParent(); unsolid(v); view.delete(k); pending.delete(k); }
    }
    // magnet: coins and potions drift toward the nearest player who is up (this copy's drawing; the host takes them)
    const ps = ctx.players.list().filter(p => p.alive !== false && (p.owned || p.drawn));
    for (const v of view.values()) {
      v.t += dt;
      if ((v.kind === KIND.coin || v.kind === KIND.potion) && V('magnet') > 0) {
        let best = null, bd = V('magnet');
        for (const p of ps) { const d = Math.hypot(p.position.x - v.x, p.position.z - v.z); if (d < bd) { bd = d; best = p; } }
        if (best) { const k = Math.min(1, dt * 7 * (1 - bd / V('magnet') + 0.25)); v.x += (best.position.x - v.x) * k; v.z += (best.position.z - v.z) * k; }
        else { v.x += (v.ox - v.x) * Math.min(1, dt * 4); v.z += (v.oz - v.z) * Math.min(1, dt * 4); }
      }
      const o = v.obj; if (!o) continue;
      const pop = Math.min(1, v.t * 5);
      if (v.kind === KIND.coin) { o.position.set(v.x, 0.32 + Math.sin(v.t * 3 + v.id) * 0.06, v.z); o.rotation.y = v.t * 3; o.scale.setScalar(pop); }
      else if (v.kind === KIND.potion) { o.position.set(v.x, 0.2 + Math.sin(v.t * 2.4 + v.id) * 0.05, v.z); o.scale.setScalar(pop); }
      else if (v.kind === KIND.weapon) { o.position.set(v.x, 0, v.z); o.rotation.y = v.t * 0.8; o.scale.setScalar(pop); }
      else { o.position.set(v.x, 0, v.z); if (v.kind === KIND.open && o.userData.lid) { v.openT = (v.openT ?? 0) + dt; o.userData.lid.rotation.x = Math.max(-1, Math.min(1, V('chestOpen') / 110)) * Math.min(1.9, v.openT * 6); } }
    }
  }
  // the players this copy owns take what they walk over (coins, potions) and what they press E at (chests, weapons)
  function ownedTakes() {
    const now = ctx.time.now;
    const ask = (p, v, press) => {
      if (now - (pending.get(v.id) ?? -9) < 0.6) return;
      pending.set(v.id, now);
      if (ctx.host) take(p, v.id, { press });
      else ctx.net.send('loot:take', { i: v.id, e: press ? 1 : 0 }, 'host');
    };
    let near = null;
    for (const p of ctx.players.owned()) {
      if (p.alive === false) continue;
      const press = !!p.actions?.interact?.pressed;
      let pn = null, pd = Infinity;
      for (const v of view.values()) {
        const d = Math.hypot(v.x - p.position.x, v.z - p.position.z);
        if ((v.kind === KIND.coin || v.kind === KIND.potion) && d <= V('touch')) ask(p, v, false);
        if ((v.kind === KIND.chest || v.kind === KIND.weapon) && d <= V('reach') && d < pd) { pd = d; pn = v; }
      }
      if (pn && press) ask(p, pn, true);
      if (p.local) near = pn;
    }
    // the HUD's prompt (kit/ui/ui.js: one line per owner)
    let text = null;
    if (near) {
      const key = 'E';
      if (near.kind === KIND.chest) text = `${key}: ${V('chestPrompt')}`;
      else { const m = M('melee'), w = m?.weapons?.[near.w]; text = `${key}: ${V('weaponPrompt').replace('{name}', `${w?.name ?? 'weapon'}${near.r ? ` (${['common', 'rare', 'epic', 'legendary'][near.r]})` : ''}`)}`; }
    }
    if (text !== promptOn) { promptOn = text; ctx.ui?.prompt?.(text, 'loot'); }
  }

  // ---------- every copy: the upgrade cards for the local player ----------
  function showCards() {
    const o = S.o, me = ctx.me;
    const want = Array.isArray(o) && o[0] > 0 && me && (S.p?.[me.id] ?? 0) < o[0] && ctx.round?.phase === 'playing' ? o[0] : 0;
    if (want === shownSerial) return;
    shownSerial = want;
    cardsH?.close(); cardsH = null;
    if (!want || !ctx.ui?.panels) return;
    // the shared choice panel (kit/ui/panels, CONTRACT §6j): the cards sit at the bottom and the player keeps moving
    const ids = o[1];
    cardsH = ctx.ui.panels.choice({
      id: 'loot-cards', domId: 'gf-loot-cards', optionClass: 'gf-loot-card', placement: 'bottom', modal: false, title: V('upgradeTitle'),
      cards: ids.map(u => ({ id: u, name: UPGRADES[u]?.name ?? u, text: UPGRADES[u]?.text ?? '', attrs: { upgrade: u } })),
      onPick: ({ index }) => {
        ctx.audio?.play(V('soundUpgrade'), { optional: true });
        if (ctx.host) pick(me, want, index); else ctx.net.send('loot:pick', { s: want, i: index }, 'host');
      },
    });
  }

  const api = {
    id, params: P,
    /** Interact (E) takes chests and weapons (CONTRACT §6d: verify check 13 walks to one and presses E). */
    interacts: true,
    interactables: () => [...view.values()].filter(v => v.kind === KIND.chest || v.kind === KIND.weapon).map(v => ({ kind: 'loot', id: `loot:${v.id}`, x: v.x, y: 0, z: v.z, reach: V('reach'), touch: 0, action: 'interact', what: KIND_NAME[v.kind] })),
    /** Every copy: a player's coins. */
    coinsOf: p => (S?.c?.[p?.id] ?? 0),
    /** Every copy: a player's upgrades (ids) and what they do to the melee mechanic's moves. */
    upgradesOf: p => [...(S?.u?.[p?.id] ?? [])],
    modsOf: p => (S?.u?.[p?.id]?.length ? modsOf(S.u[p.id]) : NO_MODS),
    /** Every copy: the drops on the ground [{id, kind, x, z}]. */
    drops: () => [...view.values()].map(v => ({ id: v.id, kind: KIND_NAME[v.kind], x: r2(v.x), z: r2(v.z) })),
    /** Host: a drop ('coin' | 'potion' | 'weapon' | 'chest') at (x, z). → its id */
    drop(kind, x, z, extra = {}) { const k = typeof kind === 'number' ? kind : KIND[kind]; return k === undefined ? null : add(k, x, z, extra); },
    /** Host: what an enemy {x, z, score} drops. */
    dropFor,
    /** Host: the level's chests, `n` of them in a circle zone {at, size} (the old level's drops are cleared). */
    placeChests(n = 1, zone = null) {
      if (!ctx.host) return;
      host.clear();
      const z = zone ?? (ctx.world?.zone?.('arena') ? { at: ctx.world.zone('arena').at, size: ctx.world.zone('arena').size } : null);
      if (!z) return;
      const avoid = ctx.players.list().map(p => ({ x: p.position.x, z: p.position.z }));
      for (let i = 0; i < n; i++) { const p = arenaPoint(z, rnd, { inner: 0.35, outer: 0.7, avoid, away: 4 }); add(KIND.chest, p.x, p.z); avoid.push(p); }
    },
    offerUpgrades,
    /** Host: take a drop for a player (rules, QA). */
    take: (p, id, opts) => take(p, id, opts),
    get stats() {
      const me = ctx.me;
      return { drops: view.size, kinds: Object.fromEntries(KIND_NAME.map(k => [k, [...view.values()].filter(v => KIND_NAME[v.kind] === k).length])), dropped: ctx.host ? dropped : null, taken: ctx.host ? taken : null, opened: ctx.host ? opened : null, picks: ctx.host ? picks : null,
        coins: me ? api.coinsOf(me) : 0, upgrades: me ? api.upgradesOf(me) : [], offer: S?.o ?? null, cards: !!cardsH?.open, ...stats };
    },
    setup() {
      // drops from kills and from the boss (host)
      const waves = M('waves'), boss = M('boss');
      waves?.onKill?.(k => { if (ctx.host) dropFor({ x: k.enemy.x, z: k.enemy.z, score: k.enemy.score ?? 10 }); });
      if (V('bossDrops')) boss?.onDown?.(k => { if (ctx.host) dropFor({ x: k.x, z: k.z, score: 100 }, { boss: true }); });
    },
    reset() { host.clear(); for (const v of view.values()) { v.obj?.removeFromParent(); unsolid(v); } view.clear(); lastList = null; pending.clear(); botPickAt.clear(); offerSerial = 0; shownSerial = -1; cardsH?.close(); cardsH = null; taken = dropped = opened = picks = 0; for (const k of Object.keys(stats)) stats[k] = 0; },
    update(dt) {
      if (!S) { if (!(ctx.shared && ctx.players && ctx.me)) return; S = ctx.shared.register('loot', { d: [], c: {}, u: {}, o: [0, []], p: {}, e: [0, 0, '', 0] }); }
      const playing = ctx.round?.phase === 'playing';
      if (ctx.host) {
        for (const d of [...host.values()]) { d.age += dt; if (d.age > V('dropSeconds') && d.kind !== KIND.chest && d.kind !== KIND.open) host.delete(d.id); }
        // bots pick a card a moment after it is offered
        if (Array.isArray(S.o) && S.o[0] > 0) for (const [pid, at] of botPickAt) if (ctx.time.now >= at) { botPickAt.delete(pid); const p = ctx.players.get(pid); if (p) pick(p, S.o[0], Math.floor(rnd() * S.o[1].length)); }
        S.d = [...host.values()].map(d => [d.id, d.kind, d.x, d.z, d.w, d.r]);
      }
      syncView(dt);
      if (playing) ownedTakes();
      // the last take's sound, on every copy
      const e = S.e;
      if (Array.isArray(e) && e[3] !== lastE) { if (lastE !== undefined && e[1]) { const snd = [V('soundCoin'), V('soundPotion'), V('soundWeapon'), V('soundChest')][e[0]]; ctx.audio?.play(snd, { optional: true }); } lastE = e[3]; }
      showCards();
    },
    /** `loot:take` {i, e (pressed)} and `loot:pick` {s, i}: a player's copy asks the host. */
    event(name, d, from) {
      if (!ctx.host || !S || !d) return;
      const p = ctx.players.get(from); if (!p || p.isBot) return;
      if (name === 'take' && Number.isFinite(d.i)) take(p, d.i, { press: d.e === 1 });
      if (name === 'pick' && Number.isFinite(d.s) && Number.isFinite(d.i)) pick(p, d.s, d.i);
    },
    dispose() { root.removeFromParent(); cardsH?.close(); },
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
  describe: 'Drops, chests, coins, potions and weapons with rarity; pick one of three upgrades between levels',
  rank: 140,
  needs: { parts: [], world: [] },
  // kills drop loot through waves and the boss; potions heal through health; weapon drops and upgrade cards change the
  // melee mechanic's weapon and moves; levels places chests and offers the cards between levels
  uses: ['waves', 'boss', 'health', 'melee', 'levels'],
  // its things (kit/assets/items.js): the coin, the potion and the chest (each its own params), and the upgrade cards
  // offered between levels (a list of the kit's cards: a page turns one on or off; a new kind of card is code)
  items: [
    { single: true, noun: 'coin', fields: ['coinColor', 'magnet', 'touch'], front: ['coinColor'], picture: (p, game, has) => (has?.('mechanic.loot.coin') ? 'mechanic.loot.coin' : 'mechanic.loot.coin-color') },
    { single: true, noun: 'potion', fields: ['potionChance', 'potionHeal', 'potionColor'], front: ['potionHeal', 'potionChance'], picture: (p, game, has) => (has?.('mechanic.loot.potion') ? 'mechanic.loot.potion' : 'mechanic.loot.potion-color') },
    { single: true, noun: 'chest', fields: ['chestWeapon', 'chestColor', 'chestTrim'], front: ['chestWeapon'], picture: (p, game, has) => (has?.('mechanic.loot.chest') ? 'mechanic.loot.chest' : 'mechanic.loot.chest-color') },
    UPGRADE_ITEM,
  ],
  owns: () => [{ res: 'input.interact', shared: true, why: 'interact (E) opens a chest or takes a weapon in reach', free: 'chests and weapon drops are always taken with interact' }],
  state: { key: 'loot', fields: { d: '[[id, kind, x, z, weapon, rarity]] drops on the ground', c: '{ playerId: coins }', u: '{ playerId: [upgrade ids] }', o: '[serial, [upgrade ids]] the offer', p: 'the last offer each player picked from', e: 'the last take, for its sound' } },
  events: [],
  sync: { owner: 'host', how: 'the host owns drops, coins, upgrades and offers; a copy asks to take what its player walks over or presses E at' },
  note: [
    'Kills and the boss drop coins, potions and weapons by themselves, coins count on the HUD, and bots walk over loot: nothing to wire.',
    'loot.coinsOf(p) and loot.upgradesOf(p) are the same on every copy: put coins in results() when they are the score.',
    'The host can add its own: loot.drop(\'coin\' | \'potion\' | \'weapon\' | \'chest\', x, z), loot.placeChests(n, zone), loot.offerUpgrades().',
  ],
  stub: {
    as: 'loot',
    worked: 'results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: loot.coinsOf(p) })); }',
    traps: [
      'coins are not the score: p.score moves only where the rules (or another mechanic\'s killPoints) move it',
      'a potion heals through the health mechanic and a weapon drop needs the melee mechanic: without them those drops do nothing',
    ],
  },
  signs: {
    sample: sh => { if (!sh.loot) return null; const d = sh.loot.d ?? []; return { loot: [d.length, Object.values(sh.loot.c ?? {}).reduce((n, x) => n + (x || 0), 0), Object.values(sh.loot.u ?? {}).reduce((n, x) => n + (x?.length ?? 0), 0), d.filter(x => x[1] === 4).length] }; },
    judge: v => {
      const a = v.action, takes = a.coins + a.upgrades + a.chestsOpened;
      if (a.drops > 0 && takes > 0) v.add('loot drops and is taken', 'ok', 'shared.loot (drops, coins, upgrades, opened chests)', `${a.drops} on the ground at once; ${a.coins} coins taken, ${a.chestsOpened} chest${a.chestsOpened === 1 ? '' : 's'} opened, ${a.upgrades} upgrade${a.upgrades === 1 ? '' : 's'} picked`);
      else v.add('loot drops and is taken', a.drops > 0 ? 'dead' : 'unmeasured', 'shared.loot (drops, coins, upgrades, opened chests)', a.drops > 0 ? `drops lay on the ground and nobody took one on any page (${v.names})` : `nothing dropped on any page (${v.names})`,
        'check loot touch and magnet, that kills drop coins (waves onKill), and that the kit\'s melee bots walk over loot when no enemy is near');
    },
  },
};
