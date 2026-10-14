// gf-three core: the kit's guard. What a game's own code cannot do to the things the kit owns (GATES.md: "make it
// impossible"), each refused by name (./refusals.js, with the fix in its message) and undone at once:
//
//   kit-ui-hidden    a game's style rule, inline style, `hidden` or removal hides one of the kit's own elements (the
//                    kit's layer, the home and pause menu and their buttons, the HUD's player card, the goal line, the
//                    menu button, the full-screen button): the rule is deleted, the style taken off, the element put back
//   kit-ui-covered   an element the game made is drawn over one of them: it goes under the kit's layer
//   kit-ui-pressed   game code clicks a kit menu button or presses Enter for it (skipping the home menu), or calls a
//                    menu or HUD method (ctx.menu and ctx.hud are read-only views for rules): ignored
//   pointer-lock     game code calls requestPointerLock: ignored (the kit's input takes the lock when the player clicks)
//   input-swallowed  game code stops a key, mouse, touch or wheel event aimed at the game before the kit's input
//                    reads it: the stop is ignored, the event goes on
//   camera-swap      a game assigns ctx.camera: ignored
// and, with no refusal: Math.random inside a rules hook draws from the game's seeded stream (seedRules).
//
// Whose code calls is read from the call's stack: a frame in one of the game's own files (beside main.js, outside
// gf/, audio/ and vendor/; its own src/ modules are the game's like rules.js). A kit file the game declared as an
// override (gf-three.json overrides, CONTRACT §1.7) is the kit's; a kit file changed without a good declaration is the
// game's, once verify names it (globalThis.__GF_KIT_EDITS, set by its server before any module: tools/lib/kit-check.mjs). A caller that can't be placed (a packed single-file game, a test's own script) is never
// refused, so the kit, its vendored libraries and verify's own scripts are never refused. The wrappers go in when
// this module is first imported: every boot imports it, and main.js imports the boot before rules.js, so they are in
// place before any game code runs. In Node (tests) nothing is installed; the pure helpers below are exported.
import { refuse } from './refusals.js';

// ---- whose code is calling ----
/** The game's folder: this file is <game>/gf/three/core/guard.js. Null where that can't be worked out. */
export const ROOT = (() => { try { const u = new URL('../../../', import.meta.url); return /^(https?|file):$/.test(u.protocol) ? u.href : null; } catch { return null; } })();
const FRAME_URL = /((?:https?|file):\/\/[^\s()]+):\d+:\d+(?=[\s)]|$)/gm;
const KIT_DIRS = /^(gf|audio|vendor)\//;
/** Kit files changed and not declared as overrides, as verify names them (game paths), or []. */
const kitEdits = () => { const e = globalThis.__GF_KIT_EDITS; return Array.isArray(e) ? e : []; };
/** Is this game path the kit's own code? A kit copy's file, unless it was changed without a declaration. */
export const kitOwned = (rest, edits = kitEdits()) => KIT_DIRS.test(rest) && !edits.includes(rest);
/**
 * The game's own files in a stack, in order (nearest first): ['rules.js', …], paths relative to root. A frame in the
 * kit (gf/, audio/, vendor/), outside the game's folder or with no file is skipped.
 */
