// gf-forge's Studio preview subjects (CONTRACT §6, §8 forge): `?gf-show=<subject>` draws one slot in place, so Studio's
// Assets tab (and verify's coverage and swap proof) can see it with no per-game work.
//   prop.<name>   the game's prop alone, turning slowly in the room's light
//   world         the room from high in a corner
//   look          the room from the first spawn, as a player first sees it
// `&gf-eye=x,y,z,yaw,pitch` (metres and degrees; yaw 0 looks north, down −Z, and turns left as it grows) looks at the
// world or the look from anywhere: the frames a world's art is judged by (research/gf-forge/library/tools/world-frames.mjs).
import * as forgeWorld from './world.js';

export async function runForgeShow(ctx, subject, { worldCfg, lightsAt, observe }) {
  const forge = ctx.forge;
  const state = { ready: false, subject, error: null };
  window.__game = Object.freeze({
    kit: 'xgames-kit', runtime: 'forge', profile: null, version: ctx.kit.version, phase: 'show', subject,
    get ready() { return state.ready; },
    snapshot: () => ({ kit: 'xgames-kit', runtime: 'forge', profile: null, version: ctx.kit.version, phase: 'show', subject, ready: state.ready, error: state.error }),
    coverage: () => observe.coverage(),
    slots: () => observe.slots(),
  });
  forge.eyes(false);
  let spin = null;
  if (subject.startsWith('prop.')) {
    // the prop alone at the middle of the room (no pieces and no ground: the first thing placed is the prop)
    ctx.world = await forgeWorld.loadWorld(ctx, { ...worldCfg, pieces: [], ground: null, sky: null, props: (worldCfg.props ?? []).filter(p => `prop.${p.prop}` === subject).slice(0, 1).map(p => ({ ...p, at: [0, 0, 0], rot: 0 })) }, { hands: false });
    const inst = ctx.world.instances.find(x => x.prop) ?? ctx.world.instances[0];
    if (!inst) throw new Error(`gf-forge show: ${subject} is not in config/world.json → props`);
    const [x0, y0, z0, x1, y1, z1] = inst.model.bounds;
    const span = Math.max(x1 - x0, y1 - y0, z1 - z0, 0.3), cy = (y0 + y1) / 2;
    const dist = span * 1.9 + 0.6;
    spin = { inst, dist, cy, a: 0 };
    ctx.world.lights = [{ at: [1.2 * span, cy + span, 1.6 * span], seed: 1 }, { at: [-1.4 * span, cy + span * 0.6, 0.4 * span], seed: 2 }];
  } else {
    ctx.world = await forgeWorld.loadWorld(ctx, worldCfg, { hands: false });
    const [W, D] = worldCfg.size ?? [9, 9];
    if (subject === 'world') forge.pose(W * 0.42, Math.max(W, D) * 0.62, D * 0.42, Math.PI / 4, -0.62);
    else { const s = ctx.world.spawn(0); forge.pose(s.x, (s.y ?? 0) + 1.55, s.z, (s.yaw ?? Math.PI) + Math.PI, -0.05); }
    const eye = new URLSearchParams(location.search).get('gf-eye')?.split(',').map(Number) ?? null;
    if (eye && eye.length >= 3 && eye.every(Number.isFinite)) forge.pose(eye[0], eye[1], eye[2], ((eye[3] ?? 0) * Math.PI) / 180, ((eye[4] ?? 0) * Math.PI) / 180);
  }
  let t = 0, last = null, frames = 0;
  const frame = now => {
    const dt = last === null ? 0 : Math.min(0.1, (now - last) / 1000); last = now; t += dt;
    if (spin) {
      spin.a += dt * 0.5;
      forge.pose(Math.sin(spin.a) * spin.dist, spin.cy + spin.dist * 0.35, Math.cos(spin.a) * spin.dist, spin.a, -0.3);
    }
    // the world's own frame work (a fire's flame steps through its loop: gf/forge/world.js `tick`), on this one frame loop
    try { ctx.world?.tick?.(dt); } catch (e) { state.error = String(e?.message ?? e); }
    forge.setLights(lightsAt(t));
    try { forge.render(t); } catch (e) { state.error = String(e?.message ?? e); }
    if (++frames >= 3) state.ready = true;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return ctx;
}
