// mechanic: pickup (track K2). Collectables at fixed spots: walk into one, or press interact (E) next to it, and it is
// yours; it comes back after a while. Heals, scores, hands you a carried item, or just calls your rules. README.md has
// ownership and API.
//
//   const pk = ctx.mechanics.get('pickup');
//   pk.onCollect(({ player, effect }) => { player.data.ammo = (player.data.ammo ?? 0) + 5; });   // host only
//
// Interact means interact (creator, T1 run 5: "I cant seem to ... drink"; the HUD said "E: grab a drink" and E did
// nothing): `collect` is 'both' by default (touch, and a press of `action` within `reach` metres). Near a spot the HUD
// shows "E: <the game's own words for interact>". Every collect shows: the item flies into the collector and shrinks,
// with the collect sound, on every copy, whatever the rules then do with it (a full bladder still sees the drink go).
import * as THREE from 'three';
import { touches, createSpots, pointsIn, clearOfShapes } from './logic.js';
import { areaOf } from '../../core/util.js';

export const id = 'pickup';
export const examples = ['balls respawn', 'health hearts around the arena', 'coins to collect'];

const D = { prop: '', count: -1, zone: '', size: 0.5, color: '#ffd23f', effect: 'auto', value: 1, radius: 1.0, collect: 'both', reach: 2.0, action: 'interact', prompt: true, respawnSeconds: 8, bob: true, spin: true, maxSpots: 24, soundCollect: 'coin', marker: 'auto' };
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    prop: { type: 'string', default: D.prop, description: 'Name of the prop.* slot to draw ("": the first gameplay prop of the game, else a coloured gem)' },
    count: { type: 'integer', minimum: -1, maximum: 40, default: D.count, description: 'Spots placed at the start (-1: the game prop\'s count; 0: none, the rules call spawnAt)' },
    zone: { type: 'string', default: D.zone, description: 'World zone the spots go in ("": scattered around the play area)' },
    size: { ...num('Drawn size in metres', 0.1, 3), default: D.size },
    color: { type: 'string', default: D.color, description: 'Colour of the stand-in gem and the ring under it' },
    effect: { type: 'string', enum: ['auto', 'carry', 'heal', 'score', 'none'], default: D.effect, description: 'What a touch does by itself: carry (hand the player a carried item), heal (health.heal), score (+value), none (rules only); auto: carry when the carry mechanic is there, else score' },
    value: { ...num('Amount for heal and score', 0, 100), default: D.value },
    radius: { ...num('Touch distance in metres', 0.3, 5), default: D.radius },
    collect: { type: 'string', enum: ['touch', 'press', 'both'], default: D.collect, description: 'How a spot is taken: walking into it (touch), pressing `action` within `reach` (press), or either (both)' },
    reach: { ...num('Press distance in metres (collect press or both)', 0.5, 6), default: D.reach },
    action: { type: 'string', enum: ['interact', 'primary', 'secondary'], default: D.action, description: 'The input that takes a spot within reach' },
    prompt: { type: 'boolean', default: D.prompt, description: 'Show "E: <controls.interact>" when a spot is within reach' },
    respawnSeconds: { ...num('Seconds until a taken spot returns (0: never)', 0, 120), default: D.respawnSeconds },
    bob: { type: 'boolean', default: D.bob, description: 'Float up and down' },
    spin: { type: 'boolean', default: D.spin, description: 'Turn slowly' },
    maxSpots: { type: 'integer', minimum: 1, maximum: 40, default: D.maxSpots, description: 'Spots alive at once (each costs about 20 bytes of the world message)' },
    soundCollect: { type: 'string', default: D.soundCollect, description: 'Sound id when a spot is taken' },
    marker: { type: 'string', enum: ['auto', 'ring', 'none'], default: D.marker, description: 'A faint ring on the ground under each spot. auto: only under the stand-in gem (a real prop model reads by itself); ring: always; none: never' },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.pickup.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : 'gameplay', ...extra });
