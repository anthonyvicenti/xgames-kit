// gf-three core: Studio preview subjects (CONTRACT §6). With ?gf-show=<subject> the game skips the lobby, the net and
// the rules, and shows one thing in the world, framed, with no UI:
//   character.<role>   a turntable of that role's body          prop.<name>   that prop alone, turning
//   world              a wide shot                              look          four characters and the props, 3/4 view
//   vfx.<preset>       an effect preset firing over the ground (kit/vfx/show.js)
//   anything else      the mechanic whose module exports show(ctx, subject), else the world
// Without the parameter none of this runs. window.__game.ready turns true once the subject is framed.
import * as THREE from 'three';
import { areaOf } from './util.js';

export async function runShow(ctx, subject, { spawnCharacter, characterFor, mechanics }) {
  const { scene, camera, assets } = ctx;
  const palette = assets.config('characters').palette ?? assets.config('look').palette?.players ?? ['#4f7cff'];
  const A = areaOf(ctx.world), half = Math.max(A.hx, A.hz);
  const state = { subject, ready: false, focus: new THREE.Vector3(), radius: 4, height: 1.2, spin: 0.35, angle: 0.6, pitch: 0.28 };
  let spinObj = null;
  // everything of the world but its ground (the stand-in's props are Object3Ds, the real world's InstancedMeshes)
  const hideLayout = () => { for (const c of ctx.world.root?.children ?? []) if (!/^ground/.test(c.name)) c.visible = false; };

  if (subject.startsWith('character.')) {
    const role = subject.slice('character.'.length) || 'player';
    const { bodySlot, height } = characterFor(role);
    const who = { id: 'show', name: '', color: palette[0] };
    let c = await spawnCharacter(ctx, { player: who, bodySlot, tint: palette[0], height });
    scene.add(c.object3d); c.locomotion?.(0, true); ctx.onFrame.push(dt => c.update?.(dt));
    hideLayout();
    state.radius = Math.max(2.2, c.height * 1.6); state.height = c.height * 0.55; state.spin = 0.5; state.pitch = 0.12;
    // a new loadout from the page (boot's onPageLoadout): the subject is made again in it, turned where the old one was,
    // and takes its place once loaded; a newer try-on that lands first wins
    let serial = 0;
    state.restyle = async () => {
      const mine = ++serial;
      try {
        const own = ctx.assets.own?.(`character.tint.${role}`, who) ?? palette[0];
        const n = await spawnCharacter(ctx, { player: who, bodySlot, tint: own, height });
        if (mine !== serial) { n.dispose?.(); return; }
        n.object3d.rotation.copy(c.object3d.rotation); n.object3d.position.copy(c.object3d.position);
        scene.add(n.object3d); n.locomotion?.(0, true);
        const old = c; c = n; old.dispose?.(); old.object3d.removeFromParent();
        state.restyled = (state.restyled ?? 0) + 1;
      } catch (e) { console.warn(`gf-three show: the new look did not load (${e.message}); the last one stays`); }
    };
  } else if (subject.startsWith('prop.')) {
    const slot = subject;
    hideLayout();
    const obj = await assets.model(slot, { ground: true });
    const box = new THREE.Box3().setFromObject(obj, true), size = box.getSize(new THREE.Vector3());
    obj.position.y = 0.05; scene.add(obj); spinObj = obj;
    const r = Math.max(size.x, size.y, size.z);
    state.radius = Math.max(1.2, r * 2.2); state.height = size.y * 0.5; state.spin = 0; state.pitch = 0.32;
  } else if (subject === 'look') {
    for (let i = 0; i < 4; i++) {
      const { bodySlot, height } = characterFor('player', i);
      const c = await spawnCharacter(ctx, { player: { id: `show${i}`, name: '', color: palette[i % palette.length] }, bodySlot, tint: palette[i % palette.length], height });
      c.object3d.position.set((i - 1.5) * 1.3, 0, 0); c.object3d.rotation.y = 0.25 * (i - 1.5);
      scene.add(c.object3d); c.locomotion?.(0, true); ctx.onFrame.push(dt => c.update?.(dt));
    }
    state.radius = 7; state.height = 1.1; state.spin = 0; state.angle = 0.45; state.pitch = 0.22;
  } else if (subject === 'world') {
    state.radius = half * 2.1; state.height = 0; state.spin = 0.05; state.angle = 0.8; state.pitch = 0.62;
  } else if (subject.startsWith('vfx.')) {
    // an effect preset (kit/vfx): loaded on demand, so a game that carries no vfx never asks for the file
    await (await import('../vfx/show.js')).showVfx(ctx, subject.slice(4), state, hideLayout);
  } else {
    const m = [...mechanics.values()].find(x => typeof x.show === 'function' && x.handles?.(subject) !== false);
    if (m) await m.show(ctx, subject, state);
    else { state.radius = half * 2; state.pitch = 0.6; }
  }
  const still = !!globalThis.__GF_STILL;
  ctx.onFrame.push(dt => {
    if (!still) state.angle += dt * state.spin;
    if (spinObj && !still) spinObj.rotation.y += dt * 0.6;
    const cp = Math.cos(state.pitch);
    camera.position.set(state.focus.x + Math.sin(state.angle) * cp * state.radius, state.height + Math.sin(state.pitch) * state.radius, state.focus.z + Math.cos(state.angle) * cp * state.radius);
    camera.lookAt(state.focus.x, state.height, state.focus.z);
  });
  state.ready = true;
  return state;
}
