// gf-three vfx: the module's manifest, read by the tools (not by the game). Any kit folder with a module.js beside its
// code is an optional module: `create` calls its functions, so the next module (a new folder) needs no edit in create,
// the slot assembler or the vendoring:
//
//   id                 the folder name; gf-three.json → modules.extras lists the ones a game uses (the rest are not vendored)
//   uses(spec, kit)    does this spec need the module? → true/false (create decides; a game that does not is unchanged)
//   configFor(spec)    → { game: { ... } } fragments merged into config/game.json (only what is not already there)
//   files(game)        → [{ from: '<kit-relative file>', to: '<game-relative file>', license? }] stand-ins copied if absent
//   slotsFor(cfg)      → slot declarations (gf-assets/1), exactly as a mechanic's
//   showcase(cfg, has) → preview entries ({ id, label, query, slots }) for Studio's preview list
//
// The effect style (styles.js): a spec whose look target says how its effects look (spec.look.target.vfx) gets
// config/game.json → fx (the style, read by vfx.blast / hit / trail / damage) and every preset that style draws, tinted
// by the target's effect palette (blast puffs, the blast's core, hit sparks). A spec whose mechanics blast or get hurt
// (a projectile with a splash, health) but whose target says nothing of effects gets nothing new: the soft style.
import { slotsFor } from './slots.js';
import { PRESETS, configFor as presetConfig } from './presets.js';
import { styleFromFacts, presetsOf } from './styles.js';

export const id = 'vfx';
export { slotsFor };
export const describe = 'Named particle effects (bursts, smoke, fire, sparkle, confetti) a mechanic or rules.js fires by name, and the game\'s effect style (blasts, hits, trails, damage numbers)';

/** Effect names a spec asks for: a mechanic param whose key ends in Fx and whose value is a kit preset. */
function named(spec) {
  const out = new Set();
  for (const m of spec?.mechanics ?? []) for (const [k, v] of Object.entries(m.params ?? {})) if (/Fx$/.test(k) && typeof v === 'string' && v in PRESETS) out.add(v);
  for (const v of spec?.effects ?? []) if (typeof v === 'string' && v in PRESETS) out.add(v);
  return [...out];
}
/** The spec's effect style (config/game.json → fx), from its look target's effect facts; null when it says none. */
export const styleOf = spec => (spec?.look?.target?.vfx ? styleFromFacts(spec.look.target.vfx) : null);

/** A style preset tinted by the target's effect palette: [main puff, the blast's core, smoke, sparks] (styles.js). */
function tinted(name, fx) {
  const c = presetConfig(name), pal = fx?.palette ?? [];
  if (!c || !pal.length) return c;
  if (['blast-puffs', 'hit-puff', 'trail-puffs'].includes(name) && pal[0]) c.color = pal[0];
  if (name === 'blast-core' && pal[1]) { c.color = pal[1]; if (pal[2]) c.colorEnd = pal[2]; }
  if (['smoke-wisp', 'trail-smoke', 'pixel-smoke'].includes(name) && pal[2]) c.color = pal[2];
  if (['hit-stars', 'pixel-sparks', 'pixel-burst', 'blast-bits'].includes(name) && pal[3]) c.color = pal[3];
  return c;
}

export const uses = spec => named(spec).length > 0 || !!styleOf(spec);
export function configFor(spec) {
  const vfx = {}, fx = styleOf(spec);
  for (const n of named(spec)) vfx[n] = presetConfig(n);
  if (fx) for (const n of presetsOf(fx)) if (PRESETS[n] && !vfx[n]) vfx[n] = tinted(n, fx);
  const game = { ...(Object.keys(vfx).length ? { vfx } : {}), ...(fx ? { fx } : {}) };
  return Object.keys(game).length ? { game } : null;
}
/** Sprites that are not ours carry their licence (NOTICE-styles beside this file): create credits them in ATTRIBUTION.md. */
export const SPRITE_LICENCES = Object.freeze({
  'smoke-wisp': { spdx: 'CC0-1.0', what: 'smoke sprite (Kenney Particle Pack 1.1, smoke_04, downscaled)', credit: 'Kenney (www.kenney.nl), CC0' },
  fireball: { spdx: 'CC-BY-4.0', what: 'explosion flipbook (Quiver, Outpost Assault die_fx_spritesheet, downscaled to 640 px)', credit: 'Explosion art from Quiver\'s Outpost Assault (github.com/quiver-dev/tower-defense-tutorial at 9f5cc040), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); downscaled' },
});
export function files(game) {
  return Object.entries(game?.vfx ?? {}).filter(([n, p]) => p?.texture && PRESETS[n]?.texture).map(([n, p]) => {
    const t = PRESETS[n].texture, lic = SPRITE_LICENCES[t];
    return { from: `vfx/standin/${t}.png`, to: p.texture, ...(lic ? { license: lic } : {}) };
  });
}
export function showcase(cfg, has) {
  const out = Object.keys(cfg.game?.vfx ?? {}).map(n => ({ id: `vfx.${n}`, label: PRESETS[n]?.label ?? n, query: `?gf-show=vfx.${n}`, slots: [`vfx.${n}.color`, `vfx.${n}.color-end`, `vfx.${n}.shape`, `vfx.${n}.texture`].filter(has) }));
  if (cfg.game?.fx) out.unshift({ id: 'vfx.blast', label: 'Blast (the game\'s effect style)', query: '?gf-show=vfx.blast', slots: ['vfx.style'].filter(has) });
  return out;
}