export const slots = [
  vs('respawnSeconds', 'Respawn time', 'number', { tier: 'main', rank: 54, constraints: { min: 0, max: 120, unit: 's' } }),
  vs('color', 'Stand-in colour', 'color', { rank: 28 }),
  vs('value', 'Value of a pickup', 'number', { rank: 40, constraints: { min: 0, max: 100 } }),
  vs('count', 'Spots at the start', 'integer', { constraints: { min: -1, max: 40 } }),
  vs('radius', 'Touch distance', 'number', { constraints: { min: 0.3, max: 5, unit: 'm' } }),
  vs('collect', 'How a pickup is taken (touch | press | both)', 'text', { constraints: { enum: ['touch', 'press', 'both'] } }),
  vs('reach', 'Press distance', 'number', { constraints: { min: 0.5, max: 6, unit: 'm' } }),
  vs('size', 'Drawn size', 'number', { constraints: { min: 0.1, max: 3, unit: 'm' } }),
  vs('prop', 'Pickup prop', 'text', { constraints: { maxLength: 40 } }),
  vs('bob', 'Bobs up and down', 'boolean'),
  vs('spin', 'Turns slowly', 'boolean'),
  vs('soundCollect', 'Collect sound id', 'text', { constraints: { maxLength: 40 } }),
  vs('marker', 'Ring under each pickup (auto | ring | none)', 'text', { constraints: { enum: ['auto', 'ring', 'none'] } }),
];

