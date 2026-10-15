// The HUD and the effects of a style target: what the references' UI and VFX look like (spec.look.target.ui / .vfx,
// read by the vision rubric from the frames) → the shared HUD's style tokens (builder/ui/kind-hud.js) and the vfx
// part's style (runtimes/three/kit/vfx/styles.js). Never per-game code: a target only picks tokens, layouts and
// widget variants the shared HUD already draws for every game, and an effect style every mechanic already calls.
//
//   hudOf(target, base)            → {tokens, said}   tokens over the kind's (base: kinds/<id>.json → hud); pure
//   fontOf(type, words)            → a library font family for the display type's class (FONTS), or null (system)
//   typeOf(ui)                     → the type class: ui.type, else read from ui.font's words
//   applyTargetUi(C, spec, {place}) create's seam after the kind and the target's look (builder/tools/create.mjs):
//                                  the tokens into config/game.json → ui.style (+ the font file, as a kind's), said in notes
//
// The legal line holds here too: a target's UI facts are conventions (shape language, ink, type class, placement,
// motion); no picture, logo or name of the reference reaches the game.
import { hexToOklab } from './stats.mjs';
import { styleFromFacts } from '../../runtimes/three/kit/vfx/styles.js';

/** The display type's class → the library's OFL fonts (packs ofl-*: library/packs/ofl-<id>), first that exists wins. */
export const FONTS = Object.freeze({
  comic: ['Bangers'],
  rounded: ['Lilita One', 'Fredoka'],
  soft: ['Fredoka', 'Lilita One'],
  blocky: ['Bungee'],
  condensed: ['Bangers', 'Bungee'],
  serif: ['Grenze'],
  pixel: ['Silkscreen', 'VT323'],
  hand: ['Bangers'],
  plain: [],
});

const LEVEL_W = { none: 0, low: 1.5, mid: 2.5, high: 3.5 };
const RADIUS = { square: '2px', rounded: '14px', pill: '999px', irregular: '10px' };

/** The type class a target's UI shows: its `type`, else read from the font words ("chunky rounded display" → rounded). */
export function typeOf(ui = {}) {
  if (ui.type) return ui.type;
  const w = (ui.font ?? []).join(' ').toLowerCase();
  if (!w) return null;
  if (/pixel|bitmap|8-?bit/.test(w)) return 'pixel';
  if (/comic|cartoon/.test(w)) return 'comic';
  if (/serif|engrav|gothic|blackletter|medieval/.test(w)) return 'serif';
  if (/hand|brush|script|marker/.test(w)) return 'hand';
  if (/block|square|stencil|slab/.test(w)) return 'blocky';
  if (/round/.test(w) && /chunky|heavy|bold|display|fat/.test(w)) return 'rounded';
  if (/round|friendly|soft/.test(w)) return 'soft';
  if (/condensed|narrow|tall/.test(w)) return 'condensed';
  return 'plain';
}

/** A font family for a type class (the first the library holds when `has` is given), or null for the system font. */
export function fontOf(type, { has = () => true } = {}) {
  for (const f of FONTS[type] ?? []) if (has(f)) return f;
  return null;
}

const isLight = hex => { try { return hexToOklab(hex)[0] > 0.72; } catch { return false; } };

/**
 * A target's UI facts → HUD tokens over the kind's (`base`). Only what the target holds is set; the rest stays the
 * kind's. → {tokens, said: [what came from the target]}. Pure.
 */
