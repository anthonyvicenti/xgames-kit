// gf-three flat: the controller of a flat (2D) game. It is the kit's own controller (the Rapier capsule, the knock, the
// stun, the anim words, the pose) with its camera rig left out and a flat rig in its place. Nothing of the 3D player is
// rewritten: a 2D player IS the 3D player on a plane, drawn as a picture and seen through an orthographic camera.
//
//   plane 'top'   A/D and W/S move along X and -Z (screen right and screen up); the camera hangs straight above
//   plane 'side'  A/D move along X, Space jumps, S (or Down) drops through a ledge; the body's Z is locked at 0
// The aim is the point under the mouse cursor on the plane (the input's cursor mode: the pointer is never locked).
//
// SIDE-ON RULES (the flat part's own; they are true of no 3D game):
//   gravity     the game's (config/game.json → gravity, default 20), 1.7 times that on the way down (the capsule's)
//   the jump    config/game.json → controller.jump (10.5: it rises 2.7 m, so a body clears 2 cells with room to spare)
//   a ledge     (a tile kind with solid "top") holds a body that comes down onto it, lets one through that is rising or
//               beside it, and lets one drop through while Down is held
//   the camera  a wide screen: `view` metres of height, the player a little below the middle, never past the map's ends.
//               A PHONE HELD UPRIGHT: `portrait` metres across; the player's feet sit 38% up the screen, so the ground
//               fills the part under the thumbs and the sky and the ledges above take the rest. The stage is not shrunk
//               to fit: it scrolls sideways.
import * as THREE from 'three';
import { createController as createBase, driveCharacter } from '../controller/controller.js';
import { GROUPS } from '../core/util.js';
import { ONEWAY } from './world.js';
export { driveCharacter };

const SCRATCH = new THREE.Vector3();
const SOLID = ((GROUPS.PLAYERS << 16) | GROUPS.WORLD | GROUPS.PROPS) >>> 0;          // what a ground probe sees (kit/core/util.js SOLID_QUERY)
const SOLID_AND_LEDGES = ((GROUPS.PLAYERS << 16) | GROUPS.WORLD | GROUPS.PROPS | ONEWAY) >>> 0;
export const FEET_UP_PORTRAIT = 0.38;

/** The flat rig: the members boot, the watch camera and the checks read on `controller.rig`. */
export function createFlatRig(ctx, plane, settings = {}) {
  const camera = ctx.camera, side = plane === 'side';
  const st = { mode: side ? 'side' : 'top', flat: plane, first: true, pivot: new THREE.Vector3(), current: 0, collided: false };
  const C = { sensitivity: 0, smooth: 9, lead: side ? 1.6 : 0, ...settings };
  const aim = new THREE.Vector3(side ? 1 : 0, 0, side ? 0 : 1), from = new THREE.Vector3(), dir = new THREE.Vector3(), target = new THREE.Vector3();
  // a value inside [lo, hi] when the span is wider than the view, its middle when it is not
  const fit = (v, lo, hi, half) => (hi - lo <= half * 2 ? (lo + hi) / 2 : Math.max(lo + half, Math.min(hi - half, v)));
  /** Put the camera over (top) or in front of (side) a point. For the local player and for a viewer's stream. */
  function place(p, dt = 0) {
    const hw = (camera.right - camera.left) / 2, hh = (camera.top - camera.bottom) / 2, V = ctx.world?.view, upright = !!camera.userData.gfUpright;
    if (side) {
      const y = upright ? (p.y ?? 0) + (0.5 - FEET_UP_PORTRAIT) * hh * 2 : (p.y ?? 0) + C.lead;
      target.set(p.x, y, 0);
      if (V) {
        target.x = fit(target.x, V.minX, V.maxX, hw);
        // a wide screen never looks under the ground (1.5 m of it shows); upright, the ground is meant to fill the bottom
        if (!upright) target.y = Math.max(V.minY - 0.5 + hh, target.y);
      }
    } else {
      target.set(p.x, 0, p.z);
      if (V) { target.x = fit(target.x, V.minX, V.maxX, hw); target.z = fit(target.z, V.minZ, V.maxZ, hh); }
    }
    if (st.first || !(dt > 0)) { st.pivot.copy(target); st.first = false; } else st.pivot.lerp(target, 1 - Math.exp(-dt * C.smooth));
    // pixel style: the camera moves in whole screen pixels, so texels never shimmer
    const q = camera.userData.gfTexel || 0, snap = v => (q ? Math.round(v / q) * q : v);
    if (side) { camera.up.set(0, 1, 0); camera.position.set(snap(st.pivot.x), snap(st.pivot.y), 60); camera.lookAt(camera.position.x, camera.position.y, 0); }
    else { camera.up.set(0, 0, -1); camera.position.set(snap(st.pivot.x), 60, snap(st.pivot.z)); camera.lookAt(camera.position.x, 0, camera.position.z); }
    camera.updateMatrixWorld();
  }
  /** The world point under the cursor, on the plane the game is played on; null while the cursor is off the canvas. */
  function pointUnder(pointer, feetY = 0) {
    if (!pointer?.inside) return null;
    SCRATCH.set(pointer.x, pointer.y, 0).unproject(camera);       // orthographic: every ray is parallel to the view
    return side ? { x: SCRATCH.x, y: SCRATCH.y, z: 0 } : { x: SCRATCH.x, y: feetY, z: SCRATCH.z };
  }
  return {
    state: st, settings: C, flat: plane, place, pointUnder,
    look() {},
    update(dt, feet) { place(feet, dt); },
    // movement is never relative to this camera's heading; the value is the heading whose "forward" is up the screen
    get yaw() { return side ? 0 : Math.PI; }, set yaw(v) {},
    get pitch() { return side ? 0 : Math.PI / 2; },
    aim: () => aim,
    /** The ray under the cursor: parallel to the view, from the camera's plane ({from, dir}); null off the canvas. */
    ray: () => {
      const p = ctx.input?.pointer; if (!p?.inside) return null;
      from.set(p.x, p.y, -1).unproject(camera); camera.getWorldDirection(dir);
      return { from, dir, fromCamera: true };
    },
    aimsAtPointer: () => true,
    reset() { st.first = true; },
    get zoom() { return camera.top - camera.bottom; },
    setAim(v) { aim.copy(v); },
  };
}

