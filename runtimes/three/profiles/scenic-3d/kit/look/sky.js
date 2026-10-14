// gf-scenic sky and void: the scene's background node.
//
//   After brunosimon/folio-2025@41046b5 src/Game/Fog.js (MIT, Copyright (c) 2025 Bruno Simon; licence in
//   research/gf-scenic/kit/LICENSE-folio-2025), where the fog's screen gradient is also the background, so distant
//   things melt into the sky. gf-scenic adds a vertical tint (sky.top) and stars (sky.stars, starColor, starSize),
//   both look slots; there is no texture: the stars are a hash over the view direction.
import { Fn, vec2, vec3, float, uniform, mix, floor, fract, sin, dot, atan, asin, positionWorldDirection, max } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { U, fogColorNode } from './materials.js';

export const S = {
  top: uniform(new THREE.Color('#3b2d70')),
  strength: uniform(0.25),
  stars: uniform(0.5),
  starColor: uniform(new THREE.Color('#e8e0ff')),
  starSize: uniform(1),
};

const h21 = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

/** The background: the fog gradient, a tint toward the top, stars. */
export const skyNode = Fn(() => {
  const d = positionWorldDirection.normalize();
  const base = vec3(fogColorNode).toVar();
  base.assign(mix(base, S.top, d.y.smoothstep(0.05, 0.9).mul(S.strength)));
  // stars on a grid over the sphere (longitude x latitude), one candidate per cell, a few lit by the hash
  const g = vec2(atan(d.z, d.x).div(6.2832).add(0.5), asin(d.y.clamp(-1, 1)).div(3.1416).add(0.5)).mul(vec2(360, 180));
  const cell = floor(g), f = fract(g);
  const r = h21(cell), r2 = h21(cell.add(17.3)), r3 = h21(cell.add(41.9));
  const at = vec2(r2, r3).mul(0.6).add(0.2);
  const dist = f.sub(at).length();
  const lit = r.greaterThan(float(1).sub(S.stars.mul(0.09))).select(float(1), float(0));
  const twinkle = sin(U.time.mul(r2.mul(3).add(1)).add(r3.mul(40))).mul(0.35).add(0.65);
  const star = float(1).sub(dist.div(S.starSize.mul(0.09).add(0.02))).clamp(0, 1).pow(2).mul(lit).mul(twinkle).mul(max(0, d.y.add(0.35)).clamp(0, 1));
  base.addAssign(S.starColor.mul(star.mul(1.6)));
  return base.add(vec3(U.flash.mul(0.25)));
})();

export function setSky(v = {}) {
  const s = v.sky ?? {};
  S.top.value.set(s.top ?? '#3b2d70');
  S.strength.value = s.strength ?? 0.25;
  S.stars.value = s.stars ?? 0;
  S.starColor.value.set(s.starColor ?? '#ffffff');
  S.starSize.value = s.starSize ?? 1;
}
