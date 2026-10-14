// Drive any game into real play, so captures reach gameplay and sound (code-art build brief 2026-10-02, agent D;
// asset-manifest/code-art-2026-10-02/BUILD_BRIEF.md and FINDINGS.md §2, "Proposed system" item 3).
// Shared by audio/capture-code-sounds.mjs, asset-manifest/asset-coverage.mjs, capture-code-art.mjs and
// export-glb.mjs. Contract: creator-studio/docs/asset-manifest.md, "v1.5: reaching play (check.play), the play driver and the coverage gate".
//
// API (a Playwright page, or check.mjs's frame proxy in --tree/--srcdoc: evaluate goes to the game's frame, input and
// screenshots to the page):
//   await installProbe(page, {seedRandom, still, pointerLock})   before page.goto. Counts audio activity (contexts, source
//        starts grouped per task, <audio>/<video> plays, the file a buffer was decoded from, where each source was made),
//        counts animation frames, tolerates pointer lock (a refused lock is faked), and optionally seeds Math.random.
//   const r = await reachPlay(page, {dir, manifest, seed, log, sound, budgetMs})
//        Per-game steps first (assets.json check.steps, then check.play.steps), then generic heuristics: start/play/
//        continue buttons in many languages, filling a required name, Enter/Space, a click on the biggest canvas, and
//        turning sound on once (a sound/mute toggle whose state is read from aria/labels/icons; never toggled back off).
//        Returns {reached, how, ms, actions, script, sound, evidence: {response, audio, pointerLock, canvas}, why}.
//        `script` replays the same input (runPlaySteps) for a second, comparable load.
//   const f = await fuzz(page, {seconds, seed | rand, onTick, restart, record, avoidKeys})   seeded game-like input:
//        WASD/arrows held, mouse look, left and right clicks and drags on the canvas, number keys, Space, the odd UI
//        button. Never a key in check.play.avoidKeys (round 3: reachPlay remembers the manifest's list for the page;
//        avoidKeysOf(manifest) reads it). Returns {actions, script}.
//   await recover(page, {rand})   past a game-over or pause card: a go-button, else a canvas click and Enter.
//   await clickSomeButton(page, {rand})   a random visible UI button, never a sound toggle or one to avoid.
//   await audioActivity(page)     {contexts, running, starts, events, media, generators, lastEventMs} (probe needed).
//   await probeData(page)         the probe's raw events (asset-coverage.mjs attributes them to manifest sounds).
//   const {ok, results, ran, failed, forced} = await runSteps(page, steps, {strict, log})   every step kind (STEP_KINDS): check.mjs's {wait},
//        {click: [x, y] | 'centre' | 'here'}, {key}, {down}, {up}, {hold, ms}, {select}, {clickSelector}, {waitFor}, plus
//        {text, last?, exact?}, {fill, value}, {move: [x, y], steps}, {mouse}, {wheel}, {rclick: [x, y]}, {domClick: [x, y]}
//        (element.click() at a point), {range: [x, y, value]} and {query}. Points may be "50%" shares, of the viewport or,
//        with {in: 'canvas'}, of the game's biggest canvas. Pointer-lock safe and no "stable" wait (see "Steps" below).
//        Never throws unless strict. check.mjs's runSteps delegates here (round-2 integration), so every tool runs steps
//        the same way; `ran`, `failed` and `forced` are its result shape. runPlaySteps is the same function.
//        {text} is exact unless `exact: false`: the element's whole text, or its own text beside a caption in a child
//        element (round 3; textLocator(page, step) is the locator). A failed {text} step says when the text is only
//        part of a longer one.
//   withPlayQuery(url, manifest)  the URL with check.play.query merged in, for a tool to load the game with it.
//   goButtons(ui), clickElement(page, locator), clickPoint(page, point), isPointerLocked(page), resolvePoint(page, point).
//   rng(seed), decodePng(buf), encodePng(w, h, rgba), diffFraction(a, b)   helpers.
// Every page action is bounded in time, so a frozen game fails its own step instead of hanging a batch.
import { inflateSync, deflateSync, crc32 } from 'node:zlib';

