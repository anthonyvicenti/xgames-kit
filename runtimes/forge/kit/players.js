// gf-forge's players (CONTRACT §8 forge "Live co-op"), vendored as gf/forge/players.js: the same API as
// gf/three/net/players.js (ctx.players: add, remove, place, visible, list, get, others, owned, humans, bots), with every
// player in the Rust core. The shared round (gf/three/net/session.js) drives it unchanged.
//
// Who simulates whom (forge-core net.rs):
//   alone     this copy's own player (SPAWN local)
//   the host  its own player, and every joiner's from the inputs that joiner sends (SPAWN, not local: owned by the
//             host's core, which replays them and sends where they are in its snapshots)
//   a joiner  its own player, predicted at once and reconciled with the host's snapshots; the others are replicas the
//             host's snapshots bring (never placed from poses)
//   a viewer  (wave 4, watch then play: CONTRACT §9b) nobody: every player in the stream is a replica the host's
//             snapshots bring. Its own seat is a ghost (in no list, no player in the core: its seat's core id is the
//             streamer's). The camera is the eyes of the player it follows (`follow`: the streamer's kit id): the core
//             is told (host.net.watch), and from then on its camera, its feel view and that player's `local` flag in
//             the players view are that player's; that body is not drawn (the view is from inside it) and has no
//             nameplate
// A player's core id is its seat + 1, the same on every copy (snapshots name players by it).
//
// What the others are drawn as (gf/forge/wear.js; the art library after tracks C2 and C3): the co-op hunter of their
// seat (slots character.body.player, .2, .3, .4: hooded, templar, rogue, witchfinder), its `player_tint` cloth in the
// player's colour (or their loadout's), animated by the clips slot, the model of the weapon in their hand in their
// fist. The core holds it as each player's Wear (forge-core components::Wear: colour, body slot, held row, hidden); the
// renderer draws every animated body GPU-skinned (gf/forge/render.js `body`: track R; the wave 1b integration took
// track S's unskinned stand-in out). A copy never draws its own first-person body.
// `visible(p)` is honest: the chest inside this player's view and no wall of the world in between (forge-web
// clear_line). Yaws at this boundary are the kit's (a character's: 0 faces +Z); the core's are a camera's (toCoreYaw).
import { idleActions } from '../three/core/input.js';
import { spawnOf } from '../three/core/util.js';
import { toCoreYaw, toKitYaw } from './host.js';
import { TINT, BODY, CLIPS, heldSlot, bodySlot, CLIP_NAMES } from './wear.js';
import { createDown } from './down.js';

/** The clips of a player who is down with a friend standing, and of one getting back up (wave 2; the forge clip file's
 *  own names; a clip file without them falls back to the death clip). */
const DOWN_CLIPS = { down: 'knockdown', up: 'getup' };

const bySeat = (a, b) => a.seat - b.seat || String(a.id).localeCompare(String(b.id));
const r2 = v => Math.round(v * 100) / 100;

/** A position with the three.js Vector3 calls the shared modules use (copy, set, distanceTo). */
function vec(x = 0, y = 0, z = 0) {
  return { x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; }, copy(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; },
    distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); }, clone() { return vec(this.x, this.y, this.z); } };
}

/** Where a world point lands in this copy's view: {x, y} in −1..1 (NDC, y up), z the depth in metres; null behind. */
export function project(cam, p, aspect) {
  const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw), sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
  const f = [-sy * cp, sp, -cy * cp], r = [cy, 0, -sy];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const d = [p.x - cam.x, p.y - cam.y, p.z - cam.z], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = dot(d, f);
  if (!(z > 0.05)) return null;
  const t = Math.tan(((cam.fov || 68) * Math.PI) / 360);
  return { x: dot(d, r) / (z * t * aspect), y: dot(d, u) / (z * t), z };
}

