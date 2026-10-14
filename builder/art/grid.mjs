// A pixel grid: pixel art written as text, one character a pixel. This is what a session hands back when the game's
// style is pixel art; it becomes a PNG here with no browser and no model call.
//
//   { "format": "gamesfun-pixel-grid/1",
//     "size": [16, 16],                               one frame, in pixels: [width, height]
//     "palette": { ".": null, "a": "#1b1f2a", … },   one character a colour; null (or "transparent") is see-through
//     "frames": { "idle": ["................", …16 rows…], "walk1": [ … ] } }
//
// A picture or a tile is a grid with one frame (any name). Frames are laid in a row, in the order asked for.
import { blank } from './png.mjs';

export const GRID_FORMAT = 'gamesfun-pixel-grid/1';
const HEX = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;

/** What is wrong with a grid, as plain sentences a session can act on ([] when it is fine). */
export function gridProblems(grid, { frames = null, size = null, maxColours = null } = {}) {
  const out = [];
  if (!grid || typeof grid !== 'object' || Array.isArray(grid)) return ['the grid must be a JSON object: { format, size, palette, frames }'];
  if (grid.format !== GRID_FORMAT) out.push(`format must be "${GRID_FORMAT}"`);
  const [w, h] = Array.isArray(grid.size) ? grid.size : [];
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 256 || h > 256) out.push('size must be [width, height] in whole pixels, each 1 to 256');
  if (size && (w !== size[0] || h !== size[1])) out.push(`size is [${w}, ${h}]; the request asked for [${size[0]}, ${size[1]}]`);
  const pal = grid.palette;
  if (!pal || typeof pal !== 'object' || Array.isArray(pal)) out.push('palette must be an object: one character to a colour (#rrggbb) or null for see-through');
  else {
    let colours = 0;
    for (const [k, v] of Object.entries(pal)) {
      if ([...k].length !== 1) out.push(`palette key ${JSON.stringify(k)} must be one character`);
      if (v === null || v === 'transparent') continue;
      if (typeof v !== 'string' || !HEX.test(v)) out.push(`palette ${JSON.stringify(k)}: ${JSON.stringify(v)} is not a colour (#rrggbb)`); else colours++;
    }
    if (maxColours && colours > maxColours) out.push(`the palette has ${colours} colours; the request allows at most ${maxColours}`);
  }
  const fr = grid.frames;
  if (!fr || typeof fr !== 'object' || Array.isArray(fr) || !Object.keys(fr).length) { out.push('frames must be an object: a name to its rows of text'); return out; }
  for (const name of frames ?? []) if (!(name in fr)) out.push(`frame "${name}" is missing (the request asked for: ${frames.join(', ')})`);
  if (out.length) return out;
  for (const [name, rows] of Object.entries(fr)) {
    if (!Array.isArray(rows) || rows.length !== h) { out.push(`frame "${name}" has ${Array.isArray(rows) ? rows.length : 'no'} rows; it needs ${h}`); continue; }
    rows.forEach((row, y) => {
      const chars = typeof row === 'string' ? [...row] : null;
      if (!chars || chars.length !== w) { out.push(`frame "${name}" row ${y + 1} is ${chars ? chars.length : 'not text:'} characters; it needs ${w}`); return; }
      const bad = chars.find(c => !(c in pal));
      if (bad !== undefined && out.length < 12) out.push(`frame "${name}" row ${y + 1} uses ${JSON.stringify(bad)}, which is not in the palette`);
    });
  }
  return out;
}

/** A checked grid → an RGBA picture, its frames in a row (in `frames` order when given, else as written). */
export function rasteriseGrid(grid, { frames = null } = {}) {
  const [w, h] = grid.size;
  const names = frames ?? Object.keys(grid.frames);
  const pal = new Map(Object.entries(grid.palette).map(([k, v]) => {
    if (v === null || v === 'transparent') return [k, [0, 0, 0, 0]];
    const n = v.slice(1);
    return [k, [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16), n.length === 8 ? parseInt(n.slice(6, 8), 16) : 255]];
  }));
  const pic = blank(w * names.length, h);
  names.forEach((name, f) => grid.frames[name].forEach((row, y) => [...row].forEach((c, x) => {
    const [r, g, b, a] = pal.get(c), i = (y * pic.width + f * w + x) * 4;
    pic.data[i] = r; pic.data[i + 1] = g; pic.data[i + 2] = b; pic.data[i + 3] = a;
  })));
  return pic;
}