export const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const within = (ms, p, what = 'a page step') => { let t; return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(`${what} took longer than ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t)); };
const sleep = (page, ms) => page.waitForTimeout(ms).catch(() => {});

// ---- In the page: the probe ----
// Runs before any game script (addInitScript). It wraps prototypes the way the gf-audio shim does and never changes what
// the game hears. Frames are "file:line:col" relative to the page's folder, innermost first, like code.sig: the
// code-sounds shim's own file and anything outside the game folder (this probe, other origins) are left out.
export const PROBE = opts => {
  const W = window, o = opts || {};
  if (W.__gfPlay) return;
  const P = W.__gfPlay = { contexts: [], starts: 0, silent: 0, events: [], media: [], generators: [], frames: 0, lock: { requests: 0, granted: 0, errors: 0, faked: 0 }, dropped: 0, MAX: 4000 };
  if (typeof o.seedRandom === 'number') {
    let s = o.seedRandom | 0;
    Math.random = function random() { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  if (o.still) W.__GF_STILL = true;
  const raf = W.requestAnimationFrame;
  if (raf) W.requestAnimationFrame = function (cb) { return raf.call(this, function () { P.frames++; return cb.apply(this, arguments); }); };
  const BASE = (() => { try { return new URL('.', document.URL).href; } catch { return ''; } })();
  const SHIM = 'audio/code-sounds.js';
  const rel = url => {
    if (!url || !BASE) return null;
    const clean = String(url).split(/[?#]/)[0];
    if (!clean.startsWith(BASE)) return null;
    let f; try { f = decodeURIComponent(clean.slice(BASE.length)) || 'index.html'; } catch { return null; }
    return f === SHIM ? null : f;
  };
  P.rel = rel;
  function frames() {
    const E = Error, lim = E.stackTraceLimit, prep = E.prepareStackTrace, out = [], names = [];
    let raw = null;
    try { E.stackTraceLimit = 30; E.prepareStackTrace = (_, s) => s; const h = {}; E.captureStackTrace(h, frames); raw = h.stack; } catch { raw = null; } finally { E.stackTraceLimit = lim; E.prepareStackTrace = prep; }
    if (Array.isArray(raw)) for (const c of raw) {
      const f = rel(c.getScriptNameOrSourceURL ? c.getScriptNameOrSourceURL() : c.getFileName());
      if (!f) continue;
      out.push(`${f}:${c.getLineNumber()}:${c.getColumnNumber()}`);
      names.push(c.getFunctionName() || c.getMethodName() || null);
      if (out.length >= 16) break;
    }
    return { frames: out, names };
  }
  // Bursts: starts in one task (as the gf-audio shim groups nodes) are one event.
  let burst = 0, burstSeq = 0, cur = null;
  const taskBurst = () => { if (!burst) { const b = burst = ++burstSeq; queueMicrotask(() => { if (burst === b) burst = 0; }); } return burst; };
  const made = new WeakMap(), bufUrl = new WeakMap(), ctxSeen = new WeakSet();
  const seeCtx = ctx => { if (ctx && !ctxSeen.has(ctx)) { ctxSeen.add(ctx); if (P.contexts.length < 32) P.contexts.push(ctx); } };
  const AC = W.AudioContext || W.webkitAudioContext;
  const BAC = W.BaseAudioContext ? W.BaseAudioContext.prototype : AC ? AC.prototype : null;
  const Offline = W.OfflineAudioContext;
  if (BAC) {
    for (const k of ['createOscillator', 'createBufferSource']) {
      const f = BAC[k]; if (typeof f !== 'function') continue;
      BAC[k] = function () { const n = f.apply(this, arguments); try { seeCtx(this); if (!(Offline && this instanceof Offline)) made.set(n, frames()); } catch {} return n; };
    }
    for (const k of ['createScriptProcessor']) {
      const f = BAC[k]; if (typeof f !== 'function') continue;
      BAC[k] = function () { const n = f.apply(this, arguments); try { if (P.generators.length < 50) P.generators.push({ t: Math.round(performance.now()), kind: 'ScriptProcessor', ...frames() }); } catch {} return n; };
    }
    const dec = BAC.decodeAudioData;
    if (typeof dec === 'function') BAC.decodeAudioData = function (data, ok, fail) {
      const url = data && bufUrl.get(data), tag = b => { if (url && b) bufUrl.set(b, url); return b; };
      const p = dec.call(this, data, ok ? b => { tag(b); ok(b); } : ok, fail);
      if (p && p.then) p.then(tag, () => {});
      return p;
    };
  }
  if (W.AudioWorkletNode) {
    const AWN = W.AudioWorkletNode;
    W.AudioWorkletNode = new Proxy(AWN, { construct(t, a, nt) { const n = Reflect.construct(t, a, nt); try { if (!/^gf-/.test(String(a[1])) && P.generators.length < 50) P.generators.push({ t: Math.round(performance.now()), kind: `AudioWorklet ${a[1]}`, ...frames() }); } catch {} return n; } });
  }
  if (W.Response) {
    const ab = Response.prototype.arrayBuffer;
    Response.prototype.arrayBuffer = function () { const url = this.url; return ab.call(this).then(b => { if (url) try { bufUrl.set(b, url); } catch {} return b; }); };
  }
  if (W.XMLHttpRequest) {
    const X = XMLHttpRequest.prototype, open = X.open, d = Object.getOwnPropertyDescriptor(X, 'response');
    X.open = function (m, url) { try { this.__gfUrl = new URL(url, document.baseURI).href; } catch {} return open.apply(this, arguments); };
    if (d && d.get) Object.defineProperty(X, 'response', { configurable: true, enumerable: d.enumerable, get() { const r = d.get.call(this); if (r instanceof ArrayBuffer && this.__gfUrl) bufUrl.set(r, this.__gfUrl); return r; } });
  }
  function note(node, when) {
    const ctx = node.context;
    seeCtx(ctx);
    if (Offline && ctx instanceof Offline) return;   // offline rendering: nobody hears it
    // A constant source is a control signal or a recorder's keep-alive (qa-gate, the capture tool), not a sound.
    if (node.__gfInternal || (W.ConstantSourceNode && node instanceof W.ConstantSourceNode)) { P.silent++; return; }
    P.starts++;
    const b = taskBurst();
    if (!cur || cur.burst !== b) {
      if (P.events.length >= P.MAX) { P.dropped++; cur = { burst: b, srcs: [] }; return; }
      cur = { t: Math.round(performance.now()), burst: b, n: 0, state: ctx.state, srcs: [] };
      P.events.push(cur);
    }
    cur.n = (cur.n || 0) + 1;
    if (cur.srcs.length < 4) {
      const m = made.get(node), buf = node.buffer;
      cur.srcs.push({ kind: node.constructor && node.constructor.name, frames: m ? m.frames : [], names: m ? m.names.slice(0, 4) : [], file: buf ? rel(bufUrl.get(buf)) || bufUrl.get(buf) || null : null, when: +when || 0 });
    }
  }
  const seenStart = new WeakSet();
  for (const C of [W.AudioScheduledSourceNode, W.AudioBufferSourceNode, W.OscillatorNode]) {
    const p = C && C.prototype;
    if (!p || !Object.prototype.hasOwnProperty.call(p, 'start')) continue;
    const st = p.start;
    p.start = function (when) { try { if (!seenStart.has(this)) { seenStart.add(this); note(this, when); } } catch {} return st.apply(this, arguments); };
  }
  document.addEventListener('play', e => {
    const m = e.target;
    if (!(m instanceof HTMLMediaElement) || P.media.length >= 500) return;
    const src = m.currentSrc || m.src || '';
    P.media.push({ t: Math.round(performance.now()), src: rel(src) || src.slice(0, 200), muted: !!m.muted, video: m instanceof HTMLVideoElement });
  }, true);
  // Pointer lock: count it; in 'auto' mode a refused or failed lock is faked so the game still enters play.
  const mode = o.pointerLock || 'auto';
  let fakeEl = null, lastReq = null, lastFake = 0;
  const fake = el => {
    if (!el || performance.now() - lastFake < 100) return;
    lastFake = performance.now(); P.lock.faked++; fakeEl = el;
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => fakeEl });
    document.dispatchEvent(new Event('pointerlockchange'));
  };
  document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement) P.lock.granted++; }, true);
  document.addEventListener('pointerlockerror', () => { P.lock.errors++; if (mode === 'auto') fake(lastReq); }, true);
  const RPL = Element.prototype.requestPointerLock;
  if (RPL) Element.prototype.requestPointerLock = function () {
    P.lock.requests++; lastReq = this;
    if (mode === 'fake') { fake(this); return Promise.resolve(); }
    let r;
    try { r = RPL.apply(this, arguments); } catch (e) { if (mode === 'auto') { fake(this); return Promise.resolve(); } throw e; }
    if (r && typeof r.catch === 'function' && mode === 'auto') return r.catch(() => fake(this));
    return r;
  };
  const EPL = Document.prototype.exitPointerLock;
  if (EPL) Document.prototype.exitPointerLock = function () {
    if (fakeEl) { fakeEl = null; delete document.pointerLockElement; document.dispatchEvent(new Event('pointerlockchange')); return; }
    return EPL.apply(this, arguments);
  };
  P.activity = () => {
    const ctxs = P.contexts.map(c => c.state), last = P.events.length ? P.events[P.events.length - 1].t : null;
    return { contexts: ctxs.length, running: ctxs.filter(s => s === 'running').length, starts: P.starts, events: P.events.length + P.dropped, media: P.media.length,
      generators: P.generators.length, lastEventMs: last === null ? null : Math.round(performance.now() - last), frames: P.frames, lock: { ...P.lock, held: !!document.pointerLockElement } };
  };
};

// ---- Staying on the game (round 4, swarm bug 74) ----
// The seeded input and the start heuristics pressed a link to the page itself (the game reloaded: a sound capture then
// said "ok, 0 events") and Enter on a sign-in button that set location.href to another site (the tools' Chrome loaded
// it, and export-glb said "0 scenes observed", exit 0). The guard keeps the page on the game and tells the tool what
// happened, so a tool can fail instead of reporting an empty page as a result:
//   - a document request to another http(s) origin (location.href = …, a form, a link, window.open) is answered 204 by
//     the tool: nothing is sent to that host and the page stays where it is;
//   - a click on <a href> to another origin, or to the page itself (which would only reload the game), is cancelled in
//     the page, so the game's own click handlers still run;
//   - every new document in the game's frame is counted (an init script calls a binding), so a reload on the game's own
//     origin is seen though the URL is the same. The tool's own loads (page.goto, page.reload, check.play.query) are
//     expected and never count;
//   - the key or the point pressed just before the page reloaded, or before a navigation was stopped, is not pressed
//     again by reachPlay, fuzz, recover or clickSomeButton on that page.
const NAV = new WeakMap(), NAV_CTX = new WeakMap();
const realPage = page => { try { return page.mainFrame().page(); } catch { return page; } };
const navState = page => (page && typeof page === 'object' ? NAV.get(realPage(page)) ?? null : null);
const samePath = p => String(p || '/').replace(/\/index\.html?$/i, '/');
const NAV_INIT = () => {
  const W = window;
  if (W.__gfNavSeen) return;
  W.__gfNavSeen = true;
  const later = W.setTimeout.bind(W);   // the real timer: play-compare's fake clock is installed after this
  const tell = (kind, url) => { try { if (typeof W.__gfNav === 'function') W.__gfNav(kind, String(url)); } catch {} };
  tell('doc', location.href);
  const norm = p => p.replace(/\/index\.html?$/i, '/');
  W.addEventListener('click', e => {
    let a = null;
    try { for (const n of (e.composedPath ? e.composedPath() : [])) if (n && n.nodeType === 1 && n.matches && n.matches('a[href], area[href]')) { a = n; break; } } catch {}
    if (!a) return;
    let u;
    try { u = new URL(typeof a.href === 'string' ? a.href : a.href.baseVal, document.baseURI); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    const out = u.origin !== location.origin;
    // A fragment link (#top) stays in the document; a link to another page of the game (play.html) is followed.
    const fragment = !out && u.pathname === location.pathname && u.search === location.search && (!!u.hash || /#$/.test(a.getAttribute('href') || ''));
    const self = !out && !fragment && norm(u.pathname) === norm(location.pathname) && (u.search === location.search || !u.search);
    if (!out && !self) return;
    // A link the game cancels itself (<a href="" onclick="start(); …preventDefault()">) was never going anywhere.
    let own = false;
    const pd = e.preventDefault;
    try { e.preventDefault = function () { own = true; return pd.call(this); }; } catch {}
    pd.call(e);
    later(() => { if (!own) tell(out ? 'link-out' : 'link-self', u.href); }, 0);
  }, true);
};
const shortUrl = url => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? (u.origin + u.pathname).slice(0, 120) : String(url).slice(0, 60); } catch { return String(url).slice(0, 60); } };

/**
 * Keep `page` on the game and count its documents (see above). Before page.goto, on the real Playwright page.
 * installProbe calls it; a tool that installs no probe (check.mjs) calls it itself. Once per page.
 *   frame    'child': the game is the first child frame of the page (check.mjs --tree and --srcdoc); a function
 *            (page) => Frame; default: the main frame.
 *   origins  origins the game's frame may load from, when the tool knows them up front (then the frame's first load
 *            must be one of them too).
 * Returns the guard's state, or null for something that is not a Playwright page (a test's stand-in).
 */
export async function guardNavigation(page, { frame = null, origins = null } = {}) {
  const real = realPage(page);
  if (!real || typeof real.route !== 'function' || typeof real.exposeBinding !== 'function' || typeof real.addInitScript !== 'function') return null;
  if (NAV.has(real)) return NAV.get(real);
  const st = { t0: Date.now(), origins: new Set(origins ?? []), strict: !!origins, origin: null, path: null, documents: 0, mainDocuments: 0, reloads: [], pages: [], blocked: [], left: null,
    expect: [], act: null, seq: 0, avoidKeys: new Set(), avoidPoints: [], installed: true };
  st.frame = () => (frame === 'child' ? real.frames().find(f => f.parentFrame() === real.mainFrame()) ?? null : typeof frame === 'function' ? frame(real) : real.mainFrame());
  NAV.set(real, st);
  // The input just before is what did it: not pressed again on this page.
  const blame = now => {
    const a = st.act;
    if (!a || now - a.t > 1500) return null;
    if (a.key) st.avoidKeys.add(a.key);
    if (a.point) st.avoidPoints.push(a.point);
    return a.what;
  };
  const expected = now => { st.expect = st.expect.filter(x => x.until > now); return st.expect.length > 0; };
  const told = (source, kind, url) => {
    const now = Date.now();
    let game = null; try { game = st.frame(); } catch {}
    const main = (() => { try { return real.mainFrame(); } catch { return null; } })();
    if (kind === 'doc') {
      if (source.frame === main && main !== game) { st.mainDocuments++; try { st.origins.add(new URL(url).origin); } catch {} return; }
      if (source.frame !== game) return;
      let u = null; try { u = new URL(url); } catch {}
      const http = !!u && /^https?:$/.test(u.protocol), origin = http ? u.origin : 'null', path = http ? samePath(u.pathname) : String(url).slice(0, 200);
      st.documents++;
      const wanted = expected(now);
      if (wanted) st.expect.shift();
      if (st.documents === 1 || wanted) { st.origin = origin; st.path = path; if (http) st.origins.add(origin); return; }
      st.seq++;
      const after = blame(now);
      if (origin !== st.origin && !(http && st.origins.has(origin))) { st.left ??= { t: now - st.t0, url: shortUrl(url), after }; return; }
      const entry = { t: now - st.t0, url: shortUrl(url), after };
      if (path === st.path) st.reloads.push(entry); else { st.pages.push(entry); st.path = path; }
      return;
    }
    if (kind === 'link-out' || kind === 'link-self') {
      if (source.frame !== game && source.frame !== main) return;
      st.seq++;
      st.blocked.push({ t: now - st.t0, url: shortUrl(url), how: 'link', to: kind === 'link-self' ? 'the page itself' : 'another site', after: blame(now) });
    }
  };
  const stop = async route => {
    const rq = route.request();
    let nav = false; try { nav = rq.isNavigationRequest(); } catch {}
    if (!nav) return route.fallback();
    let fr = null; try { fr = rq.frame(); } catch { return route.fallback(); }   // a popup's first request: the context's handler
    let game = null, main = null; try { game = st.frame(); main = real.mainFrame(); } catch {}
    if (fr !== game && fr !== main) return route.fallback();
    let u; try { u = new URL(rq.url()); } catch { return route.fallback(); }
    const now = Date.now(), first = fr === game ? st.documents === 0 && !(st.strict && fr !== main) : st.mainDocuments === 0;
    if (expected(now) || st.origins.has(u.origin) || first) { st.origins.add(u.origin); return route.fallback(); }
    st.seq++;
    st.blocked.push({ t: now - st.t0, url: shortUrl(rq.url()), how: 'request', to: 'another site', after: blame(now) });
    return route.fulfill({ status: 204, body: '' }).catch(() => {});
  };
  const http = u => /^https?:$/.test(u.protocol);
  try {
    await real.exposeBinding('__gfNav', told);
    await real.addInitScript(NAV_INIT);
    await real.route(http, stop);
    // Popups (window.open, target=_blank) and anything else in the context that is not a guarded page.
    const ctx = real.context();
    let c = NAV_CTX.get(ctx);
    if (!c) {
      c = { states: [] }; NAV_CTX.set(ctx, c);
      await ctx.route(http, async route => {
        const rq = route.request();
        let nav = false; try { nav = rq.isNavigationRequest(); } catch {}
        if (!nav) return route.fallback();
        let pg = null; try { pg = rq.frame().page(); } catch {}
        if (pg && NAV.has(pg)) return route.fallback();   // that page's own handler has decided
        let u; try { u = new URL(rq.url()); } catch { return route.fallback(); }
        if (c.states.some(s => s.origins.has(u.origin))) return route.fallback();
        const s = c.states[c.states.length - 1], now = Date.now();
        if (s) { s.seq++; s.blocked.push({ t: now - s.t0, url: shortUrl(rq.url()), how: 'popup', to: 'another site', after: s.act && now - s.act.t <= 1500 ? s.act.what : null }); if (s.act && now - s.act.t <= 1500) { if (s.act.key) s.avoidKeys.add(s.act.key); if (s.act.point) s.avoidPoints.push(s.act.point); } }
        return route.fulfill({ status: 204, body: '' }).catch(() => {});
      });
    }
    c.states.push(st);
    // The tool's own loads are expected.
    for (const k of ['goto', 'reload']) {
      const f = real[k];
      if (typeof f !== 'function') continue;
      real[k] = function (...a) {
        const tok = expectLoad(real, 120000);
        if (k === 'goto') try { st.origins.add(new URL(a[0]).origin); } catch {}
        const p = f.apply(real, a);
        Promise.resolve(p).then(() => {}, () => {}).then(() => { if (tok) tok.until = Math.min(tok.until, Date.now() + 1500); });
        return p;
      };
    }
  } catch (e) { st.installed = false; st.error = String(e?.message ?? e).split('\n')[0].slice(0, 160); }
  return st;
}
/** The tool is about to load or reload the game itself in a way the guard can't see (page.goto and page.reload are
 *  seen): the next document within `ms` is expected, not a reload. */
export function expectLoad(page, ms = 60000) {
  const st = navState(page);
  if (!st) return null;
  const tok = { until: Date.now() + ms };
  st.expect.push(tok);
  return tok;
}
/**
 * What happened to the page the tool is driving (synchronous; the page or check.mjs's frame proxy):
 *   {guarded, origin, documents, reloads: [{t, url, after}], pages: [{t, url, after}], blocked: [{t, url, how, to, after}],
 *    left, lost, problem, note}
 * reloads: documents the tool did not ask for at the same path (the game reloaded itself). pages: the same at another
 * path of the game's origin (a multi-page game moved on: followed). blocked: navigations that were stopped (how:
 * 'request' answered 204, 'link' cancelled in the page, 'popup'). left: the page got off the game's origin anyway.
 * lost: reloads.length > 0 || left: the document the tool was driving is gone, and a tool must fail with `problem` (or load the
 * game and reach play again, and say so). note: a sentence for a warning when something was stopped or the game moved on.
 */
export function pageNavigation(page) {
  const st = navState(page);
  if (!st) return { guarded: false, origin: null, documents: 0, reloads: [], pages: [], blocked: [], left: false, lost: false, problem: null, note: null };
  const times = n => (n === 1 ? 'once' : `${n} times`);
  const afterOf = list => { const a = [...new Set(list.map(x => x.after).filter(Boolean))].slice(0, 2); return a.length ? ` (after: ${a.join('; ')})` : ''; };
  const urls = list => [...new Set(list.map(x => x.url))].slice(0, 2).join(', ');
  const lost = st.reloads.length > 0 || !!st.left;
  let problem = null;
  if (st.left) problem = `the page left the game for ${st.left.url}${st.left.after ? ` (after: ${st.left.after})` : ''}: nothing the tool saw after that was the game`;
  else if (st.reloads.length) problem = `the game reloaded itself ${times(st.reloads.length)}${afterOf(st.reloads)}: what the tool had seen before is gone, and the game was back at its first screen`;
  const notes = [], away = st.blocked.filter(b => b.to !== 'the page itself'), self = st.blocked.filter(b => b.to === 'the page itself');
  if (away.length) notes.push(`stopped ${away.length} navigation${away.length === 1 ? '' : 's'} away from the game (${urls(away)})${afterOf(away)}: not followed, nothing was sent there`);
  if (self.length) notes.push(`a link to the page itself was pressed ${times(self.length)}${afterOf(self)}: not followed (it would have reloaded the game)`);
  if (st.pages.length) notes.push(`the game moved to another of its pages ${times(st.pages.length)} (${urls(st.pages)})${afterOf(st.pages)}`);
  if (!st.installed) notes.push(`the navigation guard could not be installed (${st.error ?? 'unknown'}): nothing was stopped`);
  return { guarded: st.installed, origin: st.origin, documents: st.documents, reloads: st.reloads.slice(), pages: st.pages.slice(), blocked: st.blocked.slice(), left: !!st.left, lost, problem, note: notes.length ? notes.join('; ') : null };
}
/** The driver's own input, remembered so a reload or a stopped navigation can name what was pressed (and avoid it). */
const noteInput = (page, what, { key = null, point = null } = {}) => { const st = navState(page); if (st) st.act = { what: String(what).slice(0, 80), key, point, t: Date.now() }; };
const navSeq = page => navState(page)?.seq ?? 0;
/** True when a click at x, y would press what reloaded the page or tried to leave it before. */
const pressedBefore = (page, x, y) => { const st = navState(page); return !!st && st.avoidPoints.some(([px, py]) => Math.abs(px - x) <= 40 && Math.abs(py - y) <= 24); };
const lastNavText = page => { const n = pageNavigation(page); return n.problem ?? n.note ?? 'the page navigated'; };

/** Before page.goto. seedRandom: a number seeds Math.random (same seed, same world); still: sets __GF_STILL;
 *  pointerLock: 'auto' (default; a refused lock is faked), 'fake' (always) or 'real'. Round 4 (swarm bug 74): the
 *  navigation guard is installed too (guardNavigation; `guard: false` leaves it out). */
export async function installProbe(page, { seedRandom = null, still = false, pointerLock = 'auto', guard = true } = {}) {
  if (guard) await guardNavigation(page).catch(() => null);
  await page.addInitScript(PROBE, { seedRandom, still, pointerLock });
}
export async function audioActivity(page) {
  return within(10000, page.evaluate(() => (window.__gfPlay ? window.__gfPlay.activity() : null)), 'reading the probe').catch(() => null);
}
/** The probe's events (Web Audio bursts), media plays, generators and counters. */
export async function probeData(page) {
  return within(20000, page.evaluate(() => {
    const P = window.__gfPlay;
    if (!P) return null;
    return { events: P.events.map(e => ({ t: e.t, n: e.n, state: e.state, srcs: e.srcs })), media: P.media, generators: P.generators, activity: P.activity(), dropped: P.dropped, silent: P.silent };
  }), 'reading the probe').catch(() => null);
}

// ---- Words ----
// Buttons that start or continue play, in the languages the imports use (the realistic-minecraft import is Chinese).
// Scored: 10 start/play, 8 continue/retry, 7 create a world, 6 a difficulty, 4 dismiss (ok, next, close).
// Latin and Cyrillic words need letter boundaries that \b (ASCII only) can't give; CJK words have none.
const W = src => new RegExp(`(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`, 'iu');
const GO_WORDS = [
  [10, W(String.raw`start(?:\s+(?:the\s+)?(?:game|playing|run|now|building|exploring|adventure|journey|mission|level|shift|match|race))?|play(?:\s+(?:now|game|solo|offline|alone))?|begin(?:\s+(?:game|adventure))?|new\s+game|single\s*-?\s*player|solo(?:\s*\+[^)]{0,30})?|enter\s+(?:the\s+)?(?:world|game|dungeon)|let'?s\s+(?:go|play|explore|begin)|tap\s+to\s+(?:play|start)|click\s+to\s+(?:play|start|begin)|press\s+(?:any\s+key|start|enter|space)|embark|deploy|launch(?:\s+game)?|jugar|empezar|comenzar|iniciar(?:\s+juego)?|jogar|começar|jouer|commencer|démarrer|spielen|starten|los\s+geht'?s|играть|начать|старт|gioca|inizia|oyna|başla|chơi|bắt\s+đầu|mulai|graj|zacznij|spela|speel|beginnen`)],
  [10, /开始游戏|开始|单人游戏|单人模式|单机|进入游戏|进入世界|开玩|开始冒险|開始遊戲|開始|單人遊戲|スタート|はじめる|始める|ゲーム開始|ゲームスタート|게임\s*시작|시작하기|시작/],
  [8, W(String.raw`continue|resume|retry|restart|try\s+again|play\s+again|back\s+to\s+(?:the\s+)?(?:game|world|play|exploring|it)|return\s+to\s+(?:the\s+)?game|respawn|revive|next\s+level|keep\s+(?:playing|going)|continuar|reintentar|continuer|réessayer|weiter|erneut|продолжить|заново|riprova|continua|devam`)],
  [8, /继续|繼續|重新开始|再来一次|重试|复活|返回游戏|つづける|続ける|リトライ|계속|다시\s*하기/],
  [7, W(String.raw`create(?:\s+(?:a\s+)?(?:new\s+)?(?:world|game|character|run))|new\s+world|generate\s+world|crear|créer|erstellen|создать`)],
  [7, /创建新的世界|创建世界|创建|新的世界|生成世界|新世界|确认|確認/],
  [6, W(String.raw`easy|normal|medium|casual|beginner|story\s+mode|fácil|facile|leicht|легко`)],
  [6, /简单|普通|容易|かんたん|ふつう|쉬움/],
  [4, W(String.raw`got\s+it|i\s+understand|understood|no\s+thanks|maybe\s+later|dismiss|accept|agree|aceptar|cerrar|fermer|schließen|закрыть`)],
  [4, /好的|确定|下一步|跳过|关闭|知道了|我知道了|閉じる|スキップ|닫기|확인/],
];
// Short words count only when they are the whole button ("Go", not "12 to go"; "Play", not "Main Corridor").
const GO_WHOLE = [
  [10, /^(?:go|play|start|begin|enter|solo|进入|游玩|プレイ|플레이|main)$/i],
  [8, /^(?:again|continue|resume)$/i],
  [7, /^(?:ready|select|choose|pick|confirm|create|generate)$/i],
  [4, /^(?:ok|okay|next|skip|close|done|later|×|✕|x)$/i],
];
// Never click: network play, accounts, settings and help panels, leaving or wiping, links out. Sound toggles are handled apart.
const SKIP_WORDS = /\b(?:multi\s*-?\s*player|online|join|host|server|lobby|room|co-?op|login|log\s*in|sign\s*(?:in|up)|register|account|settings?|options?|preferences|config|controls|help|how\s+to|tutorial|guide|credits?|about|privacy|cookies?|terms|share|tweet|discord|github|download|install|store|shop|buy|purchase|leaderboard|ranking|quit|exit|leave|log\s*out|reset|delete|erase|wipe|clear\s+(?:save|data)|fresh\s+world|full\s*screen|language|edit(?:or)?|watch|replay|demo|ads?|subscribe|donate|feedback|report|menu|back|friends?|invite|party|clan|guild|pause|paused|stop|freeze|halt|can'?t|cannot|can\s+not|unable|failed|error|locked|disabled|unavailable|coming\s+soon)\b|暂停|停止|一時停止|일시정지|пауза|стоп|pausa|多人|联机|聯機|在线|线上|服务器|房间|登录|登錄|注册|设置|設定|设定|选项|選項|帮助|幫助|教程|说明|關於|关于|退出|离开|删除|重置|商店|排行|全屏|语言|編集|编辑|オンライン|ヘルプ|設定|終了|멀티|설정|도움말|종료|multijugador|ajustes|configuración|ayuda|salir|paramètres|aide|quitter|einstellungen|hilfe|beenden|настройки|помощь|выход|мультиплеер/i;
// Sound and music toggles; the probe and the label decide whether they are on.
const SOUND_WORDS = /\b(?:sound|sounds|audio|sfx|music|mute|unmute|muted|volume|speaker)\b|🔇|🔈|🔉|🔊|🎵|🎶|♪|♫|volume_(?:up|off|mute|down)|声音|聲音|音效|音乐|音樂|静音|靜音|サウンド|音楽|ミュート|소리|사운드|음악|음소거|sonido|música|silenciar|\bson\b|musique|muet|\bton\b|musik|stumm|звук|музыка|без звука|suono|musica|\bses\b|müzik/i;
const SOUND_OFF = /unmute|enable\s+(?:\w+\s+)?(?:sound|sounds|audio|music)|\bwith\s+(?:sound|audio)\b|turn\s+on\s+(?:the\s+)?(?:sound|audio|music)|(?:tap|click|press)\s+(?:for|to\s+(?:enable|hear|play|turn\s+on))\s+(?:the\s+)?(?:sound|audio|music)|start\s+(?:the\s+)?(?:audio|sound|music)|allow\s+(?:audio|sound)|со\s+звуком|включить\s+(?:звук|музыку)|con\s+sonido|avec\s+(?:le\s+)?son|mit\s+ton|有声|带声音|(?:sound|audio|music|sfx)\s*(?::|is|=)?\s*off\b|turn\s+(?:sound|audio|music)\s+on|\bmuted\b|sound_off|volume_off|volume_mute|volume[-_ ]?x\b|volume[-_ ]?mute|speaker[-_ ]?(?:off|slash|x)|🔇|开启声音|打开声音|开启音效|打开音效|开启音乐|声音[:：]?\s*关|音效[:：]?\s*关|取消静音|サウンド\s*off|음소거\s*해제|activar sonido|activer le son|ton an\b|включить звук/i;
const SOUND_ON = /(?:^|\b)mute\b(?!d)|disable\s+(?:sound|audio|music)|(?:sound|audio|music|sfx)\s*(?::|is|=)?\s*on\b|turn\s+(?:sound|audio|music)\s+off|sound_on|volume_up|volume[-_ ]?(?:high|2|up)\b|speaker[-_ ]?(?:on|wave)|🔊|🔉|关闭声音|关闭音效|关闭音乐|声音[:：]?\s*开|静音|サウンド\s*on|desactivar sonido|couper le son|ton aus\b|выключить звук/i;
export const WORDS = { GO_WORDS, GO_WHOLE, SKIP_WORDS, SOUND_WORDS, SOUND_OFF, SOUND_ON };

/** Score a button text: 0 to skip, else the best GO_WORDS score (an id or class naming play/start counts too). */
export function goScore(text, attrs = '') {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t && !attrs) return 0;
  if (t.length > 48) return 0;
  if (SKIP_WORDS.test(t)) return 0;
  let best = 0;
  for (const [score, re] of GO_WORDS) if (re.test(t)) best = Math.max(best, score);
  const bare = t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}!]+$/gu, '').replace(/!$/, '');
  for (const [score, re] of GO_WHOLE) if (re.test(bare)) best = Math.max(best, score);
  // Round 4 (swarm bug 80): "restart" and "replay" in an id or class are not "start" and "play".
  if (!best && /(?:^|[-_ ])(?:play|start|begin|go|continue|resume)(?:[-_ ]?(?:btn|button|game))?(?:$|[-_ ])|(?<!re)(?:play|start)(?:btn|button)/i.test(attrs) && !SKIP_WORDS.test(attrs)) best = 6;
  else if (best && /(?<!re)(?:play|start)/i.test(attrs)) best += 1;
  return best;
}
/** Round 4 (swarm bug 80): words of a button that starts the game over. reachPlay never presses one once a start button
 *  has been pressed, and tests the play area for a response before pressing one at all (a HUD's restart button put two
 *  games back at their start, four times in one of them, and play was never reached). */
export const RESTART_WORDS = /(?<![\p{L}\p{N}])(?:restart|retry|reset|re-?play|try\s+again|play\s+again|start\s+over|again|respawn|reintentar|reiniciar|réessayer|recommencer|rejouer|erneut|neustart|nochmal|заново|рестарт|riprova|ricomincia)(?![\p{L}\p{N}])|重新开始|再来一次|重试|重新|リトライ|もう一度|다시/iu;
/** `after`: a start button has been pressed already, so "New game" is a restart too (on a title it is the start button). */
export const isRestart = (b, after = false) => RESTART_WORDS.test(`${b?.text ?? ''} ${b?.label ?? ''}`) || /(?:^|[-_ ])(?:restart|retry|reset|replay)/i.test(b?.attrs ?? '')
  || (after && /(?<![\p{L}\p{N}])new\s+(?:game|run|round|level)(?![\p{L}\p{N}])|新游戏|新遊戲/iu.test(`${b?.text ?? ''} ${b?.label ?? ''}`));
/** A sound toggle's state from its words: 'off' (click it to hear the game), 'on' (leave it) or 'unknown'. `shown`: the
 *  button's own text or label; a bare noun there ("Sound", "Music", "音效") is how games label it while it is on (the
 *  same button says "Muted" or "Sound off" when it is not). */
export function soundState(words, { pressed = null, checked = null, shown = '' } = {}) {
  const w = String(words ?? '');
  if (checked !== null) return checked ? (/mute/i.test(w) && !/unmute/i.test(w) ? 'off' : 'on') : (/mute/i.test(w) && !/unmute/i.test(w) ? 'on' : 'off');
  if (SOUND_OFF.test(w)) return 'off';
  if (SOUND_ON.test(w)) return 'on';
  if (pressed !== null) return /mute/i.test(w) ? (pressed ? 'off' : 'on') : (pressed ? 'on' : 'off');
  // State words: on/off said as a state ("Sound: on", "Звуки включены", "Son activé").
  if (/\b(?:off|disabled)\b|关$|已关闭|オフ|꺼짐|(?<![\p{L}])(?:выкл(?:ючен[аоы]?)?|desactivad[oa]s?|désactivée?s?|aus|deaktiviert|disattivat[oi])(?![\p{L}])/iu.test(w)) return 'off';
  if (/\b(?:on|enabled)\b|开$|已开启|オン|켜짐|(?<![\p{L}])(?:вкл(?:ючен[аоы]?)?|activad[oa]s?|activée?s?|an|aktiviert|attivat[oi])(?![\p{L}])/iu.test(w)) return 'on';
  if (/^[^\p{L}]*(?:sound|sounds|audio|music|sfx|声音|音效|音乐|サウンド|音楽|소리|사운드|음악|sonido|música|son|musique|ton|musik|звук|музыка)(?![\p{L}])/iu.test(String(shown ?? '').trim())) return 'on';
  return 'unknown';
}

// ---- In the page: what is on screen ----
const SCAN = ([soundSrc]) => {
  const SOUND = new RegExp(soundSrc, 'i'), vw = innerWidth, vh = innerHeight;
  const out = { buttons: [], inputs: [], canvas: null, overlay: false, url: location.href };
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const visibleRect = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6 || r.bottom <= 1 || r.right <= 1 || r.top >= vh - 1 || r.left >= vw - 1) return null;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) return null;
    return r;
  };
  const REAL = 'button,a,summary,label,input[type=button],input[type=submit],input[type=image],input[type=checkbox],input[type=radio],[role=button],[role=switch],[role=checkbox],[role=link],[role=menuitem],[onclick]';
  const isReal = el => el.matches(REAL);
  const isClickable = (el, st) => isReal(el) || (st && st.cursor === 'pointer');
  // #22: a tool bar's buttons and keyboard-hint chips ("X Build": a <span class="k">X</span> in the button) are not start buttons.
  const TOOLBAR = '[role=toolbar],[role=menubar],[role=tablist],.toolbar,.tool-bar,.toolbox,.tools,.hotbar,.hot-bar,.inventory,[class*=toolbar],[class*=hotbar],[id*=toolbar],[id*=hotbar]';
  const HUD = '#hud,.hud,[id^=hud-],[class^=hud-],[class*=" hud"],[class*="-hud"],[class*="_hud"]';
  const KEYHINT = 'kbd,.k,.key,.kbd,.keycap,.hotkey,.shortcut,[class*=keycap],[class*=hotkey],[class*=shortcut]';
  // Round 4 (swarm bug 74): where a link leads. 'out': another site; 'self': the page itself (it would only reload the game).
  const samePath = p => p.replace(/\/index\.html?$/i, '/');
  const linkOf = el => {
    const a = el.closest('a[href], area[href]');
    if (!a) return null;
    try {
      const u = new URL(typeof a.href === 'string' ? a.href : a.href.baseVal, document.baseURI);
      if (!/^https?:$/.test(u.protocol)) return null;
      if (u.origin !== location.origin) return 'out';
      if (u.pathname === location.pathname && u.search === location.search && (u.hash || /#$/.test(a.getAttribute('href') || ''))) return null;
      return samePath(u.pathname) === samePath(location.pathname) && (u.search === location.search || !u.search) ? 'self' : null;
    } catch { return null; }
  };
  const seen = new Set();
  const all = document.querySelectorAll('body *');
  let scanned = 0;
  for (const el of all) {
    if (++scanned > 4000) break;
    if (/^(?:SCRIPT|STYLE|CANVAS|NOSCRIPT|TEMPLATE|IFRAME|VIDEO|AUDIO)$/i.test(el.tagName) || el.closest('svg')) continue;
    const st = getComputedStyle(el);
    const clickable = isClickable(el, st);
    const ownText = clean(el.innerText !== undefined ? el.innerText : el.textContent);
    if (!clickable && (el.children.length > 0 || ownText.length > 40 || !ownText)) continue;
    // A part of a real control (a label span in a button) stands for the control; a part that is "clickable" only
    // because it inherits cursor: pointer stands for the element that sets the cursor.
    let target = el;
    const up = !isReal(el) && el.parentElement && el.parentElement.closest(REAL);
    if (up) target = up;
    else if (!isReal(el) && st.cursor === 'pointer') { let p = el; while (p.parentElement && p.parentElement !== document.body && getComputedStyle(p.parentElement).cursor === 'pointer') p = p.parentElement; target = p; }
    if (seen.has(target)) continue;
    const r = visibleRect(target);
    if (!r || r.width * r.height > vw * vh * 0.45) continue;
    seen.add(target);
    const text = clean(target.innerText || target.value || '').slice(0, 80);
    const label = clean([...new Set([target.getAttribute('aria-label'), target.title, target.getAttribute('alt'), target.getAttribute('data-tooltip')].filter(Boolean))].join(' '));
    const svg = target.querySelector && target.querySelector('svg, img, i, span[class*=icon], [class*=material]');
    const attrs = clean([target.id, typeof target.className === 'string' ? target.className : target.getAttribute('class'), svg && (svg.id || svg.getAttribute('class') || svg.getAttribute('alt') || ''), svg && svg.textContent && svg.textContent.length < 30 ? svg.textContent : '',
      target.querySelector && [...target.querySelectorAll('[id],[class]')].slice(0, 6).map(x => (x.id || '') + ' ' + (x.getAttribute('class') || '')).join(' ')].filter(Boolean).join(' '));
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    const covered = !!top && top !== target && !target.contains(top) && !top.contains(target);
    const words = `${text} ${label} ${attrs}`;
    const pressed = target.getAttribute('aria-pressed'), checkedAttr = target.getAttribute('aria-checked');
    const checked = target.tagName === 'INPUT' && /checkbox|radio/i.test(target.type) ? target.checked : checkedAttr === null ? null : checkedAttr === 'true';
    const isSound = (SOUND.test(text) || SOUND.test(label) || SOUND.test(attrs)) && text.length <= 24;
    // Round 3 (swarm bug 48): the label of a field to type or pick in ("Launch velocity m/s" over a number box) is not a
    // button, whatever its words say. A label of a checkbox or radio (a difficulty choice) still is.
    const control = target.tagName === 'LABEL' ? target.control || target.querySelector('input, select, textarea') : null;
    const field = !!control && !/^(?:checkbox|radio|button|submit|image)$/i.test(control.type || '');
    out.buttons.push({ x: Math.round(cx), y: Math.round(cy), w: Math.round(r.width), h: Math.round(r.height), text, label, attrs: attrs.slice(0, 160), covered, clickable: isClickable(target, getComputedStyle(target)),
      real: isReal(target), field, toolbar: !!target.closest(TOOLBAR), hud: !!target.closest(HUD), keyHint: target.tagName === 'KBD' || !!target.querySelector(KEYHINT),
      sound: isSound, words: words.slice(0, 240), pressed: pressed === null ? null : pressed === 'true', checked, tag: target.tagName.toLowerCase(), path: target.id ? `#${target.id}` : null, link: linkOf(target) });
    if (out.buttons.length >= 120) break;
  }
  for (const el of document.querySelectorAll('input[type=text], input:not([type]), input[type=search]')) {
    const r = visibleRect(el); if (!r) continue;
    out.inputs.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), value: el.value, required: el.required, words: clean([el.name, el.id, el.placeholder, el.getAttribute('aria-label')].join(' ')).slice(0, 120), path: el.id ? `#${el.id}` : null });
  }
  for (const el of document.querySelectorAll('input[type=range]')) {
    const r = visibleRect(el); if (!r) continue;
    const words = clean([el.name, el.id, el.getAttribute('aria-label'), el.title, el.closest('label') && el.closest('label').innerText, el.previousElementSibling && el.previousElementSibling.innerText].join(' '));
    if (SOUND.test(words)) out.buttons.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), text: '', label: words.slice(0, 80), attrs: '', covered: false, clickable: true, sound: true, words, range: { value: +el.value, min: +el.min || 0, max: el.max === '' ? 100 : +el.max }, tag: 'input', path: el.id ? `#${el.id}` : null });
  }
  // The biggest canvas, and whether it is what a click in the play area reaches (no menu over it).
  const canvases = [...document.querySelectorAll('canvas')].map(c => ({ c, r: c.getBoundingClientRect() })).filter(x => x.r.width > 60 && x.r.height > 60).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  if (canvases.length) {
    const { c, r } = canvases[0];
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(vw, r.right), y1 = Math.min(vh, r.bottom);
    let hits = 0, pts = 0;
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.35], [0.7, 0.35], [0.3, 0.7], [0.7, 0.7]]) {
      const px = x0 + (x1 - x0) * fx, py = y0 + (y1 - y0) * fy; pts++;
      const top = document.elementFromPoint(px, py);
      if (top && (top === c || top.contains(c) || (top.getBoundingClientRect().width * top.getBoundingClientRect().height < vw * vh * 0.05))) hits++;
    }
    out.canvas = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0), share: +(((x1 - x0) * (y1 - y0)) / (vw * vh)).toFixed(3), hits, pts };
  }
  return out;
};
/**
 * The start/continue candidates in a scanUi result, best first, each with its `score`. Text that is not itself clickable
 * (a heading that says "Start") ranks 3 below real buttons. #22: a button in a tool bar or hotbar counts only for a start
 * or play word (10); one in the HUD, or one carrying a key hint ("X Build", "[E] Use"), only for start or continue words
 * (8 and up); a dismiss word (4–5: "OK", "x") only on a real control. Round 3 (swarm bug 48): never the label of a
 * field to type or pick in ("Launch velocity m/s").
 */
