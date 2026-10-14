// gf-scenic: the tiling noise textures every scenic shader samples (wind, grass height, water ripples).
//
//   Ported from brunosimon/folio-2025@41046b5 src/Game/Noises.js (MIT, Copyright (c) 2025 Bruno Simon; licence in
//   research/gf-scenic/kit/LICENSE-folio-2025). gf-scenic: a function of the renderer instead of the game singleton;
//   the hash texture is left out (nothing here uses it). These are shader utilities computed on the GPU at start,
//   not art: nothing shows them directly.
import * as THREE from 'three/webgpu';
import { If, vec2, vec3, vec4, mod, Fn, dot, sin, fract, length, mul, float, uv, floor, ceil, smoothstep, int, mix, Loop } from 'three/tsl';

const hash = Fn(([p_immutable]) => {
  const p = vec2(p_immutable).toVar();
  p.assign(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))));
  return fract(sin(p).mul(43758.5453123));
}).setLayout({ name: 'gfHash', type: 'vec2', inputs: [{ name: 'p', type: 'vec2' }] });

const voronoiNode = Fn(([uv_immutable, repeat_immutable]) => {
  const repeat = float(repeat_immutable).toVar();
  const p = vec2(uv_immutable).toVar();
  p.mulAssign(repeat);
  const i = vec2(floor(p)).toVar();
  const f = vec2(fract(p)).toVar();
  const minDist = float(1.0).toVar();
  const minEdge = float(1.0).toVar();
  const bestId = vec2(0.0).toVar();
  Loop({ start: int(-1), end: int(1), name: 'y', condition: '<=' }, ({ y }) => {
    Loop({ start: int(-1), end: int(1), name: 'x', condition: '<=' }, ({ x }) => {
      const neighbor = vec2(x, y).toVar();
      const cell = vec2(mod(i.add(neighbor), repeat)).toVar();
      const point = vec2(hash(cell)).toVar();
      const diff = vec2(neighbor.add(point.sub(f))).toVar();
      const dist = float(length(diff)).toVar();
      If(dist.lessThan(minDist), () => { minEdge.assign(minDist); minDist.assign(dist); bestId.assign(i.add(neighbor)); })
        .ElseIf(dist.lessThan(minEdge), () => { minEdge.assign(dist); });
    });
  });
  return vec3(minDist, minEdge.sub(minDist), hash(fract(bestId.div(repeat))).x);
}).setLayout({ name: 'gfVoronoi', type: 'vec3', inputs: [{ name: 'uv', type: 'vec2' }, { name: 'repeat', type: 'float' }] });

const modulo = Fn(([divident_immutable, divisor_immutable]) => {
  const divisor = vec2(divisor_immutable).toVar();
  const divident = vec2(divident_immutable).toVar();
  return mod(vec2(mod(divident, divisor).add(divisor)), divisor);
}).setLayout({ name: 'gfModulo', type: 'vec2', inputs: [{ name: 'divident', type: 'vec2' }, { name: 'divisor', type: 'vec2' }] });

const random = Fn(([value_immutable]) => {
  const value = vec2(value_immutable).toVar();
  value.assign(vec2(dot(value, vec2(127.1, 311.7)), dot(value, vec2(269.5, 183.3))));
  return float(-1.0).add(mul(2.0, fract(sin(value).mul(43758.5453123))));
}).setLayout({ name: 'gfRandom', type: 'vec2', inputs: [{ name: 'value', type: 'vec2' }] });

const perlinNode = Fn(([uv_immutable, cell_amount_immutable, period_immutable]) => {
  const period = vec2(period_immutable).toVar();
  const cellAmount = float(cell_amount_immutable).toVar();
  const p = vec2(uv_immutable).toVar();
  p.assign(p.mul(cellAmount));
  const cMin = vec2(floor(p)).toVar();
  const cMax = vec2(ceil(p)).toVar();
  const pf = vec2(fract(p)).toVar();
  cMin.assign(modulo(cMin, period));
  cMax.assign(modulo(cMax, period));
  const blur = vec2(smoothstep(0.0, 1.0, pf)).toVar();
  const ll = vec2(random(vec2(cMin.x, cMin.y))).toVar();
  const lr = vec2(random(vec2(cMax.x, cMin.y))).toVar();
  const ul = vec2(random(vec2(cMin.x, cMax.y))).toVar();
  const ur = vec2(random(vec2(cMax.x, cMax.y))).toVar();
  const fr = vec2(fract(p)).toVar();
  return mix(mix(dot(ll, fr.sub(vec2(0, 0))), dot(lr, fr.sub(vec2(1, 0))), blur.x), mix(dot(ul, fr.sub(vec2(0, 1))), dot(ur, fr.sub(vec2(1, 1))), blur.x), blur.y).mul(0.8).add(0.5);
}).setLayout({ name: 'gfPerlin', type: 'float', inputs: [{ name: 'uv', type: 'vec2' }, { name: 'cell_amount', type: 'float' }, { name: 'period', type: 'vec2' }] });

function renderTo(renderer, outputNode, opts) {
  const target = new THREE.RenderTarget(128, 128, { depthBuffer: false, type: THREE.HalfFloatType, ...opts });
  target.texture.wrapS = target.texture.wrapT = THREE.RepeatWrapping;
  const material = new THREE.MeshBasicNodeMaterial();
  material.outputNode = outputNode;
  const quad = new THREE.QuadMesh(material);
  const state = THREE.RendererUtils.resetRendererState(renderer);
  renderer.setPixelRatio(1);
  renderer.setRenderTarget(target);
  quad.render(renderer);
  renderer.setRenderTarget(null);
  THREE.RendererUtils.restoreRendererState(renderer, state);
  material.dispose();
  return target.texture;
}

/** → { perlin, voronoi }: 128 x 128 repeating textures rendered once on this renderer. */
export function createNoises(renderer) {
  const voronoi = renderTo(renderer, vec4(voronoiNode(uv(), 8), 0));
  const perlin = renderTo(renderer, vec4(perlinNode(uv(), 6.0, 6.0).remap(0.1, 0.9, 0.0, 1.0), 0, 0, 0), { format: THREE.RedFormat });
  return { perlin, voronoi };
}
