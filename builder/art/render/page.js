// The preview page: runs in headless Chrome (render.mjs drives it). Renders a model or a picture to a PNG and measures
// what only a renderer can read: triangles, surface area, the colours the surface really shows (texture texels at each
// triangle's UVs, times the material and vertex colour), texel density, outline hulls, and a body's proportions.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
document.body.appendChild(renderer.domElement);
let lost = 0;
renderer.domElement.addEventListener('webglcontextlost', () => { lost++; });
window.contextLost = () => lost || (renderer.getContext().isContextLost() ? 1 : 0);
const pmrem = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const ktx2 = new KTX2Loader().setTranscoderPath('/three/examples/jsm/libs/basis/').detectSupport(renderer);
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);

window.gpuInfo = () => {
  const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
};

// ---- colour sampling -------------------------------------------------------------------------------------------
const pixelCache = new Map();
function pixelsOf(texture) {
  const img = texture?.image;
  if (!img || pixelCache.has(texture)) return pixelCache.get(texture) ?? null;
  let out = null;
  try {
    const w = Math.min(512, img.width), h = Math.min(512, img.height);
    if (w && h && !texture.isCompressedTexture) {
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, w, h);
      out = { w, h, data: g.getImageData(0, 0, w, h).data, full: [img.width, img.height] };
    }
  } catch { out = null; }
  pixelCache.set(texture, out);
  return out;
}
const wrap = (v, n) => { let i = Math.floor(v * n) % n; return i < 0 ? i + n : i; };
function texel(px, u, v, flipY) {
  const x = wrap(u, px.w), y = wrap(flipY ? 1 - v : v, px.h), i = (y * px.w + x) * 4;
  return [px.data[i] / 255, px.data[i + 1] / 255, px.data[i + 2] / 255, px.data[i + 3] / 255];
}
const toLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

// ---- measuring ----------------------------------------------------------------------------------------------------
const BONES = { hips: /^(mixamorig:)?hips$/i, neck: /^(mixamorig:)?neck$/i, head: /^(mixamorig:)?head$/i, armL: /^(mixamorig:)?leftarm$/i, armR: /^(mixamorig:)?rightarm$/i, footL: /^(mixamorig:)?leftfoot$/i };

