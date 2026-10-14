// House materials for gf-three (track L). Every material is a three.js MeshStandardMaterial or MeshPhysicalMaterial
// with a small shader patch, so shadows, fog, skinning, instancing and the env map all keep working.
// The look of each kind (wrap, bands, rim, subsurface, colour treatment...) lives in shared uniforms that the active
// look preset fills (look.json -> materials.<kind>), so a preset or time-of-day change restyles every material live.
//
//   material(kind, { tint, map, color, ... })   kind: character | prop | ground | water | liquid | glow | decal
//   adoptMaterials(object3d, kind, { tint, materials: { <gltf material name>: kind } })  swap a GLB's materials in place
//
// Nothing here draws art: textures come from slots (opts.map, look.textures), colours from tints and the preset.
import * as THREE from 'three';

// 'decal' (added by the wave-1 polish track): flat things lying on the ground (paint, splats, marks). It shares the
// ground's uniforms and base values (wrap, bands, shadow floor, colour treatment, no rim), so a decal sits in exactly
// the ground's light and shadow, at night too, but it has none of the ground's noise detail, so its colours stay its own.
const KINDS = ['character', 'prop', 'ground', 'water', 'liquid', 'glow', 'decal'];
const C = (v) => new THREE.Color(v);

// One uniform set per kind, shared by every material of that kind.
function kindUniforms() {
  return {
    uGfWrap: { value: 0.4 }, uGfBands: { value: 0 }, uGfBandSoft: { value: 0.06 }, uGfShadowFloor: { value: 0 },
    uGfRim: { value: 0.2 }, uGfRimPow: { value: 3 }, uGfRimColor: { value: C('#ffffff') }, uGfRimLight: { value: 0.5 },
    uGfSss: { value: 0 }, uGfSssColor: { value: C('#ff8080') },
    uGfSat: { value: 1 }, uGfLift: { value: 0 }, uGfLiftColor: { value: C('#ffffff') },
    uGfToonSpec: { value: 0 }, uGfSpecSize: { value: 0.97 },
    uGfTime: { value: 0 },
  };
}
export const U = Object.fromEntries(KINDS.map(k => [k, kindUniforms()]));
U.decal = U.ground;   // the same objects: the preset's ground block restyles decals live
// kind-specific extras
Object.assign(U.ground, { uGfColorB: { value: C('#88cc66') }, uGfDetail: { value: 0.35 }, uGfTile: { value: 6 }, uGfNoise: { value: null },
  // the world's ground pattern (paving, carpet tiles, mowing stripes; a texture slot): per material, off by default
  uGfPattern: { value: null }, uGfPatternSize: { value: 4 }, uGfPatternOn: { value: 0 }, uGfPatternStrength: { value: 1 } });
Object.assign(U.water, {
  uGfShallow: { value: C('#8ee8ff') }, uGfDeep: { value: C('#2f8fe0') }, uGfFoam: { value: C('#ffffff') }, uGfFresnel: { value: 0.6 },
  uGfSpeed: { value: 0.4 }, uGfRipple: { value: 0.5 }, uGfSparkle: { value: 0.8 }, uGfNoise: { value: null },
});
Object.assign(U.liquid, {
  uGfCore: { value: C('#ffffff') }, uGfFresnel: { value: 0.8 }, uGfGlow: { value: 0.2 }, uGfSpeed: { value: 2.5 }, uGfNoise: { value: null }, uGfStreak: { value: 0.5 },
});
Object.assign(U.glow, { uGfGlow: { value: 3 } });

// Base values per kind (roughness etc.) set by the preset; read when a material is created.
export const base = Object.fromEntries(KINDS.map(k => [k, { roughness: 0.7, metalness: 0, clearcoat: 0, clearcoatRoughness: 0.3, envIntensity: 1, emissive: 0 }]));
base.decal = base.ground;
const made = new Set();   // every live house material (WeakRef-free: materials are few and long-lived)

