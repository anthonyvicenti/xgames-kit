// runtime godot: the players. The game (Godot) moves this player and draws everyone else; the page sends this
// player's pose to friends (gf/mp: 15 a second), hands Godot where every friend is (the net's poses, interpolated
// 130 ms behind), and reads back where Godot drew each one and whether they are in view. That last part is what the
// multiplayer gate and the HUD read: a friend counts as seen only when this copy's game says it drew them on screen.
//
//   const friends = createFriends({ bridge, net, ctx, canvas });
//   every frame: friends.update()     send the pose, hand Godot the peers, place the name tags
//   const players = sessionPlayers(ctx, friends, { place })    the shared session's players (createSession)
//
// Poses are in metres, y up ({x, y, face, anim, look}); a 2D game has no z (seen from above, y is north); a 3D game's
// are {x, y, z, yaw, anim} in Godot's own axes.

const r3 = v => Math.round(v * 1000) / 1000;

export function createFriends({ bridge, net, ctx, canvas, tags = true }) {
  let tagLayer = null, tagsOn = tags;
  const tagEls = new Map();
  if (tags && typeof document !== 'undefined') {
    tagLayer = document.createElement('div');
    tagLayer.id = 'gf-godot-tags';
    tagLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;overflow:hidden';
    document.body.append(tagLayer);
  }
  let posed = null;
  const colorOf = peer => ctx.players?.get?.(peer.id)?.color ?? peer.color ?? '#4f7cff';
  const seatOf = peer => ctx.players?.get?.(peer.id)?.seat ?? peer.seat ?? 0;

  function update() {
    const me = bridge.latest.me;
    if (net.active && me && Number.isFinite(me.x) && !net.watching) {
      posed = { x: me.x, y: me.y, z: me.z ?? 0, yaw: me.yaw ?? 0, face: me.face ?? 1, anim: me.anim ?? 'idle', mode: me.mode ?? 'walk', ...(me.look ? { look: me.look } : {}) };
      net.pose(posed);
    }
    const list = [];
    if (net.active) for (const peer of net.peers()) {
      const s = peer.state;
      if (!s || !Number.isFinite(s.x)) continue;
      list.push({ id: peer.id, name: peer.name ?? peer.id, color: colorOf(peer), seat: seatOf(peer), x: r3(s.x), y: r3(s.y ?? 0), z: r3(s.z ?? 0), yaw: s.yaw ?? 0, face: s.face ?? 1, anim: s.anim ?? 'idle', mode: s.mode ?? 'walk', ...(s.look ? { look: s.look } : {}) });
    }
    bridge.set('peers', list);
    if (tagLayer) drawTags(list);
  }

  // the name tags: the page's, over the canvas, at the top of the box Godot says it drew the body in
  function drawTags(list) {
    const drawn = bridge.latest.friends ?? {}, rect = canvas.getBoundingClientRect();
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      let el = tagEls.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'gf-godot-tag';
        el.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;font:600 13px/1.2 system-ui,sans-serif;color:#fff;background:rgba(10,16,24,.62);border-radius:999px;padding:2px 9px;text-shadow:0 1px 2px #000;display:none';
        tagLayer.append(el); tagEls.set(p.id, el);
      }
      if (el.textContent !== p.name) el.textContent = p.name;
      el.style.border = `2px solid ${p.color}`;
      const f = drawn[p.id];
      if (!tagsOn || !f?.on || !Array.isArray(f.box)) { el.style.display = 'none'; continue; }
      const x = rect.left + ((f.box[0] + f.box[2]) / 2) * rect.width, y = rect.top + f.box[1] * rect.height - 4;
      el.style.display = '';
      el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%)`;
    }
    for (const [id, el] of tagEls) if (!seen.has(id)) { el.remove(); tagEls.delete(id); }
  }

  /** Where this copy's game drew a friend: {x, y, on, box} or null. */
  const drawn = id => bridge.latest.friends?.[id] ?? null;
  /** Where a friend's body is on this screen, in CSS pixels: {front, onScreen, rect} (the observation's project). */
  function project(id) {
    const f = drawn(id);
    if (!f?.box) return null;
    const r = canvas.getBoundingClientRect();
    return { front: true, onScreen: !!f.on, rect: { x0: r.left + f.box[0] * r.width, y0: r.top + f.box[1] * r.height, x1: r.left + f.box[2] * r.width, y1: r.top + f.box[3] * r.height } };
  }
  function list() {
    const out = [];
    for (const [id, f] of Object.entries(bridge.latest.friends ?? {})) out.push({ id, x: f.x, y: f.y, onScreen: !!f.on, box: f.box });
    return out;
  }
  return {
    update, drawn, project, list, pose: () => posed,
    tags(on) { tagsOn = !!on; if (!on) for (const el of tagEls.values()) el.style.display = 'none'; },
    dispose() { tagLayer?.remove(); tagEls.clear(); },
  };
}

/**
 * The shared session's players for a Godot game (createSession → createPlayers): who is in the round, their names,
 * colours, seats and scores, and where each one is for the HUD, the results and the multiplayer gate. No session
 * player has a controller: the game moves this player and draws the others. place(seat, pos?) asks the game to put
 * this player at their seat's spawn (or at pos). Bots (alone only: the session seats them) are moved by the game too
 * (GfBots2D): the page hands it the list (bridge 'bots') and reads back where each one is (GF.report_bot).
 */
export function sessionPlayers(ctx, friends, { bridge, place = () => {} } = {}) {
  const map = new Map();
  const vec = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } });
  const idle = () => Object.fromEntries(['primary', 'secondary', 'interact', 'jump'].map(a => [a, { down: false, pressed: false, released: false }]));
  const bySeat = (a, b) => a.seat - b.seat || String(a.id).localeCompare(String(b.id));
  async function add(info) {
    if (map.has(info.id)) return map.get(info.id);
    const p = {
      id: info.id, name: info.name ?? info.id, color: info.color ?? '#ffffff', seat: info.seat ?? 0, isBot: false, local: !!info.local, owned: !!info.owned,
      ghost: !!info.ghost, score: 0, alive: true, data: {}, character: null, controller: null, body: null, pose: null, position: vec(), yaw: 0, pitch: 0, anim: 'idle',
      aim: [0, 0, 1], aimDist: null, actions: idle(), input: { x: 0, z: 0 }, bot: null, poseExtra: {}, connected: true, drawn: !!info.local, onScreen: false, mode: 'walk',
      act() {}, knock() { return false; }, push() { return false; },
      isBot: !!info.isBot,
      teleport(pos, yaw) { if (p.local) place(p.seat, pos, yaw); },
      get x() { return p.position.x; }, get y() { return p.position.y; }, get z() { return p.position.z; },
    };
    p.role = info.role ?? 'player';
    map.set(p.id, p);
    if (p.isBot) botsChanged();
    return p;
  }
  function remove(id) { const was = map.get(id); map.delete(id); ctx.assets?.clearLoadout?.(id); if (was?.isBot) botsChanged(); }
  const botsChanged = () => bridge?.set('bots', [...map.values()].filter(p => p.isBot).sort(bySeat).map(p => ({ id: p.id, name: p.name, color: p.color, seat: p.seat })));
  function placeFriend(p, s) {
    if (!p || p.local || !s || !Number.isFinite(s.x)) return;
    if (!friends.drawn(p.id)) p.position.set(s.x, s.y ?? 0, s.z ?? 0);
    p.anim = s.anim ?? p.anim;
  }
  function sync() {
    const me = bridge.latest.me;
    for (const p of map.values()) {
      if (p.local) {
        if (me && Number.isFinite(me.x)) { p.position.set(me.x, me.y, me.z ?? 0); p.anim = me.anim ?? 'idle'; p.yaw = Number.isFinite(me.yaw) ? me.yaw : (me.face ?? 1) < 0 ? -Math.PI / 2 : Math.PI / 2; }
        p.drawn = true;
        continue;
      }
      if (p.isBot) {
        const b = bridge.latest.bots?.[p.id];
        if (b && Number.isFinite(b.x)) { p.position.set(b.x, b.y, b.z ?? 0); p.anim = b.anim ?? 'idle'; p.drawn = true; } else p.drawn = false;
        continue;
      }
      const f = friends.drawn(p.id);
      if (f && Number.isFinite(f.x)) { p.position.set(f.x, f.y, f.z ?? 0); p.drawn = true; p.onScreen = !!f.on; }
      else { p.drawn = false; p.onScreen = false; }
    }
  }
  const api = {
    add, remove, place: placeFriend, sync, updateLooks() {}, wantLook() {},
    visible: (p, covered = false) => !covered && !p.local && !!friends.drawn(p.id)?.on,
    list: () => [...map.values()].filter(p => !p.ghost).sort(bySeat),
    get: id => map.get(id) ?? null,
    others: () => api.list().filter(p => !p.local),
    owned: () => [...map.values()].filter(p => p.owned).sort(bySeat),
    humans: () => api.list().filter(p => !p.isBot),
    bots: () => api.list().filter(p => p.isBot),
    get size() { return map.size; },
  };
  return api;
}
