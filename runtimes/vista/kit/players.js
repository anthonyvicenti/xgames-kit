// gf-vista's other players (research/super-scenic/PLAN.md §5 wave 1: "a second player through gf/mp: each sees the
// other where they really are"). The game's side of a live round for the vista core, on the shared kit's net.js
// (research/multiplayer/party/LIVE_HANDBOOK.md):
//   - sends this copy's walker (position at the feet, yaw, pitch, mode; on the boat, the boat's pose too) every frame
//     through net.pose (the kit sends 15 a second);
//   - draws every other player as a character in the core's own scene, from net.peers() (the kit interpolates 130 ms
//     behind), smoothed again per frame so a late sample never makes a body jump;
//   - names each one with a nameplate in their colour (the shared HUD's, players.plates()), and says honestly whether
//     they are in this player's view;
//   - sends the camera this copy's core drew (`cam`: the eye and where it looks) with the pose, so a stream's viewer
//     looks out of the streamer's eyes on foot, swimming and on the boat (players.view(id); watch then play, kit/watch.js).
//
//   import { createPlayers } from './gf/vista/players.js';
//   const players = createPlayers(vista, net, { makeBody, follow });
//       follow() → the id a stream's viewer looks through (net.watch.follow): their body and nameplate are not drawn
//       makeBody(app, peer) → body, or a Promise of one (the stand-in shows until it resolves; a failure keeps it):
//       body = {group, update(dt), setTransform(pos, yaw), play?(clip, {speed}), rate?(r), clips?, speed?(clip), dispose?()}
//       kit/humanoid.js loadHumanoid(app, {body, clips, add: false}) is one (gf-humanoid-1 clip names: idle, walk, run,
//       sprint); a body without a clip gets the nearest it has (swim → walk, tread and helm → idle)
//   vista.players = players;                                   // observe.js lists players.list() in snapshot().players
//   every frame: players.update(dt) before app.frame(dt), players.after() after it (plates and sight use the drawn camera)
//
// Poses carry the core's walker yaw (core/src/player/Player.js: forward = (-sin yaw, 0, -cos yaw)). A body's
// setTransform(pos, yaw) takes the body's yaw instead, 0 facing +Z (kit/humanoid.js's convention): walker yaw + π.
// Alone (net.active false) nothing is sent and nobody is drawn.
import { Group, Mesh, Vector3 } from '../core/src/engine/index.js';
import { prepare, mergePrepared, cylinder, sphere, roundedBox, rod, mat4 } from '../core/src/world/boat/GeoKit.js';
import { createPropMaterial, PAT } from '../core/src/game/GameMaterials.js';
import { cameraPose, viewOf } from './watch.js';

const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const hexInt = c => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c ?? '')); return m ? parseInt(m[1], 16) : 0x4f7cff; };
const SWIM_DROP = 1.45;          // a swimmer's pose is their float point (eyes 0.16 m above it): the body hangs below
// a nameplate's foot stands just over the head of a 1.75 m body (1.92 m): the kit's plate sits on that point, so up
// close (a friend 1.5 m ahead) it stays over the head instead of floating off the top of the view (check 34's bound)
const PLATE_AT = 1.92;

let sharedMaterial = null;
const material = () => (sharedMaterial ??= createPropMaterial('gfFriend'));

/**
 * The stand-in body: a ~1.75 m figure from the core's own GeoKit and prop material (the way core/src/game/Vendor.js
 * builds its trader), in the player's colour, with legs and arms that swing when they walk. Used until a
 * gf-humanoid-1 body (kit/humanoid.js) is passed as makeBody. Faces local +Z.
 */
