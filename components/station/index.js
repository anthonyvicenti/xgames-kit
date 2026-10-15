// mechanic: station (track K2). Interact with a prop: an in-world screen (text and UI on a CanvasTexture, never art)
// shows a task, its progress and the quota; hold, tap or stand to work it. README.md has ownership and API.
//
//   const st = ctx.mechanics.get('station');
//   st.onComplete(({ player }) => { player.score += 1; });   // host only
//   st.show(0, { title: 'Call 12', lines: ['Say hello'], bar: 0.5 });   // host: your own text on screen 0
import * as THREE from 'three';
import { createStation, createQuota, nearestStation, screenLines } from './logic.js';
import { areaOf } from '../../core/util.js';

export const id = 'station';
export const examples = ['a desk with a job quota', 'a PC the players use to complete orders', 'a hold-to-fix control panel'];

const D = {
  stations: [], mode: 'hold', taskSeconds: 3, taps: 8, cooldown: 2, keepProgress: false, range: 2.0, action: 'interact', quota: 0, quotaLabel: 'Done',
  title: 'Station', idleText: 'Press E to start', busyText: 'In use by {name}', doneText: 'Done!', mineText: 'Working... {pct}%', pointsPerTask: 1,
  screenWidth: 1.4, screenHeight: 0.7, screenY: 1.9, screenColor: '#12182b', textColor: '#ffffff', accent: '#4be0a8', standColor: '#8a93a8', stand: true, showPrompt: true, soundStart: '', soundDone: 'coin',
};
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    stations: { type: 'array', default: D.stations, items: { type: 'object' }, description: 'Where stations are: [{zone}] or [{at: [x, y, z]}] or [{prop: "desk", index: 0}] (the screen goes above that prop), each with an optional title. Empty: one in the middle of the play area' },
    mode: { type: 'string', enum: ['hold', 'tap', 'stand'], default: D.mode, description: 'hold: hold the action for taskSeconds; tap: press it `taps` times; stand: stay in range' },
    taskSeconds: { ...num('Seconds a hold or stand task takes', 0.2, 60), default: D.taskSeconds },
    taps: { type: 'integer', minimum: 1, maximum: 100, default: D.taps, description: 'Presses a tap task takes' },
    cooldown: { ...num('Seconds before a finished station can be worked again', 0, 120), default: D.cooldown },
    keepProgress: { type: 'boolean', default: D.keepProgress, description: 'Letting go of a hold keeps the progress made (the same player resumes)' },
    range: { ...num('How close a player must be (m)', 0.5, 8), default: D.range },
    action: { type: 'string', enum: ['interact', 'primary', 'secondary'], default: D.action, description: 'The input that works a station' },
    quota: { type: 'integer', minimum: 0, maximum: 999, default: D.quota, description: 'Tasks the whole team must finish (0: no quota); the rules read quota().met' },
    quotaLabel: { type: 'string', default: D.quotaLabel, description: 'Word shown beside the quota count' },
    title: { type: 'string', default: D.title, description: 'Screen title' },
    idleText: { type: 'string', default: D.idleText, description: 'Screen text while free' },
    busyText: { type: 'string', default: D.busyText, description: 'Screen text while someone else works it ({name})' },
    mineText: { type: 'string', default: D.mineText, description: 'Screen text while you work it ({pct})' },
    doneText: { type: 'string', default: D.doneText, description: 'Screen text after a finished task' },
    pointsPerTask: { ...num('Score the player gets for a finished task', 0, 100), default: D.pointsPerTask },
    screenWidth: { ...num('Screen width (m)', 0.3, 5), default: D.screenWidth },
    screenHeight: { ...num('Screen height (m)', 0.2, 3), default: D.screenHeight },
    screenY: { ...num('Height of the screen centre above the ground (m)', 0.3, 5), default: D.screenY },
    screenColor: { type: 'string', default: D.screenColor, description: 'Screen background' },
    textColor: { type: 'string', default: D.textColor, description: 'Screen text colour' },
    accent: { type: 'string', default: D.accent, description: 'Progress bar colour' },
    standColor: { type: 'string', default: D.standColor, description: 'Colour of the stand under a screen with no prop' },
    stand: { type: 'boolean', default: D.stand, description: 'Draw a small stand under screens that are not on a prop' },
    showPrompt: { type: 'boolean', default: D.showPrompt, description: 'Show a hint near a station' },
    soundStart: { type: 'string', default: D.soundStart, description: 'Sound id when work starts' },
    soundDone: { type: 'string', default: D.soundDone, description: 'Sound id when a task is finished' },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.station.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : type === 'text' ? 'text' : 'gameplay', ...extra });
