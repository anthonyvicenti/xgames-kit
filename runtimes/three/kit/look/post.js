// Post stack for gf-three looks (pmndrs postprocessing 6.39.5 + N8AO):
//   RenderPass -> N8AO (high tier) -> [ink outline + bloom + tone mapping (AgX/ACES) + grade + vignette] -> SMAA / FXAA
// The outline is screen-space: silhouettes and creases found from the depth buffer (no extra scene pass), darkened
// with a tinted ink colour and faded with distance. The grade is lift/gamma/gain, contrast, saturation, vibrance,
// temperature and a vignette, all from look.post.grade.
import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, SMAAPreset, FXAAEffect, ToneMappingEffect, ToneMappingMode, Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

const OUTLINE_FRAG = /* glsl */`
uniform float uStrength; uniform float uThickness; uniform vec3 uColor; uniform float uDarken;
uniform float uDepthThreshold; uniform float uCrease; uniform float uCreaseThreshold; uniform float uFadeNear; uniform float uFadeFar;
float gfW( vec2 uv ) { float d = readDepth( uv ); return d >= 1.0 ? 0.0 : -1.0 / getViewZ( d ); }   // 1/distance: linear on planes
void mainImage( const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor ) {
  vec2 o = texelSize * uThickness;
  float wc = gfW( uv );
  float wl = gfW( uv - vec2( o.x, 0.0 ) ), wr = gfW( uv + vec2( o.x, 0.0 ) );
  float wd = gfW( uv - vec2( 0.0, o.y ) ), wu = gfW( uv + vec2( 0.0, o.y ) );
  float wn = max( max( wl, wr ), max( wd, wu ) );
  float near = max( wc, wn );                                     // the nearer side owns the line
  float dist = near > 0.0 ? 1.0 / near : 1e6;
  // silhouette: a jump in distance, relative to how far away it is
  float jump = max( max( abs( wl - wc ), abs( wr - wc ) ), max( abs( wd - wc ), abs( wu - wc ) ) ) / max( near, 1e-6 );
  float edge = smoothstep( uDepthThreshold, uDepthThreshold * 2.0, jump );
  // crease: a kink in 1/distance (second difference); zero on flat faces, so only corners light up
  if ( uCrease > 0.5 && wc > 0.0 ) {
    float lap = abs( wl + wr - 2.0 * wc ) + abs( wd + wu - 2.0 * wc );
    edge = max( edge, smoothstep( uCreaseThreshold, uCreaseThreshold * 2.5, lap / wc ) * 0.8 );
  }
  edge *= 1.0 - smoothstep( uFadeNear, uFadeFar, dist );
  if ( wc == 0.0 && wn == 0.0 ) edge = 0.0;                    // sky
  vec3 inked = mix( inputColor.rgb * uDarken, uColor, 0.5 );
  outputColor = vec4( mix( inputColor.rgb, inked, saturate( edge * uStrength ) ), inputColor.a );
}`;

export class InkOutlineEffect extends Effect {
  constructor(o = {}) {
    super('InkOutlineEffect', OUTLINE_FRAG, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ['uStrength', new THREE.Uniform(o.strength ?? 0.6)], ['uThickness', new THREE.Uniform(o.thickness ?? 1)],
        ['uColor', new THREE.Uniform(new THREE.Color(o.color ?? '#202030'))], ['uDarken', new THREE.Uniform(o.darken ?? 0.35)],
        ['uDepthThreshold', new THREE.Uniform(o.depthThreshold ?? 0.06)], ['uCrease', new THREE.Uniform(o.crease ? 1 : 0)],
        ['uCreaseThreshold', new THREE.Uniform(o.creaseThreshold ?? 0.02)],
        ['uFadeNear', new THREE.Uniform(o.fadeNear ?? 20)], ['uFadeFar', new THREE.Uniform(o.fadeFar ?? 80)],
      ]),
    });
  }
}

const GRADE_FRAG = /* glsl */`
uniform float uContrast; uniform float uSaturation; uniform float uVibrance; uniform float uTemperature;
uniform vec3 uLift; uniform vec3 uGamma; uniform vec3 uGain; uniform float uVignette; uniform vec3 uVignetteColor; uniform float uFade; uniform vec3 uFadeColor;
void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
  vec3 c = max( inputColor.rgb, 0.0 );
  c *= vec3( 1.0 + uTemperature * 0.10, 1.0, 1.0 - uTemperature * 0.10 );
  c = uGain * ( c + uLift * ( 1.0 - c ) );
  c = pow( max( c, 0.0 ), 1.0 / max( uGamma, vec3( 0.01 ) ) );
  c = ( c - 0.18 ) * uContrast + 0.18;
  float l = dot( max( c, 0.0 ), vec3( 0.2126, 0.7152, 0.0722 ) );
  float sat = max( max( c.r, c.g ), c.b ) - min( min( c.r, c.g ), c.b );
  c = mix( vec3( l ), c, uSaturation * ( 1.0 + uVibrance * ( 1.0 - sat ) ) );
  float v = smoothstep( 0.45, 1.15, length( ( uv - 0.5 ) * vec2( 1.2, 1.0 ) ) * 1.4 );
  c = mix( c, c * uVignetteColor, v * uVignette );
  c = mix( c, uFadeColor, uFade );
  outputColor = vec4( max( c, 0.0 ), inputColor.a );
}`;

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', GRADE_FRAG, {
      uniforms: new Map([
        ['uContrast', new THREE.Uniform(1)], ['uSaturation', new THREE.Uniform(1)], ['uVibrance', new THREE.Uniform(0)], ['uTemperature', new THREE.Uniform(0)],
        ['uLift', new THREE.Uniform(new THREE.Color(0, 0, 0))], ['uGamma', new THREE.Uniform(new THREE.Color(1, 1, 1))], ['uGain', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['uVignette', new THREE.Uniform(0.2)], ['uVignetteColor', new THREE.Uniform(new THREE.Color(0, 0, 0))],
        ['uFade', new THREE.Uniform(0)], ['uFadeColor', new THREE.Uniform(new THREE.Color(0, 0, 0))],
      ]),
    });
  }
}

