// gf-three net: the players of a round (ctx.players), each drawn as a character with a nameplate and a ring in their
// colour. Players this copy owns (the local player; bots on the host) have a controller and are simulated here; every
// other player is placed from their pose (a friend's from net.peers(), a bot's from the host's world).
//
// A player: { id, name, color, seat, isBot, local, owned, score, alive, data: {}, character, controller, body,
//             pose, position (feet, THREE.Vector3), yaw, anim, aim [x, y, z], aimDist (m to the crosshair point, or
//             null: kit/core/aim.js), actions, input, bot, poseExtra }
//   p.act(word, seconds)        hold an anim word (a throw, a cheer); the pose carries it to everyone
//   p.knock(impulse, seconds, {out, force})   knock this player over from any copy: applied here when owned, else sent
//                               to its owner. With fair play on (ctx.fair, CONTRACT §6c) the host refuses a knock on a
//                               player who is down or protected (→ false), and a knock lasts fair.downSeconds in all
//                               (ragdoll and get-up), whatever `seconds` says; {out: true} (taken out, health.down) keeps
//                               the player down for `seconds` until revived; {force: true} skips the refusal.
//   p.push(impulse)             a shove that never knocks over (fair play F6): the same routing
//   p.teleport({x, y, z}, yaw)  the same routing
// Player looks (CONTRACT §6e): each player is drawn with their own loadout (kit/net/looks.js brings everyone's to every
// copy); when one arrives or changes, updateLooks() (every frame) puts it on: the body tint at once, a hat once it loads,
// a new body once the player is on their feet. Bots wear the game's defaults.
import * as THREE from 'three';
import { idleActions } from '../core/input.js';
import { createController, driveCharacter } from '../controller/controller.js';
import { spawnOf, fixedRay } from '../core/util.js';
import { DOWN_WORDS } from '../core/fair-logic.js';

const bySeat = (a, b) => a.seat - b.seat || String(a.id).localeCompare(String(b.id));