const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.pickup.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const gameProp = () => { const list = ctx.config?.props ?? []; return list.find(p => p.name === V('prop')) ?? (V('prop') ? null : list[0]) ?? null; };
  const pool = createSpots(V('maxSpots'));
  const L = { collect: [] };
  const root = new THREE.Group(); root.name = 'gf-pickups'; ctx.scene.add(root);
  const view = [];                  // every copy: per spot index {obj, ring, state, pop}
  const lastPos = new Map();
  const flying = [];                // every copy: taken items flying into their collector {obj, from, s0, who, t}
  const stats = { touch: 0, press: 0, pressMissed: 0 };
  let S = null, needSpawn = true, tmpl = null, ringGeo = null, loading = false, t0 = 0, standin = false, promptOn = false;
  const now = () => ctx.time.now;
  const effectOf = () => { const e = V('effect'); return e !== 'auto' ? e : ctx.mechanics?.get('carry') && !ctx.mechanics.get('carry').standin ? 'carry' : 'score'; };

  async function loadTemplate() {
    if (loading) return; loading = true;
    const name = V('prop') || gameProp()?.name || '';
    try { if (name && ctx.assets.has(`prop.${name}`)) tmpl = await ctx.assets.model(`prop.${name}`, { fit: V('size') }); } catch (e) { console.warn('pickup: prop model failed, drawing a gem', e); }
    if (!tmpl) {
      const m = ctx.modules?.look?.material?.('prop', { tint: V('color') }) ?? new THREE.MeshStandardMaterial({ color: V('color'), roughness: 0.4 });
      const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(V('size') * 0.5), m); mesh.castShadow = true;
      ctx.assets.tag(mesh, 'mechanic.pickup.color'); tmpl = mesh; standin = true;
    }
    // the spot marker: a faint thin ring, only where it helps (the stand-in gem), unless the game asks for it
    const mk = V('marker');
    if (mk === 'ring' || (mk !== 'none' && standin)) ringGeo = new THREE.RingGeometry(V('radius') * 0.48, V('radius') * 0.54, 40).rotateX(-Math.PI / 2);
    loading = false;
  }
  function viewFor(i) {
    let v = view[i];
    if (!v) {
      if (!tmpl) return null;
      const obj = tmpl.clone(true);
      let ring = null;
      if (ringGeo) {
        ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: V('color'), transparent: true, opacity: 0.3, depthWrite: false }));
        ring.renderOrder = 1; ctx.assets.tag(ring, 'mechanic.pickup.color'); root.add(ring);
      }
      root.add(obj); v = view[i] = { obj, ring, state: -1, pop: 1 };
    }
    return v;
  }

  function hostSpawnStart() {
    needSpawn = false;
    const n = V('count') >= 0 ? V('count') : (gameProp()?.count ?? 0);
    if (n <= 0) return;
    const z = V('zone') && ctx.world.zone?.(V('zone')), A = areaOf(ctx.world);
    let zone;
    if (z) { const at = z.at; zone = z.shape === 'box' ? { shape: 'box', cx: at.x ?? at[0], cz: at.z ?? at[2], rx: (z.size[0] ?? 2) / 2, rz: (z.size[2] ?? z.size[0] ?? 2) / 2 } : { shape: 'circle', cx: at.x ?? at[0], cz: at.z ?? at[2], rx: z.size[0] ?? 2 }; }
    else zone = { shape: 'box', cx: A.cx, cz: A.cz, rx: Math.max(1, A.hx - 3), rz: Math.max(1, A.hz - 3) };
    // never inside a bench or a wall: spots keep clear of the world's colliders
    const free = ctx.world?.shapes ? clearOfShapes(ctx.world.shapes, V('size') * 0.5 + 0.35) : null;
    for (const q of pointsIn(zone, n, () => ctx.rng(), Math.max(0.8, V('size') * 1.6), free)) pool.add(q.x, 0, q.z, V('respawnSeconds'));
  }
  function collectBy(i, p, how = 'touch') {
    if (!pool.take(i, now())) return false;
    const eff = effectOf(), s = pool.spots[i];
    if (how === 'press' || how === 'touch') stats[how]++;
    if (eff === 'heal') ctx.mechanics?.get('health')?.heal?.(p, V('value'));
    else if (eff === 'score') p.score += V('value');
    else if (eff === 'carry') ctx.mechanics?.get('carry')?.give?.(p, {});
    ctx.net.send('pickup:got', { i, p: p.id }, 'all');
    gotFx(i, p);
    for (const fn of L.collect.slice()) try { fn({ player: p, index: i, effect: eff, value: V('value'), point: { x: s.x, y: s.y, z: s.z }, how }); } catch (e) { console.error(e); }
    return true;
  }
  const canTouch = () => V('collect') !== 'press', canPress = () => V('collect') !== 'touch';
  /** The nearest present spot within `reach` of a player (every copy, from what it draws) → {index, d} | null */
  function inReach(p, reach = V('reach')) {
    let best = null;
    for (const s of api.list()) {
      if (!s.present) continue;
      const d = Math.hypot(s.x - p.position.x, s.z - p.position.z);
      if (d <= reach && Math.abs(s.y - p.position.y) < 2.5 && (!best || d < best.d)) best = { index: s.index, d };
    }
    return best;
  }
  /** Host: a press of `action` by p near spot i (or the nearest in reach). slack: metres for a friend's latency. */
  function hostPress(p, i = null, slack = 0) {
    if (!p || p.alive === false || !canPress()) return false;
    let n = null;
    if (i === null) n = inReach(p);
    else { const s = pool.spots[i]; if (s && s.state === 1 && Math.hypot(s.x - p.position.x, s.z - p.position.z) <= V('reach') + slack) n = { index: i }; }
    if (!n) { stats.pressMissed++; return false; }
    return collectBy(n.index, p, 'press');
  }
  // every collect shows on every copy: the item flies into the collector, shrinking, with the collect sound
  const gotFx = (i, p) => {
    const s = (ctx.host ? pool.spots[i] : null) ?? (S?.p?.[i] ? { x: S.p[i][0], y: S.p[i][1], z: S.p[i][2] } : null);
    if (s && V('soundCollect')) ctx.audio?.play(V('soundCollect'), { at: s, optional: true });
    const v = view[i];
    if (v?.obj && p?.position && tmpl) {
      const obj = tmpl.clone(true);
      obj.position.copy(v.obj.position); obj.rotation.copy(v.obj.rotation); obj.visible = true; root.add(obj);
      flying.push({ obj, from: obj.position.clone(), s0: Math.max(0.3, v.obj.scale.x), who: p, t: 0 });
    }
  };
  function stepFlying(dt) {
    for (let k = flying.length - 1; k >= 0; k--) {
      const f = flying[k]; f.t += dt;
      const u = Math.min(1, f.t / 0.35), e = u * u * (3 - 2 * u), q = f.who.position, h = (f.who.character?.height ?? 1.7) * 0.6;
      f.obj.position.set(f.from.x + (q.x - f.from.x) * e, f.from.y + (q.y + h - f.from.y) * e + Math.sin(u * Math.PI) * 0.5, f.from.z + (q.z - f.from.z) * e);
      f.obj.scale.setScalar(f.s0 * (1 - 0.85 * e)); f.obj.rotation.y += dt * 9;
      if (u >= 1) { f.obj.removeFromParent(); flying.splice(k, 1); }
    }
  }
  const keyName = a => (a === 'interact' ? 'E' : a === 'primary' ? 'Click' : a === 'secondary' ? 'Right click' : a);

  const api = {
    id, params: P,
    /** Host: {player, index, effect, value, point} each time a spot is taken. → unsubscribe */
    onCollect(fn) { L.collect.push(fn); return unsub(L.collect, fn); },
    /** An interact mechanic (CONTRACT §6d): a press of `action` near a spot takes it. */
    interacts: true,
    /** Host: make `player` take spot i now. */
    collect(i, player) { return ctx.host && S ? collectBy(i, player, 'rules') : false; },
    /** Take the spot in reach now, as a press of `action` would (an owned player, or a bot on the host). → true when asked */
    press(p) {
      if (!S || !p || !(p.owned || ctx.host)) return false;
      if (ctx.host) return hostPress(p);
      const n = inReach(p); if (n) ctx.net.send('pickup:press', { i: n.index, p: p.id }, 'host');
      return !!n;
    },
    /** What a player can interact with (QA, verify check 13): present spots, with the press distance and the touch distance. */
    interactables: () => (canPress() ? api.list().filter(s => s.present).map(s => ({ kind: 'pickup', id: `pickup:${s.index}`, x: s.x, y: s.y, z: s.z, reach: V('reach'), touch: canTouch() ? V('radius') : 0, action: V('action') })) : []),
    /** Collects so far by how (touch, press) and presses that found nothing in reach (host). */
    get stats() { return { ...stats }; },
    /** Host: a new spot at pos {x, z, y?}. opts {respawn} seconds (default respawnSeconds; 0 = once). → index or -1 */
    spawnAt(pos, opts = {}) { return ctx.host && S ? pool.add(pos.x, pos.y ?? 0, pos.z, opts.respawn ?? V('respawnSeconds')) : -1; },
    /** Host: remove spot i for good. */
    remove(i) { if (ctx.host) pool.remove(i); },
    /** Host: show or hide spot i by hand (a hidden spot waits until set(i, true)). */
    set(i, present) { if (ctx.host) pool.set(i, present); },
    /** Spots now, on any copy: [{index, x, y, z, present}] */
    list() { const raw = ctx.host ? pool.encode() : (S?.p ?? []); return raw.map((s, index) => ({ index, x: s[0], y: s[1], z: s[2], present: s[3] === 1 })).filter((_, i) => raw[i][3] !== 2); },
    presentCount() { return api.list().filter(s => s.present).length; },
    /** The nearest present spot to pos {x, z} (for bots) or null. */
    nearest(pos) { let b = null, bd = Infinity; for (const s of api.list()) if (s.present) { const d = Math.hypot(s.x - pos.x, s.z - pos.z); if (d < bd) { b = s; bd = d; } } return b; },
    reset() { pool.clear(); view.forEach(v => { v?.obj.removeFromParent(); v?.ring?.removeFromParent(); }); view.length = 0; needSpawn = true; lastPos.clear(); flying.forEach(f => f.obj.removeFromParent()); flying.length = 0; },
    update(dt) {
      if (!S) { if (!(ctx.shared && ctx.players && ctx.me)) return; S = ctx.shared.register('pk', { p: [] }); loadTemplate(); }
      if (!tmpl && !loading) loadTemplate();
      t0 += dt;
      if (ctx.host) {
        if (needSpawn) hostSpawnStart();
        if (ctx.round?.phase === 'playing') {
          pool.tick(now());
          for (const p of ctx.players.list()) {
            const cur = { x: p.position.x, y: p.position.y, z: p.position.z }, prev = lastPos.get(p.id) ?? cur;
            lastPos.set(p.id, cur);
            if (p.alive === false) continue;
            if (canTouch()) for (let i = 0; i < pool.spots.length; i++) { const s = pool.spots[i]; if (s.state === 1 && touches(s, prev, cur, V('radius'), P.touchHeight)) { collectBy(i, p, 'touch'); } }
            // a press of the action by an owned player (the host's own, every bot); friends ask through pickup:press
            if (p.owned && p.actions?.[V('action')]?.pressed) hostPress(p);
          }
        }
        S.p = pool.encode();
      } else if (ctx.round?.phase === 'playing' && ctx.me?.owned && ctx.me.alive !== false && canPress() && ctx.me.actions?.[V('action')]?.pressed) {
        const n = inReach(ctx.me);
        if (n) ctx.net.send('pickup:press', { i: n.index, p: ctx.me.id }, 'host');
      }
      // the hint: near a spot the local player can take with a press
      if (V('prompt') && canPress() && ctx.ui?.prompt && ctx.me) {
        const near = ctx.round?.phase === 'playing' && ctx.me.alive !== false && !!inReach(ctx.me);
        if (near !== promptOn) { promptOn = near; ctx.ui.prompt(near ? `${keyName(V('action'))}: ${ctx.config?.controls?.[V('action')] ?? 'pick up'}` : null, 'pickup'); }
      }
      const raw = ctx.host ? S.p : S.p ?? [];
      for (let i = 0; i < raw.length; i++) {
        const s = raw[i], v = viewFor(i); if (!v) continue;
        const show = s[3] === 1;
        if (v.state !== s[3]) { if (show && v.state !== -1) v.pop = 0; v.state = s[3]; }       // the edge: it came back
        v.pop = Math.min(1, v.pop + dt * 3);
        v.obj.visible = show; if (v.ring) v.ring.visible = show;
        const k = show ? (0.3 + 0.7 * v.pop) : 0;
        v.obj.scale.setScalar(k);
        v.obj.position.set(s[0], s[1] + 0.55 + (V('bob') ? Math.sin(t0 * 2.4 + i) * 0.12 : 0), s[2]);
        if (V('spin')) v.obj.rotation.y = t0 * 1.6 + i;
        v.ring?.position.set(s[0], s[1] + 0.03, s[2]);
      }
      stepFlying(dt);
    },
    /** `pickup:got` (host to all: a spot was taken; the sound and the fly-in) and `pickup:press` (a friend's press of the
     *  action, to the host: taken when the spot is within reach, with 1 m of slack for latency). */
    event(name, d, from) {
      if (name === 'got' && !ctx.host) gotFx(d.i, ctx.players.get(d.p) ?? null);
      else if (name === 'press' && ctx.host && S) {
        const p = ctx.players.get(d?.p); if (!p || p.isBot || (ctx.net.active && from !== undefined && from !== p.id)) return;
        if (Number.isInteger(d.i)) hostPress(p, d.i, 1.0);
      }
    },
    dispose() { root.removeFromParent(); },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs MANIFEST lists the fields): what `create` composes and refuses by, what the
