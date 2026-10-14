// The studio shell. With no game open: the start page (builder/studio/start.js). With one: the conversation with the person's
// own agent session on the left (builder/studio/chat.js), and the product on the right: the game preview, with the tools (the
// tabs seam) in a bar over it and the open tool in an inspector beside it. Also the wallet, live reload and the theme.
// A tab is builder/studio/tabs/<id>.js exporting `default { id, label, order, group?, action?, wide?, icon?, mount(el, ctx) }`
// (docs/ARCHITECTURE.md). `group` names the tool bar's group it sits in (Edit, Test, Launch; the built-in tabs have theirs
// in GROUPS below, a new tab without one goes under More). `action` (true, or { label }) also gives it a primary button
// beside the preview's bar: the flow's last step, e.g. Publish. A click opens the tab like its tool bar entry does.
// `wide` (true, or { game: 'thumbnail' | 'hidden' }) gives the open tab the whole product side, the game a thumbnail
// in its corner (true) or hidden, back when the tab closes. mount may return a function, called when the studio page goes away. ctx holds:
//   game                 /api/game/info: title, hook, mechanics, controls, network, gamesfun (gamesfun.json), latestVerify
//   api(path, body?, method?)  the dev server's API: GET without a body, POST with one (JSON, or raw for a Blob/ArrayBuffer);
//                        a third argument sets the method (PATCH with a JSON body, DELETE with none);
//                        path "game/slots" or "/api/game/slots"; resolves to the parsed JSON, rejects with the error text
//                        (an Error whose `problems` holds the kit's words, one a line, when a slot write was refused)
//   wallet               the Wallet Standard connection the studio owns (builder/studio/wallet.js): list(), connect(name?),
//                        disconnect(), account, address, feature(name), onChange(fn)
//   toast(msg, kind?)    a short message; kind 'ok' | 'error'
//   preview              { reload(), show(path), overlay(node|null), frame, send(msg, {reply, timeout}), hold(files, ms) } the game
//                        frame on the left ("/game/?gf-show=prop.ball"); overlay lays an editor's own view over the game (one
//                        at a time); send posts a message to the game and resolves to its answer of type `reply` (null when
//                        none comes in time: gf:slot → gf:slot-applied, gf:loadout → gf:loadout-applied); hold keeps the
//                        next live reload away when only these files change (a value the game already took live)
//   selection            { get(), set(sel|null), onChange(fn) } what the person picked (a slot or object, {id, label}); it travels
//                        with their next change request. A game frame may post { gf: 'select', id, label } to pick one.
//   chat                 { ask({ label, placeholder, compose, selection, button, onSent }), send(text) } the conversation's one
//                        box: an editor's "Ask my session" hands it a context (builder/studio/lib/editors/ui.js askBox)
//   project()            the open game: { name, dir, made }
//   on(event, fn)        dev-server events: 'game' (the game's files changed: { files }), 'verify' (a run finished)
import { hostBridge, inside } from './host-bridge.js';
import { createWallet } from './wallet.js';

const $ = sel => document.querySelector(sel);

