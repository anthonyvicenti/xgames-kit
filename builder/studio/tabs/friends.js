// Play with a friend: a second tab joined to the same room on this machine. (Online play is not offered here yet.)
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) (k in e && k !== 'list') ? (e[k] = v) : e.setAttribute(k, v);
  e.append(...kids.filter(k => k != null));
  return e;
};

/** The room code and who is in, read from the game's own page in the preview (same origin; read only). */
function readRoom(frame) {
  try {
    const w = frame.contentWindow, d = frame.contentDocument;
    const code = (d?.getElementById('mp-code') ?? d?.getElementById('gf-room-code'))?.textContent?.trim() || null;
    let players = null, pcode = null;
    try { const s = w.__party?.snapshot?.(); pcode = s?.code ?? null; players = Array.isArray(s?.racers) ? s.racers.length : null; } catch {}
    const c = pcode || code;
    return { code: c && /^[A-Za-z0-9-]{3,16}$/.test(c) ? c : null, players };
  } catch { return { code: null, players: null }; }
}

export default {
  id: 'friends',
  label: 'Play with a friend',
  order: 30,
  async mount(root, ctx) {
    const lobby = el('button', { type: 'button' }, '1. Host a room in the preview');
    const second = el('a', { className: 'button', target: '_blank', rel: 'noopener', 'aria-disabled': 'true' }, '2. Open a second tab as your friend ↗');
    const code = el('div', { className: 'roomcode', 'aria-live': 'polite' });
    const status = el('p', { className: 'muted' });
    lobby.addEventListener('click', () => ctx.preview.show('/game/gf/mp/'));
    second.addEventListener('click', e => { if (second.getAttribute('aria-disabled') === 'true') { e.preventDefault(); ctx.toast('Host a room first (step 1)', 'error'); } });
    root.append(
      el('p', { className: 'intro' }, ctx.game.multiplayer && ctx.game.multiplayer !== 'live' ? `Multiplayer: ${ctx.game.multiplayer}.` : 'Friends play in one game, in sync, and each sees the others as a character.'),
      el('div', { className: 'toolbar' }, lobby, second), code, status,
      el('p', { className: 'muted small' }, 'This works on this machine only: both tabs talk to the local dev server and play peer to peer. The host\'s tab runs the game, so keep it open.'),
      el('h3', {}, 'Controls'),
      Object.keys(ctx.game.controls ?? {}).length
        ? el('dl', { className: 'controls' }, ...Object.entries(ctx.game.controls).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]))
        : el('p', {}, 'Move with WASD, look with the mouse.'));

    function paint() {
      const r = readRoom(ctx.preview.frame);
      code.replaceChildren();
      if (r.code) {
        code.append(el('span', { className: 'muted small' }, 'Room code'), el('b', {}, r.code));
        second.href = `/game/gf/mp/?join=${encodeURIComponent(r.code)}`;
        second.setAttribute('aria-disabled', 'false');
        status.textContent = r.players && r.players > 1 ? `${r.players} players are in the room.` : 'Waiting for your friend to join. Open the second tab, type a name and press Join.';
      } else {
        second.removeAttribute('href');
        second.setAttribute('aria-disabled', 'true');
        status.textContent = 'No room yet. Press step 1, type a name and press Host.';
      }
    }
    paint();
    const t = setInterval(paint, 1000);
    return () => clearInterval(t);
  },
};
