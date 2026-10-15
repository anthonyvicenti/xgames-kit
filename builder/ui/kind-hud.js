// The HUD of a kind (kinds/<name>.json → hud): the kit's own DOM layer (ui.js, hud.js, menu.js) restyled by a few
// tokens, so a kind changes how the HUD looks and never what it shows or where its elements are (every check that
// reads the HUD sees the same ids). A kind with `theme` (dark: 'grim') uses that theme as it is; the tokens are for
// the rest:
//   accent, panel, text   the ui.* colour slots (--gf-accent, --gf-panel, --gf-text)
//   font                  a font family (its file is a pack's, e.g. ofl-silkscreen); weight, size
//   radius                panel corners ('999px' pills, '0px' square)
//   ink                   a drawn outline round panels and big words (cartoon HUDs)
//   pixel                 crisp text, no smoothing, hard shadows (pixel HUDs)
// and, from a game's look target (builder/look/ui-style.mjs hudOf: the references' UI read on a fixed rubric), the same
// way for every game (a token only restyles and moves the kit's own elements, every id stays):
//   inkWidth              the ink's weight in px: the ink then goes round every panel, bar and big word, not only the pills
//   shape                 dial (round badges: the clock becomes a round dial), plate (squared, bevelled), banner (ribbon
//                         goal line, slanted banner words), pill, bar, card, bubble, minimal (no panels, words with a shadow)
//   layout                corners (the clock as a badge in the bottom right), top-bar (one strip across the top),
//                         bottom-bar (the clock at the bottom middle), sides, minimal, diegetic (the help line hidden)
//   motion                how banners, toasts and popped words arrive: pop, bounce, slide, fade (the kit's own), snap, none
//   tags                  name tags over characters: ink-text (coloured words in heavy ink, no panel), plate, pill
//   numbers               popped numbers (ui.pop, vfx.damage): comic (big inked numerals that pop) or float (the kit's own)
//   widgets               the widget kinds the references show (ui.dial, ui.teams, ui.turnTimer, ui.weapons, ui.announce
//                         in ./widgets.js draw in these tokens; the HUD's team cards come on with 'team-cards')
// Pure apart from applyKindHud (browser).

const css = s => String(s).replace(/[<>{};]/g, '');
const SEL = '#gf-ui';
const PILLS = ['.gf-timer', '.gf-toast', '.gf-prompt', '.gf-plate'].map(s => `${SEL} ${s}`).join(',');   // one line: any radius
const BOXES = ['.gf-scores', '.gf-meter', '.gf-card'].map(s => `${SEL} ${s}`).join(',');                // many lines: a pill would clip them
const PANELS = `${PILLS},${BOXES}`;

/** The CSS custom properties a kind sets (the ui.* colour slots). Pure. */
export function hudVars(hud = {}) {
  const out = {};
  if (hud.accent) out['--gf-accent'] = hud.accent;
  if (hud.panel) out['--gf-panel'] = hud.panel;
  if (hud.text) out['--gf-text'] = hud.text;
  if (hud.accent) out['--gf-cross'] = hud.accent;
  if (hud.ink) out['--gf-ink'] = hud.ink;
  if (hud.inkWidth != null) out['--gf-ink-w'] = `${Math.max(0, +hud.inkWidth || 0)}px`;
  return out;
}

const KEYS = `@keyframes gf-in-pop{0%{opacity:0;scale:.35}60%{opacity:1;scale:1.12}100%{opacity:1;scale:1}}
@keyframes gf-in-bounce{0%{opacity:0;scale:.3}45%{opacity:1;scale:1.18}65%{scale:.92}82%{scale:1.04}100%{opacity:1;scale:1}}
@keyframes gf-in-slide{0%{opacity:0;translate:0 -36px}100%{opacity:1;translate:0 0}}
@keyframes gf-num-comic{0%{opacity:0;scale:.2}14%{opacity:1;scale:1.3}28%{scale:1}72%{opacity:1;translate:0 -18px}100%{opacity:0;translate:0 -58px;scale:.9}}`;

