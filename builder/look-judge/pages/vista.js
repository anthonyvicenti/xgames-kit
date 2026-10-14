// The look judge's page for the vista runtime (kind calm): the core's island in the kind's look preset and a
// gf-humanoid-1 body (or two side by side) standing on the pier, skinned and lit by the core (gf/vista/kit/humanoid.js),
// held in one clip at one moment and seen from where the tool asks (window.__sheet.look). Bodies come from the asset
// library (/lib3/). ?body=<id>&also=<id>&preset=<look id>&seed=<n>&words=<k:v,…> (the island: a generated place,
// runtimes/vista/kit/world/places.js; no seed: the reference island, kept only for regressions)
import { createVista } from '/vista/kit/host.js';
import { loadHumanoid } from '/vista/kit/humanoid.js';
import { Vector3 } from '/vista/core/src/engine/math/index.js';
import { WORLD } from '/vista/core/src/world/WorldLayout.js';
import { toWorld, harbour } from '/vista/core/src/world/Place.js';
import { placeRecipe, placeLook } from '/vista/kit/world/places.js';

const Q = new URLSearchParams(location.search);
const S = window.__sheet = { ready: false, errors: [], info: {} };
addEventListener('error', e => S.errors.push(String(e.error?.stack ?? e.message)));
addEventListener('unhandledrejection', e => S.errors.push(String(e.reason?.stack ?? e.reason)));
const lib = await (await fetch('/lib3/bodies.json')).json();
const fileOf = id => { const b = lib.bodies.find(x => x.id === id); if (!b) throw new Error(`no body ${id} in the library`); return `/lib3/${b.file}`; };
const clips = `/lib3/${lib.clips}`;
// the kit ships the core's own MIT clouds (the volumetric ones carry a separate licence: runtimes/vista/core/PATCHES.md 5)
const words = Object.fromEntries((Q.get('words') || '').split(',').filter(Boolean).map(kv => kv.split(':')));
const place = Q.has('seed') ? placeRecipe(Number(Q.get('seed')), words) : null;
const vista = await createVista({ look: Q.get('preset') ? { preset: Q.get('preset'), ...(place ? placeLook(place) ?? {} : {}) } : null, panel: false, clouds: 'basic', place });
const app = vista.app;
const h = await loadHumanoid(app, { body: fileOf(Q.get('body')), clips });
const h2 = Q.get('also') ? await loadHumanoid(app, { body: fileOf(Q.get('also')), clips }) : null;
// the pier is laid out in its harbour's frame (core/src/world/Place.js): a place turns and moves it
const X = WORLD.pier.x, deckY = (x, z) => Math.max(app.terrainData.heightAt(x, z), app.colliders.groundHeightAt(x, z, WORLD.pier.deckHeight + 1));
const onPier = (lx, lz) => toWorld(lx, lz), turn = () => harbour().heading ?? 0;
app.setFreeCam(true);
const aim = (target, from) => { const d = target.clone().sub(from); app.fly.setPose(from, Math.atan2(-d.x, -d.z), Math.asin(d.y / d.length())); };
window.__sheet.look = {
  // a fixed pose: the clip at time t on the pier at z, facing yaw; the second body 0.9 m to the side
  hold({ clip = 'idle', t = 0.3, z = 0, yaw = 0 } = {}) {
    const [x1, z1] = onPier(X, z), [x2, z2] = onPier(X - 0.9, z);
    h.setTransform([x1, deckY(x1, z1), z1], yaw + turn()); h.play(clip, { fade: 0, from: t }); h.update(0);
    if (h2) { h2.setTransform([x2, deckY(x2, z2), z2], yaw + turn()); h2.play(clip, { fade: 0, from: t }); h2.update(0); }
  },
  // the camera at the body: distance, height above the feet, angle around it (0: in front), the part looked at
  look({ dist = 4, height = 1.2, angle = 0.6, at = 0.55 } = {}) {
    const p = h2 ? h.group.position.clone().add(h2.group.position).multiplyScalar(0.5) : h.group.position;
    if (h2) dist *= 1.25;
    aim(new Vector3(p.x, p.y + h.height * at, p.z), new Vector3(p.x + Math.sin(angle) * dist, p.y + height, p.z + Math.cos(angle) * dist));
  },
};
S.info = { body: Q.get('body'), also: Q.get('also'), preset: Q.get('preset'), place: place ? { seed: place.seed, words: place.words } : 'reference' };
S.ready = true;
