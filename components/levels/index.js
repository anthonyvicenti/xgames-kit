// mechanic: levels (track M, gf-scenic wave 1). A run of levels: clear every enemy on a level, its portal opens, step
// in together and everyone moves to the next level; the last level is the boss's and beating it wins the run;
// everyone down at once loses it (a replay starts at level 1). README.md has the network ownership and the API.
//
//   const lv = ctx.mechanics.get('levels');
//   lv.state();      // every copy: {level (0-based), count, phase: 'fight' | 'open' | 'travel' | 'won' | 'lost', boss, portal, left}
//   lv.onLevel(fn);  // every copy: {level} as a level begins; lv.onClear / onWin / onLose (host)
//
// Creator, 2026-10-08 (the roguelike miss): "several levels you have to clear all monsters in and then a final boss
// level". CONTRACT §8 "Levels": the world says where each level is (ctx.world.levels, setLevel); this mechanic (the host)
// decides which level is played, opens the portal and moves everyone. It drives the waves mechanic (startEncounter),
// begins the boss on the last level, and asks loot for chests and for upgrade cards between levels.
import * as THREE from 'three';
import { PH, encounterFor, stepRun, inZone } from './logic.js';
import { spawnOf } from '../../core/util.js';

export const id = 'levels';
export const examples = ['three floating islands and a boss', 'dungeon rooms you clear one by one', 'a run of arenas with a portal between them'];

const D = {
  count: 3, wavesPerLevel: 2, startCount: 3, levelGrowth: 1, growth: 1, countPerPlayer: 0.35, hpScale: 0.15, speedScale: 0.05, bossLevel: 'last',
  portalZone: 'portal', portalSeconds: 8, travelSeconds: 0.8, portalColor: '#7cf6ff', portalGlow: '#b98cff', portalProp: 'portal',
  endRound: true, upgrades: true, chests: 1,
  bannerText: 'Level {n}', bossText: 'The final level', openText: 'Portal open', winText: 'Run cleared!', loseText: 'Everyone is down',
  soundPortal: 'portal-open', soundTravel: 'portal-travel',
};
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    count: { type: 'integer', minimum: 1, maximum: 8, default: D.count, description: 'Levels in a run (the world lays out one island or room set per level; CONTRACT §8)' },
    wavesPerLevel: { type: ['integer', 'array'], default: D.wavesPerLevel, description: 'Waves on each level (a number, or one per level)' },
    startCount: { type: 'integer', minimum: 1, maximum: 30, default: D.startCount, description: 'Enemies in a level\'s first wave on level 1' },
    levelGrowth: { ...num('Extra enemies per wave on each later level', 0, 10), default: D.levelGrowth },
    growth: { ...num('Extra enemies in each later wave of a level', 0, 10), default: D.growth },
    countPerPlayer: { ...num('More enemies per player beyond the first (fraction)', 0, 2), default: D.countPerPlayer },
    hpScale: { ...num('Enemy hit points gained per level (fraction)', 0, 2), default: D.hpScale },
    speedScale: { ...num('Enemy speed gained per level (fraction)', 0, 1), default: D.speedScale },
    bossLevel: { type: 'string', enum: ['last', 'none'], default: D.bossLevel, description: 'last: the last level is the boss mechanic\'s fight' },
    portalZone: { type: 'string', default: D.portalZone, description: 'The world zone of each level the portal stands in' },
    portalSeconds: { ...num('Seconds the portal waits once one player is in it', 1, 60), default: D.portalSeconds },
    travelSeconds: { ...num('Seconds the move to the next level takes', 0.2, 5), default: D.travelSeconds },
    portalColor: { type: 'string', default: D.portalColor, description: 'Colour of the portal\'s ring' },
    portalGlow: { type: 'string', default: D.portalGlow, description: 'Colour of the portal\'s inner glow and its beam' },
    portalProp: { type: 'string', default: D.portalProp, description: 'A prop.<name> model drawn as the portal when the game has it (else the kit\'s ring)' },
    endRound: { type: 'boolean', default: D.endRound, description: 'The run\'s end is the round\'s: won on the last level, lost when everyone is down at once' },
    upgrades: { type: 'boolean', default: D.upgrades, description: 'Offer every player an upgrade card when a level is cleared (the loot mechanic)' },
    chests: { type: 'integer', minimum: 0, maximum: 4, default: D.chests, description: 'Chests on each level (the loot mechanic)' },
    bannerText: { type: 'string', default: D.bannerText }, bossText: { type: 'string', default: D.bossText }, openText: { type: 'string', default: D.openText },
    winText: { type: 'string', default: D.winText }, loseText: { type: 'string', default: D.loseText },
    soundPortal: { type: 'string', default: D.soundPortal }, soundTravel: { type: 'string', default: D.soundTravel },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.levels.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : type === 'text' ? 'text' : 'gameplay', ...extra });