export function createPlayers(ctx, { spawnCharacter, characterFor, routeToOwner }) {
  const map = new Map();
  const v = new THREE.Vector3(), chest = new THREE.Vector3();

  async function add(info) {
    if (map.has(info.id)) return map.get(info.id);
    const p = {
      id: info.id, name: info.name ?? info.id, color: info.color ?? '#ffffff', seat: info.seat ?? 0, isBot: !!info.isBot, local: !!info.local, owned: !!info.owned,
      ghost: !!info.ghost,            // a live round's viewer (gf-multiplayer 1.6.1): its own player, hidden, in no list or score
      score: 0, alive: true, data: {}, character: null, controller: null, body: null, pose: null, position: new THREE.Vector3(), yaw: 0, anim: 'idle',
      aim: [0, 0, 1], aimDist: null, actions: idleActions(), input: { x: 0, z: 0 }, bot: null, poseExtra: {}, connected: true, drawn: false, onScreen: false,
      _speed: 0, _last: null,
      act(word, seconds = 0.5) { if (p.controller) p.controller.act(word, seconds); },
      knock(impulse, seconds = 0.8, { out = false, force = false } = {}) {
        const plan = ctx.fair ? ctx.fair.knockPlan(p, { out, force }) : { budget: null };
        if (!plan) return false;
        if (p.owned && p.controller) p.controller.knock(impulse, seconds, { budget: plan.budget });
        else routeToOwner(p, 'knock', { i: [impulse.x ?? 0, impulse.y ?? 0, impulse.z ?? 0].map(n => Math.round(n * 100) / 100), s: seconds, ...(out ? { o: 1 } : {}) });
        return true;
      },
      push(impulse) { if (p.owned && p.controller) return p.controller.push(impulse); routeToOwner(p, 'push', { i: [impulse.x ?? 0, impulse.y ?? 0, impulse.z ?? 0].map(n => Math.round(n * 100) / 100) }); return true; },
      teleport(pos, yaw) { if (p.owned && p.controller) p.controller.teleport(pos, yaw); else routeToOwner(p, 'teleport', { p: [pos.x, pos.y ?? 0, pos.z], y: yaw }); },
      get x() { return p.position.x; }, get y() { return p.position.y; }, get z() { return p.position.z; },
    };
    map.set(p.id, p);
    const role = info.role ?? 'player';
    p.role = role;
    const { bodySlot, height } = characterFor(role, p.seat);
    // onState (track C): a ragdoll that gets up somewhere else moves this player's capsule there (owned players only;
    // the others follow their owner's pose)
    const onState = (state, info) => { if (state === 'getup' && p.owned && p.controller && info?.position) p.controller.teleport(info.position, info.yaw ?? p.yaw, { keepCamera: true }); };
    p._onState = onState;
    p.character = await spawnCharacter(ctx, { player: p, bodySlot, tint: p.color, local: p.local, height, plate: null, onState });
    p._lookDirty = true;            // a loadout that arrived while the body loaded is put on in the next frame
    p.character.nameplate?.(p.name, p.color);
    ctx.scene.add(p.character.object3d);
    // a ring on the ground in the player's colour: friends are told apart by it and the nameplate, never by colour alone
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.55, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.8, depthWrite: false }));
    ring.position.y = 0.02; ring.renderOrder = 1; ring.name = 'ring';
    ctx.assets.tag(ring, ctx.assets.has(`character.tint.${role}`) ? `character.tint.${role}` : 'look.palette.players');
    p.character.object3d.add(ring);
    if (p.owned) {
      const spawn = spawnOf(ctx.world, p.seat);
      const C = ctx.config.controller ?? {};
      // the controller is the game's kind's when its parts bring one (a flat game: kit/flat/controller.js), else the kit's own
      p.controller = (ctx.modules?.controller?.createController ?? createController)(ctx, { player: p, character: p.character, camera: p.local ? (ctx.config.camera ?? 'third') : null, speed: C.speed, jump: C.jump, sprint: C.sprint, spawn, settings: C.camera?.[ctx.config.camera ?? 'third'] ?? {} });
      p.body = p.controller.body;
      p.position.copy(p.controller.feet.set(spawn.x, spawn.y, spawn.z));
      p.yaw = spawn.yaw;
      p.character.object3d.position.copy(p.position); p.character.object3d.rotation.y = p.yaw;
    } else p.character.object3d.visible = false;   // until a pose arrives
    return p;
  }

  function remove(id) {
    const p = map.get(id); if (!p) return;
    p.controller?.dispose(); p.character?.dispose?.(); p.character?.object3d.removeFromParent();
    map.delete(id);
    ctx.assets.clearLoadout?.(id);
  }

  // ---- player looks (CONTRACT §6e): a loadout that arrives or changes is put on by every copy, in the next frame ----
  ctx.assets.onLoadout?.(id => { const p = map.get(id); if (p) p._lookDirty = true; });
  const charMod = () => ctx.modules?.character ?? {};
  /** What this player should wear now: { body (file), hat (file or null), tint (their own colour or null) }. */
  function wantLook(p) {
    const role = p.role ?? 'player', A = ctx.assets;
    return {
      body: A.fileFor ? A.fileFor(characterFor(role, p.seat).bodySlot ?? `character.body.${role}`, p) : null,
      hat: charMod().hatFileFor ? charMod().hatFileFor(ctx, role, p) : null,
      tint: A.own?.(`character.tint.${role}`, p) ?? null,
    };
  }
  /** Every frame: put on what changed. A tint changes at once, a hat once it loads, a body once the player is on their
   *  feet (a new character takes the old one's place: the ring, anything held in a socket, the controller). */
  function updateLooks() {
    for (const p of map.values()) {
      if (!p._lookDirty || p._restyling || !p.character?.look) continue;
      const want = wantLook(p), have = p.character.look;
      if (want.body && want.body !== have.body) { if (!p.character.state || p.character.state === 'anim') swapBody(p); continue; }
      p._lookDirty = false;
      if ((want.tint ?? null) !== (have.tint ?? null)) p.character.setLookTint?.(want.tint);
      if ((want.hat ?? null) !== (have.hat ?? null) && charMod().loadHat) {
        p._restyling = true;
        const c = p.character;
        charMod().loadHat(ctx, p.role ?? 'player', p).then(h => { if (p.character === c) c.setHat(h); }).catch(e => console.warn(`gf-three loadout: hat for ${p.id}: ${e.message}`)).finally(() => { p._restyling = false; p._lookDirty = true; });
      }
    }
  }
  async function swapBody(p) {
    p._restyling = true;
    const old = p.character;
    try {
      const { bodySlot, height } = characterFor(p.role ?? 'player', p.seat);
      const nc = await spawnCharacter(ctx, { player: p, bodySlot, tint: old.tint ?? p.color, local: p.local, height, plate: null, onState: p._onState });
      if (!map.has(p.id) || p.character !== old) { nc.dispose?.(); return; }
      nc.nameplate?.(p.name, old.plate?.color ?? p.color);
      nc.object3d.position.copy(old.object3d.position); nc.object3d.rotation.copy(old.object3d.rotation);
      nc.object3d.visible = old.object3d.visible;
      const ring = old.object3d.getObjectByName('ring'); if (ring) nc.object3d.add(ring);
      for (const [name, s] of Object.entries(old.sockets ?? {})) for (const o of [...s.children]) if (o !== old.hat) nc.socket(name).add(o);
      p.controller?.setCharacter?.(nc);
      p.character = nc;
      ctx.scene.add(nc.object3d);
      old.dispose?.(); old.object3d.removeFromParent();
      p._lookDirty = true;            // look again: something may have changed while the new body loaded
    } catch (e) { console.warn(`gf-three loadout: body for ${p.id}: ${e.message}`); p._lookDirty = false; }
    finally { p._restyling = false; }
  }

  /** A player this copy does not own: place it from a pose {x, y, z, yaw, anim, aim}. */
  function place(p, s, dt) {
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.z)) { p.drawn = false; if (p.character) p.character.object3d.visible = false; return; }
    const x = s.x, y = Number.isFinite(s.y) ? s.y : 0, z = s.z;
    const jump = p._last ? Math.hypot(x - p._last.x, z - p._last.z) : 0;
    if (p._last && dt > 0) { const sp = jump / dt; p._speed += (Math.min(sp, 12) - p._speed) * Math.min(1, dt * 10); }
    p._last = { x, z };
    p.position.set(x, y, z); p.yaw = s.yaw ?? p.yaw; p.anim = typeof s.anim === 'string' ? s.anim : 'idle';
    if (Array.isArray(s.aim)) p.aim = s.aim;
    p.aimDist = Number.isFinite(s.ad) ? s.ad : null;      // the owner's crosshair point (kit/core/aim.js aimTarget)
    p.pose = s; p.drawn = true;
    const c = p.character; if (!c) return;
    c.object3d.visible = true;
    c.object3d.position.set(x, y, z); c.object3d.rotation.y = p.yaw;
    // a respawn far away while this copy still shows the old ragdoll: stand up at the new place at once
    if (jump > 3 && c.state && c.state !== 'anim' && !DOWN_WORDS.has(p.anim)) c.recover?.();
    driveCharacter(c, p.anim, p.anim === 'idle' ? 0 : Math.max(p._speed, p.anim === 'run' ? 4 : p.anim === 'walk' ? 1.5 : 0), p.anim !== 'jump' && p.anim !== 'fall', { upSeconds: ctx.fair?.on ? ctx.fair.split.getup : null });
    if (Array.isArray(s.aim)) c.setAim?.(Math.max(-1, Math.min(1, s.aim[1] * 1.6)));
    c.update?.(dt);
  }

  /** Could this player see `p` right now: the chest inside the view and nothing of the world in between. */
  function visible(p, covered = false) {
    if (covered || !p.drawn || !p.character) return false;
    const cam = ctx.camera; const h = p.character.height ?? 1.7;
    chest.set(p.position.x, p.position.y + h * 0.6, p.position.z);
    v.copy(chest).project(cam);
    if (!(v.z > -1 && v.z < 1 && Math.abs(v.x) < 0.97 && Math.abs(v.y) < 0.97)) return false;
    // an orthographic camera sees along parallel lines: the line to the chest is the view's own direction, not one from the camera's middle
    const from = cam.isOrthographicCamera ? cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(-40).add(chest) : cam.position, dir = { x: chest.x - from.x, y: chest.y - from.y, z: chest.z - from.z }, d = Math.hypot(dir.x, dir.y, dir.z);
    const hit = fixedRay(ctx, from, dir, d);
    return !(hit !== null && hit < d - 0.4);
  }

  const api = {
    add, remove, place, visible, updateLooks, wantLook,
    list: () => [...map.values()].filter(p => !p.ghost).sort(bySeat),
    get: id => map.get(id) ?? null,
    others: () => api.list().filter(p => !p.local),
    owned: () => [...map.values()].filter(p => p.owned).sort(bySeat),     // a viewer's ghost too: its body still steps
    humans: () => api.list().filter(p => !p.isBot),
    bots: () => api.list().filter(p => p.isBot),
    get size() { return map.size; },
  };
  return api;
}
