// gf-three: an item held on a character's hand socket (a weapon on hand_r, a shield on hand_l). With a `grip`
// ({position: [x, y, z] m, quaternion: [x, y, z, w]}: the item's place on the kit's socket, as research/gf-scenic/
// library/props.json records it for each KayKit weapon) the item sits exactly as the pack's characters hold it; without
// one, a rotation in degrees and an offset (the kit's stand-ins: grip at the origin, blade toward +Y).
const DEG = Math.PI / 180;

/** Put `obj` on the socket: by its grip when it has one, else by rot (degrees) and offset (m). */
export function hold(socket, obj, { grip = null, rot = [90, 0, 0], offset = [0, 0, 0], scale = 1 } = {}) {
  if (!socket || !obj) return obj;
  const p = Array.isArray(grip?.position) && grip.position.length === 3 ? grip.position : null;
  const q = Array.isArray(grip?.quaternion) && grip.quaternion.length === 4 ? grip.quaternion : null;
  if (p && q) { obj.position.set(p[0], p[1], p[2]); obj.quaternion.set(q[0], q[1], q[2], q[3]); }
  else { obj.rotation.set((rot?.[0] ?? 0) * DEG, (rot?.[1] ?? 0) * DEG, (rot?.[2] ?? 0) * DEG); obj.position.set(offset?.[0] ?? 0, offset?.[1] ?? 0, offset?.[2] ?? 0); }
  if (scale !== 1) obj.scale.multiplyScalar(scale);
  socket.add(obj);
  return obj;
}

/** A grip from params, or null: {position: [3 numbers], quaternion: [4 numbers]}. */
export const gripOf = g => (g && Array.isArray(g.position) && g.position.length === 3 && Array.isArray(g.quaternion) && g.quaternion.length === 4 && [...g.position, ...g.quaternion].every(Number.isFinite) ? g : null);
