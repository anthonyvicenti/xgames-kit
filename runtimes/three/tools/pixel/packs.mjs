#!/usr/bin/env node
// packs.mjs: the pixel kind's art into the asset library, through the library's own ingest (builder/art/ingest.mjs:
// the flat judge validates every picture, the signature is measured, a manifest and a preview are written). Three packs:
//
//   flat-standins-pixel   the flat runtime's stand-ins by their old names (body-top, body-side: the player villager;
//                         the tiles grass, path, water, wall, ground, brick, ledge; the pickups), drawn anew
//   xk-pixel-folk         the villagers: each a 3-row sheet seen from above (<id>-top) and a 1-row sheet side-on (<id>-side)
//   xk-pixel-town         everything else: soil and cobble tiles, the edge sets, the dressing strips, props, set pieces
//
// Every binary is copied into the kit's default set (library/defaults), so a fresh clone has them. The drawings are
// also the flat runtime's stand-in files (builder/tools/lib/standin-assets/flat/pixel: folk.mjs and town.mjs --standins).
//
//   node runtimes/three/tools/pixel/packs.mjs [--only flat-standins-pixel,xk-pixel-folk,xk-pixel-town]
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FOLK, sheet } from './folk.mjs';
import { PICTURES, make } from './town.mjs';
import { copyFileWritableSync } from '../../../../builder/lib/writable.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../../..');
const imp = p => import(pathToFileURL(join(REPO, p)).href);
const { encodePng } = await imp('builder/art/png.mjs');
const { loadConfig } = await imp('builder/art/config.mjs');
const { ingest } = await imp('builder/art/ingest.mjs');
const { storePath } = await imp('builder/art/store.mjs');

const OWN = { spdx: 'CC0-1.0', author: 'xgames-kit (made by the kit\'s own tools; no upstream art)' };
const STANDIN_IDS = new Set(['tile-grass', 'tile-path', 'tile-water', 'tile-wall', 'tile-ground', 'tile-brick', 'tile-ledge', 'coin', 'gem', 'heart', 'key', 'star', 'crate']);
export const PACKS = {
  'flat-standins-pixel': { title: 'Flat pixel stand-ins', describe: 'The pixel art a flat 2D game starts with (gf-flat-1): the player villager (seen from above and side-on), the ground tiles, the pickups. Drawn by runtimes/three/tools/pixel/.' },
  'xk-pixel-folk': { title: 'Pixel folk', describe: 'Villagers for the pixel kind (gf-flat-1): a big head, a short body, five skin tones, hair, clothes, a hat or a beard; six frames (idle, walk1, walk2, air, act, down) in four facings from above and side-on. Drawn by runtimes/three/tools/pixel/folk.mjs.' },
  'xk-pixel-town': { title: 'Pixel town', describe: 'A cosy town for the pixel kind: soil and cobble tiles, soft edges for paths, ponds and fields, fences, walls and hedges that join, flowers and crops, trees, props and houses seen from above. Drawn by runtimes/three/tools/pixel/town.mjs.' },
};

/** What to ingest: [{ pack, id, file, opts }]. */
function plan(out) {
  const list = [];
  const put = (pack, id, pic, opts) => { const file = join(out, pack, `${id}.png`); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, encodePng(pic)); list.push({ pack, id, file, opts }); };
  for (const [id, v] of Object.entries(FOLK)) {
    for (const [rows, plane] of [[3, 'top'], [1, 'side']]) {
      const pic = sheet(id, { rows }), describe = `${v.describe}; a gf-flat-1 body sheet ${plane === 'top' ? 'seen from above (rows down, side, up)' : 'seen from the side'}`;
      const tags = ['pixel', 'villager', 'person', 'body', plane, ...v.label.toLowerCase().split(/\s+/)];
      if (id === 'folk-player') put('flat-standins-pixel', `body-${plane}`, pic, { category: 'sprite-sheet', plane, describe, tags: [...tags, 'player', 'tint'] });
      else put('xk-pixel-folk', `${id}-${plane}`, pic, { category: 'sprite-sheet', plane, describe, tags });
    }
  }
  for (const [id, d] of Object.entries(PICTURES)) {
    const { pic } = make(id), pack = STANDIN_IDS.has(id) ? 'flat-standins-pixel' : 'xk-pixel-town';
    const opts = d.what === 'tile' ? { category: 'tile', solid: d.solid ?? false } : d.what === 'edges' ? { category: 'tile', tileSet: d.mode } : d.what === 'dress' ? { category: 'tile', tileSet: 'dress' } : { category: 'picture' };
    put(pack, id, pic, { ...opts, describe: d.describe, tags: ['pixel', ...d.tags, ...(d.footprint ? ['set piece'] : [])] });
  }
  return list;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2), opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const only = opt('--only')?.split(',') ?? Object.keys(PACKS);
  const config = loadConfig(), out = join(REPO, '.cache/pixel-art');
  let bad = 0;
  const started = new Set();
  for (const item of plan(out).filter(x => only.includes(x.pack))) {
    const P = PACKS[item.pack], first = !started.has(item.pack) && !existsSync(join(REPO, 'library/packs', item.pack, 'pack.json'));
    started.add(item.pack);
    const r = await ingest(item.file, {
      config, renderer: null, pack: item.pack, id: item.id, style: 'pixel', texelsPerMetre: 16, replace: true,
      from: 'drawn by the kit\'s own tools (runtimes/three/tools/pixel/)', ...item.opts,
      ...(first ? { licence: OWN, licenceText: 'Made by the kit\'s own tools from code, with no upstream art. Released under CC0 1.0.', newPack: { title: P.title, describe: P.describe, owner: 'own', visibility: 'public', source: { kind: 'own', store: 'kit default set' } } } : {}),
    });
    if (r.failed.length || r.quarantined.length || r.schemaProblems?.length || !r.added.length) { bad++; console.error(`${item.pack}/${item.id}: ${JSON.stringify({ failed: r.failed, quarantined: r.quarantined, schema: r.schemaProblems, duplicates: r.duplicates, skipped: r.skipped }).slice(0, 600)}`); continue; }
    // the bytes into the kit's default set (in git), so every clone has them
    const m = JSON.parse(readFileSync(join(REPO, 'library/packs', item.pack, 'assets', `${item.id}.json`), 'utf8'));
    const to = storePath(config.defaults, m.sha256); mkdirSync(dirname(to), { recursive: true });
    if (!existsSync(to)) copyFileWritableSync(storePath(config.store, m.sha256), to);
    console.log(`${item.pack}/${item.id}  ok  ${m.validated.map(v => `${v.by} ${v.ok ? 'ok' : 'FAIL'}`).join(', ')}`);
  }
  process.exit(bad ? 1 : 0);
}