// Round 4 (swarm bug 74): a link to another site is never a start button. A link to the page itself is pressed only on a
// guarded page (guardNavigation cancels the reload, so a start button written <a href=""> still starts the game).
const leadsAway = (ui, b) => b.link === 'out' || (b.link === 'self' && !ui?.guarded);
export function goButtons(ui) {
  return (ui?.buttons ?? []).filter(b => !b.sound && !b.covered && !b.range && !b.field && !leadsAway(ui, b))
    .map(b => ({ ...b, score: goScore(b.text || b.label, b.attrs) - (b.clickable ? 0 : 3) }))
    .filter(b => b.score >= (b.toolbar ? 10 : b.hud || b.keyHint ? 8 : 4) && (b.score >= 6 || b.real !== false))
    .sort((a, b) => b.score - a.score || b.w * b.h - a.w * a.h);
}
export async function scanUi(page) {
  const ui = await within(10000, page.evaluate(SCAN, [SOUND_WORDS.source]), 'scanning the page')
    .catch(() => ({ buttons: [], inputs: [], canvas: null, error: true }));
  ui.guarded = !!navState(page)?.installed;
  // What reloaded the page or tried to leave it is not offered again.
  if (ui.buttons?.length && navState(page)?.avoidPoints.length) ui.buttons = ui.buttons.filter(b => !pressedBefore(page, b.x, b.y));
  return ui;
}

