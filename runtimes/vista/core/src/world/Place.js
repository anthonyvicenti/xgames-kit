// gf-vista: PATCHES.md #6: the island's layout read from a place recipe (kit/world/places.js) instead of fixed in the
// source. Upstream hand-authored one island: WorldLayout.js (WORLD), terrain/IslandShape.js (RIDGES, SEA_STACKS,
// PATHS), TerrainData.js (the coast ellipses, the headland rock masks, the bay's beach zone, the village valley, the
// volcanic PLUGS). Those literals are now the defaults of LAYOUT below, so with no recipe nothing changes; a recipe
// replaces them all at once (applyPlace, before the app builds its world).
//
// The frame the recipe is written in is the upstream island's: the bay opens toward +z, the harbour (pier foot at
// x 55, the beach's waterline near z -42, the boardwalk, the stilt huts, the boathouse, the stalls) stays where
// upstream built it, and the island (coast, headlands, ridges, peaks, valley, village, reef) is generated around it.
// The bay's real compass bearing turns the sun's path instead of the ground (LAYOUT.sunTurn, degrees, read by
// App.updateSun), which looks the same from anywhere on the island and keeps every hand-tuned harbour piece as it is.
import { WORLD } from './WorldLayout.js';
import { RIDGES, SEA_STACKS, PATHS, PLUGS } from './terrain/IslandShape.js';

// the knobs the generators read; every default is upstream's literal (the reference island)
const REF = {
	terrainSeed: 7,
	// signed coast distance: smin( body, smin( lobe0, lobe1, … , kLobes ), kBody ) + warp noise + fine noise
	coast: { body: [ 0, - 442, 565, 400 ], lobes: [ [ - 272, - 25, 92, 205 ], [ 288, - 12, 108, 228 ] ], kLobes: 40, kBody: 75, warp: 34, fine: 7 },
	// where grid A evaluates the ridge envelope (ellipses a little larger than the land)
	massif: [ [ 0, - 442, 640, 470 ], [ - 272, - 25, 160, 280 ], [ 288, - 12, 170, 300 ] ],
	// rocky headlands: 1 - smoothstep( r0, r1, hypot( ( x - cx ) * sx, ( z - cz ) * sz ) )
	headlands: [ [ - 272, - 25, 0.9, 0.45, 60, 140 ], [ 288, - 12, 0.9, 0.45, 60, 150 ] ],
	// the bay's sandy beach and its tuned surf profile:
	// ( 1 - smoothstep( w0, w1, |x - x| ) ) * ( 1 - smoothstep( s0, s1, z - z ) ) * smoothstep( l0, l1, z )
	beachZone: { x: 10, w0: 120, w1: 205, z: - 40, s0: 40, s1: 140, l0: - 260, l1: - 120 },
	// the open valley behind the village: 1 - smoothstep( w0, w1, |x - x - ( z - z ) * slant + noise * 30| ), fading
	// into the massif between e0 and e1 metres inland
	valley: { x: 22, z: - 100, slant: 0.08, w0: 120, w1: 230, e0: 70, e1: 340 },
	plants: 1, // vegetation density factor (sparse < 1 < lush)
	sunTurn: 0, // degrees added to the sun's azimuth (the bay's compass bearing)
	// the harbour frame: upstream's pier foot (55, -64) and everything built round it (pier, beach zone, valley, surf
	// profile, the bay's scans) sit at world (x, z), turned by heading (radians: 0, the pier runs toward +z)
	harbour: frame( 55, - 64, 0 ),
	// the sea floor beyond the surf zone: depth × shelf from 40 m out (1: upstream's lagoon shallows; > 1 deep drop-offs;
	// < 1 a wide reef flat)
	shelf: 1,
	// sheer cliffs: [x, z, radius, height] where the rocky coast's cliffs stand that high (none upstream)
	cliffs: [],
	// gf-vista: PATCHES.md #8: a flat-topped island (the massif clipped at this height, a table mountain; null upstream)
	tableTop: null,
	// gf-vista: PATCHES.md #8: rivers [{ pts: [[x, z]…] mouth first, w0, w1 (half widths at the mouth and inland), len }]
	// carved below the sea so the sea runs up them (an estuary between banks; none upstream)
	rivers: [],
	// colour of the place (multipliers on the terrain's albedo; 1 1 1 upstream): sand, rock, and how dry the grass is
	look: null,
	// vegetation mix: chance multipliers per plant group (upstream: all 1)
	vegMix: null,
	village: 'reference', // the village plan: upstream's hand-built village, or a generated plan object
	ridges: RIDGES, plugs: PLUGS, stacks: SEA_STACKS, paths: PATHS,
	recipe: null,
};

