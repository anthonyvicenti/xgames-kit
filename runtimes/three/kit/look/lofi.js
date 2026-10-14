// lofi: the post pass of the lofi kind on the three runtime (kinds/lofi.json). Cheap and dark on purpose, the look of
// the lo-fi co-op horror line: a low-resolution picture scaled up with hard pixels, an ordered dither, a small palette,
// and vertices that snap to the pixel grid so models swim a little as they move, with textures that warp across big
// triangles (affine mapping, the 1990s consoles' look). Every number is a look value (`post.lofi` in config/look.json).
//
// The look attaches it (look.js, when the look's values carry post.lofi) and sizes it on every resize: the renderer
// draws `lines` tall and the canvas is scaled up with hard pixels; the pass runs after the look's own stack (outline,
// tone mapping, grade), so the ink outline is one chunky lofi pixel wide and the dither is laid on the final colours.
//
//   const lofi = attachLofi(composer, renderer, scene, values.post.lofi);
//   renderer.setPixelRatio(lofi.pixelRatio(cssHeight)); renderer.setSize(w, h, false); composer.setSize(w, h); lofi.fitted();
//   lofi.update();            // each frame: adopts new materials into the wobble (cheap)
//   lofi.set({ dither: 0.8 }) // live, as a Studio look slot changes (a new `lines` takes effect on the next resize)
//   lofi.dispose()
//
// Its parts, usable alone (the tests use them one by one):
//   lofiScale(params, cssHeight, dpr)  → { scale, pixelRatio, lines }: whole screen pixels a lofi pixel
//   LofiEffect                          a postprocessing Effect: ordered dither (Bayer 2, 4 or 8), then a palette snap
//                                       (nearest of up to 32 colours) or `steps` levels a channel
//   wobble(material, uniforms)          patches a material: vertices snap to the pixel grid (`wobble`, in lofi
//                                       pixels), its map is sampled affinely (`affine`, 0..1)
import * as THREE from 'three';
import { Effect, EffectPass, BlendFunction } from 'postprocessing';

export const LOFI_DEFAULTS = Object.freeze({
  lines: 270,         // the picture's height in lofi pixels (a 1080p screen shows each as 4×4)
  dither: 0.6,        // ordered dither strength: 0 none, 1 a whole colour step
  bayer: 4,           // the dither matrix: 2, 4 or 8
  steps: 7,           // colour levels a channel when there is no palette
  palette: null,      // up to 32 colours ('#rrggbb'); every pixel snaps to the nearest, after the dither
  paletteMix: 1,      // 0: the dithered colour as it is, 1: snapped to the palette
  wobble: 1,          // vertex snap grid in lofi pixels (0: off)
  affine: 0.7,        // 0: textures sampled with perspective, 1: affine (they swim across large triangles)
});
export const MAX_PALETTE = 32;
const BAYERS = [2, 4, 8];

/** The defaults with `p` over them, each value checked and clamped. Pure. */
export function lofiParams(p = {}) {
  const o = { ...LOFI_DEFAULTS, ...(p ?? {}) };
  const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
  const out = {
    lines: Math.round(num(o.lines, 90, 1080, LOFI_DEFAULTS.lines)),
    dither: num(o.dither, 0, 2, LOFI_DEFAULTS.dither),
    bayer: BAYERS.includes(+o.bayer) ? +o.bayer : LOFI_DEFAULTS.bayer,
    steps: Math.round(num(o.steps, 2, 64, LOFI_DEFAULTS.steps)),
    palette: null,
    paletteMix: num(o.paletteMix, 0, 1, 1),
    wobble: num(o.wobble, 0, 8, LOFI_DEFAULTS.wobble),
    affine: num(o.affine, 0, 1, LOFI_DEFAULTS.affine),
  };
  if (Array.isArray(o.palette) && o.palette.length) {
    const ok = o.palette.filter(c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c));
    if (ok.length !== o.palette.length) throw new Error(`lofi: palette colours must be '#rrggbb' (got ${JSON.stringify(o.palette.filter(c => !ok.includes(c)))})`);
    if (ok.length > MAX_PALETTE) throw new Error(`lofi: at most ${MAX_PALETTE} palette colours (got ${ok.length})`);
    out.palette = ok.map(c => c.toLowerCase());
  }
  return out;
}

