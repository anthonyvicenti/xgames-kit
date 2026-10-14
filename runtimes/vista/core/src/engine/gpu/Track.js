// gf-vista: PATCHES.md #7 (an island rebuilt at runtime): who made which GPU resource. Upstream builds its world once
// and never frees it; a game that sails to another island throws one island away and builds the next in the same page,
// so everything the island's systems made must be found again and freed (or the GPU and the heap grow hop over hop).
//
//   const scope = []; withTracking( scope, () => new Village( ... ) );   // everything constructed in fn is listed
//
// While a scope is open, the engine's resource classes (Texture, StorageBuffer, UniformBlock, BufferGeometry, Material)
// add themselves to it from their constructors, every WGSL module compiled is listed by its code, and a raw GPUBuffer /
// GPUTexture made straight on the device (not by one of those classes: `owning` marks theirs) is listed too. Nothing
// changes for a resource outside a scope, and nothing is tracked when no scope is open (upstream's path: one check).
//
// Usage marks (`o.__gfUsed = frame`): the bind groups stamp every texture, storage buffer and uniform block they bind,
// so a rebuild frees only what no frame has used since it began (a cache one island made and the next reuses stays).

let sink = null;
let owned = 0;
let hooked = false;

/** The open scope (an array) or null. */
export const tracking = () => sink;

/** List `o` in the open scope (constructors call this; a no-op with no scope open). */
export function track( o ) {

	if ( sink ) sink.push( o );
	return o;

}

/** Run fn with `list` as the open scope (scopes nest; the inner one wins). */
export function withTracking( list, fn ) {

	const prev = sink;
	sink = list;
	try {

		return fn();

	} finally {

		sink = prev;

	}

}

/** A raw device creation that belongs to a wrapper (Texture, StorageBuffer, UniformBlock, a mesh buffer): not listed. */
export function owning( fn ) {

	owned ++;
	try {

		return fn();

	} finally {

		owned --;

	}

}

/** List raw GPUBuffers / GPUTextures made on `device` inside a scope (once per device). */
export function hookDevice( device ) {

	if ( hooked || ! device ) return;
	hooked = true;
	const cb = device.createBuffer.bind( device ), ct = device.createTexture.bind( device );
	device.createBuffer = ( d ) => {

		const b = cb( d );
		if ( sink && ! owned ) sink.push( { raw: b, label: d && d.label } );
		return b;

	};

	device.createTexture = ( d ) => {

		const t = ct( d );
		if ( sink && ! owned ) sink.push( { raw: t, label: d && d.label } );
		return t;

	};

}
