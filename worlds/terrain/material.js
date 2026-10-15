// gf-three smooth terrain: the ground's material. The house 'ground' material (so the look's light, bands, shadow floor,
// fog and colour treatment apply as they do to every ground), with the terrain's own paint on top:
//   - the top surface (grass, candy, sand, ...) where the ground faces up and was not cut, projected from above;
//   - a lip of it running a little way down the steep faces under the top edge (`lip` m), its edge broken by noise;
//   - the soil cross-section everywhere else (cliffs, cut faces, tunnel walls), projected from the side so its layers run
//     level whichever way a face turns (triplanar), darker in bands with depth (`strata`); with a `cliff` picture, the
//     faces the ground was made with (cliffs, tunnel walls) show it instead, and only what a blast cut shows the soil;
//   - an ink line where the top meets the soil (`ink`; `inkWidth` about pixels a side, 0 none): the cartoon edge.
// Which is which comes from the mesh: each vertex carries its depth below the ground's original top and how far inside
// the original ground it is (mesh.mjs `ter`), so a crater shows soil where it bit and grass where it did not.
// A composed level's set pieces are ground too (mesh.mjs `own`: which piece a vertex belongs to): their own surface is
// left to their models (world.js draws them, clipped where blasts took ground), and what a blast cut into one is drawn
// here, in the piece's inside colour (`built`, one a piece) over the soil picture's shading.
import * as THREE from 'three';
import { material } from '../../look/materials.js';

export const MATERIAL_DEFAULTS = {
  top: { color: '#ffffff', size: 6, tint: '#ffffff' },       // size: metres per tile of the top picture
  soil: { color: '#8a5a36', size: 7, tint: '#ffffff' },      // size: metres per tile (the layers' spacing follows it)
  cliff: null,                                               // { color, size, tint }: the made faces' own picture (rock strata), else the soil
  sand: { color: '#e9cf8f', below: -100 },                   // flat ground lower than `below` (m above the sea) is sand
  lip: 0.7, slope: [0.45, 0.65], strata: 0.18, ink: '#3a2414', inkWidth: 1.2, detail: 0,   // inkWidth: about pixels a side
};

const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b ?? {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a?.[k] && typeof a[k] === 'object' ? { ...a[k], ...v } : v; return o; };

/** One white pixel: the picture a layer draws with until its texture slot has loaded (or when it has none). */
function white() { const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); t.needsUpdate = true; return t; }

