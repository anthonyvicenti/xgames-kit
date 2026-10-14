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
import { slotsFor } from './slots.js';
import { PRESETS, configFor as presetConfig } from './presets.js';

export const id = 'vfx';
export { slotsFor };
export const describe = 'Named particle effects (bursts, smoke, fire, sparkle, confetti) a mechanic or rules.js fires by name';

/** Effect names a spec asks for: a mechanic param whose key ends in Fx and whose value is a kit preset. */
function named(spec) {
  const out = new Set();
  for (const m of spec?.mechanics ?? []) for (const [k, v] of Object.entries(m.params ?? {})) if (/Fx$/.test(k) && typeof v === 'string' && v in PRESETS) out.add(v);
  for (const v of spec?.effects ?? []) if (typeof v === 'string' && v in PRESETS) out.add(v);
  return [...out];
}

export const uses = spec => named(spec).length > 0;
export function configFor(spec) {
  const vfx = {};
  for (const n of named(spec)) vfx[n] = presetConfig(n);
  return Object.keys(vfx).length ? { game: { vfx } } : null;
}
export function files(game) {
  return Object.entries(game?.vfx ?? {}).filter(([n, p]) => p?.texture && PRESETS[n]).map(([n, p]) => ({ from: `vfx/standin/${PRESETS[n].texture}.png`, to: p.texture }));
}
export function showcase(cfg, has) {
  return Object.keys(cfg.game?.vfx ?? {}).map(n => ({ id: `vfx.${n}`, label: PRESETS[n]?.label ?? n, query: `?gf-show=vfx.${n}`, slots: [`vfx.${n}.color`, `vfx.${n}.color-end`, `vfx.${n}.shape`, `vfx.${n}.texture`].filter(has) }));
}
