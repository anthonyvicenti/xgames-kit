// gf-three creature: a body on one of the archetype standards beside gf-humanoid-1 (worm, blob, quadruped, flyer;
// archetypes.js, CREATURES.md), posed every frame by procedural motion (motion.js) instead of clips.
//
// It answers every member the kit reaches on `p.character` (object3d, height, hipHeight, state, anim, locomotion, play,
// stop, knock, ragdoll, recover, socket, setTint, setLookTint, nameplate, look, setHat, glow, express, update, dispose),
// so the controller, the net's place() (a friend's pose: position, yaw and the anim word), fair play and every mechanic
// drive it unchanged and never learn that it has no humanoid skeleton. spawnCharacter (character.js) hands a role to
// this file when the role's archetype (config/characters.json → roles.<role>.archetype) or the body itself
// (gf_body extras gfArchetype / gfRig) says it is a creature.
//
// Knocked over, a creature tumbles as one Rapier body (a ball for a blob, a rounded box for the rest) with the knock's
// velocity, its bones going limp, then stands back up where it came to rest (onState 'getup' moves its capsule there,
// as a humanoid's ragdoll does). Without physics it rolls over in place.
import * as THREE from 'three';
import { standardOf, findCreatureRig, creatureBind, measureCreature, socketPoint, ACTION_OF, ACTION_SECONDS, CREATURE_WORDS } from './archetypes.js';
import { createMotion } from './motion.js';
import { GROUPS } from './ragdoll.js';
import { physicsOf } from '../core/util.js';

const smooth = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const TINT = /^tint/i;

/** Make a creature from a loaded model. Throws when the model is not a body on the archetype's standard. */
export function prepareCreature(model, archetype) {
  const std = standardOf(archetype);
  if (!std) throw new Error(`gf-three creature: no standard for archetype "${archetype}"`);
  const rig = findCreatureRig(model, std);
  if (!rig.skinned.length) throw new Error(`not rigged (run gamesfun art autorig <file> --archetype ${std.archetype})`);
  const missing = std.required.filter(n => !rig.bones.has(n));
  if (missing.length) throw new Error(`not a ${std.rig} body (no ${missing.slice(0, 3).join(', ')})`);
  const bind = creatureBind(model, rig);
  const info = measureCreature(std, rig, bind);
  return { std, rig, bind, info };
}

/**
 * opts: as spawnCharacter's ({ player, bodySlot, tint, local, height, plate, onState }) plus archetype.
 */