// ---- PNG and pixel helpers (Node; no dependencies) ----
/** Decode an 8-bit PNG (grey, RGB, palette, grey+alpha or RGBA; not interlaced) to {width, height, data: RGBA}. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), kind = buf.toString('latin1', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`PNG bit depth ${depth}${interlace ? ', interlaced' : ''} is not supported`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!ch) throw new Error(`PNG colour type ${type} is not supported`);
  const raw = inflateSync(Buffer.concat(idat)), stride = width * ch, px = Buffer.alloc(stride * height);
  for (let y = 0, i = 0; y < height; y++) {
    const f = raw[i++], row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++, i++) {
      const a = x >= ch ? px[row + x - ch] : 0, b = y ? px[prev + x] : 0, c = y && x >= ch ? px[prev + x - ch] : 0, v = raw[i];
      let p;
      if (f === 0) p = v; else if (f === 1) p = v + a; else if (f === 2) p = v + b; else if (f === 3) p = v + ((a + b) >> 1);
      else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[row + x] = p & 255;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    if (ch === 4) { out[j] = px[i * 4]; out[j + 1] = px[i * 4 + 1]; out[j + 2] = px[i * 4 + 2]; out[j + 3] = px[i * 4 + 3]; }
    else if (ch === 3) { out[j] = px[i * 3]; out[j + 1] = px[i * 3 + 1]; out[j + 2] = px[i * 3 + 2]; out[j + 3] = 255; }
    else if (type === 3) { const k = px[i]; out[j] = palette[k * 3]; out[j + 1] = palette[k * 3 + 1]; out[j + 2] = palette[k * 3 + 2]; out[j + 3] = trns && k < trns.length ? trns[k] : 255; }
    else if (ch === 2) { out[j] = out[j + 1] = out[j + 2] = px[i * 2]; out[j + 3] = px[i * 2 + 1]; }
    else { out[j] = out[j + 1] = out[j + 2] = px[i]; out[j + 3] = 255; }
  }
  return { width, height, data: out };
}
/** Encode RGBA pixels as a PNG (filter 0, zlib level 6). */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1); }
  const chunk = (kind, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(kind, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
/** Share of pixels whose largest channel difference is over `tol`, sampled every `step` pixels (decoded RGBA images). */
export function diffFraction(a, b, { tol = 32, step = 3 } = {}) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return 1;
  let n = 0, m = 0;
  for (let i = 0; i < a.data.length; i += 4 * step) { m++; if (Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > tol) n++; }
  return m ? n / m : 0;
}
const grab = async page => { try { return decodePng(await within(15000, page.screenshot({ type: 'png' }), 'a screenshot')); } catch { return null; } };

// ---- Steps ----
// One step runner for every tool (round 2, 2026-10-02; check.mjs delegates its own runSteps here). Every step kind
// check.mjs ran, plus the driver's, with these fixes from the coverage pilot:
//   #13 pointer lock: while the pointer is locked (really or faked), a click or right click at a point is pressed where
//       the mouse already is, never after a move (a move turns a mouse-look camera); an element click becomes
//       element.click(). {click: 'here'} always clicks in place. Points can be viewport-relative ("50%") or relative to
//       the game's biggest canvas ({in: 'canvas'}), so steps don't depend on the 1280×720 viewport the tools use.
//   #3  animated elements: {clickSelector} and {text} wait for the element to be visible, not for Playwright's "stable"
//       state; one that keeps moving (a pulsing map node) is clicked where it is now, and the click is checked to have
//       reached it (else element.click()).
//   #28 {query: '?speed=12'} reloads the game with that URL query (check.play.query; reachPlay records it in `script`).
export const STEP_KINDS = ['wait', 'click', 'key', 'down', 'up', 'hold', 'select', 'clickSelector', 'waitFor', 'text', 'fill', 'move', 'mouse', 'rclick', 'wheel', 'domClick', 'range', 'query'];
const COORD = /^-?\d+(?:\.\d+)?%$/;
/** The kind of a step (its first STEP_KINDS key), or null. */
export const stepKind = s => (s && typeof s === 'object' ? STEP_KINDS.find(k => s[k] !== undefined) ?? null : null);
/** True when the page's pointer is locked (a real lock, or the probe's fake). Evaluated in the game's frame. */
export async function isPointerLocked(page) {
  return within(5000, page.evaluate(() => !!document.pointerLockElement), 'reading the pointer lock').catch(() => false);
}
/** The game's biggest canvas, in page coordinates: {x, y, w, h}, or null. */
async function canvasBox(page) {
  return within(5000, page.evaluate(() => { const r = [...document.querySelectorAll('canvas')].map(e => e.getBoundingClientRect()).filter(r => r.width > 60 && r.height > 60).sort((a, b) => b.width * b.height - a.width * a.height)[0]; return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; }), 'finding the canvas').catch(() => null);
}
/** A step's point in page pixels. p: [x, y] (numbers are pixels, "50%" a share of the box), 'centre'/'center', or
 *  'here' (null: where the mouse is). where: 'canvas' measures from the game's biggest canvas, else the viewport. */
export async function resolvePoint(page, p, where = null) {
  if (p === 'here') return null;
  const v = page.viewportSize() ?? { width: 1280, height: 720 };
  const box = where === 'canvas' ? (await canvasBox(page)) ?? { x: 0, y: 0, w: v.width, h: v.height } : { x: 0, y: 0, w: v.width, h: v.height };
  if (p === 'centre' || p === 'center') return [Math.round(box.x + box.w / 2), Math.round(box.y + box.h / 2)];
  if (!Array.isArray(p) || p.length !== 2) throw new Error(`not a point: ${JSON.stringify(p)} ([x, y], "centre" or "here")`);
  const one = (c, size, origin) => { if (typeof c === 'number' && Number.isFinite(c)) return Math.round(origin + c); if (typeof c === 'string' && COORD.test(c)) return Math.round(origin + size * parseFloat(c) / 100); throw new Error(`not a coordinate: ${JSON.stringify(c)} (pixels, or "50%")`); };
  return [one(p[0], box.w, box.x), one(p[1], box.h, box.y)];
}
/** Click (or right click) at a point, pointer-lock safe: in place when locked or when p is 'here'. Returns how. */
export async function clickPoint(page, p, { button = 'left', where = null } = {}) {
  const locked = p !== 'here' && await isPointerLocked(page);
  if (p === 'here' || locked) { await page.mouse.down({ button }); await page.mouse.up({ button }); return locked ? 'where the mouse is (the pointer is locked: a move would turn the camera)' : 'where the mouse is'; }
  const [x, y] = await resolvePoint(page, p, where);
  await page.mouse.click(x, y, { button });
  return `at ${x}, ${y}`;
}
/**
 * Click an element (a Playwright locator) the way a player would, without waiting for it to hold still: visible first;
 * a normal click; if Playwright says it never stops moving (an animated button), a click where it is now, checked to have
 * reached it; if something covers it, or the click didn't reach it, element.click(). Under a locked pointer,
 * element.click() straight away. Returns how it clicked; throws when the element never shows.
 */
export async function clickElement(page, loc, { timeout = 5000 } = {}) {
  await loc.waitFor({ state: 'visible', timeout });
  // An element handle, not the locator: once a click has done its job the element may be gone, and a locator would wait for it.
  const h = await loc.elementHandle({ timeout: 2000 });
  const domClick = () => h.evaluate(el => { el.click(); });
  if (await isPointerLocked(page)) { await domClick(); return 'element.click() (the pointer is locked)'; }
  let why = '';
  // Under play-compare's held clock (window.__gfLock) the page's animation frames run only when the tool steps one, so
  // Playwright's wait for the element to hold still can never end: it is skipped (round 3; it cost 1.5 s a page a click).
  const held = await within(5000, page.evaluate(() => !!window.__gfLock), 'reading the clock').catch(() => false);
  if (!held) {
    try { await h.click({ timeout: 1500 }); return 'clicked'; } catch (e) { why = String(e?.message ?? e); }
    if (/intercepts pointer events|not enabled|disabled/i.test(why)) { await domClick(); return `element.click() (${/intercepts/i.test(why) ? 'something covers it' : 'it says it is disabled'})`; }
    if (/detached|not attached/i.test(why)) return 'clicked (it went away)';
  }
  // "not stable" (it animates) or a slow page: click where it is now, and check the click reached it (a capture listener
  // on the element sees the click before the game's own handlers run, even if they then remove it).
  await h.evaluate(el => { el.__gfHit = false; el.__gfHitFn = () => { el.__gfHit = true; }; el.addEventListener('click', el.__gfHitFn, { capture: true }); }).catch(() => {});
  await h.click({ force: true, timeout: 3000 }).catch(() => {});
  const hit = await h.evaluate(el => { const ok = !!el.__gfHit; el.removeEventListener('click', el.__gfHitFn, { capture: true }); delete el.__gfHit; delete el.__gfHitFn; return ok; }).catch(() => false);
  if (hit) return held ? 'clicked (the clock is held: no wait for it to hold still)' : 'clicked where it is now (it kept moving)';
  if (!(await h.evaluate(el => el.isConnected).catch(() => false))) throw new Error('it went away before the click reached it');
  await domClick();
  return 'element.click() (a mouse click did not reach it)';
}
/** check.play.query as "?a=1&b=2" (a leading ? optional in the manifest), or ''. */
export function playQuery(manifest) {
  const q = manifest?.check?.play?.query;
  return typeof q === 'string' && q.replace(/^\?/, '').trim() ? `?${q.replace(/^\?/, '').trim()}` : '';
}
/** A URL with `query` ("?speed=12", or a manifest whose check.play.query is set) merged into its own query. */
export function withPlayQuery(url, queryOrManifest) {
  const q = typeof queryOrManifest === 'string' ? queryOrManifest : playQuery(queryOrManifest);
  if (!q) return url;
  const u = new URL(url);
  for (const [k, v] of new URLSearchParams(q)) u.searchParams.set(k, v);
  return u.href;
}
/**
 * check.play.avoidKeys (round 3, swarm bug 6): keys the tools must never press on their own, as KeyboardEvent.code
 * names (["KeyR"] for a game where R restarts: its capture then saw a fresh title and called 57 sprites unused). The
 * seeded input (fuzz), the pokes that look for play (Enter, Space), the response test and recover leave them out; the
 * manifest's own steps may still press them. reachPlay remembers them for the page, so a fuzz(page) after it needs no option.
 */
export function avoidKeysOf(manifest) {
  const k = manifest?.check?.play?.avoidKeys;
  return Array.isArray(k) ? [...new Set(k.filter(x => typeof x === 'string' && x))] : [];
}
const AVOID = new WeakMap();
const avoided = (page, list = null) => new Set([...(list ?? AVOID.get(page) ?? []), ...(navState(page)?.avoidKeys ?? [])]);
const hasQuery = (href, q) => { try { const have = new URL(href).searchParams; return [...new URLSearchParams(q)].every(([k, v]) => have.get(k) === v); } catch { return false; } };
/** Reload the game (its own frame, in check.mjs's --tree harness too) with `query` merged in, unless it already has it.
 *  Returns 'already' | 'reloaded' | 'srcdoc' (an inline page has no URL to add a query to). */
export async function applyQuery(page, query, { timeout = 45000 } = {}) {
  const href = await within(5000, page.evaluate(() => location.href), 'reading the URL');
  if (!/^https?:/.test(href)) return 'srcdoc';
  if (hasQuery(href, query)) return 'already';
  const target = withPlayQuery(href, query);
  // The old document is marked, so the new one is known by the mark's absence (a game may rewrite its own URL once
  // loaded, as rts-lite adds ?seed= and &difficulty=, so the URL alone can't tell).
  const tok = expectLoad(page, timeout + 5000);   // the tool's own reload (round 4: not "the game reloaded itself")
  const settle = () => { if (tok) tok.until = Math.min(tok.until, Date.now() + 1500); };
  await within(5000, page.evaluate(u => { window.__gfOldDocument = true; location.replace(u); }, target), 'reloading').catch(() => {});
  const end = Date.now() + timeout;
  for (;;) {
    const st = await within(5000, page.evaluate(() => [location.href, document.readyState, !!window.__gfOldDocument]), 'reading the URL').catch(() => null);
    if (st && !st[2] && st[1] === 'complete' && hasQuery(st[0], query)) { settle(); return 'reloaded'; }
    if (Date.now() > end) { settle(); throw new Error(`the page did not reload with ${query} in ${timeout / 1000} s`); }
    await sleep(page, 150);
  }
}

const xpathText = s => (!s.includes('"') ? `"${s}"` : !s.includes("'") ? `'${s}'` : `concat(${s.split('"').map(p => `"${p}"`).join(`, '"', `)})`);
/**
 * The visible elements a {text} step means (a Playwright locator). The text is exact unless the step says
 * `exact: false` (then any element containing it, in any case). Exact means the element's whole text, or (round 3, swarm
 * bugs 38 and 55) its own text beside a caption in a child element: "Need to see it in motion?" finds
 * <summary>Need to see it in motion? <span>SPOILERS AHEAD</span></summary>, and "Material range" finds
 * <span>Material range<small>3 objects</small></span>. Both used to time out.
 */
export function textLocator(page, s) {
  if (s.exact === false) return page.getByText(s.text, { exact: false }).filter({ visible: true });
  return page.getByText(s.text, { exact: true }).or(ownText(page, s)).filter({ visible: true });
}
const ownText = (page, s) => page.locator(`xpath=//*[not(self::script) and not(self::style) and text()[normalize-space(.)=${xpathText(String(s.text).replace(/\s+/g, ' ').trim())}]]`);

async function runOne(page, s) {
  const k = stepKind(s);
  if (!k) throw new Error(`not a step (one of ${STEP_KINDS.join(', ')})`);
  switch (k) {
    case 'wait': await page.waitForTimeout(Number(s.wait) || 0); return 'waited';
    case 'click': return clickPoint(page, s.click, { where: s.in ?? null });
    case 'rclick': return clickPoint(page, s.rclick, { button: 'right', where: s.in ?? null });
    case 'key': await page.keyboard.press(s.key); return 'pressed';
    case 'down': await page.keyboard.down(s.down); return 'held';
    case 'up': await page.keyboard.up(s.up); return 'released';
    case 'hold': await page.keyboard.down(s.hold); await page.waitForTimeout(s.ms ?? 1000); await page.keyboard.up(s.hold); return 'held and released';
    case 'select': await page.selectOption(s.select[0], s.select[1], { timeout: s.timeout ?? 5000 }); return 'selected';
    case 'clickSelector': {
      const all = page.locator(s.clickSelector).filter({ visible: true });
      await all.first().waitFor({ state: 'visible', timeout: s.timeout ?? 5000 });
      const n = await all.count();
      return clickElement(page, all.nth(s.last ? Math.max(0, n - 1) : Math.min(s.nth ?? 0, Math.max(0, n - 1))), { timeout: s.timeout ?? 5000 });
    }
    case 'text': {
      const any = textLocator(page, s);
      try { await any.first().waitFor({ state: 'visible', timeout: s.timeout ?? 5000 }); }
      catch (e) {
        // Say why (swarm bug 55): the text is there, but only as part of a longer one.
        const part = s.exact === false ? 0 : await page.getByText(s.text, { exact: false }).filter({ visible: true }).count().catch(() => 0);
        if (part) throw new Error(`no visible element's text is exactly ${JSON.stringify(s.text)}, but ${part} contain${part === 1 ? 's' : ''} it: add "exact": false to the step, or use clickSelector`);
        throw e;
      }
      // An element whose whole text it is comes first; one that has it beside a caption only when there is none.
      const whole = s.exact === false ? any : page.getByText(s.text, { exact: true }).filter({ visible: true });
      const all = s.exact === false || await whole.count() ? whole : any, n = await all.count();
      // Round 4 (swarm bug 90): with exact: false the first element that contains the words may be a paragraph above the
      // button. The first one a player could click (a control, or one under cursor: pointer) is meant; else the first.
      let at = s.last ? Math.max(0, n - 1) : 0, which = '';
      if (s.exact === false && !s.last && n > 1) {
        for (let i = 0; i < Math.min(n, 12); i++) {
          const can = await all.nth(i).evaluate(el => !!el.closest('button,a,summary,label,input,select,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[onclick]') || getComputedStyle(el).cursor === 'pointer').catch(() => false);
          if (can) { at = i; break; }
        }
        which = at ? ` (match ${at + 1} of ${n}: the first that can be clicked)` : '';
      }
      const how = await clickElement(page, all.nth(at), { timeout: s.timeout ?? 5000 });
      return (all === whole ? how : `${how} (its own text, beside a caption)`) + which;
    }
    case 'waitFor': await page.waitForFunction(s.waitFor, null, { timeout: s.timeout ?? 15000 }); return 'held';
    case 'fill': await page.fill(s.fill, String(s.value ?? ''), { timeout: s.timeout ?? 5000 }); return 'filled';
    case 'move': { const [x, y] = await resolvePoint(page, s.move, s.in ?? null); await page.mouse.move(x, y, { steps: s.steps ?? 1 }); return `moved to ${x}, ${y}`; }
    case 'mouse': await (s.mouse === 'down' ? page.mouse.down({ button: s.button ?? 'left' }) : page.mouse.up({ button: s.button ?? 'left' })); return s.mouse;
    case 'wheel': await page.mouse.wheel(0, s.wheel); return 'scrolled';
    case 'domClick': {
      const [x, y] = await resolvePoint(page, s.domClick, s.in ?? null);
      const tag = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); if (!el) return null; el.click(); return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''); }, [x, y]);
      if (!tag) throw new Error(`nothing at ${x}, ${y}`);
      return `element.click() on ${tag}`;
    }
    case 'range': {
      const [x, y] = await resolvePoint(page, s.range.slice(0, 2), s.in ?? null);
      // Round 4 (swarm bug 83): the value goes in through the prototype's setter. React keeps its own setter on the
      // element to tell its changes from the user's; set through that one, the input event carried "no change" and a
      // controlled slider stayed where it was while the step said ok. The value is read back.
      const r = await page.evaluate(async ([x, y, v]) => {
        const el = document.elementFromPoint(x, y);
        if (!el || el.type !== 'range') return null;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set, before = el.value;
        set.call(el, String(v));
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        const want = el.value;   // the slider's own rounding of v (step, min, max)
        await new Promise(ok => { const ch = new MessageChannel(); ch.port1.onmessage = () => ok(); ch.port2.postMessage(0); });
        return { want, before, now: el.value };
      }, [x, y, s.range[2]]);
      if (!r) throw new Error(`no slider at ${x}, ${y}`);
      if (r.want !== r.before && r.now === r.before) throw new Error(`the slider at ${x}, ${y} went back to ${r.now}: the game holds its value and did not take ${r.want}`);
      return r.now === r.want ? `set to ${r.now}` : `set to ${r.want}; the game then put it at ${r.now}`;
    }
    case 'query': return `${await applyQuery(page, s.query)} with ${s.query}`;
  }
  return 'skipped';
}

