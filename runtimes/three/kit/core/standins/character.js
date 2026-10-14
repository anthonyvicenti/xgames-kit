// STAND-IN for track C's kit/character/character.js (CONTRACT §4.4), used until it lands. The kit picks the real
// module at boot when gf/three/kit.js lists it.
//
// It plays whatever body the `character.body.<role>` slot holds: clips are found by the gf-humanoid-1 names
// (CLIPS), then by the Quaternius UAL names the stand-in mannequin carries, then by a loose name match. A body with
// no matching clip simply stands. No ragdoll physics: a knock plays the knockdown clip and holds it; getting up plays
// it backwards. The nameplate is drawn by the kit's UI (DOM, not a mesh).
import * as THREE from 'three';

export const CLIPS = ['idle', 'walk', 'run', 'jump', 'fall', 'land', 'hit', 'knockdown', 'getup', 'aim', 'carry', 'interact', 'emote_wave', 'emote_cheer'];
// gf-humanoid-1 clip → the UAL mannequin's clip (research/foundations/trials/third-person-adventure/source/assets/hero/hero.glb)
const UAL = { idle: 'Idle_Loop', walk: 'Walk_Loop', run: 'Jog_Fwd_Loop', sprint: 'Sprint_Loop', jump: 'Jump_Start', fall: 'Jump_Loop', land: 'Jump_Land',
  hit: 'Hit_Chest', knockdown: 'Death01', getup: 'Death01', aim: 'Spell_Simple_Shoot', throw: 'Spell_Simple_Shoot', carry: 'Idle_Loop', interact: 'Interact',
  emote_wave: 'Interact', emote_cheer: 'Dance_Loop', cheer: 'Dance_Loop', wave: 'Interact' };
const LOOSE = { idle: /idle/i, walk: /walk/i, run: /run|jog/i, jump: /jump/i, fall: /fall|jump_?loop/i, knockdown: /death|die|knock/i, hit: /hit|hurt/i, interact: /interact|use/i, emote_cheer: /dance|cheer/i };
const LOOPS = new Set(['idle', 'walk', 'run', 'sprint', 'fall', 'carry', 'emote_cheer', 'cheer']);
const SOCKETS = { head: [/^DEF-head$/, /head$/i], hand_r: [/^DEF-hand\.R$/, /hand[._]?r$|righthand$/i], hand_l: [/^DEF-hand\.L$/, /hand[._]?l$|lefthand$/i], back: [/^DEF-spine\.003$/, /spine2$|chest$|spine\.003$/i] };
const WALK_CLIP_SPEED = 1.45, RUN_CLIP_SPEED = 3.9;

