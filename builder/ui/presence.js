// gf-three ui: how a friend is seen when the players are not characters (gf/mp/presence.js has the shapes and the
// state each copy keeps and sends; builder/multiplayer/STANDARD.md, "Seeing a friend with no character"). A DOM layer
// over the canvas, like the rest of the HUD (text, colours and one picture slot, ui.avatar).
//
//   seats   a card for every player down the left edge: their avatar (the ui.avatar picture on a disc of their colour)
//           that reacts (waiting, thinking on their turn, placed just after a move, won, lost, away), their name and a
//           word for the mood; their pointer over the board (drawn here unless the part that holds the board draws its
//           own mark, as the board mechanic does); a ring in their colour where each of their moves lands, on every
//           screen, and their card pulses
//   boards  each friend's own board live down the right edge, framed in their colour, their avatar on its rim, their
//           name and score, their pointer and their last move on it; your own card at the left
//
// What each player's entry holds comes from three places, the later winning: the presence state (what a copy sent of
// its own player), a part's feed (presenceFeed(p) on a mechanic: what the shared state says, such as the board's turn
// and the moves each seat made), and the player list (name, colour, connected).
//
//   const view = createPresenceView(ctx, ui, { shape, model, text, avatar });   view.frame(dt); view.observe()
const CSS = `
#gf-ui .gf-pres{position:absolute;inset:0;pointer-events:none}
#gf-ui .gf-seats{position:absolute;left:10px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:8px}
#gf-ui .gf-seat{display:flex;align-items:center;gap:8px;min-width:150px;max-width:210px;padding:6px 10px 6px 6px;border-radius:14px;background:var(--gf-panel,#1c2133cc);box-shadow:inset 0 0 0 2px var(--c),0 3px 12px #0004;transition:transform .18s}
#gf-ui .gf-seat b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#gf-ui .gf-seat small{display:block;font-size:12px;font-weight:600;opacity:.85}
#gf-ui .gf-seat.gf-turn{transform:translateX(6px);box-shadow:inset 0 0 0 3px var(--c),0 0 16px var(--c)}
#gf-ui .gf-seat.gf-away{opacity:.5}
#gf-ui .gf-ava{position:relative;flex:none;width:44px;height:44px;border-radius:50%;background:var(--c);box-shadow:inset 0 -4px 0 #0003}
#gf-ui .gf-ava img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
#gf-ui .gf-ava i{position:absolute;right:-6px;top:-6px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#fff;color:#111;font:800 12px/18px system-ui,sans-serif;font-style:normal;text-align:center;box-shadow:0 1px 3px #0006;display:none}
#gf-ui .gf-m-thinking .gf-ava{animation:gf-think 1.4s ease-in-out infinite}
#gf-ui .gf-m-thinking .gf-ava i{display:block}
#gf-ui .gf-m-placed .gf-ava{animation:gf-hop .5s ease-out}
#gf-ui .gf-m-won .gf-ava,#gf-ui .gf-m-cheer .gf-ava{animation:gf-hop .6s ease-out infinite;box-shadow:0 0 0 3px #ffd23f,0 0 14px #ffd23f}
#gf-ui .gf-m-won .gf-ava i,#gf-ui .gf-m-cheer .gf-ava i,#gf-ui .gf-m-lost .gf-ava i,#gf-ui .gf-m-ouch .gf-ava i,#gf-ui .gf-m-out .gf-ava i{display:block}
#gf-ui .gf-m-lost .gf-ava,#gf-ui .gf-m-out .gf-ava{filter:grayscale(.7) brightness(.8);transform:rotate(-12deg) translateY(3px)}
#gf-ui .gf-m-ouch .gf-ava{animation:gf-shake .4s linear 2}
#gf-ui .gf-moved{animation:gf-pulse .9s ease-out}
@keyframes gf-think{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(7deg)}}
@keyframes gf-hop{0%{transform:translateY(0) scale(1)}35%{transform:translateY(-9px) scale(1.08)}100%{transform:translateY(0) scale(1)}}
@keyframes gf-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
@keyframes gf-pulse{0%{box-shadow:inset 0 0 0 2px var(--c),0 0 0 0 var(--c)}40%{box-shadow:inset 0 0 0 3px var(--c),0 0 0 10px transparent}}
#gf-ui .gf-ptr{position:absolute;left:0;top:0;padding:2px 8px 2px 18px;border-radius:999px;background:var(--c);color:#fff;font-size:12px;font-weight:800;white-space:nowrap;text-shadow:0 1px 0 #0006;will-change:transform}
#gf-ui .gf-ptr::before{content:"";position:absolute;left:4px;top:3px;border-left:8px solid #fff;border-top:6px solid transparent;border-bottom:6px solid transparent;transform:rotate(-35deg)}
#gf-ui .gf-ping{position:absolute;left:0;top:0;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;border:4px solid var(--c);box-shadow:0 0 12px var(--c);animation:gf-ping .9s ease-out forwards}
@keyframes gf-ping{0%{opacity:1;transform:var(--at) scale(.3)}100%{opacity:0;transform:var(--at) scale(1.4)}}
#gf-ui .gf-boards{position:absolute;right:10px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:10px;align-items:flex-end;max-height:calc(100% - 120px)}
#gf-ui .gf-fboard{position:relative;padding:22px 8px 8px;border-radius:14px;background:var(--gf-panel,#1c2133cc);box-shadow:inset 0 0 0 3px var(--c),0 3px 12px #0004}
#gf-ui .gf-fboard canvas{display:block;border-radius:6px}
#gf-ui .gf-fboard .gf-ava{position:absolute;left:-14px;top:-14px;width:38px;height:38px}
#gf-ui .gf-fboard header{position:absolute;left:30px;right:8px;top:3px;display:flex;justify-content:space-between;gap:8px;font-size:13px;white-space:nowrap}
#gf-ui .gf-fboard header b{overflow:hidden;text-overflow:ellipsis}
@media (max-width:640px){#gf-ui .gf-seat{min-width:0;padding:4px}#gf-ui .gf-seat div{display:none}#gf-ui .gf-ava{width:36px;height:36px}#gf-ui .gf-boards{right:6px}}
`;