export function hudOf(target, base = {}, { has } = {}) {
  const ui = target?.ui, vfx = target?.vfx, said = [];
  if (!ui && !vfx?.numbers) return { tokens: { ...base }, said };
  const t = { ...base };
  if (ui?.accent?.[0]) { t.accent = ui.accent[0]; said.push('accent'); }
  if (ui?.panel) {
    t.panel = `${ui.panel.slice(0, 7)}${['mid', 'high'].includes(ui.ink) ? 'f2' : 'cc'}`;      // a heavily inked panel is solid, like a printed plate
    t.text = isLight(ui.panel) ? '#1b1b1f' : '#ffffff'; said.push('panel');
  }
  const type = typeOf(ui ?? {});
  if (type) {
    const font = fontOf(type, { has });
    // display faces come in one weight (400); a round friendly sans reads at 700; the system sans at 600
    if (font) { t.font = font; t.weight = type === 'soft' ? 700 : 400; } else { delete t.font; t.weight = type === 'plain' ? 600 : 800; }
    t.type = type; said.push(`type ${type}${font ? ` (${font})` : ''}`);
  }
  if (ui?.corners) { t.radius = RADIUS[ui.corners]; said.push(`corners ${ui.corners}`); }
  if (ui?.ink) {
    const w = LEVEL_W[ui.ink] ?? 0;
    if (w > 0) { t.ink = ui.inkColor ?? base.ink ?? '#141414'; t.inkWidth = w; } else { delete t.ink; t.inkWidth = 0; }
    said.push(`ink ${ui.ink}`);
  } else if (ui?.inkColor && t.ink) t.ink = ui.inkColor;
  const shape = ui?.shapes?.[0] ?? null;
  if (shape) { t.shape = shape; said.push(`shape ${shape}`); }
  if (ui?.layout) { t.layout = ui.layout; said.push(`layout ${ui.layout}`); }
  if (ui?.motion) { t.motion = ui.motion; said.push(`motion ${ui.motion}`); }
  if (ui?.tags) { t.tags = ui.tags; said.push(`tags ${ui.tags}`); }
  if (ui?.widgets?.length) { t.widgets = [...ui.widgets]; said.push(`widgets ${ui.widgets.join(', ')}`); }
  const numbers = vfx?.numbers ?? (ui?.widgets?.includes('damage-numbers') ? 'comic' : null);
  if (numbers) { t.numbers = numbers; said.push(`numbers ${numbers}`); }
  // a pixel HUD keeps its crisp text whatever else the target says
  if (type === 'pixel') t.pixel = true;
  return { tokens: t, said };
}

/** A target's effect facts → the vfx part's style (styles.js), or null when the target says nothing of effects. */
export const vfxOf = target => (target?.vfx ? styleFromFacts(target.vfx) : null);

/**
 * create's seam, after applyKind and applyTarget: the target's UI facts as HUD tokens in config/game.json → ui.style
 * (and the font file, as the kind's font is placed). A themed kind (dark: 'grim') keeps its theme, said so. A runtime
 * that draws its own HUD (forge, vista) is skipped, said so. Changes C in place → {notes}.
 */
export async function applyTargetUi(C, spec, { place, fontFile = null } = {}) {
  const notes = [], t = spec?.look?.target;
  if (!t?.ui && !t?.vfx?.numbers) return { notes };
  if (!C?.game) return { notes };
  if (['forge', 'vista'].includes(place?.runtime)) { notes.push(`look target: the ${place.runtime} runtime draws its own HUD; the target's UI facts are not mapped onto it yet`); return { notes }; }
  const ui = C.game.ui = { ...(C.game.ui ?? {}) };
  if (ui.theme) { notes.push(`look target: the kind's HUD theme ${ui.theme} stands (a theme is a whole look); the target's UI facts are not mapped onto a theme`); return { notes }; }
  const ff = fontFile ?? (async family => { try { return (await import('../look-judge/lib/packs.mjs')).fontFile(family); } catch (e) { return { missing: e.message }; } });
  const base = { ...(ui.style ?? {}), ...(ui.accent ? { accent: ui.accent } : {}), ...(ui.panel ? { panel: ui.panel } : {}), ...(ui.text ? { text: ui.text } : {}) };
  const kindFont = base.fontFile ?? null;
  delete base.fontFile;
  const { tokens, said } = hudOf(t, base);
  const { accent, panel, text, font, ...style } = tokens;
  const ownPalette = Array.isArray(spec.look?.palette) && spec.look.palette.length;
  if (accent && !ownPalette) Object.assign(ui, { accent, crosshair: accent });
  if (panel) ui.panel = panel;
  if (text) ui.text = text;
  ui.style = { ...style, ...(font ? { font } : {}) };
  // the kind's font file goes when the target's type takes another (one font per HUD: the slot ui.font)
  if (kindFont && font !== base.font) C.assets = C.assets.filter(a => a.to !== kindFont);
  else if (kindFont && font === base.font) ui.style.fontFile = kindFont;
  if (font && !ui.style.fontFile) {
    const f = await ff(font);
    if (f?.file) {
      const to = `assets/fonts/${font.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${f.ext ?? '.ttf'}`;
      if (!C.assets.some(a => a.to === to)) C.assets.push({ to, from: f.file, license: { spdx: 'OFL-1.1', pack: f.pack }, note: `the look target's HUD font (${f.pack})` });
      ui.style.fontFile = to;
    } else { delete ui.style.font; notes.push(`look target: HUD font ${font} not found (${f?.missing ?? 'no file'}); the system font stands in`); }
  }
  notes.push(`look target HUD: ${said.join(', ')}`);
  return { notes };
}
