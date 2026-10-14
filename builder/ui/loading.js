// gf-three ui: the loading view (gf-forge wave 2, track U). A forge game downloads about 10 MB before its menu, and
// showed nothing while it did. This is the kit's own view for that time, never a game's: the title, a bar that is the
// bytes downloaded out of the bytes the game needs, then a "making ready" stage while the world is built, then the menu.
//
//   import { startLoading } from './gf/three/ui/loading.js';
//   startLoading({ theme: 'grim' });      // as early as possible: index.html does it before the game's modules load,
//                                         // and the forge boot does it again (the same view; a second call adds nothing)
//
// What is true about the bar: `loaded` is counted from the bodies of the game's own downloads as they stream (the core's
// wasm and the files under assets/), by wrapping fetch until the game is ready. `total` is config/game.json →
// boot.bytes, which create added up from those same files' sizes (the view reads it out of the config as it goes by);
// boot.later names what does not wait for the menu (sounds decode in the background, a seat's body loads when someone
// sits there), and neither side counts those. Which of the rest a kit loads before its menu is the loaders' business,
// so the total can still be a little over: the bar holds short of full until the game says it is ready, and what a
// load really took is kept in this browser (localStorage, by page and by boot.bytes) and is the total the next time.
// A game with no boot.bytes shows the megabytes and a bar that only creeps.
//
// Wave 3 (track M): the page itself starts the core's wasm with its first bytes (index.html: window.__gfEarly, which
// counts that download's bytes; they are added here), and this view asks for assets.json the moment it starts, so the
// boot finds it waiting (gf-assets keeps the one request).
//
// It leaves by itself when window.__game exists (the menu is up, or the kit's no-WebGPU screen is), and on an error (the
// boot's own message shows). Nothing is shown for a lobby backdrop (?gf-backdrop=1: the friends page is the screen).
// QA: window.__gfLoading.observe() → {shown, stage, loaded, total, share, title, firstMs, readyMs, samples}.
import * as gf from '../../gf-assets.js';
import { applyTheme, themeOf } from './theme.js';

const CSS = `
html.gf-loading-on,html.gf-loading-on body{background:#07080a}
#gf-loading{position:fixed;inset:0;z-index:30;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:24px;text-align:center;background:#0b0e18;color:#fff;font:600 14px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;transition:opacity .18s ease-out}
#gf-loading.out{opacity:0;pointer-events:none}
#gf-loading h1{margin:0;font-size:clamp(30px,7vw,60px);line-height:1.02}
#gf-loading .bar{position:relative;width:min(440px,74vw);height:4px;background:#ffffff22;overflow:hidden}
#gf-loading .bar u{position:absolute;inset:0 auto 0 0;width:0;background:#ff7a59;transition:width .15s linear}
#gf-loading.ready .bar u{animation:gf-loading-wait 1.3s ease-in-out infinite}
@keyframes gf-loading-wait{0%,100%{opacity:1}50%{opacity:.4}}
#gf-loading p{margin:0;min-height:1.3em;font-variant-numeric:tabular-nums;opacity:.85}
html.gf-theme-grim #gf-loading{background:radial-gradient(ellipse at 50% 36%,#171b21 0%,var(--gf-forge-ink) 58%,#050607 100%);color:var(--gf-forge-bone);font:500 14px/1.3 var(--gf-forge-serif);gap:22px;text-rendering:geometricPrecision}
html.gf-theme-grim #gf-loading h1{font:700 clamp(38px,8.4vw,88px)/.98 var(--gf-forge-display);letter-spacing:.01em;text-shadow:0 2px 0 #000a,0 0 40px #000}
html.gf-theme-grim #gf-loading h1::after{content:"";display:block;width:64px;height:2px;margin:20px auto 0;background:var(--gf-forge-accent)}
html.gf-theme-grim #gf-loading .bar{height:3px;background:color-mix(in srgb,var(--gf-forge-parchment) 20%,transparent);box-shadow:0 0 0 1px #000}
html.gf-theme-grim #gf-loading .bar u{background:var(--gf-forge-accent)}
html.gf-theme-grim #gf-loading p{font:600 11.5px/1.3 var(--gf-forge-serif);letter-spacing:.2em;text-transform:uppercase;color:var(--gf-forge-parchment);opacity:1}
html.gf-theme-grim #gf-loading p b{font-weight:700;letter-spacing:.08em;color:var(--gf-forge-bone);margin-left:.7em}
`;