function measure(root) {
  root.updateMatrixWorld(true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  let triangles = 0, vertices = 0, area = 0, texArea = 0, texels = 0, outlineArea = 0;
  const colours = new Map(); // quantised sRGB → weight (area)
  const materials = new Set(), textures = new Map();
  let skinned = false, meshes = 0;
  root.traverse(o => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    meshes++;
    if (o.isSkinnedMesh) skinned = true;
    const g = o.geometry, pos = g.attributes.position, uv = g.attributes.uv, col = g.attributes.color, idx = g.index;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: idx ? idx.count : pos.count, materialIndex: 0 }];
    vertices += pos.count;
    for (const grp of groups) {
      const m = mats[grp.materialIndex ?? 0] ?? mats[0];
      if (!m || m.visible === false) continue;
      materials.add(m);
      const map = m.map ?? null, px = map ? pixelsOf(map) : null;
      if (map?.image) textures.set(map, `${map.image.width}x${map.image.height}`);
      const hull = m.side === THREE.BackSide || /outline/i.test(m.name ?? '') || /outline/i.test(o.name ?? '');
      const base = m.color ? [m.color.r, m.color.g, m.color.b] : [1, 1, 1];
      const end = Math.min(grp.start + grp.count, idx ? idx.count : pos.count);
      for (let t = grp.start; t + 2 < end; t += 3) {
        const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
        const s = ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
        triangles++;
        if (!(s > 0)) continue;
        area += s;
        if (hull) { outlineArea += s; continue; }
        // the colour this triangle shows: texture at its UV centroid (linear) × material colour × vertex colour
        let rgb = base.slice();
        if (px && uv) {
          const u = (uv.getX(i0) + uv.getX(i1) + uv.getX(i2)) / 3, v = (uv.getY(i0) + uv.getY(i1) + uv.getY(i2)) / 3;
          const tx = texel(px, u, v, map.flipY);
          rgb = [rgb[0] * toLinear(tx[0]), rgb[1] * toLinear(tx[1]), rgb[2] * toLinear(tx[2])];
          // texel density: UV area × texture pixels against world area
          const du1 = uv.getX(i1) - uv.getX(i0), dv1 = uv.getY(i1) - uv.getY(i0), du2 = uv.getX(i2) - uv.getX(i0), dv2 = uv.getY(i2) - uv.getY(i0);
          const uvA = Math.abs(du1 * dv2 - du2 * dv1) / 2;
          const [W, H] = px.full, t = uvA * W * H;
          // a triangle whose UVs sit on one swatch of a colour atlas (Kenney's colormap) is flat colour, not texture
          if (t >= 0.5) { texels += t; texArea += s; }
        }
        if (col) rgb = [rgb[0] * (col.getX(i0) + col.getX(i1) + col.getX(i2)) / 3, rgb[1] * (col.getY(i0) + col.getY(i1) + col.getY(i2)) / 3, rgb[2] * (col.getZ(i0) + col.getZ(i1) + col.getZ(i2)) / 3];
        const q = rgb.map(x => Math.max(0, Math.min(255, Math.round(toSrgb(Math.max(0, x)) * 255))));
        const key = (q[0] << 16) | (q[1] << 8) | q[2];
        colours.set(key, (colours.get(key) ?? 0) + s);
      }
    }
  });
  const box = new THREE.Box3().setFromObject(root, true);
  const size = box.getSize(new THREE.Vector3());
  // a body's proportions from its bones (rest pose as loaded)
  let body = null;
  const bones = {};
  root.traverse(o => { if (o.isBone) for (const [k, re] of Object.entries(BONES)) if (re.test(o.name) && !bones[k]) bones[k] = o.getWorldPosition(new THREE.Vector3()); });
  let joints = 0; root.traverse(o => { if (o.isBone) joints++; });
  if (bones.hips && bones.neck && size.y > 0) {
    const top = box.max.y, floor = box.min.y, h = top - floor;
    const head = top - bones.neck.y;
    body = {
      height: +h.toFixed(3),
      headsTall: head > 0 ? +(h / head).toFixed(2) : null,
      hipShare: +((bones.hips.y - floor) / h).toFixed(3),
      shoulderShare: bones.armL && bones.armR ? +(bones.armL.distanceTo(bones.armR) / h).toFixed(3) : null,
      widthShare: +(Math.max(size.x, size.z) / h).toFixed(3),
    };
  }
  return {
    meshes, triangles, vertices, skinned, joints,
    size: [size.x, size.y, size.z].map(v => +v.toFixed(3)), min: [box.min.x, box.min.y, box.min.z].map(v => +v.toFixed(3)),
    area: +area.toFixed(4),
    texturedArea: +texArea.toFixed(4), texels: Math.round(texels),
    outlineArea: +outlineArea.toFixed(4),
    materials: materials.size, textures: [...textures.values()],
    colours: [...colours.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4096).map(([k, w]) => [k, +w.toFixed(6)]),
    body,
  };
}

// ---- rendering ----------------------------------------------------------------------------------------------------
async function frame(object, { view = 'three-quarter', size = 256 }) {
  renderer.setSize(size, size, false);
  const scene = new THREE.Scene();
  scene.environment = envMap;
  scene.environmentIntensity = 0.6;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.0); sun.position.set(3, 6, 4); scene.add(sun);
  scene.add(object);
  const box = new THREE.Box3().setFromObject(object, true);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 1e-3);
  const az = view === 'front' ? 0.35 : view === 'top' ? 0 : 0.62, el = view === 'top' ? 1.45 : view === 'front' ? 0.12 : 0.42;
  const camera = new THREE.PerspectiveCamera(30, 1, r / 100, r * 100);
  const dist = r / Math.sin(THREE.MathUtils.degToRad(15)) * 1.04;
  camera.position.set(sphere.center.x + dist * Math.sin(az) * Math.cos(el), sphere.center.y + dist * Math.sin(el), sphere.center.z + dist * Math.cos(az) * Math.cos(el));
  camera.lookAt(sphere.center);
  renderer.setClearColor(0x000000, 0);
  return capture(() => renderer.render(scene, camera), size);
}

// Draw, wait a frame, draw again and read back; on a GPU the first read now and then comes back empty, so an empty
// read of a scene that has triangles is drawn again (up to four times) before it is returned.
const probe = new OffscreenCanvas(64, 64).getContext('2d', { willReadFrequently: true });
async function capture(draw, size, { expectPixels = true } = {}) {
  let url = null;
  for (let i = 0; i < 4; i++) {
    draw();
    await new Promise(r => requestAnimationFrame(r));
    draw();
    url = renderer.domElement.toDataURL('image/png');
    if (!expectPixels) return url;
    const img = await createImageBitmap(await (await fetch(url)).blob());
    probe.clearRect(0, 0, 64, 64); probe.drawImage(img, 0, 0, 64, 64);
    const d = probe.getImageData(0, 0, 64, 64).data;
    let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k]) n++;
    if (n) return url;
  }
  return url;
}