export function gameFrames(stack, root = ROOT, edits = kitEdits()) {
  const out = [];
  if (!root) return out;
  for (const m of String(stack ?? '').matchAll(FRAME_URL)) {
    const u = m[1].split(/[?#]/)[0];
    if (!u.startsWith(root)) continue;
    const rest = u.slice(root.length);
    if (!rest || kitOwned(rest, edits)) continue;
    out.push(rest);
  }
  return out;
}
/** The file that made the call, when it is the game's own: the nearest frame outside this file. → 'rules.js' | null */
export function callerIn(stack, root = ROOT, edits = kitEdits()) {
  if (!root) return null;
  for (const m of String(stack ?? '').matchAll(FRAME_URL)) {
    const u = m[1].split(/[?#]/)[0];
    if (u.endsWith('/core/guard.js')) continue;           // this file's own frames
    if (!u.startsWith(root)) return null;                 // a script of the page's own (a test, the browser): not the game
    const rest = u.slice(root.length);
    return rest && !kitOwned(rest, edits) ? rest : null;
  }
  return null;
}
const stackNow = () => { try { return new Error().stack ?? ''; } catch { return ''; } };
/** The game's file that called the function this is called from (its immediate caller), or null. */
export const gameCaller = () => callerIn(stackNow());
/** Any of the game's own files on the stack, or null: an event the game dispatched reaches a kit listener this way. */
export const gameOnStack = () => gameFrames(stackNow())[0] ?? null;

// ---- Math.random in the rules ----
const realRandom = Math.random;
let depth = 0, current = null;
/** Run fn with Math.random drawing from `random` (nested calls keep the outer stream); always restored. */
export function withRandom(random, fn) {
  if (depth++ === 0) { current = random; Math.random = random; }
  try { return fn(); } finally { if (--depth === 0) { Math.random = realRandom; current = null; } }
}
/**
 * The rules as the kit calls them: the same object (every property read live), each function run with Math.random
 * drawing from `random`, a seeded stream (the rules' own Math.random is then as repeatable as ctx.rng()). Only the
 * call's own synchronous part: what the rules leave for later (a timer, an awaited promise) draws as before.
 */
export function seedRules(rules, random) {
  if (!rules || typeof rules !== 'object' || typeof random !== 'function') return rules;
  const wrapped = new Map();
  const proxy = new Proxy(rules, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (typeof v !== 'function') return v;
      // a frozen rules object: a proxy must hand back its own function as it is (a Proxy invariant), so unseeded
      const own = Object.getOwnPropertyDescriptor(t, k);
      if (own && !own.configurable && !own.writable) return v;
      let w = wrapped.get(v);
      if (!w) { w = function (...a) { return withRandom(random, () => v.apply(this === proxy ? t : this, a)); }; wrapped.set(v, w); }
      return w;
    },
  });
  return proxy;
}
export const randomIsSeeded = () => current !== null;

// ---- what hides an element ----
const HIDING = [
  ['display', v => v === 'none'],
  ['visibility', v => v === 'hidden' || v === 'collapse'],
  ['opacity', v => v !== '' && Number.isFinite(Number(v)) && Number(v) < 0.1],
  ['content-visibility', v => v === 'hidden'],
  ['transform', v => /scale[xy]?\(\s*0(\.0*)?\s*[,)]/.test(v)],
];
/** The hiding declarations of a style ({getPropertyValue}): [['display', 'none'], …]. */
export function hidingOf(style) {
  const out = [];
  for (const [p, bad] of HIDING) { const v = String(style?.getPropertyValue?.(p) ?? '').trim(); if (bad(v)) out.push([p, v]); }
  return out;
}
/** The kit's own elements by name: a selector that names one of them is a selector on the kit's UI. */
export const KIT_SELECTOR = /#gf-(ui|menu|hud|goal|menu-button|fullscreen|wallet|play|friends|how|settings|resume|leave|back)(?![\w-])|\.gf-(me|menubtn|fsbtn|goal|col|btn)(?![\w-])/;
/** Does a selector's subject (the last compound of any of its parts) name one of the kit's elements? */
export const namesKit = sel => String(sel ?? '').split(',').some(part => KIT_SELECTOR.test(part.trim().split(/\s*[\s>+~]\s*/).pop() ?? ''));

// ---- the browser side ----
const INPUT_EVENTS = new Set(['keydown', 'keyup', 'mousedown', 'mouseup', 'mousemove', 'wheel', 'touchstart', 'touchmove', 'touchend', 'touchcancel']);
const gameNodes = new Set();            // elements the game's own code put at the top of the page (or a style it added)
const gameSheets = new WeakSet();       // <style>/<link> nodes the game's own code added
const watched = [];                     // the kit's own elements to keep (watchKit)
let W = null, D = null;

function aimedAtGame(t) {
  if (!t || !D) return false;
  return t === W || t === D || t === D.documentElement || t === D.body || t.id === 'gf-canvas';
}
function kitElements() {
  const out = [];
  for (const w of watched) for (const it of w.items()) if (it?.el) out.push(it.el);
  return out;
}
/** Does a selector reach one of the kit's elements (or a page box they sit in)? */
function reachesKit(sel) {
  if (namesKit(sel)) return true;
  for (const el of kitElements()) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) { try { if (n.matches(sel)) return true; } catch { return false; } }
  }
  return false;
}
function ruleList(sheet) { try { return sheet.cssRules ?? []; } catch { return []; } }
/** Delete every hiding rule in a game's sheet that reaches the kit's UI; refuse each by its selector. */
function scanSheet(sheet, who) {
  const walk = holder => {
    const rules = ruleList(holder);
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i];
      if (r.cssRules && !r.selectorText) { walk(r); continue; }     // @media, @supports, @layer
      if (!r.selectorText || !r.style) continue;
      const hides = hidingOf(r.style);
      if (!hides.length || !reachesKit(r.selectorText)) continue;
      try { holder.deleteRule(i); } catch { continue; }
      refuse('kit-ui-hidden', `${who ?? 'the game'} added the style rule "${r.selectorText} { ${hides.map(([p, v]) => `${p}: ${v}`).join('; ')} }", which hides the kit's own UI. The home menu, the HUD (player card, goal line, menu and full-screen buttons) and the wallet are the kit's (CONTRACT §6g): change their words in config/game.json → text (text.goal, text.play…), add a meter with ctx.ui.meter, and never hide or restyle them. The kit deleted the rule`, r.selectorText);
    }
  };
  walk(sheet);
}
function watchSheetNode(node, who) {
  if (gameSheets.has(node)) return;
  gameSheets.add(node);
  const scan = () => { if (node.sheet) scanSheet(node.sheet, who); };
  if (node.nodeName === 'LINK') node.addEventListener?.('load', scan);
  scan();
  try { new W.MutationObserver(scan).observe(node, { childList: true, characterData: true, subtree: true }); } catch {}
}
function inserted(parent, nodes) {
  const els = nodes.filter(n => n && (n.nodeType === 1 || n.nodeType === 11));
  if (!els.length) return;
  const top = parent === D.body || parent === D.documentElement || parent === D.head;
  const sheets = [];
  for (const n of els) {
    if (n.nodeName === 'STYLE' || n.nodeName === 'LINK') sheets.push(n);
    else if (n.querySelectorAll && (top || n.nodeType === 11)) for (const s of n.querySelectorAll('style,link[rel~=stylesheet]')) sheets.push(s);
  }
  if (!top && !sheets.length) return;
  const who = gameCaller();
  if (!who) return;
  if (top) for (const n of els) if (n.nodeType === 1 && n.nodeName !== 'STYLE' && n.nodeName !== 'LINK' && n.nodeName !== 'SCRIPT') gameNodes.add(n);
  for (const s of sheets) watchSheetNode(s, who);
}

