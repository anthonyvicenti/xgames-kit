// gf-three ui: slot declarations for the words and colours of the HUD and cards. Pure (Node imports it).
// A themed game (./theme.js: config/game.json → ui.theme) also declares the theme's colours, its two font files and the
// words its HUD says; a game with no theme declares exactly what it did before.
import { themeOf } from './theme.js';

const G = 'config/game.json';
const TEXT = [
  ['title', 'Game title', 'main', 99, 40, 'The home menu, the results and the browser tab'],
  ['hook', 'Tagline', 'main', 92, 200, 'Under the title on the home menu'],
  ['play', 'Play button', 'advanced', 12, 24],
  ['again', 'Play again button', 'advanced', 12, 24],
  ['waiting', 'Waiting line', 'advanced', 8, 60],
  ['you', 'Your name when playing alone', 'advanced', 8, 24],
  ['wins', 'Winner line ({name} is the winner)', 'advanced', 9, 60],
  ['draw', 'No-winner line', 'advanced', 8, 60],
  ['goal', 'Goal line (on the HUD and in How to play)', 'main', 90, 120, 'One line: what a player is trying to do'],
  ['friends', 'Play with friends button', 'advanced', 12, 28],
  ['how', 'How to play button', 'advanced', 12, 28],
  ['settings', 'Settings button', 'advanced', 12, 28],
  ['wallet', 'Connect wallet button', 'advanced', 12, 28],
  ['items', 'Your items title', 'advanced', 12, 28],
  ['resume', 'Resume button', 'advanced', 12, 24],
  ['leave', 'Quit to menu button', 'advanced', 12, 28],
  ['toMenu', 'Results menu button', 'advanced', 12, 24],
  ['paused', 'Pause title (alone)', 'advanced', 8, 24],
  ['menu', 'Pause title (with friends)', 'advanced', 8, 24],
  ['tank', 'Tank meter label', 'advanced', 10, 24],
  ['paint', 'Paint share label', 'advanced', 10, 24],
  // the words a themed action HUD says (gf-forge: gf/forge/hud.js); {n}, {m}, {count} and {name} are filled in
  ['health', 'Health label', 'advanced', 8, 16],
  ['stamina', 'Stamina label', 'advanced', 8, 16],
  ['wounded', 'Low health, first stage', 'advanced', 7, 20],
  ['bleeding', 'Low health, second stage', 'advanced', 7, 20],
  ['lastBreath', 'Low health, last stage', 'advanced', 7, 20],
  ['down', 'You are down line', 'advanced', 7, 30],
  ['friendDown', 'A friend is down (beside their name)', 'advanced', 7, 16],
  ['friendRising', 'A friend is being revived (beside their name)', 'advanced', 7, 16],
  ['wave', 'Wave line ({n} of {m})', 'advanced', 8, 30],
  ['remain', 'Enemies left line ({n})', 'advanced', 8, 24],
  ['waveStart', 'Wave banner ({n})', 'advanced', 8, 30],
  ['waveStartSub', 'Wave banner, second line ({count} enemies, {m} waves)', 'advanced', 7, 50],
  ['waveClear', 'Wave cleared banner ({n})', 'advanced', 8, 40],
  ['waveClearSub', 'Wave cleared banner, second line', 'advanced', 7, 50],
  ['bossRises', 'Boss banner ({name})', 'advanced', 8, 40],
  ['bossSub', 'Boss banner, second line', 'advanced', 7, 50],
  ['reloading', 'Reloading word', 'advanced', 7, 16],
  ['kills', 'Combo kills ({n})', 'advanced', 7, 20],
  ['critical', 'Critical hit tag', 'advanced', 7, 16],
  ['score', 'Score label', 'advanced', 7, 16],
  ['coins', 'Coins label', 'advanced', 7, 16],
  ['loading', 'Loading line', 'advanced', 7, 40],
  ['clickToFight', 'Click to take the mouse back (back in a fight with the mouse free)', 'advanced', 7, 30],
  ['preparing', 'Loading line, after the download', 'advanced', 7, 40],
];
const COLORS = [
  ['accent', 'Accent colour (buttons, bars)', 'main', 74, '--gf-accent'], ['panel', 'Panel colour', 'advanced', 18, '--gf-panel'], ['text', 'Text colour', 'advanced', 16, '--gf-text'], ['crosshair', 'Crosshair colour', 'advanced', 15, '--gf-cross'],
  // a theme's own colours (./theme.js "grim")
  ['ember', 'Accent colour: ember (the main button, the combo, critical hits)', 'main', 74, '--gf-forge-accent'], ['bone', 'Text and number colour: bone', 'advanced', 16, '--gf-forge-bone'],
  ['parchment', 'Label and rule colour: parchment', 'advanced', 15, '--gf-forge-parchment'], ['ink', 'Shade and panel colour: ink', 'advanced', 18, '--gf-forge-ink'],
  ['blood', 'Hurt and low-health colour: blood', 'advanced', 14, '--gf-forge-blood'], ['moon', 'Cold accent: moon (stamina, friends)', 'advanced', 14, '--gf-forge-moon'],
];