export const slots = [
  vs('portalColor', 'Portal ring colour', 'color', { tier: 'main', rank: 66 }),
  vs('portalGlow', 'Portal glow colour', 'color', { tier: 'main', rank: 64 }),
  vs('startCount', 'Enemies in a level\'s first wave', 'integer', { tier: 'main', rank: 60, constraints: { min: 1, max: 30 } }),
  vs('levelGrowth', 'Extra enemies per level', 'number', { constraints: { min: 0, max: 10 } }),
  vs('growth', 'Extra enemies per wave', 'number', { constraints: { min: 0, max: 10 } }),
  vs('hpScale', 'Enemy toughness per level', 'number', { constraints: { min: 0, max: 2 } }),
  vs('speedScale', 'Enemy speed per level', 'number', { constraints: { min: 0, max: 1 } }),
  vs('portalSeconds', 'Portal wait', 'number', { constraints: { min: 1, max: 60, unit: 's' } }),
  vs('bannerText', 'Level banner text', 'text', { constraints: { maxLength: 40 } }), vs('bossText', 'Boss level banner', 'text', { constraints: { maxLength: 40 } }),
  vs('openText', 'Portal open text', 'text', { constraints: { maxLength: 40 } }), vs('winText', 'Run won text', 'text', { constraints: { maxLength: 40 } }), vs('loseText', 'Run lost text', 'text', { constraints: { maxLength: 40 } }),
  vs('soundPortal', 'Portal opens sound id', 'text', { constraints: { maxLength: 40 } }), vs('soundTravel', 'Travel sound id', 'text', { constraints: { maxLength: 40 } }),
];