/** Put the wrappers in. Once per page; nothing in Node. */
export function installGuard(win = globalThis.window) {
  if (!win?.Element || !win.document || win.__gfGuard) return false;
  try { Object.defineProperty(win, '__gfGuard', { value: true }); } catch { return false; }
  W = win; D = win.document;
  const E = win.Element.prototype, N = win.Node.prototype, Ev = win.Event.prototype;
  // the pointer lock: the kit's input takes it on the player's click
  const lock = E.requestPointerLock;
  if (typeof lock === 'function') {
    E.requestPointerLock = function requestPointerLock(...a) {
      const who = gameCaller();
      if (who) {
        refuse('pointer-lock', `${who} called requestPointerLock(): the mouse is the kit's (CONTRACT §6d). The kit's input takes the lock when the player clicks the game, gives it back on Esc, and offers full screen where a frame refuses it (a post on X). Take the call out; read ctx.input.locked to know whether the mouse is locked. The call was ignored`, who);
        return Promise.resolve();
      }
      return lock.apply(this, a);
    };
  }
  // stopping the keyboard, mouse or touch on its way to the kit's input
  for (const name of ['stopPropagation', 'stopImmediatePropagation']) {
    const orig = Ev[name];
    if (typeof orig !== 'function') continue;
    Ev[name] = function (...a) {
      if (INPUT_EVENTS.has(this.type) && aimedAtGame(this.target)) {
        const who = gameCaller();
        if (who) {
          refuse('input-swallowed', `${who} called event.${name}() on a ${this.type} aimed at the game: the keyboard, mouse and touch are read by the kit's input (CONTRACT §6d), and a game reads them through ctx.input (move, look, actions, keyPressed, pointer), never by stopping them. The event went on to the kit`, `${who}|${this.type}`);
          return undefined;
        }
      }
      return orig.apply(this, a);
    };
  }
  // what the game puts at the top of the page, and the styles it adds
  const wrap = (proto, name, nodesOf) => {
    const orig = proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function (...a) { const r = orig.apply(this, a); try { inserted(name === 'before' || name === 'after' || name === 'replaceWith' ? this.parentNode : name === 'insertAdjacentElement' ? (/^(beforebegin|afterend)$/i.test(a[0]) ? this.parentNode : this) : this, nodesOf(a)); } catch {} return r; };
  };
  wrap(N, 'appendChild', a => [a[0]]); wrap(N, 'insertBefore', a => [a[0]]); wrap(N, 'replaceChild', a => [a[0]]);
  for (const m of ['append', 'prepend', 'before', 'after', 'replaceWith']) wrap(E, m, a => a);
  wrap(E, 'insertAdjacentElement', a => [a[1]]);
  const CS = win.CSSStyleSheet?.prototype;
  if (CS && typeof CS.insertRule === 'function') {
    const ins = CS.insertRule;
    CS.insertRule = function (...a) { const r = ins.apply(this, a); try { const who = gameCaller(); if (who) scanSheet(this, who); } catch {} return r; };
  }
  return true;
}
installGuard();