export const slots = [
  vs('taskSeconds', 'Seconds a task takes', 'number', { tier: 'main', rank: 60, constraints: { min: 0.2, max: 60, unit: 's' } }),
  vs('quota', 'Tasks needed (quota)', 'integer', { tier: 'main', rank: 58, constraints: { min: 0, max: 999 } }),
  vs('title', 'Screen title', 'text', { tier: 'main', rank: 54, constraints: { maxLength: 30 } }),
  vs('screenColor', 'Screen colour', 'color', { rank: 34 }),
  vs('accent', 'Progress bar colour', 'color', { rank: 32 }),
  vs('textColor', 'Screen text colour', 'color', { rank: 20 }),
  vs('standColor', 'Stand colour', 'color', { rank: 10 }),
  vs('cooldown', 'Cooldown after a task', 'number', { constraints: { min: 0, max: 120, unit: 's' } }),
  vs('taps', 'Presses in a tap task', 'integer', { constraints: { min: 1, max: 100 } }),
  vs('range', 'Use distance', 'number', { constraints: { min: 0.5, max: 8, unit: 'm' } }),
  vs('pointsPerTask', 'Score per task', 'number', { constraints: { min: 0, max: 100 } }),
  vs('idleText', 'Free text', 'text', { constraints: { maxLength: 40 } }),
  vs('busyText', 'Busy text', 'text', { constraints: { maxLength: 40 } }),
  vs('mineText', 'Working text', 'text', { constraints: { maxLength: 40 } }),
  vs('doneText', 'Done text', 'text', { constraints: { maxLength: 40 } }),
  vs('quotaLabel', 'Quota word', 'text', { constraints: { maxLength: 20 } }),
  vs('screenWidth', 'Screen width', 'number', { constraints: { min: 0.3, max: 5, unit: 'm' } }),
  vs('screenHeight', 'Screen height', 'number', { constraints: { min: 0.2, max: 3, unit: 'm' } }),
  vs('screenY', 'Screen height above ground', 'number', { constraints: { min: 0.3, max: 5, unit: 'm' } }),
  vs('soundDone', 'Task done sound id', 'text', { constraints: { maxLength: 40 } }),
];

