// Does a screen fit a phone? Every button, link and field a finger can press, measured where the page draws it (the
// light DOM and every open shadow root: the host-join kit draws its Host / Join screen in one), against the screen's
// edges and against every ancestor that clips it, and its height against what a thumb needs.
//
// The creator, 2026-10-12, on the forge zombie game v8 on a phone: "Review mobile, especially around the pre-game lobby.
// Looks like some of the buttons run off the screen" (research/rust-engine/evidence/creator-zombie-town-v8-mobile-lobby-2026-10-12.json).
// Measured on production (gf-forge/evidence/zombie-town-v8-mobile-lobby-audit-2026-10-12): the waiting room's
// Play alone instead · Lock room · Go live · Close room 15 px past the bottom of a 740×360 screen and 30-32 px tall,
// the friends page's code and Join cut off at 740×360, Settings' lower rows 20-160 px past the bottom of a phone held
// sideways. Nothing in verify had looked at the friends page or the menu's inner views on a phone.
//
// Used by verify check 25's phone leg (tools/lib/friends-check.mjs: the friends page, the waiting room, the stream
// panel) and check 20's (tools/lib/menu-check.mjs: the home menu, How to play, Settings, the pause menu).
//
// The rules (judgeFit):
//   reachable   a control is on the screen, or inside a box that scrolls (the box itself on the screen) and only
//               scrolled out of view; never past the screen's edge with nothing to scroll it back, never cut off by an
//               ancestor that clips without scrolling (overflow hidden, or a scroller already at its end)
//   main        the screen's main action (Host, Join, Start, Back, Resume ...: `main` selectors) is whole on the screen
//               without scrolling anything
//   a thumb     each control's target (an input's own <label> counts: a press on it presses the input) at least
//               MIN_TAP px tall and wide
//   no sideways the page itself never scrolls sideways, and a box that scrolls sideways counts as cutting off what it hides
//   exempt      a link inside a sentence (display: inline, words of its own beside it, e.g. an art credit's "source"), as
//               WCAG 2.5.8 exempts inline targets; an underlined link standing alone as an action is not exempt
// What a finger cannot press is not measured: anything hidden, `pointer-events: none`, or inside a frame (a frame's
// own page is measured on its own: `frame`).

/** A thumb's target, both ways (Apple's and Google's guides: 44 pt, 48 dp). */
export const MIN_TAP = 44;
/** The three phone sizes verify measures: upright, held sideways, and held sideways with the browser's bars showing. */
export const PHONE_SIZES = [[390, 844], [844, 390], [640, 360]];
/** The audit's sizes (the creator's phone held both ways, the common small ones, and the shortest a browser leaves). */
export const AUDIT_SIZES = [[390, 844], [375, 667], [360, 740], [412, 915], [844, 390], [740, 360], [667, 375], [640, 360], [568, 320]];

/**
 * In the page: every control a finger can press, with what clips it. page.evaluate(FIT, { main, skip }).
 * Measured twice: as the page stands, and with every box that scrolls scrolled to its end (then put back), where the
 * main action must still be whole on the screen (a Back that scrolls away with the rows under it is not "always there").
 * A control another element covers at its middle (a menu over the HUD) cannot be pressed now and is not measured.
 * → { W, H, side, els: [{ label, id, x, y, w, h, hit: {w, h}, off: [...], clip: null | {by, scrolls, onScreen}, main, atEnd? }] }
 */