// ---- the kit's own elements, kept ----
const visible = el => {
  if (!el.isConnected) return false;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const cs = W.getComputedStyle(el);
  return el.getClientRects().length > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
};
const area = r => Math.max(0, r.width) * Math.max(0, r.height);
const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const describe = n => (n.id ? `#${n.id}` : n === D.body ? 'body' : n === D.documentElement ? 'html' : `<${n.nodeName.toLowerCase()}${n.className && typeof n.className === 'string' ? ` class="${n.className}"` : ''}>`);
const topOf = n => { while (n.parentElement && n.parentElement !== D.body && n.parentElement !== D.documentElement) n = n.parentElement; return n; };
/** Does a game's element paint (or catch the mouse) above the kit's layer? */
function above(node, layer) {
  const t = topOf(node), cs = W.getComputedStyle(t);
  if (cs.position === 'static') return false;
  const z = cs.zIndex === 'auto' ? 0 : Number(cs.zIndex), lz = Number(W.getComputedStyle(layer).zIndex) || 0;
  if (z !== lz) return z > lz;
  return !!(layer.compareDocumentPosition(t) & 4);     // the same level: the later one paints on top
}
function paints(n) {
  const cs = W.getComputedStyle(n);
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.2) return false;
  if (cs.pointerEvents !== 'none') return true;                 // it takes the clicks meant for the kit's buttons
  const bg = cs.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
  return (bg.length >= 3 && (bg.length < 4 || bg[3] > 0.2)) || cs.backgroundImage !== 'none' || /^(IMG|CANVAS|VIDEO|svg)$/i.test(n.nodeName);
}
/** Why the element is hidden by something the game did, undone: a line for the refusal, or null (the kit's own CSS). */
function undoHiding(el) {
  const found = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hidden && n !== D.documentElement) { n.hidden = false; found.push(`the hidden attribute on ${describe(n)}`); }
    const hides = hidingOf(n.style);
    for (const [p, v] of hides) { n.style.removeProperty(p); found.push(`the inline style ${p}: ${v} on ${describe(n)}`); }
  }
  for (const s of D.styleSheets) {
    if (!s.ownerNode || !gameSheets.has(s.ownerNode)) continue;
    const walk = holder => {
      const rules = ruleList(holder);
      for (let i = rules.length - 1; i >= 0; i--) {
        const r = rules[i];
        if (r.cssRules && !r.selectorText) { walk(r); continue; }
        if (!r.selectorText || !r.style || !hidingOf(r.style).length) continue;
        let hit = false;
        for (let n = el; n && n.nodeType === 1 && !hit; n = n.parentElement) { try { hit = n.matches(r.selectorText); } catch { hit = false; } }
        if (hit) { try { holder.deleteRule(i); found.push(`the style rule "${r.selectorText}"`); } catch {} }
      }
    };
    walk(s);
  }
  return found.length ? found.join(', ') : null;
}