const r2 = v => Math.round(v * 100) / 100;
const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
const qaParam = name => { try { return new URLSearchParams(globalThis.location?.search ?? '').get(name); } catch { return null; } };

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.levels.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const L = { level: [], clear: [], win: [], lose: [] };
  const root = new THREE.Group(); root.name = 'gf-levels'; ctx.scene.add(root);
  // QA's staged moments: `levels.clear` (the host takes down each level's enemies 3 s after they come: the portal opens
  // without a fight) and `levels.boss` / `boss.phase` (the run starts on the boss level). verify check 15 walks into
  // the portal on the first and watches the boss's phase change on the second.
  const demo = qaParam('gf-demo');
  const M = id => { const m = ctx.mechanics?.get?.(id); return m && !m.standin ? m : null; };
  const count = () => Math.max(1, Math.min(V('count'), ctx.world?.levels?.length || V('count')));
  const run = { l: 0, ph: PH.fight, t: 0, armed: false };
  let S = null, applied = -1, started = false, clearsSeen = 0, travels = 0, levelT = 0, portal = null, lastPh = null, inPortalNow = 0, demoT = 0, endAt = null;

  const levelOf = i => ctx.world?.levels?.[i] ?? null;
  // the level's portal zone; a world without levels (a party arena) plays every level in the one arena, with the
  // portal at its portal zone, else its centre
  const zoneOf = i => {
    const lv = levelOf(i), z = lv?.zones?.[V('portalZone')];
    if (z) return { at: z.at, size: z.size };
    const zz = ctx.world?.zone?.(V('portalZone')) ?? (ctx.world?.levels?.length ? null : ctx.world?.zone?.('centre'));
    return zz ? { at: zz.at, size: [Math.max(1.6, [].concat(zz.size ?? 2)[0])] } : ctx.world?.levels?.length ? null : { at: [0, 0, 0], size: [2.2] };
  };
  const encounter = i => encounterFor(i, { count: count(), wavesPerLevel: V('wavesPerLevel'), startCount: V('startCount'), growth: V('growth'), levelGrowth: V('levelGrowth'), hpScale: V('hpScale'), speedScale: V('speedScale'), bossLevel: V('bossLevel') });

  // ---------- host ----------
  function begin(i) {
    run.l = i; run.ph = PH.fight; run.t = 0; run.armed = false; levelT = 0; demoT = 0;
    const waves = M('waves'), boss = M('boss'), loot = M('loot'), e = encounter(i);
    waves?.clearAll?.();
    if (e.boss && boss) { waves?.endEncounter?.(); boss.begin?.(levelCenter(i)); }
    else {
      const crowd = 1 + V('countPerPlayer') * Math.max(0, ctx.players.list().length - 1);
      waves?.startEncounter?.({ level: e.level, waves: e.waves, startCount: Math.max(1, Math.round(e.startCount * crowd)), growth: e.growth, hpScale: e.hpScale, speedScale: e.speedScale });
    }
    if (V('chests') > 0) loot?.placeChests?.(V('chests'), zoneArena(i));
  }
  const levelCenter = i => { const lv = levelOf(i); return lv ? { x: lv.at?.[0] ?? 0, z: lv.at?.[2] ?? 0 } : { x: 0, z: 0 }; };
  const zoneArena = i => { const lv = levelOf(i), z = lv?.zones?.arena; return z ? { at: z.at, size: z.size } : { at: [levelCenter(i).x, 0, levelCenter(i).z], size: [Math.max(4, (lv?.radius ?? 12) - 2)] }; };
  function hostStep(dt) {
    const waves = M('waves'), boss = M('boss'), health = M('health');
    const ps = ctx.players.list();
    const up = ps.filter(p => p.alive !== false);
    const z = zoneOf(run.l);
    inPortalNow = run.ph === PH.open && z ? up.filter(p => inZone(z, p.position.x, p.position.z, 0.3)).length : 0;
    const e = encounter(run.l);
    // QA: levels.clear takes down this level's enemies a moment after they come (none of them killed by anyone)
    if (demo === 'levels.clear' && run.ph === PH.fight && !e.boss) { demoT += dt; if (demoT > 3 && (waves?.state?.().alive ?? 0) > 0) { waves.clearAll(); waves.endEncounter?.(); } }
    const ws = waves?.state?.() ?? null;
    const cleared = !waves ? true : demo === 'levels.clear' && !e.boss ? demoT > 3.2 && ws.alive === 0 : !!ws.encounterCleared;
    const bs = boss?.state?.() ?? null;
    const ev = stepRun(run, { cleared: e.boss ? (ws?.alive ?? 0) === 0 : cleared, boss: e.boss && !!boss, bossDown: !!bs?.dead, alive: up.length, players: ps.length, inPortal: inPortalNow, wipe: !!health && ps.length > 0 && up.length === 0 }, dt, { count: count(), portalSeconds: V('portalSeconds'), travelSeconds: V('travelSeconds') });
    for (const x of ev) {
      if (x === 'open') { clearsSeen++; for (const fn of L.clear.slice()) try { fn({ level: run.l }); } catch (er) { console.error(er); } if (V('upgrades')) M('loot')?.offerUpgrades?.(run.l); }
      if (x === 'travel') travels++;
      if (x === 'next') begin(run.l);
      if (x === 'won') { for (const fn of L.win.slice()) try { fn({ level: run.l }); } catch (er) { console.error(er); } endAt = { t: 1.6, won: true }; }
      if (x === 'lost') { for (const fn of L.lose.slice()) try { fn({ level: run.l }); } catch (er) { console.error(er); } endAt = { t: 1.2, won: false }; }
    }
    if (endAt && V('endRound')) {
      endAt.t -= dt;
      if (endAt.t <= 0) { const won = endAt.won; endAt = null; ctx.round?.end?.(won ? 'won' : 'lost', won ? ps.map(p => p.id) : []); }
    }
  }

  // ---------- every copy: the level, the portal ----------
  function applyLevel(i) {
    applied = i;
    ctx.world?.setLevel?.(i);
    // the players this copy owns go to the level's spawns (a late joiner lands on the current level)
    for (const p of ctx.players.list()) if (p.owned && p.controller) { const s = spawnOf(ctx.world, p.seat); p.teleport({ x: s.x, y: s.y ?? 0, z: s.z }, s.yaw); }
    const e = encounter(i);
    if (started) ctx.ui?.banner?.(e.boss ? V('bossText') : V('bannerText').replace('{n}', i + 1), 1.8);
    placePortal(i);
    for (const fn of L.level.slice()) try { fn({ level: i }); } catch (er) { console.error(er); }
  }
  const glowMat = color => ctx.modules?.look?.material?.('glow', { tint: color }) ?? new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.2, roughness: 0.4, transparent: true, opacity: 0.85 });
  async function makePortal() {
    const g = new THREE.Group(); g.name = 'gf-portal';
    let model = null;
    try { if (V('portalProp') && ctx.assets.has(`prop.${V('portalProp')}`)) model = await ctx.assets.model(`prop.${V('portalProp')}`, { fit: 3.2, fitAxis: 'y' }); } catch (e) { console.warn('levels: portal model failed, drawing the ring', e); }
    const ringMat = glowMat(V('portalColor')), coreMat = new THREE.MeshBasicMaterial({ color: V('portalGlow'), transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const beamMat = new THREE.MeshBasicMaterial({ color: V('portalGlow'), transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const ring = model ?? new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.13, 14, 56), ringMat);
    if (!model) { ring.position.y = 1.65; ctx.assets.tag(ring, 'mechanic.levels.portal-color'); }
    const core = new THREE.Mesh(new THREE.CircleGeometry(1.36, 48), coreMat); core.position.y = 1.65; ctx.assets.tag(core, 'mechanic.levels.portal-glow');
    const floor = new THREE.Mesh(new THREE.RingGeometry(1.9, 2.2, 56).rotateX(-Math.PI / 2), coreMat); floor.position.y = 0.04; ctx.assets.tag(floor, 'mechanic.levels.portal-glow');
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.6, 14, 24, 1, true), beamMat); beam.position.y = 7; ctx.assets.tag(beam, 'mechanic.levels.portal-glow');
    g.add(ring, core, floor, beam);
    g.userData = { ring, core, floor, beam, ringMat, coreMat, beamMat, model: !!model };
    root.add(g);
    return g;
  }
  let portalLoading = null;
  function placePortal(i) {
    const z = zoneOf(i);
    if (!z) { if (portal) portal.visible = false; return; }
    const at = z.at ?? [0, 0, 0], x = at.x ?? at[0] ?? 0, zz = at.z ?? at[2] ?? 0;
    const c = levelCenter(i);
    const put = g => { g.position.set(x, 0, zz); g.rotation.y = Math.atan2(c.x - x, c.z - zz); g.visible = true; };
    if (portal) put(portal);
    else portalLoading ??= makePortal().then(g => { portal = g; put(g); });
  }
  // when the portal is open and off this player's screen, an arrow at the edge of the screen points to it (UI, not art)
  let arrow = null;
  const pv = new THREE.Vector3();
  function drawArrow() {
    const s = api.state(), open = s.phase === PH.open || s.phase === PH.travel;
    if (!ctx.ui?.root || typeof document === 'undefined') return;
    if (!arrow) {
      arrow = document.createElement('div'); arrow.id = 'gf-portal-arrow';
      arrow.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;border-left:14px solid transparent;border-right:14px solid transparent;border-bottom:26px solid var(--c,#7cf6ff);filter:drop-shadow(0 0 6px var(--c,#7cf6ff)) drop-shadow(0 2px 0 #0008);display:none;pointer-events:none;will-change:transform';
      arrow.style.setProperty('--c', V('portalColor'));
      ctx.ui.root.append(arrow);
    }
    if (!open || !s.portal || !ctx.camera || ctx.round?.phase !== 'playing') { arrow.style.display = 'none'; return; }
    ctx.camera.updateMatrixWorld();
    pv.set(s.portal.x, 1.5, s.portal.z).project(ctx.camera);
    const W = innerWidth, H = innerHeight, inView = pv.z < 1 && Math.abs(pv.x) < 0.92 && Math.abs(pv.y) < 0.9;
    if (inView) { arrow.style.display = 'none'; return; }
    let x = pv.x, y = pv.y; if (pv.z >= 1) { x = -x; y = -y; }
    const k = 0.86 / Math.max(Math.abs(x), Math.abs(y), 1e-3);
    const sx = (x * k * 0.5 + 0.5) * W, sy = (-y * k * 0.5 + 0.5) * H, ang = Math.atan2(x, y);
    arrow.style.display = 'block';
    arrow.style.transform = `translate(${Math.round(sx - 14)}px, ${Math.round(sy - 13)}px) rotate(${ang}rad)`;
  }
  function drawPortal(dt) {
    if (!portal) return;
    const ph = api.state().phase, open = ph === PH.open || ph === PH.travel;
    const u = portal.userData, t = ctx.time.now;
    const k = open ? 1 : 0.12;
    u.core.visible = open; u.beam.visible = open; u.floor.visible = true;
    u.core.material.opacity = (0.4 + 0.2 * Math.sin(t * 4)) * k + (ph === PH.travel ? 0.3 : 0);
    u.core.scale.setScalar(open ? 0.96 + 0.05 * Math.sin(t * 6) : 0.2);
    u.floor.material.opacity = 0.25 + 0.4 * k;
    if (!u.model) { u.ring.rotation.z += dt * (open ? 1.6 : 0.2); if (u.ringMat.emissiveIntensity !== undefined) u.ringMat.emissiveIntensity = open ? 2.4 + Math.sin(t * 5) * 0.5 : 0.35; }
    u.beam.rotation.y += dt * 0.6;
  }

  const api = {
    id, params: P,
    /** Every copy: {level (0-based), count, phase, boss (this level is the boss's), portal: {x, z, r, open} | null, left (enemies), inPortal, seconds (the portal's wait)}. */
    state() {
      const s = ctx.host ? run : { l: S?.l ?? 0, ph: S?.ph ?? PH.fight, t: S?.t ?? 0 };
      const z = zoneOf(s.l), at = z?.at ?? null;
      const w = M('waves')?.state?.();
      return {
        level: s.l, count: count(), phase: s.ph, boss: encounter(s.l).boss, left: w?.alive ?? 0, inPortal: ctx.host ? inPortalNow : (S?.ip ?? 0), seconds: r2(s.t ?? 0),
        portal: at ? { x: at.x ?? at[0], z: at.z ?? at[2], r: [].concat(z.size ?? 2)[0], open: s.ph === PH.open || s.ph === PH.travel } : null,
        cleared: ctx.host ? clearsSeen : (S?.c ?? 0), travels: ctx.host ? travels : (S?.v ?? 0),
      };
    },
    /** Host: move everyone to the next level now (rules or QA). */
    next() { if (ctx.host && run.l < count() - 1) { run.ph = PH.travel; run.t = 0.01; } },
    /** Host: start the run over on level i (default 0). */
    restart(i = 0) { if (ctx.host) begin(Math.max(0, Math.min(count() - 1, i))); },
    onLevel(fn) { L.level.push(fn); return unsub(L.level, fn); },
    onClear(fn) { L.clear.push(fn); return unsub(L.clear, fn); },
    onWin(fn) { L.win.push(fn); return unsub(L.win, fn); },
    onLose(fn) { L.lose.push(fn); return unsub(L.lose, fn); },
    /** QA: what this copy shows (window.__game.controls()). */
    get stats() { const s = api.state(); return { ...s, applied, worldLevel: ctx.world?.level ?? null, portalShown: !!portal?.visible, demo: demo?.startsWith('levels.') ? demo : null }; },
    setup() { M('waves')?.manage?.(true); },
    reset() {
      run.l = 0; run.ph = PH.fight; run.t = 0; run.armed = false; started = false; clearsSeen = 0; travels = 0; endAt = null; demoT = 0;
      ctx.world?.setLevel?.(0); applied = -1;
    },
    update(dt) {
      if (!S) { if (!(ctx.shared && ctx.players && ctx.me)) return; S = ctx.shared.register('levels', { l: 0, ph: PH.fight, t: 0, ip: 0, c: 0, v: 0 }); M('waves')?.manage?.(true); }
      const playing = ctx.round?.phase === 'playing';
      if (ctx.host) {
        if (playing && !started) { started = true; begin(demo === 'levels.boss' || demo === 'boss.phase' ? count() - 1 : 0); applyLevel(run.l); }
        if (playing) hostStep(dt);
        S.l = run.l; S.ph = run.ph; S.t = r2(run.t); S.ip = inPortalNow; S.c = clearsSeen; S.v = travels;
      } else if (playing) started = true;
      const s = api.state();
      if (s.level !== applied) applyLevel(s.level);
      if (s.phase !== lastPh) {
        if (lastPh !== null && s.phase === PH.open) { ctx.ui?.banner?.(V('openText'), 1.6); ctx.audio?.play(V('soundPortal'), { optional: true }); }
        if (s.phase === PH.travel) ctx.audio?.play(V('soundTravel'), { optional: true });
        if (s.phase === PH.won) ctx.ui?.banner?.(V('winText'), 2.2);
        if (s.phase === PH.lost) ctx.ui?.banner?.(V('loseText'), 2.2);
        lastPh = s.phase;
      }
      if (!portal && !portalLoading) placePortal(s.level);
      drawPortal(dt);
      drawArrow();
      levelT += dt;
    },
    dispose() { root.removeFromParent(); arrow?.remove(); },
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
  describe: 'A run of levels (one island or room set each): clear every enemy, the portal or door opens, everyone moves to the next; the last is the boss',
  rank: 120,
  needs: { parts: [], world: [] },
  // waves gives each level its enemies (without it every level is clear at once); a world with levels (scenic isles,
  // dungeon) gives each level its own place, any other world plays every level in its one arena
  uses: ['waves', 'boss', 'loot', 'health'],
  owns: p => (p.endRound ? [{ res: 'round.end', why: 'the run\'s end is the round\'s: won on the last level, lost when everyone is down at once (params.endRound)', free: 'set levels params.endRound to false and end the round in rules.check' }] : []),
  state: { key: 'levels', fields: { l: 'the level being played (0-based)', ph: 'fight | open | travel | won | lost', t: 'the portal\'s wait', ip: 'players standing in the portal', c: 'levels cleared', v: 'moves through a portal' } },
  events: [
    { name: 'onLevel', on: 'every copy', args: '{ level }', when: 'a level begins' },
    { name: 'onClear', on: 'host', args: '{ level }', when: 'the level\'s last enemy went down and its portal opened' },
    { name: 'onWin', on: 'host', args: '{ level }', when: 'the last level was beaten' },
    { name: 'onLose', on: 'host', args: '{ level }', when: 'everyone was down at once' },
  ],
  sync: { owner: 'host', how: 'the host owns the run; every copy applies a level change on its edge' },
  note: [
    'The run plays by itself: the waves mechanic gives each level its enemies, the portal opens when they are down, everyone steps in, and the last level is the boss\'s when the game has one.',
    'It ends the round by itself (endRound): rules.check stays null unless the game has another way to end.',
    'In a world with levels (scenic isles or dungeon) each level is its own island or room set; any other world plays them all in its one arena.',
  ],
  stub: {
    as: 'levels',
    worked: 'levels.onClear(({ level }) => { for (const p of ctx.players.list()) p.score += 10 * (level + 1); });',
    traps: [
      'returning a winner from rules.check while endRound is on ends the run early: one of the two ends the round, never both',
      'a replay starts at level 1 again: reset the game\'s own per-run state in roundStart(ctx)',
    ],
  },
  signs: {
    sample: sh => (sh.levels ? { levels: [sh.levels.l ?? 0, sh.levels.ph ?? '', sh.levels.c ?? 0, sh.levels.v ?? 0] } : null),
    judge: v => {
      const a = v.action, d = v.page('demo-levels'), ds = d ? v.actionOn(d) : null;
      if (a.movedOn) v.add('a cleared level opens its portal and everyone moves on', 'ok', 'shared.levels (level, phase, cleared, travels)', `${a.travels} move${a.travels === 1 ? '' : 's'} through a portal, ${a.cleared} level${a.cleared === 1 ? '' : 's'} cleared${ds?.movedOn ? '; on the staged page the player walked into the open portal' : ''}`);
      else v.add('a cleared level opens its portal and everyone moves on', ds || a.opened ? 'dead' : 'unmeasured', 'shared.levels (level, phase, cleared, travels)',
        ds ? (ds.opened ? 'the portal opened on the staged page (?gf-demo=levels.clear) but walking into it with real keys did not move the run on' : 'on the staged page (?gf-demo=levels.clear) the level was cleared and its portal never opened') : a.opened ? 'a portal opened but nobody moved on' : `no level was cleared on any page (${v.names})`,
        'check config/world.json → levels (each with a portal zone), levels portalZone, and that nothing in rules.js holds the run');
    },
  },
};
