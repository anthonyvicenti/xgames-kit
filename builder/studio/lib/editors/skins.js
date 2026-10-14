// The skin editor's logic, with no DOM. Pure.
//
// A character's look is made of slots the kit already has (CONTRACT §2, §6e): the body (character.body.<role>: a
// model in 3D, a picture sheet in 2D), the seat colours (character.tint.player: one colour a seat; light parts of a
// sheet and the tinted part of a body take it), a hat (character.hat.player), and its height. The editor tries a
// look on in the preview with the kit's own loadout input (?gf-show=character.<role>&gf-loadout=..., §6e "?gf-show=
// subjects wear the page's loadout too") before anything is written, then saves through the slot routes.

/** A small, friendly palette first (Animal Crossing, Picrew: curated swatches before a free picker). */
export const SWATCHES = [
  '#ff5a5f', '#ff7eb3', '#f59bff', '#b79bff', '#6d8bff', '#6cc4ff', '#5fe0d6', '#4be0a8',
  '#7ee08f', '#c6e85c', '#ffc94d', '#ff9d5c', '#c98a5a', '#8a5a3c', '#f4f1ea', '#3a3d4a',
];

const HEX = /^#[0-9a-f]{6}$/i;
export const isColour = v => typeof v === 'string' && HEX.test(v);

/** base64url of a loadout (the kit's ?gf-loadout= format: { values, files, pass }). Works in Node and in a page. */
export function loadoutParam({ values = {}, files = {} } = {}) {
  const json = JSON.stringify({ values, files, pass: null });
  const b64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(json))) : Buffer.from(json, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A look that is not saved yet, as the kit's loadout ({ values, files }). A `colors` slot takes one colour in a
 *  loadout: the player's own (§6e). */
export function tryOnLoadout({ colour = null, extra = {} } = {}) {
  const values = { ...extra };
  if (colour && isColour(colour)) values['character.tint.player'] = colour.toLowerCase();
  return { values, files: {} };
}
/** The preview address that shows a role turning, wearing a look that is not saved yet. */
export function tryOnPath(role, { colour = null, extra = {} } = {}) {
  const { values } = tryOnLoadout({ colour, extra });
  const q = new URLSearchParams({ 'gf-show': `character.${role}` });
  if (Object.keys(values).length) q.set('gf-loadout', loadoutParam({ values }));
  return `/game/?${q}`;
}
/** Is the preview showing this role turning already (so a new look can be handed to it without a reload)? */
export const showingRole = (search, role) => new URLSearchParams(String(search ?? '')).get('gf-show') === `character.${role}`;

/** The seat colours with one changed. → a new list (lower case) */
export function setSeat(list, i, colour) {
  if (!isColour(colour)) throw new Error(`"${colour}" is not a colour (#rrggbb)`);
  const out = (Array.isArray(list) ? list : []).slice();
  while (out.length <= i) out.push(out[out.length - 1] ?? '#ffffff');
  out[i] = colour.toLowerCase();
  return out;
}

/** Two seats too alike to tell apart at a glance (a plain distance in RGB; a hint, not a rule). → [[i, j], ...] */
export function lookAlike(list, limit = 60) {
  const rgb = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16)), out = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    if (!isColour(list[i]) || !isColour(list[j])) continue;
    const a = rgb(list[i]), b = rgb(list[j]);
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < limit) out.push([i, j]);
  }
  return out;
}

/** The frames of a picture sheet (gf-flat-1: 6 square cells across, 1 or 3 rows). → [{ name, row, x, y, w, h }] */
export function sheetFrames(width, height, frames = ['idle', 'walk1', 'walk2', 'air', 'act', 'down']) {
  const cell = width / frames.length, rows = Math.max(1, Math.round(height / cell)), out = [];
  for (let r = 0; r < rows; r++) frames.forEach((name, i) => out.push({ name, row: r, x: i * cell, y: r * cell, w: cell, h: cell }));
  return out;
}
/** Named moves from the six frames (Aseprite's tags): what the little animated preview loops through. */
export const MOVES = { stand: ['idle'], walk: ['walk1', 'idle', 'walk2', 'idle'], jump: ['air'], act: ['act'], down: ['down'] };

/** The bodies a person may pick: the library's, those with a licence that lets a game ship them with no credit line
 *  to add (CC0), each with its picture. `current` is the id whose file the game's body slot holds now, if known. */
export function bodyChoices(bodies = [], { current = null } = {}) {
  return bodies.filter(b => b.license?.spdx === 'CC0-1.0' || b.licence === 'CC0-1.0')
    .map(b => ({ id: b.id, label: b.label ?? b.id, describe: b.describe ?? '', height: b.height ?? null, playerColour: b.playerColour !== false, preview: b.preview ?? null, tags: b.tags ?? [], current: b.id === current }));
}

/** The words of a request to the person's own session to draw a new body (the art tool: gamesfun_art_request). */
export function drawRequest({ slot, subject, style = null, plane = null }) {
  return `Draw a new picture for the slot ${slot}: ${subject}. Use the art tool (gamesfun_art_request with this game and slot, then answer the request yourself and call gamesfun_art_take), so it is checked against the picture standard and written through the slot.${style ? ` Keep the game's ${style} style.` : ''}${plane ? ` It is seen from the ${plane === 'side' ? 'side' : 'top'}.` : ''} Then tell me it is in.`;
}
/** The words of a request for a new 3D body: the session has no 3D maker of its own (docs/ART.md). */
export function modelRequest({ slot, subject }) {
  return `Make a new body for the slot ${slot}: ${subject}. Use the art tool (gamesfun_art_request with this game and slot): it says which 3D maker this machine has. If none is connected, tell me which library body is closest instead, and do not spend money without asking me.`;
}
