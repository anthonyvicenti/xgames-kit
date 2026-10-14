// The HUD of a kind (kinds/<name>.json → hud): the kit's own DOM layer (ui.js, hud.js, menu.js) restyled by a few
// tokens, so a kind changes how the HUD looks and never what it shows or where its elements are (every check that
// reads the HUD sees the same ids). A kind with `theme` (dark: 'grim') uses that theme as it is; the tokens are for
// the rest:
//   accent, panel, text   the ui.* colour slots (--gf-accent, --gf-panel, --gf-text)
//   font                  a font family (its file is a pack's, e.g. ofl-silkscreen); weight, size
//   radius                panel corners ('999px' pills, '0px' square)
//   ink                   a drawn outline round panels and big words (cartoon HUDs)
//   pixel                 crisp text, no smoothing, hard shadows (pixel HUDs)
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
  return out;
}

/** The stylesheet for a kind's tokens (empty for a themed kind: the theme is the style). Pure. */
export function hudCss(hud = {}) {
  if (!hud || hud.theme) return '';
  const rules = [];
  const font = hud.font ? `"${css(hud.font)}",system-ui,sans-serif` : null;
  if (font || hud.weight || hud.size) rules.push(`${SEL}{${font ? `font-family:${font};` : ''}${hud.weight ? `font-weight:${+hud.weight};` : ''}${hud.size ? `font-size:${css(hud.size)};` : ''}}`);
  if (font) rules.push(`${SEL} button{font-family:${font}}`);
  if (hud.radius != null) rules.push(`${PILLS}{border-radius:${css(hud.radius)}}`, `${BOXES}{border-radius:min(${css(hud.radius)},16px)}`, `${SEL} .gf-meter span,${SEL} .gf-hbar{border-radius:min(${css(hud.radius)},6px)}`);
  if (hud.ink) {
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
  return rules.join('\n');
}

/** Turn a kind's HUD on (browser), after createUI (its stylesheet must come after the kit's): its variables on <html>, its stylesheet once, and its font (url: the font file's
 *  address, from the kind's font pack). → a promise that settles when the font is ready (or failed: the system font
 *  stands in). */
export function applyKindHud(hud = {}, { fontUrl = null, root = document.documentElement } = {}) {
  for (const [k, v] of Object.entries(hudVars(hud))) root.style.setProperty(k, v);
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
