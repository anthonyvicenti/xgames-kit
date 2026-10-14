import { Color, Vector3 } from '../engine/index.js';
import { PIER } from './Pier.js';
import { HARD, C, lin, bollard, cleat, tireFender, ropeCoil, lifeRing, lampPost, bench, bucket } from './Props.js';

// gf-vista: PATCHES.md #6: a stone (or concrete) jetty, the other way a place lands its boats: a solid causeway on
// masonry from the beach out to a wider head, a capping slab, kerbs, a ramp down to the sand, bollards, tyre fenders
// and a ladder on the berthing side, a few lamps. Built in upstream's pier frame (x 55, running +z from PIER.zStart to
// PIER.zEnd, the deck at PIER.deck), like Pier.js, so the village's harbour frame places it; the same colliders tags
// (pierDeck, pierStep, ladder, bollard, lampPost) so walking, swimming out and boarding work as on the timber pier.
//   style: 'stone' (coursed rubble, dark or pale by tint) or 'concrete' (rendered, pale)

const _v = new Vector3();
const _h = new Vector3();

export function buildJetty( { B, terrain, colliders, rand, lights, inst, style = 'stone', tint = null } ) {

	const X = PIER.x, DK = PIER.deck, W = PIER.width;
	const z0 = PIER.zStart, z1 = PIER.zEnd, zH = PIER.headZ0, hx0 = PIER.headX0, hx1 = PIER.headX1;
	const ground = ( x, z ) => terrain.heightAt( x, z );
	const info = { lamps: [], bollards: [], hung: [] };
	const concrete = style === 'concrete';
	const wall = tint ?? ( concrete ? lin( 0xc9c6bd ) : lin( 0xb8b0a2 ) );
	const sd = () => [ rand.next(), concrete ? 1 : 0, 0, 0 ]; // stone vdata: seed, style (0 coursed rubble, 1 render)
	const capT = 0.28;
	const addBox = ( cx, cy, cz, hx, hy, hz, opts ) => colliders.addBox( _v.set( cx, cy, cz ), _h.set( hx, hy, hz ), 0, opts );

	// the causeway: blocks of masonry standing on the sea bed (or the sand), their joints a little irregular
	const seg = 3.6;
	const n = Math.max( 1, Math.ceil( ( zH - z0 ) / seg ) );
	for ( let i = 0; i < n; i ++ ) {

		const za = z0 + i * ( zH - z0 ) / n, zb = z0 + ( i + 1 ) * ( zH - z0 ) / n;
		const base = Math.min( ground( X - W / 2, za ), ground( X + W / 2, za ), ground( X - W / 2, zb ), ground( X + W / 2, zb ) ) - 0.6;
		const top = DK - capT;
		const wob = rand.range( - 0.03, 0.03 );
		B.box( 'stone', X + wob, ( top + base ) / 2, ( za + zb ) / 2, W - 0.06, top - base, zb - za + 0.02, { grain: 0, tint: wall, data: sd() } );
		// the cap: one slab per bay, a hair proud of the walls
		B.box( 'stone', X, DK - capT / 2, ( za + zb ) / 2, W + 0.12, capT, zb - za - 0.03, { grain: 2, tint: concrete ? lin( 0xd8d4ca ) : lin( 0xcfc8ba ), data: [ rand.next(), 1, 0, 0 ] } );
		addBox( X, ( DK + base ) / 2, ( za + zb ) / 2, W / 2, ( DK - base ) / 2, ( zb - za ) / 2, { walkable: true, solid: true, tag: 'pierDeck' } );

	}

	// the head: a wider block for the berth
	{

		let base = Infinity;
		for ( const x of [ hx0, X, hx1 ] ) for ( const z of [ zH, ( zH + z1 ) / 2, z1 ] ) base = Math.min( base, ground( x, z ) );
		base -= 0.6;
		const top = DK - capT;
		B.box( 'stone', ( hx0 + hx1 ) / 2, ( top + base ) / 2, ( zH + z1 ) / 2, hx1 - hx0 - 0.06, top - base, z1 - zH, { grain: 0, tint: wall, data: sd() } );
		const nx = Math.max( 2, Math.round( ( hx1 - hx0 ) / 3.5 ) );
		for ( let k = 0; k < nx; k ++ ) {

			const xa = hx0 + k * ( hx1 - hx0 ) / nx, xb = hx0 + ( k + 1 ) * ( hx1 - hx0 ) / nx;
			B.box( 'stone', ( xa + xb ) / 2, DK - capT / 2, ( zH + z1 ) / 2, xb - xa - 0.03, capT, z1 - zH + 0.12, { grain: 0, tint: concrete ? lin( 0xd8d4ca ) : lin( 0xcfc8ba ), data: [ rand.next(), 1, 0, 0 ] } );

		}

		addBox( ( hx0 + hx1 ) / 2, ( DK + base ) / 2, ( zH + z1 ) / 2, ( hx1 - hx0 ) / 2, ( DK - base ) / 2, ( z1 - zH ) / 2, { walkable: true, solid: true, tag: 'pierDeck' } );

	}

	// kerbs along the edges (gaps at the ramp and the berth)
	const kerb = ( ax, az, bx, bz ) => {

		const len = Math.hypot( bx - ax, bz - az ), alongX = Math.abs( bx - ax ) > Math.abs( bz - az );
		B.box( 'stone', ( ax + bx ) / 2, DK + 0.09, ( az + bz ) / 2, alongX ? len : 0.3, 0.18, alongX ? 0.3 : len, { grain: alongX ? 0 : 2, tint: wall, data: sd() } );
		addBox( ( ax + bx ) / 2, DK + 0.09, ( az + bz ) / 2, alongX ? len / 2 : 0.15, 0.09, alongX ? 0.15 : len / 2, { tag: 'pierKerb' } );

	};
	for ( const s of [ - 1, 1 ] ) kerb( X + s * ( W / 2 - 0.15 ), z0 + 1.5, X + s * ( W / 2 - 0.15 ), zH );
	kerb( hx0 + 0.15, zH, hx0 + 0.15, z1 - 0.15 );
	kerb( hx0, z1 - 0.15, hx1 - 3.5, z1 - 0.15 );

	// a ramp down to the sand
	{

		const gs = ground( X, z0 - 1 );
		const rise = DK - gs;
		const nR = Math.max( 2, Math.ceil( rise / 0.2 ) );
		const tread = 0.42;
		for ( let k = 1; k < nR; k ++ ) {

			const top = DK - k * rise / nR, zc = z0 - ( k - 0.5 ) * tread;
			B.box( 'stone', X, ( top + gs - 0.5 ) / 2, zc, W, top - gs + 0.5, tread + 0.01, { grain: 0, tint: wall, data: sd() } );
			addBox( X, ( top + gs - 0.5 ) / 2, zc, W / 2, ( top - gs + 0.5 ) / 2, tread / 2 + 0.005, { walkable: true, solid: true, tag: 'pierStep' } );

		}

		info.stepFoot = new Vector3( X, ground( X, z0 - ( nR - 1 ) * tread - 0.3 ), z0 - ( nR - 1 ) * tread - 0.3 );

	}

	// the berth (east face of the head): bollards, a cleat, tyre fenders, a ladder down into the water
	const edgeX = hx1;
	for ( const bz of [ z1 - 5.7, z1 - 1.3 ] ) {

		bollard( B, edgeX - 0.5, DK, bz, rand.next() );
		ropeCoil( B, edgeX - 1.2, DK, bz + ( bz < z1 - 3 ? 0.4 : - 0.4 ), 0.08, 0.3, 4, rand.next() );
		colliders.addCylinder( edgeX - 0.5, bz, 0.22, DK, DK + 0.5, { tag: 'bollard' } );
		info.bollards.push( new Vector3( edgeX - 0.5, DK + 0.45, bz ) );

	}

	cleat( B, edgeX - 0.25, DK, z1 - 3.5, Math.PI / 2, rand.next() );
	info.bollards.push( new Vector3( edgeX - 0.25, DK + 0.1, z1 - 3.5 ) );
	for ( const fz of [ z1 - 6.4, z1 - 4.2, z1 - 2.6, z1 - 0.8 ] ) tireFender( B, edgeX + 0.05, DK - 0.04, fz, 0, rand.range( 0.65, 0.85 ), rand.next() );
	{

		const lz = z1 - 4.9, lx = edgeX + 0.07, yb = - 2.2, yt = DK + 0.85;
		const t = C.galv, d = HARD( rand.next(), 0.45, 0.85, 0.4 );
		for ( const s of [ - 1, 1 ] ) B.rod( 'hard', [ lx, yb, lz + s * 0.24 ], [ lx, yt - 0.15, lz + s * 0.24 ], 0.024, 0.024, { segs: 7, tint: t, data: d } );
		for ( let y = yb + 0.25; y < DK - 0.1; y += 0.3 ) {

			B.rod( 'hard', [ lx, y, lz - 0.24 ], [ lx, y, lz + 0.24 ], 0.018, 0.018, { segs: 6, tint: t, data: d } );
			if ( y >= - 0.4 ) colliders.addBox( _v.set( lx + 0.25, y - 0.15, lz ), _h.set( 0.27, 0.15, 0.3 ), 0, { walkable: true, solid: false, tag: 'ladder' } );

		}

		info.ladder = new Vector3( lx, DK, lz );

	}

	// lamps: along the causeway and on the head
	const lampAt = ( lx, lz, yaw ) => {

		const w = lampPost( B, lx, DK, lz, yaw, 3.1, rand.next() );
		lights.push( { position: w, color: new Color( 1.0, 0.72, 0.42 ), intensity: 5, kind: 'lantern' } );
		info.lamps.push( w );
		colliders.addCylinder( lx, lz, 0.1, DK, DK + 3.2, { tag: 'lampPost' } );

	};
	const nL = Math.max( 1, Math.floor( ( zH - z0 ) / 22 ) );
	for ( let i = 0; i < nL; i ++ ) lampAt( X + ( i % 2 ? 1 : - 1 ) * ( W / 2 - 0.35 ), z0 + 6 + i * ( zH - z0 - 8 ) / nL, ( i % 2 ? 1 : - 1 ) * Math.PI / 2 );
	lampAt( hx0 + 0.6, z1 - 0.6, 3 * Math.PI / 4 );

	// the head's own gear: a bench facing the sea, a life ring, crates and traps, a bucket
	bench( B, X - 1.6, DK, z1 - 1.0, 0, 1.7, rand.next() );
	addBox( X - 1.6, DK + 0.45, z1 - 1.05, 0.85, 0.45, 0.3, { tag: 'bench' } );
	lifeRing( B, hx0 + 0.3, DK + 0.6, zH + 1.5, Math.PI / 2, rand.next() );
	for ( const [ type, x, z, ry, stack ] of [ [ 'crate', hx0 + 1.2, zH + 0.9, 0.1 ], [ 'crate', hx0 + 1.25, zH + 0.95, 0.4, 0.4 ], [ 'trap', hx0 + 2.3, zH + 0.8, 0.05 ], [ 'trap', hx0 + 2.35, zH + 0.85, 0.3, 0.31 ], [ 'barrel', X + 1.6, zH + 1.0, 0.7 ] ] ) {

		inst.add( type, x, DK + ( stack || 0 ), z, ry, [ rand.range( 0.85, 1.05 ), rand.range( 0.85, 1.0 ), rand.range( 0.8, 0.95 ) ] );
		if ( ! stack ) {

			if ( type === 'barrel' ) colliders.addCylinder( x, z, 0.32, DK, DK + 0.9, { tag: 'barrel' } );
			else addBox( x, DK + 0.25, z, type === 'trap' ? 0.48 : 0.33, 0.3, type === 'trap' ? 0.28 : 0.24, { tag: type } );

		}

	}

	bucket( B, X + 1.3, DK, ( z0 + zH ) / 2, C.blue, rand.next() );
	return info;

}