export function standInBody(app, peer = {}) {
  const SHIRT = { color: hexInt(peer.color), rough: 0.85, pattern: PAT.cloth };
  const TROUSERS = { color: 0x2c3440, rough: 0.9, pattern: PAT.cloth };
  const SKIN = { color: 0xb07a58, rough: 0.55, pattern: PAT.skin };
  const BOOTS = { color: 0x2a2420, rough: 0.6 };
  const CAP = { color: hexInt(peer.color), rough: 0.8, pattern: PAT.cloth };
  const V = (x, y, z) => new Vector3(x, y, z);
  const part = list => { const m = new Mesh(mergePrepared(list), material()); m.castShadow = true; return m; };

  const group = new Group();
  group.name = 'Friend:' + (peer.name ?? peer.id ?? '?');
  const body = new Group();          // bobs and leans; limbs hang from it
  group.add(body);
  const P = [], add = (g, o) => P.push(prepare(g, o));
  add(roundedBox(0.4, 0.54, 0.24, 0.08, 3), { ...SHIRT, matrix: mat4(0, 1.13, 0) });          // torso
  add(roundedBox(0.36, 0.16, 0.22, 0.06, 2), { ...TROUSERS, matrix: mat4(0, 0.86, 0) });       // hips
  add(cylinder(0.055, 0.06, 0.1, 10), { ...SKIN, matrix: mat4(0, 1.44, 0.01) });               // neck
  add(sphere(0.11, 14, 10), { ...SKIN, matrix: mat4(0, 1.58, 0.02, 0, 0, 0, 1, 1.12, 1.02) }); // head
  add(sphere(0.02, 6, 5), { ...SKIN, matrix: mat4(0, 1.57, 0.135, 0, 0, 0, 1, 1.4, 1) });      // nose
  for (const s of [-1, 1]) add(sphere(0.013, 6, 4), { color: 0x14100e, rough: 0.2, matrix: mat4(s * 0.04, 1.61, 0.115) });
  add(sphere(0.118, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), { ...CAP, matrix: mat4(0, 1.6, 0.015) });   // cap crown
  add(cylinder(0.11, 0.11, 0.012, 16, 1, false, -Math.PI * 0.5, Math.PI), { ...CAP, matrix: mat4(0, 1.6, 0.1, 0, 0, 0, 1, 1, 1.1) });   // peak
  body.add(part(P));

  const limb = (pivot, list) => { const g = new Group(); g.position.copy(pivot); g.add(part(list)); body.add(g); return g; };
  const legs = [-1, 1].map(s => limb(V(s * 0.1, 0.86, 0), [
    prepare(cylinder(0.085, 0.072, 0.5, 10), { ...TROUSERS, matrix: mat4(0, -0.26, 0) }),
    prepare(cylinder(0.072, 0.066, 0.3, 10), { ...BOOTS, matrix: mat4(0, -0.66, 0.01) }),
    prepare(roundedBox(0.11, 0.08, 0.24, 0.03, 2), { ...BOOTS, matrix: mat4(0, -0.82, 0.05) }),
  ]));
  const arms = [-1, 1].map(s => limb(V(s * 0.24, 1.33, 0), [
    prepare(rod(V(0, 0, 0), V(s * 0.02, -0.3, 0), 0.055, 8, 0.05), SHIRT),
    prepare(rod(V(s * 0.02, -0.3, 0), V(s * 0.01, -0.56, 0.04), 0.045, 8, 0.04), SKIN),
    prepare(sphere(0.045, 8, 6), { ...SKIN, matrix: mat4(s * 0.01, -0.6, 0.05) }),
  ]));

  let clip = 'idle', phase = Math.random() * 6, t = 0, speed = 0;
  const last = new Vector3(), cur = new Vector3();
  let has = false;
  return {
    group, kind: 'stand-in',
    play(c) { clip = c; },
    setTransform(pos, yaw) {
      cur.set(pos.x, pos.y, pos.z);
      group.position.copy(cur);
      group.rotation.y = yaw;
    },
    update(dt) {
      t += dt;
      if (has && dt > 0) speed = speed * 0.8 + 0.2 * Math.hypot(cur.x - last.x, cur.z - last.z) / dt;
      last.copy(cur); has = true;
      const moving = clip === 'walk' || clip === 'run' || clip === 'sprint' || clip === 'swim';
      const k = moving ? Math.min(1, speed / 3) : 0;
      phase += dt * (clip === 'run' || clip === 'sprint' ? 9.5 : clip === 'swim' ? 3 : 6.5) * Math.max(0.35, Math.min(1.6, speed / 2.5));
      const sw = Math.sin(phase) * (clip === 'run' || clip === 'sprint' ? 0.75 : 0.5) * (clip === 'swim' ? 0.6 : k);
      legs[0].rotation.x = sw; legs[1].rotation.x = -sw;
      arms[0].rotation.x = -sw * 0.8; arms[1].rotation.x = sw * 0.8;
      arms[0].rotation.z = -0.06; arms[1].rotation.z = 0.06;
      body.position.y = moving ? Math.abs(Math.cos(phase)) * 0.035 * k : Math.sin(t * 1.7) * 0.004;
      body.rotation.x = clip === 'run' ? 0.12 : clip === 'walk' ? 0.04 * k : 0;
      if (clip === 'helm') { arms[0].rotation.x = arms[1].rotation.x = -0.9; }
    },
    dispose() { group.parent?.remove(group); },
  };
}

