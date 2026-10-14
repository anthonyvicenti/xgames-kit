// mechanic loot, the forge runtime's implementation (vendored as gf/three/mechanics/loot/impl/forge/index.js; the boot
// loads it through gf/forge/mechanics.js). What a kill drops, on forge (components/loot/README.md for three's):
//
//   coins      the core's: a kill's coins fly to the nearest player standing (forge-feel kills.rs; each enemy row's
//              `coins`), and each one reaching a player is a `coin` rule event. The host counts them per player in
//              ctx.shared 'loot' ({c: {playerId: coins}, d: drops}, the shape three's loot has): coinsOf(p) is the same number on every copy
//   potions    `potionChance` of a kill leaves a potion where the enemy fell (the host rolls with the game's seeded
//              stream); any standing player who walks within `touch` metres takes it and gets `potionHeal` hit points
//              back (the core's health, never past full). It fades after `dropSeconds`; at most `maxDrops` lie about (and never more than 10 on forge).
//              Drawn on every copy from the shared rows: the `potionProp` slot's model (prop.<name>) or the kit's coin
//              (fight.coin) tinted `potionColor`
//   weapons    `weaponChance` of a kill leaves a weapon from the tables that nobody starts with (forge-feel's own weapon
//              pickup: walking over it puts it in hand, as the tables' pickups do)
//
//   const loot = ctx.mechanics.get('loot');
//   loot.coinsOf(p);  loot.onCoin(({ player, value }) => …);  loot.onTake(({ player, kind, value }) => …)   // host
//   loot.drops() → [{id, kind, x, y, z}];  loot.drop('potion', {x, z}) (host, the rules' own) → id
//
// Not on forge (observe().notOnForge): chests, the upgrade cards between levels (forge has its own reward cards and
// the pedlar's cart: spec.tables.cards, shop), rarity, the magnet pull, a press of E to take a drop.

export const id = 'loot';
const D = { potionChance: 0.12, potionHeal: 2, weaponChance: 0.06, touch: 0.9, maxDrops: 20, dropSeconds: 45, potionColor: '#ff4d6a', potionProp: 'potion', label: 'Coins', soundPotion: 'loot-potion', soundCoin: 'loot-coin' };
/** Drop kinds, as three's loot numbers them (components/loot/logic.js KIND). */
const KIND = { coin: 0, potion: 1, weapon: 2 };
/** At most this many drops ride the world message on forge (the core's snapshot shares it). */
export const MAX_DROPS = 10;