/** A `how` that says an element step didn't go through a plain player click (check.mjs reports these as `forced`). */
const FORCED_HOW = /kept moving|did not reach it|something covers it|says it is disabled/;
/**
 * Run steps in order. A step that can't run (gone, covered, timed out) is recorded and skipped; the rest still run.
 * Every step is bounded in time, so a frozen game fails its own step instead of hanging a batch.
 * Returns {ok, results: [{i, kind, ok, how?, error?, ms}], ran, failed: [{i, step, kind, error}], forced: [{i, step,
 * how}]}: `ran`, `failed` and `forced` are check.mjs's shape (round-2 integration: check.mjs delegates here), where
 * `forced` lists element clicks that needed force or element.click() (an animated, covered or disabled element).
 * strict: throw on the first step that fails instead (the error names it). log: called with a line per step.
 */
export async function runSteps(page, steps = [], { strict = false, log = null, until = null } = {}) {
  const results = [], list = Array.isArray(steps) ? steps : [];
  let notRun = 0;
  const done = () => ({ ok: results.every(r => r.ok), results, ran: list.length - notRun, notRun,
    failed: results.filter(r => !r.ok).map(r => ({ i: r.i, step: list[r.i], kind: r.kind, error: r.error })),
    forced: results.filter(r => r.ok && FORCED_HOW.test(r.how ?? '')).map(r => ({ i: r.i, step: list[r.i], how: r.how })),
    navigation: pageNavigation(page) });
  for (const [i, s] of list.entries()) {
    const t = Date.now(), kind = stepKind(s);
    // Round 4 (swarm bug 79): past `until` no further step starts (the one in flight is bounded by its own limit), and
    // the first step left out says so, so the steps never run on under whatever the tool does next.
    if (until !== null && t > until) {
      notRun = list.length - i;
      const error = `not run: the steps before it used up their time (${notRun} step${notRun === 1 ? '' : 's'} left out)`;
      results.push({ i, kind, ok: false, error, ms: 0 });
      log?.(`step ${i + 1} ${kind ?? '?'} ${error}`);
      if (strict) throw new Error(`step ${i + 1} (${JSON.stringify(s).slice(0, 80)}): ${error}`);
      break;
    }
    if (kind && kind !== 'wait' && kind !== 'waitFor') { const at = s.click ?? s.rclick ?? s.domClick; noteInput(page, `step ${i + 1} ${JSON.stringify(s).slice(0, 60)}`, { key: kind === 'key' ? s.key : null, point: Array.isArray(at) && at.every(Number.isFinite) && !s.in ? at : null }); }
    const limit = Math.max(20000, (s?.timeout ?? 0) + 8000, (Number(s?.wait) || 0) + 5000, (s?.ms ?? 0) + 5000, kind === 'query' ? 60000 : 0);
    try {
      const how = await within(limit, runOne(page, s), `step ${i + 1} (${kind ?? '?'})`);
      results.push({ i, kind, ok: true, how, ms: Date.now() - t });
      if (log && kind !== 'wait') log(`step ${i + 1} ${kind}: ${how}`);
    } catch (e) {
      const error = String(e?.message ?? e).split('\n')[0].slice(0, 240);
      results.push({ i, kind, ok: false, error, ms: Date.now() - t });
      log?.(`step ${i + 1} ${kind ?? '?'} failed: ${error}`);
      if (strict) throw new Error(`step ${i + 1} (${JSON.stringify(s).slice(0, 80)}): ${error}`);
    }
  }
  return done();
}
/** The same runner, named as before (asset-coverage.mjs, capture-code-sounds.mjs and the tests import it). */
export const runPlaySteps = (page, steps = [], opts = {}) => runSteps(page, steps, opts);