export function createController(ctx, opts = {}) {
  const plane = ctx.flat?.plane === 'side' ? 'side' : 'top', side = plane === 'side';
  const player = opts.player, local = !!opts.camera && !!player?.local;
  // seen from above nobody jumps (the capsule keeps its jump; it is given no height)
  const c = createBase(ctx, { ...opts, camera: null, jump: side ? opts.jump : 0.01 });
  // side-on: the body cannot leave the plane (Rapier locks its Z translation), whatever pushes or knocks it
  if (side) c.body.setEnabledTranslations(true, true, false, true);
  const rig = local ? createFlatRig(ctx, plane, opts.settings) : null;
  c.rig = rig; c.flat = plane;
  if (local && ctx.input) ctx.input.cursorMode = true;       // the mouse stays free and aims where it points
  const fixedStep = c.fixedStep, update = c.update, teleport = c.teleport, cap = c.capsule;
  const ledges = () => ctx.world?.ledges ?? [];
  let drop = 0, stuck = 0, hopIn = 1 + Math.random() * 2, held = null, downWas = false;
  c.ledge = { on: false, drops: 0, passes: 0 };      // QA reads it (tools/flat-reach.mjs)
  c.fixedStep = () => {
    // the local player's keys, stick or touch, mapped onto the plane (a bot's brain writes player.input itself)
    if (local) { const m = ctx.input.move; player.input.x = m.x; player.input.z = side ? 0 : -m.y; }
    else if (side && player.input) player.input.z = 0;
    if (side && cap.setQuery) {
      // THE LEDGE RULE. This body's ground probe sees ledges only while it is coming down (or standing) with its feet
      // at or above a ledge's top under it, and Down is not held. Rising, beside one, or dropping: ledges are air.
      // (No grabbing: feet 6 cm under a ledge's top are under it, so a jump reaches exactly what its height reaches.)
      const t = c.body.translation(), v = c.body.linvel(), feet = t.y - cap.feetOffset, down = local ? ctx.input.move.y < -0.6 : (player.input?.down ?? false);
      // one press of Down drops through one ledge: held, it does not fall through the next one too
      if (down && !downWas && c.state.onGround && drop <= 0 && c.ledge.on) { drop = 0.3; c.ledge.drops++; }
      downWas = down;
      drop = Math.max(0, drop - 1 / 60);
      let over = false;
      if (drop > 0 || v.y > 0.6) held = null;
      else {
        // the ledge this body is on keeps holding it while a hard landing presses its feet a little under the top
        if (held && t.x > held.x0 - 0.25 && t.x < held.x1 + 0.25 && feet >= held.top - 0.55) over = true;
        else { held = null; for (const L of ledges()) if (t.x > L.x0 - 0.25 && t.x < L.x1 + 0.25 && feet >= L.top - 0.06 && feet <= L.top + 2.5) { over = true; held = L; break; } }
      }
      if (over !== c.ledge.on) { c.ledge.on = over; if (!over) c.ledge.passes++; }
      // a ledge is not a collider a capsule can hit, and the float spring alone cannot stop a fast fall in the space of
      // a ledge: a body that has come down past the top of the ledge holding it is set on it
      if (over && held && v.y < 0 && feet < held.top - 0.02) { c.body.setTranslation({ x: t.x, y: held.top - 0.02 + cap.feetOffset, z: t.z }, true); c.body.setLinvel({ x: v.x, y: 0, z: v.z }, true); }
      cap.setQuery(over ? SOLID_AND_LEDGES : SOLID);
    }
    fixedStep();
  };
  c.update = (dt, a) => {
    // a bot side-on: it hops when something blocks it, when what it seeks is just above it, and now and then, so it
    // reaches the ledges (it does not plan a route)
    let hop = false;
    if (side && player.isBot && c.enabled && c.state.onGround) {
      const pushing = Math.abs(player.input?.x ?? 0) > 0.4;
      stuck = pushing && c.state.speed < 0.6 ? stuck + dt : 0; hopIn -= dt;
      // what it is after (rules.bot → p.bot.seek(point)) is above it and near: jump for it
      const t = player.bot?.mode === 'seek' ? player.bot.target : null, above = !!t && Number.isFinite(t.y) && t.y - c.feet.y > 0.5 && Math.abs(t.x - c.feet.x) < 1.6;
      if (stuck > 0.25 || (pushing && hopIn <= 0) || (above && hopIn <= 1.4)) { hop = true; stuck = 0; hopIn = 1.8 + Math.random() * 2; }
    }
    const jumpAct = player.actions?.jump, had = jumpAct?.pressed;
    if (hop && jumpAct) jumpAct.pressed = true;
    update(dt, a);
    if (hop && jumpAct) jumpAct.pressed = had;
    if (!rig) return;
    rig.update(dt, c.feet);
    const P = rig.pointUnder(ctx.input?.pointer, c.feet.y);
    const f = c.state.facing;
    if (P) {
      const ox = c.feet.x, oy = side ? c.feet.y + 0.9 : c.feet.y, oz = c.feet.z;
      const dx = P.x - ox, dy = side ? P.y - oy : 0, dz = side ? 0 : P.z - oz, d = Math.hypot(dx, dy, dz);
      if (d > 0.05) { player.aim = [dx / d, dy / d, dz / d]; player.aimDist = d; player.aimPoint = { x: P.x, y: side ? P.y : c.feet.y, z: P.z }; }
      player.aimOnSelf = false; player.aimHit = 'plane';
      // firing in a game with an aimed mechanic: the body turns to where the shot goes
      const fire = player.actions?.primary?.down || player.actions?.secondary?.down;
      if (ctx.aimed && fire && c.enabled) c.faceTo(side ? (dx >= 0 ? Math.PI / 2 : -Math.PI / 2) : Math.atan2(dx, dz), 0.12);
    } else { player.aim = [Math.sin(f), 0, Math.cos(f)]; player.aimDist = null; player.aimPoint = null; }
    rig.setAim(SCRATCH.set(player.aim[0], player.aim[1], player.aim[2]));
  };
  c.teleport = (p, yaw, o) => { teleport(side ? { x: p.x, y: p.y, z: 0 } : p, yaw, o); if (rig && !o?.keepCamera) rig.reset(); };
  // QA only (?gf-flat-qa=1; never set in real play): tools/flat-reach.mjs puts the real player at a take-off point,
  // then presses the real keys and reads where the body lands. Nothing here moves the body except place().
  if (local && new URLSearchParams(globalThis.location?.search ?? '').has('gf-flat-qa')) {
    globalThis.__flat = {
      plane,
      place(p, yaw = c.state.facing) { c.teleport({ x: p.x, y: p.y ?? 0, z: side ? 0 : p.z ?? 0 }, yaw, { keepCamera: false }); return true; },
      state: () => { const t = c.body.translation(), v = c.body.linvel(); return { x: t.x, y: t.y - cap.feetOffset, z: t.z, vx: v.x, vy: v.y, onGround: !!c.state.onGround, jumps: c.state.jumps, ledge: { ...c.ledge }, frame: c.character?.frame ?? null }; },
      reach: () => { const R = ctx.world.reach?.() ?? {}; return { plane, tile: ctx.world.tile, up: R.up, across0: R.across?.(0), jump: R.jump, gravity: R.gravity, speed: R.speed, surfaces: R.surfaces ?? [], tree: R.tree ?? [], problems: R.problems ?? [], spawns: ctx.world.spawns.map(s => ({ x: s.x, y: s.y, z: s.z })) }; },
      feet: (cc, r) => ctx.world.map.feet(cc, r),
    };
  }
  return c;
}
