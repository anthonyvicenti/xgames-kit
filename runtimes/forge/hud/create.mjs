// What create gives a forge game for its HUD, touch, sound and loading view (wave 2, track U). One call from
// builder/tools/lib/spec-config.mjs (specToConfig, engine forge), which hands over what it has built so far;
// everything else is here so that file stays as it was.
//
//   forgeHud({ spec, game, sounds, multiplayer, assets, world, notes })
//
//   config/game.json  ui        the "grim" theme (builder/ui/theme.js): ui.theme and its six colours, each a
//                               colour slot; the party kit's panel, text and accent colours are left out (the theme
//                               does not read them)
//                     text      the words the HUD says (each a text slot); the results' lines in a co-op game's words
//                     controls  more: the forge keys (evade, reload, quick melee, weapons) for How to play, the help
//                               line and the touch buttons' labels
//                     boot      {bytes, files}: what the game downloads before its menu (the wasm and every asset
//                               file), for the loading view's bar (gf/three/ui/loading.js); an estimate once a creator
//                               swaps a file
//   assets/fonts/     the theme's two font files, each a font slot, their OFL texts beside them
//   assets/sounds/    the library's sound files the game's ids play (tools/sound-wire.mjs), each an audio slot;
//   assets.json       sounds: those files in place of the presets create listed; an id the library lacks keeps its
//                     preset; the spec's own sounds are never touched
//   multiplayer.json  theme: the friends page's colours, so its lobby and results match
//   ATTRIBUTION.md    a row per font and sound file (through world.__art, which create prints)
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { themeOf } from '../../../builder/ui/theme.js';
import { tiers } from '../kit/first.js';
import { wearConfig } from '../kit/wear.js';
import { forgeSoundList } from '../tools/sound-wire.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = resolve(HERE, '..');
export const THEME = 'grim';

/**
 * The forge keys beyond the four shared actions, by what the tables hold: rows [keys, what it does, the touch control].
 * The touch control's first word is the name under its button on a phone (gf/forge/hud.js touchPlan). Keep it short:
 * How to play prints it in its keys column, and a long one leaves no room for what the control does on an upright
 * phone (wave 5 tried "Load button (there when rounds are spent)": the second column was pushed off the screen).
 */
export function forgeKeys(forge = {}) {
  const weapons = forge.weapons ?? [], rows = [['Shift', 'Evade', 'Dodge button']];
  if (weapons.some(w => (w.magazine ?? 0) > 0)) rows.push(['R', 'Reload', 'Load button']);
  if (weapons.length) rows.push(['V', 'Quick melee', 'Strike button']);
  // the weapon keys only when a player can come to hold a second weapon: one in hand at the start, or one a card gives
  // (a row that only the quick melee swings is not held; verify check 20 presses every key this table lists)
  const cards = forge.cards ?? [], held = weapons.filter(w => w.start !== false || cards.some(c => c.kind === 'weapon' && c.weapon === w.id));
  if (held.length > 1) rows.push([`1–${Math.min(4, Math.max(...held.map(w => w.slot ?? 1), 2))}`, 'Pick a weapon', 'Swap button']);
  return rows;
}


