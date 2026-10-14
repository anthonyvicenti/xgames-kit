// runtime godot: every picture slot of a 2D game judged against the gf-flat-1 standard (runtimes/three/profiles/flat-2d/
// ART-STANDARD.md), with the flat profile's own rules (judge.js) and the builder's PNG reader. Verify's measure 19.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importShared, SHARED } from './lib.mjs';

/** One picture file. → the judge's report with `file`; a file that is not an 8-bit RGBA PNG fails the `png` rule. */
export async function judgeFile(file, { kind, style = 'pixel', plane = 'side', solid = false } = {}) {
  const { decodePng } = await import(pathToFileURL(SHARED.png).href);
  const { judge } = await importShared('gf/three/flat/judge.js');
  const img = decodePng(await readFile(file));
  if (img.error) return { ok: false, file, kind, style, cell: null, rows: null, frames: null, errors: [{ rule: 'png', frame: null, message: img.error }], warnings: [] };
  return { file, ...judge(kind, img, { style, plane, solid }) };
}

/** Every picture slot of a created game that declares a gf-flat-1 constraint (sheet, tile, picture). */
export async function judgeGame(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8')), world = JSON.parse(await readFile(join(dir, 'config/world.json'), 'utf8'));
  const plane = world.plane === 'side' ? 'side' : 'top', out = [];
  for (const s of manifest.slots ?? []) {
    const c = s.constraints ?? {}, kind = c.sheet ? 'body' : c.tile ? 'tile' : c.picture ? 'prop' : null;
    if (s.type !== 'image' || !kind) continue;
    const style = (c.sheet ?? c.tile ?? c.picture).style ?? world.style ?? 'pixel';
    out.push({ slot: s.id, ...(await judgeFile(join(dir, s.source.file), { kind, style, plane, solid: c.tile?.solid ?? false })) });
  }
  return { ok: out.every(r => r.ok), plane, style: world.style ?? 'pixel', pictures: out };
}
