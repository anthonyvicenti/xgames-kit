// gf-three controller (CONTRACT §4.5): a player's body on the Rapier capsule, its character placed on it, and for the
// local player the camera rig and the aim.
//
//   const c = createController(ctx, { player, character, camera: 'third' | 'first' | 'top' | 'follow' | null, speed, jump });
//   c.update(dt)       every frame: places the character (interpolated between physics steps), animates it, moves the camera
//   c.pose()           {x, y, z, yaw, anim, aim, extra} for the net
//   c.teleport(p, yaw) c.knock(impulse, seconds, {budget})  c.push(impulse)  c.enabled = false (input ignored; physics continues)
//   c.aimAt(point|null) hold the aim on a world point (QA, fixtures, cutscenes); null gives it back to the crosshair
//   c.setCharacter(ch) drive another character (a player's own body arrived: CONTRACT §6e)
//   Aim (kit/core/aim.js): the local player with a third or first camera aims at the point under the crosshair, with
//   the 'follow' camera (CONTRACT §8) at the point under the mouse cursor (the input's cursor mode: no pointer lock):
//   player.aim (a unit direction from feet + AIM_HEIGHT) and player.aimDist (the distance to that point; the pose's
//   `ad`). While primary or secondary is held in a game with an aimed mechanic (ctx.aimed), the body turns to the aim.
//   A knock with a budget (fair play F1, ctx.fair.split = {total, ragdoll, getup}) is out of control for budget.total
//   seconds, ragdoll and get-up included: the stun lasts the ragdoll part, then the character gets up at once in the
//   get-up part (the clip played faster). Without one, the old way: stun for `seconds`, get up once the ragdoll settles.
//
// The kit steps every controller at a fixed 60 Hz (fixedStep, then the world, then postStep) and calls update(dt)
// once per frame. Who drives the body: the local player from kit/core/input.js (camera-relative), a bot from its
// brain (player.input, world-space), both through the same `player.input` and `player.actions`.
import * as THREE from 'three';
import { createCapsule, capsuleConfig } from './capsule.mjs';
import { createCameraRig } from './camera-rig.js';
import { crosshairPoint, aimFrom, AIM_HEIGHT } from '../core/aim.js';

const r2 = v => Math.round(v * 100) / 100;

