// mechanic: tag (track K2). Roles that pass between players on contact: tag, infection, hide and seek. The host decides
// every tag; everyone draws a marker over whoever is "it". README.md has ownership and API.
//
//   const tag = ctx.mechanics.get('tag');
//   tag.onTag(({ from, to }) => { to.score -= 1; });         // host only
//   update(ctx) { if (ctx.host) for (const b of ctx.players.bots()) tag.botStep(b); }
import * as THREE from 'three';
import { closestApproach, createRoles, botGoal } from './logic.js';

export const id = 'tag';
export const examples = ['tag: whoever is it chases', 'infection: tagged players join the chasers', 'hide and seek with a head start'];

const D = { its: 1, mode: 'swap', radius: 1.0, cooldown: 1.5, hideSeconds: 0, color: '#ff4d4d', prop: '', markerSize: 0.5, toast: true, toastText: '{name} is it!', soundTag: 'bonk', knock: 0 };
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    its: { type: 'integer', minimum: 1, maximum: 4, default: D.its, description: 'Players who start as "it" (picked at random by the host)' },
    mode: { type: 'string', enum: ['swap', 'infect'], default: D.mode, description: 'swap: a tag passes the role on; infect: the tagged player becomes "it" too' },
    radius: { ...num('Contact distance in metres', 0.3, 4), default: D.radius },
    cooldown: { ...num('Seconds before a tag can be tagged back, or the victim again', 0, 10), default: D.cooldown },
    hideSeconds: { ...num('Head start for the hiders: the "it"s are held still this long at the start (hide and seek)', 0, 60), default: D.hideSeconds },
    color: { type: 'string', default: D.color, description: 'Colour of the marker over the "it"s' },
    prop: { type: 'string', default: D.prop, description: 'Prop slot hovering over the "it"s ("": a cone marker)' },
    markerSize: { ...num('Marker size in metres', 0.1, 2), default: D.markerSize },
    toast: { type: 'boolean', default: D.toast, description: 'Show a line when someone becomes "it"' },
    toastText: { type: 'string', default: D.toastText, description: 'That line; {name} is the new "it"' },
    soundTag: { type: 'string', default: D.soundTag, description: 'Sound id when someone is tagged' },
    knock: { ...num('Knock the victim gets from a tag (m/s, 0: none)', 0, 20), default: D.knock },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.tag.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : type === 'text' ? 'text' : 'gameplay', ...extra });
export const slots = [
  vs('its', 'Players who start as it', 'integer', { tier: 'main', rank: 54, constraints: { min: 1, max: 4 } }),
  vs('radius', 'Tag distance', 'number', { tier: 'main', rank: 50, constraints: { min: 0.3, max: 4, unit: 'm' } }),
  vs('color', 'It marker colour', 'color', { tier: 'main', rank: 48 }),
  vs('cooldown', 'Tag-back delay', 'number', { rank: 40, constraints: { min: 0, max: 10, unit: 's' } }),
  vs('hideSeconds', 'Hide head start', 'number', { rank: 36, constraints: { min: 0, max: 60, unit: 's' } }),
  vs('toastText', 'New it text', 'text', { constraints: { maxLength: 40 } }),
  vs('markerSize', 'Marker size', 'number', { constraints: { min: 0.1, max: 2, unit: 'm' } }),
  vs('prop', 'Marker prop', 'text', { constraints: { maxLength: 40 } }),
  vs('knock', 'Tag knock', 'number', { constraints: { min: 0, max: 20, unit: 'm/s' } }),
  vs('soundTag', 'Tag sound id', 'text', { constraints: { maxLength: 40 } }),
];