/**
 * Keep the kit's own elements as the kit means them. items() → [{el, name, want, cover}] where want says the kit
 * means it to show now and cover asks for the over-it check (a button, the player card). tick() at most every
 * `every` seconds: put back a removed element, undo what the game did to hide one, push a game's element that covers
 * one under the kit's layer; each refused once (by element and cause) with the fix. → {tick(now), off}
 */
export function watchKit({ items, layer, every = 0.25 } = {}) {
  const w = { items, off: false };
  if (!W) return { tick() {}, set off(v) {}, get off() { return true; } };
  watched.push(w);
  const homes = new Map();      // element → where it lives (to put it back)
  let next = 0;
  const tick = now => {
    if (w.off || now < next) return;
    next = now + every;
    for (const n of [...gameNodes]) if (!n.isConnected) gameNodes.delete(n);
    for (const it of items()) {
      const el = it?.el;
      if (!el) continue;
      if (el.parentNode) homes.set(el, { parent: el.parentNode, next: el.nextSibling });
      if (!it.want) continue;
      if (!el.isConnected) {
        const h = homes.get(el);
        if (h?.parent?.isConnected) { try { h.parent.insertBefore(el, h.next?.parentNode === h.parent ? h.next : null); } catch {} }
        refuse('kit-ui-hidden', `${it.name} was taken off the page by the game's code: it is the kit's (CONTRACT §6g), so the kit put it back. Change its words in config/game.json → text, or add to the HUD with ctx.ui.meter; never remove it`, `${it.name}|removed`);
        continue;
      }
      if (!visible(el)) {
        const why = undoHiding(el);
        if (why) refuse('kit-ui-hidden', `${it.name} was hidden by ${why}: it is the kit's (CONTRACT §6g), so the kit undid it. Change its words in config/game.json → text, add to the HUD with ctx.ui.meter, and never hide it`, `${it.name}|${why}`);
        continue;
      }
      if (!it.cover || !layer || !gameNodes.size) continue;
      const r = el.getBoundingClientRect(), a = area(r), screen = (W.innerWidth || 1) * (W.innerHeight || 1);
      if (a < 4) continue;
      for (const n of gameNodes) {
        // an overlay: most of the screen, over at least half of the kit's element (a game's small panel beside the
        // HUD is its own business)
        let o = 0, nr = null;
        try { nr = n.getBoundingClientRect(); o = overlap(r, nr); } catch { continue; }
        if (o < a * 0.5 || overlap(nr, { left: 0, top: 0, right: W.innerWidth, bottom: W.innerHeight }) < screen * 0.4 || !paints(n) || !above(n, layer)) continue;
        const t = topOf(n);
        t.style.setProperty('z-index', String(Math.max(0, (Number(W.getComputedStyle(layer).zIndex) || 1) - 1)), 'important');
        refuse('kit-ui-covered', `${describe(t)}, made by the game's code, was drawn over ${it.name}: the kit's UI stays on top (CONTRACT §6g), so the kit put that element under its layer. Place the game's own panels clear of the kit's (or use ctx.ui.panels), and never cover the menu or the HUD`, `${it.name}|${describe(t)}`);
      }
    }
  };
  return { tick, get off() { return w.off; }, set off(v) { w.off = !!v; } };
}