function frame( x, z, heading ) {

	return { x, z, heading, c: Math.cos( heading ), s: Math.sin( heading ), id: x === 55 && z === - 64 && heading === 0 };

}

let active = REF;

// gf-vista: PATCHES.md #7: upstream's layout as it was before any place was applied (applyPlace fills WORLD and the
// IslandShape arrays in place, and REF holds those very arrays), so a second island starts from upstream's values
const deep = ( v ) => JSON.parse( JSON.stringify( v ) );
const WORLD0 = {
	beach: { ...WORLD.beach }, pier: { ...WORLD.pier },
	boatDock: { p: WORLD.boatDock.position.clone(), heading: WORLD.boatDock.heading },
	village: { c: WORLD.village.center.clone(), radius: WORLD.village.radius },
	reef: { c: WORLD.reef.center.clone(), radius: WORLD.reef.radius },
	spawn: { p: WORLD.spawn.position.clone(), yaw: WORLD.spawn.yaw }, start: { p: WORLD.start.position.clone(), yaw: WORLD.start.yaw },
	swellDir: WORLD.swellDir.clone(),
};
const SHAPES0 = { ridges: deep( RIDGES ), plugs: deep( PLUGS ), stacks: deep( SEA_STACKS ), paths: deep( PATHS ) };

/**
 * The active harbour frame (upstream's: the identity). local: upstream's coordinates round its pier (the pier at x 55
 * running +z from z -64); world: where the place put it. Both return a new [x, z].
 */
export const harbour = () => active.harbour;
export function toWorld( lx, lz, H = active.harbour ) {

	if ( H.id ) return [ lx, lz ];
	const dx = lx - 55, dz = lz + 64;
	return [ H.x + dx * H.c + dz * H.s, H.z - dx * H.s + dz * H.c ];

}

export function toLocal( wx, wz, H = active.harbour ) {

	if ( H.id ) return [ wx, wz ];
	const dx = wx - H.x, dz = wz - H.z;
	return [ 55 + dx * H.c - dz * H.s, - 64 + dx * H.s + dz * H.c ];

}

// the world box round a box given in the harbour frame [x0, x1, z0, z1] (upstream: the same numbers)
export function worldBox( x0, x1, z0, z1, H = active.harbour ) {

	if ( H.id ) return [ x0, x1, z0, z1 ];
	const pts = [ toWorld( x0, z0, H ), toWorld( x1, z0, H ), toWorld( x0, z1, H ), toWorld( x1, z1, H ) ];
	return [ Math.min( ...pts.map( ( p ) => p[ 0 ] ) ), Math.max( ...pts.map( ( p ) => p[ 0 ] ) ), Math.min( ...pts.map( ( p ) => p[ 1 ] ) ), Math.max( ...pts.map( ( p ) => p[ 1 ] ) ) ];

}

/** The layout the core builds from: the reference island until applyPlace() sets another. */
export const activeLayout = () => active;
export const referenceLayout = () => REF;

const v2 = ( a, d ) => Array.isArray( a ) ? a : a && typeof a === 'object' ? [ a.x, a.z ] : d;

/**
 * A recipe (plain JSON, kit/world/places.js) as the knobs the generators read. Pure: nothing global changes, so a
 * recipe can be probed or checked (TerrainData with this layout) while another island is live.
 */