// The world's light on a material: a world that lights its own cells (the voxel world's sun and lamps) says how much
// sky reaches a point and what light it adds there (world.lightAt), and a body standing there takes it. Each material
// set with setWorldLight reads its own pair of uniforms; every other house material reads the neutral pair (full sky,
// nothing added), so nothing changes for them.
//   uGfWorldLight (sky 0-1: scales the sun and the sky; ambient 0-1: how much of the sky's light stays where no sky
//   reaches), uGfWorldBlock (rgb, linear: light added in its own colour, times the surface colour)
const WORLD_NEUTRAL = { uGfWorldLight: { value: new THREE.Vector2(1, 1) }, uGfWorldBlock: { value: new THREE.Vector3(0, 0, 0) } };
const worldLit = new WeakMap();
/** A fresh pair of world-light uniforms (one per body: every material of that body shares it). */
export function worldLightUniforms() { return { uGfWorldLight: { value: new THREE.Vector2(1, 1) }, uGfWorldBlock: { value: new THREE.Vector3(0, 0, 0) } }; }
/** Light a house material by these world-light uniforms (worldLightUniforms()); it is compiled again to read them. */
export function setWorldLight(mat, uniforms) { if (!mat) return; worldLit.set(mat, uniforms); mat.needsUpdate = true; }

const HEADER = /* glsl */`
uniform float uGfWrap; uniform float uGfBands; uniform float uGfBandSoft; uniform float uGfShadowFloor;
uniform float uGfRim; uniform float uGfRimPow; uniform vec3 uGfRimColor; uniform float uGfRimLight;
uniform float uGfSss; uniform vec3 uGfSssColor;
uniform float uGfSat; uniform float uGfLift; uniform vec3 uGfLiftColor;
uniform float uGfToonSpec; uniform float uGfSpecSize; uniform float uGfTime;
uniform vec2 uGfWorldLight; uniform vec3 uGfWorldBlock;
float gfShadow = 1.0; float gfSunLit = 0.0;
vec3 gfColor( vec3 c ) {
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = max( mix( vec3( l ), c, uGfSat ), 0.0 );
  return mix( c, uGfLiftColor, uGfLift );
}
float gfBand( float x ) {
  if ( uGfBands < 0.5 ) return x;
  float b = x * uGfBands; float f = fract( b );
  return ( floor( b ) + smoothstep( 0.5 - uGfBandSoft, 0.5 + uGfBandSoft, f ) ) / uGfBands;
}
`;

const DIRECT = /float dotNL = saturate\( dot\( geometryNormal, directLight\.direction \) \);\s*vec3 irradiance = dotNL \* directLight\.color;/;
const STYLISED_DIRECT = /* glsl */`
	float gfNdl = dot( geometryNormal, directLight.direction );
	float gfSh = gfShadow; gfShadow = 1.0;
	vec3 gfLightCol = directLight.color / max( gfSh, 1e-3 );
	float gfLit = gfBand( saturate( ( gfNdl + uGfWrap ) / ( 1.0 + uGfWrap ) ) * max( gfSh, uGfShadowFloor ) );
	gfSunLit = max( gfSunLit, gfLit );
	float dotNL = gfLit;
	vec3 irradiance = gfLit * gfLightCol;
	// subsurface: warm light bleeding at the terminator and through back-lit edges
	float gfTerm = saturate( 1.0 - abs( gfNdl ) * 1.6 ) * gfSh;
	float gfBack = pow( saturate( dot( geometryViewDir, - directLight.direction ) ), 3.0 );
	reflectedLight.directDiffuse += uGfSss * uGfSssColor * gfLightCol * material.diffuseContribution * ( 0.5 * gfTerm + 0.5 * gfBack );
	// toon highlight: a crisp spot instead of (or on top of) GGX
	if ( uGfToonSpec > 0.0 ) {
		float gfNh = dot( geometryNormal, normalize( directLight.direction + geometryViewDir ) );
		reflectedLight.directSpecular += smoothstep( uGfSpecSize - 0.012, uGfSpecSize + 0.012, gfNh ) * uGfToonSpec * gfLightCol * gfSh;
	}
`;
// GGX keeps the true N.L: wrapped irradiance on faces turned away from the light would hit the BRDF's 1/(N.V) term
// at silhouettes and blow up into fireflies.
const SPEC = /reflectedLight\.directSpecular \+= irradiance \* specularBRDF/;
const SPEC_TRUE = 'reflectedLight.directSpecular += saturate( gfNdl ) * directLight.color * specularBRDF';
const SHADOW_DIR = /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ i \]([^;]*);/;

