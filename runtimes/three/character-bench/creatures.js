// Creature bench: bodies on the archetype standards (worm, blob, quadruped, flyer; kit/character/CREATURES.md) side by
// side, moved the way the kit's controller moves a player (speed, on the ground or not, the anim words), so their
// procedural motion can be watched and filmed. Each body goes through the kit's own creature.js.
//
// URL: ?bodies=<library id>,<id>…  (or window.__CREATURE_BODIES = [{ id, url, name }] set before load)
//      ?script=film   the film timeline (idle, walk, run, jump, act, hit, knock and get up, celebrate) on every body
//      ?manual        no clock of its own: window.__bench.advance(seconds) steps it (a film's frames are exact)
//      ?clean         no panel
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { spawnCreature } from '/kit/character/creature.js';
import { archetypeOfModel } from '/kit/character/archetypes.js';

const Q = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
const B = (window.__bench = { ready: false, errors: [], chars: [], t: 0, label: '' });
addEventListener('error', e => B.errors.push(String(e.message)));
addEventListener('unhandledrejection', e => B.errors.push(String(e.reason?.message ?? e.reason)));
if (Q.has('clean')) document.body.classList.add('clean');

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#cfe6ff');
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;
scene.add(new THREE.HemisphereLight('#f2f7ff', '#b8a68e', 1.3));
const sun = new THREE.DirectionalLight('#fff4e6', 2.6);
sun.position.set(4, 9, 6); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 0.5, far: 30 });
scene.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#9ccf7a', roughness: 0.95 }));
ground.receiveShadow = true; scene.add(ground);
const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.05, 200);
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.1, 30).setTranslation(0, -0.1, 0).setFriction(0.9));

// ---- bodies
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const list = window.__CREATURE_BODIES ?? (Q.get('bodies') ?? '').split(',').filter(Boolean).map(id => ({ id, url: `/library/bodies/${id}.glb`, name: id }));
const loaded = new Map();
for (const b of list) {
  const g = await loader.loadAsync(b.url);
  loaded.set(`creature.${b.id}`, g);
}
const assets = {
  async model(slot) { const g = loaded.get(slot); const m = SkeletonUtils.clone(g.scene); m.userData.gfFile = slot; return m; },
  has: () => false,
};
const ctx = { THREE, scene, camera, renderer, physics: { RAPIER, world }, assets, time: { now: 0 } };
const PALETTE = ['#ff7eb3', '#4fc7c0', '#ffc94a', '#a98bff', '#6fb7ff'];
const gap = +(Q.get('gap') ?? 1.5);
for (const [i, b] of list.entries()) {
  const g = loaded.get(`creature.${b.id}`);
  const archetype = archetypeOfModel(g.scene);
  const c = await spawnCreature(ctx, { player: { id: b.id, name: b.name ?? b.id, color: PALETTE[i % PALETTE.length] }, bodySlot: `creature.${b.id}`, archetype, tint: PALETTE[i % PALETTE.length], plate: Q.has('plates') ? 'sprite' : null });
  const home = new THREE.Vector3((i - (list.length - 1) / 2) * gap, 0, 0);
  c.object3d.position.copy(home);
  scene.add(c.object3d);
  B.chars.push({ c, home, pos: home.clone(), yaw: 0, vy: 0, y: 0, grounded: true, angle: 0, word: 'idle' });
}

// ---- the camera: the row, from a little above and in front
const span = Math.max(1.5, list.length * gap);
const maxH = Math.max(0.4, ...B.chars.map(x => x.c.height));
// room above for a jump (about a metre), the row across
camera.position.set(0, maxH * 0.9 + 0.6 + span * 0.14, span * 0.7 + maxH * 1.4 + 1.6); camera.lookAt(0, maxH * 0.4 + 0.35, -0.3);