const MB = n => (n / 1048576).toFixed(1);
const pathOf = url => { try { return new URL(url, location.href).pathname; } catch { return String(url); } };

export function startLoading({ theme = null, title = null } = {}) {
  const W = globalThis;
  if (W.__gfLoading) return W.__gfLoading;
  const params = new URLSearchParams(location.search), quiet = params.get('gf-backdrop') === '1';
  const t0 = performance.now();
  const S = { stage: 'download', loaded: 0, total: 0, declared: 0, learned: false, later: [], open: 0, last: t0, firstMs: null, readyMs: null, done: false, samples: [], words: { loading: 'Loading', preparing: 'Making ready' } };
  // the theme's look at once; its font files once the game's config says it carries them (below)
  if (themeOf(theme)) applyTheme(theme, { fonts: false });
  let view = null, bar = null, line = null, h1 = null, timer = null;
  if (!quiet && typeof document !== 'undefined') {
    const style = document.createElement('style'); style.id = 'gf-loading-css'; style.textContent = CSS; document.head.append(style);
    document.documentElement.classList.add('gf-loading-on');
    view = document.getElementById('gf-loading') ?? document.createElement('div'); view.id = 'gf-loading'; view.setAttribute('role', 'status');
    h1 = document.createElement('h1'); h1.textContent = title ?? document.title ?? '';
    const track = document.createElement('div'); track.className = 'bar'; bar = document.createElement('u'); track.append(bar);
    line = document.createElement('p');
    view.replaceChildren(h1, track, line);
    const mount = () => { if (!view.isConnected) (document.body ?? document.documentElement).append(view); };
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
    requestAnimationFrame(() => { S.firstMs = Math.round(performance.now() - t0); });
  }
  // what the last load of this page really took, when it was the same build (the same boot.bytes)
  const KEY = `gf-loading:${location.pathname}`;
  const remembered = () => { try { const r = JSON.parse(localStorage.getItem(KEY) ?? 'null'); return r && r.declared === S.declared && r.bytes > 0 ? r.bytes : 0; } catch { return 0; } };

  // ---- the bytes: every download of the game's own, counted as its body streams ----
  /** What counts toward the bar: the core's wasm and the game's asset files, but not what boot.later names. */
  const counted = url => { const p = pathOf(url); return /\.wasm$/.test(p) || (/(^|\/)assets\/.+\.[a-z0-9]+$/i.test(p) && !S.later.some(x => p.includes(`/${x}`) || p.startsWith(x))); };
  const orig = W.fetch;
  const expect = g => {
    const n = Number(g?.boot?.bytes);
    if (Array.isArray(g?.boot?.later)) S.later = g.boot.later.filter(x => typeof x === 'string' && x);
    if (n > 0) { S.declared = n; const r = remembered(); S.learned = r > 0; S.total = r || n; }
    if (typeof g?.text?.loading === 'string') S.words.loading = g.text.loading;
    if (typeof g?.text?.preparing === 'string') S.words.preparing = g.text.preparing;
    if (themeOf(g?.ui?.theme)) applyTheme(g.ui.theme, { url: gf.url });
    const t = g?.text?.title ?? g?.title;
    if (h1 && typeof t === 'string' && t && h1.textContent !== t) h1.textContent = t;
  };
  const wrapped = async function (input, init) {
    const res = await orig.call(W, input, init);
    try {
      const url = typeof input === 'string' ? input : input?.url ?? String(input ?? '');
      if (/(^|\/)config\/game\.json(\?|$)/.test(url) && res.ok) res.clone().json().then(expect).catch(() => {});
      if (S.done || !res.ok || !res.body || res.type === 'opaque' || !counted(url)) return res;
      S.open++;
      const reader = res.body.getReader();
      let closed = false;
      const close = () => { if (!closed) { closed = true; S.open--; S.last = performance.now(); } };
      const body = new ReadableStream({
        async pull(c) { try { const { done, value } = await reader.read(); if (done) { close(); c.close(); return; } if (!S.done) S.loaded += value.byteLength; S.last = performance.now(); c.enqueue(value); } catch (e) { close(); c.error(e); } },
        cancel(reason) { close(); return reader.cancel(reason); },
      });
      const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
      try { Object.defineProperty(out, 'url', { value: res.url }); } catch { /* the copy has no url: nothing here reads it */ }
      return out;
    } catch { return res; }
  };
  if (typeof orig === 'function') W.fetch = wrapped;
  // the manifest, asked for now (the boot's own gf.manifest() is this same request)
  try { gf.manifest().catch(() => {}); } catch { /* the boot will say what is wrong with it */ }

  // what has come in: this view's own count, and the wasm's bytes when the page started it before this view existed
  const loaded = () => S.loaded + (Number(W.__gfEarly?.bytes) || 0);
  const share = () => (S.total > 0 ? Math.min(1, loaded() / S.total) : 1 - Math.exp(-loaded() / 6e6));
  const draw = () => {
    const now = performance.now(), p = share();
    // downloaded: everything the total names is in, or nothing has come for a while after most of it has
    if (S.stage === 'download' && loaded() > 0 && S.open === 0 && (p >= 0.995 || (now - S.last > 600 && (S.total === 0 || p > 0.8)))) S.stage = 'ready';
    if (view) {
      bar.style.width = `${(Math.min(S.stage === 'ready' ? 1 : 0.985, p) * 100).toFixed(1)}%`;
      view.classList.toggle('ready', S.stage === 'ready');
      const text = S.stage === 'ready' ? S.words.preparing : S.words.loading, nums = S.stage === 'ready' ? '' : S.total > 0 ? `${MB(Math.min(loaded(), S.total))} / ${MB(S.total)} MB` : loaded() > 0 ? `${MB(loaded())} MB` : '';
      if (line.dataset.k !== `${text}|${nums}`) { line.dataset.k = `${text}|${nums}`; const b = document.createElement('b'); b.textContent = nums; line.replaceChildren(text, ...(nums ? [b] : [])); }
    }
    if (S.samples.length < 400 && (!S.samples.length || now - t0 - S.samples.at(-1).ms >= 100)) S.samples.push({ ms: Math.round(now - t0), loaded: loaded(), share: Math.round(p * 1000) / 1000, stage: S.stage });
    if (W.__game) api.done();
  };
  const onError = () => api.done(true);
  const api = {
    /** Leave: the game is ready (or it failed: its own message shows). */
    done(failed = false) {
      if (S.done) return;
      S.done = true; S.readyMs = Math.round(performance.now() - t0); S.failed = !!failed; S.atReady = loaded();
      clearInterval(timer);
      if (W.fetch === wrapped) W.fetch = orig;
      W.removeEventListener?.('unhandledrejection', onError);
      document.documentElement.classList.remove('gf-loading-on');
      // what this load took, for the next one of the same build (a real game only: never the no-WebGPU screen)
      if (!failed && S.declared > 0 && S.atReady > 0 && W.__game?.phase !== 'unsupported' && !params.get('gf-show')) { try { localStorage.setItem(KEY, JSON.stringify({ declared: S.declared, bytes: S.atReady })); } catch { /* private mode: the estimate again next time */ } }
      if (!view) return;
      if (!failed) bar.style.width = '100%';
      view.classList.add('out');
      const gone = () => view.remove();
      if (failed || params.get('gf-show')) gone(); else setTimeout(gone, 220);
    },
    observe: () => ({ shown: !!view?.isConnected && !view.classList.contains('out'), stage: S.done ? 'done' : S.stage, loaded: S.done ? S.atReady : loaded(), early: Number(W.__gfEarly?.bytes) || 0, total: S.total, declared: S.declared, learned: S.learned, share: Math.round((S.done && S.total > 0 ? Math.min(1, S.atReady / S.total) : share()) * 1000) / 1000, title: h1?.textContent ?? null, line: line?.textContent ?? null, firstMs: S.firstMs, readyMs: S.readyMs, failed: !!S.failed, samples: S.samples.slice() }),
  };
  W.addEventListener?.('unhandledrejection', onError);
  timer = setInterval(draw, 50);
  draw();
  W.__gfLoading = api;
  return api;
}
