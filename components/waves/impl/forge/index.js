// mechanic waves, the forge runtime's implementation (vendored as gf/three/mechanics/waves/impl/forge/index.js; the
// boot loads it through gf/forge/mechanics.js). On forge the enemies, their AI and the wave director are the core's
// (forge-ai): this implementation writes the wave plan the mechanic's params describe into the core's tables, and gives
// the rules the same reading and callbacks as on three (components/waves/README.md).
//
//   the plan        when the spec's own tables have no waves, `maxWaves` waves (0, endless on three: 10 here) of
//                   startCount + growth × (n − 1) enemies, split over the tables' enemy rows that are not the boss,
//                   `firstDelay` before the first, `restSeconds` before each next, `spawnEvery` between arrivals, at
//                   most `maxAlive` at once; nextWave 'timer' ends a wave after `interval` seconds. A spec that writes
//                   its own tables.waves keeps them (the tables are the game's; the params then only name the callbacks)
//   the enemies     the tables' (spec.tables.enemies: health, speed and damage on forge's scale, their bodies). The
//                   params hp, speed, damage and the rest of three's enemy tuning are not read on forge
//   scoring         killPoints to whoever made the kill, on the host (0: the rules score kills themselves)
//   the banner      the forge HUD's own ("Wave 2 of 4" as a wave starts), so banner and bannerText are not read
//   state           the host's, in ctx.shared 'waves' with three's shape (what the gates read): e [[id, x, z, hp,
//                   max]] the core's enemies standing (at most MAX_ROWS), w [wave, kills, 0, phase], k the last kills
//                   [[enemy, killer]], n the waves planned; alive is the core's enemies standing, on every copy
//
//   const waves = ctx.mechanics.get('waves');
//   waves.onKill(({ killer, row, points }) => …)   waves.onWaveStart(({ wave, waves }) => …)   waves.onAllClear(() => …)
//   waves.state() → { wave, waves, alive, kills, cleared, phase }
//
// Not on forge (observe().notOnForge): a target to defend (target, targetHp), enemy typing by `types`, the stand-in
// capsule look (enemies are the tables' bodies), every enemy stat in the params.

export const id = 'waves';
const D = { startCount: 3, growth: 2, maxAlive: 14, firstDelay: 3, restSeconds: 4, spawnEvery: 0.6, nextWave: 'clear', interval: 20, maxWaves: 0, killPoints: 1 };
/** Waves made when maxWaves is 0 (three's endless round): forge's director plays a list. */
export const ENDLESS_AS = 10;
/** Enemy rows in the shared state at most (the core's snapshot shares the world message). */
export const MAX_ROWS = 12;

/** The wave plan the params describe, over the given enemy rows (ids). Pure. → forge waves table rows */
export function planWaves(P = {}, rows = []) {
  const p = { ...D, ...P }, ids = rows.length ? rows : ['grunt'];
  const n = Math.max(1, Math.min(99, Number(p.maxWaves) > 0 ? Number(p.maxWaves) : ENDLESS_AS));
  const out = [];
  for (let w = 0; w < n; w++) {
    const count = Math.max(1, Math.round((Number(p.startCount) || 1) + (Number(p.growth) || 0) * w));
    // split over the rows: the first row the most, one more row joining each wave (never more rows than the wave has)
    const used = ids.slice(0, Math.min(ids.length, 1 + w, count)), groups = used.map(type => ({ type, count: 0 }));
    for (let i = 0; i < count; i++) groups[i % groups.length].count++;
    out.push({ id: `wave-${w + 1}`, enemies: groups, delay: w === 0 ? Number(p.firstDelay) || 0 : Number(p.restSeconds) || 0, spawnEvery: Math.max(0.05, Number(p.spawnEvery) || 0.6), maxAlive: Math.max(1, Math.round(Number(p.maxAlive) || 8)),
      ...(p.nextWave === 'timer' ? { next: 'timer', time: Math.max(5, Number(p.interval) || 20) } : {}) });
  }
  return out;
}