const TONE = { AgX: ToneMappingMode.AGX, ACES: ToneMappingMode.ACES_FILMIC, Neutral: ToneMappingMode.NEUTRAL };

/** Build the composer for a resolved look (preset with time applied) and a quality tier block. */
export function createPost(renderer, scene, camera, look, tier) {
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  let ao = null;
  if (tier.ao) {
    ao = new N8AOPostPass(scene, camera, size.x, size.y);
    ao.configuration.gammaCorrection = false;
    ao.configuration.transparencyAware = false;
    ao.configuration.halfRes = !!tier.aoHalfRes;
    ao.configuration.screenSpaceRadius = false;
    ao.setQualityMode(tier.aoQuality ?? 'Medium');
    composer.addPass(ao);
  }
  const outline = new InkOutlineEffect({ crease: tier.outlineCrease });
  const bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1, luminanceSmoothing: 0.2, intensity: 0.5, radius: 0.7, levels: tier.bloomLevels ?? 8 });
  const tone = new ToneMappingEffect({ mode: TONE[look.renderer?.toneMapping] ?? ToneMappingMode.AGX });
  const grade = new GradeEffect();
  const effects = [];
  if (tier.outline !== false) effects.push(outline);
  if (tier.bloom !== false) effects.push(bloom);
  effects.push(tone, grade);
  const main = new EffectPass(camera, ...effects);
  composer.addPass(main);
  let aa = null;
  if (tier.smaa) aa = new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH }));
  else if (tier.fxaa) aa = new EffectPass(camera, new FXAAEffect());
  if (aa) composer.addPass(aa);

  function configure(look) {
    const p = look.post ?? {};
    renderer.toneMappingExposure = look.renderer?.exposure ?? 1;
    tone.mode = TONE[look.renderer?.toneMapping] ?? ToneMappingMode.AGX;
    if (ao && p.ao) {
      ao.configuration.aoRadius = p.ao.radius ?? 1.5; ao.configuration.distanceFalloff = p.ao.falloff ?? 1;
      ao.configuration.intensity = p.ao.intensity ?? 2; ao.configuration.color = new THREE.Color(p.ao.color ?? '#000000');
      ao.configuration.aoSamples = tier.aoSamples ?? ao.configuration.aoSamples;
    }
    const o = p.outline ?? {}, u = outline.uniforms;
    u.get('uStrength').value = o.strength ?? 0; u.get('uThickness').value = (o.thickness ?? 1) * (tier.outlineScale ?? 1);
    u.get('uColor').value.set(o.color ?? '#202030'); u.get('uDarken').value = o.darken ?? 0.35;
    u.get('uDepthThreshold').value = o.depthThreshold ?? 0.06; u.get('uCreaseThreshold').value = o.creaseThreshold ?? 0.02;
    u.get('uFadeNear').value = o.fadeNear ?? 20; u.get('uFadeFar').value = o.fadeFar ?? 80;
    const b = p.bloom ?? {};
    bloom.intensity = b.intensity ?? 0.5; bloom.luminanceMaterial.threshold = b.threshold ?? 1; bloom.luminanceMaterial.smoothing = b.smoothing ?? 0.2;
    if (bloom.mipmapBlurPass) bloom.mipmapBlurPass.radius = b.radius ?? 0.7;
    const g = p.grade ?? {}, gu = grade.uniforms;
    gu.get('uContrast').value = g.contrast ?? 1; gu.get('uSaturation').value = g.saturation ?? 1; gu.get('uVibrance').value = g.vibrance ?? 0;
    gu.get('uTemperature').value = g.temperature ?? 0;
    gu.get('uLift').value.set(g.lift ?? '#000000'); gu.get('uGamma').value.set(g.gamma ?? '#ffffff'); gu.get('uGain').value.set(g.gain ?? '#ffffff');
    gu.get('uVignette').value = g.vignette ?? 0.2; gu.get('uVignetteColor').value.set(g.vignetteColor ?? '#000000');
  }
  configure(look);

  function setCamera(cam) {
    renderPass.mainCamera = cam; main.mainCamera = cam; if (aa) aa.mainCamera = cam;
    if (ao) ao.camera = cam;
  }
  return {
    composer, ao, bloom, outline, grade, tone, configure, setCamera,
    // w, h: CSS pixels. composer.setSize sizes every pass, N8AO included, at the drawing buffer (w, h times the
    // renderer's pixel ratio); sizing N8AO again at w, h drew its scene at the wrong size whenever the ratio is not 1
    // (a shrunken second copy of the frame in the lower left at a ratio under 1: the lofi pass, the resolution governor)
    setSize(w, h) { composer.setSize(w, h); },
    render(dt) { composer.render(dt); },
    fade(amount, color = '#000000') { grade.uniforms.get('uFade').value = amount; grade.uniforms.get('uFadeColor').value.set(color); },
    dispose() { composer.dispose(); },
  };
}
