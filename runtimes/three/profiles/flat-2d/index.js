// The three runtime's flat-2d profile: the part's own declarations, read by the tools (the catalog, create, the checks)
// and never by a game at run time. Pure: Node imports it. A flat-2d game is `"runtime": "three", "profile": "flat-2d"`
// in the spec, seen from above (camera top) or from the side (camera side); inside the kit it is the three kit with
// four parts swapped (slots.js has the list), and only the parts that differ are here.
//
// Like a mechanic (tools/catalog.mjs MANIFEST) and a flow (LOOP_MANIFEST), the part brings its own guidance (`note`,
// read only by builds of a flat game), says which mechanics it has been run with (`runs`), and says what a check
// should read where a check would otherwise assume a 3D game (`reads`, `worldReport`, `bodyReport`).
import { PLANES, STYLES, STANDARD, FRAMES, ROWS, FILL, SIDE, presets, templates, cameras, refuse, refuseNotFlat, mapFor, styleOf, spawnsOf, planeOfSpec } from './slots.js';
import { FORMAT, LIMITS, REACH_MARGIN, SIZES, readMap, reachOf, jumpReach } from './tilemap.js';
import { judge } from './judge.js';

export const id = 'flat';
export { refuse, refuseNotFlat, mapFor, judge, spawnsOf };
export { lookConfig, worldConfig, propFor, bodyFor, gameFor, presets, templates, cameras, PLANES } from './slots.js';

const PLANE = {
  top: {
    id: 'top', label: 'Seen from above', world: 'field', camera: 'top',
    describe: 'A field seen from straight above: bodies walk in every direction on a tile map of ground kinds and walls; nobody jumps',
    pick: 'twin-stick and arena games, collect-and-dodge, top-down adventure, a board or grid on the ground (with the board mechanic and a cursor each)',
    controls: 'WASD or the stick moves on the screen\'s axes; the mouse cursor (or a tap) aims and acts where it points',
  },
  side: {
    id: 'side', label: 'Seen from the side', world: 'stage', camera: 'side',
    describe: 'A stage seen from the side with gravity: ground and blocks, ledges you land on from above and jump up through, a jump that clears two cells',
    pick: 'platformers, side-on brawls and races, climb-and-collect',
    controls: 'A and D or the stick run, Space jumps, S or Down drops through a ledge; the mouse cursor (or a tap) aims',
  },
};

// The mechanics run on each plane with real input (research/open-builder/findings/two-d-wave8/). `params` are laid
// under the spec's own (create): what the mechanic needs to sit on a plane. A mechanic not listed for a plane is
// refused by create with `notRun`, not because it is known to fail: nobody has run it there.
const RUNS = {
  top: {
    pickup: { params: { spin: false }, how: 'spots lie on the ground; world.marks(name) gives the map\'s marked cells for pickup.spawnAt' },
    // seen from above the screen is the board, one picture for everyone: row 0 (where a dropped piece gathers) is its
    // bottom edge, as a four-in-a-row board stands, and the seats are its left and right, clear of the HUD's top and
    // bottom middle (the clock and the goal, the prompt)
    board: { params: { presence: 'cursor', clear: 0, rowZero: 'front', seatSides: 'ew' }, how: 'a grid on the ground with a cursor each (presence "cursor"): the bodies stand at its left and right, each player moves a mark; row 0 is the bottom edge of the screen (a dropped piece falls down the screen); with the turns loop' },
  },
  side: {
    pickup: { params: { spin: false, touchHeight: 0.4, radius: 0.8 }, how: 'by itself pickup puts its spots along y = 0; for spots on the ledges give it count 0 and place them at the map\'s marks: for (const m of ctx.world.marks(name)) pickup.spawnAt(m). A spot is taken by a body within reach along X and within 1.4 m in height' },
  },
};
const notRun = (mech, plane) => `mechanics: "${mech}" has not been run on the flat ${plane} plane yet (run there: ${Object.keys(RUNS[plane]).join(', ')}): leave it out, or write that part in rules.js`;

