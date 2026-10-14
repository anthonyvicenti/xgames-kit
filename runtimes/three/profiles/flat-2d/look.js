// gf-three flat: the look of a flat (2D) game. One WebGL renderer with no shadows and no tone mapping (a picture's
// colours are drawn as they are), a background colour, and the ORTHOGRAPHIC camera a flat game is seen through. The
// runtime shape of every look (CONTRACT §4.2: createRenderer, applyLook → {update, render, resize}), plus what boot
// asks a look for when it brings its own camera: createCamera, resizeCamera, frameSubject.
//
// Two art styles (config/look.json → style; ART-STANDARD.md §1):
//   pixel   nearest filtering, no mipmaps, and the view is snapped so one texel is a whole number of screen pixels
//   drawn   linear filtering, smooth edges, any size
// The view (config/look.json → values): `view` metres across the shorter side of a wide screen. On a phone held
// upright a top-down game shows `view` metres across its width; a side-on game shows `portrait` metres across.
import * as THREE from 'three';
import { assets } from '../assets/assets.js';
import { STYLES, styleOf } from './slots.js';
export { presets, presetValues, lookConfig } from './slots.js';

const flatCfg = () => { const c = assets.config('look'); return { plane: c.flat === 'side' ? 'side' : 'top', style: styleOf(c) }; };

export function createRenderer(canvas, values, quality) {
  const { style } = flatCfg();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: style !== 'pixel', powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, quality?.pixelRatio ?? 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  return renderer;
}

export function createCamera(values) {
  const camera = new THREE.OrthographicCamera(-8, 8, 8, -8, 0.1, 200), { plane, style } = flatCfg();
  Object.assign(camera.userData, { gfFlat: plane, gfStyle: style, gfView: Math.max(4, Number(values?.view) || 12), gfPortrait: Math.max(4, Number(values?.portrait) || Number(values?.view) || 11), gfShow: null });
  return camera;
}
/** The camera's extent for a screen of w × h CSS pixels. → sets left/right/top/bottom and userData.gfTexel (metres a
 *  screen pixel, the step a pixel-style camera moves in). */
export function resizeCamera(camera, w, h, renderer = null) {
  const u = camera.userData, a = w / Math.max(1, h), upright = a < 1;
  // metres across the screen's height
  let viewH = u.gfShow ?? (upright ? (u.gfFlat === 'side' ? u.gfPortrait : u.gfView) / a : u.gfView);
  const ratio = renderer?.getPixelRatio?.() ?? 1, px = Math.max(1, h * ratio);
  if (u.gfStyle === 'pixel' && !u.gfShow) {
    const ppm = STYLES.pixel.ppm, k = Math.max(1, Math.round(px / viewH / ppm));      // screen pixels a texel
    viewH = px / (k * ppm);
    u.gfTexel = 1 / (k * ppm);
  } else u.gfTexel = 0;
  u.gfUpright = upright;
  const halfH = viewH / 2, halfW = halfH * a;
  camera.left = -halfW; camera.right = halfW; camera.top = halfH; camera.bottom = -halfH;
  camera.updateProjectionMatrix();
}

/** A picture's texture, filtered for the style. */
export function tune(tex, style) {
  if (!tex) return tex;
  if (style === 'pixel') { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; }
  else { tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; }
  tex.generateMipmaps = false; tex.anisotropy = 1; tex.needsUpdate = true;
  return tex;
}
/** A picture's material: unlit. Pixel art is cut out at its alpha (it sorts by depth); drawn art blends its soft edge
 *  and is drawn in `order` (ground 0, tiles 1, things 2, bodies 3). */
export function pictureMaterial(map, { color = '#ffffff', style = 'pixel', order = 2 } = {}) {
  tune(map, style);
  const m = new THREE.MeshBasicMaterial({ map, color, side: THREE.DoubleSide, transparent: style !== 'pixel', alphaTest: style === 'pixel' ? 0.5 : 0.02, depthWrite: style === 'pixel' });
  m.userData.gfOrder = order;
  return m;
}

/** Seen from above, how far toward the eye a standing thing is drawn: by the row of its feet, so a nearer thing (lower
 *  on the screen) covers a farther one. A body walks behind a house's roof and in front of its door. The ground and
 *  what lies on it stay under 0.05; standing things are 0.5 to about 1. */
export const standY = z => 0.75 + Math.max(-60, Math.min(60, z)) * 0.004;

const shadowTex = {};
/** The texture of a shadow: an ellipse, hard-edged for pixel art (a flat, see-through shape, as the art standard's
 *  alpha rule wants), soft for drawn art. */
function shadowMap(style) {
  if (shadowTex[style]) return shadowTex[style];
  const W = 32, H = 16, d = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (x + 0.5 - W / 2) / (W / 2), dy = (y + 0.5 - H / 2) / (H / 2), r = Math.hypot(dx, dy);
    d[(y * W + x) * 4 + 3] = style === 'pixel' ? (r <= 1 ? 255 : 0) : Math.round(255 * Math.max(0, Math.min(1, (1 - r) * 2.2)));
  }
  const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat);
  t.magFilter = t.minFilter = style === 'pixel' ? THREE.NearestFilter : THREE.LinearFilter; t.needsUpdate = true;
  return (shadowTex[style] = t);
}
const shadowMats = {};
/** A soft shadow on the ground under a standing thing, w x d metres (seen from above), see-through and unlit. */
export function groundShadow(w, d, style = 'pixel') {
  const m = shadowMats[style] ??= new THREE.MeshBasicMaterial({ color: '#1a1030', map: shadowMap(style), transparent: true, opacity: 0.26, depthWrite: false });
  const geo = new THREE.PlaneGeometry(w, d); geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, m); mesh.name = 'shadow'; mesh.renderOrder = 2; mesh.userData.gfShadow = true;
  return mesh;
}