// ---- Reaching play ----
const viewport = page => page.viewportSize() ?? { width: 1280, height: 720 };
/**
 * Get past menus into real play. Returns what it did and the evidence it reached play:
 *   reached     true when input changed the picture more than idle animation did, or (no canvas) every start button is gone
 *   how         'input-response' | 'ready' (check.play.ready held) | 'no-menu' | 'none'
 *   actions     [{t, what}] in order; script: runPlaySteps steps that replay them with the same gaps
 *   sound       {toggle, state, clicked, before, after, started} (null when no toggle and sound was not asked for)
 *   steps       {ran, failed: [{step, kind, error}]} for the manifest's steps (null when it has none)
 *   query       {query, how} when check.play.query is set ('reloaded', 'already', 'srcdoc' or 'failed (…)')
 *   evidence    {response: {idle, input}, audio: activity, pointerLock, canvas}
 * Order: check.play.query (a reload), check.play.sound or a sound toggle that says it is off, the manifest's steps
 * (check.steps, then check.play.steps), then the heuristics.
 */
export async function reachPlay(page, { dir = null, manifest = {}, seed = 1, log = () => {}, sound = true, budgetMs = 45000, settleMs = 1500,
  stepsBudgetMs = Number(process.env.GF_PLAY_STEPS_MS) || 70000, totalMs = null } = {}) {
  const t0 = Date.now(), actions = [], script = [], rand = rng(seed + 101);
  let last = t0, tHeur = t0;
  // `at`: when the input happened (default now); the script waits the same gap before it on a replay.
  const mark = (what, step, at = Date.now(), press = {}) => { actions.push({ t: at - t0, what }); if (step) { if (at - last > 30) script.push({ wait: at - last }); script.push(...[step].flat()); last = Date.now(); noteInput(page, what, press); } log(what); };
  // Round 4 (swarm bug 74): what an input did to the page. `seq` grows with every reload and every stopped navigation.
  const navNote = (seq0, what) => { if (navSeq(page) === seq0) return false; mark(`${what}: ${lastNavText(page)}. It is not pressed again`, null); return true; };
  const play = manifest?.check?.play ?? {};
  const avoid = new Set(avoidKeysOf(manifest));
  try { AVOID.set(page, [...avoid]); } catch { /* not an object a WeakMap can hold */ }
  const out = { reached: false, how: 'none', ms: 0, actions, script, sound: null, steps: null, evidence: {}, why: null, navigation: null };
  // Round 4 (swarm bug 79): the manifest's steps have their own time (stepsBudgetMs, or GF_PLAY_STEPS_MS in the
  // environment), and the heuristics' budget starts when the steps end. totalMs caps both (default: their sum).
  const total = totalMs ?? stepsBudgetMs + budgetMs;
  const left = () => Math.min(budgetMs - (Date.now() - tHeur), total - (Date.now() - t0));
  // 0. check.play.query (a test flag such as ?speed=12): reload with it unless the tool loaded the game with it already.
  const query = playQuery(manifest);
  if (query) {
    const q0 = Date.now(), how = await applyQuery(page, query).catch(e => `failed (${String(e?.message ?? e).slice(0, 120)})`);
    out.query = { query, how };
    if (how === 'reloaded') mark(`reloaded the game with ${query} (check.play.query)`, { query }, q0);
    else if (how === 'already') { script.push({ query }); mark(`the game was loaded with ${query} (check.play.query)`, null); }
    else mark(`check.play.query ${query}: ${how}`, null);
  }
  await sleep(page, settleMs); mark(`waited ${settleMs} ms for the page`, null);
  const steps = [...(Array.isArray(manifest?.check?.steps) ? manifest.check.steps : []), ...(Array.isArray(play.steps) ? play.steps : [])];
  const soundState0 = { done: false, tries: 0 };
  const doSound = async (ui, phase = 'title') => {
    if (!sound || soundState0.done || play.sound === false) return;
    // check.play.sound is tried at most three times (first screen, after the steps, in play): a missing button costs its timeout each time.
    if (play.sound && typeof play.sound === 'object' && soundState0.tries++ >= 3) return;
    const r = await turnSoundOn(page, ui, { play, mark, phase });
    if (r) { out.sound = r; if (r.clicked || r.state === 'on') soundState0.done = true; }
  };
  // 1. Sound first (check.play.sound, or a toggle on the first screen that says it is off), so the sounds the steps make
  //    are heard. Steps that press a sound toggle themselves keep that job: the heuristic waits until after them.
  const stepsDoSound = steps.some(s => typeof s?.clickSelector === 'string' && /sound|audio|mute|music|volume|sfx/i.test(s.clickSelector) || typeof s?.text === 'string' && SOUND_WORDS.test(s.text));
  if (sound && play.sound !== false && (play.sound || !stepsDoSound)) await doSound(play.sound ? { buttons: [] } : await scanUi(page), 'title');
  // 2. The game's own steps.
  if (steps.length) {
    const s0 = Date.now();
    // Not raced against a timer any more: an abandoned runSteps went on pressing its steps under the heuristics and the
    // tool's seeded input, and the report said "step 0 null: timed out". Each step has its own limit, no step starts
    // past the budget, and the step that failed or was left out is named.
    const r = await runSteps(page, steps, { log, until: s0 + Math.max(10000, stepsBudgetMs) });
    out.steps = { ran: r.ran, failed: r.failed.map(x => ({ step: x.i, kind: x.kind, error: x.error })), ms: Date.now() - s0, ...(r.notRun ? { notRun: r.notRun, budgetMs: Math.max(10000, stepsBudgetMs) } : {}) };
    mark(`ran ${r.ran} of ${steps.length} manifest step(s) in ${((Date.now() - s0) / 1000).toFixed(1)} s${out.steps.failed.length ? `, ${out.steps.failed.length} failed (${out.steps.failed.slice(0, 2).map(f => `step ${f.step + 1} ${f.kind}: ${f.error}`).join('; ')})` : ''}`, steps.slice(0, r.ran), s0);
    tHeur = Date.now();
  }
  const tried = new Map(), pokes = ['Enter', 'canvas', 'Space', 'canvas'].filter(p => !avoid.has(p));
  let poke = 0, readyHeld = false, rounds = 0, idleRounds = 0, started = false, tested = false, movedAlone = 0;
  while (left() > 0 && rounds++ < 14) {
    if (play.ready) { readyHeld = await within(5000, page.evaluate(play.ready), 'check.play.ready').catch(() => false); if (readyHeld) { out.how = 'ready'; break; } }
    const ui = await scanUi(page);
    await doSound(ui);
    const go = goButtons(ui).filter(b => (tried.get(`${b.text}|${b.x}|${b.y}`) ?? 0) < 2 && !(started && isRestart(b, true)));
    // #22: once a start button has been pressed and the play area is open, check for play before pressing anything that
    // isn't a start or continue button (a HUD's "X Build" tool, a dismiss-word in the HUD). Round 4 (swarm bug 80): and
    // before pressing a restart button at all.
    const onCanvas = ui.canvas && ui.canvas.share > 0.2 && ui.canvas.hits >= 3;
    if (go.length && !(onCanvas && !tested && (started ? go[0].score < 8 : isRestart(go[0])))) {
      const b = go[0], key = `${b.text}|${b.x}|${b.y}`;
      tried.set(key, (tried.get(key) ?? 0) + 1);
      // A required name first (a character name, a nickname): the game won't start with it empty.
      for (const inp of ui.inputs) if (!inp.value && (inp.required || /name|nick|player|昵称|名字|名前|이름|nombre|nom\b/i.test(inp.words)) && !/seed|search|种子|搜索/i.test(inp.words)) {
        await page.mouse.click(inp.x, inp.y).catch(() => {}); await page.keyboard.type('Player', { delay: 20 }).catch(() => {});
        mark(`typed a name into ${inp.path ?? inp.words}`, inp.path ? { fill: inp.path, value: 'Player' } : { click: [inp.x, inp.y] });
      }
      // Under a locked pointer a mouse click goes to the locked element (and its move turns the camera): click the button in the page.
      const seq0 = navSeq(page), name = `"${(b.text || b.label || b.attrs).slice(0, 40)}"`, press = { point: [b.x, b.y] };
      noteInput(page, `clicked ${name} (score ${b.score})`, press);
      if (await isPointerLocked(page)) { await runSteps(page, [{ domClick: [b.x, b.y] }]); noteInput(page, `clicked ${name} (score ${b.score})`, press); mark(`clicked ${name} in the page (score ${b.score}; the pointer is locked)`, { domClick: [b.x, b.y] }, Date.now(), press); }
      else { await page.mouse.click(b.x, b.y).catch(() => {}); mark(`clicked ${name} (score ${b.score})`, { click: [b.x, b.y] }, Date.now(), press); }
      await sleep(page, 900);
      // Round 4 (swarm bug 74): a button that reloaded the game or tried to leave it started nothing.
      if (navNote(seq0, `clicking ${name} did not start the game`)) { tried.set(key, 2); continue; }
      // Round 4 (swarm bug 80): once a start button has been pressed, a restart button is HUD furniture.
      if (b.score >= 8) started = true;
      tested = false;
      idleRounds = 0;
      continue;
    }
    // No menu button: is the canvas what the player reaches, and does input move the picture?
    if (onCanvas || idleRounds > 0) {
      const r = await responseTest(page, ui, { mark, rand, avoid });
      out.evidence.response = r; tested = true;
      if (started) movedAlone = Math.max(movedAlone, r.idle);
      if (r.responds) { out.reached = true; out.how = 'input-response'; break; }
    }
    if (poke < pokes.length) {
      const p = pokes[poke++];
      if (p === 'canvas') {
        // In place while the pointer is locked: a move would turn a mouse-look camera.
        if (await isPointerLocked(page)) { noteInput(page, 'clicked where the mouse is'); await page.mouse.down().catch(() => {}); await page.mouse.up().catch(() => {}); mark('clicked where the mouse is (the pointer is locked)', { click: 'here' }); }
        else { const c = ui.canvas, v = viewport(page), x = Math.round(c ? c.x + c.w / 2 : v.width / 2), y = Math.round(c ? c.y + c.h / 2 : v.height / 2);
          if (pressedBefore(page, x, y)) { idleRounds++; continue; }
          noteInput(page, 'clicked the middle of the play area', { point: [x, y] });
          const seq0 = navSeq(page);
          await page.mouse.click(x, y).catch(() => {}); mark('clicked the middle of the play area', { click: [x, y] }, Date.now(), { point: [x, y] });
          await sleep(page, 700); navNote(seq0, 'the click in the middle of the play area'); idleRounds++; continue; }
      } else if (!avoided(page).has(p)) {
        const seq0 = navSeq(page);
        noteInput(page, `pressed ${p}`, { key: p });
        await page.keyboard.press(p).catch(() => {}); mark(`pressed ${p}`, { key: p }, Date.now(), { key: p });
        await sleep(page, 700); navNote(seq0, `pressing ${p}`); idleRounds++; continue;
      }
      await sleep(page, 700);
      idleRounds++;
      continue;
    }
    if (!ui.canvas) { out.how = 'no-menu'; out.reached = !goButtons(ui).some(b => b.score >= 8); break; }
    break;
  }
  if (!out.reached && out.how === 'none' && readyHeld) out.reached = true;
  if (out.how === 'ready') out.reached = true;
  // Sound after play too: some games show their toggle only in the HUD.
  if (sound && !soundState0.done && play.sound !== false) await doSound(await scanUi(page), 'play');
  out.evidence.audio = await audioActivity(page);
  out.evidence.pointerLock = out.evidence.audio?.lock ?? null;
  const ui = await scanUi(page);
  out.evidence.canvas = ui.canvas;
  if (out.sound && !out.sound.after) out.sound.after = out.evidence.audio;
  // Started: audio activity grew after the click, right away or by the end (a game may only make sound in play).
  const grew = (a, b) => !!(a && b && (a.events > b.events || a.media > b.media || (a.running > 0 && b.running === 0)));
  if (out.sound) out.sound.started = out.sound.clicked ? grew(out.sound.after, out.sound.before) || grew(out.evidence.audio, out.sound.before) : !!(out.evidence.audio && (out.evidence.audio.events || out.evidence.audio.media));
  if (!out.reached) out.why = ui.canvas ? (out.evidence.response ? 'input did not change the picture more than idle animation' : 'a menu or overlay still covers the play area') : 'no canvas, and start buttons are still showing';
  // Round 3 (swarm bug 25): a simulation or an idle game plays on its own and has no keys to answer. The test can't tell
  // that from a title screen that animates, so it stays "not reached"; say what to do about it.
  if (!out.reached && started && movedAlone > 0.0005) out.why += '; a start button was pressed and the picture then moved on its own, so if this is a simulation or an idle game (no keys to answer), set check.play.ready to an expression that is true in play (and check.play.avoidKeys if Space or Enter pauses it)';
  if (!out.reached && out.steps?.notRun) out.why += `; ${out.steps.notRun} of the manifest's steps were left out because the steps before them took ${Math.round(out.steps.ms / 1000)} s of their ${Math.round(out.steps.budgetMs / 1000)} s (raise it with GF_PLAY_STEPS_MS)`;
  // Round 4 (swarm bug 74): what happened to the page. A tool must fail on navigation.lost, never report an empty page.
  out.navigation = pageNavigation(page);
  if (out.navigation.lost && !out.reached) out.why = `${out.navigation.problem}; ${out.why}`;
  out.ms = Date.now() - t0;
  return out;
}