const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.tag.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const roles = createRoles({ mode: V('mode'), cooldown: V('cooldown') });
  const L = { tag: [] };
  const root = new THREE.Group(); root.name = 'gf-tag'; ctx.scene.add(root);
  const markers = new Map();        // player id → Object3D
  const lastPos = new Map();
  let S = null, picked = false, hideLeft = 0, lastIts = '', lastHide = false, tmpl = null, loading = false, t0 = 0, tAcc = 0;
  const now = () => ctx.time.now;
  const list = () => ctx.players.list();
  const itIds = () => (ctx.host ? [...roles.its] : (S?.t ?? []));

  async function loadTemplate() {
    if (loading) return; loading = true;
    try { if (V('prop') && ctx.assets.has(`prop.${V('prop')}`)) tmpl = await ctx.assets.model(`prop.${V('prop')}`, { fit: V('markerSize') }); } catch (e) { console.warn('tag: marker prop failed', e); }
    if (!tmpl) {
      const m = ctx.modules?.look?.material?.('glow', { tint: V('color') }) ?? new THREE.MeshStandardMaterial({ color: V('color'), emissive: V('color'), emissiveIntensity: 0.6 });
      const mesh = new THREE.Mesh(new THREE.ConeGeometry(V('markerSize') * 0.4, V('markerSize'), 14).rotateX(Math.PI), m);
      ctx.assets.tag(mesh, 'mechanic.tag.color'); tmpl = mesh;
    }
    loading = false;
  }
  function setControl(p, on) { if (p.owned && p.controller) p.controller.enabled = on && ctx.round?.phase === 'playing'; }
  function doTag(from, to) {
    if (!roles.tag(from.id, to.id, now())) return false;
    ctx.net.send('tag:fx', { f: from.id, t: to.id }, 'all');
    fx(to);
    if (V('knock') > 0) { const dx = to.position.x - from.position.x, dz = to.position.z - from.position.z, l = Math.hypot(dx, dz) || 1; to.knock?.({ x: dx / l * V('knock'), y: 2, z: dz / l * V('knock') }, 0.6); }
    for (const fn of L.tag.slice()) try { fn({ from, to }); } catch (e) { console.error(e); }
    return true;
  }
  const fx = to => { if (V('soundTag')) ctx.audio?.play(V('soundTag'), { at: to.position, optional: true }); };

  const api = {
    id, params: P,
    /** Every copy: is this player "it"? */
    isIt: p => !!p && itIds().includes(p.id),
    /** Every copy: the players who are "it". */
    its: () => list().filter(p => itIds().includes(p.id)),
    /** Every copy: the players who are not "it" (in infect mode these are the survivors). */
    notIt: () => list().filter(p => !itIds().includes(p.id)),
    /** Every copy: seconds a player has spent as "it" (updated about twice a second). */
    itTime(p) { return (ctx.host ? roles.time.get(p.id) : S?.ti?.[p.id]) ?? 0; },
    /**
     * Every copy: whole seconds a player has spent as "it", for a score shown while the round runs. A score is the
     * host's and travels to the other copies a few times a second: a fraction that moves every frame is never the
     * same number on two screens at once (the two-player gate compares them), a whole second is.
     */
    itSeconds(p) { return Math.floor(api.itTime(p) + 1e-6); },
    /** Every copy: the hide head start is still running. */
    hiding: () => (ctx.host ? hideLeft > 0 : (S?.h ?? 0) > 0),
    /** Host: make someone "it", or not. */
    makeIt(p) { if (ctx.host) roles.make(p.id); },
    clearIt(p) { if (ctx.host) roles.clear(p.id); },
    /** Host: a tag from → to (the contact test calls this; rules may too). → true when it counted */
    tag: (from, to) => ctx.host && S && doTag(from, to),
    /** Host: {from, to} on every tag. → unsubscribe */
    onTag(fn) { L.tag.push(fn); return unsub(L.tag, fn); },
    /** Host, for bots: seek the nearest non-it when "it", else flee from the nearest it. Call from rules.bot. */
    botStep(b) {
      if (!b.bot) return;
      if (this.hiding() && this.isIt(b)) { b.bot.stop(); return; }
      const g = botGoal({ id: b.id, x: b.position.x, z: b.position.z }, list().map(o => ({ id: o.id, x: o.position.x, z: o.position.z })), id => itIds().includes(id));
      if (!g) { b.bot.wander(); return; }
      if (g.mode === 'seek') b.bot.seek(g.target, { stop: 0.3 }); else if (g.dist < 9) b.bot.flee(g.target); else b.bot.wander();
    },
    reset() { roles.reset(); picked = false; hideLeft = 0; lastIts = ''; lastHide = false; markers.forEach(m => m.removeFromParent()); markers.clear(); lastPos.clear(); },
    update(dt) {
      if (!S) { if (!(ctx.shared && ctx.players && ctx.me)) return; S = ctx.shared.register('tag', { t: [], h: 0, ti: {} }); loadTemplate(); }
      if (!tmpl && !loading) loadTemplate();
      t0 += dt;
      const playing = ctx.round?.phase === 'playing';
      if (ctx.host) {
        if (playing && !picked && list().length) {
          picked = true; roles.pick(list().map(p => p.id), Math.min(V('its'), Math.max(1, list().length - 1)), () => ctx.rng()); hideLeft = V('hideSeconds');
        }
        if (playing && picked) {
          if (hideLeft > 0) hideLeft = Math.max(0, hideLeft - dt);
          else {
            roles.tick(dt);
            const ps = list().filter(p => p.alive !== false);
            for (const a of ps) {
              if (!roles.isIt(a.id)) continue;
              for (const b of ps) {
                if (a === b || roles.isIt(b.id)) continue;
                const a1 = { x: a.position.x, z: a.position.z }, b1 = { x: b.position.x, z: b.position.z };
                const a0 = lastPos.get(a.id) ?? a1, b0 = lastPos.get(b.id) ?? b1;
                if (closestApproach(a0, a1, b0, b1) <= V('radius')) doTag(a, b);
              }
            }
          }
          for (const p of list()) lastPos.set(p.id, { x: p.position.x, z: p.position.z });
        }
        for (const id of [...roles.its]) if (!ctx.players.get(id)) { roles.clear(id); if (!roles.its.size && list().length > 1) roles.make(list()[0].id); }   // the "it" left: someone else is
        S.t = [...roles.its]; S.h = Math.ceil(hideLeft);
        if ((tAcc += dt) >= 0.5) { tAcc = 0; S.ti = Object.fromEntries([...roles.time].map(([k, v]) => [k, Math.round(v * 10) / 10])); }
      }
      // every copy: markers, the toast on the edge of a new "it", and held still while hiding
      const ids = itIds(), key = ids.join(',');
      if (key !== lastIts) {
        if (V('toast') && playing) for (const id of ids) if (!lastIts.split(',').includes(id)) { const p = ctx.players.get(id); if (p) ctx.ui?.toast(V('toastText').replace('{name}', p.name)); }
        lastIts = key;
      }
      const hide = api.hiding();
      if (hide !== lastHide) { lastHide = hide; for (const p of ctx.players.owned()) if (ids.includes(p.id)) setControl(p, !hide); }
      else if (hide) for (const p of ctx.players.owned()) if (ids.includes(p.id) && p.controller?.enabled) setControl(p, false);
      for (const [id, m] of markers) if (!ids.includes(id) || !ctx.players.get(id)) { m.removeFromParent(); markers.delete(id); }
      if (tmpl) for (const id of ids) {
        const p = ctx.players.get(id); if (!p) continue;
        let m = markers.get(id); if (!m) { m = tmpl.clone(true); root.add(m); markers.set(id, m); }
        const h = p.character?.height ?? 1.7;
        m.visible = p.owned ? !p.local || true : p.drawn !== false;
        m.position.set(p.position.x, p.position.y + h + 0.45 + Math.sin(t0 * 3) * 0.06, p.position.z); m.rotation.y = t0 * 2;
      }
    },
    /** `tag:fx` (the host tells everyone a tag happened: the sound). */
    event(name, d) { if (name === 'fx' && !ctx.host) { const p = ctx.players.get(d?.t); if (p) fx(p); } },
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
  describe: 'Roles that pass between players on contact, hide and seek',
  rank: 90,
  needs: { parts: [], world: [] },
  uses: [],
  owns: p => (p.hideSeconds > 0 ? [{ res: 'player.control', why: 'whoever is it stands still for hideSeconds (params.hideSeconds)', free: 'set tag params.hideSeconds to 0' }] : []),
  // what a score in time as it follows: each player's whole seconds as it; verify gate D counts a change of it as a
  // counted event (kit/core/events.js samples it)
  counters: (api, ctx) => ctx.players.list().map(p => [p.id, api.itSeconds(p)]),
  state: { key: 'tag', fields: { t: 'ids of the players who are it', h: 'hide seconds left', ti: '{ playerId: seconds spent as it }' } },
  events: [
    { name: 'onTag', on: 'host', args: '{ from, to }', when: 'a tag counted' },
  ],
  sync: { owner: 'host', how: 'the host decides every tag, the cooldowns and the hide timer' },
  note: [
    'The kit picks who is it at round start, judges contact, and draws the marker over them: mode "swap" passes it on, "infect" adds to the its.',
    'tag.isIt(p), tag.its() and tag.notIt() are the same on every copy. A score in time as it: p.score = tag.itSeconds(p) (whole seconds, set on the host in update), never tag.itTime(p), a fraction that differs on every screen.',
    'hideSeconds > 0 is hide and seek: the it waits that long before chasing.',
  ],
  stub: {
    as: 'tag',
    worked: 'update(ctx) { if (ctx.host) for (const p of ctx.players.list()) p.score = tag.itSeconds(p); }',
    traps: [
      'a score that is a running time must be whole seconds (tag.itSeconds): with tag.itTime(p) as the score the two screens never show the same number and verify check 5 fails on "the-shared-world-matches"',
      'bots neither chase nor flee unless the rules steer them: in bot(ctx, p) call tag.botStep(p)',
      'with mode "infect", end the round in check(ctx) when tag.notIt().length === 0, or the last runner is chased until the clock runs out',
    ],
  },
  signs: {
    sample: sh => (sh.tag ? { tag: sh.tag.t ?? [] } : null),
    judge: v => {
      const ok = v.others.it;
      v.add('someone is it', ok ? 'ok' : 'dead', 'shared.tag.t', ok ? 'yes' + (v.others.itPassed ? ', and it passed on' : '') : `nobody was it on any page (${v.names})`, ok ? '' : 'tag makes an it at round start unless rules clear it');
    },
  },
};