// ---- a driver per body: what the kit's controller would tell it
function setWord(x, word, speed, grounded) {
  const c = x.c;
  if (word === 'idle' || word === 'walk' || word === 'run') c.locomotion(speed, grounded);
  else if (word === 'jump' || word === 'fall') c.locomotion(speed, false);
  else if (word !== x.word) c.play(word, { loop: false });
  c.__word = word; x.word = word;
}
const H = 1 / 60, G = 14;
const FILM = [
  [0, 'idle'], [1.2, 'walk'], [3.4, 'run'], [5.0, 'jump'], [6.2, 'act'], [7.0, 'hit'], [7.6, 'hit'], [8.3, 'knock'], [11.2, 'celebrate'], [13.2, 'end'],
];
let mode = Q.get('script') === 'film' ? 'film' : 'idle', modeT = 0, filmT = 0, filmI = -1;
function setMode(m) { mode = m; modeT = 0; B.label = m; $('label').textContent = m; for (const x of B.chars) x.event = m; }
function stepOne(dt) {
  B.t += dt; modeT += dt; ctx.time.now = B.t;
  if (Q.get('script') === 'film') {
    filmT += dt;
    while (filmI + 1 < FILM.length && filmT >= FILM[filmI + 1][0]) { filmI++; setMode(FILM[filmI][1]); }
  }
  for (const x of B.chars) {
    const c = x.c, sc = Math.max(0.5, c.height);
    let speed = 0;
    if (mode === 'walk' || mode === 'run') {
      speed = (mode === 'walk' ? 1.1 : 3.2) * sc;
      // a little circle in place: forward along the yaw, turning
      const r = (mode === 'walk' ? 0.55 : 0.75) * Math.max(0.6, sc) * 1.2;
      x.angle += speed / r * dt;
      x.pos.set(x.home.x + Math.sin(x.angle) * r - 0, 0, x.home.z + (1 - Math.cos(x.angle)) * r - r);
      x.yaw = Math.PI / 2 - x.angle;            // facing along the path: (cos a, sin a)
    } else if (x.pos.distanceTo(x.home) > 0.01) { x.pos.lerp(x.home, Math.min(1, dt * 3)); x.yaw += (0 - x.yaw) * Math.min(1, dt * 3); if (mode !== 'knock') speed = 0.8; }
    const ev = x.event; x.event = null;          // what the mode does once, on the step it starts
    if (ev === 'jump' && x.grounded) { x.vy = 5.2; x.grounded = false; }
    if (!x.grounded) { x.vy -= G * dt; x.y += x.vy * dt; if (x.y <= 0) { x.y = 0; x.vy = 0; x.grounded = true; c.play('land'); } }
    c.object3d.position.set(x.pos.x, x.y, x.pos.z); c.object3d.rotation.y = x.yaw;
    if (ev === 'knock') c.knock({ x: 0.5, y: 2.6, z: 1.3 });
    const word = mode === 'knock' ? (c.state === 'anim' ? 'idle' : 'down') : !x.grounded ? (x.vy > 0 ? 'jump' : 'fall') : mode === 'act' ? 'punch' : mode === 'hit' ? 'hit' : mode === 'celebrate' ? 'emote_cheer' : speed > 3.6 ? 'run' : speed > 0.35 ? 'walk' : 'idle';
    if (ev === 'hit') { c.play('hit'); x.word = 'hit'; }
    else setWord(x, word, speed, x.grounded);
    if (mode === 'knock' && c.state === 'ragdoll' && modeT > 0.4) c.ragdoll(false);
    c.update(dt);
  }
  world.step();
}
B.advance = (seconds) => { const n = Math.max(1, Math.round(seconds / H)); for (let i = 0; i < n; i++) stepOne(H); renderer.render(scene, camera); return B.t; };
B.setMode = setMode;
B.probe = () => B.chars.map(x => { const p = x.c.model.getWorldPosition(new THREE.Vector3()); return { id: x.c.player.id, state: x.c.state, model: [p.x, p.y, p.z].map(v => +v.toFixed(2)), off: x.c.object3d.children[0].position.toArray().map(v => +v.toFixed(2)) }; });
B.info = () => B.chars.map(x => ({ id: x.c.player.id, archetype: x.c.archetype, height: +x.c.height.toFixed(3), state: x.c.motionState }));

for (const a of ['idle', 'walk', 'run', 'jump', 'act', 'hit', 'knock', 'celebrate']) {
  const b = document.createElement('button'); b.textContent = a; b.onclick = () => setMode(a); $('actions').append(b);
}
$('status').textContent = B.chars.map(x => `${x.c.player.id}: ${x.c.archetype}, ${x.c.height.toFixed(2)} m`).join('\n');
setMode(mode);
B.ready = true;
if (!Q.has('manual')) {
  let last = performance.now(), acc = 0;
  renderer.setAnimationLoop(now => { acc += Math.min(0.1, (now - last) / 1000); last = now; while (acc >= H) { stepOne(H); acc -= H; } renderer.render(scene, camera); });
} else renderer.render(scene, camera);
