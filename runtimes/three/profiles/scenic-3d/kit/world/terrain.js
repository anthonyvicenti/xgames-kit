// gf-scenic terrain: the generated islands' tops, cliff skirts, water and waterfalls.
//
//   After brunosimon/folio-2025@41046b5 src/Game/Terrain.js (the terrain data: r paths and slabs, g grass, b water
//   depth, sampled by world position; its colour node), src/Game/World/Floor.js (the floor material: the terrain
//   colour, folio's slabs texture where r is, grass shading the ground, water depth displacing it) and
//   src/Game/World/WaterSurface.js (the shore line and ripples over the water) (MIT, Copyright (c) 2025 Bruno Simon;
//   licence in research/gf-scenic/kit/LICENSE-folio-2025). gf-scenic: the data texture is computed from the layout
//   (generate.js terrainData) instead of baked in Blender; folio's single endless floor became one top per island,
//   meeting a cliff skirt that tapers to a hanging point (the floating isles), with mossy vertex colours; the
//   waterfalls are new. Every colour is a world.<template>.* slot.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, uniform, uniformArray, mix, texture, positionWorld, positionLocal, positionGeometry, modelWorldMatrix, uv, max, min, abs, fwidth, Loop, int, length } from 'three/tsl';
import { HouseMaterial, U } from '../look/materials.js';
import { terrainData, outlineRadius, rngOf } from './generate.js';