window.renderModel = async (url, opts = {}) => {
  pixelCache.clear();
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;
  const m = measure(root);
  let shown = root;
  if (!m.meshes) { // a clip file with only a skeleton
    const helper = new THREE.SkeletonHelper(root);
    helper.material.linewidth = 2;
    shown = new THREE.Group(); shown.add(root); shown.add(helper);
  }
  const png = await frame(shown, { view: opts.view ?? (m.body ? 'front' : 'three-quarter'), size: opts.size ?? 256 });
  const clips = gltf.animations.map(a => a.name);
  root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); for (const mm of [].concat(o.material)) { for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) mm[k]?.dispose(); mm.dispose(); } } });
  return { png, measures: { ...m, clips } };
};

/** A clip file shown on a body: the body posed by one clip at one moment. */
window.renderClip = async (clipUrl, bodyUrl, { clip = 'walk', at = 0.3, size = 256 } = {}) => {
  const [c, b] = await Promise.all([loader.loadAsync(clipUrl), loader.loadAsync(bodyUrl)]);
  const anim = c.animations.find(a => a.name === clip) ?? c.animations[0];
  const mixer = new THREE.AnimationMixer(b.scene);
  if (anim) { mixer.clipAction(anim).play(); mixer.setTime(Math.min(at, anim.duration)); }
  b.scene.updateMatrixWorld(true);
  const png = await frame(b.scene, { view: 'three-quarter', size });
  return { png, measures: { clips: c.animations.map(a => a.name), seconds: c.animations.map(a => +a.duration.toFixed(3)) } };
};

/** A KTX2 picture drawn flat to a PNG (node reads its pixels from there). */
window.renderKtx2 = async (url, { size = 256 } = {}) => {
  const tex = await ktx2.loadAsync(url);
  const w = tex.image.width, h = tex.image.height;
  renderer.setSize(size, size, false);
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true })));
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0);
  const png = await capture(() => renderer.render(scene, cam), size);
  renderer.toneMapping = THREE.NeutralToneMapping;
  tex.dispose();
  return { png, width: w, height: h };
};

/** A font drawn as a sample line on a light card. */
window.renderFont = async (url, { size = 256 } = {}) => {
  const face = new FontFace(`f${Date.now()}`, `url(${url})`);
  await face.load();
  document.fonts.add(face);
  const c = new OffscreenCanvas(size, size), g = c.getContext('2d');
  g.fillStyle = '#f4f1ea'; g.fillRect(0, 0, size, size);
  g.fillStyle = '#1d2230'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `${Math.round(size * 0.3)}px "${face.family}"`; g.fillText('Aa', size / 2, size * 0.36);
  g.font = `${Math.round(size * 0.11)}px "${face.family}"`; g.fillText('Score 1234', size / 2, size * 0.68);
  g.font = `${Math.round(size * 0.08)}px "${face.family}"`; g.fillText('PLAY AGAIN?', size / 2, size * 0.84);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const pb = new Uint8Array(await blob.arrayBuffer());
  let ps = ''; for (let k = 0; k < pb.length; k += 0x8000) ps += String.fromCharCode.apply(null, pb.subarray(k, k + 0x8000));
  return { png: 'data:image/png;base64,' + btoa(ps), family: face.family };
};

/** A sound decoded to PCM (base64 Float32 per channel) with a waveform picture. */
window.decodeAudio = async (url, { size = 256 } = {}) => {
  const buf = await (await fetch(url)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const audio = await ctx.decodeAudioData(buf);
  const chans = [];
  for (let i = 0; i < Math.min(2, audio.numberOfChannels); i++) {
    const f = audio.getChannelData(i), bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
    let s = ''; for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
    chans.push(btoa(s));
  }
  // the waveform: peak per column, both halves
  const c = new OffscreenCanvas(size, size), g = c.getContext('2d'), d = audio.getChannelData(0), per = Math.max(1, Math.floor(d.length / size));
  g.fillStyle = '#1d2230'; g.fillRect(0, 0, size, size);
  g.fillStyle = '#7fd1ff';
  for (let x = 0; x < size; x++) { let p = 0; for (let k = x * per; k < Math.min(d.length, (x + 1) * per); k++) p = Math.max(p, Math.abs(d[k])); const hgt = Math.max(1, p * size * 0.45); g.fillRect(x, size / 2 - hgt, 1, hgt * 2); }
  const blob = await c.convertToBlob({ type: 'image/png' });
  const pb = new Uint8Array(await blob.arrayBuffer());
  let ps = ''; for (let k = 0; k < pb.length; k += 0x8000) ps += String.fromCharCode.apply(null, pb.subarray(k, k + 0x8000));
  return { sampleRate: audio.sampleRate, seconds: audio.duration, channels: chans, png: 'data:image/png;base64,' + btoa(ps) };
};

window.ready = true;
