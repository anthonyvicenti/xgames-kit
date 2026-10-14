// The world's light on bodies (runtimes/three/kit/look/materials.js setWorldLight; kit/character reads world.lightAt):
// a house material reads its own pair of world-light uniforms once set, the neutral pair (full sky, nothing added)
// before, and its shader scales the sun and sky by them and adds the block light.
import { installKitImports } from '../builder/tools/lib/kit-import.mjs';
installKitImports();
import { test } from 'node:test';
import assert from 'node:assert/strict';

const THREE = await import('three');
const M = await import('../runtimes/three/kit/look/materials.js');

const compile = m => {
  const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  m.onBeforeCompile(sh);
  return sh;
};

test('a house material is neutral until the world lights it, then reads its own pair', () => {
  const a = M.material('character'), b = M.material('character');
  const sa = compile(a);
  assert.deepEqual(sa.uniforms.uGfWorldLight.value.toArray(), [1, 1], 'full sky, all of the ambient');
  assert.deepEqual(sa.uniforms.uGfWorldBlock.value.toArray(), [0, 0, 0], 'nothing added');
  assert.match(sa.fragmentShader, /reflectedLight\.directDiffuse \*= gfSkyW/);
  assert.match(sa.fragmentShader, /reflectedLight\.indirectDiffuse \+= diffuseColor\.rgb \* uGfWorldBlock/);
  const u = M.worldLightUniforms();
  M.setWorldLight(a, u);
  u.uGfWorldLight.value.set(0, 0.03); u.uGfWorldBlock.value.set(0.8, 0.4, 0.1);
  assert.equal(compile(a).uniforms.uGfWorldLight, u.uGfWorldLight, 'its own pair, live');
  assert.notEqual(compile(b).uniforms.uGfWorldLight, u.uGfWorldLight, 'another body is untouched');
  assert.ok(a.needsUpdate !== false);
});

test('a clone (a per-body tint copy) starts neutral and takes its own pair', () => {
  const a = M.material('prop'), u = M.worldLightUniforms();
  M.setWorldLight(a, u);
  const c = a.clone();
  assert.notEqual(compile(c).uniforms.uGfWorldLight, u.uGfWorldLight);
  const v = M.worldLightUniforms(); M.setWorldLight(c, v);
  assert.equal(compile(c).uniforms.uGfWorldLight, v.uGfWorldLight);
});