/** What a spec's mechanics need on its plane. → { problems: [string], params: { mechanicId: {…} } } */
export function mechanicsOn(spec) {
  const plane = planeOfSpec(spec), R = RUNS[plane] ?? {}, problems = [], params = {};
  for (const m of spec.mechanics ?? []) { if (!R[m.id]) problems.push(notRun(m.id, plane)); else params[m.id] = R[m.id].params; }
  if (plane !== 'top' && (spec.mechanics ?? []).some(m => m.id === 'board')) problems.push('mechanics: a board lies on the ground: it needs the camera "top" (seen from above)');
  return { problems, params };
}

/**
 * What a check should read in a flat game, where it would otherwise assume a 3D one. Each entry names the fact and why.
 * A check asks the game's own copy (gf/three/flat/index.js → manifest.reads(plane)) and never keeps a list of camera
 * names or keys of its own.
 */
const reads = plane => ({
  // which real keys walk the player, and along which world axes (checks 3, 13, 24, 34: "W is forward" is not true side-on)
  walk: plane === 'side'
    ? { keys: { right: 'KeyD', left: 'KeyA' }, axes: ['x'], jump: 'Space', forward: 'KeyD', why: 'side-on W is not a direction: a body runs along X and jumps' }
    : { keys: { up: 'KeyW', right: 'KeyD', down: 'KeyS', left: 'KeyA' }, axes: ['x', 'z'], forward: 'KeyW', why: 'from above W is up the screen (-Z), whatever way the body faces' },
  // the mouse (check 24): never locked, never turns the camera; a click acts where the cursor is
  pointer: { locks: false, turnsCamera: false, why: 'the camera is fixed over the plane; the cursor is free and aims where it points (input.cursorMode true)' },
  // a body (check 19): a picture sheet, judged by the gf-flat-1 judge, not a skeleton
  body: { kind: 'picture', slotType: 'image', standard: STANDARD, judge: 'bodyReport(image, { style, plane })', why: 'a picture body has no bones or clips; its sheet\'s shape, anchor and frames are what can go wrong' },
  // the world (check 17): a tile map, judged by its own rules
  world: { kind: 'tilemap', format: FORMAT, judge: 'worldReport(subject)', why: 'a tile map has no wall height, ceiling, doors or view past the edge; it has a closed map, a spawn a seat on open ground, and (side-on) every ledge and mark within a jump' },
  // a swapped slot (check 8): a picture changes pixels, never triangles
  swap: { slotType: 'image', proves: 'pixels', why: 'replacing a picture leaves the quad it is drawn on as it was: the proof is that the drawn pixels of that slot change' },
  // the preview and the contact sheet (check 9, the studio page): straight on
  shots: { camera: 'orthographic', frame: 'gf/three/flat/look.js frameSubject(ctx, state, subject)', why: 'a picture seen from a turntable\'s orbit is a line' },
  // nameplates (check 34)
  plates: { at: plane === 'side' ? 'position + (0, character.height + 0.3, 0)' : 'position + character.plateOffset (up the screen, -Z)', why: 'from above, over the head is up the screen, not +Y' },
});

/** Check 17's reading of a flat world. subject: { world (config/world.json), game (config/game.json), spec, target, intent }.
 *  The report shape of tools/lib/world-check.mjs checkWorld. */