const DEFAULT_TEXT = { waiting: 'waiting', thinking: 'thinking…', placed: 'placed!', won: 'won!', lost: 'lost', draw: 'draw', away: 'away', cheer: 'nice!', ouch: 'ouch', out: 'out', you: 'you' };
const BADGE = { thinking: '…', won: '★', cheer: '!', lost: '×', ouch: '!', out: '×' };
const MOVED_SECONDS = 1.5;
const mix = (hex, t) => { const n = parseInt(String(hex ?? '#888888').slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (255 - v) * t)); return `rgb(${c.join(',')})`; };

export function createPresenceView(ctx, ui, { shape = 'seats', model, text = {}, avatar = null } = {}) {
  const T = { ...DEFAULT_TEXT, ...Object.fromEntries(Object.entries(text).filter(([, v]) => typeof v === 'string' && v)) };
  if (!document.getElementById('gf-presence-css')) { const st = document.createElement('style'); st.id = 'gf-presence-css'; st.textContent = CSS; document.head.append(st); }
  const root = document.createElement('div'); root.className = 'gf-pres'; root.id = 'gf-presence';
  const seatsEl = document.createElement('div'); seatsEl.className = 'gf-seats';
  const boardsEl = document.createElement('div'); boardsEl.className = 'gf-boards';
  root.append(seatsEl, boardsEl);
  (ui.root ?? document.body).append(root);
  const els = new Map();        // id → { seat, ava, badge, name, mood, ptr, board, canvas, head, score }
  const seen = new Map();       // id → { moves, at, cell, shown, screen }
  let hidden = false;

  const feeds = () => (ctx.mechanicsList ?? []).filter(m => !m.standin && typeof m.presenceFeed === 'function');
  function entryOf(p) {
    let e = { id: p.id, mood: 'waiting', moves: 0, pointer: null, last: null, board: null, score: null, ...(model?.of(p.id) ?? {}) };
    for (const m of feeds()) { try { const f = m.presenceFeed(p); if (f) for (const [k, v] of Object.entries(f)) if (v !== undefined) e[k] = v; } catch (err) { console.error(err); } }
    if (p.connected === false) e.mood = 'away';
    return { ...e, name: p.name ?? '', color: p.color ?? '#888888', local: !!p.local, bot: !!p.isBot, score: e.score ?? p.score ?? null };
  }
  const screenOf = (e, c) => { for (const m of feeds()) { try { const s = m.presenceScreen?.(c, e); if (s) return s; } catch { /* a part without a screen */ } } return null; };
  const marksDrawn = () => feeds().some(m => m.presenceMarks === true);
  const inView = r => r && r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  const rectOf = el => { if (!el || hidden || ui.covered) return null; const r = el.getBoundingClientRect(); return inView(r) ? r : null; };

  function avatarEl() {
    const ava = document.createElement('span'); ava.className = 'gf-ava';
    if (avatar) { const img = document.createElement('img'); img.alt = ''; img.src = avatar; img.draggable = false; ava.append(img); }
    const badge = document.createElement('i'); ava.append(badge);
    return { ava, badge };
  }
  function elsFor(e) {
    let x = els.get(e.id);
    if (x) return x;
    x = {};
    const showCard = shape === 'seats' || e.local;
    if (showCard) {
      x.seat = document.createElement('div'); x.seat.className = 'gf-seat';
      ({ ava: x.ava, badge: x.badge } = avatarEl());
      const words = document.createElement('div'); x.name = document.createElement('b'); x.mood = document.createElement('small'); words.append(x.name, x.mood);
      x.seat.append(x.ava, words); seatsEl.append(x.seat);
    }
    if (shape === 'boards' && !e.local) {
      x.board = document.createElement('div'); x.board.className = 'gf-fboard';
      const a = avatarEl(); x.bAva = a.ava; x.bBadge = a.badge;
      x.head = document.createElement('header'); x.bName = document.createElement('b'); x.score = document.createElement('span'); x.head.append(x.bName, x.score);
      x.canvas = document.createElement('canvas'); x.board.append(x.canvas, a.ava, x.head); boardsEl.append(x.board);
    }
    if (shape === 'seats' && !e.local) { x.ptr = document.createElement('div'); x.ptr.className = 'gf-ptr'; x.ptr.style.display = 'none'; root.append(x.ptr); }
    els.set(e.id, x);
    return x;
  }
  function ping(color, s) {
    const d = document.createElement('div'); d.className = 'gf-ping'; d.style.setProperty('--c', color);
    d.style.setProperty('--at', `translate(${Math.round(s.x)}px,${Math.round(s.y)}px)`); d.style.transform = `translate(${Math.round(s.x)}px,${Math.round(s.y)}px)`;
    root.append(d); setTimeout(() => d.remove(), 950);
  }
  function drawBoard(x, e, flash) {
    const b = e.board; if (!b) { x.canvas.width = 0; return; }
    const px = Math.max(6, Math.min(26, Math.floor(Math.min(190 / b.cols, 230 / b.rows)))), w = b.cols * px, h = b.rows * px;
    if (x.canvas.width !== w || x.canvas.height !== h) { x.canvas.width = w; x.canvas.height = h; x.canvas.style.width = `${w}px`; x.canvas.style.height = `${h}px`; }
    const g = x.canvas.getContext('2d'); if (!g) return;
    g.fillStyle = '#0d1020'; g.fillRect(0, 0, w, h);
    const letters = [...new Set(b.g.replaceAll('.', ''))].sort();
    for (let i = 0; i < b.g.length; i++) {
      const c = i % b.cols, r = Math.floor(i / b.cols), ch = b.g[i];
      g.fillStyle = ch === '.' ? '#ffffff14' : mix(e.color, Math.min(0.5, letters.indexOf(ch) * 0.18));
      g.fillRect(c * px + 1, r * px + 1, px - 2, px - 2);
    }
    if (flash && e.last) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(e.last[0] * px + 1, e.last[1] * px + 1, px - 2, px - 2); }
    if (e.pointer) { g.strokeStyle = mix(e.color, 0.6); g.lineWidth = 2; g.beginPath(); g.arc((e.pointer[0] + 0.5) * px, (e.pointer[1] + 0.5) * px, px * 0.42, 0, Math.PI * 2); g.stroke(); }
  }

  const api = {
    shape,
    frame() {
      hidden = !['playing', 'countdown'].includes(ctx.round?.phase) || root.style.display === 'none';
      root.style.visibility = hidden ? 'hidden' : '';
      const list = ctx.players?.list?.() ?? [], live = new Set(list.map(p => p.id)), now = ctx.time?.now ?? 0, marks = marksDrawn();
      for (const [id, x] of els) if (!live.has(id)) { for (const el of [x.seat, x.board, x.ptr]) el?.remove(); els.delete(id); seen.delete(id); }
      for (const p of list) {
        const e = entryOf(p), x = elsFor(e);
        const was = seen.get(e.id) ?? { moves: e.moves, at: -99, cell: null, shown: false, screen: null };
        let moved = false;
        if (e.moves > was.moves) {
          moved = true; was.at = now; was.cell = e.last; was.shown = false; was.screen = null;
          for (const el of [x.seat, x.board]) if (el) { el.classList.remove('gf-moved'); void el.offsetWidth; el.classList.add('gf-moved'); }
          const s = shape === 'seats' && e.last ? screenOf(e, e.last) : null;
          if (s && s.front !== false && !hidden) { ping(e.color, s); was.shown = true; was.screen = { x: Math.round(s.x), y: Math.round(s.y) }; }
          else if (shape === 'boards' && x.board && !hidden) was.shown = true;
        }
        was.moves = e.moves; seen.set(e.id, was);
        const mood = e.mood === 'waiting' && now - was.at < MOVED_SECONDS && was.at >= 0 ? 'placed' : e.mood;
        e.shownMood = mood;
        const cls = `gf-m-${mood}`;
        for (const [el, badge] of [[x.seat, x.badge], [x.board, x.bBadge]]) {
          if (!el) continue;
          el.style.setProperty('--c', e.color);
          if (!el.classList.contains(cls)) { for (const c of [...el.classList]) if (c.startsWith('gf-m-')) el.classList.remove(c); el.classList.add(cls); }
          el.classList.toggle('gf-turn', mood === 'thinking'); el.classList.toggle('gf-away', mood === 'away');
          if (badge) badge.textContent = BADGE[mood] ?? '';
        }
        if (x.name) { x.name.textContent = e.local ? `${e.name} (${T.you})` : e.name; x.mood.textContent = T[mood] ?? mood; }
        if (x.board) { x.bName.textContent = e.name; x.score.textContent = e.score == null ? '' : String(e.score); drawBoard(x, e, now - was.at < MOVED_SECONDS); }
        if (x.ptr) {
          const s = !marks && e.pointer ? screenOf(e, e.pointer) : null;
          x.ptr.style.display = s && s.front !== false ? '' : 'none';
          if (s) { x.ptr.style.setProperty('--c', e.color); x.ptr.textContent = e.name; x.ptr.style.transform = `translate(${Math.round(s.x)}px,${Math.round(s.y)}px)`; }
        }
        x.last = e;
        if (moved) x.movedAt = now;
      }
    },
    /** What this screen shows of every player (verify gate E, the presence leg of measure 5; the play-tester). */
    observe() {
      const r2 = v => Math.round(v);
      const box = r => (r ? { x: r2(r.left), y: r2(r.top), w: r2(r.width), h: r2(r.height) } : null);
      const now = ctx.time?.now ?? 0, marks = marksDrawn();
      return {
        shape, hidden,
        seats: [...els].map(([id, x]) => {
          const e = x.last ?? { id }, sm = seen.get(id), card = rectOf(x.seat), board = rectOf(x.board);
          // a pointer on a friend's own board is on that board's panel, never on this screen's board
          const ps = e.pointer && shape === 'seats' ? screenOf(e, e.pointer) : null;
          return {
            id, name: e.name ?? null, color: e.color ?? null, local: !!e.local, bot: !!e.bot, mood: e.shownMood ?? e.mood ?? null, moves: e.moves ?? 0, score: e.score ?? null,
            card: card ? { ...box(card), visible: true } : { visible: false },
            avatar: !!(x.ava || x.bAva),
            pointer: e.pointer ? { cell: e.pointer, drawnBy: shape === 'boards' ? 'board panel' : marks ? 'part' : 'presence', onScreen: shape === 'boards' ? !!board || (!!e.local && !hidden) : !!ps && ps.front !== false && !hidden && ps.x >= 0 && ps.y >= 0 && ps.x <= innerWidth && ps.y <= innerHeight, ...(ps ? { x: r2(ps.x), y: r2(ps.y) } : {}) } : null,
            lastMove: sm && sm.at >= 0 ? { n: sm.moves, cell: sm.cell, shown: !!sm.shown, ago: Math.round((now - sm.at) * 10) / 10, ...(sm.screen ? { screen: sm.screen } : {}) } : null,
            board: e.board ? { cols: e.board.cols, rows: e.board.rows, g: e.board.g, ...(x.board ? { panel: board ? { ...box(board), visible: true } : { visible: false } } : {}) } : null,
          };
        }),
      };
    },
    dispose() { root.remove(); },
  };
  return api;
}