/** The rules for the target's tokens (shape, layout, motion, tags, numbers, inkWidth). Empty without them. Pure. */
function targetRules(hud) {
  const r = [], ink = css(hud.ink ?? '#141414'), W = Math.max(0, +hud.inkWidth || 0), w = `${W}px`;
  const S = `${SEL} `;
  if (hud.inkWidth != null && W > 0) {
    const ring = `0 0 0 ${w} ${ink},0 ${Math.round(W * 1.3)}px 0 ${w} ${ink}`;
    r.push(`${[`.gf-me`, `.gf-goal`, `.gf-menubtn`, ...PILLS.split(',').map(x => x.replace(`${SEL} `, '')), ...BOXES.split(',').map(x => x.replace(`${SEL} `, ''))].map(x => S + x).join(',')}{box-shadow:${ring}}`,
      `${S}.gf-hp-bar,${S}.gf-line span,${S}.gf-hbar,${S}.gf-bossbar span,${S}.gf-meter span{box-shadow:0 0 0 ${Math.max(1.5, W * 0.7)}px ${ink}}`,
      `${S}.gf-hp-pips u{box-shadow:inset 0 -3px 0 #0003,0 0 0 1.5px ${ink}}`,
      `${S}.gf-timer,${S}.gf-banner,${S}.gf-pop,${S}.gf-me-name,${S}.gf-bossbar i,${S}.gf-card h1,${S}.gf-count{-webkit-text-stroke:${Math.max(1, W * 0.7)}px ${ink};paint-order:stroke fill;text-shadow:0 ${Math.round(W * 0.9)}px 0 ${ink}}`,
      `${S}.gf-banner{-webkit-text-stroke:${Math.max(2, W)}px ${ink};text-shadow:0 ${Math.round(W * 1.5)}px 0 ${ink}}`);
  }
  switch (hud.shape) {
    case 'dial':
      r.push(`${S}.gf-timer{width:74px;height:74px;min-width:0;padding:0;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;letter-spacing:.02em}`,
        `${S}.gf-menubtn{border-radius:50%}`, `${S}.gf-me{border-radius:22px}`, `${S}.gf-scores{border-radius:18px}`, `${S}.gf-goal,${S}.gf-toast,${S}.gf-prompt{border-radius:999px}`);
      break;
    case 'plate': {
      const bevel = 'inset 0 3px 0 #ffffff2e,inset 0 -4px 0 #0000002e';
      r.push(`${PANELS},${S}.gf-me,${S}.gf-goal,${S}.gf-menubtn{border-radius:5px}`);
      if (W > 0) r.push(`${PANELS},${S}.gf-me,${S}.gf-goal,${S}.gf-menubtn{box-shadow:${bevel},0 0 0 ${w} ${ink},0 ${Math.round(W * 1.3)}px 0 ${w} ${ink}}`);
      else r.push(`${PANELS},${S}.gf-me,${S}.gf-goal,${S}.gf-menubtn{box-shadow:${bevel},0 3px 10px #0004}`);
      break;
    }
    case 'banner':
      r.push(`${S}.gf-goal{border-radius:3px;padding:5px 26px;clip-path:polygon(0 0,100% 0,calc(100% - 13px) 50%,100% 100%,0 100%,13px 50%)}`,
        `${S}.gf-banner{rotate:-4deg;letter-spacing:.02em}`);
      break;
    case 'minimal':
      r.push(`${PANELS},${S}.gf-me,${S}.gf-goal{background:transparent;box-shadow:none}`, `${SEL}{text-shadow:0 2px 0 #000b,0 0 6px #0009}`);
      break;
    case 'card': case 'bubble':
      r.push(`${S}.gf-me,${S}.gf-scores,${S}.gf-card{border-radius:18px}`);
      break;
    default: break;
  }
  switch (hud.layout) {
    case 'corners':
      r.push(`${S}.gf-top{top:auto;left:auto;right:18px;bottom:18px;transform:none}`, `${S}.gf-goal{top:12px}`, `${S}.gf-toasts{top:52px}`, `${S}.gf-bossbar{top:52px}`,
        `${S}.gf-menubtn.gf-fsbtn{right:auto;bottom:auto;left:60px;top:10px}`,
        `@media (max-width:640px){${S}.gf-top{bottom:auto;top:50px;right:8px}${S}.gf-timer{scale:.8}}`);
      break;
    case 'top-bar':
      r.push(`${S}.gf-top{left:0;right:0;top:0;transform:none;justify-content:center;padding:5px 0;background:var(--gf-panel,#1c2133cc)${W > 0 ? `;box-shadow:0 ${w} 0 ${ink}` : ''}}`,
        `${S}.gf-top .gf-timer{background:transparent;box-shadow:none}`, `${S}.gf-scores{top:4px}`, `${S}.gf-menubtn{top:4px}`, `${S}.gf-goal{top:62px}`, `${S}.gf-toasts{top:98px}`);
      break;
    case 'bottom-bar':
      r.push(`${S}.gf-top{top:auto;bottom:14px}`, `${S}.gf-help{bottom:70px}`, `${S}.gf-prompt{bottom:100px}`);
      break;
    case 'minimal': case 'diegetic':
      r.push(`${S}.gf-help{display:none}`);
      break;
    default: break;
  }
  const arrive = { pop: 'gf-in-pop .42s cubic-bezier(.2,1.5,.45,1) both', bounce: 'gf-in-bounce .6s ease-out both', slide: 'gf-in-slide .3s ease-out both' }[hud.motion];
  if (arrive) r.push(`${S}.gf-banner.on,${S}.gf-toast,${S}.gf-announce.on{animation:${arrive}}`);
  if (hud.motion === 'snap' || hud.motion === 'none') r.push(`${S}.gf-banner,${S}.gf-toast{transition:none}`);
  if (hud.tags === 'ink-text') {
    r.push(`${S}.gf-plate{background:transparent;box-shadow:none;padding:0;font-size:17px;line-height:1.05;text-align:center;color:var(--c,#fff);-webkit-text-stroke:${Math.max(2, W * 0.8)}px ${ink};paint-order:stroke fill;text-shadow:0 2px 0 ${ink}}`, `${S}.gf-plate i{display:none}`);
  } else if (hud.tags === 'plate') r.push(`${S}.gf-plate{border-radius:4px;background:var(--gf-panel,#000a)${W > 0 ? `;box-shadow:0 0 0 ${Math.max(1.5, W * 0.6)}px ${ink}` : ''}}`);
  if (hud.numbers === 'comic') r.push(`${S}.gf-pop{font-size:40px;letter-spacing:.02em;-webkit-text-stroke:${Math.max(2.5, W)}px ${ink};paint-order:stroke fill;text-shadow:0 ${Math.round(Math.max(3, W * 1.2))}px 0 ${ink};animation:gf-num-comic 1.05s ease-out forwards}`);
  if (r.length) r.unshift(KEYS);
  return r;
}

