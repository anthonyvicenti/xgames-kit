// gf-scenic: the house material, after folio-2025's MeshDefaultMaterial and Materials.js.
//
//   Ported from brunosimon/folio-2025@41046b5 src/Game/Materials/MeshDefaultMaterial.js and src/Game/Materials.js
//   (MIT, Copyright (c) 2025 Bruno Simon; the licence is research/gf-scenic/kit/LICENSE-folio-2025, beside this kit).
//   gf-scenic: the folio game singleton became the shared uniforms U below (the look sets them every frame); the
//   material's own colour comes from three's diffuseColor (material.color x map x vertex colours x instance colour),
//   so material.color, map, emissive and opacity keep meaning what they mean, and a material is patched in place
//   (references held by the kit's tint, hit flash and fair-play shimmer keep working); emissive is added for bloom;
//   lantern light pools and a character rim light were added; the reveal effect and the water line were left out.
//
//   material(kind, opts)          a new house material: 'character' | 'prop' | 'ground' | 'water' | 'liquid' | 'glow' | 'decal'
//   adoptMaterials(object, kind)  every lit material under object becomes a house material, in place (kept names)
//   adoptScene(scene)             the same for anything in the scene not adopted yet (the look runs it every frame)
//   HouseMaterial                 MeshLambertNodeMaterial + the house output (folio's MeshDefaultMaterial)
//   U                             the shared uniforms (light, shade, fog, bounce, lamps, rim, wind, time, noise)
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uniform, uniformArray, mix, max, If, Loop, int, positionWorld, normalWorld, diffuseColor,
  materialEmissive, materialColor, rangeFogFactor, viewportUV, frontFacing, cameraPosition, luminance, texture, screenSize,
} from 'three/tsl';

const v4 = () => new THREE.Vector4(0, -9999, 0, 0);
export const LAMP_SLOTS = 8;

// a 1x1 grey placeholder until the look renders its noise textures (TextureNode.value is swapped, no rebuild)
const grey = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
grey.needsUpdate = true;

/** The shared uniforms. The look writes them; every house material, grass blade and leaf reads them. */
export const U = {
  lightDir: uniform(new THREE.Vector3(0.4, 0.8, 0.4).normalize()),
  lightColor: uniform(new THREE.Color('#ffffff')),
  lightIntensity: uniform(1),
  coreLow: uniform(-0.25),
  coreHigh: uniform(1),
  shadowColor: uniform(new THREE.Color('#4b3896')),
  shadowStrength: uniform(1),
  bounceColor: uniform(new THREE.Color('#5d7d46')),
  bounceStrength: uniform(0.6),
  bounceDistance: uniform(1.5),
  bounceLow: uniform(-1),
  bounceHigh: uniform(1),
  fogA: uniform(new THREE.Color('#2b2552')),
  fogB: uniform(new THREE.Color('#08081a')),
  fogNear: uniform(34),
  fogFar: uniform(120),
  fogRadialStart: uniform(0.1),
  fogRadialEnd: uniform(0.85),
  fogCenter: uniform(new THREE.Vector2(0.5, 0.42)),
  voidTop: uniform(-1),
  voidBottom: uniform(-26),
  rimColor: uniform(new THREE.Color('#a9a6ff')),
  rimStrength: uniform(0.4),
  charLift: uniform(0.4),            // characters: their shade moves this far toward white (they read in dark scenes)
  charShade: uniform(0.75),          // characters: how strong their shade is
  charBright: uniform(1.05),         // characters: a lift of their lit colour
  lampColor: uniform(new THREE.Color('#ffae5c')),
  lampIntensity: uniform(1.3),
  lampRadius: uniform(6.5),
  lamps: uniformArray(Array.from({ length: LAMP_SLOTS }, v4), 'vec4'),
  lampTints: uniformArray(Array.from({ length: LAMP_SLOTS }, () => new THREE.Vector4(1, 1, 1, 1)), 'vec4'),
  glowIntensity: uniform(2.2),
  glowRune: uniform(new THREE.Color('#55ff9e')),       // the look's glow.rune / glow.crystal (world floors draw runes in them)
  glowCrystal: uniform(new THREE.Color('#9b72ff')),
  windDir: uniform(new THREE.Vector2(Math.sin(Math.PI * 0.6), Math.cos(Math.PI * 0.6))),
  windStrength: uniform(0.35),
  windFrequency: uniform(0.5),
  windTime: uniform(0),
  time: uniform(0),
  flash: uniform(0),                  // lightning: a short white lift of the whole scene
  perlin: texture(grey),              // folio's perlin noise (r), set by the look once rendered
  voronoi: texture(grey),
};

