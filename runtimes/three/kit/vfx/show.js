// gf-three vfx: the Studio preview subject ?gf-show=vfx.<preset> (vfx.blast: the game's effect style). A burst preset fires over the ground about once a
// second; a continuous preset (shape.rate > 0) burns on a marker that drifts slowly side to side. The world is hidden.
// Loaded on demand by kit/core/show.js, so a game that carries no vfx never asks for this file.
import * as THREE from 'three';
import { vfxOf } from './index.js';

export function showVfx(ctx, name, state, hideLayout) {
  const vfx = vfxOf(ctx);
  globalThis.__gfVfx = vfx;      // QA only: screenshots pause it mid-effect (vfx.paused), tests read vfx.stats()
  hideLayout();
  state.focus.set(0, 1, 0); state.radius = 3.4; state.height = 1.1; state.spin = 0; state.pitch = 0.1; state.angle = 0.4;
  if (name === 'blast') {          // the game's effect style: a blast, then a hit, over and over
    let t = 0, n = 0;
    ctx.onFrame.push(dt => { t -= dt; if (t <= 0) { t = 1.6; if (n++ % 2) vfx.hit({ x: 0, y: 1, z: 0 }); else vfx.blast({ x: 0, y: 0.6, z: 0 }, { radius: 2 }); } });
    return;
  }
  const rate = ctx.assets?.has(`vfx.${name}.shape`) ? (ctx.assets.value(`vfx.${name}.shape`, {}).rate ?? 0) : 0;
  if (rate > 0) {
    const marker = new THREE.Object3D(); marker.position.set(0, 0.2, 0); ctx.scene.add(marker);
    let t = 0;
    ctx.onFrame.push(dt => { t += dt; marker.position.x = Math.sin(t * 0.8) * 0.8; });
    vfx.follow(name, marker);
  } else {
    let t = 0;
    ctx.onFrame.push(dt => { t -= dt; if (t <= 0) { t = 1.1; vfx.fx(name, { at: { x: 0, y: 1, z: 0 } }); } });
  }
}
