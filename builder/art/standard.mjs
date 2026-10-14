// What a 2D picture must be to work in a flat game: THE ONE PLACE this kit states it. The numbers are games.fun's
// `gf-flat-1` (games.fun's runtimes/three/profiles/flat-2d/ART-STANDARD.md, read 2026-10-11 before it was in the kits).
// That file says its judge (`kit/flat/judge.js`) is the authority; when it reaches this kit through the sync, checks.mjs
// should call it and this file should only keep what a REQUEST needs to say. Requests, checks and docs all read from here.
export const STANDARD = {
  id: 'gf-flat-1',
  source: 'games.fun runtimes/three/profiles/flat-2d/ART-STANDARD.md (2026-10-11)',
  styles: {
    pixel: { label: 'pixel art', answer: 'grid', cell: 32, cells: [16, 24, 32, 48, 64], tile: 16, picture: 16, pictures: [8, 64], softLimit: 0.02, colours: 32, margin: 0,
      note: 'Hard pixels: every pixel fully drawn or fully see-through, no soft edges. At most 32 colours in a picture. A dark outline one pixel wide around bodies and props reads best.' },
    drawn: { label: 'drawn art', answer: 'svg', cell: 256, cells: null, tile: 128, picture: 128, pictures: [64, 512], softLimit: null, colours: null, margin: 2,
      note: 'Smooth shapes, clean outlines, flat or softly shaded colour. Soft edges are fine.' },
  },
  sheet: {
    frames: ['idle', 'walk1', 'walk2', 'air', 'act', 'down'],
    rows: { 1: ['turn'], 3: ['down', 'side', 'up'] },
    meaning: { idle: 'standing still', walk1: 'one step of a walk', walk2: 'the other step (legs swapped)', air: 'off the ground: a jump or a fall', act: 'any action: a throw, a swing, a grab, a cheer', down: 'knocked down' },
    planes: {
      side: 'Seen from the side, standing, FACING RIGHT (the game mirrors it to face left).',
      top: 'Seen from straight above, FACING THE TOP of the picture (the game turns it to the heading).',
    },
    fill: 0.85, overfill: 0.9, small: 0.5, empty: 0.04, feet: 1 / 16, airFeet: 1 / 4, centre: 1 / 8, same: 0.01,
    tint: 'The game multiplies the picture by each player\'s colour mixed 30% toward white. Paint what should take the player\'s colour (a shirt, a shell) light: #e0e0e0 or lighter. Skin, ink and dark parts keep their look.',
  },
  kinds: {
    sheet: { transparent: true },
    picture: { transparent: true, note: 'One object, centred, all of it inside the picture, see-through around it.' },
    tile: { transparent: false, seam: 3, seamFail: 6, note: 'Fills the whole square with no see-through pixel. It is repeated across the ground: what leaves on the right comes back in on the left, and what leaves at the bottom comes back in at the top.' },
  },
};

/** The size in pixels [width, height] of the whole file for a kind in a style (a sheet: six cells in one row). */
export function sizeFor(kind, style, standard = STANDARD) {
  const s = standard.styles[style];
  if (!s) throw new Error(`style "${style}" is not one of ${Object.keys(standard.styles).join(', ')}`);
  if (kind === 'sheet') return [s.cell * standard.sheet.frames.length, s.cell];
  if (kind === 'tile') return [s.tile, s.tile];
  if (kind === 'picture') return [s.picture, s.picture];
  throw new Error(`kind "${kind}" is not sheet, picture or tile`);
}