/** The terrain material. opts: MATERIAL_DEFAULTS' shape. → { material, setTexture(layer, texture), values } */
export function createTerrainMaterial(opts = {}) {
  const V = merge(MATERIAL_DEFAULTS, opts);
  const mat = material('ground', { color: '#ffffff' });
  const C = c => new THREE.Color(c);
  const u = {
    uTerTop: { value: white() }, uTerSoil: { value: white() }, uTerCliff: { value: white() }, uTerCliffOn: { value: V.cliff ? 1 : 0 },
    uTerCliffSize: { value: V.cliff?.size ?? 8 }, uTerCliffTint: { value: V.cliff ? C(V.cliff.tint ?? '#ffffff').multiply(C(V.cliff.color ?? '#c9a473')) : C('#ffffff') },
    uTerTopSize: { value: V.top.size }, uTerSoilSize: { value: V.soil.size },
    // the colour each layer is drawn in: its picture (white until loaded) times its tint, times its colour while it has no picture
    uTerTopTint: { value: C(V.top.tint).multiply(C(V.top.color)) }, uTerSoilTint: { value: C(V.soil.tint).multiply(C(V.soil.color)) },
    uTerSand: { value: C(V.sand.color) }, uTerSandBelow: { value: V.sand.below },
    uTerLip: { value: V.lip }, uTerSlope: { value: new THREE.Vector2(V.slope[0], V.slope[1]) }, uTerStrata: { value: V.strata },
    uTerInk: { value: C(V.ink) }, uTerInkWidth: { value: V.inkWidth },
    uGfDetail: { value: V.detail }, uGfPatternOn: { value: 0 },
    // a composed level's pieces: the colour their cut faces show (piece n at n − 1), and how deep a cut must be before
    // the field draws it (shallower, the piece's model still stands there)
    uTerBuilt: { value: Array.from({ length: 8 }, () => C('#9a8f80')) }, uTerBuiltCut: { value: 0.06 },
  };
  const house = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    house(sh, r);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aTer;\nattribute float aOwn;\nvarying vec2 vTer;\nvarying vec3 vTerN;\nvarying float vOwn;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n\tvTer = aTer;\n\tvOwn = aOwn;\n\tvTerN = normalize( mat3( modelMatrix ) * objectNormal );');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vTer; varying vec3 vTerN; varying float vOwn; uniform vec3 uTerBuilt[ 8 ]; uniform float uTerBuiltCut;
uniform sampler2D uTerTop; uniform sampler2D uTerSoil; uniform float uTerTopSize; uniform float uTerSoilSize;
uniform sampler2D uTerCliff; uniform float uTerCliffOn; uniform float uTerCliffSize; uniform vec3 uTerCliffTint;
uniform vec3 uTerTopTint; uniform vec3 uTerSoilTint; uniform vec3 uTerSand; uniform float uTerSandBelow;
uniform float uTerLip; uniform vec2 uTerSlope; uniform float uTerStrata; uniform vec3 uTerInk; uniform float uTerInkWidth;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
	// a set piece's own surface: its model draws it (only a cut into it is the field's to draw)
	if ( vOwn > 0.5 && vTer.y < uTerBuiltCut ) discard;
	{
		vec3 tn = normalize( vTerN ), tp = vGfWorld;
		vec3 tw = pow( abs( tn ), vec3( 4.0 ) ); tw /= max( 1e-4, tw.x + tw.y + tw.z );
		// the soil from the side (its layers run level), from above on level cut floors
		vec3 soil = texture2D( uTerSoil, vec2( tp.z, tp.y ) / uTerSoilSize ).rgb * tw.x
		          + texture2D( uTerSoil, tp.xz / uTerSoilSize ).rgb * tw.y
		          + texture2D( uTerSoil, vec2( tp.x, tp.y ) / uTerSoilSize ).rgb * tw.z;
		soil *= uTerSoilTint;
		float tdepth = vTer.x, tcut = vTer.y;
		float tnz = texture2D( uGfNoise, tp.xz * 0.13 + tp.y * 0.07 ).r;
		// darker bands with depth (the layers of the cross-section)
		soil *= 1.0 - uTerStrata * smoothstep( 0.35, 0.65, fract( tdepth / ( uTerSoilSize * 0.5 ) + tnz * 0.35 ) ) - uTerStrata * 0.6 * smoothstep( 2.0, 14.0, tdepth );
		// the faces the ground was made with show the cliff's own picture; what a blast cut shows the soil
		if ( uTerCliffOn > 0.5 ) {
			vec3 rock = ( texture2D( uTerCliff, vec2( tp.z, tp.y ) / uTerCliffSize ).rgb * tw.x + texture2D( uTerCliff, tp.xz / uTerCliffSize ).rgb * tw.y
			            + texture2D( uTerCliff, vec2( tp.x, tp.y ) / uTerCliffSize ).rgb * tw.z ) * uTerCliffTint;
			soil = mix( rock, soil, smoothstep( 0.08, 0.3, tcut ) );
		}
		vec3 topc = ( texture2D( uTerTop, vec2( tp.z, tp.y ) / uTerTopSize ).rgb * tw.x + texture2D( uTerTop, tp.xz / uTerTopSize ).rgb * tw.y
		            + texture2D( uTerTop, vec2( tp.x, tp.y ) / uTerTopSize ).rgb * tw.z ) * uTerTopTint;
		float sandy = 1.0 - smoothstep( uTerSandBelow - 0.25, uTerSandBelow + 0.25, tp.y + ( tnz - 0.5 ) * 0.6 );
		topc = mix( topc, uTerSand * ( 0.9 + 0.2 * tnz ), sandy );
		float up = smoothstep( uTerSlope.x, uTerSlope.y, tn.y );
		float lip = ( 1.0 - smoothstep( uTerLip * ( 0.55 + 0.9 * tnz ), uTerLip * ( 0.55 + 0.9 * tnz ) + 0.12, tdepth ) ) * step( -0.2, tn.y );
		float uncut = 1.0 - smoothstep( 0.08, 0.3, tcut );
		float top = clamp( max( up, lip ), 0.0, 1.0 ) * uncut;
		// the ink line along the top's edge, about uTerInkWidth × 2 pixels wide whatever the distance
		float edge = 1.0 - smoothstep( 0.0, max( fwidth( top ) * uTerInkWidth * 2.0, 1e-3 ), abs( top - 0.5 ) );
		vec3 ground = mix( soil, topc, smoothstep( 0.4, 0.6, top ) );
		ground = mix( ground, uTerInk, edge * 0.8 * step( 0.001, uTerInkWidth ) );
		// a cut into a set piece: its inside colour, shaded by the soil picture's light and dark
		if ( vOwn > 0.5 ) {
			vec3 inside = uTerBuilt[ int( clamp( vOwn + 0.5, 1.0, 8.0 ) ) - 1 ];
			float shade = dot( soil / max( uTerSoilTint, vec3( 1e-3 ) ), vec3( 0.333 ) );
			ground = inside * ( 0.75 + 0.35 * shade );
		}
		diffuseColor.rgb *= ground;
	}`);
  };
  mat.customProgramCacheKey = () => 'gf-terrain-3';
  return {
    material: mat, values: V, uniforms: u,
    /** A layer's picture ('top' | 'soil' | 'cliff'): drawn at its size in metres, its colour then only the tint. */
    setTexture(layer, tex) {
      const K = { top: ['uTerTop', 'uTerTopTint'], soil: ['uTerSoil', 'uTerSoilTint'], cliff: ['uTerCliff', 'uTerCliffTint'] }[layer];
      if (!tex || !K) return;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      u[K[0]].value = tex;
      u[K[1]].value.set(V[layer]?.tint ?? '#ffffff');
      if (layer === 'cliff') u.uTerCliffOn.value = 1;
    },
    /** The colour a set piece's cut faces show (owner n: worlds/terrain/compose.mjs). */
    setBuilt(owner, color) { if (owner >= 1 && owner <= 8) u.uTerBuilt.value[owner - 1].set(color); },
  };
}