/** folio's screen-space fog colour (Fog.js): colorA in the middle, colorB at the edges. It is also the sky. */
export const fogColorNode = Fn(() => {
  const p = vec2(viewportUV.xy).sub(U.fogCenter).mul(vec2(screenSize.x.div(screenSize.y), 1));
  return mix(U.fogA, U.fogB, p.length().smoothstep(U.fogRadialStart, U.fogRadialEnd));
})();
export const fogStrengthNode = rangeFogFactor(U.fogNear, U.fogFar);

/** folio's Wind.offsetNode: a 2D push from two scrolling perlin samples. */
export const windOffset = Fn(([position]) => {
  const p = position.mul(U.windFrequency);
  const n1 = U.perlin.sample(p.xy.mul(0.2).add(U.windDir.mul(U.windTime))).r.sub(0.5);
  const n2 = U.perlin.sample(p.xy.mul(0.1).add(U.windDir.mul(U.windTime.mul(0.2)))).r.sub(0.5);
  return vec2(U.windDir.mul(n1.add(n2)).mul(U.windStrength));
});

const FLAGS = { coreShadows: true, dropShadows: true, bounce: true, fog: true, voidFade: true, lamps: true, rim: false, emissive: true };
export const KINDS = {
  character: { rim: true },
  prop: {},
  ground: { bounce: false },
  decal: { bounce: false, coreShadows: false },
  water: { bounce: false, coreShadows: false },
  liquid: { bounce: false },
  foliage: {},
  sky: { coreShadows: false, dropShadows: false, bounce: false, lamps: false },
};
const flagsOf = (kind, extra = {}) => ({ ...FLAGS, ...(KINDS[kind] ?? {}), ...extra });

/**
 * folio's MeshDefaultMaterial output: lit colour = base x light; core shade (normal away from the sun) and drop shadows
 * (caught from the shadow map) mix toward base x shadow colour; ground bounce; lamp pools; fog; void fade; emissive.
 * Optional nodes: colorNode (vec3, instead of diffuseColor), normalNode, alphaNode, shadowNode (extra shade 0..1).
 * → { outputNode, receivedShadowNode }
 */
