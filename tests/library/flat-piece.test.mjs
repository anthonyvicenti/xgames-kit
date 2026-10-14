// gf-flat-1's tile-set pieces: an edge, a corner or an end is judged as a tile without the seam rule, only when it is
// declared one (the library's use.tile false). A game's own tile kinds keep every rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { importLayer } from '../../builder/tools/lib/kit-import.mjs';
import { encodePng } from '../../builder/art/png.mjs';
import { validatePicture } from '../../builder/art/validate.mjs';
import { fillSlots, needFromSlot } from '../../builder/art/resolve.mjs';
import { toolPath } from '../../builder/art/toolpaths.mjs';

const { judge } = await importLayer(toolPath('flatJudge'));

/** A 16 px pixel tile: grass with a dirt band along its top rows (the north edge of a dirt patch: it never wraps). */
function edgeTile({ hole = false } = {}) {
  const W = 16, data = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, dirt = y < 5;
    data.set(dirt ? [214, 160, 104, 255] : [104, 190, 96, 255], i);
    if (hole) data[i + 3] = 0;
  }
  return { width: W, height: W, data };
}

test('a tile whose top and bottom do not continue fails the seam rule; declared a piece, it is judged without it', () => {
  const plain = judge('tile', edgeTile(), { style: 'pixel' });
  assert.equal(plain.ok, false);
  assert.ok(plain.errors.some(e => e.rule === 'seam'), JSON.stringify(plain.errors));
  const piece = judge('tile', edgeTile(), { style: 'pixel', piece: true });
  assert.equal(piece.ok, true, JSON.stringify(piece.errors));
  assert.equal(piece.warnings.some(w => w.rule === 'seam'), false);
});

test('a piece keeps every other tile rule: an empty piece still fails', () => {
  const r = judge('tile', edgeTile({ hole: true }), { style: 'pixel', piece: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.rule === 'empty'));
});

test('the library validator passes piece only for a tile it is told is one', async () => {
  const png = Buffer.from(encodePng({ width: 16, height: 16, data: Buffer.from(edgeTile().data) }));
  const fill = await validatePicture(png, { category: 'tile', style: 'pixel' });
  assert.equal(fill.by, 'flat-judge');
  assert.equal(fill.ok, false);
  const piece = await validatePicture(png, { category: 'tile', style: 'pixel', piece: true });
  assert.equal(piece.ok, true, piece.problems.join('; '));
  // a picture (a prop) is never judged as a tile, piece or not
  const prop = await validatePicture(png, { category: 'sprite', style: 'pixel', piece: true });
  assert.equal(prop.ok, true);
});

test('a game\'s tile kind asks for a tile that repeats: a piece never fills it', () => {
  const slot = { id: 'world.tiles.ground', type: 'image', label: 'Ground', description: 'grass ground', source: { file: 'assets/tiles/ground.png' }, constraints: { tile: { standard: 'gf-flat-1', style: 'pixel' } } };
  const need = needFromSlot(slot);
  assert.equal(need.tile, true);
  const asset = (id, tile, describe) => ({ id, pack: 'p', file: `${id}.png`, sha256: id.padEnd(64, '0'), dimension: '2d', category: 'tile', describe, tags: ['grass', 'ground'], use: { style: 'pixel', tile }, validated: [{ by: 'flat-judge', ok: true }] });
  const lib = [{ pack: { id: 'p', licence: { spdx: 'CC0-1.0' } }, assets: [asset('grass-edge', false, 'grass ground edge'), asset('grass', true, 'grass ground')] }];
  const r = fillSlots(lib, [slot], { policy: { classes: { 'public-domain': { rank: 0, spdx: ['CC0-1.0'], duty: 'none' } }, allow: ['public-domain'] } });
  assert.equal(r.filled[0]?.pick.id, 'grass', JSON.stringify(r));
});