export function createController(ctx, { player, character = null, camera = null, speed = null, jump = null, sprint = null, spawn = { x: 0, y: 0, z: 0, yaw: 0 }, settings = {} } = {}) {
  const cfg = capsuleConfig({ move: { ...(speed ? { runSpeed: speed } : {}), ...(sprint ? { sprintSpeed: sprint } : {}) }, jump: jump ? { velocity: jump } : {} });
  const cap = createCapsule(ctx.RAPIER, ctx.physics, cfg, { x: spawn.x, y: spawn.y + 0, z: spawn.z, yaw: spawn.yaw ?? 0 }, { userData: { player: player.id } });
  cap.reset({ x: spawn.x, y: spawn.y + cap.feetOffset, z: spawn.z }, spawn.yaw ?? 0);
  const rig = camera ? createCameraRig({ camera: ctx.camera, mode: camera, physics: { RAPIER: ctx.RAPIER, world: ctx.physics }, exclude: cap.collider, settings, yaw: spawn.yaw ?? 0, pointer: () => ctx.input?.pointer, wheel: () => ctx.input?.wheel ?? 0, free: () => !!ctx.input?.aimFree }) : null;
  if (camera === 'follow' && ctx.input) ctx.input.cursorMode = true;
  if (camera === 'orbit' && ctx.input) ctx.input.cursorMode = 'drag';
  // first person in a world (CONTRACT §9): the lock where the page allows it, the 'drag' way where a post refuses it
  const firstWorld = camera === 'first' && ctx.config?.round?.mode === 'world';
  if (firstWorld && ctx.input) ctx.input.cursorMode = 'look';
  const prev = new THREE.Vector3(), curr = new THREE.Vector3(), drawn = new THREE.Vector3();
  const snap = () => { const t = cap.body.translation(); prev.set(t.x, t.y, t.z); curr.copy(prev); };
  snap();
  let jumpPresses = 0, landT = 9, animOverride = null, alpha = 0, forced = null, aimFace = null, faceHold = null;
  const c = {
    player, character, rig, capsule: cap, body: cap.body, collider: cap.collider, state: cap.state, enabled: true, anim: 'idle',
    feet: new THREE.Vector3(),

    /** One physics step's input: the kit calls this before world.step(). */
    fixedStep() {
      const inp = player.input ?? {};
      let x = inp.x ?? 0, z = inp.z ?? 0;
      if (rig && player.local) {
        // camera-relative: forward is the camera heading, right is 90° clockwise from it (seen from above)
        const m = ctx.input.move, f = rig.yaw;
        x = Math.sin(f) * m.y - Math.cos(f) * m.x; z = Math.cos(f) * m.y + Math.sin(f) * m.x;
      }
      // a ragdolled or standing-up character holds its capsule still (track C's character.state)
      const down = !!character?.state && character.state !== 'anim';
      // first person: the body turns with the view, so the others see a player face where they look
      const view = rig?.state.mode === 'first' && player.local ? rig.yaw : undefined;
      cap.step({ x, z, sprint: !!inp.sprint || (player.local && ctx.input.sprint), jumpPresses, enabled: c.enabled && player.alive !== false && !down, face: inp.face ?? aimFace ?? view, speed: inp.speed });
      jumpPresses = 0;
    },
    postStep() { prev.copy(curr); const p = cap.post(); curr.set(p.x, p.y, p.z); if (cap.state.landed) landT = 0; },

    /** Every frame: input edges, the character on the body, the camera. alpha: how far between the last two physics steps. */
    update(dt, a = alpha) {
      alpha = a;
      const acts = player.actions;
      if (acts?.jump?.pressed && c.enabled) jumpPresses++;
      drawn.lerpVectors(prev, curr, alpha);
      c.feet.set(drawn.x, drawn.y - cap.feetOffset, drawn.z);
      const s = cap.state;
      landT += dt;
      // the anim word the net carries (and the character plays)
      // knockdown while stunned; then 'down' while the ragdoll settles (the character gets up by itself once told, and
      // every other copy is told by the word leaving 'knockdown'), 'getup' while it stands up, then locomotion
      // (a knock wins over a held act word: every copy must see that this player is down)
      let word;
      const cs = character?.state;
      if (player.alive === false || s.stun > 0) word = 'knockdown';
      else if (cs === 'ragdoll') word = 'down';
      else if (cs === 'getup') word = 'getup';
      else if (animOverride && animOverride.until > ctx.time.now) word = animOverride.word;
      else if (!s.onGround && s.heightAboveGround > 0.3) word = s.vy > 0 ? 'jump' : 'fall';
      else if (landT < 0.15 && s.landSpeed > 6) word = 'land';
      else word = s.speed > 3.6 ? 'run' : s.speed > 0.35 ? 'walk' : 'idle';
      c.anim = word;
      if (character) {
        character.object3d.position.copy(c.feet);
        character.object3d.rotation.y = s.facing;
        driveCharacter(character, word, s.speed, s.onGround, { upSeconds: ctx.fair?.on ? ctx.fair.split.getup : null });
        if (player.aim) character.setAim?.(rig?.state.mode === 'follow' ? 0 : Math.max(-1, Math.min(1, player.aim[1] * 1.6)));
        character.update?.(dt);
      }
      if (rig) {
        if (player.local && c.enabled) rig.look(ctx.input.look.dx, ctx.input.look.dy);
        rig.update(dt, c.feet, { onGround: s.onGround });
        // a wall pulled the orbit camera right up to the head: hide the player's own body rather than look out of it
        if (rig.state.mode === 'orbit' && character?.object3d) { const close = rig.state.current < 0.9; if (close !== !!c._camClose) { c._camClose = close; character.object3d.visible = !close; } }
        // first person: the player's own body is never drawn here (a body that arrives later, a loadout's, included)
        if (rig.state.mode === 'first' && character?.object3d?.visible) character.object3d.visible = false;
        // the aim: the point under the crosshair (or a held point), from the aim origin (kit/core/aim.js)
        const o = { x: c.feet.x, y: c.feet.y + AIM_HEIGHT, z: c.feet.z }, ray = forced ? null : rig.ray?.();
        const P = forced ?? (ray ? crosshairPoint(ctx, ray.from, ray.dir, { self: player, selfVisible: rig.state.mode === 'third' || rig.state.mode === 'orbit', exclude: cap.collider, fromCamera: !!ray.fromCamera }) : null);
        if (P) {
          const a = aimFrom(o, P);
          player.aim = a.aim; player.aimDist = a.dist; player.aimPoint = { x: P.x, y: P.y, z: P.z };
          player.aimOnSelf = !!P.onSelf; player.aimHit = P.hit ?? null;
        } else {
          const aim = rig.aim();
          player.aim = [aim.x, aim.y, aim.z]; player.aimDist = null; player.aimPoint = null; player.aimOnSelf = false;
        }
        // firing in a game with an aimed mechanic: the body turns to where the shot goes
        const fire = acts?.primary?.down || acts?.secondary?.down;
        aimFace = faceHold && faceHold.until > ctx.time.now ? faceHold.yaw : player.local && ctx.aimed && fire && rig.state.mode !== 'top' && c.enabled ? Math.atan2(player.aim[0], player.aim[2]) : null;
      } else if (!player.aim || player.isBot) {
        const f = player.input?.face ?? s.facing;
        player.aim = player.input?.aim ?? [Math.sin(f), 0, Math.cos(f)];
      }
    },

    /** The pose the net sends (CONTRACT §4.6): small, flat, rounded. */
    pose(extra = player.poseExtra) {
      const p = { x: r2(c.feet.x), y: r2(c.feet.y), z: r2(c.feet.z), yaw: r2(cap.state.facing), anim: c.anim };
      if (player.aim) p.aim = player.aim.map(r2);
      if (Number.isFinite(player.aimDist)) p.ad = r2(player.aimDist);      // the aim point = origin + aim * ad (kit/core/aim.js)
      if (extra && Object.keys(extra).length) p.extra = extra;
      return p;
    },
    /** Turn the body to a heading (yaw, radians) for `seconds`: a builder faces the block they place. */
    faceTo(yaw, seconds = 0.5) { if (Number.isFinite(yaw)) faceHold = { yaw, until: ctx.time.now + seconds }; },
    /** Hold the aim on a world point {x, y, z} (QA, fixtures, a cutscene); null gives it back to the crosshair. */
    aimAt(point) { forced = point && Number.isFinite(point.x) ? { x: point.x, y: point.y ?? 0, z: point.z, hit: 'held', onSelf: false } : null; },
    /** Hold an anim word (a throw, a cheer) for `seconds`: the character plays it here and the pose carries it. */
    act(word, seconds = 0.5) { animOverride = { word, until: ctx.time.now + seconds }; character?.play?.(word, { loop: false }); },
    /** Move the body (feet at p). keepCamera: the camera stays where it looks (a get-up, not a respawn). */
    // A teleport that is not a get-up (a respawn, a round reset) stands the character up at once where it lands: a ragdoll
    // left lying elsewhere would otherwise get up there later and pull the body back (onState 'getup').
    teleport(p, yaw, { keepCamera = false } = {}) { cap.reset({ x: p.x, y: (p.y ?? 0) + cap.feetOffset, z: p.z }, yaw); snap(); if (!keepCamera) { character?.recover?.(); animOverride = null; } if (rig && !keepCamera) rig.reset(yaw); },
    // The capsule flies and is stunned; the character ragdolls with the same velocity (world m/s) and stays down until
    // the stun ends (the 'knockdown' word), then gets up where it lies (onState 'getup' → teleport, kit/net/players.js).
    // budget ({total, ragdoll, getup}, fair play F1): the stun is the ragdoll part; the get-up starts at once after it.
    knock(impulse, seconds = 0.8, { budget = null } = {}) {
      animOverride = null;
      if (budget) { cap.knock(impulse, budget.ragdoll); character?.knock?.(impulse, { getUp: false }); return; }
      cap.knock(impulse, seconds); character?.knock?.(impulse, { getUp: false });
    },
    /** A shove (fair play F6: continuous attacks push, never knock over): a velocity and a short slip, still in control. */
    push(impulse, seconds = 0.3) {
      if (cap.state.stun > 0 || (character?.state && character.state !== 'anim')) return false;
      cap.push(impulse, seconds); character?.play?.('hit', { layer: 'upper' });
      return true;
    },
    /** Drive another character from now on (a player's body changed: their loadout, CONTRACT §6e). */
    setCharacter(next) { character = next; c.character = next; },
    dispose() { ctx.physics.removeRigidBody(cap.body); },
  };
  return c;
}

// The state word → the character's animation. Locomotion words drive locomotion(speed, grounded); the others play
// once (or hold, for knockdown) through play(). Shared with remote players (kit/net/players.js).
const LOCO = new Set(['idle', 'walk', 'run']);
const QUIET = new Set(['down']);   // a state word with nothing to play
// opts.upSeconds (fair play F1): when the word leaves 'knockdown', get up at once and take this long doing it.
export function driveCharacter(character, word, speed, grounded, { upSeconds = null } = {}) {
  if (!character) return;
  const last = character.__word;
  if (LOCO.has(word)) { character.locomotion?.(speed, grounded); }
  else if (word === 'jump' || word === 'fall') { character.locomotion?.(speed, false); }
  else if (word !== last && !QUIET.has(word)) {
    if (word === 'knockdown') { if (character.ragdoll) character.ragdoll(true); else character.play?.('knockdown', { loop: false, hold: true }); }
    else character.play?.(word, { loop: false });
  }
  if (last === 'knockdown' && word !== 'knockdown') { if (character.ragdoll) character.ragdoll(false, { upSeconds }); else character.play?.('getup', { loop: false }); }
  character.__word = word;
}