/** The forge tables with the plan in them, when the spec's own tables have no waves. */
export function tables(t = {}, params = {}) {
  if (Array.isArray(t.waves) && t.waves.length) return t;
  const enemies = Array.isArray(t.enemies) && t.enemies.length ? t.enemies : [{ id: 'grunt', name: 'Grunt', archetype: 'chaser' }];
  const rows = enemies.filter(e => e && typeof e.id === 'string' && (e.archetype ?? 'chaser') !== 'boss').map(e => e.id);
  return { ...t, enemies, waves: planWaves(params, rows) };
}

export function create(ctx, params = {}, K) {
  const P = { ...D, ...params };
  const V = k => K.valueOf(ctx, 'waves', P, k, D[k]);
  const L = { kill: K.listeners('waves.onKill'), start: K.listeners('waves.onWaveStart'), clear: K.listeners('waves.onWaveClear'), all: K.listeners('waves.onAllClear') };
  let S = null, off = [], sent = -1;
  const standing = () => { try { return (ctx.forge.entities(K.KIND.ENEMY) ?? []).filter(e => !(e.flags & 1) && e.hp > 0); } catch { return []; } };
  const alive = () => standing().length;
  const maxOf = type => Number((ctx.tables?.enemies ?? [])[type]?.health) || 1;
  const r2 = v => Math.round(v * 100) / 100;

  return {
    setup(c) {
      S = c.shared.register('waves', { e: [], w: [0, 0, 0, 'wait'], k: [], n: (c.tables?.waves ?? []).length });
      off.push(c.forge.on('rule', e => {
        if (!c.host || !S) return;
        const w = [...(S.w ?? [0, 0, 0, 'wait'])];
        if (e.name === 'wave-start') { w[0] = Math.round(e.a); w[3] = 'wave'; S.w = w; S.n = Math.round(e.b) || S.n; L.start.emit({ wave: w[0], waves: S.n, enemies: Math.round(e.c), boss: e.d > 0 }); }
        else if (e.name === 'wave-clear') { w[3] = 'rest'; S.w = w; L.clear.emit({ wave: Math.round(e.a), waves: S.n }); }
        else if (e.name === 'waves-done') { w[3] = 'cleared'; S.w = w; L.all.emit({ waves: S.n }); }
        else if (e.name === 'enemy-down') {
          w[1] += 1; S.w = w;
          const killer = K.playerOfCore(c, Math.round(e.d)), pts = Number(V('killPoints')) || 0;
          S.k = [...(S.k ?? []), [e.entity, killer?.id ?? null]].slice(-6);
          if (killer && pts > 0 && c.round?.phase === 'playing') killer.score = (killer.score ?? 0) + pts;
          L.kill.emit({ enemy: e.entity, row: Math.round(e.a), killer, points: pts, coins: Math.round(e.c) });
        }
      }));
    },
    update() {
      if (!ctx.host || !S) return;
      if (ctx.round?.phase === 'countdown' && (S.w?.[0] || S.w?.[1] || S.w?.[3] !== 'wait')) { S.w = [0, 0, 0, 'wait']; S.k = []; S.e = []; }
      // the enemies standing, a few times a second (where they are, their hit points)
      if (ctx.time.now - sent >= 0.2) { sent = ctx.time.now; S.e = standing().slice(0, MAX_ROWS).map(e => { const max = maxOf(e.type); return [e.net, r2(e.x), r2(e.z), Math.round(e.hp * max * 10) / 10, max]; }); }
    },
    state: () => { const w = S?.w ?? [0, 0, 0, 'wait']; return { wave: w[0], waves: S?.n ?? 0, alive: alive(), kills: w[1], cleared: w[3] === 'cleared', phase: w[3] }; },
    onKill: fn => L.kill.on(fn),
    onWaveStart: fn => L.start.on(fn),
    onWaveClear: fn => L.clear.on(fn),
    onAllClear: fn => L.all.on(fn),
    observe: () => ({ ...(S ? { w: [...(S.w ?? [])], n: S.n, rows: (S.e ?? []).length } : {}), alive: alive(), planned: (ctx.tables?.waves ?? []).length,
      notOnForge: ['target and targetHp (no target to defend)', 'types (enemies are the tables\' rows)', 'hp, speed, damage and the other enemy stats (the tables\' scale)', 'banner and bannerText (the forge HUD banners each wave)'] }),
    dispose() { for (const f of off) f?.(); off = []; },
  };
}