export function createForgePlayers(ctx, { host, live = false, epoch = 0, watching = false, follow = () => null } = {}) {
  const role = !live ? 'solo' : watching ? 'viewer' : ctx.host ? 'host' : 'joiner';
  const A = ctx.assets, gf = ctx.gf;
  const map = new Map();
  // a viewer's own seat is nobody in the core (its seat's core id is another player's there)
  const nidOf = p => (p.ghost ? 0 : (p.seat ?? 0) + 1);
  const wearCfg = A.config?.('characters')?.forge ?? null;
  let roleSet = false;
  // a viewer: said once, before any snapshot; then who it looks through, as the stream names them
  if (role === 'viewer') { host.net.role('viewer'); roleSet = true; }
  const W = { nid: -1, player: null };
  /** The player a viewer looks through, once the core holds them (the host's snapshot brought them); else null. */
  const watched = () => (role === 'viewer' ? W.player : null);

  // ---- the bodies: one a seat (the four hunters), each loaded when a player first sits there; the clips once ----
  const R = ctx.render ?? null;
  const seatFiles = Array.isArray(wearCfg?.bodies) && wearCfg.bodies.length ? wearCfg.bodies.length : 1;
  const seatOf = p => ((p.seat ?? 0) % seatFiles + seatFiles) % seatFiles;
  const slotOf = p => { const s = bodySlot(seatOf(p)); return A.has(s) ? s : BODY; };
  const bodies = { ready: false, failed: null, clips: null, seats: new Map(), held: new Map() };
  const canDraw = () => !!wearCfg && !!R && A.has(BODY) && A.has(CLIPS);
  const loadClips = () => (bodies.clips ??= (async () => host.animClips(await gf.bytes(A.file(CLIPS))))());
  /** A seat's body: {body (the animation library's), model (the renderer's)}, loaded once. */
  function loadBody(p) {
    if (!canDraw()) return null;
    const slot = slotOf(p);
    if (!bodies.seats.has(slot)) bodies.seats.set(slot, (async () => {
      try {
        const [b, clips] = await Promise.all([R.body(await gf.bytes(A.file(slot)), ctx.slotIndex(slot)), loadClips()]);
        bodies.ready = true;
        return { ...b, clips, slot };
      } catch (e) { bodies.failed = e?.message ?? String(e); console.warn(`gf-forge players: ${slot} could not load (${bodies.failed})`); return null; }
    })());
    return bodies.seats.get(slot);
  }
  const heldModel = id => {
    if (!bodies.held.has(id)) bodies.held.set(id, (async () => { const s = heldSlot(id); if (!A.has(s)) return null; try { return await host.model(await gf.bytes(A.file(s))); } catch (e) { console.warn(`gf-forge players: ${s} could not load (${e?.message ?? e})`); return null; } })());
    return bodies.held.get(id);
  };

  function controllerFor(p) {
    const n = nidOf(p);
    const c = {
      enabled: true, feet: p.position, state: { stun: 0, facing: p.yaw }, anim: 'idle',
      teleport(pos, yaw = p.yaw) {
        p.position.set(pos.x, pos.y ?? 0.05, pos.z); p.yaw = Number.isFinite(yaw) ? yaw : p.yaw;
        host.cmd.teleport(n, { x: pos.x, y: pos.y ?? 0.05, z: pos.z }, toCoreYaw(p.yaw), 0);
      },
      pose: () => ({ x: r2(p.position.x), y: r2(p.position.y), z: r2(p.position.z), yaw: r2(p.yaw), anim: c.anim, aim: p.aim }),
      // the feel systems (knocks, pushes, held actions) are track F's; until then these do nothing, and say so
      act() {}, knock() { return false; }, push() { return false; },
      dispose() { host.cmd.despawn(n); },
    };
    return c;
  }

  async function add(info) {
    if (map.has(info.id)) return map.get(info.id);
    const p = {
      id: info.id, name: info.name ?? info.id, color: info.color ?? '#ffffff', seat: info.seat ?? 0, isBot: !!info.isBot, local: !!info.local, owned: !!info.owned,
      score: 0, alive: true, data: {}, character: null, controller: null, body: null, pose: null, position: vec(), yaw: 0, pitch: 0, anim: 'idle',
      aim: [0, 0, 1], aimDist: null, actions: idleActions(), input: { x: 0, z: 0 }, bot: null, poseExtra: {}, connected: true, drawn: false, onScreen: false,
      inputDriven: false, heldId: undefined, clip: null, animated: false,
      act() {}, knock() { return false; }, push() { return false; },
      teleport(pos, yaw) {
        if (p.controller) p.controller.teleport(pos, yaw);
        // the host moves a joiner's player itself (its core owns it); the joiner's prediction snaps to it
        else if (p.inputDriven) { p.position.set(pos.x, pos.y ?? 0.05, pos.z); if (Number.isFinite(yaw)) p.yaw = yaw; host.cmd.teleport(nidOf(p), { x: pos.x, y: pos.y ?? 0.05, z: pos.z }, toCoreYaw(p.yaw), 0); }
      },
      get x() { return p.position.x; }, get y() { return p.position.y; }, get z() { return p.position.z; },
    };
    p.role = info.role ?? 'player';
    map.set(p.id, p);
    // a viewer's own seat (the shared session adds it as its local player): a ghost, in no list and not in the core
    if (role === 'viewer' && (info.ghost || p.local)) { p.ghost = true; p.health = { hp: 0, max: 0, armor: 0 }; return p; }
    const n = nidOf(p);
    const s = spawnOf(ctx.world, p.seat);
    if (role === 'viewer') {
      // everyone in the stream: where they are is the host's snapshot's (never spawned or placed here)
      p.position.set(s.x, s.y ?? 0.05, s.z); p.yaw = s.yaw; p.owned = false;
    } else if (p.owned) {
      p.position.set(s.x, s.y ?? 0.05, s.z); p.yaw = s.yaw;
      if (p.local && !roleSet) { host.net.role(role, n, epoch); roleSet = true; }
      host.cmd.spawn(n, { x: s.x, y: s.y ?? 0.05, z: s.z }, toCoreYaw(s.yaw), p.local);
      p.controller = controllerFor(p);
    } else if (role === 'host' && !p.isBot) {
      // a joiner's player: the host's core simulates it from the inputs that joiner sends (net.rs)
      p.position.set(s.x, s.y ?? 0.05, s.z); p.yaw = s.yaw;
      host.cmd.spawn(n, { x: s.x, y: s.y ?? 0.05, z: s.z }, toCoreYaw(s.yaw), false);
      p.inputDriven = true;
    }
    if (!p.local) loadBody(p)?.then(b => { if (map.get(p.id) === p) p.body = b; });
    return p;
  }

  function remove(id) {
    const p = map.get(id); if (!p) return;
    if (!p.ghost) { host.cmd.despawn(nidOf(p)); R?.detach(nidOf(p)); }
    if (W.player === p) W.player = null;
    map.delete(id);
    ctx.assets.clearLoadout?.(id);
  }

  /** The colour a player's body is drawn in: their loadout's (CONTRACT §6e), else their seat's. */
  const loadoutTint = p => { const v = A.loadout?.(p.id)?.loadout?.values?.[TINT]; return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null; };
  const bodyColor = p => loadoutTint(p) ?? p.color;

  // down and revive on the screen (gf/forge/down.js): a marker over a downed friend, the revive's ring, the prompt
  let down = null, downTried = false;
  const downLayer = () => { if (!downTried && ctx.ui?.root) { downTried = true; try { down = createDown(ctx, { host }); } catch (e) { console.warn(`gf-forge players: the down markers could not start (${e?.message ?? e})`); } } return down; };

  /** After each tick: every player's state from the core's views, and the others' bodies. */
  function fromCore() {
    const byNid = new Map(host.players().map(q => [q.id, q]));
    const ents = new Map(host.entities(1).map(e => [e.net, e]));
    const run = host.runStates?.() ?? new Map();
    // a viewer: the player it follows (the streamer), told to the core when it changes; `watched()` once the core has them
    if (role === 'viewer') {
      let id = null; try { id = follow() ?? null; } catch { id = null; }
      const f = id != null ? map.get(id) ?? null : null, n = f && !f.ghost ? nidOf(f) : 0;
      if (n !== W.nid) { W.nid = n; host.net.watch(n); }
      W.player = f && n && byNid.has(n) ? f : null;
    }
    for (const p of map.values()) {
      if (p.ghost) continue;
      const n = nidOf(p), q = byNid.get(n), e = ents.get(n);
      if (!q) { p.drawn = false; continue; }
      // the run (wave 2): down with a friend standing, the revive under way, the cards held
      const r = run.get(n);
      const wasDown = p.down;
      p.down = !!r?.down; p.revive = r?.revive ?? 0; p.reviver = r?.reviver ?? 0; p.cards = r?.cards ?? 0;
      if (wasDown && !p.down && q.alive) p.rising = ctx.time.now + 0.9;
      p.position.set(q.x, q.y, q.z); p.yaw = toKitYaw(q.yaw); p.pitch = q.pitch;
      const speed = e?.speed ?? q.speed;
      p.anim = !q.alive ? 'down' : !q.grounded ? (q.vy > 0 ? 'jump' : 'fall') : speed > 5.8 ? 'run' : speed > 0.3 ? 'walk' : 'idle';
      // the core's health (forge-core Health: the tables' player.health and armour; damage from hits; the host's on a joiner)
      p.health = { hp: q.hp, max: q.hpMax, armor: q.armor };
      p.alive = q.alive;
      if (p.controller) { p.controller.anim = p.anim; p.controller.state.facing = p.yaw; }
      const cy = Math.cos(q.pitch);
      p.aim = [r2(-Math.sin(q.yaw) * cy), r2(Math.sin(q.pitch)), r2(-Math.cos(q.yaw) * cy)];
      // what the body wears (the core's Wear: the renderer reads its colour and whether to draw it), every frame (a
      // loadout can change mid-round)
      const slot = slotOf(p);
      host.wear(n, { color: bodyColor(p), body: A.has(slot) ? ctx.slotIndex(slot) : 0xffffffff, hidden: p.local });
      if (p.local || !p.body) { p.drawn = false; continue; }
      // the core animates it (its bones); the renderer draws every animated body skinned (track R). A body spawned
      // again (a new round) is animated again, and holds its weapon again
      if (!(e && (e.flags & 8))) {
        try { p.animated = !!host.animate(n, p.body.body, p.body.clips, { hurt: false }); } catch (err) { p.animated = false; console.warn(`gf-forge players: ${p.id} could not be animated (${err?.message ?? err})`); }
        p.clip = null; p.heldId = undefined;
      }
      p.drawn = p.animated;
      if (!p.animated) continue;
      const C = wearCfg?.clipNames ?? CLIP_NAMES;
      // down: lying where they fell; back up: the get-up, then what they do
      const rising = q.alive && (p.rising ?? 0) > ctx.time.now;
      const want = p.down ? (C.down ?? DOWN_CLIPS.down) : !q.alive ? C.death : rising ? (C.up ?? DOWN_CLIPS.up) : !q.grounded ? (q.vy > 0 ? C.jump : C.fall) : speed > 5.8 ? C.run : speed > 0.3 ? C.walk : C.idle;
      if (want && want !== p.clip) {
        const once = !q.alive || rising;
        if (!host.animPlay(n, want, { fade: 0.2, loop: !once }) && once) host.animPlay(n, C.death, { fade: 0.2, loop: false });
        p.clip = want;
      }
      holdWeapon(p, n);
    }
    // the markers, the prompt and the rings (every player, this copy's own too)
    const layer = run.size ? downLayer() : down;
    if (layer) {
      const list = [];
      // (a viewer: the one it looks through stands where a player's own would in this list, and is named: down.js)
      for (const p of map.values()) { if (p.ghost) continue; const n = nidOf(p), q = byNid.get(n); if (q) list.push({ nid: n, name: p.name, color: p.color, local: p.local || p === W.player, at: { x: q.x, y: q.y, z: q.z }, height: heightOf(p), down: !!p.down, revive: p.revive ?? 0, reviver: p.reviver ?? 0, alive: q.alive }); }
      try { layer.update(list, { watching: role === 'viewer' }); } catch (e) { console.error(e); }
    }
  }

  /** The weapon in a friend's hand: the model of their held row in their fist (the body's hand_r socket; the seat's
   *  fist and the weapon's own turn and scale from the catalog: gf/forge/wear.js). */
  function holdWeapon(p, n) {
    const w = host.wearOf(n), rows = ctx.tables?.weapons ?? [];
    const row = w && w.held < rows.length ? rows[w.held] : null;
    const id = row?.id ?? null;
    if (p.heldId === id) return;
    p.heldId = id;
    R.detach(n);
    if (!id) return;
    heldModel(id).then(m => {
      if (!m || p.heldId !== id || map.get(p.id) !== p) return;
      const g = wearCfg?.weapons?.[id]?.grip ?? {}, fist = wearCfg?.fists?.[seatOf(p)] ?? [0, -0.04, -0.01];
      R.detach(n);
      R.attach(n, m.id, ctx.slotIndex(heldSlot(id)), 'hand_r', { position: fist, quaternion: g.quaternion ?? [0, 0, -0.7071, 0.7071], scale: g.scale ?? 1.15 });
    });
  }

  /** A player this copy does not own: forge places nobody from poses (the core has them: the host simulates them,
   *  a joiner shows the host's snapshots); the pose only says they are connected. */
  function place(p, s) {
    if (!s) return;
    p.pose = s;
  }

  const heightOf = p => wearCfg?.heights?.[seatOf(p)] ?? wearCfg?.height ?? 1.75;

  /** Could this copy's player see `p` now: its chest inside the view, in front, and no wall of the world in between. */
  function visible(p, covered = false) {
    if (covered || !p.drawn || p.local || p === W.player) return false;
    const cam = host.drawnCamera();
    const chest = { x: p.position.x, y: p.position.y + heightOf(p) * 0.6, z: p.position.z };
    const v = project(cam, chest, (globalThis.innerWidth || 16) / (globalThis.innerHeight || 9));
    if (!v || Math.abs(v.x) > 0.97 || Math.abs(v.y) > 0.97) return false;
    return host.clearLine({ x: cam.x, y: cam.y, z: cam.z }, chest);
  }

  /** Nameplates over everyone this copy draws: {id, text, color, x, y (screen px), visible}. */
  function plates(covered = false) {
    const cam = host.drawnCamera(), w = globalThis.innerWidth || 1, h = globalThis.innerHeight || 1, out = [];
    for (const p of map.values()) {
      // (a viewer sees from the eyes of the one it follows: no plate of theirs)
      if (p.local || !p.drawn || p === W.player) continue;
      const head = { x: p.position.x, y: p.position.y + heightOf(p) + 0.3, z: p.position.z };
      const v = project(cam, head, w / h);
      const on = !!v && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05 && !covered && host.clearLine({ x: cam.x, y: cam.y, z: cam.z }, head);
      out.push({ id: p.id, text: p.name, color: p.color, x: v ? (v.x * 0.5 + 0.5) * w : -999, y: v ? (-v.y * 0.5 + 0.5) * h : -999, visible: on });
    }
    return out;
  }

  /** What this copy draws each player in (window.__game.looks()): the Wear the core holds, read back. */
  function drawnLook(p) {
    const w = host.wearOf(nidOf(p));
    if (!w) return null;
    const slot = slotOf(p);
    return { body: A.has(slot) ? A.file(slot) : null, slot, tint: loadoutTint(p), bodyTint: bodyColor(p), material: w.color, mix: wearCfg?.tintMix ?? 0.9, visible: !w.hidden && !!p.drawn,
      held: w.held < 255 ? (ctx.tables?.weapons?.[w.held]?.id ?? w.held) : null, renderer: p.drawn && host.drawsBodies() ? 'skinned' : 'none' };
  }

  const api = {
    add, remove, place, fromCore, visible, plates, drawnLook, nid: id => { const p = map.get(id); return p ? nidOf(p) : undefined; },
    byNid: n => [...map.values()].find(p => !p.ghost && nidOf(p) === n) ?? null,
    /** A viewer (wave 4): the player it looks through, once the core holds them; null on any other copy. */
    watched,
    role, bodies: () => ({ ready: bodies.ready, failed: bodies.failed, canDraw: canDraw(), skinned: host.drawsBodies(), seats: [...bodies.seats.keys()] }),
    /** Down and revive as this copy shows it (gf/forge/down.js): the markers, the prompt, the rings. */
    down: () => down?.observe() ?? null,
    downLayer: () => downLayer(),
    /** The body slot a player is drawn as (their seat's hunter). */
    bodySlot: p => slotOf(p),
    updateLooks() {},
    list: () => [...map.values()].filter(p => !p.ghost).sort(bySeat),
    get: id => map.get(id) ?? null,
    others: () => api.list().filter(p => !p.local),
    owned: () => api.list().filter(p => p.owned),
    humans: () => api.list().filter(p => !p.isBot),
    bots: () => api.list().filter(p => p.isBot),
    get size() { return map.size; },
  };
  return api;
}