const RIM = /* glsl */`
	{
		float gfNv = saturate( dot( geometryNormal, geometryViewDir ) );
		float gfRimT = pow( 1.0 - gfNv, uGfRimPow ) * uGfRim;
		reflectedLight.indirectDiffuse += gfRimT * uGfRimColor * mix( 1.0, gfSunLit, uGfRimLight );
	}
`;

// the world's light where this surface is (setWorldLight; neutral: nothing changes)
const WORLD = /* glsl */`
	{
		float gfSkyW = uGfWorldLight.x, gfAmbW = mix( uGfWorldLight.y, 1.0, gfSkyW );
		reflectedLight.directDiffuse *= gfSkyW; reflectedLight.directSpecular *= gfSkyW;
		reflectedLight.indirectDiffuse *= gfAmbW; reflectedLight.indirectSpecular *= gfAmbW;
		reflectedLight.indirectDiffuse += diffuseColor.rgb * uGfWorldBlock;
	}
`;

function patchLights(fs) {
  const pars = THREE.ShaderChunk.lights_physical_pars_fragment;
  if (!DIRECT.test(pars) || !SPEC.test(pars)) throw new Error('gf-three look: three.js lighting chunk changed (RE_Direct_Physical); update kit/look/materials.js');
  const begin = THREE.ShaderChunk.lights_fragment_begin;
  if (!SHADOW_DIR.test(begin)) throw new Error('gf-three look: three.js lighting chunk changed (lights_fragment_begin); update kit/look/materials.js');
  return fs
    .replace('#include <common>', '#include <common>\n' + HEADER)
    .replace('#include <lights_physical_pars_fragment>', pars.replace(DIRECT, STYLISED_DIRECT).replace(SPEC, SPEC_TRUE))
    .replace('#include <lights_fragment_begin>', begin.replace(SHADOW_DIR, 'gfShadow = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]$1; directLight.color *= gfShadow;'))
    .replace('#include <map_fragment>', '#include <map_fragment>\n\tdiffuseColor.rgb = gfColor( diffuseColor.rgb );')
    .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + RIM + WORLD);
}