/** The stylesheet for a kind's tokens (empty for a themed kind: the theme is the style). Pure. */
export function hudCss(hud = {}) {
  if (!hud || hud.theme) return '';
  const rules = [];
  const font = hud.font ? `"${css(hud.font)}",system-ui,sans-serif` : null;
  if (font || hud.weight || hud.size) rules.push(`${SEL}{${font ? `font-family:${font};` : ''}${hud.weight ? `font-weight:${+hud.weight};` : ''}${hud.size ? `font-size:${css(hud.size)};` : ''}}`);
  if (font) rules.push(`${SEL} button{font-family:${font}}`);
  if (hud.radius != null) rules.push(`${PILLS}{border-radius:${css(hud.radius)}}`, `${BOXES}{border-radius:min(${css(hud.radius)},16px)}`, `${SEL} .gf-meter span,${SEL} .gf-hbar{border-radius:min(${css(hud.radius)},6px)}`);
  if (hud.ink && hud.inkWidth == null) {
    rules.push(`${PANELS}{box-shadow:0 0 0 3px ${css(hud.ink)},0 4px 0 3px ${css(hud.ink)}}`,
      `${SEL} .gf-banner{color:#fff;-webkit-text-stroke:2px ${css(hud.ink)};paint-order:stroke fill;text-shadow:0 4px 0 ${css(hud.ink)}}`,
      `${SEL} .gf-meter span{background:${css(hud.ink)}33;box-shadow:inset 0 0 0 2px ${css(hud.ink)}}`);
  }
  if (hud.pixel) {
    rules.push(`${SEL}{-webkit-font-smoothing:none;font-smooth:never;text-rendering:optimizeSpeed;letter-spacing:.02em}`,
      `${SEL} .gf-banner{text-shadow:4px 4px 0 #000a;letter-spacing:.04em}`,
      `${PANELS}{box-shadow:inset 0 0 0 2px #0008,0 0 0 2px ${css(hud.accent ?? '#000')}}`,
      `${SEL} .gf-meter span{height:10px;border-radius:0}`);
  }
  if (hud.size) rules.push(`${SEL} .gf-banner{font-size:calc(${css(hud.size)} * 2.8)}`);
  rules.push(...targetRules(hud));
  return rules.join('\n');
}

/** Turn a kind's HUD on (browser), after createUI (its stylesheet must come after the kit's): its variables on <html>, its stylesheet once, and its font (url: the font file's
 *  address, from the kind's font pack). → a promise that settles when the font is ready (or failed: the system font
 *  stands in). */
export function applyKindHud(hud = {}, { fontUrl = null, root = document.documentElement } = {}) {
  for (const [k, v] of Object.entries(hudVars(hud))) root.style.setProperty(k, v);
  // the widgets (./widgets.js) read the shape and the layout from the layer itself
  const layer = typeof document !== 'undefined' ? document.getElementById('gf-ui') : null;
  if (layer && !hud.theme) for (const k of ['shape', 'layout', 'motion', 'tags', 'numbers', 'type']) { if (hud[k]) layer.dataset[k] = hud[k]; else delete layer.dataset[k]; }
  const text = hudCss(hud);
  if (text) {
    let s = document.getElementById('gf-kind-hud');
    if (!s) { s = document.createElement('style'); s.id = 'gf-kind-hud'; document.head.append(s); }
    s.textContent = text;
  }
  if (!hud.font || !fontUrl || typeof FontFace === 'undefined') return Promise.resolve(false);
  const face = new FontFace(hud.font, `url(${JSON.stringify(fontUrl)})`, { display: 'block' });
  return face.load().then(f => { document.fonts.add(f); return true; }, () => false);
}
