// src/car.js: every player is a car. Two parts:
//
//   The body (every copy, every player): the prop.car slot's model on the player's character, tinted in that player's
//   own colour (their loadout's, else their seat's), with the driver sitting still in it (no running legs). It rides on
//   the character, so it goes wherever the player's pose puts it on every screen.
//
//   The driving (the copy that owns the player: you on yours, the bots on the host): the kit steps each owned body at
//   60 Hz through controller.fixedStep; for a car that step is drive() below. Steer (A/D, ←/→, the stick sideways)
//   turns the car, accelerate (W, ↑, stick up) speeds it up, brake (S, ↓, stick down) slows it and then reverses. Speed,
//   grip and turn rate are rules.params (maxSpeed, accel, brake, turnRate, grip, reverse, coast). The capsule underneath
//   is the kit's, so cars bump into each other and the world, and its pose is sent like any player's.
//
//   const cars = createCars(ctx, track);
//   cars.update(ctx, dt)   every frame (rules.update): fit bodies, take over owned players' steps, line cars up before Go,
//                          turn your own camera round behind your car (the chase view, rules.params.chaseTurn), and
//                          your dashboard: a speed meter that says Braking / Reverse, and the driving keys on the help line
//   cars.botDrive(p)       host, rules.bot: follow the road to the next gates
//   cars.speedOf(p)        the car's speed (m/s) on the copy that owns it

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

