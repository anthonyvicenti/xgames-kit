// gf-three character bench (track C). Any body plays every clip; a knock ragdolls it and it gets up; four bodies
// stand side by side on the same clip. The bodies load through the kit's real assets module (gf-assets), so a body
// swap is a Studio-style file override: window.__GF_ASSET_OVERRIDES.files['assets/models/body-player.glb'].
//
// URL: ?body=<library id>  ?override=<library id> (swaps the player slot's file)  ?mode=lineup|all  ?clip=<name>
//      ?bodies=a,b,c,d  ?speed=<m/s>  ?t=<seconds to freeze the clip at>
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { assets } from '/kit/assets/assets.js';
import { spawnCharacter, CLIPS } from '/kit/character/character.js';

const Q = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
const status = t => { $('status').textContent = t; };
const B = (window.__bench = { ready: false, errors: [], chars: [] });
addEventListener('error', e => B.errors.push(String(e.message)));
addEventListener('unhandledrejection', e => B.errors.push(String(e.reason?.message ?? e.reason)));

// ---------------------------------------------------------------- renderer, light, ground
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#dfe8f3');
scene.fog = new THREE.Fog('#dfe8f3', 14, 40);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;
scene.add(new THREE.HemisphereLight('#f2f7ff', '#c9b9a6', 1.2));
const sun = new THREE.DirectionalLight('#fff4e6', 2.4);
sun.position.set(4, 9, 6); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 0.5, far: 30 });
scene.add(sun);
const exempt = (o, why) => { o.traverse(x => { x.userData.gfExempt = why; }); return o; };
const ground = exempt(new THREE.Mesh(new THREE.CircleGeometry(30, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#d6e3cf', roughness: 0.95 })), 'bench floor');
ground.receiveShadow = true; scene.add(ground);
const step = exempt(new THREE.Mesh(new THREE.BoxGeometry(2, 0.35, 1.2), new THREE.MeshStandardMaterial({ color: '#c6d2e6', roughness: 0.8 })), 'bench block');
step.position.set(-3.2, 0.175, -1.5); step.castShadow = step.receiveShadow = true; scene.add(step);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.05, 200);
const orbit = { yaw: 0, pitch: 0.12, dist: 4.4, target: new THREE.Vector3(0, 0.85, 0) };
function placeCamera() {
  const c = Math.cos(orbit.pitch);
  camera.position.set(orbit.target.x + Math.sin(orbit.yaw) * c * orbit.dist, orbit.target.y + Math.sin(orbit.pitch) * orbit.dist, orbit.target.z + Math.cos(orbit.yaw) * c * orbit.dist);
  camera.lookAt(orbit.target);
}
let drag = null;
renderer.domElement.addEventListener('pointerdown', e => { drag = [e.clientX, e.clientY]; });
addEventListener('pointerup', () => { drag = null; });
addEventListener('pointermove', e => { if (!drag) return; orbit.yaw -= (e.clientX - drag[0]) * 0.006; orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + (e.clientY - drag[1]) * 0.004, -0.2, 1.3); drag = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('wheel', e => { orbit.dist = THREE.MathUtils.clamp(orbit.dist * (1 + Math.sign(e.deltaY) * 0.08), 1.2, 20); }, { passive: true });
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

// ---------------------------------------------------------------- physics
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.1, 30).setTranslation(0, -0.1, 0).setFriction(0.9));
world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.175, 0.6).setTranslation(-3.2, 0.175, -1.5));

// ---------------------------------------------------------------- assets (+ a Studio-style override from ?override=)
const lib = await (await fetch('/library/bodies.json')).json();
if (Q.get('override')) {
  const id = Q.get('override');
  const bytes = new Uint8Array(await (await fetch(`/library/bodies/${id}.glb`)).arrayBuffer());
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  window.__GF_ASSET_OVERRIDES.files['assets/models/body-player.glb'] = `data:model/gltf-binary;base64,${btoa(bin)}`;
  B.override = id;
}
await assets.init({ renderer, configs: [] });
const ctx = { THREE, scene, camera, renderer, physics: { RAPIER, world }, assets, time: { now: 0 } };
B.ctx = ctx;

// ---------------------------------------------------------------- characters
const PALETTE = ['#ff7eb3', '#4fc7c0', '#ffc94a', '#a98bff', '#6fb7ff', '#ff9b5e', '#7bd389'];
const slotFor = id => (id === 'player' ? 'character.body.player' : `character.body.lib-${id}`);
let chars = [], loco = { speed: +(Q.get('speed') ?? 0), angle: 0, radius: 2.2, inPlace: Q.has('inplace') }, jump = null, mode = Q.get('mode') ?? 'single';
let selected = Q.get('body') ?? 'player';