export function slotsFor(cfg) {
  const g = cfg.game ?? {}, out = [];
  // the picture on a published game's link preview (a post on X shows it before the game loads): tools/card.mjs renders it
  if ((cfg.files ?? []).includes('assets/card.jpg')) out.push({ id: 'ui.card', group: 'text', label: 'Link preview picture', type: 'image', source: { file: 'assets/card.jpg' }, constraints: { colorSpace: 'srgb', formats: ['jpg', 'png', 'webp'], square: true, maxBytes: 1500000 }, tier: 'main', facet: 'look', rank: 93, description: 'The square picture a post on X shows for the game before it loads (960×960 is drawn); the title goes over its lower part', generate: { prompt: 'a square key-art picture of the game world, bright and inviting, room for a title at the bottom', style: 'the game\'s own look' } });
  for (const [k, label, tier, rank, maxLength, description] of TEXT) {
    if (g.text?.[k] === undefined) continue;
    // slot ids are lowercase (gf-assets/1): a camelCase key's id is kebab case, as the manifest tool would make it
    out.push({ id: `ui.${k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`, group: 'text', label, type: 'text', source: { file: G, pointer: `/text/${k}` }, constraints: { maxLength, ...(maxLength > 80 ? { multiline: true } : {}) }, tier, facet: 'text', rank, ...(description ? { description } : {}) });
  }
  for (const k of Object.keys(g.controls ?? {})) {
    // controls.more (CONTRACT §9): a game's own keys, a list of rows: one json slot, not a line of text
    if (k === 'more') { out.push({ id: 'ui.controls.more', group: 'text', label: 'The game\'s own keys', type: 'json', source: { file: G, pointer: '/controls/more' }, tier: 'advanced', facet: 'text', rank: 10, description: 'Rows [keys, what it does, the touch control that does it] for How to play and the help line' }); continue; }
    out.push({ id: `ui.controls.${k}`, group: 'text', label: `What ${k === 'primary' ? 'the main button' : k === 'secondary' ? 'the second button' : k} does`, type: 'text', source: { file: G, pointer: `/controls/${k}` }, constraints: { maxLength: 80 }, tier: 'advanced', facet: 'text', rank: 11, description: 'The controls in How to play, the help line and the touch button label' });
  }
  for (const [k, label, tier, rank, css] of COLORS) if (g.ui?.[k] !== undefined) out.push({ id: `ui.${k}`, group: 'ui', label, type: 'color', source: { file: G, pointer: `/ui/${k}` }, css, tier, facet: 'look', rank });
  // a theme's font files (each replaceable; its licence travels in the slot and beside the file)
  for (const f of themeOf(g.ui?.theme)?.fonts ?? []) if ((cfg.files ?? []).includes(f.file)) out.push({ id: f.slot, group: 'ui', label: f.label, type: 'font', source: { file: f.file }, constraints: { formats: ['woff2', 'woff', 'ttf', 'otf'], maxBytes: 400000 }, tier: 'advanced', facet: 'look', rank: 12, license: f.license, description: `"${f.family}": the theme's ${f.slot.endsWith('display') ? 'display' : 'text'} type; a replacement keeps the family name` });
  // a kind's HUD font (kinds/apply.mjs → ui.style.fontFile; ./kind-hud.js loads it)
  const kf = g.ui?.style?.fontFile;
  if (kf && (cfg.files ?? []).includes(kf)) out.push({ id: 'ui.font', group: 'ui', label: 'HUD font', type: 'font', source: { file: kf }, constraints: { formats: ['woff2', 'woff', 'ttf', 'otf'], maxBytes: 400000 }, tier: 'advanced', facet: 'look', rank: 12, description: `"${g.ui.style.font}": the HUD's type, from the game's kind; a replacement keeps the family name` });
  return out;
}
