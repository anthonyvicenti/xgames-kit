// gf-three flat: a body that is a picture, one cell of a sheet at a time (the gf-flat-1 standard, ART-STANDARD.md §2).
// It answers the members the kit reaches on `p.character` (object3d, height, play, locomotion, socket, setTint,
// nameplate, look, update, dispose, ...), the ones a picture has no use for as no-ops: the kit's controller, the
// net's place() and every mechanic drive it through those members and never learn that it has no skeleton.
//
// The sheet (the character.body.<role> slot, an image): 6 square cells across (idle, walk1, walk2, air, act, down) and
// 1 or 3 rows; its shape says which.
//   side-on                 the `side` row (or the only row), feet at the bottom middle, mirrored to face left
//   from above, 3 rows      down / side / up by the heading; never rotated; feet at the bottom middle of the cell
//   from above, 1 row       drawn lying on the ground, the top of the picture toward the heading, rotated with it
// The seat colour (mixed 30% toward white) goes onto the picture's light greys only: a shirt painted in light grey takes
// the player's colour with its shading kept, and skin, hair and coloured clothes keep their own (ART-STANDARD.md §2).
// Seen from above a body stands in the near-over-far order (look.js standY) and casts a small shadow.
import * as THREE from 'three';
import { FRAMES, FILL } from './slots.js';
import { pictureMaterial, standY, groundShadow } from './look.js';

/** The seat colour on light greys only: a texel takes material.color by how grey (unsaturated) and how light it is. */
export function tintGreys(mat) {
  mat.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        float hi = max( max( sampledDiffuseColor.r, sampledDiffuseColor.g ), sampledDiffuseColor.b );
        float lo = min( min( sampledDiffuseColor.r, sampledDiffuseColor.g ), sampledDiffuseColor.b );
        float grey = 1.0 - smoothstep( 0.07, 0.14, hi > 0.0 ? ( hi - lo ) / hi : 0.0 );
        float takes = grey * smoothstep( 0.18, 0.3, hi );
        diffuseColor = vec4( sampledDiffuseColor.rgb * mix( vec3( 1.0 ), diffuseColor.rgb, takes ), diffuseColor.a * sampledDiffuseColor.a );
      #endif`);
  };
  mat.customProgramCacheKey = () => 'gf-flat-tint-greys';
  return mat;
}

const F = Object.fromEntries(FRAMES.map((n, i) => [n, i]));