export const FIT = ({ main = [], skip = [] } = {}) => {
  const W = innerWidth, H = innerHeight;
  const up = e => e.parentElement ?? (e.parentNode instanceof ShadowRoot ? e.parentNode.host : null);
  const name = a => (a.id ? `#${a.id}` : a.tagName.toLowerCase() + (typeof a.className === 'string' && a.className ? '.' + a.className.trim().split(/\s+/).join('.') : '')).slice(0, 40);
  const all = [];
  const walk = root => { for (const e of root.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot); } };
  walk(document);
  const TAP = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button]';
  const onScreen = r => r.left >= -1 && r.top >= -1 && r.right <= W + 1 && r.bottom <= H + 1;
  const once = () => {
    const els = [];
    for (const e of all) {
      if (!e.isConnected || !e.matches(TAP) || skip.some(s => e.matches(s))) continue;
      if (typeof e.checkVisibility === 'function' && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const cs = getComputedStyle(e);
      if (cs.pointerEvents === 'none') continue;
      // a link inside a sentence (an art credit's "source") is part of the text, as WCAG 2.5.8 exempts inline targets
      if (e.tagName === 'A' && cs.display === 'inline' && [...e.parentNode.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
      const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
      // a press on an input's own label presses the input (a checkbox drawn small in a tall row)
      const lab = e.tagName === 'INPUT' ? e.closest('label') : null, q = lab ? lab.getBoundingClientRect() : r;
      const hit = { w: Math.round(Math.max(r.right, q.right) - Math.min(r.left, q.left)), h: Math.round(Math.max(r.bottom, q.bottom) - Math.min(r.top, q.top)) };
      const off = [];
      if (r.left < -1) off.push(`left ${Math.round(-r.left)}`); if (r.right > W + 1) off.push(`right ${Math.round(r.right - W)}`);
      if (r.top < -1) off.push(`top ${Math.round(-r.top)}`); if (r.bottom > H + 1) off.push(`bottom ${Math.round(r.bottom - H)}`);
      // the nearest ancestor that does not hold it whole: one that scrolls (and is itself on the screen) only hides it
      // until scrolled (the body's and the page's own overflow is the screen's: the edges above say it)
      let clip = null;
      for (let a = up(e); a && a !== document.documentElement && a !== document.body; a = up(a)) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const ar = a.getBoundingClientRect();
        const outY = r.top < ar.top - 1 || r.bottom > ar.bottom + 1, outX = r.left < ar.left - 1 || r.right > ar.right + 1;
        if (!outY && !outX) continue;
        const scrollY = /(auto|scroll)/.test(s.overflowY) && a.scrollHeight > a.clientHeight + 1;
        // a box that scrolls sideways hides what is beyond its edge from a phone's player: that counts as cut off
        clip = { by: name(a), scrolls: !outX && scrollY, onScreen: onScreen(ar) };
        break;
      }
      // whole and on the screen, but under something else at its middle: not pressable now
      if (!off.length && !clip) {
        const root = e.getRootNode(), at = (typeof root.elementFromPoint === 'function' ? root : document).elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (at && at !== e && !e.contains(at) && !(lab && lab.contains(at))) continue;
      }
      const label = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.id || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 36);
      els.push({ el: e, label, id: e.id || null, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), hit, off, clip, main: main.some(s => e.matches(s)) });
    }
    return els;
  };
  const els = once();
  // every box that scrolls, scrolled to its end: is the main action still whole on the screen?
  const scrollers = all.filter(a => a.isConnected && /(auto|scroll)/.test(getComputedStyle(a).overflowY) && a.scrollHeight > a.clientHeight + 1);
  if (scrollers.length) {
    const was = scrollers.map(a => a.scrollTop);
    for (const a of scrollers) a.scrollTop = a.scrollHeight;
    const end = once();
    scrollers.forEach((a, i) => { a.scrollTop = was[i]; });
    for (const x of els) if (x.main) { const y = end.find(z => z.el === x.el); x.atEnd = y ? { off: y.off, clip: y.clip } : { off: ['covered or gone'], clip: null }; }
  }
  for (const x of els) delete x.el;
  const d = document.scrollingElement || document.documentElement;
  return { W, H, side: d.scrollWidth > d.clientWidth + 1, els };
};