/** Whole screen pixels per lofi pixel for a canvas `cssHeight` CSS pixels tall at `dpr`, and the renderer's pixel ratio
 *  that draws it. The scale is whole so every lofi pixel is the same square on screen. Pure. */
export function lofiScale(params, cssHeight, dpr = 1) {
  const { lines } = lofiParams(params);
  const device = Math.max(1, Math.round(cssHeight * dpr));
  const scale = Math.max(1, Math.round(device / lines));
  return { scale, pixelRatio: dpr / scale, lines: Math.round(device / scale) };
}

/** The ordered dither threshold at integer pixel (x, y) for a Bayer matrix of side n, in [0, 1). The shader's formula,
 *  in JS, so tests can check it is a true Bayer matrix (every threshold once). Pure. */
export function bayerAt(x, y, n = 4) {
  const b2 = (ax, ay) => { ax = Math.floor(ax); ay = Math.floor(ay); const f = v => v - Math.floor(v); return f(ax * 0.5 + ay * ay * 0.75); };
  if (n === 2) return b2(x, y);
  const b4 = (ax, ay) => b2(ax * 0.5, ay * 0.5) * 0.25 + b2(ax, ay);
  if (n === 4) return b4(x, y);
  return b4(x * 0.5, y * 0.5) * 0.25 + b2(x, y);
}

/** Palette colours as linear-free sRGB triples 0..1 (the snap is done in display space). Pure. */
export const paletteRgb = palette => (palette ?? []).map(c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255));

const FRAG = /* glsl */`
uniform float uDither; uniform float uSteps; uniform float uBayer; uniform float uMix; uniform int uCount;
uniform vec3 uPalette[${MAX_PALETTE}];
float gfB2( vec2 a ) { a = floor( a ); return fract( dot( a, vec2( 0.5, a.y * 0.75 ) ) ); }
float gfB4( vec2 a ) { return gfB2( 0.5 * a ) * 0.25 + gfB2( a ); }
float gfB8( vec2 a ) { return gfB4( 0.5 * a ) * 0.25 + gfB2( a ); }
vec3 gfToSrgb( vec3 c ) { return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) ); }
vec3 gfToLinear( vec3 c ) { return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) ); }
void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
  vec2 px = gl_FragCoord.xy;
  float b = uBayer < 3.0 ? gfB2( px ) : uBayer < 6.0 ? gfB4( px ) : gfB8( px );
  vec3 c = gfToSrgb( clamp( inputColor.rgb, 0.0, 1.0 ) );
  float step_ = 1.0 / ( uSteps - 1.0 );
  vec3 d = c + ( b - 0.5 ) * uDither * step_;
  vec3 q = clamp( floor( d / step_ + 0.5 ) * step_, 0.0, 1.0 );
  if ( uCount > 0 ) {
    // the nearest palette colour, by a weighted distance that tracks the eye ("redmean")
    float best = 1e9; vec3 pick = q;
    for ( int i = 0; i < ${MAX_PALETTE}; i++ ) {
      if ( i >= uCount ) break;
      vec3 p = uPalette[ i ], e = d - p;
      float r = 0.5 * ( d.r + p.r );
      float dist = ( 2.0 + r ) * e.r * e.r + 4.0 * e.g * e.g + ( 3.0 - r ) * e.b * e.b;
      if ( dist < best ) { best = dist; pick = p; }
    }
    q = mix( q, pick, uMix );
  }
  outputColor = vec4( gfToLinear( q ), inputColor.a );
}`;

/** The dither and palette, as a postprocessing Effect (an EffectPass of its own, after the look's main pass). */
export class LofiEffect extends Effect {
  constructor(params = {}) {
    super('LofiEffect', FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['uDither', new THREE.Uniform(0)], ['uSteps', new THREE.Uniform(7)], ['uBayer', new THREE.Uniform(4)], ['uMix', new THREE.Uniform(1)],
        ['uCount', new THREE.Uniform(0)], ['uPalette', new THREE.Uniform(Array.from({ length: MAX_PALETTE }, () => new THREE.Vector3()))],
      ]),
    });
    this.set(params);
  }
  set(params) {
    const p = lofiParams(params), u = this.uniforms;
    u.get('uDither').value = p.dither; u.get('uSteps').value = p.steps; u.get('uBayer').value = p.bayer; u.get('uMix').value = p.paletteMix;
    const rgb = paletteRgb(p.palette);
    u.get('uCount').value = rgb.length;
    rgb.forEach((c, i) => u.get('uPalette').value[i].set(...c));
    this.params = p;
    return p;
  }
}