export function houseNodes(flags = FLAGS, { colorNode = null, normalNode = null, alphaNode = null, shadowNode = null, emissiveNode = null, alphaTest = 0.1, doubleSided = false } = {}) {
  const caught = float(1).toVar();
  const receivedShadowNode = flags.dropShadows ? Fn(([shadow]) => { caught.mulAssign(shadow.r); return float(1); }) : null;
  const outputNode = Fn(() => {
    const base = (colorNode ? vec3(colorNode) : diffuseColor.rgb).toVar();
    const out = vec3(base).toVar();
    const n = vec3(normalNode ?? normalWorld).toVar();
    if (doubleSided) If(frontFacing.not(), () => { n.mulAssign(-1); });
    // light bounce from the ground (folio: surfaces facing down, close to the ground, take its colour)
    if (flags.bounce) {
      const facingDown = n.dot(vec3(0, -1, 0)).smoothstep(U.bounceLow, U.bounceHigh);
      const near = U.bounceDistance.sub(max(0, positionWorld.y)).div(U.bounceDistance).max(0).pow(2);
      out.assign(mix(out, U.bounceColor, facingDown.mul(near).mul(U.bounceStrength)));
    }
    // light
    out.mulAssign(U.lightColor.mul(U.lightIntensity).add(U.flash));
    // shade: core (turned away from the sun), drop (the shadow map) and the caller's own
    let shade = float(0);
    if (flags.coreShadows) shade = n.dot(U.lightDir).smoothstep(U.coreHigh, U.coreLow);
    if (flags.dropShadows) shade = max(shade, caught.oneMinus());
    if (shadowNode) shade = max(shade, shadowNode);
    if (flags.coreShadows || flags.dropShadows || shadowNode) {
      if (flags.rim) {
        // characters: a lighter, softer shade, so a body reads as its own colours in any light
        out.mulAssign(U.charBright);
        const shadeColor = base.mul(mix(U.shadowColor, vec3(1), U.charLift));
        out.assign(mix(out, shadeColor, shade.clamp(0, 1).mul(U.shadowStrength).mul(U.charShade)));
      } else {
        const shadeColor = base.mul(U.shadowColor);
        out.assign(mix(out, shadeColor, shade.clamp(0, 1).mul(U.shadowStrength)));
      }
    }
    // warm pools of light round lanterns and braziers (the world's light points)
    if (flags.lamps) {
      const pool = vec3(0).toVar();
      Loop({ start: int(0), end: int(LAMP_SLOTS), type: 'int', condition: '<' }, ({ i }) => {
        const l = U.lamps.element(i), tint = U.lampTints.element(i);
        const d = positionWorld.sub(l.xyz).length();
        const f = float(1).sub(d.div(U.lampRadius.mul(l.w))).clamp(0, 1).pow(2);
        pool.addAssign(tint.rgb.mul(f.mul(tint.w)));
      });
      out.addAssign(base.mul(U.lampColor).add(U.lampColor.mul(0.06)).mul(pool).mul(U.lampIntensity));
    }
    // a soft rim so characters read against dark ground
    if (flags.rim) {
      const view = cameraPosition.sub(positionWorld).normalize();
      const rim = float(1).sub(max(0, n.dot(view))).pow(3);
      out.addAssign(U.rimColor.mul(rim.mul(U.rimStrength)));
    }
    // fog toward the sky colour, and the void below the islands
    if (flags.fog) out.assign(mix(out, fogColorNode, fogStrengthNode));
    if (flags.voidFade) out.assign(mix(out, U.fogB, positionWorld.y.smoothstep(U.voidTop, U.voidBottom)));
    // emissive (bloom picks up anything over the threshold)
    if (flags.emissive) out.addAssign(materialEmissive);
    if (emissiveNode) out.addAssign(emissiveNode);
    const a = alphaNode ? float(alphaNode) : diffuseColor.a;
    if (alphaNode) a.lessThan(alphaTest).discard();
    return vec4(out, a);
  })();
  return { outputNode, receivedShadowNode };
}

// one node pair per kind: every material of that kind shares it (each material still compiles its own shader)
const cache = new Map();
function nodesFor(kind) {
  if (!cache.has(kind)) cache.set(kind, houseNodes(flagsOf(kind)));
  return cache.get(kind);
}

const patched = new WeakMap();   // material → kind
/** Make a lit material a house material, in place. Its own colour, map, emissive and opacity keep working. */
export function patchMaterial(m, kind = 'prop') {
  if (!m || patched.get(m) === kind) return m;
  const nodes = nodesFor(kind);
  m.outputNode = nodes.outputNode;
  m.receivedShadowNode = nodes.receivedShadowNode;
  m.userData.gfHouse = kind;
  m.needsUpdate = true;
  patched.set(m, kind);
  return m;
}
export const isHouse = m => patched.has(m);

/** A material we never restyle: unlit (rings, sprites, lines, points), our own glow, or one that opts out. */
const LIT = /^Mesh(Standard|Physical|Lambert|Phong|Toon)(Node)?Material$/;
const skip = m => !m || !LIT.test(m.type) || m.userData?.gfNoHouse || m.userData?.gfGlow;

/** folio's MeshDefaultMaterial: MeshLambertNodeMaterial with the house output. */
export class HouseMaterial extends THREE.MeshLambertNodeMaterial {
  constructor(params = {}, kind = 'prop') {
    super();
    const { colorNode, normalNode, alphaNode, shadowNode, emissiveNode, flags, ...rest } = params;
    this.setValues(rest);
    this.isHouseMaterial = true;
    if (colorNode || normalNode || alphaNode || shadowNode || emissiveNode || flags) {
      const nodes = houseNodes(flagsOf(kind, flags ?? {}), { colorNode, normalNode, alphaNode, shadowNode, emissiveNode, alphaTest: rest.alphaTest ?? 0.1, doubleSided: rest.side === THREE.DoubleSide });
      if (normalNode) this.normalNode = normalNode;
      this.outputNode = nodes.outputNode;
      this.receivedShadowNode = nodes.receivedShadowNode;
      this.userData.gfHouse = kind;
      patched.set(this, kind);
    } else patchMaterial(this, kind);
  }
}

