// Bakes a pack's character poses into gf-flat-1 body sheets (6 frames: idle, walk1, walk2, air, act, down; 1 row,
// facing right) and judges each with the flat runtime's own judge (runtimes/three/profiles/flat-2d/judge.js). For the drawn
// kind: the platformer pack's 256 px poses are a drawn cell as they are (128 texels a metre, a 2 m cell).
//   const r = await bakeBodies('kenney-new-platformer-pack', outDir) → [{ id, file, judge }]
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KIT, repoFileOf } from './roots.mjs';
import { importLayer } from '../../tools/lib/kit-import.mjs';
import { packDir } from './packs.mjs';

/** What each pack's poses become, frame by frame (gf-flat-1 FRAMES order). */
export const BODY_BAKES = {
  'kenney-new-platformer-pack': {
    style: 'drawn', dir: 'Sprites/Characters/Double', ids: ['beige', 'green', 'pink', 'purple', 'yellow'],
    file: (id, pose) => `character_${id}_${pose}.png`,
    poses: ['idle', 'walk_a', 'walk_b', 'jump', 'front', 'duck'],
  },
};

export async function bakeBodies(pack, out) {
  const B = BODY_BAKES[pack];
  if (!B) return [];
  const { sharp } = await import(pathToFileURL(join(KIT, 'builder/tools/lib/char-deps.mjs')).href);
  const { judge } = await importLayer(repoFileOf('gf/three/flat/judge.js'));   // it imports across layers as a game's copy does
  mkdirSync(out, { recursive: true });
  const results = [];
  for (const id of B.ids) {
    const frames = B.poses.map(p => join(packDir(pack), B.dir, B.file(id, p)));
    if (!frames.every(existsSync)) continue;
    const metas = await Promise.all(frames.map(f => sharp(f).metadata()));
    const cell = metas[0].width;
    const sheet = sharp({ create: { width: cell * 6, height: cell, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(await Promise.all(frames.map(async (f, i) => ({ input: await sharp(f).ensureAlpha().png().toBuffer(), left: i * cell, top: 0 }))));
    const png = await sheet.png().toBuffer();
    const file = join(out, `body-np-${id}.png`);
    await sharp(png).toFile(file);
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const j = judge('body', { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) }, { style: B.style, plane: 'side' });
    results.push({ id: `np-${id}`, file, judge: { ok: j.ok, cell: j.cell, errors: j.errors, warnings: j.warnings } });
  }
  return results;
}

/** A kind's own body sheets in the asset library (kinds/<id>.json → bodies.three: "<pack>/<id>" refs), each judged by
 *  the flat runtime's judge as the sheet draws them. → [{ id, ok, errors }] */
export async function judgeLibraryBodies(refs, { style = 'pixel' } = {}) {
  const { findAsset, assetFile } = await import(pathToFileURL(join(KIT, 'builder/art/views.mjs')).href);
  const { decodePng } = await import(pathToFileURL(join(KIT, 'builder/art/png.mjs')).href);
  const { readFileSync } = await import('node:fs');
  const { judge } = await importLayer(repoFileOf('gf/three/flat/judge.js'));
  const out = [];
  for (const ref of refs.filter(r => r.includes('/'))) {
    const a = findAsset(ref), file = a ? await assetFile(a) : null;
    if (!file) { out.push({ id: ref, ok: false, errors: 1, why: 'not in the library on this machine' }); continue; }
    const pic = decodePng(readFileSync(file));
    const j = judge('body', { width: pic.width, height: pic.height, data: new Uint8Array(pic.data.buffer, pic.data.byteOffset, pic.data.length) }, { style, plane: a.use?.plane ?? 'top' });
    out.push({ id: ref, ok: j.ok, errors: j.errors.length });
  }
  return out;
}