export function createCars(ctx, track) {
  const cars = new WeakMap();
  const P = () => ctx.config?.rules?.params ?? {};
  const num = (k, d) => (Number.isFinite(P()[k]) ? P()[k] : d);
  const stateOf = p => { let c = cars.get(p); if (!c) cars.set(p, c = { h: p.yaw ?? 0, v: 0, bot: null, step: null, body: null, on: null, loading: null, stuck: 0, backUp: 0 }); return c; };

  /** This frame's controls for a player: the local input, or what the bot driver chose. */
  function controlsOf(p, c) {
    if (p.local) {
      const m = ctx.input?.move ?? { x: 0, y: 0 };
      return { steer: clamp(m.x, -1, 1), gas: m.y > 0.15 ? m.y : 0, brake: m.y < -0.15 ? -m.y : 0 };
    }
    return c.bot ?? { steer: 0, gas: 0, brake: 0 };
  }

  /** One 60 Hz physics step of an owned car (in place of the kit's walking step). */
  function drive(p) {
    const ctl = p.controller, cap = ctl?.capsule; if (!cap) return;
    const c = stateOf(p), dt = ctx.physics?.timestep ?? 1 / 60;
    const held = cap.state.stun > 0 || (p.character?.state && p.character.state !== 'anim');
    const on = ctl.enabled && p.alive !== false && !held;
    const k = on ? controlsOf(p, c) : { steer: 0, gas: 0, brake: 0 };
    const top = num('maxSpeed', 12) * (p.isBot ? num('botPace', 0.86) : 1);
    if (k.gas > 0) c.v += num('accel', 10) * k.gas * dt * (c.v < 0 ? 2 : 1);
    else if (k.brake > 0) c.v -= (c.v > 0 ? num('brake', 20) : num('accel', 10) * 0.6) * k.brake * dt;
    else c.v -= Math.sign(c.v) * Math.min(Math.abs(c.v), num('coast', 3) * dt);
    c.v = clamp(c.v, -top * num('reverse', 0.4), top);
    // steering bites with speed, and turns the other way in reverse, as a car does (right turns lower the yaw)
    c.h = wrapAngle(c.h - k.steer * num('turnRate', 2.4) * clamp(Math.abs(c.v) / 3, 0.25, 1) * Math.sign(c.v || 1) * dt);
    // what the body really does: a wall or another car slows the car down
    const vel = cap.body.linvel(), fx = Math.sin(c.h), fz = Math.cos(c.h), along = vel.x * fx + vel.z * fz;
    if (c.v > 0 && c.v > along + 2) c.v = Math.max(0, along + 2);
    if (c.v < 0 && c.v < along - 2) c.v = Math.min(0, along - 2);
    // the capsule keeps the car on the ground; the car sets its own flat velocity and points where it drives
    cap.step({ x: 0, z: 0, enabled: on, jumpPresses: 0 });
    cap.state.facing = c.h;
    // grip: the car goes where it points, less a little slide of the way it was already going
    // (from the velocity before the capsule's own step: its standing friction is for feet, not wheels)
    const bite = Math.min(1, clamp(num('grip', 0.85), 0.2, 1) * dt * 14), vy = cap.body.linvel().y;
    cap.body.setLinvel({ x: vel.x + (fx * c.v - vel.x) * bite, y: vy, z: vel.z + (fz * c.v - vel.z) * bite }, true);
    track.contain(cap.body, c, dt);
    c.braking = k.brake > 0 && c.v > 0.3; c.reversing = c.v < -0.3;
  }

  /** The car body on a player's character (every copy), tinted in their own colour. */
  async function fitBody(p, c, holder) {
    c.loading = holder;
    try {
      const m = await ctx.assets.model('prop.car', { player: p });
      if (p.character?.object3d !== holder) return;
      const size = new ctx.THREE.Box3().setFromObject(m).getSize(new ctx.THREE.Vector3());
      const s = num('carLength', 2.4) / Math.max(0.01, Math.max(size.x, size.z)) / (holder.scale.x || 1);
      m.scale.multiplyScalar(s);
      m.rotation.y = num('carYaw', 0);
      // centred on the body underneath, so the car you see is where it drives (and where the edges hold it)
      m.updateMatrixWorld(true);
      const mid = new ctx.THREE.Box3().setFromObject(m).getCenter(new ctx.THREE.Vector3());
      m.position.x -= mid.x; m.position.z -= mid.z;
      const tint = new ctx.THREE.Color(ctx.assets.value('character.tint.player', p.color, { player: p }) ?? p.color ?? '#ffffff');
      m.traverse(o => { if (o.isMesh && o.material) { o.material = o.material.clone(); o.material.color?.lerp(tint, clamp(num('carTint', 0.6), 0, 1)); } });
      m.name = 'island-circuit-car';
      if (c.body) c.body.removeFromParent();
      holder.add(m); c.body = m; c.on = holder;
    } catch (e) { console.warn('Island Circuit: the car body did not load', e); }
    finally { if (c.loading === holder) c.loading = null; }
  }

  /** The driver sits: the character's legs stay still whatever the body's speed. */
  function seat(ch) {
    if (!ch || ch.__seated || typeof ch.locomotion !== 'function') return;
    const walk = ch.locomotion.bind(ch);
    ch.locomotion = (speed, grounded) => walk(0, grounded);
    ch.__seated = true;
  }

  /** Your dashboard: the HUD's speed meter (with Braking / Reverse in its label) and the driving keys on the help line. */
  let meter = null, lastLabel = '';
  function dash(me) {
    const ui = ctx.ui; if (!ui || !me) return;
    const help = ui.root?.querySelector?.('.gf-help'), keys = 'W / ↑ accelerate · A D / ← → steer · S / ↓ brake & reverse · Esc: menu';
    if (help && help.textContent !== keys) help.textContent = keys;
    const c = stateOf(me), kmh = Math.round(Math.abs(c.v) * 3.6);
    const label = c.reversing ? `Reverse ${kmh} km/h` : c.braking ? `Braking ${kmh} km/h` : `Speed ${kmh} km/h`;
    if (label !== lastLabel) { meter = ui.meter('island-circuit-speed', { label, max: num('maxSpeed', 12), color: c.reversing ? '#ff7a59' : c.braking ? '#ffd23f' : '#4be0a8' }); lastLabel = label; }
    meter.set(Math.abs(c.v), num('maxSpeed', 12));
  }

  return {
    stateOf,
    speedOf: p => stateOf(p).v,
    update(_ctx, dt = 1 / 60) {
      const playing = ctx.round?.phase === 'playing';
      // the chase view: your own camera swings round behind your car's nose (the follow rig, its yaw turned each frame)
      const me = ctx.me, rig = me?.controller?.rig;
      if (me && rig) { const c = stateOf(me); rig.yaw = wrapAngle(rig.yaw + wrapAngle(c.h - rig.yaw) * (1 - Math.exp(-dt * num('chaseTurn', 5)))); }
      dash(me);
      for (const p of ctx.players.list()) {
        const c = stateOf(p), holder = p.character?.object3d;
        if (holder && c.on !== holder && c.loading !== holder) fitBody(p, c, holder);
        seat(p.character);
        if (!p.owned || !p.controller) continue;
        // the copy that owns this player drives it as a car from now on
        if (p.controller.fixedStep !== c.step) { c.step = () => drive(p); p.controller.fixedStep = c.step; }
        // the driver sits: the word the net carries is never a walk or a run (a knock's words stand)
        if (p.anim === 'walk' || p.anim === 'run') p.anim = p.controller.anim = 'idle';
        // before Go (and between rounds) every car stands still, pointing down the road
        if (!playing) { c.v = 0; c.h = track.nearest(p.position.x, p.position.z).yaw; }
      }
    },
    /** Host, from rules.bot: aim a little ahead along the road in the bot's own lane; brake for sharp turns; back out when stuck. */
    botDrive(p, dt) {
      const c = stateOf(p), n = track.nearest(p.position.x, p.position.z);
      const lane = (((p.seat ?? 0) % 3) - 1) * track.shape.width * 0.18;
      const t = track.at(n.s + num('botLook', 6) + Math.abs(c.v) * 0.3), tx = t.x + t.nx * lane, tz = t.z + t.nz * lane;
      const d = wrapAngle(Math.atan2(tx - p.position.x, tz - p.position.z) - c.h);
      if (c.backUp > 0) { c.backUp -= dt; c.bot = { steer: clamp(d * 2, -1, 1), gas: 0, brake: 1 }; }
      else {
        c.stuck = Math.abs(c.v) < 0.6 ? c.stuck + dt : 0;
        if (c.stuck > 1.5) { c.stuck = 0; c.backUp = 0.9; }
        const sharp = Math.abs(d) > 0.75 && c.v > 6;
        c.bot = { steer: clamp(-d * 2.5, -1, 1), gas: sharp ? 0 : 1, brake: sharp ? 0.6 : 0 };
      }
      p.bot?.stop?.();
    },
  };
}
