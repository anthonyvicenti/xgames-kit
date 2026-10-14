// mechanic: carve. Explosions bite smooth craters out of the terrain world (worlds/terrain), and the host keeps the ground
// the same on every screen. With the projectile mechanic, every shot with a splash carves where it ends by itself
// (fromProjectile); rules.js can carve or add ground too (host). README.md has the network ownership and the API.
//
//   const carve = ctx.mechanics.get('carve');
//   if (ctx.host) carve.carve({ x, y, z }, 2.5);       // a crater 2.5 m across the radius, on every copy
//   carve.onCarve(c => ...)                              // every copy: {op, at, r, normal, live} (sounds, shake, score)
import { craterRadius, createFeed, chunksOf } from './logic.js';

export const id = 'carve';
export const examples = ['explosions blow smooth craters in the ground', 'dig tunnels through an island', 'artillery that reshapes the land'];

const D = { fromProjectile: true, radius: 0, scale: 1, minRadius: 0.6, maxRadius: 8, keep: false, debris: true, blastFx: '', dustFx: '', splashFx: '', sound: '', splashSound: '', shake: 0.25 };
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    fromProjectile: { type: 'boolean', default: D.fromProjectile, description: 'Carve where the projectile mechanic\'s shots end, when they have a splash (splashRadius > 0)' },
    radius: { ...num('Crater radius in metres (0: the shot\'s splash radius times scale)', 0, 20), default: D.radius },
    scale: { ...num('Crater radius per metre of the shot\'s splash radius', 0.1, 4), default: D.scale },
    minRadius: { ...num('Smallest crater (m)', 0.2, 10), default: D.minRadius },
    maxRadius: { ...num('Largest crater (m)', 0.5, 20), default: D.maxRadius },
    keep: { type: 'boolean', default: D.keep, description: 'Keep the craters from one round to the next (false: every round starts on the ground as it was made)' },
    debris: { type: 'boolean', default: D.debris, description: 'Lumps of ground thrown out of each crater' },
    blastFx: { type: 'string', description: 'A vfx preset (kit/vfx: impact-flash, spark-burst, ...) at the heart of each blast; unset: none', default: D.blastFx },
    dustFx: { type: 'string', description: 'A vfx preset (kit/vfx: smoke-puff, dust-kick, ...) rising from each crater; unset: none', default: D.dustFx },
    splashFx: { type: 'string', description: 'A vfx preset (kit/vfx: smoke-puff, ...) where a blast lands in the sea and carves nothing; unset: none', default: D.splashFx },
    splashSound: { type: 'string', description: 'A sound id played where a blast lands in the sea; unset: none', default: D.splashSound },
    sound: { type: 'string', description: 'A sound id (assets.json → sounds) played at each crater; unset: none', default: D.sound },
    shake: { ...num('Camera shake at a blast next to the camera (m)', 0, 2), default: D.shake },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.carve.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: 'gameplay', ...extra });