/** Idle change vs change under input (movement keys and a mouse sweep over the play area). */
async function responseTest(page, ui, { mark, rand, avoid = new Set() }) {
  const c = ui.canvas, v = viewport(page);
  const box = c ?? { x: 0, y: 0, w: v.width, h: v.height }, cx = Math.round(box.x + box.w / 2), cy = Math.round(box.y + box.h / 2);
  const a0 = await audioActivity(page);
  const s1 = await grab(page); await sleep(page, 450); const s2 = await grab(page);
  const idle = diffFraction(s1, s2);
  // KeyW or ArrowUp (the same seeded choice as ever); a key in check.play.avoidKeys gives way to the other, then to any
  // movement key that is not avoided, then to the mouse sweep alone.
  const first = rand() < 0.5 ? 'KeyW' : 'ArrowUp', k = [first, first === 'KeyW' ? 'ArrowUp' : 'KeyW', ...MOVE].find(x => !avoid.has(x)) ?? null;
  const at = Date.now(), x2 = cx + Math.round(box.w * 0.12);
  await page.mouse.move(cx, cy).catch(() => {});
  if (k) await page.keyboard.down(k).catch(() => {});
  await page.mouse.move(x2, cy + 6, { steps: 6 }).catch(() => {});
  await sleep(page, 380);
  if (k) await page.keyboard.up(k).catch(() => {});
  // Recorded as plain steps, so a replay moves the same way.
  mark(`${k ? `held ${k} and ` : ''}swept the mouse to test the response`, [{ move: [cx, cy] }, ...(k ? [{ down: k }] : []), { move: [x2, cy + 6], steps: 6 }, { wait: 380 }, ...(k ? [{ up: k }] : [])], at);
  const s3 = await grab(page);
  const input = diffFraction(s2, s3);
  const a1 = await audioActivity(page);
  const heard = !!(a0 && a1 && a1.events > a0.events);
  return { idle: +idle.toFixed(4), input: +input.toFixed(4), heard, responds: input > Math.max(0.004, idle * 1.6 + 0.003) || (heard && input > idle) };
}

/** Turn the game's sound on once: find a toggle, read its state, click it only when it is off (or, when nothing says,
 *  only when the game has made no sound at all), then check that audio activity started. Never clicks it twice. */
