// gf-vista: the one place the core reads files from (core/PATCHES.md #1). Upstream fetched relative to Vite's
// BASE_URL; here the host decides: setBase() for a plain file tree (the sandbox, the reference comparison), or
// setReader() so every read goes through gf-assets (Studio's swaps and overrides, a packed page with no fetch).
//   assetBase()        what upstream's `( import.meta.env && import.meta.env.BASE_URL ) || '/'` gave
//   vistaFetch( url )  what upstream's fetch( url ) did, for a url built from assetBase()
let base = '/';
let reader = null;

export function setBase( b ) {

	base = b.endsWith( '/' ) ? b : b + '/';

}

// fn( path ) → Promise<Response>, path relative to the asset root ('models/whale/humpback.bin')
export function setReader( fn ) {

	reader = fn;

}

export const assetBase = () => base;

// the asset path under the root: a url built from assetBase(), or one already relative
export function assetPath( url ) {

	const u = String( url );
	return ( u.startsWith( base ) ? u.slice( base.length ) : u ).replace( /^(\.\/)+/, '' );

}

export function vistaFetch( url ) {

	return reader ? reader( assetPath( url ) ) : fetch( url );

}

// gf-vista: PATCHES.md #5: which clouds the core draws: 'volumetric' (sky-pro-webgpu's, the default) or 'basic' (the
// core's own Clouds.js, for a copy of the core that ships without the sky-pro files)
let clouds = 'volumetric';
export function setClouds( c ) {

	clouds = c === 'basic' ? 'basic' : 'volumetric';

}

export const cloudsChoice = () => clouds;

// gf-vista: PATCHES.md #6: the island the core builds: a place recipe (kit/world/places.js placeRecipe: plain JSON with
// the coast, ridges, peaks, bay, beach, pier, dock, village, reef, spawn, start, swell). Set before the app starts
// (App.init applies it through world/Place.js); null: the reference island (upstream's, unchanged)
let place = null;
export function setPlace( recipe ) {

	place = recipe || null;

}

export const placeChoice = () => place;
