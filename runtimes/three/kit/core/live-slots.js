// gf-three live slots (open builder wave 10, track I; the editors' request 5): while a person edits a game in the
// studio page, a value slot changes in the running game without a reload.
//
//   frame.contentWindow.postMessage({ type: 'gf:slot', id, value }, '*')     from the page hosting the game
//   ← { type: 'gf:slot-applied', id, ok, live, problems }                    to that page
//
//   ok        the value fits the slot (its type and range; a table of items: every entry fits what its mechanic says
//             one is) and is now the game's, in memory. The file on disk is the page's to write (its slot route).
//   live      'taken'    a part said it took it at once (melee: a weapon's numbers, for its next swing)
//             'reload'   a part said it cannot take it while running: the page reloads the game to show it
//             'on-use'   no part claimed it: everything that reads the slot through assets.value() at the moment it uses
//                        it (most numbers: a pickup's value, a dash's cooldown) sees it from now on; something built once
//                        at the start (a model, a stand-in's colour, the world) shows it after a reload
//
// Dev only. A game listens only where a person is building it: when its page is served from this machine (localhost,
// 127.0.0.1, [::1]) or the page asks with ?gf-dev=1, and never in a live round with friends (the host's copy owns the
// shared world). Only the window hosting the game (an ancestor) or the game itself is heard.
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function devAllowed(win = globalThis) {
  try {
    const q = new URLSearchParams(win.location?.search ?? '');
    return q.get('gf-dev') === '1' || LOCAL.has(win.location?.hostname ?? '');
  } catch { return false; }
}

function ancestors(win) {
  const out = [];
  try { let w = win; for (let i = 0; i < 8 && w.parent && w.parent !== w; i++) { out.push(w.parent); w = w.parent; } } catch {}
  return out;
}

/** Put one value in; ask each part whether it took it. → { ok, live, problems } */
export function applySlot(ctx, id, value) {
  const r = ctx.assets.setValue(id, value);
  if (!r.ok) return { ok: false, live: null, problems: r.problems };
  let live = 'on-use';
  for (const m of ctx.mechanics?.list?.() ?? []) {
    if (m.standin || typeof m.slotChanged !== 'function') continue;
    let said; try { said = m.slotChanged(id, value); } catch (e) { console.error(e); said = 'reload'; }
    if (said === 'reload') live = 'reload';
    else if (said === 'live' && live !== 'reload') live = 'taken';
  }
  return { ok: true, live, problems: [] };
}

/** Listen for the page's slot messages (boot calls it once the mechanics exist). net: the session's net (a live
 *  round with friends is never changed from one page). → stop() */
export function listenForSlots(ctx, { win = globalThis, net = null } = {}) {
  if (!win?.addEventListener || !devAllowed(win)) return () => {};
  const onMessage = e => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.type !== 'gf:slot' || typeof d.id !== 'string') return;
    if (e.source !== win && !ancestors(win).includes(e.source)) return;
    const answer = net?.active ? { ok: false, live: null, problems: ['a round with friends is running: the value is written and shows after a reload'] } : applySlot(ctx, d.id, d.value);
    try { (e.source ?? win).postMessage({ type: 'gf:slot-applied', id: d.id, ...answer }, '*'); } catch {}
  };
  win.addEventListener('message', onMessage);
  return () => win.removeEventListener('message', onMessage);
}