export async function spawnCreature(ctx, opts = {}) {
  const { player = null, bodySlot = 'character.body.player', tint = player?.color ?? null, local = false, height = null, plate = null, onState = null, archetype, role = null } = opts;
  const A = ctx.assets;
  const prepare = (m) => {
    if (!m) throw new Error(`gf-three creature: body slot ${bodySlot} is empty`);
    const p = prepareCreature(m, archetype);
    try { ctx.look?.adoptMaterials?.(m, 'character'); } catch (e) { console.warn(`gf-three creature: house material for ${bodySlot}: ${e.message}`); }
    return { model: m, ...p };
  };
  // a player's own body (a loadout) when it is a body on the same standard; else the game's
  const ownBody = player && A.ownFile ? A.ownFile(bodySlot, player) : null;
  let body = null;
  if (ownBody) {
    try { const m = await A.model(bodySlot, { player, ownOnly: true }); if (m) body = prepare(m); }
    catch (e) { A.reject?.(player, bodySlot, e.message); }
  }
  body ??= prepare(opts.model ?? await A.model(bodySlot));
  const { model, std, rig, bind, info } = body;
  const bodyFile = model.userData?.gfFile ?? null;

  // object3d (placed by the controller) → offset (a tumble and the get-up) → holder (height scale, feet at 0) → model
  const object3d = new THREE.Group(); object3d.name = `character:${player?.id ?? bodySlot}`;
  const offset = new THREE.Group(); offset.name = 'gf_offset';
  const holder = new THREE.Group(); holder.name = 'gf_holder';
  const scale = height ? height / Math.max(1e-3, info.height) : 1;
  holder.scale.setScalar(scale);
  model.position.y = -info.ground;
  holder.add(model); offset.add(holder); object3d.add(offset);
  object3d.userData.gfSlot = bodySlot; object3d.userData.gfArchetype = std.archetype;
  model.traverse(o => { if (o.isSkinnedMesh) o.frustumCulled = false; if (o.isMesh) o.castShadow = true; });
  const bodyNode = model.getObjectByName('gf_body') ?? model;
  const motion = createMotion(std, rig, bind, info, { bodyNode });

  // tint (RIG.md §8, the same rule as a humanoid's): tint_* materials or the body's gfTint list, moved by gfTintMix
  const extras = bodyNode.userData ?? {};
  const tintNames = new Set(extras.gfTint ?? []);
  const tintMix = typeof extras.gfTintMix === 'number' ? extras.gfTintMix : 1;
  const tinted = [], cloned = new Map();
  let gameTint = null, lookTint = null;
  const paintTint = () => { const c = lookTint ?? gameTint; if (c == null) return; const t = new THREE.Color(c); for (const m of tinted) if (m.color) m.color.copy(m.userData.gfBase ?? m.color).lerp(t, tintMix); };
  model.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map(m => {
      if (!(TINT.test(m.name) || tintNames.has(m.name))) return m;
      if (!cloned.has(m)) { const c = m.clone(); c.userData.gfBase = c.color?.clone(); cloned.set(m, c); tinted.push(c); }
      return cloned.get(m);
    });
    o.material = Array.isArray(o.material) ? out : out[0];
  });

  // sockets: frames aligned with the character at rest, metres, on the standard's bone for each
  const sockets = {};
  for (const name of ['head', 'hand_l', 'hand_r', 'back']) {
    const file = model.getObjectByName(`socket_${name}`);
    if (file) { sockets[name] = file; continue; }
    const sp = socketPoint(std, name, bind);
    const bone = rig.bones.get(sp.bone) ?? rig.bones.get('Root');
    const bp = bind.pos.get(bone.name) ?? new THREE.Vector3(), bq = bind.rot.get(bone.name) ?? new THREE.Quaternion();
    const bm = new THREE.Matrix4().compose(bp, bq, new THREE.Vector3(1, 1, 1));
    const s = new THREE.Object3D(); s.name = `socket_${name}`;
    s.position.copy(sp.at.clone().applyMatrix4(bm.clone().invert()));
    s.quaternion.copy(bq.clone().invert());
    bone.add(s); sockets[name] = s;
  }

  // ---------------- state (the same words and modes as a humanoid: 'anim' | 'ragdoll' | 'getup')
  const S = { t: 0, speed: 0, grounded: true, vy: 0, vyGiven: 0, airT: 0, landT: 9, jumped: false, action: null, hold: 0, holdOn: null, aim: 0, mode: 'anim', down: 0, getup: null };
  const vel = new THREE.Vector3(), lastPos = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Quaternion();
  let havePos = false, glowMats = null, plateSprite = null, wantUp = false, upIn = null, tumble = null, tumbleT = 0, lying = null, word = 'idle';
  const plateInfo = { text: player?.name ?? '', color: tint ?? '#ffffff' };
  const TELEPORT = 40, TELEPORT_M = 2.5, MAX_CARRY = 14;
  const { RAPIER, world: pworld } = physicsOf(ctx);

  function startAction(action, w, { loop = false, rate = 1, hold = false, seconds = null } = {}) {
    const dur = (seconds ?? ACTION_SECONDS[action] ?? 0.5) / Math.max(0.2, rate);
    S.action = { action, word: w, t: 0, dur, loop, hold };
  }

  // ---------------- tumbling (a knock): one rigid body for the whole creature
  const sizeOf = () => ({ h: info.height * scale, w: info.width * scale, d: info.depth * scale });
  function startTumble(v) {
    stopTumble();
    if (!(RAPIER && pworld)) { S.mode = 'ragdoll'; S.down = 0; tumbleT = 0; onState?.('ragdoll', {}); return; }
    object3d.updateWorldMatrix(true, true);
    const { h, w, d } = sizeOf();
    const centre = object3d.localToWorld(new THREE.Vector3(0, h / 2, 0));
    const q = object3d.getWorldQuaternion(new THREE.Quaternion());
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(centre.x, centre.y, centre.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(0.4).setAngularDamping(2).setCcdEnabled(true);
    const rb = pworld.createRigidBody(desc);
    const r = Math.min(h, Math.max(w, d)) / 2;
    const shape = std.archetype === 'blob' ? RAPIER.ColliderDesc.ball(Math.max(0.05, r * 0.92))
      : RAPIER.ColliderDesc.roundCuboid(Math.max(0.03, w * 0.32), Math.max(0.03, h * 0.32), Math.max(0.03, d * 0.32), Math.max(0.02, Math.min(w, h, d) * 0.15));
    shape.setDensity(1).setFriction(0.8).setRestitution(std.archetype === 'blob' ? 0.2 : 0.05)
      .setCollisionGroups((GROUPS.RAGDOLL << 16) | (GROUPS.WORLD | GROUPS.PROPS));
    pworld.createCollider(shape, rb);
    const lv = v.clone().clampLength(0, 30);
    rb.setLinvel({ x: lv.x, y: lv.y, z: lv.z }, true);
    // it rolls the way it is pushed, with a little twist (from the push itself, so every copy tumbles alike)
    const spinAxis = new THREE.Vector3(lv.z, 0, -lv.x).multiplyScalar(1 / Math.max(0.2, r) * 0.35);
    const twist = Math.sign(lv.x * lv.z || 1) * Math.min(2, 0.25 * Math.hypot(lv.x, lv.z));
    rb.setAngvel({ x: spinAxis.x, y: twist, z: spinAxis.z }, true);
    tumble = { rb, h }; tumbleT = 0;
    S.mode = 'ragdoll'; S.action = null;
    onState?.('ragdoll', {});
  }
  function stopTumble() { if (tumble) { try { pworld.removeRigidBody(tumble.rb); } catch {} tumble = null; } }
  /** The model where the tumbling body is: offset = object3d⁻¹ · (body's place, lowered by half the height). */
  function followTumble() {
    const t = tumble.rb.translation(), r = tumble.rb.rotation();
    const world = new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(1, 1, 1))
      .multiply(new THREE.Matrix4().makeTranslation(0, -tumble.h / 2, 0));
    setOffsetWorld(world);
    return world;
  }
  function setOffsetWorld(world) {
    object3d.updateWorldMatrix(true, false);
    const local = object3d.matrixWorld.clone().invert().multiply(world);
    local.decompose(offset.position, offset.quaternion, _p);
    offset.updateMatrixWorld(true);
  }
  function beginGetUp(seconds = null) {
    let from;
    if (tumble) {
      from = followTumble();
      const t = tumble.rb.translation();
      // stand up on the ground under where it lies, facing the way its front ended up
      let groundY = object3d.getWorldPosition(new THREE.Vector3()).y;
      if (RAPIER && pworld) {
        const ray = new RAPIER.Ray({ x: t.x, y: t.y + 0.2, z: t.z }, { x: 0, y: -1, z: 0 });
        const hit = pworld.castRay(ray, 6, true, undefined, (GROUPS.WORLD << 16) | GROUPS.WORLD);
        if (hit) groundY = t.y + 0.2 - (hit.timeOfImpact ?? hit.toi);
      }
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(from)).setY(0);
      const yaw = fwd.lengthSq() > 1e-4 ? Math.atan2(fwd.x, fwd.z) : 0;
      stopTumble();
      lying = { from, target: new THREE.Vector3(t.x, groundY, t.z), yaw };
      onState?.('getup', { position: lying.target.clone(), yaw });
    } else lying = null;
    S.getup = { t: 0, dur: typeof seconds === 'number' && seconds > 0 ? seconds : 0.6 };
    S.mode = 'getup';
  }

  // ---------------- the character
  const ch = {
    object3d, model, sockets, player, local, archetype: std.archetype, rig: std.rig,
    get height() { return info.height * scale; },
    /** Half way up the body: where a 'hips' muzzle starts. */
    get hipHeight() { return info.height * scale * 0.5; },
    get state() { return S.mode; },
    get anim() { return S.action?.word ?? (S.holdOn ?? word); },
    clips: CREATURE_WORDS,
    meta: {},
    bones: rig.bones,
    retarget: null,
    info,
    plate: plateInfo,

    /** Play a word (a humanoid clip name or an action: act, hit, celebrate, hold, down). */
    play(name, o = {}) {
      const action = ACTION_OF[name];
      if (!action) return false;
      if (S.mode !== 'anim' && action !== 'down') return false;
      if (name === 'land' && !o.loop) { S.landT = 0; return true; }
      if (name === 'jump' && !o.loop) { S.jumped = true; return true; }
      if (name === 'getup' || name === 'getup_front') { if (S.down > 0 || S.mode !== 'anim') beginGetUp(); return true; }
      if (action === 'down') { if (o.hold === false) { startAction('hit', name); return true; } ch.ragdoll(true); return true; }
      if (action === 'hold') { S.holdOn = name; return true; }
      if (action === 'move' || action === 'idle' || action === 'air') { if (!o.hold && !o.loop) S.action = null; return true; }
      startAction(action, name, { loop: o.loop ?? false, rate: o.rate ?? 1, hold: o.hold ?? false, seconds: o.seconds ?? null });
      return true;
    },
    stop(name = 'upper') {
      if (S.holdOn && (name === 'upper' || name === S.holdOn || ACTION_OF[name] === 'hold')) S.holdOn = null;
      if (S.action && (name === 'base' || name === S.action.word || name === S.action.action)) S.action = null;
    },
    locomotion(speed = 0, grounded = true, vy = 0) {
      if (S.grounded && !grounded) { S.airT = 0; S.jumped = vy > 0.5 || ch.__word === 'jump'; }
      if (!grounded && !S.jumped && S.airT < 0.2 && ch.__word === 'jump') S.jumped = true;
      if (!S.grounded && grounded && S.airT > 0.25) S.landT = 0;
      // the controller passes no vertical speed: update() reads it from how object3d moves
      S.vyGiven = vy; S.speed = speed; S.grounded = grounded;
    },
    setAim(pitch) { S.aim = pitch; },
    socket(name) { return sockets[name] ?? object3d; },
    express() { return false },
    get face() { return null; },
    faces: [],
    /** Knocked: tumble with this velocity (world m/s), then get up by itself (unless getUp is false). */
    knock(impulse = { x: 0, y: 2, z: -3 }, { getUp = true } = {}) {
      const v = new THREE.Vector3(impulse.x ?? 0, impulse.y ?? 0, impulse.z ?? 0).add(vel.clone().clampLength(0, MAX_CARRY));
      if (tumble && S.mode === 'ragdoll') { const lv = tumble.rb.linvel(); tumble.rb.setLinvel({ x: lv.x + (impulse.x ?? 0), y: lv.y + (impulse.y ?? 0), z: lv.z + (impulse.z ?? 0) }, true); tumbleT = Math.min(tumbleT, 0.2); wantUp = getUp; return; }
      startTumble(v); wantUp = getUp; upIn = null;
    },
    /** Down (stays down) or up (gets up once it has come to rest). The controller's 'knockdown' word uses this. */
    ragdoll(on, { upSeconds = null } = {}) {
      if (on) { if (S.mode !== 'ragdoll') startTumble(vel.clone().clampLength(0, MAX_CARRY)); wantUp = false; upIn = null; }
      else if (S.mode === 'ragdoll') { wantUp = true; upIn = typeof upSeconds === 'number' && upSeconds > 0 ? upSeconds : null; }
    },
    /** Stand at once where object3d is (a respawn or a round reset). */
    recover() {
      if (S.mode === 'anim' && S.down === 0) return;
      stopTumble(); wantUp = false; upIn = null; lying = null;
      S.mode = 'anim'; S.down = 0; S.getup = null; S.action = null;
      offset.position.set(0, 0, 0); offset.quaternion.identity();
      havePos = false; vel.set(0, 0, 0);
      onState?.('up', {});
    },
    glow(color, amount = 0.4) {
      if (!glowMats) {
        if (color == null) return;
        glowMats = [];
        const own = new Map();
        model.traverse(o => {
          if (!o.isMesh) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          const out = mats.map(m => {
            if (!m || !m.emissive) return m;
            if (!own.has(m)) { const c = tinted.includes(m) ? m : m.clone(); c.userData = { ...m.userData, gfGlowBase: m.emissive.clone() }; own.set(m, c); glowMats.push(c); }
            return own.get(m);
          });
          o.material = Array.isArray(o.material) ? out : out[0];
        });
      }
      const k = color == null ? 0 : Math.max(0, Math.min(1, amount));
      const gc = new THREE.Color(color ?? '#000');
      for (const m of glowMats) m.emissive.copy(m.userData.gfGlowBase).lerp(gc, k);
    },
    setTint(c) { if (c == null) return; gameTint = typeof c === 'string' ? c : '#' + new THREE.Color(c).getHexString(); paintTint(); plateInfo.color = gameTint; },
    setLookTint(c) { lookTint = c == null ? null : typeof c === 'string' ? c : '#' + new THREE.Color(c).getHexString(); paintTint(); },
    get tint() { return gameTint; },
    get look() { return { body: bodyFile, hat: ch.hat?.userData?.gfFile ?? null, tint: lookTint, bodyTint: lookTint ?? gameTint, material: tinted[0]?.color ? '#' + tinted[0].color.getHexString() : null, mix: tintMix }; },
    setHat(obj) {
      if (ch.hat) { ch.hat.removeFromParent(); ch.hat = null; }
      if (!obj) return;
      try { ctx.look?.adoptMaterials?.(obj, 'prop'); } catch (e) { console.warn(`gf-three creature: hat material: ${e.message}`); }
      sockets.head.add(obj); ch.hat = obj;
    },
    nameplate(text, color) {
      plateInfo.text = text ?? ''; if (color) plateInfo.color = color;
      if (plate === 'sprite' && globalThis.document) drawPlate();
    },
    /** What the motion is doing now, for tests and the creature judge: { mode, action, down, speed, grounded }. */
    get motionState() { return { mode: S.mode, action: S.action?.action ?? null, word: ch.anim, down: S.down, speed: S.speed, grounded: S.grounded }; },
    update(dt) {
      dt = Math.min(Math.max(dt, 0), 0.1);
      S.t += dt;
      object3d.updateWorldMatrix(true, false);
      const p = object3d.getWorldPosition(_p.set(0, 0, 0));
      if (dt > 1e-4) {
        if (havePos) {
          const step = p.clone().sub(lastPos), d = step.length();
          if (!(d <= TELEPORT_M && d / dt <= TELEPORT)) vel.set(0, 0, 0); else vel.lerp(step.divideScalar(dt), 0.5);
        }
        havePos = true; lastPos.copy(p);
      }
      S.vy = S.vyGiven || (S.grounded ? 0 : vel.y);
      if (!S.grounded) S.airT += dt;
      if (S.landT < 9) S.landT += dt;
      const a = S.action;
      if (a) {
        a.t += dt;
        if (a.t >= a.dur) { if (a.loop) a.t %= a.dur; else if (a.hold) a.t = a.dur; else S.action = null; }
      }
      S.hold += ((S.holdOn ? 1 : 0) - S.hold) * Math.min(1, dt * 8);
      // down, up
      if (S.mode === 'ragdoll') {
        tumbleT += dt;
        S.down = Math.min(1, S.down + dt * 5);
        if (tumble) followTumble();
        const settled = tumble ? tumbleT > 0.7 && (Math.hypot(...Object.values(tumble.rb.linvel())) < 0.35 || tumbleT > 4) : tumbleT > 0.5;
        if (wantUp && (upIn !== null ? tumbleT > 0.05 : settled)) beginGetUp(upIn);
      } else if (S.mode === 'getup') {
        const g = S.getup; g.t += dt;
        const k = smooth(g.t / g.dur);
        S.down = 1 - k;
        if (lying) {
          // blend from where it lay to standing on object3d (which onState('getup') moved to the place it lay)
          object3d.updateWorldMatrix(true, false);
          const fromP = new THREE.Vector3(), fromQ = new THREE.Quaternion(), toP = new THREE.Vector3(), toQ = new THREE.Quaternion(), sc = new THREE.Vector3();
          lying.from.decompose(fromP, fromQ, sc); object3d.matrixWorld.decompose(toP, toQ, sc);
          const w = new THREE.Matrix4().compose(fromP.lerp(toP, k), fromQ.slerp(toQ, k), new THREE.Vector3(1, 1, 1));
          setOffsetWorld(w);
        }
        if (g.t >= g.dur) { S.mode = 'anim'; S.down = 0; S.getup = null; lying = null; offset.position.set(0, 0, 0); offset.quaternion.identity(); onState?.('up', {}); }
      }
      // body-frame horizontal velocity (for the jiggle)
      const yaw = object3d.getWorldQuaternion(_q);
      const bv = vel.clone().applyQuaternion(yaw.clone().invert());
      word = !S.grounded ? (S.vy > 0 ? 'jump' : 'fall') : S.speed > 3.6 ? 'run' : S.speed > 0.35 ? 'walk' : 'idle';
      motion.pose({ t: S.t, speed: S.mode === 'anim' ? S.speed : 0, grounded: S.grounded || S.mode !== 'anim', vy: S.vy, airT: S.airT, landT: S.landT,
        vel: { x: bv.x, z: bv.z }, action: S.mode === 'anim' ? S.action : null, hold: S.hold, aim: S.aim,
        down: S.down, tumbling: !!tumble || !!lying, getup: S.getup ? Math.min(1, S.getup.t / S.getup.dur) : null }, dt);
    },
    dispose() {
      stopTumble();
      object3d.removeFromParent();
      for (const m of tinted) m.dispose();
      if (plateSprite) { plateSprite.material.map?.dispose(); plateSprite.material.dispose(); }
    },
  };

  function drawPlate() {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
    const g = cv.getContext('2d');
    g.font = '600 30px system-ui, sans-serif';
    const w = Math.min(248, g.measureText(plateInfo.text).width + 34);
    g.fillStyle = 'rgba(20,22,34,0.72)'; g.beginPath(); g.roundRect((256 - w) / 2, 10, w, 44, 22); g.fill();
    g.fillStyle = plateInfo.color; g.beginPath(); g.arc((256 - w) / 2 + 18, 32, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(plateInfo.text, (256 - w) / 2 + 30, 33);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    if (!plateSprite) {
      plateSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
      plateSprite.userData.gfSlot = 'character.nameplate';
      plateSprite.renderOrder = 10; plateSprite.scale.set(1.0, 0.25, 1);
      object3d.add(plateSprite);
    } else { plateSprite.material.map?.dispose(); plateSprite.material.map = tex; }
    plateSprite.position.set(0, info.height * scale + 0.32, 0);
  }

  // a hat on the head socket: the player's own, else the game's (character.js loadHat)
  if (opts.loadHat) { try { ch.setHat(await opts.loadHat(ctx, role, player)); } catch (e) { console.warn(`gf-three creature: hat for ${role}: ${e.message}`); } }
  if (tint) ch.setTint(tint);
  const own = player && role && A.own ? A.own(`character.tint.${role}`, player) : undefined;
  if (own != null) ch.setLookTint(own);
  if (player?.name) ch.nameplate(player.name, tint ?? undefined);
  ch.update(0);
  return ch;
}
