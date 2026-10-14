// gf-forge's AI in the browser (track A), vendored into a game as gf/forge/ai.js (never edited there): what joins the
// Rust core's forge-ai (research/gf-forge/core/forge-ai) to the shared system. world.js attaches it when the world
// loads (attachAi → ctx.ai); it then runs in ctx.onFrame, after the core's tick:
//
//   - the arena's emerge points and the nav grid's bounds go to the core (OP_MOUND, OP_ARENA);
//   - the enemies' bodies: each type's body slot loaded for animation (forge-anim: its clips play, its hurtboxes ride
//     its bones) and drawn GPU-skinned by the renderer (gf/forge/render.js `body`: the wave 1b integration; its eyes
//     glow from the AI view, forge-web glue.rs), with what its type holds on its hand sockets (the catalog's Meshy
//     weapons and their grips: config/world.json → enemies.bodies[].held); a caster's orb drawn with the orb slot.
//     Without a renderer that skins (`ctx.ai.drawBodies`), a still body at the entity's place is the fallback;
//   - the wave director follows the round on the host: it starts when a round starts playing and stops (clearing every
//     enemy) when it ends; a wave that asks for a reward pauses it until the reward is over: the rules' own
//     (rules.reward(ctx, {wave, resume})), else the kit's three-card reward when the tables have cards (gf/forge/cards.js:
//     ctx.cards.open deals, and resumes when everyone has picked or passed or the time ran out), else it goes on at once;
//     wave 7: a wave after which the pedlar's cart opens (spec.forge.shop) waits for it too (gf/forge/shop.js: ctx.shop.open),
//     and on a wave with a reward the cards and the cart share one screen and one timer: it goes on when both are done;
//   - bots (ctx.makeBot, the session's bots): each bot gets the shared bot API (p.bot.seek(pos), flee, wander, stop,
//     face, aimAt(pos), press(action), hold(action, s)); rules.bot(ctx, p, dt) steers it when the rules have one, else
//     the core's own brain fights the enemies (aim, fire, melee, evade) or wanders; every frame each bot's wishes go to
//     the core as an OP_BOT command, and the core writes the bot's stick, look and buttons as an INPUT would.
//
//   - wave 7 (track E), elites (spec.forge.elites; core/forge-ai/src/elite.rs): the first elite of each modifier in a run
//     gets a soft banner (its name before the enemy's, its line under it; a rules.js banner wins), and this copy's own
//     player burning (the host's rule event `burning`) gets an ember-coloured edge for as long as it burns.
//
// ctx.ai: spawn(type, {at, emerge, elite}), emerge(type, count), director {start(wave, lap), stop, resume,
// skip(wave, lap), pause, state()}, elites {force(modifier, count), observe(), MODIFIERS}, clear(), knock(net, dir, s),
// enemies(), boss(), bots(), view(), archetypes(), observe().
// The AI view (eye glow per state, the hit flash, orb lights) is the renderer's to draw: research/gf-forge/core/
// forge-ai/src/view.rs says what each field is.
import { KIND, ENTITY_FLAG } from './host.js';
import { ENTITY_CLASS, fitTo } from './render.js';
import { firstEnemyRows, firstWaveCasts } from './first.js';