export function forgeHud({ spec = {}, game, sounds, multiplayer, assets, world, notes = [] }) {
  const T = themeOf(THEME);
  // ---- the theme: colours, words, fonts ----
  const cross = game.ui?.crosshair;
  game.ui = { ...T.ui, ...(cross && cross !== '#ffffff' ? { crosshair: cross } : {}) };
  game.text = { ...game.text, ...T.text };
  if (!Array.isArray(game.controls?.more)) game.controls = { ...(game.controls ?? {}), more: forgeKeys(game.forge) };
  const art = [];
  for (const f of T.fonts) {
    assets.push({ to: f.file, from: join(HERE, 'fonts', f.from), license: f.license });
    // its licence text travels beside it (SIL OFL 1.1)
    assets.push({ to: f.file.replace(/[^/]+$/, `LICENSE-${f.from.replace(/\.woff2$/, '')}.txt`), from: join(HERE, 'fonts', `LICENSE-${f.from.replace(/\.woff2$/, '')}.txt`), license: f.license });
    art.push({ file: f.file, what: `${f.label} ("${f.family}", a subset: runtimes/forge/hud/fonts/ATTRIBUTION.md)`, license: `${f.license.spdx}, ${f.license.author}` });
  }
  // ---- sounds: the library's files for every id create listed as a kit preset (never the spec's own) ----
  const own = new Set((spec.sounds ?? []).map(s => s.id));
  const ids = Object.entries(sounds.sounds).filter(([id, s]) => !own.has(id) && typeof s?.src?.preset === 'string').map(([id, s]) => ({ id, preset: s.src.preset, label: s.label }));
  const r = forgeSoundList({ ids, tables: game.forge ?? {} });
  const replaced = {};
  for (const [id, e] of Object.entries(r.sounds)) {
    if (own.has(id)) continue;
    const old = sounds.sounds[id];
    if (old && !e.src?.preset) replaced[id] = JSON.stringify(old.src);
    sounds.sounds[id] = e;
  }
  // for upgrade: the preset each id had before, so a game still on that untouched preset takes the file (not written out)
  Object.defineProperty(sounds, 'replaced', { value: replaced, enumerable: false });
  for (const a of r.assets) {
    assets.push({ to: a.to, from: a.from, license: a.license, sound: true });
    art.push({ file: a.to, what: `sound (the forge's ${a.name}${a.modified && a.modified !== 'unmodified' ? '; cut and levelled, see its pack\'s LICENSE.txt in the asset library' : ''})`, license: a.license ? `${a.license.spdx}, ${a.license.author}` : 'no licence record' });
  }
  for (const p of r.problems) notes.push(`sounds: ${p}`);
  notes.push(`sounds: ${r.rows.length - r.presets.length} of ${r.rows.length} ids play the forge library's files (${r.assets.length} files, ${(r.bytes / 1024).toFixed(0)} KB) through gf-audio at the default bus levels${r.presets.length ? `; still gf-audio presets (the library has no file): ${r.presets.join(', ')}` : ''}`);
  notes.push(`hud: the "${THEME}" theme (two OFL font files as font slots, six colour slots), the forge keys in How to play (${game.controls.more.map(k => k[1].toLowerCase()).join(', ')}), touch buttons for each`);
  // ---- the friends page in the theme's colours ----
  if (multiplayer && multiplayer.theme === undefined) multiplayer.theme = { ...T.mp };
  // ---- what the game downloads before its menu: the loading bar's total ----
  // Not everything waits for the menu: gf-audio decodes its sound files in the background, and a seat's body is loaded
  // when a player first sits there (gf/forge/players.js). Those are `later`: the view counts neither side of them.
  // Wave 3 (track M; gf/forge/first.js): nor does what a fight needs (asked for once the menu is drawn: the first
  // wave's bodies, the starting weapon, a kill's pieces) or what later waves and rewards need.
  let wait = { first: [], later: [] };
  try { wait = tiers({ tables: game.forge ?? {}, world, characters: { forge: wearConfig(game.forge ?? {}) } }); } catch { /* the total is then every file's */ }
  const LATER = ['assets/sounds/', 'assets/models/body-player', ...wait.first, ...wait.later];
  let bytes = 0, files = 0, later = 0;
  const seen = new Set();
  for (const a of assets) {
    if (seen.has(a.to) || /\.txt$/.test(a.to) || !existsSync(a.from)) continue;
    seen.add(a.to);
    const n = statSync(a.from).size;
    if (LATER.some(p => a.to.startsWith(p))) later += n; else { bytes += n; files++; }
  }
  try { const raw = JSON.parse(readFileSync(join(FORGE, 'kit/BUILD.json'), 'utf8')).wasm.bytes.raw; if (raw > 0) { bytes += raw; files++; } } catch { /* no build record: the total is the assets' */ }
  game.boot = { bytes, files, later: LATER, laterBytes: later, afterMenu: { first: wait.first.length, later: wait.later.length } };
  (world.__art ??= []).push(...art);
  return { theme: THEME, sounds: r };
}