async function spawn(id, at, i = 0) {
  const c = await spawnCharacter(ctx, { player: { id: `b${i}`, name: id === 'player' ? (B.override ? `player ← ${B.override}` : 'player') : lib.bodies.find(b => b.id === id)?.label ?? id, color: PALETTE[i % PALETTE.length] },
    bodySlot: slotFor(id), tint: Q.has('notint') ? null : PALETTE[i % PALETTE.length], plate: 'sprite' });
  c.object3d.position.copy(at);
  scene.add(c.object3d);
  c.bodyId = id;
  return c;
}
function clear() { for (const c of chars) c.dispose(); chars = []; B.chars = chars; }
async function setup() {
  clear();
  status('loading…');
  if (mode === 'single') {
    chars.push(await spawn(selected, new THREE.Vector3(0, 0, 0), lib.bodies.findIndex(b => b.id === selected) + 1));
    orbit.target.set(0, 0.85, 0); orbit.dist = 4.4;
  } else if (mode === 'grid') {
    // one body, one clip each, frozen at a fraction of the clip (?clips=a,b,c&body=x&at=0.5)
    const names = (Q.get('clips') ?? 'idle,walk,run,jump,fall,land,hit,knockdown,getup,getup_front,aim,carry,interact,emote_wave,emote_cheer,throw').split(',');
    const cols = +(Q.get('cols') ?? Math.min(names.length, 6)), gap = +(Q.get('gap') ?? 1.3), rows = Math.ceil(names.length / cols);
    for (const [i, n] of names.entries()) {
      const c = await spawn(selected, new THREE.Vector3((i % cols - (cols - 1) / 2) * gap, 0, -Math.floor(i / cols) * 3), i);
      c.nameplate(n, '#ffffff'); c.gridClip = n;
      chars.push(c);
    }
    orbit.target.set(0, 0.75, -3 * (rows - 1) / 2); orbit.dist = 2.2 + cols * gap * 1.05 + rows * 1.2; orbit.pitch = rows > 1 ? 0.45 : 0.1;
  } else {
    const ids = mode === 'lineup' ? (Q.get('bodies')?.split(',') ?? ['bean-classic', 'ual-mannequin', 'quaternius-astronaut', lib.bodies.at(-1).id]) : lib.bodies.map(b => b.id);
    const gap = mode === 'lineup' ? 1.25 : 1.1;
    for (const [i, id] of ids.entries()) chars.push(await spawn(id, new THREE.Vector3((i - (ids.length - 1) / 2) * gap, 0, 0), i));
    orbit.target.set(0, 0.9, 0); orbit.dist = mode === 'lineup' ? 6.4 : 8.6;
  }
  B.chars = chars;
  buildClips();
  if (mode === 'grid') {
    const at = +(Q.get('at') ?? 0.5);
    for (const c of chars) { c.play(c.gridClip, { loop: c.meta?.[c.gridClip]?.loop }); const d = (c.meta?.[c.gridClip]?.duration ?? 1) * at; for (let t = 0; t < d; t += 1 / 60) c.update(1 / 60); }
    frozenGrid = true;
  }
  if (Q.get('clip')) playAll(Q.get('clip'));
  status(info());
}
function playAll(name) { for (const c of chars) c.play(name, { loop: c.meta?.[name]?.loop ?? undefined }); B.lastClip = name; }
function info() {
  const c = chars[0]; if (!c) return '';
  const meshes = []; c.model.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
  return `${chars.map(x => x.bodyId).join(', ')}\n${c.clips.length} clips · height ${c.height.toFixed(2)} m · legs ×${c.retarget.k.toFixed(2)} · ${meshes.reduce((a, m) => a + m.geometry.attributes.position.count, 0)} verts`;
}

// ---------------------------------------------------------------- UI
for (const [i, b] of [['player', { label: 'player slot (assets.json)' }], ...lib.bodies.map(b => [b.id, b])].entries()) {
  const o = document.createElement('option'); o.value = b[0]; o.textContent = b[1].label + (b[0] === 'player' ? '' : `  (${b[0]})`); $('body').append(o);
}
$('body').value = selected;
$('body').onchange = () => { selected = $('body').value; mode = 'single'; setup(); };
function buildClips() {
  const el = $('clips'); el.innerHTML = '';
  for (const n of chars[0]?.clips ?? CLIPS) { const b = document.createElement('button'); b.textContent = n; b.onclick = () => playAll(n); el.append(b); }
}
$('speed').oninput = () => { loco.speed = +$('speed').value; $('speedv').textContent = loco.speed.toFixed(1); };
$('jump').onclick = () => { jump = { t: 0, vy: 4.6 }; };
$('knock').onclick = () => knockAll();
$('aimbtn').onclick = e => { const on = e.target.classList.toggle('on'); for (const c of chars) on ? c.play('aim', { loop: true }) : c.stop('aim'); };
$('carrybtn').onclick = e => { const on = e.target.classList.toggle('on'); for (const c of chars) on ? c.play('carry', { loop: true }) : c.stop('carry'); };
$('tint').oninput = () => { for (const c of chars) c.setTint($('tint').value); };
let axes = [];
$('sockets').onclick = () => {
  if (axes.length) { for (const a of axes) a.removeFromParent(); axes = []; return; }
  for (const c of chars) for (const s of Object.values(c.sockets)) { const a = exempt(new THREE.AxesHelper(0.18), 'socket axes'); a.material.depthTest = false; a.renderOrder = 20; s.add(a); axes.push(a); }
};
for (const m of ['single', 'lineup', 'all']) $(m).onclick = () => { mode = m; for (const x of ['single', 'lineup', 'all']) $(x).classList.toggle('on', x === m); setup(); };
function knockAll(dir) {
  for (const [i, c] of chars.entries()) {
    const a = dir ?? (Math.PI + (i % 2 ? 0.5 : -0.4));
    c.knock({ x: Math.sin(a) * 3.2, y: 2.6, z: Math.cos(a) * 3.2 });
  }
}