export function create(ctx, params = {}, K) {
  const P = { ...D, ...params };
  const V = k => K.valueOf(ctx, 'loot', P, k, D[k]);
  const L = { coin: K.listeners('loot.onCoin'), take: K.listeners('loot.onTake') };
  const prop = String(V('potionProp') || '');
  const marks = K.createMarks(ctx, { slot: prop && ctx.assets?.has?.(`prop.${prop}`) ? `prop.${prop}` : 'fight.coin', size: 0.42, tint: prop && ctx.assets?.has?.(`prop.${prop}`) ? null : V('potionColor'), mix: 0.7, spin: 1.2, bob: 0.06, lift: 0.55 });
  const killAt = new Map();       // the host: where each enemy fell (its KILL event's point), for the drop
  const rng = ctx.rng?.fork?.('loot') ?? ctx.rng;
  const roll = () => (typeof rng?.next === 'function' ? rng.next() : typeof rng === 'function' ? rng() : Math.random());
  const stats = { coins: 0, potions: 0, taken: 0, weapons: 0, faded: 0, sounds: 0 };
  let S = null, off = [], serial = 0;
  const seen = new Map();
  const weaponRows = () => {
    const W = ctx.tables?.weapons ?? [];
    return W.map((w, i) => ({ w, i })).filter(({ w }) => w && w.start === false).map(({ i }) => i);
  };

  function drop(kind, at) {
    if (!ctx.host || !S) return -1;
    const list = S.d ?? [];
    if (list.length >= Math.max(1, Math.min(MAX_DROPS, Number(V('maxDrops')) || 20))) list.shift();
    const id = ++serial;
    // [id, kind, x, z, y, laid at] (three's rows are [id, kind, x, z, weapon, rarity]: the gates read id, kind, x and z)
    list.push([id, KIND[kind] ?? KIND.potion, Math.round(at.x * 100) / 100, Math.round(at.z * 100) / 100, Math.round((at.y ?? 0) * 100) / 100, Math.round(ctx.time.now * 10) / 10]);
    S.d = list;
    return id;
  }
  function take(player, row) {
    const heal = Number(V('potionHeal')) || 0, n = K.coreIdOf(ctx, player), h = player.health;
    if (n != null && h && h.max > 0) ctx.forge.cmd.setHealth(n, Math.min(h.max, h.hp + heal), h.max, h.armor ?? 0);
    S.d = (S.d ?? []).filter(r => r[0] !== row[0]);
    stats.taken++;
    L.take.emit({ player, kind: 'potion', value: heal, point: { x: row[2], y: row[4], z: row[3] } });
  }

  return {
    setup(c) {
      S = c.shared.register('loot', { c: {}, d: [] });
      off.push(c.forge.on('kill', e => { if (c.host && Array.isArray(e.point)) killAt.set(e.target, { x: e.point[0], y: 0, z: e.point[2] }); }));
      off.push(c.forge.on('rule', e => {
        if (!c.host || !S || c.round?.phase !== 'playing') return;
        if (e.name === 'coin') {
          const p = K.playerOfCore(c, e.entity); if (!p) return;
          const v = Math.max(0, Math.round(e.a || 0)); const coins = { ...(S.c ?? {}) }; coins[p.id] = (coins[p.id] ?? 0) + v; S.c = coins;
          stats.coins += v; L.coin.emit({ player: p, value: v });
        } else if (e.name === 'enemy-down') {
          const killer = K.playerOfCore(c, Math.round(e.d));
          const at = killAt.get(e.entity) ?? (killer ? { x: killer.position.x, y: 0, z: killer.position.z } : null);
          killAt.delete(e.entity);
          if (!at) return;
          if (roll() < (Number(V('potionChance')) || 0)) { drop('potion', at); stats.potions++; }
          const rows = weaponRows();
          if (rows.length && roll() < (Number(V('weaponChance')) || 0)) {
            // beside the potion, not on it (a weapon is taken within 1.1 m, a potion within `touch`): two things, two steps
            c.forge.cmd.raw(K.FEEL_OP.PICKUP, [rows[Math.floor(roll() * rows.length) % rows.length]], [at.x + 2, 0.9, at.z, 0]);
            stats.weapons++;
          }
        }
      }));
    },
    update(dt) {
      if (!S) return;
      const phase = ctx.round?.phase;
      if (ctx.host) {
        if (phase === 'countdown' && ((S.d ?? []).length || Object.keys(S.c ?? {}).length)) { S.d = []; S.c = {}; }
        const life = Number(V('dropSeconds')) || 45, before = (S.d ?? []).length;
        if (before) { const kept = S.d.filter(r => ctx.time.now - r[5] < life); if (kept.length !== before) { stats.faded += before - kept.length; S.d = kept; } }
        if (phase === 'playing') {
          const r = Number(V('touch')) || 0.9;
          for (const p of ctx.players.list()) {
            if (p.ghost || p.alive === false || p.down) continue;
            const row = (S.d ?? []).find(d => d[1] === KIND.potion && Math.hypot(d[2] - p.position.x, d[3] - p.position.z) <= r + 0.3 && Math.abs(d[4] - p.position.y) < 2);
            if (row) take(p, row);
          }
        }
      }
      // every copy: the host's drops drawn; a potion that went is heard where it was
      const now = new Set();
      for (const d of S.d ?? []) { now.add(d[0]); seen.set(d[0], d); marks.set(d[0], { x: d[2], y: d[4], z: d[3], on: true }); }
      for (const [id2, d] of seen) if (!now.has(id2)) { marks.drop(id2); seen.delete(id2); const snd = V('soundPotion'); if (snd) { stats.sounds++; ctx.audio?.play(snd, { optional: true, at: { x: d[2], y: d[4] + 0.5, z: d[3] } }); } }
      marks.tick(dt);
    },
    coinsOf: p => (p ? S?.c?.[p.id] ?? 0 : 0),
    drops: () => (S?.d ?? []).map(d => ({ id: d[0], kind: d[1] === KIND.potion ? 'potion' : 'drop', x: d[2], y: d[4], z: d[3] })),
    /** Host: lay a drop (the rules' own; QA). → its id, or -1 on another copy */
    drop: (kind, at) => drop(kind, at),
    onCoin: fn => L.coin.on(fn),
    onTake: fn => L.take.on(fn),
    observe: () => ({ stats: { ...stats }, drops: (S?.d ?? []).length, coins: { ...(S?.c ?? {}) }, marks: marks.observe(), notOnForge: ['chests', 'upgrade cards (forge has its reward cards and the cart)', 'rarity', 'the magnet pull', 'a press of E to take a drop'] }),
    dispose() { for (const f of off) f?.(); off = []; },
  };
}