/** A picture slot as a card on the game's plane: lying on the ground (top) or standing at Z = 0 (side). The return
 *  shape of assets.model(): a tagged Group with (no) animations. `fit`: metres across its longer side; without one its
 *  size is its pixels over the style's texels per metre. */
async function card(id, { fit = null, player = null } = {}, { plane, style }) {
  const tex = await assets.texture(id, player !== null ? { player } : {});
  if (!tex) return null;
  const map = tex.clone(); map.userData.gfSlot = id; map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping; map.needsUpdate = true;
  const iw = tex.image?.width || 1, ih = tex.image?.height || 1, k = fit ? fit / Math.max(iw, ih) : 1 / STYLES[style].ppm, w = iw * k, h = ih * k;
  const side = plane === 'side';
  const geo = new THREE.PlaneGeometry(w, h); if (side) geo.translate(0, h / 2, 0); else geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, pictureMaterial(map, { style, order: 2 })); mesh.renderOrder = 2;
  if (side) mesh.position.z = 0.02; else mesh.position.y = 0.06;
  const root = new THREE.Group(); root.name = id; root.add(mesh); root.animations = [];
  // seen from above a card casts a small shadow and stands in the near-over-far order (standY) of the bodies
  const shadow = side ? null : groundShadow(w * 0.7, Math.min(h, w) * 0.32, style);
  if (shadow) { shadow.position.set(0, 0.045, h * 0.32); root.add(shadow); }
  const at = new THREE.Vector3();
  // a thing a mechanic spins about Y would turn a picture edge-on: the card undoes its parent's turn every frame
  mesh.onBeforeRender = () => {
    const p = mesh.parent; let moved = false;
    if (p && (p.rotation.y || p.parent?.rotation.y)) { mesh.rotation.y = -(p.rotation.y + (p.parent?.rotation.y ?? 0)); moved = true; }
    if (!side && p) { p.getWorldPosition(at); const y = standY(at.z) - at.y; if (Math.abs(mesh.position.y - y) > 1e-4) { mesh.position.y = y; moved = true; } if (shadow) shadow.position.y = 0.045 - at.y; }
    if (moved) mesh.updateMatrixWorld();
  };
  root.userData.gfFile = assets.fileFor(id, player); root.userData.gfSize = side ? [w, h, 0.02] : [w, 0.02, h]; root.userData.gfCard = true;
  return assets.tag(root, id);
}

export function applyLook(ctx, values) {
  const { scene, renderer } = ctx, cfg = flatCfg();
  scene.background = new THREE.Color(values?.background ?? '#8fd3ff');
  // what the kit's own parts draw with lit materials (a board and its pieces, a ring, a marker) is lit evenly: no
  // shadow, no shading by angle, so it sits with the pictures
  const light = new THREE.AmbientLight('#ffffff', 3.0); light.name = 'gf-flat-light'; scene.add(light);
  // THE CARD SEAM. In a flat game a "model" may be a picture slot: any part that asks for its prop's model (a pickup, a
  // carried thing, a marker) gets a card on the game's plane and never learns it is not a mesh.
  if (!ctx.assets.__flatCards) {
    const model = ctx.assets.model.bind(ctx.assets), typeOf = id => ctx.assets.manifest?.slots?.find(s => s.id === id)?.type;
    ctx.assets.model = (id, opts = {}) => (['image', 'texture'].includes(typeOf(id)) ? card(id, opts, cfg) : model(id, opts));
    ctx.assets.__flatCards = true;
  }
  ctx.flat = { plane: cfg.plane, style: cfg.style, ppm: STYLES[cfg.style].ppm };
  return {
    flat: cfg.plane, style: cfg.style,
    update() {},
    resize() {},
    render(camera) { renderer.render(scene, camera); },
  };
}

/** The preview (?gf-show): a flat game's subject is seen as the game is, straight on and filling the view, never from
 *  a turntable's orbit (a picture seen edge-on is a line). state: {focus, radius, height} from boot's show mode. */
export function frameSubject(ctx, state, subject) {
  const cam = ctx.camera, v = Math.max(1.6, state.radius * (subject === 'world' ? 1.15 : 0.8)) * 2, f = state.focus;
  if (cam.userData.gfShow !== v) { cam.userData.gfShow = v; resizeCamera(cam, innerWidth, innerHeight, ctx.renderer); }
  if (cam.userData.gfFlat === 'side') { cam.up.set(0, 1, 0); cam.position.set(f.x, state.height, 60); cam.lookAt(f.x, state.height, 0); }
  else { cam.up.set(0, 0, -1); cam.position.set(f.x, 60, f.z); cam.lookAt(f.x, 0, f.z); }
}
