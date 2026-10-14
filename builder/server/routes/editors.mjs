// /api/editors/…: what the map, skin and item editors need beyond the slot routes. Nothing here writes a game file in
// a way the slot routes could not: the map save IS a slot write (lib/slots setValue on world.map, the same function
// POST /api/game/slots/value calls), followed by the kit's own rewrite of what is derived from the map
// (tools/flat-map.mjs sync: config/world.json → spawns and half). The rest only reads the kit's library.
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { artLibrary, bodiesIn, findAsset, localFile, propsCatalog } from '../../art/views.mjs';
import { FLAT_KIT, GF3_TOOLS } from '../../lib/paths.mjs';
import { findSlot, setValue } from '../../lib/slots.mjs';
import { BASE_HEADERS } from '../security.mjs';
import { HttpError, openGame, readJson } from '../http.mjs';

const PACK = /^[a-z][a-z0-9.-]{0,39}$/, NAME = /^[a-z0-9][a-z0-9._-]*\.(glb|png)$/;
const TYPES = { glb: 'model/gltf-binary', png: 'image/png' };
const json = async f => JSON.parse(await readFile(f, 'utf8'));
// the flat profile's modules (runtimes/three/profiles/flat-2d, a game's gf/three/flat/)
const flatModule = rel => import(pathToFileURL(path.join(FLAT_KIT, rel)).href);

export default function register(router, ctx) {
  // the open game, read at each request: the studio may open another while the server runs (builder/server/index.mjs)
  const G = () => openGame(ctx);

  // the library's bodies, each with its picture, and which one the game's body slot holds now (by its bytes)
  router.get('/bodies', async () => {
    const list = bodiesIn('three').filter(b => localFile(findAsset(b.ref)));
    let current = null, file = null;
    try { const s = await findSlot(G(), `character.body.${ctxRole(ctx)}`); file = s.source?.file; } catch {}
    if (file && file.endsWith('.glb')) {
      try { const mine = createHash('sha256').update(await readFile(path.join(G(), file))).digest('hex'); current = list.find(b => b.sha256 === mine)?.id ?? null; } catch {}
    }
    const out = list.map(b => ({ id: b.id, label: b.label, describe: b.describe ?? '', height: b.height, tags: b.tags, playerColour: b.tint.length > 0, license: b.license,
      file: `/api/editors/library/${b.ref}.glb`, preview: `/api/editors/library/${b.ref}.png` }));
    return { bodies: out, current, slotFile: file };
  });

  // an asset library file (a body or prop model by <pack>/<id>.glb, or its preview <pack>/<id>.png): read-only
  router.get('/library/:pack/:file', async (req, res, { pack, file }) => {
    if (!PACK.test(pack) || !NAME.test(file)) throw new HttpError(404, 'no such library file');
    const [id, ext] = [file.replace(/\.(glb|png)$/, ''), file.split('.').pop()];
    const a = findAsset(`${pack}/${id}`), p = a && artLibrary().packs.get(pack);
    const full = !a ? null : ext === 'png' ? (a.preview ? path.join(p.dir, a.preview) : null) : localFile(a);
    let st; try { st = await stat(full); } catch { throw new HttpError(404, 'no such library file'); }
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': TYPES[ext] ?? 'application/octet-stream', 'content-length': st.size, 'cache-control': 'max-age=300' });
    createReadStream(full).pipe(res);
  });

  // the footprint of each library prop (metres, [w, h, d]): the layout editor draws props at their real size
  router.get('/props', async () => {
    const sizes = {};
    for (const p of propsCatalog('three').props) if (Array.isArray(p.size)) sizes[p.id] = p.size;
    return { sizes };
  });

  // the map: checked by the kit's own flat part, written through its slot, then the derived list rewritten by the kit
  router.post('/map', async req => {
    const { map } = await readJson(req, { limit: 512 * 1024 });
    if (!map || typeof map !== 'object') throw new HttpError(400, 'map is required');
    const slot = await findSlot(G(), 'world.map').catch(() => null);
    if (!slot) throw new HttpError(400, 'this game has no tile map (no world.map slot)');
    const { readMap, reachOf, jumpReach } = await flatModule('tilemap.js');
    const { SIDE } = await flatModule('slots.js');
    const M = readMap(map);
    if (!M.ok) throw new HttpError(400, `the map has problems: ${M.problems.join('; ')}`);
    if (M.side) {
      const game = await json(path.join(G(), 'config', 'game.json')).catch(() => ({}));
      const C = game.controller ?? {};
      const reach = reachOf(M, jumpReach({ gravity: game.gravity ?? 20, jump: C.jump ?? SIDE.jump, speed: C.speed ?? SIDE.speed, fallScale: SIDE.fallScale }));
      if (reach.problems.length) throw new HttpError(400, `out of reach: ${reach.problems.join('; ')}`);
    }
    const wrote = await setValue(G(), 'world.map', map);
    const derived = await syncDerived(G());
    return { id: wrote.id, file: wrote.file, cols: M.cols, rows: M.rows, spawns: M.spawns.length, derived };
  });
}

/**
 * What is derived from the map, written again (config/world.json → spawns and half): builder/tools/flat-map.mjs's
 * sync() when it is there, else the same three lines here on the kit's own spawnsOf.
 */
async function syncDerived(gameDir) {
  const tool = path.join(GF3_TOOLS, 'flat-map.mjs');
  try { await stat(tool); return (await import(pathToFileURL(tool).href)).sync(gameDir); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
  const { readMap } = await flatModule('tilemap.js');
  const { spawnsOf } = await flatModule('index.js');
  const file = path.join(gameDir, 'config', 'world.json'), world = await json(file), M = readMap(world.map);
  const next = { ...world, spawns: spawnsOf(world.map), half: Math.round((M.cols * M.tile) / 2) };
  if (JSON.stringify(next) === JSON.stringify(world)) return [];
  await writeFile(file, `${JSON.stringify(next, null, 1)}\n`);
  return ['config/world.json'];
}

// the role whose body the skin editor edits: the player (every game has one; other roles are a next step)
const ctxRole = () => 'player';