// world position varying for ground / water / liquid
const VERT_WORLD = (vs) => vs
  .replace('#include <common>', '#include <common>\nvarying vec3 vGfWorld;\nvarying vec2 vGfUv;')
  .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
	{
		vec4 gfWp = vec4( transformed, 1.0 );
		#ifdef USE_INSTANCING
			gfWp = instanceMatrix * gfWp;
		#endif
		vGfWorld = ( modelMatrix * gfWp ).xyz;
		vGfUv = uv;
	}`);

const KIND_FRAG = {
  ground: (fs) => fs
    .replace('#include <common>', '#include <common>\nvarying vec3 vGfWorld;\nvarying vec2 vGfUv;\nuniform vec3 uGfColorB; uniform float uGfDetail; uniform float uGfTile; uniform sampler2D uGfNoise;\nuniform sampler2D uGfPattern; uniform float uGfPatternSize; uniform float uGfPatternOn; uniform float uGfPatternStrength;')
    .replace('#include <map_fragment>', `#include <map_fragment>
	{
		vec2 gp = vGfWorld.xz / uGfTile;
		float n1 = texture2D( uGfNoise, gp ).r;
		float n2 = texture2D( uGfNoise, gp * 3.7 + 0.31 ).g;
		float n = n1 * 0.7 + n2 * 0.3;
		diffuseColor.rgb = mix( diffuseColor.rgb, uGfColorB, smoothstep( 0.35, 0.75, n ) * uGfDetail * 2.0 );
		diffuseColor.rgb *= 1.0 - uGfDetail * 0.25 * ( n2 - 0.5 );
		// the ground pattern multiplies on top (world space, so it tiles the same at any ground size)
		if ( uGfPatternOn > 0.5 ) diffuseColor.rgb *= mix( vec3( 1.0 ), texture2D( uGfPattern, vGfWorld.xz / uGfPatternSize ).rgb, uGfPatternStrength );
	}`),
  water: (fs) => fs
    .replace('#include <common>', '#include <common>\nvarying vec3 vGfWorld;\nvarying vec2 vGfUv;\nuniform vec3 uGfShallow; uniform vec3 uGfDeep; uniform vec3 uGfFoam; uniform float uGfFresnel; uniform float uGfSpeed; uniform float uGfRipple; uniform float uGfSparkle; uniform sampler2D uGfNoise;\nfloat gfWaterH( vec2 p ) { float t = uGfTime * uGfSpeed; return texture2D( uGfNoise, p * 0.35 + vec2( t * 0.05, t * 0.03 ) ).r * 0.6 + texture2D( uGfNoise, p * 0.9 - vec2( t * 0.04, -t * 0.06 ) ).g * 0.4; }')
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
	{
		vec2 wp = vGfWorld.xz;
		float e = 0.08;
		float h0 = gfWaterH( wp ), hx = gfWaterH( wp + vec2( e, 0.0 ) ), hz = gfWaterH( wp + vec2( 0.0, e ) );
		vec3 wn = normalize( vec3( ( h0 - hx ) * uGfRipple * 6.0, 1.0, ( h0 - hz ) * uGfRipple * 6.0 ) );
		normal = normalize( ( viewMatrix * vec4( wn, 0.0 ) ).xyz );
	}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
	{
		vec3 V = normalize( vViewPosition );
		float facing = saturate( dot( normal, V ) );
		float fres = pow( 1.0 - facing, 3.0 ) * uGfFresnel;
		float h = gfWaterH( vGfWorld.xz * 1.7 );
		diffuseColor.rgb = mix( uGfDeep, uGfShallow, saturate( facing * 0.6 + h * 0.6 ) );
		diffuseColor.rgb = mix( diffuseColor.rgb, uGfFoam, smoothstep( 0.78, 0.86, h ) * 0.55 );
		totalEmissiveRadiance += uGfFoam * smoothstep( 0.9, 0.93, gfWaterH( vGfWorld.xz * 2.3 + 1.7 ) ) * uGfSparkle;
		totalEmissiveRadiance += uGfShallow * fres * 0.25;
	}`),
  liquid: (fs) => fs
    .replace('#include <common>', '#include <common>\nvarying vec3 vGfWorld;\nvarying vec2 vGfUv;\nuniform vec3 uGfCore; uniform float uGfFresnel; uniform float uGfGlow; uniform float uGfSpeed; uniform sampler2D uGfNoise; uniform float uGfStreak;')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
	{
		vec3 V = normalize( vViewPosition );
		float facing = saturate( abs( dot( normal, V ) ) );
		float streak = texture2D( uGfNoise, vec2( vGfUv.x * 0.6 - uGfTime * uGfSpeed * 0.35, vGfUv.y * 0.5 ) ).r;
		float core = smoothstep( 0.35, 0.95, facing );
		diffuseColor.rgb = mix( diffuseColor.rgb, uGfCore, core * 0.22 + smoothstep( 0.55, 0.8, streak ) * uGfStreak * 0.45 );
		totalEmissiveRadiance += diffuseColor.rgb * uGfGlow + mix( diffuseColor.rgb, uGfCore, 0.5 ) * pow( 1.0 - facing, 2.5 ) * uGfFresnel * 0.5;
	}`),
  glow: (fs) => fs
    .replace('#include <common>', '#include <common>\nuniform float uGfGlow;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance = diffuseColor.rgb * uGfGlow;'),
};

function stylise(mat, kind, own = null) {
  const uni = U[kind];
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni, own ?? {}, worldLit.get(mat) ?? WORLD_NEUTRAL);
    let fs = sh.fragmentShader;
    if (KIND_FRAG[kind]) {
      sh.vertexShader = VERT_WORLD(sh.vertexShader);
      fs = KIND_FRAG[kind](fs);
    }
    sh.fragmentShader = patchLights(fs);
  };
  mat.customProgramCacheKey = () => `gf-look-${kind}`;
  mat.userData.gfKind = kind;
  // Material.clone() drops onBeforeCompile; a cloned house material (e.g. a per-character tint copy) stays a house material
  const baseClone = mat.clone;
  mat.clone = function () {
    const c = baseClone.call(this);
    const copy = own ? Object.fromEntries(Object.entries(own).map(([k, u]) => [k, { value: u.value?.isColor ? u.value.clone() : u.value }])) : null;
    if (copy) ownUniforms(c, copy);
    return stylise(c, kind, copy);
  };
  made.add(mat);
  return mat;
}

/**
 * A house material. opts: tint (colour), color (base colour before tint), map, vertexColors, transparent, opacity,
 * alphaTest, side, emissive, emissiveMap, emissiveIntensity, normalMap. Missing opts take the preset's values.
 */
export function material(kind, opts = {}) {
  if (!KINDS.includes(kind)) throw new Error(`gf-three look: unknown material kind "${kind}" (${KINDS.join(', ')})`);
  const b = base[kind];
  const physical = kind === 'character' || kind === 'liquid';
  const Ctor = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const m = new Ctor({
    color: opts.color !== undefined ? C(opts.color) : C('#ffffff'),
    map: opts.map ?? null, vertexColors: !!opts.vertexColors,
    roughness: opts.roughness ?? b.roughness, metalness: opts.metalness ?? b.metalness,
    transparent: !!opts.transparent, opacity: opts.opacity ?? 1, alphaTest: opts.alphaTest ?? 0,
    side: opts.side ?? THREE.FrontSide, normalMap: opts.normalMap ?? null,
    emissive: opts.emissive !== undefined ? C(opts.emissive) : C('#000000'), emissiveMap: opts.emissiveMap ?? null,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    envMapIntensity: opts.envIntensity ?? b.envIntensity,
  });
  if (physical) { m.clearcoat = opts.clearcoat ?? b.clearcoat; m.clearcoatRoughness = opts.clearcoatRoughness ?? b.clearcoatRoughness; }
  if (opts.tint !== undefined && opts.tint !== null) m.color.multiply(C(opts.tint));
  if (kind === 'glow') { m.emissive.set('#ffffff'); }
  m.userData.gfTint = opts.tint ?? null;
  m.userData.gfBaseColor = m.color.clone();
  // per-material uniforms: the ground's second colour and its pattern belong to the world, not the preset
  let own = null;
  if (kind === 'ground' && (opts.color2 !== undefined || opts.patternSize !== undefined || opts.pattern)) {
    own = {};
    if (opts.color2 !== undefined) own.uGfColorB = { value: C(opts.color2) };
    if (opts.patternSize !== undefined || opts.pattern) Object.assign(own, {
      uGfPattern: { value: opts.pattern ?? null }, uGfPatternSize: { value: opts.patternSize ?? 4 },
      uGfPatternOn: { value: opts.pattern ? 1 : 0 }, uGfPatternStrength: { value: opts.patternStrength ?? 1 },
    });
  }
  if (own) ownUniforms(m, own);
  return stylise(m, kind, own);
}
// non-enumerable: Material.copy JSON-clones userData, and a texture in it would be serialised
const ownUniforms = (m, own) => Object.defineProperty(m.userData, 'gfUniforms', { value: own, enumerable: false, configurable: true, writable: true });

/** Give a ground material (made with a patternSize) its pattern texture once it has loaded. */
export function setGroundPattern(mat, texture, { size, strength } = {}) {
  const u = mat?.userData?.gfUniforms;
  if (!u?.uGfPattern) return false;
  u.uGfPattern.value = texture; u.uGfPatternOn.value = texture ? 1 : 0;
  if (size !== undefined) u.uGfPatternSize.value = size;
  if (strength !== undefined) u.uGfPatternStrength.value = strength;
  return true;
}

/** Restyle every house material from the preset's `materials` block (called by applyLook; values are already resolved). */
export function configureMaterials(mats, textures = {}) {
  for (const kind of KINDS) {
    const p = mats?.[kind]; if (!p) continue;
    const u = U[kind];
    const set = (k, v) => { if (v !== undefined && u[k]) { if (u[k].value?.isColor) u[k].value.set(v); else u[k].value = v; } };
    set('uGfWrap', p.wrap); set('uGfBands', p.bands); set('uGfBandSoft', p.bandSoftness); set('uGfShadowFloor', p.shadowFloor);
    set('uGfRim', p.rim); set('uGfRimPow', p.rimPower); set('uGfRimColor', p.rimColor); set('uGfRimLight', p.rimLightOnly);
    set('uGfSss', p.subsurface); set('uGfSssColor', p.subsurfaceColor);
    set('uGfSat', p.saturation); set('uGfLift', p.lift); set('uGfLiftColor', p.liftColor);
    set('uGfToonSpec', p.toonSpecular); set('uGfSpecSize', p.toonSpecularSize);
    set('uGfColorB', p.colorB); set('uGfDetail', p.detail); set('uGfTile', p.tile);
    set('uGfShallow', p.shallow); set('uGfDeep', p.deep); set('uGfFoam', p.foam); set('uGfFresnel', p.fresnel);
    set('uGfSpeed', p.speed); set('uGfRipple', p.ripple); set('uGfSparkle', p.sparkle);
    set('uGfCore', p.core); set('uGfGlow', p.glow); set('uGfStreak', p.streak);
    Object.assign(base[kind], {
      roughness: p.roughness ?? base[kind].roughness, metalness: p.metalness ?? base[kind].metalness,
      clearcoat: p.clearcoat ?? base[kind].clearcoat, clearcoatRoughness: p.clearcoatRoughness ?? base[kind].clearcoatRoughness,
      envIntensity: p.envIntensity ?? base[kind].envIntensity,
    });
  }
  if (textures.noise) for (const k of ['ground', 'water', 'liquid']) U[k].uGfNoise.value = textures.noise;
  // existing materials take the new per-material base values (uniforms are shared, so they already follow)
  for (const m of made) {
    const b = base[m.userData.gfKind]; if (!b) continue;
    if (!m.userData.gfOwnRoughness) m.roughness = b.roughness;
    m.envMapIntensity = b.envIntensity;
    if (m.isMeshPhysicalMaterial) { m.clearcoat = b.clearcoat; m.clearcoatRoughness = b.clearcoatRoughness; }
  }
}

export function tickMaterials(t) { for (const k of KINDS) U[k].uGfTime.value = t; }

/** Set a house material's tint (keeps its base colour). */
export function setTint(mat, tint) {
  mat.color.copy(mat.userData.gfBaseColor ?? mat.color);
  if (tint !== undefined && tint !== null) mat.color.multiply(C(tint));
  mat.userData.gfTint = tint;
}

const adoptCache = new Map();
/**
 * Replace the materials of a loaded model (GLB) with house materials, keeping each source material's colour, map,
 * vertex colours, transparency and emissive. opts.materials maps a source material name to a kind (e.g. {Water:'water'}).
 * opts.tintMaterials: names of the source materials the tint applies to (default: all; names starting "tint" always do
 * when a list is given, as in bodies.json). opts.tintMode: 'multiply' (props: shade the authored colour) or 'replace'
 * (bodies: the tint is the colour, like kit/character's setTint with gfTintMix 1).
 * Materials are cached per (source material, kind, tint), so instances share programs and uniforms.
 */
export function adoptMaterials(root, kind, opts = {}) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const next = list.map((src) => {
      if (!src) return src;
      const k = opts.materials?.[src.name] ?? kind;
      // tintMaterials: only these source materials take the tint (a body's skin, not its eyes or shoes)
      const tintable = opts.tintMaterials ? opts.tintMaterials.includes(src.name) || /^tint/i.test(src.name) : true;
      const tint = tintable ? opts.tint : undefined;
      // already a house material of this kind and nothing to tint: keep it (adopting twice, e.g. a bench's assets shim
      // and then kit/character's spawnCharacter, is a no-op)
      if (src.userData?.gfKind === k && tint === undefined) return src;
      const replace = tint !== undefined && (opts.tintMode ?? 'multiply') === 'replace';
      const key = `${src.uuid}|${k}|${tint ?? ''}|${replace}`;
      if (adoptCache.has(key)) return adoptCache.get(key);
      const m = material(k, {
        color: replace ? '#ffffff' : (src.color ?? '#ffffff'), map: src.map ?? null, vertexColors: src.vertexColors,
        transparent: src.transparent, opacity: src.opacity, alphaTest: src.alphaTest, side: src.side,
        emissive: src.emissive, emissiveMap: src.emissiveMap ?? null, emissiveIntensity: src.emissiveIntensity,
        normalMap: k === 'water' ? null : (src.normalMap ?? null), tint,
      });
      m.name = src.name;
      adoptCache.set(key, m);
      return m;
    });
    o.material = Array.isArray(o.material) ? next : next[0];
  });
  return root;
}

export { KINDS };