// ---- read-only views and refused presses ----
/**
 * A kit object as rules see it: the names in `keep` read through (functions bound), any other method refused
 * (kit-ui-pressed) and does nothing. view(menu, ['view', 'paused', 'observe'], 'ctx.menu')
 */
export function readOnlyView(obj, keep, label) {
  const ok = new Set(keep);
  return new Proxy(obj, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (typeof k !== 'string' || ok.has(k)) return typeof v === 'function' ? v.bind(t) : v;
      if (typeof v !== 'function') return v;
      return () => { refuse('kit-ui-pressed', `${gameCaller() ?? 'the game'} called ${label}.${k}(): the menu and the HUD are the kit's (CONTRACT §6g); rules read ${label} (${keep.join(', ')}) and never drive it. The round starts from the kit's Play button; change the goal line with ctx.ui.goal(text). The call was ignored`, `${label}.${k}`); return undefined; };
    },
    set(t, k) { refuse('kit-ui-pressed', `the game set ${label}.${String(k)}: ${label} is the kit's and read-only for rules (CONTRACT §6g). Ignored`, `${label}.${String(k)}=`); return true; },
  });
}
/**
 * A press of a kit control that the game's own code made (el.click(), a dispatched Enter): refused, true. A player's
 * press (trusted) or a test's script (no game file on the stack) is never refused.
 */
export function refusedPress(e, what) {
  if (!e || e.isTrusted !== false) return false;
  const who = gameOnStack();
  if (!who) return false;
  refuse('kit-ui-pressed', `${who} pressed the kit's ${what} itself: the home menu is where every game starts, and only the player starts the round (CONTRACT §6g). Take the call out; the kit runs the menu, the countdown and the round. The press was ignored`, `${who}|${what}`);
  return true;
}
/** ctx.camera as rules see it: the kit's camera; assigning another is refused. */
export function guardCamera(ctx, camera) {
  Object.defineProperty(ctx, 'camera', {
    configurable: true, enumerable: true,
    get: () => camera,
    set: v => { if (v !== camera) refuse('camera-swap', `${gameCaller() ?? 'the game'} assigned ctx.camera: the camera is the kit's (CONTRACT §6d). Pick it in config/game.json → camera ('third', 'first', 'follow', 'top', 'orbit') and tune it in config (camera settings); the kit's camera follows the local player. The new camera was ignored`, 'ctx.camera'); },
  });
}

// ---- errors in the game's hooks and the parts, said once ----
/** What an error says, with its kind: "TypeError: x is null". */
const said = e => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const firstLine = e => String(e?.stack ?? '').split('\n').map(s => s.trim()).find(s => /^at |@/.test(s)) ?? '';
/** A setup that threw (a mechanic's or the rules'): a refusal naming it. The caller still decides whether to go on. */
export function setupFailed(who, e) {
  refuse('setup-failed', `${who}.setup threw ${said(e)}${firstLine(e) ? ` (${firstLine(e)})` : ''}. ${who === 'rules' ? 'The game cannot start until rules.setup runs through' : 'That part does not work this round'}: fix the error`, `${who}|${e?.message ?? e}`);
}
const loud = new Set([10, 100, 1000, 10000]);
/** An every-frame hook that threw: refused once per hook and message, with a count (said again at 10, 100, 1000…). */
export function frameFailed(who, e) {
  const r = refuse('update-failed', `${who} threw ${said(e)}${firstLine(e) ? ` (${firstLine(e)})` : ''}. It is called every frame, so this is said once and counted (snapshot().refusals): fix the error`, `${who}|${e?.message ?? e}`);
  if (r.count > 1 && loud.has(r.count)) console.error(`gf-three refused [update-failed]: ${who} has thrown ${r.count} times: ${e?.message ?? e}`);
  return r;
}
