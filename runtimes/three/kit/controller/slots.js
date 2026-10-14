// gf-three controller: slot declarations for movement and the camera. Pure (Node imports it).
const G = 'config/game.json';
export function slotsFor(cfg) {
  const c = cfg.game?.controller ?? {}, out = [];
  const num = (id, label, pointer, v, tier, rank, constraints) => { if (typeof v === 'number') out.push({ id, group: 'controls', label, type: 'number', source: { file: G, pointer }, constraints, tier, facet: 'gameplay', rank }); };
  num('controller.speed', 'Running speed', '/controller/speed', c.speed, 'main', 58, { min: 1, max: 14, unit: 'm/s' });
  num('controller.jump', 'Jump strength', '/controller/jump', c.jump, 'main', 56, { min: 0, max: 16, unit: 'm/s' });
  num('controller.sprint', 'Sprint speed (Shift)', '/controller/sprint', c.sprint, 'advanced', 20, { min: 1, max: 18, unit: 'm/s' });
  const mode = cfg.game?.camera ?? 'third', cam = c.camera?.[mode] ?? {};
  const follow = mode === 'follow';   // CONTRACT §8: a long lens far away (fov 25, 15-30 m)
  num(`controller.camera.distance`, 'Camera distance', `/controller/camera/${mode}/distance`, cam.distance, follow ? 'main' : 'advanced', 22, { min: 1, max: follow ? 60 : 30, unit: 'm' });
  num(`controller.camera.fov`, 'Camera field of view', `/controller/camera/${mode}/fov`, cam.fov, 'advanced', 18, { min: follow ? 10 : 30, max: 100, unit: '°' });
  if (follow) {
    num('controller.camera.pitch', 'Camera angle above the ground', `/controller/camera/${mode}/pitchDeg`, cam.pitchDeg, 'advanced', 17, { min: 15, max: 89, unit: '°' });
    num('controller.camera.yaw', 'Camera turn', `/controller/camera/${mode}/yawDeg`, cam.yawDeg, 'advanced', 16, { min: -180, max: 180, unit: '°' });
  }
  num(`controller.camera.sensitivity`, 'Mouse look sensitivity', `/controller/camera/${mode}/sensitivity`, cam.sensitivity, 'advanced', 14, { min: 0, max: 0.01 });
  return out;
}