export async function spawnCharacter(ctx, { player = null, bodySlot = 'character.body.player', tint = null, height = 1.7 } = {}) {
  const side = ctx.flat?.plane === 'side', style = ctx.flat?.style ?? 'pixel';
  const shared = await ctx.assets.texture(bodySlot, player ? { player } : {});
  const iw = shared.image?.width || 6, ih = shared.image?.height || 1, rows = Math.abs(iw / ih - 2) < 0.01 ? 3 : 1;
  const map = shared.clone(); map.userData.gfSlot = bodySlot; map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping; map.repeat.set(1 / FRAMES.length, 1 / rows); map.needsUpdate = true;
  const mat = tintGreys(pictureMaterial(map, { style, order: 3 }));
  // a cell is height / FILL metres square: the standing figure fills at most FILL of it (ART-STANDARD.md §2)
  const size = height / FILL, turning = !side && rows === 1;
  const geo = new THREE.PlaneGeometry(size, size);
  if (side) geo.translate(0, size / 2, 0);
  else if (turning) geo.rotateX(-Math.PI / 2);
  else { geo.rotateX(-Math.PI / 2); geo.translate(0, 0, -size / 2 + size * 0.08); }      // lying on the ground, feet at the body's place, the head up the screen
  const quad = new THREE.Mesh(geo, mat); quad.name = 'body'; quad.renderOrder = 3;
  if (side) quad.position.z = 0.05; else { quad.position.y = 0.1; if (turning) quad.rotation.y = Math.PI; }
  const object3d = new THREE.Group(); object3d.name = `character:${player?.id ?? bodySlot}`;
  object3d.add(quad);
  // seen from above: a shadow at the feet (a 3-row body stands on its feet; a 1-row body lies centred on its place),
  // part of the body's slot like the picture
  const shadow = side ? null : groundShadow(height * 0.5, height * 0.2, style);
  if (shadow) { shadow.position.y = 0.045; object3d.add(shadow); }
  ctx.assets.tag(object3d, bodySlot);
  // where a carried or held thing goes: in front of the body
  const hold = new THREE.Group(); hold.name = 'hold'; object3d.add(hold);
  if (side) hold.position.set(0, height * 0.55, 0.1); else hold.position.set(0, 0.2, height * 0.3);

  let frame = -1, row = -1, held = null, until = 0, stride = 0, flash = 0, now = 0, speedNow = 0;
  const base = new THREE.Color('#ffffff'), WHITE = new THREE.Color('#ffffff');
  let plate = { text: player?.name ?? '', color: player?.color ?? '#ffffff' };
  const show = (f, r = row < 0 ? 0 : row) => { if (f === frame && r === row) return; frame = f; row = r; map.offset.set(f / FRAMES.length, 1 - (r + 1) / rows); };
  const me = {
    object3d, height: side ? height : 0.4, flat: true, model: quad, sockets: { hold }, tint: null, sheet: { rows, cell: iw / FRAMES.length, frames: FRAMES },
    /** What this body is drawn from (CONTRACT §6e: net/players.js compares it with what the player should wear). */
    look: { body: ctx.assets.fileFor?.(bodySlot, player) ?? null, hat: null, tint: null },
    // where the kit's nameplate goes. Seen from above "over the head" is not +Y: it is up the screen (-Z).
    plateOffset: side ? null : { x: 0, y: 0, z: -(turning ? size * 0.5 : size * 0.95) - 0.25 },
    get frame() { return FRAMES[frame] ?? null; },
    /** A one-shot or a held word. The words a picture can show: knockdown (down), a hit (a flash); anything else (a
     *  throw, a swing, a cheer) shows the `act` frame for a quarter second. */
    play(name, { hold: keep = false } = {}) {
      if (name === 'getup') { held = null; until = 0; return; }
      if (name === 'knockdown') { held = keep ? 'down' : null; until = now + 0.6; show(F.down); return; }
      if (name === 'hit') { flash = 0.18; return; }
      until = now + 0.25; show(F.act);
    },
    locomotion(speed, grounded = true) {
      speedNow = speed;
      if (held || now < until) return;
      if (!grounded) { show(F.air); return; }
      if (speed < 0.3) { show(F.idle); stride = 0; return; }
      show(Math.floor(stride) % 2 ? F.walk2 : F.walk1);
    },
    socket: () => hold,
    knock() { me.play('knockdown', { hold: true }); },
    recover() { held = null; until = 0; show(F.idle); },
    setAim() {}, express() {}, glow() {}, setHat() {},
    // the picture's own colours stay readable: the seat colour is mixed a third of the way back to white
    setTint(c) { if (c === null || c === undefined) return; me.tint = c; base.set(c).lerp(WHITE, 0.3); mat.color.copy(base); },
    setLookTint(c) { me.look.tint = c ?? null; me.setTint(c ?? player?.color ?? '#ffffff'); },
    nameplate(text, color) { plate = { text: text ?? plate.text, color: color ?? plate.color }; return plate; },
    get plate() { return plate; },
    update(dt) {
      now += dt; stride += dt * Math.max(2, speedNow * 1.9);
      if (flash > 0) { flash -= dt; mat.color.copy(base).lerp(WHITE, flash > 0 ? 0.7 : 0); }
      // the kit turns object3d about Y to the heading. A picture does not turn (unless it is a 1-row sheet seen from
      // above): it mirrors, and from above it picks its row.
      const yaw = object3d.rotation.y, sx = Math.sin(yaw), cz = Math.cos(yaw);
      if (side) { quad.rotation.y = -yaw; quad.scale.x = sx >= -0.01 ? 1 : -1; hold.rotation.y = -yaw; hold.position.x = 0; }
      else {
        // near over far: the row of the body's feet sets how far toward the eye it is drawn; its shadow stays down
        const y = object3d.position.y;
        quad.position.y = standY(object3d.position.z) - y + 0.002;
        if (shadow) { shadow.position.y = 0.045 - y; shadow.rotation.y = -yaw; }
        if (!turning) {
          quad.rotation.y = -yaw;
          const r = Math.abs(sx) > Math.abs(cz) * 1.15 ? 1 : cz > 0 ? 0 : 2;      // down (toward the screen's bottom), side, up
          quad.scale.x = r === 1 && sx < 0 ? -1 : 1;
          if (r !== row) show(frame < 0 ? F.idle : frame, r);
        }
      }
    },
    dispose() { object3d.removeFromParent(); map.dispose(); mat.dispose(); geo.dispose(); },
  };
  show(F.idle, turning || side ? (rows === 3 ? 1 : 0) : 0);
  me.setTint(tint);
  return me;
}