// ---- glow: folio's createEmissive / createEmissiveGradient (MeshBasicNodeMaterial, no fog), normalised to the glow
// strength so bloom picks it up; .color keeps meaning the colour ----
export function glowMaterial({ color = '#ffb15c', intensity = null, gradient = null, transparent = false, opacity = 1 } = {}) {
  const m = new THREE.MeshBasicNodeMaterial({ color, transparent, opacity });
  const k = intensity === null ? U.glowIntensity : uniform(intensity);
  let c = materialColor.rgb;
  if (gradient) c = mix(c, vec3(gradient.inner ?? '#ffffff'), float(1).sub(gradient.uv.sub(0.5).length().mul(2)).clamp(0, 1).mul(gradient.amount ?? 0.5));
  m.colorNode = vec4(c.div(luminance(c).max(0.05)).mul(k), 1);
  m.fog = false;
  m.userData.gfGlow = true;
  m.userData.gfHouse = 'glow';
  return m;
}

// folio's GLB material names that mean "glow": emissiveOrangeRadialGradient and its siblings
const GLOW_NAMES = /^emissive/i;
const glowByName = new Map();
const glowColorOf = name => (/purple|violet/i.test(name) ? 'crystal' : /green/i.test(name) ? 'rune' : /blue|white/i.test(name) ? 'crystal' : 'lantern');
/** The glow material a folio GLB name stands for (shared; its colour follows the look's glow slots). */
export function glowFor(name) {
  if (!glowByName.has(name)) { const m = glowMaterial({ color: '#ffffff' }); m.name = name; m.userData.glowRole = glowColorOf(name); glowByName.set(name, m); }
  return glowByName.get(name);
}
/** Recolour the shared glow materials (the look calls it when its values change). */
export function setGlowColors(glow = {}) {
  for (const m of glowByName.values()) m.color.set(glow[m.userData.glowRole] ?? '#ffffff');
}

/**
 * Every lit material under `object` becomes a house material of `kind`, in place; folio's emissive* materials become
 * the shared glow. opts.tint: a colour multiplied in (prop tints), opts.shadows: set cast/receive on the meshes.
 */
export function adoptMaterials(object, kind = 'prop', opts = {}) {
  object?.traverse?.(o => {
    if (!(o.isMesh || o.isSkinnedMesh || o.isInstancedMesh)) return;
    const one = m => {
      if (!m) return m;
      if (GLOW_NAMES.test(m.name ?? '') && !m.userData?.gfGlow) return glowFor(m.name);
      if (skip(m)) return m;
      if (opts.tint != null && m.color) m.color.multiply(new THREE.Color(opts.tint));
      return patchMaterial(m, kind);
    };
    o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
    if (opts.shadows !== false) { o.castShadow = o.castShadow || !o.material?.userData?.gfGlow; o.receiveShadow = true; }
  });
  return object;
}

/** Adopt anything in the scene that is not a house material yet: skinned bodies as characters, the rest as props. */
export function adoptScene(scene) {
  scene.traverse(o => {
    if (!o.isMesh || o.userData.gfNoHouse) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (!skip(m) && !patched.has(m)) patchMaterial(m, o.isSkinnedMesh ? 'character' : 'prop');
  });
}

/** House materials by kind (CONTRACT §4.2): tint (or color) is the base colour; glow is unlit and blooms. */
export function material(kind = 'prop', opts = {}) {
  const { tint, color, ...rest } = opts;
  const c = tint ?? color ?? '#ffffff';
  if (kind === 'glow') return glowMaterial({ color: c, intensity: rest.intensity ?? null, transparent: !!rest.transparent, opacity: rest.opacity ?? 1 });
  const k = KINDS[kind] ? kind : 'prop';
  const m = new HouseMaterial({ color: c, ...rest }, k);
  if (kind === 'liquid' && m.emissive) m.emissive.set(c).multiplyScalar(0.15);
  return m;
}

/** Tint a house material (or every material under an object) toward a colour. */
export function setTint(target, c) {
  const col = new THREE.Color(c);
  const one = m => { if (m?.color) m.color.copy(col); };
  if (target?.isMaterial) one(target);
  else target?.traverse?.(o => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(one); });
}