export function worldReport(subject) {
  const cfg = subject.world ?? {}, game = subject.game ?? {}, plane = cfg.plane === 'side' ? 'side' : 'top', t = cfg.template ?? templates[plane][0];
  const problems = [], add = (rule, severity, message, fix = null) => problems.push({ rule, severity, message, fix, slot: 'world.map' });
  const M = readMap(cfg.map);
  for (const p of M.problems) add('map', 'error', p, 'fix config/world.json → map (the slot world.map)');
  const intent = SIZES[plane][subject.intent] ? subject.intent : SIZES[plane][cfg.size] ? cfg.size : 'small', [wantC, wantR] = SIZES[plane][intent];
  if (M.ok) {
    const seats = Math.max(1, Number(subject.spec?.players?.max ?? game.players?.max ?? 4) || 4);
    if (M.spawns.length < seats) add('spawns', 'error', `${M.spawns.length} spawns for ${seats} seats`, 'add "spawn" cells to the map');
    // the map is what the game reads; config/world.json → spawns (the world contract's list) must say the same
    if (Array.isArray(cfg.spawns) && JSON.stringify(cfg.spawns) !== JSON.stringify(spawnsOf(cfg.map))) add('mirror', 'error', `config/world.json → spawns lists ${cfg.spawns.length} points that are not the map's ${M.spawns.length} spawn cells (the map was edited after the list was written)`, 'node research/gf-three/tools/flat-map.mjs <game> --sync');
    if (M.cols * M.rows < wantC * wantR * 0.4 || M.cols * M.rows > wantC * wantR * 2.5) add('size', 'warning', `the map is ${M.cols} x ${M.rows} cells; "${intent}" is about ${wantC} x ${wantR}`);
    for (const s of M.spawns) {
      const here = M.solid(s.c, s.r), above = plane === 'side' ? M.solid(s.c, s.r - 1) : false;
      if (here === true || above === true) add('spaces', 'error', `the spawn at column ${s.c + 1}, row ${s.r + 1} is inside a ${plane === 'side' ? 'block' : 'wall'}`, 'move the spawn or the tile');
      if (plane === 'top' && [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dc, dr]) => M.solid(s.c + dc, s.r + dr) !== false)) add('spaces', 'error', `the spawn at column ${s.c + 1}, row ${s.r + 1} is walled in on every side`, 'open a way out');
    }
    if (plane === 'top') {
      // every spawn reaches every other on foot (4 ways)
      const seen = new Set(), key = (c, r) => `${c},${r}`, q = M.spawns.length ? [[M.spawns[0].c, M.spawns[0].r]] : [];
      while (q.length) { const [c, r] = q.pop(); if (seen.has(key(c, r)) || M.solid(c, r) !== false) continue; seen.add(key(c, r)); q.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]); }
      const cut = M.spawns.filter(s => !seen.has(key(s.c, s.r))).length;
      if (cut) add('paths', 'error', `${cut} spawn(s) cannot be walked to from the first spawn (walls close them off)`, 'open the walls between them');
      for (const [name, list] of Object.entries(M.marks)) { const off = list.filter(m => !seen.has(key(m.c, m.r))).length; if (off) add('paths', 'error', `${off} "${name}" mark(s) cannot be walked to from a spawn`, 'move them or open a way'); }
    } else {
      const C = game.controller ?? {}, R = jumpReach({ gravity: game.gravity ?? 20, jump: C.jump ?? SIDE.jump, speed: C.speed ?? SIDE.speed, fallScale: SIDE.fallScale }), G = reachOf(M, R);
      for (const p of G.problems) add('reach', 'error', p, 'lower it, move it nearer, or raise config/game.json → controller.jump');
      for (const p of G.notes) add('reach', 'warning', p);
    }
  }
  add('flat', 'warning', `a flat ${t} seen from ${plane === 'side' ? 'the side' : 'above'}: the rules about wall height, ceilings, doors, gates and the view past the edge are not this world's; its edge is closed and its picture continues past it`);
  const errors = problems.filter(p => p.severity === 'error').length, size = [M.cols * M.tile, M.rows * M.tile];
  return { tool: 'research/gf-three/kit/flat/index.js worldReport', check: 17, target: subject.target, template: t, kind: t, profile: 'flat-2d', plane, ok: errors === 0, errors, warnings: problems.length - errors, problems,
    stats: { size, area: Math.round(size[0] * size[1]), sizeClass: intent, measuredClass: intent, cells: [M.cols, M.rows], kinds: Object.keys(M.kinds ?? {}).length, rooms: 0, levels: 1, levelsAsked: 1, entries: 0, ceiling: null, filledGround: 0, spawns: M.spawns.length, marks: Object.fromEntries(Object.entries(M.marks ?? {}).map(([k, v]) => [k, v.length])) } };
}

/** Check 19's reading of a picture body. image: decoded RGBA ({width, height, data}), or { error } when it is not an
 *  8-bit RGBA PNG. → { ok, picture: true, summary, errors: [string], warnings: [string], stats: { frames, rows, cell } } */