/** What is wrong with one measured screen. → { ok, problems: [string], counts: {controls, off, clipped, small} } */
export function judgeFit(m, { minTap = MIN_TAP, needMain = null } = {}) {
  const problems = [], tag = e => `"${e.label}"${e.id ? ` (#${e.id})` : ''}`;
  if (!m) return { ok: false, problems: ['nothing measured'], counts: null };
  let off = 0, clipped = 0, small = 0;
  for (const e of m.els) {
    const away = !!e.clip && e.clip.scrolls && e.clip.onScreen;        // only scrolled out of view, in a box on the screen
    if (e.clip && !away) { clipped++; problems.push(`${tag(e)} is cut off by ${e.clip.by}${e.clip.scrolls ? ', which runs past the screen' : ', which does not scroll'}`); }
    else if (e.off.length && !away) { off++; problems.push(`${tag(e)} runs past the screen (${e.off.join(', ')} px)`); }
    if (e.main && (e.off.length || e.clip)) problems.push(`${tag(e)}, the main action, is not on the screen without scrolling${e.off.length ? ` (${e.off.join(', ')} px)` : ` (in ${e.clip.by})`}`);
    else if (e.main && e.atEnd && (e.atEnd.off.length || e.atEnd.clip)) problems.push(`${tag(e)}, the main action, scrolls off the screen with what is under it (${e.atEnd.off.length ? e.atEnd.off.join(', ') : `hidden in ${e.atEnd.clip.by}`})`);
    if (e.hit.h < minTap || e.hit.w < minTap) { small++; problems.push(`${tag(e)} is ${e.hit.w}×${e.hit.h} px (a thumb needs ${minTap})`); }
  }
  if (needMain && !m.els.some(e => e.main)) problems.push(`no ${needMain} on the screen`);
  if (m.side) problems.push('the page scrolls sideways');
  return { ok: problems.length === 0, problems, counts: { controls: m.els.length, off, clipped, small } };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** The context options of a phone's page (a touch screen, a phone's pixel ratio). */
export const PHONE_CONTEXT = { hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

/**
 * One screen at each size: the same page turned and resized as a phone is (the layout reads only the size), measured
 * and judged; the page is left at the first size. `frame`: measure that frame's page (the game under the friends page).
 * → { ok, lines: [string], record: [{size, ok, counts, problems}] }
 */
export async function fitScreen(page, where, { main = [], skip = [], sizes = PHONE_SIZES, frame = null, shot = null } = {}) {
  const record = [], lines = [];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h }); await sleep(380);
    const m = await (frame ?? page).evaluate(FIT, { main, skip }).catch(() => null);
    const j = judgeFit(m, { needMain: main.length ? main.join(' or ') : null });
    record.push({ size: `${w}x${h}`, ok: j.ok, counts: j.counts, problems: j.problems });
    if (!j.ok) lines.push(fitLine(where, [w, h], j));
    if (shot && !j.ok) await shot(page, `phone-${where.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${w}x${h}`);
  }
  await page.setViewportSize({ width: sizes[0][0], height: sizes[0][1] }); await sleep(200);
  return { ok: lines.length === 0, lines, record, summary: summarize(where, record) };
}

/** One line for a screen over its sizes: each problem once, with the sizes it was seen at. */
export function summarize(where, record, max = 8) {
  const seen = new Map();
  for (const r of record) for (const p of r.problems ?? []) { const k = p.replace(/\d+×\d+ px/, 'N px'); if (!seen.has(k)) seen.set(k, { text: p, at: [] }); if (!seen.get(k).at.includes(r.size)) seen.get(k).at.push(r.size); }
  if (!seen.size) return null;
  // what runs off the screen or is cut off first, then what is too small (a long detail is cut short where it is read)
  const rank = t => (/main action/.test(t) ? 0 : /past the screen|cut off/.test(t) ? 1 : 2);
  const all = [...seen.values()].sort((a, b) => rank(a.text) - rank(b.text));
  return `${where}: ${all.slice(0, max).map(x => `${x.text} at ${x.at.join(', ')}`).join('; ')}${all.length > max ? ` (+${all.length - max} more)` : ''}`;
}

/** One line for a screen at a size. */
export function fitLine(where, size, j) { return `${where} at ${size[0]}×${size[1]}: ${j.ok ? `${j.counts.controls} controls, all on the screen and at least ${MIN_TAP} px` : j.problems.slice(0, 4).join('; ') + (j.problems.length > 4 ? ` (+${j.problems.length - 4} more)` : '')}`; }
