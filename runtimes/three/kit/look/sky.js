// Sky dome and image-based lighting for gf-three looks.
// The dome is a kit primitive (an inverted sphere) whose colours are look slots (look.sky.*); it carries
// userData.gfSlot = 'look.sky.top'. The environment map is baked at runtime from the same dome plus a ground disc in the
// look's ground-bounce colour, so reflections and soft ambient always match the visible sky.
import * as THREE from 'three';

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize( ( modelMatrix * vec4( position, 0.0 ) ).xyz );
  vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position = p.xyww;   // on the far plane
}`;
const FRAG = /* glsl */`
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uBottom; uniform vec3 uGlow; uniform vec3 uSunDir;
uniform float uGlowSize; uniform float uGlowStrength; uniform float uDisc; uniform float uHorizonSharp; uniform float uBrightness;
varying vec3 vDir;
void main() {
  vec3 d = normalize( vDir );
  float y = d.y;
  float up = pow( clamp( y, 0.0, 1.0 ), uHorizonSharp );
  float down = pow( clamp( - y * 2.5, 0.0, 1.0 ), 0.6 );
  vec3 c = mix( uHorizon, uTop, up );
  c = mix( c, uBottom, down );
  float s = max( dot( d, uSunDir ), 0.0 );
  c += uGlow * ( pow( s, 1.0 / max( uGlowSize, 1e-3 ) ) * uGlowStrength + smoothstep( 0.9996, 0.99975, s ) * uDisc );
  gl_FragColor = vec4( c * uBrightness, 1.0 );
}`;

export function createSky() {
  const uniforms = {
    uTop: { value: new THREE.Color('#7fc4ff') }, uHorizon: { value: new THREE.Color('#ffe2f0') }, uBottom: { value: new THREE.Color('#fbe9e2') },
    uGlow: { value: new THREE.Color('#fff2d6') }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uGlowSize: { value: 0.1 }, uGlowStrength: { value: 0.6 }, uDisc: { value: 4 }, uHorizonSharp: { value: 0.6 }, uBrightness: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false, fog: false });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  dome.name = 'gf-sky';
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.userData.gfSlot = 'look.sky.top';   // a kit primitive whose colours are the look.sky.* value slots
  dome.onBeforeRender = (renderer, scene, camera) => { dome.position.copy(camera.position); dome.scale.setScalar(camera.far * 0.9); dome.updateMatrixWorld(); };

  // environment scene: the same sky + a ground disc for bounce light
  const envScene = new THREE.Scene();
  const envDome = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({ uniforms, vertexShader: VERT.replace('p.xyww', 'p'), fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false }));
  envScene.add(envDome);
  const groundMat = new THREE.MeshBasicMaterial({ color: '#f3d9c8' });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(9, 32), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.5;
  envScene.add(ground);
  let pmrem = null, envRT = null;

  function set(sky, sunDir, groundColor, envGroundStrength = 1) {
    uniforms.uTop.value.set(sky.top); uniforms.uHorizon.value.set(sky.horizon); uniforms.uBottom.value.set(sky.bottom ?? sky.horizon);
    uniforms.uGlow.value.set(sky.glow ?? '#ffffff');
    uniforms.uGlowSize.value = sky.glowSize ?? 0.1; uniforms.uGlowStrength.value = sky.glowStrength ?? 0.6;
    uniforms.uDisc.value = sky.disc ?? 4; uniforms.uHorizonSharp.value = sky.horizonSharpness ?? 0.6; uniforms.uBrightness.value = sky.brightness ?? 1;
    uniforms.uSunDir.value.copy(sunDir);
    groundMat.color.set(groundColor).multiplyScalar(envGroundStrength);
  }
  function bakeEnvironment(renderer) {
    pmrem ??= new THREE.PMREMGenerator(renderer);
    const disc = uniforms.uDisc.value; uniforms.uDisc.value = 0;   // no sun disc in the IBL: the sun light does that
    const next = pmrem.fromScene(envScene, 0.035, 0.1, 100);
    uniforms.uDisc.value = disc;
    envRT?.dispose(); envRT = next;
    return envRT.texture;
  }
  function dispose() { envRT?.dispose(); pmrem?.dispose(); dome.geometry.dispose(); mat.dispose(); envDome.geometry.dispose(); envDome.material.dispose(); groundMat.dispose(); }
  return { dome, uniforms, set, bakeEnvironment, dispose };
}

export function sunDirection(elevationDeg, azimuthDeg, out = new THREE.Vector3()) {
  const el = THREE.MathUtils.degToRad(elevationDeg), az = THREE.MathUtils.degToRad(azimuthDeg);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
}