export function bodyReport(image, { style = 'pixel', plane = 'side' } = {}) {
  if (!image || image.error) return { ok: false, picture: true, summary: image?.error ?? 'the picture could not be read', errors: [image?.error ?? 'the picture could not be read'], warnings: [], stats: {} };
  const j = judge('body', image, { style, plane }), errors = j.errors.map(e => `${e.rule}: ${e.message}`);
  return { ok: j.ok, picture: true, summary: errors.join('; '), errors, warnings: j.warnings.map(e => `${e.rule}: ${e.message}`), stats: { frames: j.frames, rows: j.rows, cell: j.cell } };
}

export const manifest = {
  id, standard: STANDARD,
  describe: 'A flat (2D) game: the same kit on a plane, seen from above or from the side, drawn with pictures in pixel or drawn style on a tile map',
  planes: PLANE, styles: Object.fromEntries(Object.entries(STYLES).map(([k, s]) => [k, { ppm: s.ppm, cell: s.cell, tile: s.tile, filter: s.hard ? 'nearest' : 'linear' }])),
  looks: Object.fromEntries(Object.entries(presets).map(([k, p]) => [k, { label: p.label, describe: p.describe, style: p.style }])),
  worlds: { field: { plane: 'top', label: 'Field', describe: 'A tile map seen from above: grass, paths, water and walls', sizes: SIZES.top }, stage: { plane: 'side', label: 'Stage', describe: 'A tile map seen from the side: ground, brick and ledges', sizes: SIZES.side } },
  cameras, templates, body: { from: 'sprite', frames: FRAMES, rows: ROWS, fill: FILL },
  map: { format: FORMAT, limits: LIMITS, slot: 'world.map', file: 'config/world.json', pointer: '/map', tiles: 'world.tiles.<kind>', spec: 'spec.world.map = { rows, legend?, kinds?, tile?, base? } (optional: without it a map of world.size is generated)' },
  side: { ...SIDE, gravity: 20, reachMargin: REACH_MARGIN, portrait: 'a phone held upright shows look.portrait metres across with the player\'s feet 38% up the screen; the stage scrolls, it is not shrunk' },
  runs: Object.fromEntries(PLANES.map(p => [p, Object.fromEntries(Object.entries(RUNS[p]).map(([k, v]) => [k, v.how]))])),
  // nothing is claimed that a mechanic could also claim: the part swaps how the kit's own controller is seen and steered
  owns: plane => [{ res: 'camera', why: `the flat ${plane} camera is fixed over the plane; no part turns it`, free: 'a game that needs a turning camera is not a flat game' }],
  reads,
  // at most three lines for the build agent, read only by builds of a flat game (create writes them into rules.js)
  note: plane => (plane === 'side' ? [
    'Side-on: positions are {x, y, z: 0}; X runs along the stage, Y is up. Place things at the map\'s marks (ctx.world.marks(name) → [{x, y, z}]) or by cell (ctx.world.map.feet(c, r)), never at y = 0 by habit: the ground is wherever the tile map puts it.',
    'The level is config/world.json → map (the slot world.map; kit/flat/tilemap.js): edit its rows, not code. A ledge or mark out of a jump\'s reach is refused by create and by check 17; node research/gf-three/tools/flat-reach.mjs <game> drives the real player over every jump.',
    'Bodies and props are pictures (gf-flat-1; kit/flat/ART-STANDARD.md): never build a mesh for one. ctx.assets.model("prop.<name>") gives a picture as a card. Bots hop but do not plan routes: steer them in bot(ctx, p) with p.input.x.',
  ] : [
    'From above: positions are {x, y: 0, z}; screen right is +X and screen up is -Z. Place things at the map\'s marks (ctx.world.marks(name) → [{x, y, z}]) or by cell (ctx.world.map.centre(c, r)); ctx.world.cell(p) says what tile a point is on.',
    'The level is config/world.json → map (the slot world.map; kit/flat/tilemap.js): edit its rows, not code. Solid kinds are walls; a kind with solid false is ground you can give a meaning in rules.js (ctx.world.cell(p).kind).',
    'Bodies and props are pictures (gf-flat-1; kit/flat/ART-STANDARD.md): never build a mesh for one. ctx.assets.model("prop.<name>") gives a picture as a card. Nobody jumps; the mouse cursor aims (player.aimPoint).',
  ]),
};
export { styleOf };