// ---------------------------------------------------------------- loop (physics at a fixed 60 Hz)
let acc = 0, last = performance.now(), frozen = Q.get('t') !== null, frozenGrid = false;
const clock = { t: 0 };
function frame(dt) {
  ctx.time.now += dt;
  acc = Math.min(acc + dt, 0.25);
  while (acc >= 1 / 60) { world.step(); acc -= 1 / 60; }
  // locomotion demo: the single character walks a circle at the chosen speed
  if (mode === 'single' && chars[0]) {
    const c = chars[0];
    let grounded = true, vy = 0, y = 0;
    if (jump) { jump.t += dt; vy = jump.vy - 9.81 * jump.t; y = jump.vy * jump.t - 4.905 * jump.t * jump.t; if (y <= 0 && jump.t > 0.1) { y = 0; jump = null; } else grounded = false; }
    if (c.state === 'anim') {
      if (loco.speed > 0 && !loco.inPlace) {
        loco.angle += loco.speed * dt / loco.radius;
        c.object3d.position.set(Math.cos(loco.angle) * loco.radius, y, -Math.sin(loco.angle) * loco.radius);
        c.object3d.rotation.y = -loco.angle + Math.PI;    // facing along the circle (counter-clockwise from above)
      } else c.object3d.position.y = y;
    }
    c.locomotion(loco.speed, grounded, vy);
  } else for (const c of chars) c.locomotion(loco.speed, true, 0);
  for (const c of chars) c.update(dt);
}
function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!frozen && !frozenGrid) frame(dt);
  if (mode === 'single' && chars[0] && !loco.inPlace) { const h = chars[0].bones.get('Hips').getWorldPosition(new THREE.Vector3()); orbit.target.lerp(h.setY(Math.max(0.5, h.y)), frozen ? 1 : 0.08); }
  placeCamera();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- the observation for QA (qa.mjs)
Object.assign(B, {
  lib, info, playAll, knockAll, setup,
  setMode: async (m, opts = {}) => { mode = m; if (opts.body) selected = opts.body; if (opts.bodies) Q.set('bodies', opts.bodies.join(',')); await setup(); },
  setSpeed: (s, { inPlace = false } = {}) => { loco.speed = s; loco.inPlace = inPlace; },
  jump: () => { jump = { t: 0, vy: 4.6 }; },
  /** Advance the simulation by `seconds` in fixed frames (deterministic, independent of the display rate). */
  advance(seconds, dt = 1 / 60) { for (let t = 0; t < seconds; t += dt) frame(dt); },
  freeze(on = true) { frozen = on; },
  /** What each character is: body slot, mesh/material names, vertex count, clips, height, state, and a pose hash. */
  describe() {
    return chars.map(c => {
      const meshes = [], mats = new Set(); let verts = 0;
      c.model.traverse(o => { if (o.isSkinnedMesh) { meshes.push(o.name); verts += o.geometry.attributes.position.count; [].concat(o.material).forEach(m => mats.add(m.name)); } });
      const pose = ['Hips', 'LeftUpLeg', 'LeftLeg', 'RightArm', 'Head'].map(n => c.bones.get(n)?.quaternion.toArray().map(v => +v.toFixed(3)));
      const head = c.bones.get('Head').getWorldPosition(new THREE.Vector3()), feet = new THREE.Box3().setFromObject(c.model, true);
      return { body: c.bodyId, slot: c.object3d.userData.gfSlot, meshes, materials: [...mats], verts, clips: c.clips, height: +c.height.toFixed(3), state: c.state, anim: c.anim,
        pose, head: head.toArray().map(v => +v.toFixed(3)), minY: +feet.min.y.toFixed(3), maxY: +feet.max.y.toFixed(3), plate: c.plate,
        nan: [...c.bones.values()].some(b => !Number.isFinite(b.quaternion.x) || !Number.isFinite(b.position.x)) };
    });
  },
  coverage: () => assets.coverage(scene),
  /** Point the camera: { yaw, pitch, dist, target: [x, y, z] }; hides the bench's nameplates (for previews). */
  setOrbit({ target, ...o }) { Object.assign(orbit, o); if (target) orbit.target.set(...target); loco.inPlace = true; },
  hidePlates() { for (const c of chars) c.object3d.traverse(x => { if (x.isSprite) x.visible = false; }); },
});
await setup();
if (Q.get('t') !== null) { B.advance(+Q.get('t')); }
requestAnimationFrame(tick);
B.ready = true;