// which clip a friend's body plays, from its mode and how fast it is drawn moving (with some hysteresis)
const GAITS = [['idle', 0], ['walk', 0.3], ['run', 2.0], ['sprint', 4.8]];
function gaitOf(prev, v) {
  let i = Math.max(0, GAITS.findIndex(g => g[0] === prev));
  while (i < GAITS.length - 1 && v > GAITS[i + 1][1] + 0.15) i++;
  while (i > 0 && v < GAITS[i][1] - 0.15) i--;
  return GAITS[i][0];
}
const FALLBACK = { swim: ['swim', 'walk'], tread: ['tread', 'idle'], helm: ['helm', 'idle'], sprint: ['sprint', 'run'], run: ['run', 'walk'] };

/**
 * createPlayers(vista, net, { makeBody, tags, follow }) → players
 *   players.update(dt)   before the core's frame: send this copy's pose, move every friend's body
 *   players.after()      after it: nameplates and sight, from the camera that was just drawn
 *   players.list()       [{id, name, color, x, y, z, yaw, mode, boat?}]: where this copy DRAWS each friend (feet)
 *   players.plates(covered)  the shared HUD's nameplates (ui.update's `plates`): {id, text, color, x, y, visible}
 *   players.view(id)     a friend's camera as their copy drew it ({x, y, z, yaw, pitch}; kit/watch.js), or null
 *   players.net(extra)   the snapshot().net block the multiplayer gate reads (LIVE_HANDBOOK "What the gate reads")
 *   players.pose()       what this copy sends
 *   players.body(id)     a friend's body ({group, ...}); players.tags(on) shows or hides the nameplates
 *   players.project(id)  where the friend's body is on this screen: {front, onScreen, rect: {x0,y0,x1,y1} in CSS px}
 */
