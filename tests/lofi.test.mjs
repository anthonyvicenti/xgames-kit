// The lofi pass (runtimes/three/kit/look/lofi.js, a game's gf/three/look/lofi.js): its numbers, its dither matrix, its palette, and the material patch.
// The pass on a real graphics card is the lofi kind's contact sheet (builder/look-judge/kind-sheet.mjs lofi).
import { installKitImports } from '../builder/tools/lib/kit-import.mjs';
installKitImports();
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const THREE = await import('three');
const L = await import('../runtimes/three/kit/look/lofi.js');

test('params: defaults, clamping, the dither matrix sides, palettes', () => {
  const d = L.lofiParams();
  assert.deepEqual({ ...d, palette: null }, { ...L.LOFI_DEFAULTS, palette: null });
  const p = L.lofiParams({ lines: 5, dither: 9, bayer: 3, steps: 1, wobble: -1, affine: 2 });
  assert.equal(p.lines, 90); assert.equal(p.dither, 2); assert.equal(p.bayer, L.LOFI_DEFAULTS.bayer); assert.equal(p.steps, 2);
  assert.equal(p.wobble, 0); assert.equal(p.affine, 1);
  assert.deepEqual(L.lofiParams({ palette: ['#AABBCC', '#000000'] }).palette, ['#aabbcc', '#000000']);
  assert.throws(() => L.lofiParams({ palette: ['red'] }), /'#rrggbb'/);
  assert.throws(() => L.lofiParams({ palette: Array.from({ length: 33 }, () => '#000000') }), /at most 32/);
});

test('scale: whole screen pixels a lofi pixel, near the asked lines', () => {
  assert.deepEqual(L.lofiScale({ lines: 270 }, 1080, 1), { scale: 4, pixelRatio: 0.25, lines: 270 });
  assert.deepEqual(L.lofiScale({ lines: 270 }, 1080, 2), { scale: 8, pixelRatio: 0.25, lines: 270 });
  const s = L.lofiScale({ lines: 240 }, 720, 1);
  assert.equal(s.scale, 3); assert.equal(s.lines, 240);
  for (const h of [300, 568, 844, 1440, 2160]) {
    const r = L.lofiScale({ lines: 240 }, h, 1);
    assert.ok(Number.isInteger(r.scale) && r.scale >= 1);
    assert.ok(Math.abs(r.lines - 240) <= 240 * 0.5, `${h}: ${r.lines} lines`);
  }
});

test('the dither is a true Bayer matrix: every threshold once per tile', () => {
  for (const n of [2, 4, 8]) {
    const seen = new Set();
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = L.bayerAt(x, y, n);
      assert.ok(v >= 0 && v < 1);
      seen.add(Math.round(v * n * n));
    }
    assert.equal(seen.size, n * n, `bayer ${n}`);
    assert.equal(L.bayerAt(n, 0, n), L.bayerAt(0, 0, n), 'it tiles');
  }
});

test('the effect carries the params into its uniforms; palettes cap at 32', () => {
  const e = new L.LofiEffect({ dither: 0.5, steps: 5, bayer: 8, palette: ['#ff0000', '#00ff00'] });
  const u = e.uniforms;
  assert.equal(u.get('uDither').value, 0.5); assert.equal(u.get('uSteps').value, 5); assert.equal(u.get('uBayer').value, 8);
  assert.equal(u.get('uCount').value, 2);
  assert.deepEqual(u.get('uPalette').value[1].toArray(), [0, 1, 0]);
  assert.equal(u.get('uPalette').value.length, L.MAX_PALETTE);
  e.set({ palette: null });
  assert.equal(u.get('uCount').value, 0);
  assert.match(e.fragmentShader, /mainImage/);
});

test('wobble patches a material once, chains its own patch, and keys its program', () => {
  const m = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  let theirs = 0;
  m.onBeforeCompile = () => { theirs++; };
  m.customProgramCacheKey = () => 'house';
  const U = L.wobbleUniforms();
  L.wobble(m, U); L.wobble(m, U);
  const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  m.onBeforeCompile(sh, null);
  assert.equal(theirs, 1, 'the material\'s own patch still runs, once');
  assert.match(sh.vertexShader, /uLofiGrid/); assert.match(sh.vertexShader, /vLofiUvW = vec3\( vMapUv \* gl_Position\.w/);
  assert.match(sh.fragmentShader, /vLofiUvW\.xy \/ vLofiUvW\.z/); assert.doesNotMatch(sh.fragmentShader, /#include <map_fragment>/);
  assert.equal(sh.uniforms.uLofiGrid, U.uLofiGrid, 'shared uniforms: one resize reaches every material');
  assert.equal(m.customProgramCacheKey(), 'house|gf-lofi');
  const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial()), new THREE.Mesh(new THREE.BoxGeometry(), m));
  assert.equal(L.wobbleTree(g, U), 1, 'only the unpatched material');
});

test('the lofi kind\'s look values are valid params for the pass', () => {
  const kind = JSON.parse(readFileSync(new URL('../kinds/lofi.json', import.meta.url), 'utf8'));
  const p = L.lofiParams(kind.look.three.values.post.lofi);
  assert.ok(p.palette.length >= 8 && p.palette.length <= L.MAX_PALETTE);
});
