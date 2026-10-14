// Applying a kind in create: the one seam (builder/tools/create.mjs, right after specToConfig) through which a spec's
// `kind` reaches the game it makes. A kind changes how the game looks and sounds, never a rule of play, and the spec's
// own answers always win over it:
//
//   look     the kind's look values on this runtime (kinds/<id>.json → look.<runtime>.values) over the preset's, folded
//            into the chosen time of day too, so a preset's time block never shadows them; only when the game's look
//            is the kind's (the spec named no other preset)
//   world    world values over the template's layout (world.<runtime>.values: a ceiling, a ground), and a world preset
//            file (world.<runtime>.preset: blocky's island) when the game's world is the kind's template
//   camera   the rig's numbers (camera.<runtime>: fov, distance…) when the spec's rig is the kind's default
//   audio    pitch and gain trims on the sounds the game has (audio.sounds), never on a sound the spec described
//   hud      the kind's HUD: a theme (config/game.json → ui.theme), or colours (ui.accent, ui.panel, ui.text: the kit's
//            ui.* colour slots) and style tokens (ui.style, applied by gf/three/ui/kind-hud.js) with the font they
//            name, a file of the kind's font pack copied into the game (assets/fonts/, slot ui.font)
//   packs    the packs the art resolver ranks first for this game (config/game.json → art.packs)
//
//   const { notes } = await applyKind(C, spec, { place });     // C: specToConfig's output, changed in place
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
/** b over a (objects deep, everything else replaced); a new object. */
export function over(a, b) {
  if (!isObj(a) || !isObj(b)) return structuredClone(b === undefined ? a : b);
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? over(out[k], v) : structuredClone(v);
  return out;
}

/** A kind preset by id (kinds/<id>.json), or null. */
export function readKind(id, { dir = HERE } = {}) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) return null;
  const f = join(dir, `${id}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

/** The kind's look on a runtime and profile, or null when it has none there. */
export function kindLook(kind, { runtime, profile = null }) {
  const L = kind?.look?.[runtime];
  if (!L || (L.profile && profile && L.profile !== profile)) return null;
  return L;
}

/** The font file of a kind's HUD: the asset library's font pack (builder/look-judge/sheet-packs.json names it). */
async function fontOf(family) {
  if (!family) return null;
  try {
    const { fontFile } = await import('../builder/look-judge/lib/packs.mjs');
    return fontFile(family);
  } catch (e) { return { missing: e.message }; }
}

/**
 * Apply the spec's kind to create's config. C is specToConfig's output ({game, look, world, sounds, assets, notes…}),
 * changed in place. place: {runtime, profile}. → {kind, notes}; a spec with no kind, or a kind with no preset, changes
 * nothing and says so.
 */
export async function applyKind(C, spec, { place, kinds = HERE } = {}) {
  const notes = [];
  const kind = readKind(spec?.kind, { dir: kinds });
  if (!kind) return { kind: null, notes: spec?.kind ? [`kind: "${spec.kind}" has no preset in kinds/; the runtime's defaults stand`] : [] };
  const rt = place?.runtime, said = [];

  // ---- look: the kind's values, over the preset and over its time of day ----
  const L = kindLook(kind, { runtime: rt, profile: place?.profile });
  if (L?.values && Object.keys(L.values).length && C.look && (!spec.look?.preset || spec.look.preset === L.preset)) {
    const time = C.look.time ?? L.time;
    C.look = over(C.look, L.values);
    if (isObj(C.look.times) && time) C.look.times[time] = over(C.look.times[time] ?? {}, L.values);
    said.push(`look values (${Object.keys(L.values).join(', ')})`);
  }

  // ---- world: values over the template, the kind's world preset ----
  const W = kind.world?.[rt];
  if (W && C.world && (!W.templates || W.templates.includes(spec.world?.template))) {
    if (W.preset && spec.world?.template === (W.default ?? W.templates?.[0])) {
      const file = join(REPO, W.preset);
      if (existsSync(file)) { const { about, template, ...p } = JSON.parse(readFileSync(file, 'utf8')); C.world = over(C.world, p); said.push(`world preset ${W.preset}`); }
      else notes.push(`kind ${kind.id}: its world preset ${W.preset} is not in this checkout`);
    }
    if (W.values) { C.world = over(C.world, W.values); said.push(`world values (${Object.keys(W.values).join(', ')})`); }
  }

  // ---- camera: the rig's numbers when the rig is the kind's ----
  const cam = kind.camera?.[rt];
  const rig = spec.camera ?? C.game?.camera;
  if (isObj(cam) && rig === kind.camera.default && C.game?.controller?.camera?.[rig]) {
    const numbers = Object.fromEntries(Object.entries(cam).filter(([, v]) => typeof v === 'number'));
    if (Object.keys(numbers).length) {
      C.game.controller.camera[rig] = { ...C.game.controller.camera[rig], ...numbers };
      said.push(`camera ${rig} (${Object.keys(numbers).join(', ')})`);
    }
  }

  // ---- audio: trims on the sounds the game has; a sound the spec described is the spec's ----
  const mine = new Set((spec.sounds ?? []).map(s => s.id));
  const trimmed = [];
  for (const [id, a] of Object.entries(kind.audio?.sounds ?? {})) {
    const s = C.sounds?.sounds?.[id];
    if (!s || mine.has(id)) continue;
    if (a.preset && s.src?.preset && !s.src.file) s.src = { ...s.src, preset: a.preset };
    if (a.pitch != null) s.pitch = a.pitch;
    if (a.gainDb != null) s.gainDb = a.gainDb;
    trimmed.push(id);
  }
  if (trimmed.length) said.push(`sounds ${trimmed.join(', ')}`);

  // ---- hud: a theme, or colours (the kit's ui.* colour slots) and style tokens with the font they name ----
  if (kind.hud && C.game && !['forge', 'vista'].includes(rt)) {
    const { theme, accent, panel, text, font, ...style } = kind.hud;
    const ui = C.game.ui = { ...(C.game.ui ?? {}) };
    if (theme) ui.theme = theme;
    else {
      Object.assign(ui, { ...(accent ? { accent, crosshair: accent } : {}), ...(panel ? { panel } : {}), ...(text ? { text } : {}) });
      ui.style = { ...style, ...(font ? { font } : {}) };
      const f = font ? await fontOf(font) : null;
      if (f?.file) {
        const to = `assets/fonts/${font.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${f.ext ?? '.ttf'}`;
        C.assets.push({ to, from: f.file, license: { spdx: 'OFL-1.1', pack: f.pack }, note: `the ${kind.id} kind's HUD font (${f.pack})` });
        ui.style.fontFile = to;
      } else if (f?.missing) notes.push(`kind ${kind.id}: HUD font ${font} not found (${f.missing}); the system font stands in`);
    }
    said.push(theme ? `HUD theme ${theme}` : `HUD colours and style${ui.style?.fontFile ? ` in ${font}` : ''}`);
  }

  // ---- packs: what the art resolver ranks first ----
  if (kind.packs?.length && C.game) { C.game.art = { ...(C.game.art ?? {}), kind: kind.id, packs: [...kind.packs] }; said.push(`${kind.packs.length} packs first`); }

  notes.unshift(`kind ${kind.id}: ${said.length ? said.join('; ') : 'nothing to apply on this runtime'}${kindLook(kind, { runtime: rt, profile: place?.profile }) ? '' : ` (it has no look on ${rt}${place?.profile ? `/${place.profile}` : ''}: the game builds it)`}`);
  return { kind, notes };
}