export function createPlayers(vista, net, { makeBody = standInBody, tags = true, follow = () => null } = {}) {
  const { app } = vista;
  const scene = app.scene, cam = app.camera;
  const friends = new Map();   // id → {body, pos, yaw, mode, clip, name, color, plate, onScreen, state}
  let tagsOn = tags, posed = null;

  function pose() {
    const p = app.player, b = app.boatCtl;
    const moving = p.velocity ? Math.hypot(p.velocity.x, p.velocity.z) : 0;
    const mode = p.mode;
    const anim = mode === 'boat' ? 'helm' : mode === 'swim' ? (moving > 0.2 ? 'swim' : 'tread') : moving > 4.2 ? 'run' : moving > 0.3 ? 'walk' : 'idle';
    const out = { x: r2(p.position.x), y: r2(p.position.y), z: r2(p.position.z), yaw: r3(wrap(p.yaw ?? 0)), pitch: r3(p.pitch ?? 0), mode, anim };
    if (mode === 'boat' || mode === 'deck') out.b = { x: r2(b.position.x), y: r2(b.position.y), z: r2(b.position.z), yaw: r3(wrap(b.getYaw?.() ?? 0)) };
    // the camera the core drew last frame (the walker's eyes, the swimmer's, the helm's chase view): a viewer's eyes
    if (!app.freeCam) out.cam = cameraPose(cam);
    return out;
  }

  function friendOf(peer) {
    let f = friends.get(peer.id);
    if (f && f.color !== peer.color) { scene.remove(f.body.group); friends.delete(peer.id); f = null; }   // a seat changed hands
    if (f) return f;
    let made = null;
    try { made = makeBody(app, peer); } catch (e) { console.warn('gf-vista players: makeBody failed, using the stand-in', e); }
    const body = made && typeof made.then !== 'function' ? made : standInBody(app, peer);
    if (!body.group.parent) scene.add(body.group);
    f = { id: peer.id, body, pos: null, yaw: 0, mode: 'walk', gait: 'idle', clip: null, v: 0, name: peer.name, color: peer.color, plate: null, onScreen: false, front: false, state: null, standIn: body !== made };
    friends.set(peer.id, f);
    if (made && typeof made.then === 'function') {
      const fr = f;
      made.then(b => {
        if (friends.get(fr.id) !== fr) { b.dispose?.(); return; }      // gone meanwhile
        scene.remove(fr.body.group); fr.body.dispose?.();
        fr.body = b; fr.standIn = false; fr.clip = null;
        if (fr.eyes) b.group.visible = false;   // a viewer looks through these eyes
        if (!b.group.parent) scene.add(b.group);
      }).catch(e => console.warn('gf-vista players: the body did not load, keeping the stand-in', e));
    }
    return f;
  }

  function update(dt) {
    dt = Math.max(0, Math.min(0.1, dt || 0));
    if (!net.active) return;
    if (!net.watching) { posed = pose(); net.pose(posed); }
    const seen = new Set(), followed = net.watching ? follow() : null;
    for (const peer of net.peers()) {
      const s = peer.state;
      if (!s || !Number.isFinite(s.x)) continue;
      seen.add(peer.id);
      const f = friendOf(peer);
      f.name = peer.name; f.state = s;
      // a viewer looks out of the streamer's eyes: their own body is not in that view (it was, from inside)
      const eyes = peer.id === followed;
      if (eyes !== !!f.eyes) { f.eyes = eyes; f.body.group.visible = !eyes; }
      const target = { x: s.x, y: s.y, z: s.z };
      // smoothing on top of the kit's interpolation: critically damped toward the interpolated pose; a jump (a
      // respawn, boarding the boat across the pier) snaps
      if (!f.pos || Math.hypot(target.x - f.pos.x, target.y - f.pos.y, target.z - f.pos.z) > 6) { f.pos = { ...target }; f.yaw = s.yaw ?? 0; }
      else {
        const k = 1 - Math.exp(-dt * 22);
        f.pos.x += (target.x - f.pos.x) * k; f.pos.y += (target.y - f.pos.y) * k; f.pos.z += (target.z - f.pos.z) * k;
        f.yaw += wrap((s.yaw ?? 0) - f.yaw) * (1 - Math.exp(-dt * 16));
      }
      f.mode = typeof s.mode === 'string' ? s.mode : f.mode;
      // how fast this copy draws the friend moving (horizontal), smoothed: the clip and its rate follow it
      if (f.last && dt > 0) f.v += (Math.hypot(f.pos.x - f.last.x, f.pos.z - f.last.z) / dt - f.v) * (1 - Math.exp(-dt * 6));
      f.last = { x: f.pos.x, z: f.pos.z };
      f.gait = gaitOf(f.gait, f.v);
      const want = f.mode === 'boat' ? 'helm' : f.mode === 'swim' ? (f.v > 0.25 ? 'swim' : 'tread') : f.gait;
      const have = f.body.clips;
      const clip = (FALLBACK[want] ?? [want]).find(c => !have || have.includes(c)) ?? 'idle';
      const base = f.body.speed?.(clip) || 0;
      const rate = base > 0 ? Math.max(0.6, Math.min(1.6, f.v / base)) : 1;
      if (clip !== f.clip) { f.clip = clip; try { f.body.play?.(clip, { speed: rate }); } catch (e) { console.warn(e); } }
      else f.body.rate?.(rate);
      const y = f.pos.y - (f.mode === 'swim' ? SWIM_DROP : 0);
      f.body.setTransform({ x: f.pos.x, y, z: f.pos.z }, f.yaw + Math.PI);
      f.body.update(dt);
    }
    for (const [id, f] of friends) if (!seen.has(id)) {
      // gone from the room, or no pose for 4 s (the kit's stale limit): take the body away
      if (f.body.dispose) f.body.dispose(); else scene.remove(f.body.group);
      friends.delete(id);
    }
  }

  const _v = new Vector3();
  // camera space → CSS pixels; null behind the camera
  function toScreen(x, y, z) {
    _v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
    if (_v.z > -cam.near) return null;
    _v.applyMatrix4(cam.projectionMatrix);
    const w = innerWidth, h = innerHeight;
    return { x: (_v.x * 0.5 + 0.5) * w, y: (0.5 - _v.y * 0.5) * h };
  }
  // the terrain between the camera and a point (the island's hills, the dunes); props and the pier are not tested
  function terrainBlocks(x, y, z) {
    const c = cam.position, td = app.terrainData;
    if (!td?.heightAt) return false;
    for (let i = 1; i < 16; i++) {
      const t = i / 16, px = c.x + (x - c.x) * t, py = c.y + (y - c.y) * t, pz = c.z + (z - c.z) * t;
      if (td.heightAt(px, pz) > py + 0.05) return true;
    }
    return false;
  }
  function project(id) {
    const f = friends.get(id);
    if (!f?.pos) return null;
    const base = f.pos.y - (f.mode === 'swim' ? SWIM_DROP : 0);
    const pts = [];
    for (const dy of [0, 0.9, 1.78]) for (const [dx, dz] of [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) pts.push(toScreen(f.pos.x + dx, base + dy, f.pos.z + dz));
    const ok = pts.filter(Boolean);
    if (ok.length < pts.length) return { front: false, onScreen: false, rect: null };
    const xs = ok.map(p => p.x), ys = ok.map(p => p.y);
    const rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    const inside = rect.x1 > 0 && rect.x0 < innerWidth && rect.y1 > 0 && rect.y0 < innerHeight;
    const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2;
    const centreIn = cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight;
    const dist = Math.hypot(f.pos.x - cam.position.x, base + 1 - cam.position.y, f.pos.z - cam.position.z);
    // in front, its middle inside the view, not behind a hill, and near enough to be more than a few pixels
    const onScreen = inside && centreIn && dist < 400 && !terrainBlocks(f.pos.x, base + 1.2, f.pos.z) && (rect.y1 - rect.y0) > 6;
    return { front: true, onScreen, rect, dist: r2(dist) };
  }

  function after() {
    if (!friends.size) return;
    cam.updateMatrixWorld();
    for (const f of friends.values()) {
      const pr = project(f.id);
      f.onScreen = !!pr?.onScreen; f.front = !!pr?.front;
      // the nameplate's point on this screen: over the head, while the body is drawn and in view
      const head = f.pos && f.body.group.visible && !f.eyes && tagsOn && f.onScreen ? toScreen(f.pos.x, f.pos.y - (f.mode === 'swim' ? SWIM_DROP : 0) + PLATE_AT, f.pos.z) : null;
      f.plate = head ? { x: r2(head.x), y: r2(head.y) } : null;
    }
  }
  /** The shared HUD's nameplates (kit/ui/ui.js update's `plates`), one a friend; none while something covers the game. */
  function plates(covered = false) {
    return [...friends.values()].map(f => ({ id: f.id, text: f.name ?? f.id, color: f.color ?? '#4f7cff', x: f.plate?.x ?? 0, y: f.plate?.y ?? 0, visible: !covered && !!f.plate }));
  }

  function list() {
    return [...friends.values()].filter(f => f.pos).map(f => {
      const o = { id: f.id, name: f.name, color: f.color, x: r3(f.pos.x), y: r3(f.pos.y), z: r3(f.pos.z), yaw: r3(wrap(f.yaw)), mode: f.mode, clip: f.clip, body: f.standIn ? 'stand-in' : (f.body.kind ?? 'custom'), onScreen: f.onScreen };
      if (f.state?.b) o.boat = { x: r2(f.state.b.x), y: r2(f.state.b.y), z: r2(f.state.b.z), yaw: r3(f.state.b.yaw) };
      return o;
    });
  }

  return {
    update, after, list, plates, pose: () => posed ?? pose(), project,
    body: id => friends.get(id)?.body ?? null,
    /** A friend's camera as their own copy drew it, at the time this copy draws them (kit/watch.js viewOf). */
    view: id => { const f = friends.get(id); return f?.state ? viewOf(f.state) : null; },
    friends,
    tags(on) { tagsOn = !!on; if (!on) for (const f of friends.values()) f.plate = null; },
    /** snapshot().net for the gate. extra: {clock, shared} from the game (the host-owned world) */
    net(extra = {}) {
      if (!net.active) return null;
      const p = app.player.position;
      return {
        you: net.you?.id ?? null, host: net.host, started: net.started, over: net.over,
        me: { x: r3(p.x), y: r3(p.y), z: r3(p.z) },
        peers: net.peers().map(peer => { const f = friends.get(peer.id); return { id: peer.id, name: peer.name, x: f?.pos ? r3(f.pos.x) : null, y: f?.pos ? r3(f.pos.y) : null, z: f?.pos ? r3(f.pos.z) : null, onScreen: !!f?.onScreen }; }),
        clock: extra.clock ?? null, shared: extra.shared ?? '-',
      };
    },
    dispose() { for (const f of friends.values()) { if (f.body.dispose) f.body.dispose(); else scene.remove(f.body.group); } friends.clear(); },
  };
}

/**
 * The shared session's players for a vista game (gf/three/net/session.js createPlayers; CONTRACT §8 vista): who is in
 * the round, their names, colours and scores, and where each one is, for the HUD, the results and the multiplayer gate.
 * The bodies are this file's (createPlayers above, `friends`): it sends this copy's pose and draws everyone else where
 * they really are, so a session player here has no controller (the session sends nothing for it) and is never drawn by
 * the session. The local player is the core's walker (its feet each frame); a friend is where `friends` draws them.
 *
 *   const players = sessionPlayers(ctx, friends, { vista, placeLocal })
 *     placeLocal(seat, pos?, yaw?) puts this copy's walker at its start place, or at pos (the boot's)
 *   players.sync()   once a frame, after the core's frame and friends.after(): positions, drawn, on screen
 */
export function sessionPlayers(ctx, friends, { vista, placeLocal = () => {} } = {}) {
  const map = new Map();
  const vec = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } });
  const idle = () => Object.fromEntries(['primary', 'secondary', 'interact', 'jump'].map(a => [a, { down: false, pressed: false, released: false }]));
  const bySeat = (a, b) => a.seat - b.seat || String(a.id).localeCompare(String(b.id));
  async function add(info) {
    if (map.has(info.id)) return map.get(info.id);
    const p = {
      id: info.id, name: info.name ?? info.id, color: info.color ?? '#ffffff', seat: info.seat ?? 0, isBot: false, local: !!info.local, owned: !!info.owned,
      ghost: !!info.ghost, score: 0, alive: true, data: {}, character: null, controller: null, body: null, pose: null, position: vec(), yaw: 0, pitch: 0, anim: 'idle',
      aim: [0, 0, 1], aimDist: null, actions: idle(), input: { x: 0, z: 0 }, bot: null, poseExtra: {}, connected: true, drawn: !!info.local, onScreen: false, mode: 'walk',
      act() {}, knock() { return false; }, push() { return false; },
      teleport(pos, yaw) { if (p.local) placeLocal(p.seat, pos, yaw); },
      get x() { return p.position.x; }, get y() { return p.position.y; }, get z() { return p.position.z; },
    };
    p.role = info.role ?? 'player';
    map.set(p.id, p);
    return p;
  }
  function remove(id) { map.delete(id); ctx.assets?.clearLoadout?.(id); }
  /** A friend's pose as the session hands it in (net.peers() → state): where they are, until `friends` draws them. */
  function place(p, s) {
    if (!p || p.local || !s || !Number.isFinite(s.x)) return;
    if (!friends.friends.get(p.id)?.pos) { p.position.set(s.x, s.y ?? 0, s.z); p.yaw = s.yaw ?? p.yaw; }
    p.mode = typeof s.mode === 'string' ? s.mode : p.mode;
  }
  function sync() {
    const app = vista.app;
    for (const p of map.values()) {
      if (p.local) {
        const w = app.player;
        p.position.set(w.position.x, w.position.y, w.position.z); p.yaw = w.yaw ?? 0; p.pitch = w.pitch ?? 0; p.mode = w.mode; p.drawn = true;
        continue;
      }
      const f = friends.friends.get(p.id);
      if (f?.pos) { p.position.set(f.pos.x, f.pos.y, f.pos.z); p.yaw = f.yaw; p.drawn = true; p.onScreen = !!f.onScreen; p.anim = f.clip ?? 'idle'; }
      else { p.drawn = false; p.onScreen = false; }
    }
  }
  const api = {
    add, remove, place, sync, updateLooks() {}, wantLook() {},
    visible: (p, covered = false) => !covered && !p.local && !!friends.friends.get(p.id)?.onScreen,
    list: () => [...map.values()].filter(p => !p.ghost).sort(bySeat),
    get: id => map.get(id) ?? null,
    others: () => api.list().filter(p => !p.local),
    owned: () => [...map.values()].filter(p => p.owned).sort(bySeat),
    humans: () => api.list().filter(p => !p.isBot),
    bots: () => [],
    get size() { return map.size; },
  };
  return api;
}