/** Shared uniforms of the vertex wobble (one object for every patched material, so a resize reaches them all). */
export function wobbleUniforms() {
  return { uLofiGrid: { value: new THREE.Vector2(480, 270) }, uLofiWobble: { value: 1 }, uLofiAffine: { value: 0.7 } };
}

/** Patch one material: vertices snap to the lofi grid; its map is sampled affinely. Chains any onBeforeCompile the
 *  material already has (the house materials do). Idempotent. → the material */
export function wobble(material, uniforms) {
  if (!material || material.userData?.gfLofi) return material;
  const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey?.bind(material);
  material.onBeforeCompile = (sh, r) => {
    prev?.call(material, sh, r);
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uLofiGrid; uniform float uLofiWobble; uniform float uLofiAffine;\nvarying vec3 vLofiUvW;')
      .replace('#include <project_vertex>', `#include <project_vertex>
  if ( uLofiWobble > 0.0 ) {
    vec2 g = uLofiGrid * 0.5 / uLofiWobble;
    vec2 ndc = gl_Position.xy / gl_Position.w;
    gl_Position.xy = floor( ndc * g + 0.5 ) / g * gl_Position.w;
  }
  #ifdef USE_MAP
    vLofiUvW = vec3( vMapUv * gl_Position.w, gl_Position.w );
  #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uLofiAffine;\nvarying vec3 vLofiUvW;')
      .replace('#include <map_fragment>', THREE.ShaderChunk.map_fragment.replace(/vMapUv/g, 'mix( vMapUv, vLofiUvW.xy / vLofiUvW.z, uLofiAffine )'));
  };
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|gf-lofi`;
  material.userData.gfLofi = true;
  material.needsUpdate = true;
  return material;
}

/** Patch every material under `root` that is not patched yet. → how many were patched */
export function wobbleTree(root, uniforms) {
  let n = 0;
  root?.traverse?.(o => {
    if (!o.isMesh || o.isSprite) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m && !m.userData?.gfLofi && !m.isShaderMaterial) { wobble(m, uniforms); n++; }
  });
  return n;
}

/**
 * Attach the pass to a composer (the look's): a LofiEffect pass after the composer's last, the wobble on the scene's
 * materials, hard pixels on the canvas. The caller sizes it: pixelRatio(cssHeight) is the renderer's pixel ratio that
 * draws the picture `lines` tall, and fitted() after the renderer and the composer are sized.
 */
export function attachLofi(composer, renderer, scene, params = {}) {
  let p = lofiParams(params);
  const effect = new LofiEffect(p);
  const uniforms = wobbleUniforms();
  const canvas = renderer.domElement;
  if (canvas?.style) canvas.style.imageRendering = 'pixelated';
  const pass = new EffectPass(new THREE.Camera(), effect);             // the dither reads colour only, never depth
  composer.addPass(pass);                                               // the last pass draws to the screen
  let scaleInfo = null, frame = 0;
  function apply() { uniforms.uLofiWobble.value = p.wobble; uniforms.uLofiAffine.value = p.affine; effect.set(p); }
  apply();
  wobbleTree(scene, uniforms);
  return {
    effect, uniforms, pass,
    get params() { return p; }, get scale() { return scaleInfo; },
    pixelRatio(cssHeight, dpr = globalThis.devicePixelRatio || 1) { scaleInfo = lofiScale(p, cssHeight, dpr); return scaleInfo.pixelRatio; },
    fitted() { const db = renderer.getDrawingBufferSize(new THREE.Vector2()); uniforms.uLofiGrid.value.set(db.x, db.y); },
    set(next) { p = lofiParams({ ...p, ...next }); apply(); return p; },
    adopt(root) { return wobbleTree(root, uniforms); },
    update() { if (++frame % 30 === 0) wobbleTree(scene, uniforms); },
    dispose() { composer.removePass(pass); pass.dispose(); effect.dispose(); if (canvas?.style) canvas.style.imageRendering = ''; },
  };
}