const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
const CODE = { idle: 0, busy: 1, cool: 2 }, NAME = ['idle', 'busy', 'cool'];

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.station.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const A = areaOf(ctx.world);
  const L = { complete: [], start: [], cancel: [] };
  const root = new THREE.Group(); root.name = 'gf-stations'; ctx.scene.add(root);
  let spots = [];                   // [{x, y, z, yaw, title, onProp}] resolved once the world is up
  const logic = [];                 // host: one createStation per spot
  const views = [];                 // every copy: {mesh, canvas, tex, key, stand}
  const custom = new Map();         // host: spot → {title, lines, bar} the rules set
  const quota = createQuota(V('quota'));
  let S = null, resolved = false, lastWire = [], lastQuota = 0, promptOn = false, tAcc = 0;
  const now = () => ctx.time.now;

  function resolve() {
    resolved = true;
    const list = P.stations?.length ? P.stations : [{ zone: ctx.world.zone?.('centre') ? 'centre' : '' }];
    // where each stands: the world's own ground (worlds/placement.js), the same on every copy (a seeded draw per
    // station over the same world); at [x, z] stands on the ground there, a zone or "the middle" on open ground every
    // seat reaches (nearest the zone's or the play area's middle), never a floor at y = 0
    const W = ctx.world, seeded = k => { let q = 7919 * (k + 1); return () => ((q = (q * 16807) % 2147483647) / 2147483647); };
    const placed = (i, zone, at) => W.place?.('station', 1, { ...(zone ? { zone } : {}), prefer: at, rng: seeded(i), clear: 0.9, away: 1.2, exclude: spots.map(o => ({ x: o.x, z: o.z, r: 2 })) })?.[0] ?? null;
    spots = [];
    for (const [i, def] of list.entries()) spots.push((() => {
      let x = A.cx, y = W.groundAt?.(A.cx, A.cz) ?? 0, z = A.cz, onProp = false;
      if (def.at) { x = def.at[0]; z = def.at.length === 2 ? def.at[1] : def.at[2]; y = def.at.length === 2 ? (W.groundAt?.(x, z) ?? 0) : def.at[1]; }
      else if (def.zone) { const zn = W.zone?.(def.zone); if (zn) { const a = zn.at, ax = a.x ?? a[0], az = a.z ?? a[2]; const q = placed(i, def.zone, { x: ax, z: az }); if (q) ({ x, y, z } = q); else { x = ax; z = az; y = W.groundAt?.(ax, az) ?? a.y ?? a[1] ?? 0; } } }
      else if (!def.prop) { const q = placed(i, null, { x: A.cx, z: A.cz }); if (q) ({ x, y, z } = q); }
      else if (def.prop) {
        const arr = ctx.world.props?.get?.(def.prop) ?? [], it = arr[def.index ?? 0];
        if (it) { onProp = true; if (it.at) { x = it.at.x ?? it.at[0]; y = it.at.y ?? it.at[1] ?? 0; z = it.at.z ?? it.at[2]; } else if (it.position) { x = it.position.x; y = it.position.y; z = it.position.z; } }
      }
      return { x, y, z, yaw: Math.atan2(A.cx - x, A.cz - z), title: def.title ?? V('title'), onProp };
    })());
    for (const sp of spots) logic.push(createStation({ mode: V('mode'), taskSeconds: V('taskSeconds'), taps: V('taps'), cooldown: V('cooldown'), keepProgress: V('keepProgress') }));
    spots.forEach((sp, i) => buildView(sp, i));
  }

  function buildView(sp, i) {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = Math.round(512 * V('screenHeight') / V('screenWidth'));
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(V('screenWidth'), V('screenHeight')), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    mesh.position.set(sp.x, sp.y + V('screenY'), sp.z); mesh.rotation.y = sp.yaw; mesh.name = `gf-station-screen-${i}`;
    ctx.assets.tag(mesh, 'mechanic.station.screen-color'); root.add(mesh);
    let stand = null;
    if (V('stand') && !sp.onProp) {
      const h = V('screenY') - V('screenHeight') / 2;
      stand = new THREE.Mesh(new THREE.BoxGeometry(0.16, h, 0.16).translate(0, h / 2, 0), ctx.modules?.look?.material?.('prop', { tint: V('standColor') }) ?? new THREE.MeshStandardMaterial({ color: V('standColor'), roughness: 0.7 }));
      stand.position.set(sp.x, sp.y, sp.z); stand.castShadow = true; ctx.assets.tag(stand, 'mechanic.station.stand-color'); root.add(stand);
    }
    views[i] = { mesh, canvas, tex, key: '', stand };
  }
  function draw(i, content) {
    const v = views[i], key = JSON.stringify([content, V('screenColor'), V('textColor'), V('accent')]);
    if (v.key === key) return; v.key = key;
    const c = v.canvas.getContext('2d'), W = v.canvas.width, H = v.canvas.height;
    c.fillStyle = V('screenColor'); c.fillRect(0, 0, W, H);
    c.fillStyle = V('textColor'); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `700 ${Math.round(H * 0.17)}px system-ui, sans-serif`; c.fillText(content.title, W / 2, H * 0.18, W * 0.92);
    c.font = `600 ${Math.round(H * 0.12)}px system-ui, sans-serif`;
    content.lines.slice(0, 3).forEach((ln, k) => c.fillText(ln, W / 2, H * (0.42 + k * 0.17), W * 0.92));
    const bx = W * 0.08, bw = W * 0.84, by = H * 0.86, bh = H * 0.07;
    c.fillStyle = '#ffffff30'; c.fillRect(bx, by, bw, bh);
    c.fillStyle = V('accent'); c.fillRect(bx, by, bw * Math.max(0, Math.min(1, content.bar ?? 0)), bh);
    v.tex.needsUpdate = true;
  }

  // ---------- host ----------
  function inRange(p, sp) { return p && p.alive !== false && Math.hypot(p.position.x - sp.x, p.position.z - sp.z) <= V('range') + 0.8; }
  function handle(i, events, who) {
    for (const e of events) {
      const p = typeof who === 'string' ? ctx.players.get(who) : who;
      if (e === 'start') for (const fn of L.start.slice()) try { fn({ station: i, player: p }); } catch (er) { console.error(er); }
      else if (e === 'cancel') for (const fn of L.cancel.slice()) try { fn({ station: i, player: p }); } catch (er) { console.error(er); }
      else if (e === 'done') {
        quota.add(1);
        if (p && V('pointsPerTask')) p.score += V('pointsPerTask');
        for (const fn of L.complete.slice()) try { fn({ station: i, player: p, quota: { done: quota.done, needed: quota.needed, met: quota.met } }); } catch (er) { console.error(er); }
      }
    }
  }
  function hostUse(p, i, on) {
    const st = logic[i], sp = spots[i]; if (!st || !p) return false;
    if (on) { if (!inRange(p, sp) || p.alive === false) return false; const ev = st.claim(p.id); handle(i, ev, p); return st.who === p.id; }
    handle(i, st.release(p.id), p); return true;
  }
  function hostTap(p, i) {
    const st = logic[i], sp = spots[i]; if (!st || !p || !inRange(p, sp)) return false;
    const before = st.who, ev = st.tap(p.id);
    handle(i, ev, p.id === before || ev.includes('done') ? (ev.includes('done') ? p : p) : p); return true;
  }

  const wire = () => logic.map(st => [CODE[st.state], st.who ? (ctx.players.get(st.who)?.seat ?? -1) : -1, Math.round(st.progress * 100), Math.round(st.cool * 10)]);
  const api = {
    id, params: P,
    /** Work station i: on=true starts (hold/stand modes), on=false lets go. An owned player, or any bot on the host. */
    use(p, i, on = true) {
      if (!S || !resolved || !p || !(p.owned || ctx.host)) return false;
      if (ctx.host) return hostUse(p, i, on);
      ctx.net.send('station:use', { p: p.id, s: i, on: on ? 1 : 0 }, 'host'); return true;
    },
    /** One press in tap mode. */
    tap(p, i) {
      if (!S || !resolved || !p || !(p.owned || ctx.host)) return false;
      if (ctx.host) return hostTap(p, i);
      ctx.net.send('station:tap', { p: p.id, s: i }, 'host'); return true;
    },
    /** The nearest station within range of a player: {index, dist, state} or null (every copy). */
    nearest(p, range = V('range')) { const n = nearestStation(spots, p.position.x, p.position.z, range); return n ? { ...n, state: api.state(n.index).state } : null; },
    /** Station i: {state: 'idle'|'busy'|'cool', who (player id), progress 0..1, cool (s)} on every copy. */
    state(i) {
      if (ctx.host) { const st = logic[i]; return st ? { state: st.state, who: st.who, progress: st.progress, cool: st.cool } : null; }
      const w = S?.s?.[i]; if (!w) return null;
      return { state: NAME[w[0]], who: ctx.players.list().find(p => p.seat === w[1])?.id ?? null, progress: w[2] / 100, cool: w[3] / 10 };
    },
    count: () => spots.length,
    positions: () => spots.map(s => ({ x: s.x, y: s.y, z: s.z })),
    /** An interact mechanic when its action is interact (CONTRACT §6d). */
    get interacts() { return V('action') === 'interact' && V('mode') !== 'stand'; },
    /** What a player can work (QA, verify check 13): the free stations, with the use distance and how to work them. */
    /** The places a player must get to (gate D's reach leg, window.__game.objectives()): every station. */
    objectives: () => Object.assign(spots.map((sp, i) => ({ kind: 'station', id: `station:${i}`, label: sp.title || 'station', x: sp.x, y: sp.y, z: sp.z, present: true, open: api.state(i)?.state !== 'cool', radius: V('range') })), { asked: (P.stations?.length || 1) }),
    interactables: () => spots.map((s, i) => ({ s, i, st: api.state(i) })).filter(x => x.st?.state === 'idle').map(({ s, i }) => ({ kind: 'station', id: `station:${i}`, x: s.x, y: s.y, z: s.z, reach: V('range'), touch: 0, action: V('action'), mode: V('mode'), seconds: V('mode') === 'tap' ? 0 : V('taskSeconds'), taps: V('taps') })),
    /** Every copy: {done, needed, met}. */
    quota() { const q = ctx.host ? [quota.done, quota.needed] : (S?.q ?? [0, V('quota')]); return { done: q[0], needed: q[1], met: q[1] > 0 && q[0] >= q[1] }; },
    /** Host: count tasks done outside the stations (or negative). */
    addQuota(n = 1) { if (ctx.host) quota.add(n); },
    /** Host: put your own text on screen i ({title, lines: [..], bar 0..1}); null gives the screen back. */
    show(i, content) { if (!ctx.host) return; if (content) custom.set(i, { title: String(content.title ?? '').slice(0, 30), lines: (content.lines ?? []).slice(0, 3).map(s => String(s).slice(0, 40)), bar: content.bar ?? 0 }); else custom.delete(i); },
    /** Host: {station, player, quota} when a task is finished / {station, player} when work starts or is dropped. → unsubscribe */
    onComplete(fn) { L.complete.push(fn); return unsub(L.complete, fn); },
    onStart(fn) { L.start.push(fn); return unsub(L.start, fn); },
    onCancel(fn) { L.cancel.push(fn); return unsub(L.cancel, fn); },
    reset() { logic.forEach(s => s.reset()); quota.reset(); custom.clear(); lastWire = []; lastQuota = 0; },
    update(dt) {
      if (!S) { if (!(ctx.shared && ctx.players && ctx.me)) return; S = ctx.shared.register('station', { s: [], q: [0, V('quota')], x: {} }); }
      if (!resolved) { if (ctx.world.walk && !ctx.world.walk.ready()) return; resolve(); }   // the ground is read after the physics' first step
      if (!spots.length) return;
      const playing = ctx.round?.phase === 'playing';
      // input of owned players (the local human and, on the host, bots that press interact)
      if (playing) for (const p of ctx.players.owned()) {
        if (p.alive === false) continue;
        const act = p.actions?.[V('action')]; if (!act) continue;
        const n = nearestStation(spots, p.position.x, p.position.z, V('range'));
        if (V('mode') === 'tap') { if (act.pressed && n) api.tap(p, n.index); }
        else if (V('mode') === 'hold') {
          if (act.pressed && n) api.use(p, n.index, true);
          if ((act.released || !act.down) && p.data?.stationAt !== undefined) { api.use(p, p.data.stationAt, false); delete p.data.stationAt; }
          if (act.pressed && n) p.data.stationAt = n.index;
        } else if (V('mode') === 'stand' && n) { const w = api.state(n.index); if (w?.state === 'idle') api.use(p, n.index, true); }
      }
      if (ctx.host) {
        if (playing) logic.forEach((st, i) => {
          const who = st.who ? ctx.players.get(st.who) : null;
          const ev = st.tick(dt, !who || inRange(who, spots[i]));
          if (ev.length) handle(i, ev.filter(e => e !== 'ready'), st.lastWho ?? who);
        });
        S.s = wire(); S.q = [quota.done, quota.needed];
        const xs = {}; custom.forEach((c, i) => { xs[i] = c; }); S.x = xs;
      }
      // every copy: screens, sounds on edges, the prompt
      const w = S.s ?? [];
      const q = api.quota(), me = ctx.me;
      spots.forEach((sp, i) => {
        const cur = w[i]; if (!cur) return;
        const was = lastWire[i];
        if (was && was[0] !== cur[0]) {
          if (cur[0] === 1 && V('soundStart')) ctx.audio?.play(V('soundStart'), { at: sp, optional: true });
          if (was[0] === 1 && cur[0] === 2 && V('soundDone')) ctx.audio?.play(V('soundDone'), { at: sp, optional: true });
        }
        const s = api.state(i), who = s.who ? ctx.players.get(s.who) : null;
        const text = (ctx.host ? custom.get(i) : S.x?.[i]) ?? screenLines(s, { title: sp.title, idleText: V('idleText'), busyText: V('busyText'), mineText: V('mineText'), doneText: V('doneText'), quota: { done: q.done, needed: q.needed, label: V('quotaLabel') }, name: who?.name ?? '', mine: who === me });
        draw(i, { title: text.title, lines: text.lines, bar: Math.round((text.bar ?? 0) * 50) / 50 });
      });
      lastWire = w.map(x => [...x]);
      if (V('showPrompt') && me && ctx.ui?.prompt) {
        const n = playing && me.alive !== false ? nearestStation(spots, me.position.x, me.position.z, V('range')) : null;
        const s = n ? api.state(n.index) : null;
        const on = !!n && s.state === 'idle';
        if (on !== promptOn || on) { promptOn = on; ctx.ui.prompt(on ? `${V('mode') === 'tap' ? 'Tap' : V('mode') === 'stand' ? 'Stay' : 'Hold'} ${V('action') === 'interact' ? 'E' : V('action')}: ${spots[n.index].title}` : null, 'station'); }
      }
    },
    /** `station:use` and `station:tap` from a player's copy, to the host. */
    event(name, d, from) {
      if (!ctx.host || !S || !resolved) return;
      const p = ctx.players.get(d?.p); if (!p || p.isBot || (ctx.net.active && from !== undefined && from !== p.id)) return;
      if (!Number.isInteger(d.s) || d.s < 0 || d.s >= spots.length) return;
      if (name === 'use') hostUse(p, d.s, !!d.on); else if (name === 'tap') hostTap(p, d.s);
    },
    dispose() { root.removeFromParent(); views.forEach(v => v?.tex.dispose()); },
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
  describe: 'Interact with a prop: an in-world screen or panel UI, timed tasks, quotas',
  rank: 70,
  needs: { parts: [], world: [] },
  uses: [],
  owns: p => [{ res: `input.${p.action}`, shared: true, why: `${p.action} works a station in range (params.action)`, free: 'set station params.action to another input' }],
  state: { key: 'station', fields: { s: '[[state, workerSeat, progress %, cooldown × 10]] per station', q: '[done, needed] the quota', x: 'screen text the rules set with station.show' } },
  events: [
    { name: 'onComplete', on: 'host', args: '{ station, player, quota: { done, needed, met } }', when: 'a task was finished' },
    { name: 'onStart', on: 'host', args: '{ station, player }', when: 'a player began working a station' },
    { name: 'onCancel', on: 'host', args: '{ station, player }', when: 'a player let go before it was done' },
  ],
  sync: { owner: 'host', how: 'the host owns each station\'s state and the quota; a copy sends its hold or taps' },
  note: [
    'A station is a screen in the world (text and a bar the kit draws); hold, tap or stand in range works it, with the HUD\'s prompt.',
    'A finished task already scores pointsPerTask and counts toward quota; station.show(i, { title, lines, bar }) puts your own text on a screen.',
    'Place stations by zone, position or prop: params.stations is [{ zone }], [{ at: [x, y, z] }] or [{ prop, index }].',
  ],
  stub: {
    as: 'station',
    worked: 'station.onComplete(({ quota }) => { if (quota.met) ctx.round.end(\'quota met\', ctx.players.list().map(p => p.id)); });',
    traps: [
      'adding score in onComplete counts every task twice (pointsPerTask is already added): set pointsPerTask to 0 first',
      'bots work a station only when the rules send them: in bot(ctx, p) walk to it and call station.use(p, i, true)',
    ],
  },
  signs: {
    sample: sh => (sh.station ? { station: (sh.station.s ?? []).map(x => [x[0], x[2]]), q: sh.station.q ?? null } : null),
    judge: v => {
      const ok = v.others.station;
      v.add('a station is worked', ok ? 'ok' : 'dead', 'shared.station.s progress, q', ok ? 'yes' : `no station made progress on any page (${v.names})`, ok ? '' : 'make bots work stations (rules.bot) and check station action and range');
    },
  },
};
