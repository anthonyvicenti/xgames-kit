// gf-scenic post: bloom on every tier, plus folio's cheap depth of field (a hash blur that grows toward the top and
// bottom of the screen, the tilt-shift diorama feel) on the high tier.
//
//   Ported from brunosimon/folio-2025@41046b5 src/Game/Rendering.js (setPostprocessing) and
//   src/Game/Passes/cheapDOF.js (MIT, Copyright (c) 2025 Bruno Simon; licence in research/gf-scenic/kit/LICENSE-folio-2025).
//   gf-scenic: the pipeline is built per camera (a contact-sheet shot renders through its own camera); the depth of
//   field blurs the linear scene colour and the pipeline's own output transform does the colour space once; exposure
//   is a final multiply; every value is a look slot (post.bloom.*, post.dof.*, quality.*.dof, quality.*.bloomMips).
import * as THREE from 'three/webgpu';
import { pass, uniform, uv, mix, convertToTexture, nodeObject, Fn } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { hashBlur } from 'three/addons/tsl/display/hashBlur.js';

class CheapDOFNode extends THREE.TempNode {
  static get type() { return 'CheapDOFNode'; }
  constructor(textureNode) {
    super('vec4');
    this.textureNode = textureNode;
    this.start = uniform(0.2);
    this.end = uniform(0.5);
    this.repeats = uniform(20);
    this.amount = uniform(0.003);
  }
  setup() {
    return Fn(() => {
      const strength = uv().y.sub(0.5).abs().smoothstep(this.start, this.end);
      const blurred = hashBlur(this.textureNode, strength.mul(this.amount), { repeats: this.repeats, premultipliedAlpha: true });
      return mix(this.textureNode, blurred, strength);
    })();
  }
}
const cheapDOF = node => nodeObject(new CheapDOFNode(convertToTexture(node)));

/** → { render(), setCamera(cam), configure(values, tier), dispose() } */
export function createPost(renderer, scene, camera, values, tier) {
  const exposure = uniform(1);
  let pipe = null, bloomPass = null, dofPass = null, cam = camera, dofOn = null, mips = null, dofAllowed = true;
  function build() {
    pipe?.dispose();
    pipe = new THREE.RenderPipeline(renderer);
    const scenePass = pass(scene, cam, tier?.msaa ? { samples: 4 } : {});
    const color = scenePass.getTextureNode('output');
    bloomPass = bloom(color);
    bloomPass._nMips = mips;                      // folio: 5 mips on high, 2 on low
    dofPass = dofOn ? cheapDOF(color) : null;
    pipe.outputNode = (dofPass ?? color).add(bloomPass).mul(exposure);
    configure(values, tier);
  }
  function configure(v, t) {
    values = v; tier = t;
    const b = v.post?.bloom ?? {}, d = v.post?.dof ?? {};
    const wantDof = t?.dof !== false, wantMips = Math.max(1, Math.min(5, Math.round(t?.bloomMips ?? 5)));
    if (pipe && (wantDof !== dofOn || wantMips !== mips)) { dofOn = wantDof; mips = wantMips; return build(); }
    dofOn = wantDof; mips = wantMips;
    exposure.value = v.renderer?.exposure ?? 1;
    if (!bloomPass) return;
    bloomPass.strength.value = b.strength ?? 0.4;
    bloomPass.radius.value = b.radius ?? 0.5;
    bloomPass.threshold.value = b.threshold ?? 0.9;
    bloomPass.smoothWidth.value = b.smoothWidth ?? 0.6;
    if (dofPass) { dofPass.start.value = d.start ?? 0.2; dofPass.end.value = d.end ?? 0.5; dofPass.amount.value = dofAllowed === false ? 0 : (d.amount ?? 0.003); dofPass.repeats.value = Math.round(d.repeats ?? 20); }
  }
  dofOn = tier?.dof !== false; mips = Math.max(1, Math.min(5, Math.round(tier?.bloomMips ?? 5)));
  build();
  return {
    render() { pipe.render(); },
    /** turn the depth of field off (close shots) or back to the look's amount */
    dof(on) { dofAllowed = !!on; if (dofPass) dofPass.amount.value = dofAllowed ? (values.post?.dof?.amount ?? 0.003) : 0; },
    setCamera(c) { if (c && c !== cam) { cam = c; build(); } },
    configure,
    get camera() { return cam; },
    dispose() { pipe?.dispose(); },
  };
}