/** forge-ai's command ops (core/forge-ai/src/lib.rs). */
export const OP = { SPAWN: 96, ARENA: 97, MOUND: 98, DIRECTOR: 99, BOT: 100, CLEAR: 101, KNOCK: 102, EMERGE: 103, ELITE: 104 };
/** The AI view's fields (forge_ai::view::field). ELITE (wave 7): the modifier in the low three bits, + 8 a split one's young. */
export const AI = { NET: 0, KIND: 1, TYPE: 2, ARCH: 3, STATE: 4, STATE_T: 5, EYE_R: 6, EYE_G: 7, EYE_B: 8, EYE_I: 9, FLASH: 10, OFFSET: 11, TARGET: 12, FLAGS: 13, LIGHT: 14, HP: 15, ELITE: 16 };
/** Elite modifiers by their number (forge_ai::elite::Mod) and the young's bit. */
export const ELITE = { MODIFIERS: ['', 'burning', 'armoured', 'splitting', 'fast'], CHILD: 8 };
const ELITE_CSS = `#gf-ui .gf-forge-burn{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .25s;background:radial-gradient(ellipse at center,rgba(255,120,20,0) 50%,rgba(255,110,20,.14) 80%,rgba(255,150,40,.32) 100%);animation:gf-forge-burn .5s ease-in-out infinite alternate}
@keyframes gf-forge-burn{from{filter:brightness(.85)}to{filter:brightness(1.25)}}`;
export const AI_FLAG = { TOKEN: 1, GUARD: 2, SHIELD_BROKEN: 4, BOSS: 8, ARRIVING: 16, TELL: 32, ATTACK: 64, DOWN: 128, REPLICA: 256 };
export const STATES = ['arrive', 'idle', 'chase', 'wait', 'tell', 'attack', 'recover', 'hold', 'stagger', 'down', 'rise', 'roar', 'dead'];
export const ARCHS = ['chaser', 'runner', 'caster', 'shield', 'brute', 'boss'];
const DIRECTOR = { STOP: 0, START: 1, RESUME: 2, SKIP: 3, PAUSE: 4 };
const MODES = { auto: 0, seek: 1, flee: 2, wander: 3, idle: 4, fight: 5 };
const BTN = { jump: 1, primary: 8, secondary: 16, melee: 32, evade: 64, reload: 128, interact: 256 };

const yawOf = q => 2 * Math.atan2(q[1], q[3]);