export async function spawnCharacter(ctx, { player = null, bodySlot = 'character.body.player', tint = null, local = false, height = 1.7 } = {}) {
  const model = await ctx.assets.model(bodySlot, { fit: height, fitAxis: 'y' });
  const object3d = new THREE.Group(); object3d.name = `character:${player?.id ?? bodySlot}`;
  object3d.add(model); object3d.userData.gfSlot = bodySlot;
  const meshes = [];
  model.traverse(o => { if (o.isMesh) { o.frustumCulled = false; meshes.push(o); } });
  const base = new Map();
  for (const m of meshes) {
    const own = (Array.isArray(m.material) ? m.material : [m.material]).map(x => { const c = x.clone(); base.set(c, c.color ? c.color.clone() : null); return c; });
    m.material = Array.isArray(m.material) ? own : own[0];
  }
  const mixer = new THREE.AnimationMixer(model);
  const clips = model.animations ?? [];
  const find = name => clips.find(c => c.name === name) ?? (UAL[name] && clips.find(c => c.name === UAL[name])) ?? (LOOSE[name] && clips.find(c => LOOSE[name].test(c.name))) ?? null;
  const actions = new Map();
  const action = name => {
    if (actions.has(name)) return actions.get(name);
    const clip = find(name); const a = clip ? mixer.clipAction(clip) : null;
    if (a && !LOOPS.has(name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    actions.set(name, a); return a;
  };
  let cur = null, curName = null, oneShot = null, held = false;
  function fadeTo(name, { fade = 0.18, timeScale = 1, reverse = false } = {}) {
    const next = action(name); if (!next) return false;
    if (next === cur && curName === name && !reverse) { next.timeScale = timeScale; return true; }
    next.reset(); next.enabled = true; next.setEffectiveWeight(1); next.timeScale = reverse ? -Math.abs(timeScale) : timeScale;
    if (reverse) next.time = next.getClip().duration;
    next.play();
    if (cur && cur !== next) cur.crossFadeTo(next, fade, false);
    cur = next; curName = name;
    return true;
  }
  fadeTo('idle', { fade: 0 });
  const sockets = {};
  for (const [k, pats] of Object.entries(SOCKETS)) { for (const p of pats) { model.traverse(o => { if (!sockets[k] && o.isBone && p.test(o.name)) sockets[k] = o; }); if (sockets[k]) break; } }
  const box = new THREE.Box3().setFromObject(model, true);
  const h = Math.max(0.5, box.max.y - box.min.y);
  let plate = { text: player?.name ?? '', color: player?.color ?? '#ffffff' };

  const me = {
    object3d, height: h, model, mixer, clips: clips.map(c => c.name),
    /** Play a clip by gf-humanoid-1 name. {loop, fade, hold}: a one-shot returns to locomotion when it ends unless held. */
    play(name, { loop = LOOPS.has(name), fade = 0.12, hold = false } = {}) {
      if (name === 'getup') { held = false; oneShot = fadeTo('knockdown', { fade: 0.1, timeScale: 1.6, reverse: true }) ? 'getup' : null; return; }
      if (!fadeTo(name, { fade })) return;
      held = !!hold; oneShot = loop ? null : name;
    },
    /** Locomotion by speed (m/s); grounded false → the air loop. Ignored while a one-shot or a held clip plays. */
    locomotion(speed, grounded = true) {
      if (held) return;
      if (oneShot) { const a = cur; if (a && a.isRunning() && (a.timeScale > 0 ? a.time < a.getClip().duration - 0.05 : a.time > 0.05)) return; oneShot = null; }
      if (!grounded) { fadeTo('fall', { fade: 0.2 }); return; }
      if (speed < 0.3) fadeTo('idle');
      else if (speed < 3.6) fadeTo('walk', { timeScale: Math.max(0.6, speed / WALK_CLIP_SPEED) });
      else fadeTo('run', { timeScale: Math.max(0.7, speed / RUN_CLIP_SPEED) });
    },
    socket: name => sockets[name] ?? object3d,
    knock() { me.play('knockdown', { hold: true }); },
    ragdoll(on) { if (on) me.play('knockdown', { hold: true }); else me.play('getup'); },
    setTint(c) {
      if (c === null || c === undefined) return;
      const col = new THREE.Color(c);
      for (const [mat, b] of base) {
        if (!mat.color || !b) continue;
        // the mannequin's main material takes the colour, its joints a darker shade; any other body is tinted gently
        if (/joint/i.test(mat.name)) mat.color.copy(col).multiplyScalar(0.35);
        else if (/main/i.test(mat.name)) mat.color.copy(col);
        else mat.color.copy(b).lerp(col, 0.35);
      }
    },
    nameplate(text, color) { plate = { text: text ?? plate.text, color: color ?? plate.color }; return plate; },
    get plate() { return plate; },
    update(dt) { mixer.update(dt); },
    dispose() { mixer.stopAllAction(); object3d.removeFromParent(); for (const mat of base.keys()) mat.dispose(); },
  };
  me.setTint(tint);
  // a hat: the optional character.hat.<role> slot, on the head socket (its origin on top of the head)
  const role = bodySlot.split('.')[2];
  if (role && ctx.assets.has(`character.hat.${role}`)) {
    try { const hat = await ctx.assets.model(`character.hat.${role}`); const head = sockets.head; if (hat && head) { head.add(hat); hat.scale.setScalar(1 / Math.max(1e-3, head.getWorldScale(new THREE.Vector3()).x / object3d.getWorldScale(new THREE.Vector3()).x)); me.hat = hat; } }
    catch (e) { console.warn(`gf-three character: hat for ${role}: ${e.message}`); }
  }
  return me;
}