async function turnSoundOn(page, ui, { play = {}, mark = () => {}, phase = 'title' } = {}) {
  const before = await audioActivity(page);
  if (play.sound && typeof play.sound === 'object') {
    // A step that can't run yet (its button shows only after the steps) is tried again later; it never runs twice.
    const r = await runSteps(page, [play.sound]);
    if (!r.ok) { mark(`check.play.sound could not run on the ${phase === 'title' ? 'first screen' : 'play screen'}: ${r.results[0]?.error ?? ''}`, null); return { toggle: 'check.play.sound', state: 'unknown', clicked: false, failed: r.results[0]?.error ?? null, before, after: null }; }
    mark(`turned sound on (check.play.sound: ${r.results[0].how})`, play.sound);
    await sleep(page, 500);
    return { toggle: 'check.play.sound', state: 'off', clicked: true, before, after: await audioActivity(page) };
  }
  const toggles = ui.buttons.filter(b => b.sound && !b.covered && b.w * b.h < 160 * 120);
  if (!toggles.length) return null;
  const read = toggles.map(b => ({ b, state: b.range ? (b.range.value <= b.range.min ? 'off' : 'on') : soundState(`${b.text} ${b.label} ${b.attrs}`, { pressed: b.pressed, checked: b.checked, shown: b.text || b.label }) }));
  // Prefer one that says it is off; a music-only toggle last.
  const off = read.filter(r => r.state === 'off').sort((x, y) => (/music|音乐|音楽|음악|música|musique|musik/i.test(x.b.words) ? 1 : 0) - (/music|音乐|音楽|음악|música|musique|musik/i.test(y.b.words) ? 1 : 0));
  const on = read.find(r => r.state === 'on');
  let pick = off[0] ?? null, why = 'its label says sound is off';
  // Nothing says: only in play, and only when the game has no audio at all yet (a game that made an AudioContext may
  // just have had nothing to play; clicking then could mute it).
  // Only an icon with no words at all is guessed at: words this can't read may well say "on" (retro-os's "Звуки включены").
  if (!pick && !on && phase === 'play') {
    const silent = !before || (before.contexts === 0 && before.events === 0 && before.media === 0);
    if (silent) { pick = read.find(r => r.state === 'unknown' && !r.b.text.replace(/[^\p{L}\p{N}]/gu, '') && !r.b.label) ?? null; why = 'an icon with no words, and in play the game has no audio at all'; }
  }
  if (!pick) return { toggle: (on ?? read[0]).b.text || (on ?? read[0]).b.label || (on ?? read[0]).b.attrs.slice(0, 40), state: on ? 'on' : read[0].state, clicked: false, before, after: null };
  const b = pick.b, name = (b.text || b.label || b.attrs).slice(0, 40);
  if (b.range) {
    const value = b.range.min + (b.range.max - b.range.min) * 0.7;
    await runPlaySteps(page, [{ range: [b.x, b.y, value] }]);
    mark(`raised the "${name}" slider from ${b.range.value} (${why})`, { range: [b.x, b.y, value] });
  } else {
    // While the pointer is locked a mouse click goes to the locked element, not the button: click it in the page then.
    const locked = await page.evaluate(() => !!document.pointerLockElement).catch(() => false);
    if (locked) { await runPlaySteps(page, [{ domClick: [b.x, b.y] }]); mark(`clicked the sound toggle "${name}" in the page (pointer locked; ${why})`, { domClick: [b.x, b.y] }); }
    else { await page.mouse.click(b.x, b.y).catch(() => {}); mark(`clicked the sound toggle "${name}" (${why})`, { click: [b.x, b.y] }); }
  }
  await sleep(page, 600);
  return { toggle: name, state: pick.state, clicked: true, why, before, after: await audioActivity(page) };
}

// ---- Playing ----
// Keys most games use. Not Escape, P (pause), M, N (mute, music), F (fullscreen), Tab (focus) or browser shortcuts.
export const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyJ', 'KeyK', 'KeyL',
  'KeyE', 'KeyQ', 'KeyR', 'KeyT', 'KeyG', 'KeyH', 'KeyB', 'KeyI', 'KeyO', 'KeyU', 'KeyY', 'ShiftLeft'];
const MOVE = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];
const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];

/** A random visible button that is not a sound toggle and not one to avoid (network play, settings, leaving, resetting). */
export async function clickSomeButton(page, { rand = Math.random, record = null } = {}) {
  const ui = await scanUi(page);
  // Round 4 (swarm bug 74): never a link to another site, nor (on a page with no guard) one to the page itself.
  const pool = ui.buttons.filter(b => b.clickable && !b.sound && !b.covered && !b.range && !leadsAway(ui, b) && !SKIP_WORDS.test(`${b.text} ${b.label}`) && !SOUND_WORDS.test(`${b.text} ${b.label} ${b.attrs}`));
  if (!pool.length) return null;
  const b = pool[Math.floor(rand() * pool.length)];
  noteInput(page, `clicked "${(b.text || b.label).slice(0, 30)}"`, { point: [b.x, b.y] });
  await page.mouse.click(b.x, b.y).catch(() => {});
  record?.({ click: [b.x, b.y] });
  return `clicked "${(b.text || b.label).slice(0, 30)}"`;
}

/** Past a game-over or pause card: the best go-button, else a click in the play area and Enter. */
export async function recover(page, { rand = Math.random, record = null, avoidKeys = null } = {}) {
  const ui = await scanUi(page);
  const go = goButtons(ui).filter(b => b.score >= 6);
  if (go.length) {
    const b = go[Math.floor(rand() * Math.min(2, go.length))];
    noteInput(page, `clicked "${(b.text || b.label).slice(0, 30)}"`, { point: [b.x, b.y] });
    if (await isPointerLocked(page)) { await runSteps(page, [{ domClick: [b.x, b.y] }]); noteInput(page, `clicked "${(b.text || b.label).slice(0, 30)}"`, { point: [b.x, b.y] }); record?.({ domClick: [b.x, b.y] }); }
    else { await page.mouse.click(b.x, b.y).catch(() => {}); record?.({ click: [b.x, b.y] }); }
    return `clicked "${(b.text || b.label).slice(0, 30)}"`;
  }
  const c = ui.canvas, v = viewport(page), x = Math.round(c ? c.x + c.w / 2 : v.width / 2), y = Math.round(c ? c.y + c.h / 2 : v.height / 2);
  if (!pressedBefore(page, x, y)) {
    noteInput(page, 'clicked the play area', { point: [x, y] });
    await page.mouse.click(x, y).catch(() => {});
    record?.({ click: [x, y] });
  }
  if (avoided(page, avoidKeys).has('Enter')) return 'clicked the play area';
  noteInput(page, 'pressed Enter', { key: 'Enter' });
  await page.keyboard.press('Enter').catch(() => {});
  record?.({ key: 'Enter' });
  return 'clicked the play area and pressed Enter';
}

/**
 * Seeded game-like input for `seconds` (or `ms`). rand: a seeded generator (else rng(seed)). onTick every ~2 s, restart
 * (default recover) every ~7 s. record: true returns `script`, the same input as runPlaySteps steps with their gaps.
 * avoidKeys: keys never pressed (default: the manifest's check.play.avoidKeys, which reachPlay remembered for this
 * page). The seeded choices stay the same: an avoided key's turn goes to the next key in its list that is not avoided.
 */
export async function fuzz(page, { seconds = 10, ms = null, seed = 1, rand = null, onTick = null, restart = undefined, record = false, buttons = true, avoidKeys = null } = {}) {
  rand ??= rng(seed);
  const avoid = avoided(page, avoidKeys), nav = navState(page);
  // Round 4 (swarm bug 74): a key after which the page reloaded or tried to leave is avoided from then on, like the
  // manifest's avoidKeys; so is a click where one did.
  const skip = k => avoid.has(k) || (!!nav && nav.avoidKeys.has(k));
  // One draw per pick, whatever is avoided (so a game with no avoidKeys gets exactly the input it always got).
  const v = viewport(page), end = Date.now() + (ms ?? seconds * 1000);
  const pick = a => { const i = Math.floor(rand() * a.length); if (!avoid.size && !(nav && nav.avoidKeys.size)) return a[i]; for (let j = 0; j < a.length; j++) { const k = a[(i + j) % a.length]; if (!skip(k)) return k; } return null; };
  const press = async k => { if (k === null || skip(k)) return; noteInput(page, `pressed ${k}`, { key: k }); await page.keyboard.press(k); rec({ key: k }); };
  const click = async (x, y, button = 'left') => { if (pressedBefore(page, x, y)) return false; noteInput(page, `${button === 'right' ? 'right-' : ''}clicked at ${x}, ${y}`, { point: [x, y] }); await page.mouse.click(x, y, button === 'right' ? { button } : undefined); return true; };
  const script = [], t = { last: Date.now() };
  const rec = step => { if (!record) return; const now = Date.now(); if (now - t.last > 15) script.push({ wait: now - t.last }); script.push(step); t.last = now; };
  if (restart === undefined) restart = () => recover(page, { rand, record: record ? rec : null, avoidKeys: [...avoid] });
  let box = null, lastBox = 0, lastRestart = Date.now(), lastTick = Date.now(), n = 0, mx = v.width / 2, my = v.height / 2;
  while (Date.now() < end) {
    if (!box || Date.now() - lastBox > 3000) {
      box = await within(5000, page.evaluate(() => { const c = [...document.querySelectorAll('canvas')].map(e => e.getBoundingClientRect()).filter(r => r.width > 80 && r.height > 80).sort((a, b) => b.width * b.height - a.width * a.height)[0]; return c ? { x: c.x, y: c.y, w: c.width, h: c.height } : null; }), 'finding the canvas').catch(() => null)
        ?? { x: 0, y: 0, w: v.width, h: v.height };
      box = { x: Math.max(0, box.x), y: Math.max(0, box.y), w: Math.min(box.w, v.width), h: Math.min(box.h, v.height) };
      lastBox = Date.now();
    }
    const r = rand(), at = () => [Math.round(box.x + 8 + rand() * Math.max(1, box.w - 16)), Math.round(box.y + 8 + rand() * Math.max(1, box.h - 16))];
    n++;
    try {
      await within(10000, (async () => {
        if (r < 0.26) await press(pick(KEYS));
        else if (r < 0.46) {
          const k = pick(MOVE), k2 = rand() < 0.3 ? pick(MOVE) : null, hold = Math.round(150 + rand() * 700);
          if (k) { noteInput(page, `held ${k}`, { key: k }); await page.keyboard.down(k); rec({ down: k }); } if (k2 && k2 !== k) { await page.keyboard.down(k2); rec({ down: k2 }); }
          if (rand() < 0.4) await press(pick(['Space', 'KeyZ', 'KeyX', 'KeyJ', 'ShiftLeft']));
          await page.waitForTimeout(hold);
          if (k2 && k2 !== k) { await page.keyboard.up(k2); rec({ up: k2 }); }
          if (k) { await page.keyboard.up(k); rec({ up: k }); }
        } else if (r < 0.60) {
          // Mouse look: a short sweep from where the mouse is, kept inside the play area.
          const nx = Math.round(Math.min(box.x + box.w - 4, Math.max(box.x + 4, mx + (rand() - 0.5) * box.w * 0.3))), ny = Math.round(Math.min(box.y + box.h - 4, Math.max(box.y + 4, my + (rand() - 0.5) * box.h * 0.2)));
          await page.mouse.move(nx, ny, { steps: 5 }); rec({ move: [nx, ny], steps: 5 }); mx = nx; my = ny;
        } else if (r < 0.74) { const [x, y] = at(); if (await click(x, y)) { rec({ click: [x, y] }); mx = x; my = y; } }
        else if (r < 0.79) { const [x, y] = at(); if (await click(x, y, 'right')) { rec({ rclick: [x, y] }); mx = x; my = y; } }
        else if (r < 0.83) { const [x, y] = at(), [x2, y2] = at(); await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 6 }); await page.mouse.up(); rec({ move: [x, y] }); rec({ mouse: 'down' }); rec({ move: [x2, y2], steps: 6 }); rec({ mouse: 'up' }); mx = x2; my = y2; }
        else if (r < 0.90) await press(pick(DIGITS));
        else if (r < 0.93) { const k = rand() < 0.5 ? 'Space' : 'Enter'; await press([k, k === 'Space' ? 'Enter' : 'Space'].find(x => !skip(x)) ?? null); }
        else if (r < 0.98 && buttons) { const how = await clickSomeButton(page, { rand, record: record ? rec : null }); if (!how) await press(pick(KEYS)); }
        else { const dy = rand() < 0.5 ? 200 : -200; await page.mouse.wheel(0, dy); rec({ wheel: dy }); }
      })(), 'input');
    } catch { /* a closed dialog, a navigation in progress, a frozen page: carry on */ }
    await page.waitForTimeout(Math.round(40 + rand() * 180)).catch(() => {});
    if (restart && Date.now() - lastRestart > 7000) { lastRestart = Date.now(); await within(15000, Promise.resolve(restart()), 'restart').catch(() => {}); }
    if (onTick && Date.now() - lastTick > 2000) { lastTick = Date.now(); await within(30000, Promise.resolve(onTick()), 'onTick').catch(() => {}); }
  }
  // Round 4 (swarm bug 74): what happened to the page. A tool must fail on navigation.lost, never report an empty page.
  return { actions: n, script, navigation: pageNavigation(page) };
}