/** Attach the AI to a loaded world. → ctx.ai */
export async function attachAi(ctx, cfg, world) {
  const host = ctx.forge, A = ctx.assets, gf = ctx.gf;
  // the renderer (gf/forge/render.js), when it skins bodies itself
  const R = ctx.render?.drawsBodies?.() ? ctx.render : null;
  const showing = typeof location !== 'undefined' && /[?&]gf-show=/.test(location.search ?? '');
  const tables = ctx.tables ?? {};
  const rows = Array.isArray(tables.enemies) ? tables.enemies : [];
  const rowOf = type => (typeof type === 'number' ? type : rows.findIndex(r => r.id === type));
  // ---- the arena to the core: the grid's bounds and the emerge points ----
  const [W, D] = cfg.size ?? [9, 9];
  const nav = cfg.nav ?? { min: [-W / 2, -D / 2], max: [W / 2, D / 2], cell: 0.5 };
  host.cmd.raw(OP.ARENA, [], [nav.min[0], nav.min[1], nav.max[0], nav.max[1], nav.cell ?? 0.5]);
  host.cmd.raw(OP.MOUND, [], []);
  for (const m of cfg.mounds ?? []) host.cmd.raw(OP.MOUND, [], [m[0], m[1] ?? 0, m[2]]);

  // ---- the enemies' bodies: animation (bones, hurtboxes, clips) and the static fallback drawing ----
  const E = cfg.enemies ?? null;
  const bodyOfRow = new Map((E?.bodies ?? []).map(b => [b.row, b]));
  const loaded = new Map();   // row → Promise<{model, anim, slot}>
  const ready = new Map();    // row → {model, anim, slot} once loaded
  let clips = null;
  const load = row => {
    const b = bodyOfRow.get(row);
    if (!b || !A.has(b.slot)) return null;
    if (!loaded.has(row)) loaded.set(row, (async () => {
      const bytes = await gf.bytes(A.file(b.slot));
      let body;
      if (R) {
        // one call: the body in the animation library and its model bound to that skeleton, drawn on every entity
        // the core animates with it
        const x = await R.body(bytes, ctx.slotIndex(b.slot));
        const held = [];
        for (const h of b.held ?? []) { const m = await heldModel(h.slot); if (m) held.push({ ...h, model: m.id }); }
        body = { model: { id: x.model }, anim: x.body, slot: b.slot, held };
      } else {
        const model = await host.model(bytes);
        let anim = -1;
        try { anim = await host.animBody(bytes); } catch (e) { console.warn(`gf-forge ai: ${b.slot} is not an animatable body (${e.message}); drawn still`); }
        body = { model, anim, slot: b.slot, held: [] };
      }
      ready.set(row, body);
      return body;
    })().catch(e => { console.error(`gf-forge ai: ${b.slot}: ${e.message}`); return null; }));
    return loaded.get(row);
  };
  const heldModels = new Map();
  const heldModel = slot => {
    if (!heldModels.has(slot)) heldModels.set(slot, (async () => { try { return A.has(slot) ? await host.model(await gf.bytes(A.file(slot))) : null; } catch (e) { console.warn(`gf-forge ai: ${slot}: ${e.message}`); return null; } })());
    return heldModels.get(slot);
  };
  const loadClips = () => {
    if (!clips && E?.clips && A.has(E.clips.slot)) clips = (async () => { try { return await host.animClips(await gf.bytes(A.file(E.clips.slot))); } catch (e) { console.warn(`gf-forge ai: the clip file: ${e.message}`); return -1; } })();
    return clips;
  };
  let orb = null, orbModel = null;
  const loadOrb = () => {
    if (!orb && E?.orb && A.has(E.orb.slot)) orb = (async () => {
      try { orbModel = await host.model(await gf.bytes(A.file(E.orb.slot))); } catch { orbModel = null; }
      // the renderer draws every orb in flight with it (and lights the scene from the AI view's orb light)
      if (orbModel && R) R.entityModel(ENTITY_CLASS.ORB, null, orbModel.id, ctx.slotIndex(E.orb.slot), { fit: fitTo(orbModel.bounds, { size: 0.34, turn: Math.PI }) });
      return orbModel;
    })();
    return orb;
  };
  // What is fetched when (wave 3, track M; gf/forge/first.js): nothing of the enemies before the menu. Once it is
  // drawn the boot runs `first` (the bodies the first wave raises, the clip file, the orb when that wave casts), and
  // the director below waits for it; then `later` (every other body, the boss's among them). A page with no such
  // steps (a tool's own) asks for everything at once, as before. A body nobody loaded yet is still loaded when one
  // of its kind is raised (the spawn below).
  const firstRows = new Set(firstEnemyRows(tables));
  const loadRows = keep => Promise.all([loadClips(), ...(E?.bodies ?? []).filter(b => keep(b.row)).map(b => load(b.row))].filter(Boolean));
  let firstReady = !E || showing;
  if (E && !showing) {
    const after = ctx.after ?? ((_step, fn) => fn());
    after('first', () => Promise.all([loadRows(r => firstRows.has(r)), firstWaveCasts(tables) ? loadOrb() : null]).finally(() => { firstReady = true; }));
    after('later', () => Promise.all([loadRows(r => !firstRows.has(r)), loadOrb()]));
  }

  // the drawing fallback until the renderer skins bodies (track R): a still body at each enemy's place
  const api = {
    drawBodies: !R,
    rows,
  };
  const pools = new Map();   // slot → [{i, used}]
  const animated = new Set();
  const drawn = new Map();   // net → {slot, i}
  const draw = (slot, model, place) => {
    const pool = pools.get(slot) ?? (pools.set(slot, []), pools.get(slot));
    let p = pool.find(x => !x.used);
    if (!p) { p = { i: host.instance(model.id, ctx.slotIndex(slot), place), used: false }; pool.push(p); }
    else { host.move(p.i, place); host.visible(p.i, true); }
    p.used = true;
    return p.i;
  };

  // ---- the AI view ----
  const view = () => {
    const f = host.forge;
    const ptr = f.ai_view_ptr(), cap = f.ai_capacity(), n = f.ai_count();
    if (!ptr) return { n: 0, at: () => 0 };
    const v = new Float32Array(host.memory.buffer, ptr, f.ai_fields() * cap);
    return { n, at: (field, i) => v[field * cap + i] };
  };
  const enemies = () => {
    const v = view(), out = [];
    for (let i = 0; i < v.n; i++) {
      if (v.at(AI.KIND, i) !== KIND.ENEMY) continue;
      const mark = v.at(AI.ELITE, i) | 0;
      out.push({ net: v.at(AI.NET, i), type: v.at(AI.TYPE, i), id: rows[v.at(AI.TYPE, i)]?.id ?? null, arch: ARCHS[v.at(AI.ARCH, i)] ?? '?', state: STATES[v.at(AI.STATE, i)] ?? '?', t: v.at(AI.STATE_T, i),
        eye: { color: [v.at(AI.EYE_R, i), v.at(AI.EYE_G, i), v.at(AI.EYE_B, i)], intensity: v.at(AI.EYE_I, i) }, flash: v.at(AI.FLASH, i), offset: v.at(AI.OFFSET, i), target: v.at(AI.TARGET, i), flags: v.at(AI.FLAGS, i), hp: v.at(AI.HP, i),
        elite: ELITE.MODIFIERS[mark & 7] || null, young: (mark & ELITE.CHILD) !== 0 });
    }
    return out;
  };
  const boss = () => { const b = host.forge.ai_boss(); return b[0] ? { net: b[0], hp: b[1], max: b[2], phase: b[3], phases: b[4], state: STATES[b[5]] ?? '?', row: b[6], invulnerable: b[7] > 0.5, share: b[2] ? b[1] / b[2] : 0 } : null; };
  const director = () => { const d = host.forge.ai_director(); return { phase: ['idle', 'running', 'reward', 'done'][d[0]] ?? '?', wave: d[1], waves: d[2], spawned: d[3], total: d[4], killed: d[5], alive: d[6], seconds: Math.round(d[7] * 100) / 100, kills: d[8], started: d[9], attackers: d[10], mounds: d[11], number: d[12] ?? d[1], lap: d[13] ?? 0, endless: (d[14] ?? 0) > 0.5 }; };
  const bots = () => { const b = host.forge.ai_bots(), out = []; for (let k = 0; k + 7 < b.length; k += 8) out.push({ id: b[k], mode: Object.keys(MODES)[b[k + 1]] ?? '?', target: b[k + 2], firing: b[k + 3] > 0.5, shots: b[k + 4], swings: b[k + 5], evades: b[k + 6], enabled: b[k + 7] > 0.5 }); return out; };

  // ---- the director with the round (the host's copy) ----
  const waves = Array.isArray(tables.waves) ? tables.waves.length : 0;
  // by hand when the rules say so, and in a staged moment (?gf-demo=…: one thing to look at, no waves; verify's
  // check 16 stages forge-feel's target dummy)
  const manual = ctx.config?.rules?.params?.director === 'manual' || (typeof location !== 'undefined' && /[?&]gf-demo=/.test(location.search ?? ''));
  const cmd = (act, wave = 0, lap = 0) => host.cmd.raw(OP.DIRECTOR, lap ? [act, wave, lap] : [act, wave], []);
  let phase = null;
  host.on('rule', e => {
    if (e.remote || e.name !== 'wave-reward') return;
    // c: a reward, d: the cart (wave 7). A core before wave 7 said neither: a reward
    const cart = e.d > 0.5, reward = e.c > 0.5 || !cart;
    let parts = (reward ? 1 : 0) + (cart ? 1 : 0), resumed = false;
    const resume = () => { if (--parts <= 0 && !resumed) { resumed = true; cmd(DIRECTOR.RESUME); } };
    // one timer for both: the longer of the two tables' seconds
    const seconds = cart && reward ? Math.max(Number(tables.deal?.seconds) || 0, Number(tables.shop?.seconds) || 0) : 0;
    if (cart && !ctx.shop?.open({ wave: e.a, resume, seconds, withReward: reward })) resume();
    if (!reward) return;
    const rules = ctx.rules;
    if (rules?.reward) { try { rules.reward(ctx, { wave: e.a, waves: e.b, resume, seconds }); } catch (err) { console.error(err); resume(); } }
    else if (!ctx.cards?.open({ wave: e.a, resume, seconds })) resume();
  });
  // ---- wave 7: elites. The first of each modifier in a run gets a soft banner (the rules' own banner wins); this
  // copy's own player burning gets an ember-coloured edge while it burns ----
  const ET = tables.elites ?? null;
  const shownFirst = new Set(), firstQueue = [];
  let burnLeft = 0, burnEl = null;
  host.on('rule', e => {
    if (e.name === 'elite' && e.c > 0.5 && ET?.on) {
      const m = ELITE.MODIFIERS[e.a | 0], t = m && ET[m];
      if (!t || shownFirst.has(m)) return;
      shownFirst.add(m);
      const who = rows[e.b | 0]?.name || rows[e.b | 0]?.id || '';
      // shown when no other banner is (a soft banner never replaces one, and the wave's own is up as its first rise)
      firstQueue.push({ text: `${t.name || m} ${who}`.trim(), sub: t.line || null, tone: m === 'burning' ? 'ember' : 'blood', left: 8 });
    } else if (e.name === 'burning') {
      const me = host.players().find(p => p.local)?.id ?? 0;
      if (e.entity === me) burnLeft = Math.max(burnLeft, Number(e.a) || 0);
    } else if ((e.name === 'wave-start' && (e.a | 0) <= 1) || e.name === 'player-out') { shownFirst.clear(); firstQueue.length = 0; burnLeft = 0; }
  });
  const firstBanner = dt => {
    if (!firstQueue.length) return;
    for (const q of firstQueue) q.left -= dt;
    while (firstQueue.length && firstQueue[0].left <= 0) firstQueue.shift();
    if (firstQueue.length && !ctx.ui?.bannerText) { const q = firstQueue.shift(); ctx.ui?.banner?.(q.text, 2.2, { sub: q.sub, tone: q.tone, soft: true }); }
  };
  const burnEdge = dt => {
    if (!ET?.on) return;
    burnLeft = Math.max(0, burnLeft - dt);
    const me = host.players().find(p => p.local);
    if (me && me.alive === false) burnLeft = 0;
    if (!burnEl && burnLeft > 0 && ctx.ui?.root && typeof document !== 'undefined') {
      if (!document.getElementById('gf-forge-elite-css')) { const st = document.createElement('style'); st.id = 'gf-forge-elite-css'; st.textContent = ELITE_CSS; document.head.append(st); }
      burnEl = document.createElement('div'); burnEl.className = 'gf-forge-burn'; ctx.ui.root.prepend(burnEl);
    }
    if (burnEl) { const o = burnLeft > 0 ? '1' : '0'; if (burnEl.style.opacity !== o) burnEl.style.opacity = o; }
  };

  // a new enemy: animate its body (bones, hurtboxes on them, the AI's clips)
  host.on('spawn', e => {
    if (e.entityKind !== KIND.ENEMY) return;
    const p = load(e.type);
    if (!p) return;
    Promise.all([p, loadClips()]).then(([b, c]) => {
      if (!(b && b.anim >= 0 && c >= 0 && host.animate(e.id, b.anim, c, { hurt: true }))) return;
      animated.add(e.id);
      // what its type holds, on its hand sockets (the renderer takes them off again when it despawns)
      if (R) for (const h of b.held) R.attach(e.id, h.model, ctx.slotIndex(h.slot), h.socket, h.grip);
    });
  });

  // ---- bots: the shared bot API over OP_BOT ----
  const brains = new Map();
  ctx.makeBot = p => {
    const b = { mode: 'auto', target: null, goal: null, stopAt: 0.8, aimAt_: null, presses: 0, holds: new Map(), skill: 0.6,
      seek(pos, { stop = 0.8 } = {}) { b.mode = 'seek'; b.goal = pos; b.stopAt = stop; }, flee(pos) { b.mode = 'flee'; b.goal = pos; },
      wander() { b.mode = 'wander'; }, stop() { b.mode = 'idle'; }, fight() { b.mode = 'fight'; }, auto() { b.mode = 'auto'; b.goal = null; },
      face() {}, aimAt(pos) { b.aimAt_ = pos; }, press(action) { b.presses |= BTN[action] ?? 0; }, hold(action, s = 0.3) { if (BTN[action]) b.holds.set(action, s); },
      begin() { b.aimAt_ = null; }, get hushed() { return false; } };
    brains.set(p.id, b);
    return b;
  };
  // the forge bot target helpers (CONTRACT §6c's names): an enemy to go for, and the attack on it
  ctx.bots = {
    target(p, { range = 30 } = {}) { const me = p.position; let best = null, bd = range; for (const e of host.entities()) { if (e.kind !== KIND.ENEMY || (e.flags & ENTITY_FLAG.DEAD)) continue; const d = Math.hypot(e.x - me.x, e.z - me.z); if (d < bd) { bd = d; best = { x: e.x, y: e.y, z: e.z, net: e.net }; } } return best; },
    attack(p, t, { stop = 6 } = {}) { if (!p.bot || !t) return; p.bot.mode = 'fight'; p.bot.goal = t; p.bot.stopAt = stop; },
    aim(p, t) { p.bot?.aimAt(t); },
    ready: () => true,
  };
  const sendBots = (dt, playing) => {
    if (!ctx.host || !ctx.players) return;
    const rules = ctx.rules;
    for (const p of ctx.players.bots?.() ?? []) {
      if (!p.owned) continue;
      const b = p.bot ?? brains.get(p.id);
      const n = ctx.players.nid?.(p.id) ?? null;
      if (!b || n == null) continue;
      b.begin?.();
      if (playing && rules?.bot) { try { rules.bot(ctx, p, dt); } catch (e) { console.error(e); } }
      let hold = 0;
      for (const [k, s] of [...b.holds]) { hold |= BTN[k] ?? 0; const left = s - dt; if (left <= 0) b.holds.delete(k); else b.holds.set(k, left); }
      const g = b.goal ?? null, a = b.aimAt_ ?? null;
      host.cmd.raw(OP.BOT, [n, playing ? 1 : 0, MODES[b.mode] ?? 0, a ? 1 : 0, b.presses >>> 0, hold >>> 0],
        [b.skill, g?.x ?? 0, g?.y ?? 0, g?.z ?? 0, b.stopAt ?? 0.8, a?.x ?? 0, (a?.y ?? 0) + 1, a?.z ?? 0]);
      b.presses = 0;
    }
  };

  // ---- every frame, after the core's tick ----
  // the first wave is owed from the moment a round plays, and rises when its bodies are in (never a wave of nothing
  // to see; they were asked for when the menu was drawn, so this waits only for a player quicker than the download).
  // After FIRST_WAIT seconds it rises anyway: a body that failed to load is drawn when it does
  const FIRST_WAIT = 10;
  let owed = 0;
  const frame = dt => {
    const ph = ctx.round?.phase ?? null;
    if (ph !== phase) {
      if (ctx.host && waves && !manual) {
        if (ph === 'playing') owed = 1e-9;
        else if (phase === 'playing' || ph === 'lobby' || ph === 'results') { owed = 0; cmd(DIRECTOR.STOP); ctx.cards?.close?.(); }
      } else if (ctx.host && ph !== 'playing' && phase === 'playing') host.cmd.raw(OP.CLEAR, [], []);
      phase = ph;
    }
    if (owed > 0) { owed += dt; if (firstReady || owed > FIRST_WAIT) { owed = 0; cmd(DIRECTOR.START, 0); } }
    sendBots(dt, ph === 'playing');
    burnEdge(dt);
    firstBanner(dt);
    if (!api.drawBodies) return;
    // the fallback drawing: every enemy and orb at its place (still bodies; a body that rises is drawn rising)
    for (const pool of pools.values()) for (const x of pool) x.used = false;
    const v = view(), off = new Map();
    for (let i = 0; i < v.n; i++) off.set(v.at(AI.NET, i), v.at(AI.OFFSET, i));
    for (const e of host.entities()) {
      if (e.kind === KIND.ENEMY && !(e.flags & ENTITY_FLAG.DEAD)) {
        const body = ready.get(e.type);
        if (!body) { load(e.type); continue; }
        // a gf-humanoid-1 body faces +Z, a forge entity −Z: turned by π; a still body (no skinning) carries the AI's
        // offset (the rise from the ground, the lunge's dip), which a skinned body's clips carry themselves
        const yaw = yawOf(e.q) + Math.PI;
        draw(body.slot, body.model, { at: [e.x, e.y + (off.get(e.net) ?? 0), e.z], rot: (yaw * 180) / Math.PI, scale: e.scale || 1 });
      } else if (e.kind === KIND.PROJECTILE && E?.orb) {
        if (!orbModel) { loadOrb(); continue; }
        draw(E.orb.slot, orbModel, { at: [e.x, e.y - 0.12, e.z], rot: (yawOf(e.q) * 180) / Math.PI + 180, scale: E.orb.scale ?? 1.4 });
      }
    }
    for (const pool of pools.values()) for (const x of pool) if (!x.used) host.visible(x.i, false);
  };
  if (!showing) ctx.onFrame?.push(frame);

  Object.assign(api, {
    spawn(type, { at = null, emerge = true, yaw = 0, elite = null } = {}) {
      const row = rowOf(type);
      if (row < 0) return false;
      const m = typeof elite === 'number' ? elite : Math.max(0, ELITE.MODIFIERS.indexOf(elite ?? ''));
      if (!at) { if (m) host.cmd.raw(OP.ELITE, [m, 1], []); host.cmd.raw(OP.EMERGE, [row, 1], []); return true; }
      host.cmd.raw(OP.SPAWN, m ? [row, emerge ? 0 : 1, m] : [row, emerge ? 0 : 1], [at.x ?? at[0], at.y ?? at[1] ?? 0.05, at.z ?? at[2], yaw]);
      return true;
    },
    emerge(type, count = 1) { const row = rowOf(type); if (row >= 0) host.cmd.raw(OP.EMERGE, [row, count], []); return row >= 0; },
    director: { start: (wave = 0, lap = 0) => cmd(DIRECTOR.START, wave, lap), stop: () => cmd(DIRECTOR.STOP), resume: () => cmd(DIRECTOR.RESUME), skip: (wave, lap = 0) => cmd(DIRECTOR.SKIP, wave, lap), pause: () => cmd(DIRECTOR.PAUSE), state: director },
    elites: {
      MODIFIERS: ELITE.MODIFIERS.slice(1),
      /** QA: the director's next `count` arrivals rise with modifier `m` (a name or 1-4; none: clear what is queued). */
      force: (m, count = 1) => { const n = typeof m === 'number' ? m : Math.max(0, ELITE.MODIFIERS.indexOf(m ?? '')); host.cmd.raw(OP.ELITE, [n, count], []); return n; },
      /** The elites as this copy knows them (the host's burns and fire; raised by modifier). */
      observe: () => {
        const v = host.forge.ai_elites?.() ?? [];
        if (!v.length) return null;
        return { raised: { burning: v[0], armoured: v[1], splitting: v[2], fast: v[3] }, children: v[4], splits: v[5], bites: v[6], burned: Math.round(v[7] * 100) / 100, ignitions: v[8],
          thisWave: v[9], seen: v[10], burning: v[11], patches: v[12], forced: v[13], patch: v[12] ? { left: Math.round(v[14] * 100) / 100, radius: v[15], dps: v[16] } : null };
      },
      burning: () => burnLeft,
    },
    clear: () => host.cmd.raw(OP.CLEAR, [], []),
    knock: (net, dir = [0, 0, 1], s = 1) => host.cmd.raw(OP.KNOCK, [net], [dir[0], dir[1], dir[2], s]),
    enemies, boss, bots, view,
    archetypes: () => { try { return JSON.parse(host.forge.ai_archetypes()); } catch { return null; } },
    nav: () => host.forge.ai_nav(),
    observe: () => {
      const list = enemies(), by = {}, elites = {};
      for (const e of list) { by[e.state] = (by[e.state] ?? 0) + 1; if (e.elite) elites[e.elite] = (elites[e.elite] ?? 0) + 1; }
      return { director: director(), boss: boss(), enemies: list.length, states: by, elites, burning: Math.round(burnLeft * 100) / 100, bots: bots(), drawBodies: api.drawBodies, animated: animated.size, firstReady, waveOwed: owed > 0, bodiesLoaded: ready.size };
    },
  });
  return api;
}