export function layoutFromRecipe( r ) {

	if ( ! r ) return REF;
	const ridges = ( r.ridges || [] ).map( ( pl ) => pl.map( ( p ) => p.length < 4 ? [ p[ 0 ], p[ 1 ], p[ 2 ], 2.5 * p[ 2 ] + 50 ] : p.slice( 0, 4 ) ) );
	return {
		terrainSeed: r.terrain?.seed ?? REF.terrainSeed,
		// a turned lobe carries its angle's cosine and sine (TerrainData evaluates it a million times per grid)
		coast: { ...REF.coast, ...r.coast, lobes: ( r.coast?.lobes || REF.coast.lobes ).map( ( l ) => l[ 4 ] ? [ l[ 0 ], l[ 1 ], l[ 2 ], l[ 3 ], l[ 4 ], Math.cos( l[ 4 ] ), Math.sin( l[ 4 ] ) ] : l ),
			// gf-vista: PATCHES.md #8: coves bitten out of the coast (each a turned ellipse of sea)
			coves: ( r.coast?.coves || [] ).map( ( l ) => [ l[ 0 ], l[ 1 ], l[ 2 ], l[ 3 ], l[ 4 ] || 1e-9, Math.cos( l[ 4 ] || 0 ), Math.sin( l[ 4 ] || 0 ) ] ) },
		tableTop: r.tableTop ?? null,
		rivers: ( r.rivers || [] ).map( riverOf ),
		massif: r.massif || REF.massif,
		headlands: r.headlands || REF.headlands,
		beachZone: { ...REF.beachZone, ...r.beachZone },
		valley: { ...REF.valley, ...r.valley },
		plants: r.plants ?? 1,
		sunTurn: r.sunTurn ?? 0,
		harbour: r.harbour ? frame( r.harbour.x, r.harbour.z, r.harbour.heading ?? 0 ) : REF.harbour,
		shelf: r.nature?.shelf ?? 1,
		cliffs: ( r.cliffs || [] ).map( ( c ) => c.slice() ),
		look: r.nature ? { sand: r.nature.sand ?? [ 1, 1, 1 ], rock: r.nature.rock ?? [ 1, 1, 1 ], dry: r.nature.dry ?? 0, wetSand: r.nature.wetSand ?? r.nature.sand ?? [ 1, 1, 1 ] } : null,
		vegMix: r.nature?.vegMix ?? null,
		village: r.village?.plan ?? 'reference',
		ridges,
		plugs: ( r.plugs || [] ).map( ( p ) => p.slice() ),
		stacks: ( r.stacks || [] ).map( ( p ) => p.slice() ),
		paths: ( r.paths || [] ).map( ( p ) => ( { w: p.w, pts: p.pts.map( ( q ) => q.slice() ) } ) ),
		recipe: r,
		// WORLD's fields for this recipe (applyPlace writes them into WORLD in place)
		world: {
			beach: r.beach,
			pier: r.pier,
			boatDock: r.boatDock && { x: r.boatDock.x, z: r.boatDock.z, heading: r.boatDock.heading ?? 0 },
			village: r.village && { center: v2( r.village.center ), radius: r.village.radius },
			reef: r.reef && { center: v2( r.reef.center ), radius: r.reef.radius },
			spawn: r.spawn, start: r.start, swellDir: r.swellDir,
		},
	};

}

// gf-vista: PATCHES.md #8: a river's polyline with its running length and box (TerrainData carves it per texel)
function riverOf( rv ) {

	const pts = rv.pts.map( ( p ) => p.slice() ), at = [ 0 ];
	for ( let i = 1; i < pts.length; i ++ ) at.push( at[ i - 1 ] + Math.hypot( pts[ i ][ 0 ] - pts[ i - 1 ][ 0 ], pts[ i ][ 1 ] - pts[ i - 1 ][ 1 ] ) );
	const pad = rv.w0 + 90;
	return { pts, at, len: at[ at.length - 1 ] || 1, w0: rv.w0, w1: rv.w1,
		box: [ Math.min( ...pts.map( ( p ) => p[ 0 ] ) ) - pad, Math.max( ...pts.map( ( p ) => p[ 0 ] ) ) + pad, Math.min( ...pts.map( ( p ) => p[ 1 ] ) ) - pad, Math.max( ...pts.map( ( p ) => p[ 1 ] ) ) + pad ] };

}

