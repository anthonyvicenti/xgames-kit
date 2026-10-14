// The start page: what the studio opens on when no game is open (`gamesfun dev` with no folder, or "All games").
// Nothing is played here. The person describes a game (the idea goes to their own agent session through the bridge,
// the same queue the conversation uses, and starts the build loop on a fresh folder), opens one of theirs, or starts
// from an example. With no session connected the page says how to connect one; it never calls a model.
import { connection, NONE_HINT, RELOAD_HINT, readQueue } from './lib/session.js';
import { sessionApi } from './lib/session-client.js';
import { ideaRequest } from './chat.js';

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'on') { for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); continue; }
    (k in e && k !== 'list' && !k.startsWith('aria-') && !k.startsWith('data-')) ? (e[k] = v) : e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter(k => k != null && k !== false));
  return e;
};

/** A few ideas to start from, one tap each: they fill the box, the person still presses Make it. */
export const IDEAS = [
  'A pillow fight in a backyard with my friends',
  'Four in a row on a giant board, we take turns',
  'A side-on platformer where we race to grab coins',
  'Tag in a haunted house: one ghost, everyone else hides',
  'Bumper boats in a pool, last one floating wins',
];

const STEP_WORDS = { 'waiting-on-creator': 'waiting for your pick', building: 'being made', delivered: 'ready', failed: 'stopped', cancelled: 'rolled back' };

export function mountStart(root, ctx) {
  const box = el('textarea', { id: 'start-input', rows: 3, maxLength: 2000, placeholder: 'Describe your game…', 'aria-label': 'Describe your game' });
  const go = el('button', { id: 'start-go', type: 'button' }, 'Make it');
  const note = el('div', { className: 'start-note small', 'aria-live': 'polite' });
  const session = el('div', { className: 'start-session small', 'data-part': 'session' });
  const chips = el('div', { className: 'start-ideas', role: 'group', 'aria-label': 'Ideas to start from' },
    ...IDEAS.map(t => el('button', { type: 'button', className: 'idea', on: { click: () => { box.value = t; box.focus(); } } }, t)));
  const mine = el('div', { className: 'start-games' });
  const examples = el('div', { className: 'start-examples' });

  root.replaceChildren(el('div', { className: 'start-inner' },
    el('div', { className: 'start-hero' },
      el('h1', {}, 'What do you want to ', el('span', {}, 'make'), '?'),
      el('p', { className: 'start-lede' }, 'Describe a game in your own words. Your agent session pitches a few takes, you pick one, and it builds it here: a multiplayer game your friends play from their browser.'),
      el('div', { className: 'start-box' }, box, el('div', { className: 'start-box-row' }, session, go)),
      note, chips),
    el('section', { className: 'start-section', 'aria-labelledby': 'start-mine' }, el('h2', { id: 'start-mine' }, 'Your games'), mine),
    el('section', { className: 'start-section', 'aria-labelledby': 'start-ex' }, el('h2', { id: 'start-ex' }, 'Start from an example'), el('p', { className: 'muted small' }, 'A finished game made with the kit, copied into games/ for you to change.'), examples)));

  async function make() {
    const idea = box.value.trim();
    if (!idea) { box.focus(); note.textContent = 'Say what the game is first: a sentence is plenty.'; return; }
    go.disabled = true; note.textContent = '';
    try {
      const p = await ctx.api('studio/new', { idea });
      const r = await sessionApi('request', { text: ideaRequest(idea, `games/${p.name}`) });
      // say only what is true now: handed to a session that listens, or waiting for one
      ctx.toast(r.state === 'handed' ? 'Handed to your session: it starts with a pitch' : r.session ? 'Saved: your session gets it when it listens again' : 'Saved: no session is listening yet, so nothing is being made. It waits for your session', r.state === 'handed' ? 'ok' : '');
      box.value = '';
      await ctx.open(p.project);
    } catch (e) { note.textContent = `Not sent: ${e.message}`; }
    finally { go.disabled = false; }
  }
  go.addEventListener('click', make);
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey)) { e.preventDefault(); make(); } });

  async function openGame(name) {
    try { const r = await ctx.api('studio/project', { name }); await ctx.open(r.project); } catch (e) { ctx.toast(e.message, 'error'); }
  }
  async function fromExample(ex, btn) {
    btn.disabled = true; btn.textContent = 'Making a copy…';
    try { const r = await ctx.api('studio/example', { example: ex.id }); ctx.toast(`Made games/${r.name} from ${ex.title}`, 'ok'); await ctx.open(r.project); }
    catch (e) { ctx.toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Start from this'; }
  }

  let setup = null;
  async function paintSession() {
    let q = null;
    try { q = await sessionApi('queue'); } catch { /* no bridge */ }
    const c = connection(readQueue(q));
    const hint = c.state === 'none' && setup?.connected && setup.plugin ? RELOAD_HINT : c.hint;
    const words = { none: 'No session is listening yet. ', listening: 'Your session is listening: what you send reaches it at once. ', working: 'Your session is working. ', idle: 'Your session is connected but not listening. ', stalled: 'Waiting for your session. ' }[c.state];
    session.dataset.state = c.state;
    session.replaceChildren(el('span', { className: `dot ${c.state === 'none' ? 'wait' : c.state === 'idle' || c.state === 'stalled' ? 'warn' : 'ok'}` }),
      el('span', {}, el('b', {}, words), c.state === 'listening' && !c.hint.startsWith('Its') ? '' : hint, c.toolsNote ? ` ${c.toolsNote}` : ''));
  }
  async function paint() {
    let home;
    try { home = await ctx.api('studio/home'); } catch (e) { mine.replaceChildren(el('p', { className: 'error-box' }, e.message)); return; }
    setup = home.setup;
    mine.replaceChildren(...(home.games.length ? [el('div', { className: 'game-list' }, ...home.games.map(g => el('button', { type: 'button', className: 'game-card', 'data-game': g.name, on: { click: () => openGame(g.name) } },
      el('span', { className: 'game-card-title' }, g.title), g.hook ? el('span', { className: 'game-card-hook' }, g.hook) : null,
      el('span', { className: 'game-card-meta' }, `games/${g.name}`, ' · ', g.made ? (STEP_WORDS[g.loop?.status] && g.loop?.status !== 'delivered' ? STEP_WORDS[g.loop.status] : 'made') : `being pitched${g.loop?.status ? `: ${STEP_WORDS[g.loop.status] ?? g.loop.status}` : ''}`))))]
      : [el('p', { className: 'empty' }, 'No games yet. Describe one above, or start from an example below.')]));
    examples.replaceChildren(el('div', { className: 'game-list' }, ...home.examples.map(ex => {
      const b = el('button', { type: 'button', className: 'ghost small' }, 'Start from this');
      b.addEventListener('click', () => fromExample(ex, b));
      return el('div', { className: 'game-card example', 'data-example': ex.id }, el('span', { className: 'game-card-title' }, ex.title), el('span', { className: 'game-card-hook' }, ex.summary), el('span', { className: 'game-card-meta' }, b));
    })));
    paintSession();
  }
  paint();
  const t = setInterval(paintSession, 4000);
  return { refresh: paint, focus: () => box.focus(), close: () => clearInterval(t) };
}