export const slots = [
  vs('scale', 'Crater size (per metre of blast)', 'number', { tier: 'main', rank: 46, constraints: { min: 0.1, max: 4 } }),
  vs('radius', 'Crater size (fixed, 0: from the blast)', 'number', { constraints: { min: 0, max: 20, unit: 'm' } }),
  vs('maxRadius', 'Largest crater', 'number', { constraints: { min: 0.5, max: 20, unit: 'm' } }),
  vs('keep', 'Craters stay between rounds', 'boolean'),
  vs('shake', 'Blast camera shake', 'number', { facet: 'look', constraints: { min: 0, max: 2, unit: 'm' } }),
];

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.carve.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const L = { carve: [] };
  const feed = createFeed();
  const stats = { carved: 0, added: 0, splashes: 0, asked: 0, logsSent: 0, caughtUp: 0 };
  let S = null, T = null, round = 0, linked = false, askedAt = -9, shake = 0, vfx = null, groundRound = 0;
  if (P.blastFx || P.dustFx || P.splashFx) import('../../vfx/index.js').then(m => { vfx = m.vfxOf(ctx); }).catch(e => console.warn(`gf-three carve: blastFx/dustFx need the vfx module (${e.message})`));
  const log = [];           // host: every edit of this round, in order (what a late copy is sent)

  /** An edit applied on this copy: the ground, then what every copy shows for it (live), then the listeners. */
  function applied(e, { live = true, by = null } = {}) {
    const changed = T.apply(e, { quiet: !live || !V('debris') });
    if (!changed) return false;
    const op = e[0] === 0 ? 'carve' : 'add', at = { x: e[1] / 100, y: e[2] / 100, z: e[3] / 100 }, r = e[4] / 100;
    if (op === 'carve') stats.carved++; else stats.added++;
    if (live && op === 'carve') {
      if (vfx && P.blastFx) vfx.fx(P.blastFx, { at, scale: Math.max(0.6, r / 1.6) });
      if (vfx && P.dustFx) vfx.fx(P.dustFx, { at: { x: at.x, y: at.y + r * 0.3, z: at.z }, scale: Math.max(0.8, r / 1.2) });
      if (P.sound) ctx.audio?.play?.(P.sound, { at, optional: true });
      const cam = ctx.camera?.position, d = cam ? Math.hypot(cam.x - at.x, cam.y - at.y, cam.z - at.z) : 99;
      shake = Math.max(shake, V('shake') * Math.max(0, 1 - d / (r * 8 + 10)));
    }
    const normal = T.normal(at.x, at.y + r * 0.5, at.z);
    for (const fn of L.carve.slice()) try { fn({ op, at, r, normal, live, by }); } catch (err) { console.error(err); }
    return true;
  }
  /** Every copy: a blast that landed in the sea (it carves nothing): a splash where everyone sees it. */
  function splashAt(at, r) {
    stats.splashes++;
    if (vfx && P.splashFx) vfx.fx(P.splashFx, { at, scale: Math.max(1, r / 0.8) });
    if (P.splashSound) ctx.audio?.play?.(P.splashSound, { at, optional: true });
  }
  /** Host: make an edit, apply it here and send it to everyone. */
  function hostEdit(op, at, r, by = null) {
    if (!T || !ctx.host) { if (T && !ctx.host) console.warn('gf-three carve: carve() and add() change the ground on the host only: keep them under if (ctx.host)'); return null; }
    const e = T.editOf(op, at, r);
    if (!e || !applied(e, { live: true, by })) return null;
    log.push(e);
    if (S) S.n = log.length;
    ctx.net?.send('carve:e', { r: round, i: log.length - 1, e });
    return e;
  }
  /** A copy that is not the host: back to the ground as it was made, for the host's round R. */
  function freshGround(R) { if (groundRound !== R) T.reset(); groundRound = R; feed.reset(R); }

  function link() {
    if (linked) return; linked = true;
    const prj = ctx.mechanics?.get('projectile');
    if (!prj || prj.standin || !V('fromProjectile')) return;
    const splashOf = () => { try { return ctx.assets?.has('mechanic.projectile.splash-radius') ? ctx.assets.value('mechanic.projectile.splash-radius', prj.params?.splashRadius ?? 0) : prj.params?.splashRadius ?? 0; } catch { return prj.params?.splashRadius ?? 0; } };
    prj.onEnd(h => {
      if (!ctx.host || h.reason === 'expired' || !h.point) return;
      const r = craterRadius({ radius: V('radius'), scale: V('scale'), minRadius: V('minRadius'), maxRadius: V('maxRadius') }, splashOf());
      if (r <= 0) return;
      if (hostEdit('carve', h.point, r, h.shooter?.id ?? null)) return;
      // nothing to carve there: a blast on the sea splashes (on every copy)
      const sea = ctx.world?.seaLevel ?? 0;
      if (h.point.y <= sea + 0.8) { const at = { x: Math.round(h.point.x * 100) / 100, y: sea, z: Math.round(h.point.z * 100) / 100 }; splashAt(at, r); ctx.net?.send('carve:s', { p: [at.x, at.y, at.z], r }); }
    });
  }

  const api = {
    id: 'carve', stats,
    setup() {
      T = ctx.world?.terrain ?? null;
      if (!T) throw new Error('gf-three carve: needs the terrain world (config/world.json template "terrain")');
      S = ctx.shared.register('carve', { r: 0, n: 0 });
      link();
    },
    /** Host: a crater of radius r (m) at {x, y, z}, on every copy. → the edit, or null (nothing there to carve). */
    carve: (at, r, by = null) => hostEdit('carve', at, r, by),
    /** Host: a lump of ground of radius r at {x, y, z} (a bridge, a wall, a filled hole), on every copy. */
    add: (at, r, by = null) => hostEdit('add', at, r, by),
    /** Every copy: after each edit of the ground {op, at, r, normal, live (false when a late copy catches up), by}. */
    onCarve(fn) { L.carve.push(fn); return () => { const i = L.carve.indexOf(fn); if (i >= 0) L.carve.splice(i, 1); }; },
    /** How many edits this copy has applied this round (the host: its log). */
    applied: () => (ctx.host ? log.length : feed.next),
    reset() {
      if (V('keep')) return;
      // the host starts the ground again and counts a new round; every other copy follows when it sees the new round
      // number (in the shared state or on the next edit), never on its own (its reset may come after the new round's
      // first edits have arrived)
      if (ctx.host) { if (log.length) { log.length = 0; round++; T?.reset(); } groundRound = round; if (S) { S.r = round; S.n = 0; } }
    },
    update(dt) {
      if (!T) return;
      if (shake > 0 && ctx.camera) { shake = Math.max(0, shake - dt * 1.4); ctx.camera.position.x += (Math.random() - 0.5) * shake; ctx.camera.position.y += (Math.random() - 0.5) * shake; }
      if (ctx.host || !S) return;
      // a copy that is not the host: a new round on the host starts the ground again; edits it lacks are asked for
      const R = S.r ?? 0, n = S.n ?? 0;
      if (R !== feed.round) freshGround(R);
      if (n > feed.next && ctx.time.now - askedAt > 1.5) { askedAt = ctx.time.now; stats.asked++; ctx.net.send('carve:want', { r: R, from: feed.next }, 'host'); }
    },
    event(name, d, from) {
      if (!T || !d) return;
      if (name === 'e' && !ctx.host && Number.isInteger(d.i) && Array.isArray(d.e)) {
        if (d.r !== feed.round) freshGround(d.r);
        const t = feed.take(d.r, d.i, d.e);
        if (t === 'apply') applied(d.e, { live: true });
        else if (t === 'gap' && ctx.time.now - askedAt > 0.3) { askedAt = ctx.time.now; stats.asked++; ctx.net.send('carve:want', { r: d.r, from: feed.next }, 'host'); }
      } else if (name === 's' && !ctx.host && Array.isArray(d.p) && d.p.length === 3 && d.p.every(Number.isFinite) && Number.isFinite(d.r)) {
        splashAt({ x: d.p[0], y: d.p[1], z: d.p[2] }, Math.min(V('maxRadius'), Math.max(0, d.r)));
      } else if (name === 'want' && ctx.host && Number.isInteger(d.from) && d.r === round) {
        for (const [start, l] of chunksOf(log.slice(Math.max(0, d.from)), Math.max(0, d.from))) { ctx.net.send('carve:log', { r: round, from: start, l }, from); stats.logsSent++; }
      } else if (name === 'log' && !ctx.host && Number.isInteger(d.from) && Array.isArray(d.l)) {
        if (d.r !== feed.round) freshGround(d.r);
        for (const e of feed.takeLog(d.r, d.from, d.l)) { applied(e, { live: false }); stats.caughtUp++; }
      }
    },
    hostChanged(isHost) {
      // a world's handoff: the new host's log is what it applied, in order
      if (isHost) { log.length = 0; for (const e of T?.edits ?? []) log.push(e.slice()); round = feed.round; if (S) { S.r = round; S.n = log.length; } }
    },
    /** The streamer's key frame: the round and every edit of it (a viewer tuning in rebuilds the same ground). */
    watchKey() { return T ? { r: ctx.host ? round : feed.round, l: ctx.host ? log.slice() : (T.edits ?? []).slice() } : null; },
    watchStart(d) {
      if (!T || !d || !Array.isArray(d.l)) return;
      T.reset(); groundRound = d.r; feed.reset(d.r);
      for (const e of feed.takeLog(d.r, 0, d.l)) applied(e, { live: false });
    },
    /** QA: what this copy holds. */
    observe: () => ({ round: ctx.host ? round : feed.round, applied: ctx.host ? log.length : feed.next, host: !!ctx.host, stats: { ...stats }, terrain: T?.stats?.() ?? null }),
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs MANIFEST lists the fields). The tools read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, examples, params,
  describe: 'Explosions carve smooth craters in the terrain world; the host keeps the ground the same everywhere',
  rank: 34,
  needs: { parts: [], world: [{ id: 'terrain', why: 'it edits the smooth terrain\'s field (config/world.json template "terrain")' }] },
  uses: ['projectile'],
  owns: () => [],
  state: { key: 'carve', fields: { r: 'the host\'s round count (a new round starts the ground again)', n: 'how many edits the host has made this round' } },
  events: [
    { name: 'onCarve', on: 'every copy', args: '{ op: \'carve\' | \'add\', at: {x, y, z}, r, normal, live, by }', when: 'the ground changed here (live: false while a late copy catches up)' },
  ],
  sync: { owner: 'host', how: 'the host makes every edit and numbers it; every copy applies them in order on the same generated ground; a copy missing some asks the host for them' },
  note: [
    'With the projectile mechanic every shot with a splash (splashRadius > 0) carves where it ends by itself (fromProjectile); otherwise the host calls carve.carve({ x, y, z }, r).',
    'Players fall when the ground under them goes, and into the sea past the land: the rules decide what the sea does (world.seaLevel).',
  ],
  stub: {
    as: 'carve',
    worked: 'carve.onCarve(c => { if (c.live) ctx.audio.play(\'explosion-small\', { at: c.at, optional: true }); });',
    traps: ['carve.carve and carve.add change the ground on the host only: keep them under if (ctx.host)'],
  },
  signs: {
    sample: sh => (sh.carve ? { carve: `${sh.carve.r}:${sh.carve.n}` } : null),
    judge: v => {
      const seen = new Set();
      for (const p of v.pages ?? []) for (const s of p.samples ?? []) if (s.sh?.carve !== undefined) seen.add(String(s.sh.carve));
      const ok = seen.size > 1;
      v.add('the ground is carved', ok ? 'ok' : 'dead', 'shared.carve.n', ok ? 'yes' : `no crater was made on any page (${v.names})`, ok ? '' : 'check that shots have a splashRadius and land on the ground (or rules call carve.carve)');
    },
  },
};