const replace = ( arr, items ) => {

	arr.length = 0;
	for ( const it of items ) arr.push( it );

};

/**
 * gf-vista: PATCHES.md #7: back to upstream's layout (WORLD, the IslandShape arrays, the reference knobs), as before any
 * place was applied. App.rebuildPlace calls it before applying the next island's recipe (or for the reference).
 */
export function resetPlace() {

	Object.assign( WORLD.beach, WORLD0.beach );
	Object.assign( WORLD.pier, WORLD0.pier );
	WORLD.boatDock.position.copy( WORLD0.boatDock.p );
	WORLD.boatDock.heading = WORLD0.boatDock.heading;
	WORLD.village.center.copy( WORLD0.village.c );
	WORLD.village.radius = WORLD0.village.radius;
	WORLD.reef.center.copy( WORLD0.reef.c );
	WORLD.reef.radius = WORLD0.reef.radius;
	WORLD.spawn.position.copy( WORLD0.spawn.p );
	WORLD.spawn.yaw = WORLD0.spawn.yaw;
	WORLD.start.position.copy( WORLD0.start.p );
	WORLD.start.yaw = WORLD0.start.yaw;
	WORLD.swellDir.copy( WORLD0.swellDir );
	replace( RIDGES, deep( SHAPES0.ridges ) );
	replace( PLUGS, deep( SHAPES0.plugs ) );
	replace( SEA_STACKS, deep( SHAPES0.stacks ) );
	replace( PATHS, deep( SHAPES0.paths ) );
	active = REF;
	return active;

}

/**
 * Make `recipe` the island the core builds next (null: the reference). Fills WORLD and IslandShape's arrays in place,
 * so modules holding them see the new layout. Call before the app builds its world (vista-io setPlace, App.init).
 */
export function applyPlace( recipe ) {

	if ( ! recipe ) return active;
	const L = layoutFromRecipe( recipe );
	const W = L.world;
	if ( W.beach ) Object.assign( WORLD.beach, W.beach );
	if ( W.pier ) {

		for ( const k of [ 'x', 'zStart', 'zEnd', 'deckHeight', 'width', 'headWidth', 'headDepth' ] ) if ( W.pier[ k ] !== undefined ) WORLD.pier[ k ] = W.pier[ k ];

	}

	if ( W.boatDock ) {

		WORLD.boatDock.position.set( W.boatDock.x, 0, W.boatDock.z );
		WORLD.boatDock.heading = W.boatDock.heading;

	}

	if ( W.village ) {

		WORLD.village.center.set( W.village.center[ 0 ], 0, W.village.center[ 1 ] );
		WORLD.village.radius = W.village.radius;

	}

	if ( W.reef ) {

		WORLD.reef.center.set( W.reef.center[ 0 ], 0, W.reef.center[ 1 ] );
		WORLD.reef.radius = W.reef.radius;

	}

	for ( const k of [ 'spawn', 'start' ] ) {

		const s = W[ k ];
		if ( ! s ) continue;
		WORLD[ k ].position.set( s.x, 0, s.z );
		WORLD[ k ].yaw = s.yaw;

	}

	if ( W.swellDir ) WORLD.swellDir.set( W.swellDir[ 0 ], W.swellDir[ 1 ] ).normalize();
	replace( RIDGES, L.ridges );
	replace( PLUGS, L.plugs );
	replace( SEA_STACKS, L.stacks );
	replace( PATHS, L.paths );
	L.ridges = RIDGES; L.plugs = PLUGS; L.stacks = SEA_STACKS; L.paths = PATHS;
	active = L;
	return L;

}