async function api(path, body, method) {
  const url = path.startsWith('/api/') ? path : `/api/${String(path).replace(/^\/+/, '')}`;
  const raw = body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
  const init = body === undefined ? (method ? { method } : {}) : method ? { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : raw
    ? { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } }
    : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
  const res = await fetch(url, { cache: 'no-store', ...init });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) { const e = new Error((data && data.error) || `${res.status} ${res.statusText}`); if (Array.isArray(data?.problems)) e.problems = data.problems; throw e; }
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = String(msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

const store = {
  get(k) { try { return localStorage.getItem(`gamesfun.${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`gamesfun.${k}`, v); } catch {} },
};

// ---- the theme: dark (XGames.fun's) by default, light by the header's switch; ?theme= wins for this visit ----
const themeBtn = $('#theme-btn');
const ICON = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const SUN = ICON('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>');
const MOON = ICON('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>');
function paintTheme() {
  const light = document.documentElement.dataset.theme === 'light';
  const words = light ? 'Switch to the dark theme' : 'Switch to the light theme';
  themeBtn.innerHTML = light ? MOON : SUN;
  themeBtn.title = words; themeBtn.setAttribute('aria-label', words);
}
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
  paintTheme();
});
paintTheme();

// ---- the preview ----
const frame = $('#preview');
const preview = {
  frame,                      // the iframe element (same origin: a tab may read the game's page, never write it)
  path: store.get('preview') || '/game/',
  show(path) { this.path = path; frame.src = path; const opt = [...$('#preview-mode').options].find(o => o.value === path); $('#preview-mode').value = opt ? path : $('#preview-mode').value; },
  reload() { try { frame.contentWindow.location.reload(); } catch { frame.src = this.path; } },
  // an editor's own view laid over the game (the map painter, the layout's top view); null takes it away
  overlay(node) { const wrap = frame.parentElement; wrap.querySelector(':scope > .preview-overlay')?.remove(); if (node) { node.classList.add('preview-overlay'); wrap.append(node); } },
  // a message to the game (same origin), and its answer of type `reply` from that frame, or null after `timeout` ms
  send(msg, { reply = null, timeout = 1500 } = {}) {
    const win = frame.contentWindow;
    if (!win) return Promise.resolve(null);
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (done) return; done = true; window.removeEventListener('message', on); clearTimeout(t); resolve(v); };
      const on = e => { if (e.source === win && e.origin === location.origin && e.data?.type === reply && (msg.id === undefined || e.data.id === msg.id)) finish(e.data); };
      if (reply) window.addEventListener('message', on);
      const t = setTimeout(() => finish(null), reply ? timeout : 0);
      try { win.postMessage(msg, location.origin); } catch { finish(null); }
    });
  },
  // the next file change that touches only `files` (within ms) does not reload the game: it already took the value live
  hold(files, ms = 4000) { held = { files: new Set(files), until: Date.now() + ms }; },
};
let held = null;
$('#preview-mode').addEventListener('change', e => { store.set('preview', e.target.value); preview.show(e.target.value); });
$('#preview-reload').addEventListener('click', () => preview.reload());

// ---- the host bridge: a game with a live economy gets its buttons from this page (builder/studio/host-bridge.js) ----
// It answers only the preview frame (or a frame inside it, the friends lobby's game) and only when gamesfun.json has a
// live economy; otherwise it says nothing and the game looks as it always did.
const bridge = hostBridge({ win: window, accept: src => inside(frame.contentWindow, src) });
window.__gamesfunHostBridge = bridge;

// ---- the selection chip ----
let selected = null;
const selListeners = new Set();
const selection = {
  get: () => selected,
  set(sel) { selected = sel && sel.id ? { id: String(sel.id), label: String(sel.label ?? sel.id) } : null; for (const fn of selListeners) { try { fn(selected); } catch (e) { console.error(e); } } },
  onChange(fn) { selListeners.add(fn); return () => selListeners.delete(fn); },
};
window.addEventListener('message', e => {
  if (e.origin !== location.origin || e.source !== frame.contentWindow) return;      // only the game frame, on this origin
  const d = e.data;
  if (d && d.gf === 'select' && typeof d.id === 'string') selection.set({ id: d.id.slice(0, 120), label: String(d.label ?? d.id).slice(0, 120) });
});

// ---- events from the dev server (live reload) ----
const handlers = new Map();
const on = (event, fn) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); return () => handlers.get(event).delete(fn); };
const fire = (event, data) => { for (const fn of handlers.get(event) ?? []) { try { fn(data); } catch (e) { console.error(e); } } };
const es = new EventSource('/__gamesfun/events');
let reloadTimer = null;
es.addEventListener('game', e => {
  const data = JSON.parse(e.data || '{}');
  clearTimeout(reloadTimer);
  const files = Array.isArray(data.files) ? data.files : [];
  const live = held && Date.now() < held.until && files.length && files.every(f => held.files.has(f));
  if (live) held = null;
  reloadTimer = setTimeout(() => { if (!live) { bridge.forget(); preview.reload(); } fire('game', { ...data, live: !!live }); showTitle(); }, 120);
});
// The title in the bar follows the game's files: a change by the session or a roll-back may rename the game.
function showTitle() {
  api('game/info').then(g => { $('#game-title').textContent = g.title; $('#game-title').title = g.hook || ''; }).catch(() => {});
}
es.addEventListener('verify', e => fire('verify', JSON.parse(e.data || '{}')));
es.addEventListener('studio', () => location.reload());

// ---- the wallet ----
const wallet = createWallet();
const walletBtn = $('#wallet-btn');
const short = a => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
function paintWallet() {
  const list = wallet.list();
  walletBtn.hidden = !list.length && !wallet.account;
  walletBtn.textContent = wallet.account ? `Wallet ${short(wallet.address)}` : 'Connect wallet';
  walletBtn.title = wallet.account ? `${wallet.wallet?.name}: ${wallet.address} (click to disconnect)` : list.map(w => w.name).join(', ');
}
wallet.onChange(paintWallet);
walletBtn.addEventListener('click', async () => {
  try {
    if (wallet.account) { await wallet.disconnect(); toast('Wallet disconnected'); }
    else { const a = await wallet.connect(); toast(`Connected ${short(a?.address)}`, 'ok'); }
  } catch (e) { toast(e.message, 'error'); }
});
setTimeout(paintWallet, 500);

// ---- tabs ----
// The network badge belongs to the web3 side: hidden until the game has web3 settings or the person opens a web3 tab.
const WEB3_TABS = new Set(['economy']);
let networkShown = false;
const paintNetwork = id => { $('#network').hidden = !(networkShown || WEB3_TABS.has(id)); };

// The tool bar's groups, in order. A tab may name its own (`group: 'Edit'`); one that names none goes under More.
// (Session and Build are not tools: they are the conversation, on the left.)
const GROUPS = { map: 'Edit', skins: 'Edit', items: 'Edit', assets: 'Edit', tune: 'Edit', verify: 'Test', friends: 'Test', economy: 'Launch' };
const GROUP_ORDER = ['Edit', 'Test', 'Launch'];
const TAB_ICONS = {
  map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
  skins: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  items: '<path d="M14.5 3.5l6 6-9 9-4 1 1-4z"/><path d="M4 20l3-3"/>',
  assets: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  tune: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  verify: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  friends: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1"/><path d="M16 5.5a3 3 0 0 1 0 5M18 14a5.5 5.5 0 0 1 3 5v1"/>',
  economy: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v2M12 16v2"/>',
};
const tabIcon = (id, own = null) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ico'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.innerHTML = TAB_ICONS[id] ?? (typeof own === 'string' && /^<(path|circle|rect|line|polyline|polygon)\b[^<>]*\/>(\s*<(path|circle|rect|line|polyline|polygon)\b[^<>]*\/>)*$/.test(own.trim()) ? own : '<rect x="5" y="5" width="14" height="14" rx="3"/>'); return s; };

async function loadTabs(ctx) {
  const list = await api('studio/tabs');
  const tabs = [];
  for (const t of list) {
    try {
      const mod = await import(`${t.url}?v=${Date.now()}`);
      const d = mod.default;
      if (!d || typeof d.id !== 'string' || typeof d.label !== 'string' || typeof d.mount !== 'function') throw new Error('must export default { id, label, order, mount(el, ctx) }');
      tabs.push({ ...d, order: Number.isFinite(d.order) ? d.order : 100, group: typeof d.group === 'string' && d.group ? d.group : GROUPS[d.id] ?? 'More', file: t.file });
    } catch (e) {
      tabs.push({ id: `broken-${t.file}`, label: `${t.file} ⚠`, order: 999, group: 'More', file: t.file, mount: el => { el.innerHTML = '<p class="error-box"></p>'; el.firstChild.textContent = `studio/tabs/${t.file} did not load: ${e.message}`; } });
    }
  }
  const groupRank = g => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length : i; };
  tabs.sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.order - b.order || a.label.localeCompare(b.label));
  const bar = $('#tabs'), panels = $('#panels'), inspector = $('#inspector');
  const mounted = new Map(), cleanups = [];
  // A tool opens in the inspector beside the game; closing it gives the game the room (nothing is lost: a tool stays mounted)
  async function select(id) {
    store.set('tab', id);
    paintNetwork(id);
    for (const b of bar.querySelectorAll('[role=tab]')) { const on = b.dataset.id === id; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
    for (const p of panels.children) p.hidden = p.dataset.id !== id;
    const tab = tabs.find(t => t.id === id);
    inspector.hidden = false;
    document.documentElement.dataset.tool = id;
    // a tool that asks for the whole product side (wide): the game shrinks to a thumbnail, or hides, while it is open
    const wide = tab.wide === true ? 'thumbnail' : tab.wide?.game === 'hidden' ? 'hidden' : tab.wide ? 'thumbnail' : null;
    if (wide) document.documentElement.dataset.wide = wide; else delete document.documentElement.dataset.wide;
    $('#inspector-title').textContent = tab.label;
    if (!mounted.has(id)) {
      const el = panels.querySelector(`[data-id="${CSS.escape(id)}"]`);
      mounted.set(id, true);
      try { const off = await tab.mount(el, ctx); if (typeof off === 'function') cleanups.push(off); }
      catch (e) { el.innerHTML = '<p class="error-box"></p>'; el.firstChild.textContent = `${tab.label}: ${e.message}`; console.error(e); }
    }
  }
  function closeTool() {
    store.set('tab', '');
    paintNetwork(null);
    for (const b of bar.querySelectorAll('[role=tab]')) { b.setAttribute('aria-selected', 'false'); b.tabIndex = -1; }
    bar.querySelector('[role=tab]')?.setAttribute('tabindex', '0');
    for (const p of panels.children) p.hidden = true;
    inspector.hidden = true;
    delete document.documentElement.dataset.tool;
    delete document.documentElement.dataset.wide;
  }
  $('#inspector-close').addEventListener('click', closeTool);
  // the game as a thumbnail (a wide tool is open): a click on it gives the game its room back
  $('.preview').addEventListener('click', e => { if (document.documentElement.dataset.wide === 'thumbnail' && e.target.closest('.preview-cover')) closeTool(); });
  let lastGroup = null;
  for (const t of tabs) {
    if (t.group !== lastGroup) {
      lastGroup = t.group;
      const g = document.createElement('div');
      g.className = 'tab-group'; g.setAttribute('aria-hidden', 'true'); g.textContent = t.group;
      bar.append(g);
    }
    const b = document.createElement('button');
    b.type = 'button'; b.role = 'tab'; b.dataset.id = t.id; b.dataset.group = t.group; b.id = `tab-${t.id}`; b.tabIndex = -1;
    b.setAttribute('aria-selected', 'false');
    b.append(tabIcon(t.id, t.icon), Object.assign(document.createElement('span'), { textContent: t.label }));
    b.setAttribute('aria-controls', `panel-${t.id}`);
    b.addEventListener('click', () => select(t.id));
    bar.append(b);
    const p = document.createElement('div');
    p.className = 'panel'; p.dataset.id = t.id; p.hidden = true; p.role = 'tabpanel'; p.id = `panel-${t.id}`; p.setAttribute('aria-labelledby', `tab-${t.id}`);
    panels.append(p);
  }
  bar.querySelector('[role=tab]')?.setAttribute('tabindex', '0');
  // a tab that is the flow's last step (action) also gets a primary button at the end of the bar
  const acts = $('#product-actions');
  for (const t of tabs.filter(x => x.action)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'product-action'; b.dataset.action = t.id;
    b.textContent = typeof t.action === 'object' && t.action.label ? String(t.action.label) : t.label;
    b.addEventListener('click', () => select(t.id));
    acts.append(b);
  }
  // the arrow keys move between tools, Home and End go to the first and the last (the tablist pattern)
  bar.addEventListener('keydown', e => {
    const list = [...bar.querySelectorAll('[role=tab]')], i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const j = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (j === undefined) return;
    e.preventDefault();
    const next = list[(j + list.length) % list.length];
    next.focus(); select(next.dataset.id);
  });
  window.addEventListener('pagehide', () => { for (const off of cleanups) { try { off(); } catch {} } });
  // a link to a tool (#economy, or #economy?flow=economy from an agent's tool) wins over the one left open last time
  const linked = () => decodeURIComponent(location.hash.slice(1).split('?')[0]);
  const want = tabs.some(t => t.id === linked()) ? linked() : store.get('tab');
  if (tabs.some(t => t.id === want)) await select(want);
  window.addEventListener('hashchange', () => { if (tabs.some(t => t.id === linked())) select(linked()); });
  return tabs;
}

// ---- which game is open ----
const setView = v => { document.documentElement.dataset.view = v; };
// another game opened (here, from another tab, or by the build loop's folder becoming a game): start the page over
const reopen = () => { location.href = '/studio/'; };
es.addEventListener('project', reopen);
$('#home-btn').addEventListener('click', async () => {
  try { await api('studio/project', { name: null }); } catch (e) { toast(e.message, 'error'); return; }
  reopen();
});

async function main() {
  window.__gamesfunStudio = true;
  let project;
  try { project = (await api('studio/project')).project; } catch (e) { $('#game-title').textContent = `Could not reach the dev server: ${e.message}`; return; }
  const ctx = { api, wallet, toast, preview, on, selection, project: () => project, open: reopen };

  if (!project) {                                         // the start page: nothing is played
    setView('start');
    $('#game-title').textContent = '';
    document.title = 'XGames.fun Studio';
    const { mountStart } = await import('./start.js');
    window.__gamesfunStart = mountStart($('#start'), ctx);
    return;
  }

  setView(project.made ? 'game' : 'making');
  const { mountChat } = await import('./chat.js');
  ctx.chat = mountChat($('#chat'), { ...ctx, onMade: reopen });
  window.__gamesfunChat = ctx.chat;
  if (!project.made) {                                    // the build loop is making this folder: the game appears when it exists
    $('#game-title').replaceChildren('New game ', Object.assign(document.createElement('span'), { className: 'game-folder', textContent: `games/${project.name}` }));
    document.title = `${project.name} · XGames.fun Studio`;
    const empty = $('#product-empty');
    empty.hidden = false;
    // a plain state, never a game: no example and no frame stand in while the person's own game is being made. It
    // says "Making your game" only once a session acts on the idea (it holds the request, or the build loop has a
    // state); until then "Waiting for your session", with the one step left (2026-10-12: it said "Making" with no
    // session at all)
    const { connection, readQueue } = await import('./lib/session.js');
    const { sessionApi } = await import('./lib/session-client.js');
    const { loopView } = await import('./lib/loop-state.js');
    const { loopPanel } = await import('./loop-panel.js');
    // while the game is being made, the loop fills this side: the stages, then the ledger and the foundation as they form
    const openSecs = new Set(['ledger', 'foundation']);
    let shown = '';
    const paintMaking = async () => {
      let q = null, loop = null;
      try { q = await sessionApi('queue'); } catch { /* no bridge */ }
      try { loop = (await api('build/state')).loop ?? null; } catch { /* not yet */ }
      const c = connection(readQueue(q));
      const acting = !!loop || (c.state === 'working' && c.open > 0);
      const key = acting ? `making|${loop?.updated ?? ''}|${[...openSecs].join()}` : `waiting|${c.state}|${c.hint}`;
      if (key === shown) return;
      shown = key;
      const box = document.createElement('div');
      box.className = `product-empty-inner${loop ? ' with-loop' : ''}`;
      box.dataset.part = acting ? 'making' : 'waiting';
      box.dataset.session = c.state;
      const h = document.createElement('h2'), para = document.createElement('p');
      const mark = Object.assign(document.createElement('div'), { className: 'product-empty-mark' });
      mark.setAttribute('aria-hidden', 'true');
      if (acting) { h.textContent = 'Making your game'; para.textContent = 'Your session pitches a few takes first, in the conversation. Pick one and it makes the game from it. Your game appears here when its first build is done: then you play it here and change it with the tools.'; }
      else { h.textContent = 'Waiting for your session'; para.textContent = `Your idea is saved; nothing is being made yet. ${c.state === 'none' ? 'No agent session is listening. ' : ''}${c.hint}`; }
      box.append(mark, h, para);
      if (loop) {
        const panel = loopPanel(loopView(loop), { open: [...openSecs] });         // the stages are the conversation's
        panel?.addEventListener('toggle', e => { const id = e.target?.dataset?.sec; if (id) { if (e.target.open) openSecs.add(id); else openSecs.delete(id); } }, true);
        if (panel) box.append(panel);
      }
      empty.replaceChildren(box);
    };
    await paintMaking();
    setInterval(paintMaking, 2000);
    return;
  }

  let game;
  try { game = await api('game/info'); } catch (e) { $('#game-title').textContent = `Could not reach the dev server: ${e.message}`; return; }
  document.title = `${game.title} · XGames.fun Studio`;
  $('#game-title').textContent = game.title;
  $('#game-title').title = game.hook || '';
  $('#network').textContent = game.network || 'devnet';
  networkShown = !!game.gamesfun;       // only a game with web3 settings (gamesfun.json) shows its network up front
  // a live economy: "Open game in its own tab" opens it hosted (builder/studio/play.html), so its economy's buttons come along
  if (game.gamesfun?.economy?.live?.game) $('#open-game').href = '/studio/play.html';
  paintNetwork(store.get('tab'));
  preview.show(preview.path);
  ctx.game = game;
  window.__gamesfunStudioTabs = await loadTabs(ctx);
}
main();