// catalog tells a pitch, the handlers and traps of the rules.js stub, and verify check 15's sign of life. The tools
// read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, examples, params,
  describe: 'Consumables that refill or modify a player\'s meters; respawn',
  rank: 30,
  // what a collect does by itself decides what else the game must have
  needs: p => ({ parts: p.effect === 'heal' ? [{ id: 'health', why: 'effect "heal" calls health.heal' }] : p.effect === 'carry' ? [{ id: 'carry', why: 'effect "carry" hands the player a carried item' }] : [], world: [] }),
  uses: ['carry', 'health'],
  // its thing (kit/assets/items.js): one kind of pickup, the mechanic's own params; its picture is the prop it draws
  items: [{ single: true, noun: 'pickup', fields: ['value', 'respawnSeconds', 'count', 'size', 'radius', 'reach', 'color'], front: ['value', 'respawnSeconds', 'count'],
    picture: (p, game) => { const n = p.prop || (game?.props ?? [])[0]?.name; return n ? `prop.${n}` : 'mechanic.pickup.color'; } }],
  owns: p => (p.collect === 'touch' ? [] : [{ res: `input.${p.action}`, shared: true, why: `a press of ${p.action} within reach takes a spot (params.action, collect "${p.collect}")`, free: 'set pickup params.collect to "touch", or params.action to another input' }]),
  state: { key: 'pk', fields: { p: '[[x, y, z, state]] per spot: state 1 = out, 0 = taken and waiting to come back' } },
  events: [
    { name: 'onCollect', on: 'host', args: '{ player, index, effect, value, point, how: \'touch\' | \'press\' | \'rules\' }', when: 'a player took a spot' },
  ],
  sync: { owner: 'host', how: 'the host owns the spots and who takes them; a guest\'s press goes to the host' },
  note: [
    'A spot is taken by walking into it or by a press of interact within reach; it comes back after respawnSeconds.',
    'effect says what a collect does by itself: auto (hand a carried item when the game has carry, else +value score), heal, score, carry, or none (your onCollect alone).',
    'Name the pickup\'s prop in the spec (a prop whose role says players pick it up): without one it is a stand-in gem, which the set-dressing lint fails.',
  ],
  stub: {
    as: 'pk',
    worked: 'pk.onCollect(({ player }) => { player.data.ammo = (player.data.ammo ?? 0) + 5; });',
    traps: [
      'with effect "score" (or auto without carry) a collect already adds value to the score: adding it again in onCollect counts it twice',
      'bots take pickups only when the rules send them: in bot(ctx, p) use p.bot.seek(pk.nearest(p.position))',
    ],
  },
  signs: {
    sample: sh => (sh.pk ? { pk: (sh.pk.p ?? []).map(q => q[3]) } : null),
    judge: v => {
      const o = v.others;
      if (!o.pkPresent) v.add('pickups are there', 'dead', 'shared.pk.p[i][3]', `no pickup was out on any page (${v.names})`, 'check mechanics[pickup].params count and zone');
      else if (o.pkTaken) v.add('one is taken', 'ok', 'shared.pk.p[i][3] 1 → 0', `${o.pkTaken} taken`);
      else v.add('one is taken', 'dead', 'shared.pk.p[i][3] 1 → 0', `${o.pkPresent} pickups were out and nobody took one on any page (${v.names})`, 'make bots go for them (rules.bot: p.bot.seek(pk.nearest(p.position))) and keep them where players walk; collect "both" lets E take them');
    },
  },
};