/** The terrain data texture and its world mapping (folio's terrainNode). */
export function createTerrainData(cfg) {
  const t = terrainData(cfg);
  const tex = new THREE.DataTexture(t.data, t.width, t.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.flipY = false; tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  const origin = uniform(new THREE.Vector2(t.box[0], t.box[1]));
  const size = uniform(new THREE.Vector2(t.width * t.texel, t.height * t.texel));
  const node = texture(tex);
  /** folio's terrainNode: the data (r slab, g grass, b depth, a island) at a world xz */
  const terrainNode = Fn(([xz]) => node.sample(xz.sub(origin).div(size)));
  return { texture: tex, terrainNode, raw: t, origin, size };
}

/** The terrain colours (world slots) as uniforms, and folio's colour node: dirt, water bed by depth, grass by g. */
export function terrainColors(cfg) {
  const g = cfg.ground ?? {}, w = cfg.water ?? {};
  const C = {
    grass: uniform(new THREE.Color(g.grass ?? '#4f7d3e')), grass2: uniform(new THREE.Color(g.grass2 ?? '#6c9a45')),
    dirt: uniform(new THREE.Color(g.dirt ?? '#5b4a3c')), path: uniform(new THREE.Color(g.path ?? '#8a8494')),
    slabLow: uniform(new THREE.Color(g.slabLow ?? '#5d5866')), slabHigh: uniform(new THREE.Color(g.slabHigh ?? '#8c8697')),
    water: uniform(new THREE.Color(w.color ?? '#2a6f8a')), bed: uniform(new THREE.Color(w.bed ?? '#1b3550')), foam: uniform(new THREE.Color(w.foam ?? '#d9f4ff')),
    slabFreq: uniform(1 / (g.slabs?.size ?? 5.7)),
  };
  // folio Terrain.colorNode: the dirt-to-water gradient by depth, then grass by g (varied by a slow perlin)
  C.colorNode = Fn(([d, xz]) => {
    const wet = mix(C.water, C.bed, d.b.smoothstep(0.2, 1));
    const base = mix(C.dirt, wet, d.b.smoothstep(0.02, 0.25)).toVar();
    const vary = U.perlin.sample(xz.mul(0.035)).r;
    base.assign(mix(base, mix(C.grass, C.grass2, vary.smoothstep(0.3, 0.75)), d.g));
    return base;
  });
  return C;
}

/**
 * Glowing rune lines (the creator's reference art: lit edges and rings on the arena floor), computed in the shader so
 * they stay crisp at any zoom: just inside each plaza's edge, two rings in its middle, a ring round each portal.
 * levels: config/world.json levels; on: cfg.runes. → a node (0..1) for a world xz
 */
export function runeNode(levels, on = true) {
  const n = Math.max(1, Math.min(8, levels.length));
  const plaza = uniformArray(Array.from({ length: n }, (_, i) => { const p = levels[i]?.plaza; return p ? new THREE.Vector4(p.at[0], p.at[1], p.half[0], p.corner) : new THREE.Vector4(0, 0, -1, 0); }), 'vec4');
  const rings = uniformArray(Array.from({ length: n }, (_, i) => { const p = levels[i]?.plaza; return p ? new THREE.Vector4(Math.min(3.4, p.half[0] * 0.5), Math.min(1.4, p.half[0] * 0.2), 0, 0) : new THREE.Vector4(0, 0, 0, 0); }), 'vec4');
  const portal = uniformArray(Array.from({ length: n }, (_, i) => { const z = levels[i]?.zones?.portal?.at; return z && levels[i]?.plaza ? new THREE.Vector4(z[0], z[2], 2.7, 1) : new THREE.Vector4(0, 0, 0, 0); }), 'vec4');
  const enabled = uniform(on ? 1 : 0);
  const line = (d, w) => { const fw = fwidth(d).max(0.004); return float(1).sub(abs(d).sub(w).div(fw.mul(1.2)).clamp(0, 1)); };
  const node = Fn(([xz]) => {
    const g = float(0).toVar();
    Loop({ start: int(0), end: int(n), type: 'int', condition: '<' }, ({ i }) => {
      const p = plaza.element(i), r = rings.element(i), q = portal.element(i);
      const rel = xz.sub(p.xy);
      const qd = abs(rel).sub(vec2(p.z.sub(p.w))).toVar();
      const sd = length(max(qd, vec2(0))).add(min(max(qd.x, qd.y), 0)).sub(p.w);
      const on = p.z.greaterThan(0).select(float(1), float(0));
      g.assign(max(g, line(sd.add(0.85), 0.05).mul(on)));
      const c = length(rel);
      g.assign(max(g, line(c.sub(r.x), 0.05).mul(on)));
      g.assign(max(g, line(c.sub(r.y), 0.04).mul(on).mul(0.8)));
      g.assign(max(g, line(length(xz.sub(q.xy)).sub(q.z), 0.05).mul(q.w)));
    });
    return g.mul(enabled);
  });
  return { node, enabled };
}

/** folio's Floor material on an island top: terrain colour, slabs where r is, grass shading the ground, water depth. */
export function floorMaterial(T, C, slabs, depth = 0.45, runes = null) {
  const node = slabs ? texture(slabs) : null;
  const colorNode = Fn(() => {
    const d = T.terrainNode(positionWorld.xz);
    const base = C.colorNode(d, positionWorld.xz).toVar();
    const pat = node ? node.sample(positionWorld.xz.mul(C.slabFreq)).r : float(0.6);
    const tint = U.perlin.sample(positionWorld.xz.mul(0.07)).r;
    const slab = mix(C.slabLow, C.slabHigh, pat).mul(tint.mul(0.25).add(0.88));
    return mix(base, slab, d.r);
  })();
  const shadowNode = Fn(() => { const d = T.terrainNode(positionWorld.xz); return d.g.mul(0.55); })();
  const alphaNode = Fn(() => T.terrainNode(positionWorld.xz).a.mul(4).sub(0.5))();
  // runes: glowing lines on the plazas and round the portals, in the look's rune colour (look.glow.rune)
  const emissiveNode = runes && Fn(() => {
    const g = runes.node(positionWorld.xz);
    const pulse = U.time.mul(1.3).add(positionWorld.x.add(positionWorld.z).mul(0.15)).sin().mul(0.15).add(0.85);
    return U.glowRune.div(max(0.05, U.glowRune.r.mul(0.2126).add(U.glowRune.g.mul(0.7152)).add(U.glowRune.b.mul(0.0722)))).mul(g.mul(U.glowIntensity).mul(pulse).mul(0.55));
  })();
  const m = new HouseMaterial({ colorNode, normalNode: vec3(0, 1, 0), shadowNode, alphaNode, emissiveNode, alphaTest: 0.5, flags: { bounce: false, coreShadows: false } }, 'ground');
  m.positionNode = Fn(() => {
    const p = positionGeometry.toVar();
    const d = T.terrainNode(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xz);
    p.y.addAssign(d.b.mul(-depth));
    return p;
  })();
  return m;
}

/** An island top: rings from the centre out to the outline (polar), flat at y = 0. */
export function topGeometry(level, { ringStep = 0.45, segments = 160 } = {}) {
  const R = level.shape.radius, K = Math.max(8, Math.ceil(R / ringStep)), S = segments;
  const pos = [0, 0, 0], idx = [];
  for (let k = 1; k <= K; k++) for (let s = 0; s < S; s++) {
    const a = (s / S) * Math.PI * 2, r = outlineRadius(level.shape, a) * (k / K);
    pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
  }
  const at = (k, s) => (k === 0 ? 0 : 1 + (k - 1) * S + (s % S));
  for (let s = 0; s < S; s++) idx.push(0, at(1, s + 1), at(1, s));
  for (let k = 1; k < K; k++) for (let s = 0; s < S; s++) { const a = at(k, s), b = at(k, s + 1), c = at(k + 1, s), d = at(k + 1, s + 1); idx.push(a, b, d, a, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

/** A dungeon level's top: a grid over its box (the floor shader keeps only the rooms and corridors). */
export function boxTopGeometry(level) {
  const [x0, z0, x1, z1] = level.box, [cx, , cz] = level.at;
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, Math.ceil((x1 - x0) / 1.5), Math.ceil((z1 - z0) / 1.5)).rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2 - cx, 0, (z0 + z1) / 2 - cz);
  return g;
}

const lerpC = (a, b, t, out) => out.copy(a).lerp(b, t);
/**
 * The rock under an island (or an islet): rings from the outline down to a hanging point, a cliff for the first few
 * metres and then a taper, jittered by a seeded noise; flat-shaded facets with moss at the top. kind 'shore' is a short
 * skirt into the sea. → BufferGeometry with vertex colours (rock, darker rock, moss).
 */
export function cliffGeometry(shape, { depth = 16, seed = 1, kind = 'float', colors, segments = 72, rows = 12, cap = false, capColor = null }) {
  const rng = rngOf(seed);
  const S = segments, M = kind === 'shore' ? 3 : rows;
  const jit = Array.from({ length: (M + 1) * S }, () => rng() - 0.5);
  const ringRot = Array.from({ length: M + 1 }, () => (rng() - 0.5) * 0.12);
  const rows3 = [];
  const R = shape.radius;
  for (let k = 0; k <= M; k++) {
    const t = k / M;
    const y = kind === 'shore' ? -t * depth : -depth * Math.pow(t, 1.25);
    // a cliff wall for the first third (a bulge at its middle), then the taper to a hanging point
    const lip = 0.32;
    const f = kind === 'shore' ? 1 + t * 0.35 : t < lip ? 1 + 0.035 * Math.sin((t / lip) * Math.PI) - 0.04 * (t / lip) : Math.pow(1 - (t - lip) / (1 - lip), 0.9) * 0.96;
    const ring = [];
    for (let s = 0; s < S; s++) {
      const a = (s / S) * Math.PI * 2 + ringRot[k] * (k ? 1 : 0);
      const j = k === 0 ? 0 : jit[k * S + s] * Math.min(1.1, R * 0.08) * (kind === 'shore' ? 0.6 : 1);
      const r = Math.max(0, outlineRadius(shape, a) * f + j * (t < 0.98 ? 1 : 0));
      ring.push([Math.cos(a) * r, y + (k && k < M ? jit[(k * S + s + 7) % jit.length] * depth * 0.035 : 0), Math.sin(a) * r]);
    }
    rows3.push(ring);
  }
  const pos = [], col = [];
  const cRock = new THREE.Color(colors.cliff), cDark = new THREE.Color(colors.cliff2), cMoss = new THREE.Color(colors.moss), c = new THREE.Color();
  const tone = (k, s) => { const t = k / M; const n = jit[(k * S + s * 3) % jit.length]; lerpC(cRock, cDark, Math.min(1, Math.max(0, t * 1.3 - 0.15 + n * 0.45)), c); if (k === 0 || (k === 1 && n > -0.25 && kind !== 'shore') || (k === 2 && n > 0.3 && kind !== 'shore')) lerpC(c, cMoss, k === 0 ? 1 : k === 1 ? 0.8 : 0.55, c); return c; };
  const tri = (a, b, d, ka, sa) => { pos.push(...a, ...b, ...d); const cc = tone(ka, sa); for (let q = 0; q < 3; q++) col.push(cc.r, cc.g, cc.b); };
  for (let k = 0; k < M; k++) for (let s = 0; s < S; s++) {
    const a = rows3[k][s], b = rows3[k][(s + 1) % S], d = rows3[k + 1][s], e = rows3[k + 1][(s + 1) % S];
    tri(a, d, b, k, s); tri(b, d, e, k, s);
  }
  if (cap) {
    // a low dome of moss: a ring halfway in, raised a little, then the centre
    const top = rows3[0], dome = capColor ? 0 : Math.min(0.5, R * 0.12), mid = top.map(([x, , z]) => [x * 0.55, dome * 0.7, z * 0.55]);
    const capC = capColor ? new THREE.Color(capColor) : cMoss;
    const cm = new THREE.Color(), shade = t => cm.copy(capC).multiplyScalar(0.92 + t * 0.12);
    for (let s = 0; s < S; s++) {
      const a = top[s], b = top[(s + 1) % S], c = mid[s], d = mid[(s + 1) % S];
      pos.push(...a, ...c, ...b, ...b, ...c, ...d, ...c, 0, dome, 0, ...d);
      for (let q = 0; q < 6; q++) { const cc = shade(0); col.push(cc.r, cc.g, cc.b); }
      for (let q = 0; q < 3; q++) { const cc = shade(1); col.push(cc.r, cc.g, cc.b); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** The rock material (vertex colours carry the rock, the darker rock and the moss). */
export function rockMaterial() {
  return new HouseMaterial({ color: '#ffffff', vertexColors: true, flatShading: true }, 'prop');
}

/** folio's water surface over an island's ponds and streams: the shore line and slow ripples, nothing else (the
 *  floor under it already carries the water's colour by depth). */
export function waterSurfaceMaterial(T, C) {
  const alphaNode = Fn(() => {
    const d = T.terrainNode(positionWorld.xz);
    const shore = d.b.smoothstep(0.05, 0.16).mul(float(1).sub(d.b.smoothstep(0.16, 0.3)));
    const t = U.windTime.mul(0.5).add(U.time.mul(0.04));
    const n = U.perlin.sample(positionWorld.xz.mul(0.12).add(vec2(t, t.mul(0.7)))).r;
    const ripple = d.b.add(n.mul(0.6)).mul(9).add(t.mul(3)).fract().smoothstep(0.9, 0.97).mul(d.b.smoothstep(0.15, 0.35));
    return max(shore, ripple.mul(0.8)).mul(d.b.greaterThan(0.02).select(float(1), float(0))).sub(0.35);
  })();
  const m = new HouseMaterial({ color: '#ffffff', transparent: true, depthWrite: false, colorNode: C.foam, alphaNode, alphaTest: 0, normalNode: vec3(0, 1, 0), flags: { coreShadows: false, bounce: false, lamps: true } }, 'water');
  return m;
}

/** A waterfall: a ribbon falling from the lip of the cliff, arcing out, streaked and glowing, fading at the bottom. */
export function fallGeometry(fall, { cols = 4, rows = 28 } = {}) {
  const pos = [], uvs = [], idx = [];
  const a = fall.angle, out = [Math.cos(a), Math.sin(a)], side = [-Math.sin(a), Math.cos(a)];
  for (let r = 0; r <= rows; r++) {
    const t = r / rows, drop = fall.drop * t, push = 0.35 + Math.sqrt(t) * 1.6;
    for (let c = 0; c <= cols; c++) {
      const u = c / cols, w = fall.width * (1 + t * 0.6) * (u - 0.5);
      pos.push(out[0] * push + side[0] * w, -drop, out[1] * push + side[1] * w);
      uvs.push(u, t);
    }
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const i = r * (cols + 1) + c, j = i + cols + 1; idx.push(i, j, i + 1, i + 1, j, j + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function fallMaterial(color) {
  const m = new THREE.MeshBasicNodeMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const c = uniform(new THREE.Color(color));
  m.userData.gfGlow = true;
  m.userData.fallColor = c;
  m.colorNode = Fn(() => {
    const p = uv();
    const streak = U.perlin.sample(vec2(p.x.mul(1.3), p.y.mul(2.2).sub(U.time.mul(0.9)))).r;
    const streak2 = U.perlin.sample(vec2(p.x.mul(3.1).add(0.37), p.y.mul(4.1).sub(U.time.mul(1.4)))).r;
    const k = streak.mul(0.6).add(streak2.mul(0.5)).smoothstep(0.35, 0.95);
    const edge = p.x.sub(0.5).abs().mul(2).smoothstep(0.55, 1).oneMinus();
    const fade = p.y.smoothstep(0.55, 1).oneMinus();
    const top = p.y.smoothstep(0, 0.06);
    const glow = mix(c.mul(0.55), c.mul(1.55).add(0.15), k);
    return vec4(mix(glow, U.fogB, p.y.smoothstep(0.35, 1).mul(0.7)), edge.mul(fade).mul(top).mul(k.mul(0.55).add(0.4)));
  })();
  m.fog = false;
  return m;
}
