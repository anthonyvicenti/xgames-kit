// gf-three looks: each player's loadout (CONTRACT §6e), from the page to the game, and from each player's copy to
// every other copy.
//
// The page hands this player's loadout to the game, before boot or at any time:
//   window.__GF_LOADOUT = { values: {...}, files: {...} }          (same-origin hosts; a later assignment applies too)
//   frame.contentWindow.postMessage({ type: 'gf:loadout', loadout }, '*')   (the play page, from any ancestor window;
//                                     the game answers { type: 'gf:loadout-applied', key, dropped } to the sender, and
//                                     says { type: 'gf:loadout-ready', v: 1 } to its ancestors once it listens)
//   ?gf-loadout=<base64url JSON>                                     (QA only)
//
// Over the net (gf-multiplayer, through the kit's own events): the owner's pose carries its loadout's key (`lk`, 8 hex
// digits; nothing when it has none). A copy that holds a different key for that player asks the owner ('lq', at most
// every 1.5 s per player) and the owner answers with the loadout ('lo', one message, under 3 KB). A change is also sent
// to everyone at once (at most twice a second). So a late or reloaded copy gets everyone's loadouts from their poses,
// and a lost message is asked for again. Bots wear the game's defaults. Phase 1 trusts each client (wallet decision
// 2026-10-07); a signed, session-bound pass may later travel in the loadout's `pass` field.
import { decodeLoadout } from '../assets/loadout.js';

let installed = false, latest, from = null, replyTo = null;
const subs = [];

function ancestors(win) {
  const out = [];
  try { let w = win; for (let i = 0; i < 8 && w.parent && w.parent !== w; i++) { out.push(w.parent); w = w.parent; } } catch {}
  return out;
}
function take(raw, how, reply = null) {
  latest = raw; from = how; replyTo = reply;
  for (const fn of subs.slice()) { try { fn(raw, how, reply); } catch (e) { console.error(e); } }
}

/** Listen for the page's loadout (boot calls this first, so nothing the page sends early is missed). */
export function listenForLoadout(win = globalThis) {
  if (installed || !win) return; installed = true;
  const q = new URLSearchParams(win.location?.search ?? '');
  if (win.__GF_LOADOUT !== undefined && win.__GF_LOADOUT !== null) take(win.__GF_LOADOUT, 'window');
  else if (q.get('gf-loadout')) take(decodeLoadout(q.get('gf-loadout')), 'url');
  // a same-origin host may assign it again later
  try { Object.defineProperty(win, '__GF_LOADOUT', { configurable: true, get: () => latest, set: v => take(v, 'window') }); } catch {}
  win.addEventListener?.('message', e => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.type !== 'gf:loadout') return;
    if (e.source !== win && !ancestors(win).includes(e.source)) return;     // only the page hosting the game (or itself)
    take(d.loadout ?? null, 'message', e.source);
  });
  for (const w of ancestors(win)) { try { w.postMessage({ type: 'gf:loadout-ready', v: 1 }, '*'); } catch {} }
}
/** The page's latest loadout for this player: { loadout (undefined when none was given), from: 'window'|'url'|'message' }. */
export const pageLoadout = () => ({ loadout: latest, from });
/** fn(loadout, from, replyTo) each time the page hands a loadout after this call (a preview subject's try-on). → stop() */
export function onPageLoadout(fn) { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; }

/**
 * The session's side: this player's loadout and everyone else's. live: a live round (net.active).
 * → { key, apply(raw), tick(dt), start(), observe() }
 */
export function createLooks(ctx, { live, net, localId }) {
  const A = ctx.assets;
  let key = '', lastAll = -1e9, timer = null, acc = 0, source = null;
  const asked = new Map();
  const now = () => (globalThis.performance?.now?.() ?? Date.now());
  const payload = () => ({ k: key, l: key ? A.loadout(localId)?.loadout ?? null : null });
  function sendAll() {
    if (!live) return;
    const t = now();
    if (t - lastAll < 500) { if (!timer) timer = setTimeout(() => { timer = null; sendAll(); }, 500 - (t - lastAll)); return; }
    lastAll = t;
    net.send('lo', payload(), 'all');
  }
  /** This player's loadout from the page (or null to wear the game's). → { key, loadout, dropped, changed } */
  function apply(raw, how = null, reply = null) {
    const r = A.setLoadout(localId, raw ?? null);
    key = r.key; source = how ?? source;
    if (r.dropped.length) console.warn(`gf-three loadout: dropped ${r.dropped.map(d => `${d.slot ?? 'loadout'} (${d.why})`).join('; ')}`);
    if (reply) { try { reply.postMessage({ type: 'gf:loadout-applied', key: r.key, dropped: r.dropped }, '*'); } catch {} }
    if (r.changed) sendAll();
    return r;
  }
  if (live) {
    net.on('lo', (d, who) => {
      if (!who || who === localId || !d || typeof d !== 'object') return;
      if (ctx.players?.get(who)?.isBot) return;
      A.setLoadout(who, d.l ?? null, { key: typeof d.k === 'string' ? d.k : null });
    });
    net.on('lq', (d, who) => { if (who && who !== localId) net.send('lo', payload(), who); });
  }
  subs.push((raw, how, reply) => apply(raw, how, reply));
  if (latest !== undefined) apply(latest, from, replyTo);

  return {
    get key() { return key; },
    apply,
    /** A live round began: tell everyone (they would also ask, from the pose's key). */
    start() { if (key) { lastAll = -1e9; sendAll(); } },
    /** Every frame (cheap): each friend's advertised key against the one this copy holds; ask the owner when they differ. */
    tick(dt) {
      if (!live || (acc += dt) < 0.25) return;
      acc = 0;
      const t = now();
      for (const peer of net.peers()) {
        if (!peer.state || peer.id === localId) continue;
        const lk = typeof peer.state.lk === 'string' ? peer.state.lk : '';
        if (lk === (A.loadout(peer.id)?.advertised ?? '')) continue;
        if (!lk) { A.setLoadout(peer.id, null); continue; }
        if (t - (asked.get(peer.id) ?? -1e9) < 1500) continue;
        asked.set(peer.id, t);
        net.send('lq', { k: lk }, peer.id);
      }
    },
    /** Watch then play (gf-multiplayer 1.6.0): everyone's looks this copy holds, for a stream's key frame. */
    watchKey() {
      const out = {};
      for (const p of ctx.players?.humans?.() ?? []) {
        const r = A.loadout(p.id); if (!r || !r.key) continue;
        out[p.id] = { k: r.advertised || r.key, l: r.loadout };
      }
      return Object.keys(out).length ? out : null;
    },
    /** A viewer: put on the looks a stream's key frame carried (asking would go nowhere: a viewer sends nothing). */
    watchTake(all) {
      if (!all || typeof all !== 'object') return;
      for (const [id, x] of Object.entries(all)) {
        if (id === localId || !x || typeof x !== 'object') continue;
        try { A.setLoadout(id, x.l ?? null, { key: typeof x.k === 'string' ? x.k : null }); } catch (e) { console.warn(`gf-three loadout: ${id}: ${e.message}`); }
      }
    },
    observe: () => ({ key, from: source }),
  };
}
