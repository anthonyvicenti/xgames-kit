// gf-three panels: the pure part (Node imports it; no DOM). What each kind of panel is, the words it says by default,
// what it refuses at the call, and the small rules the DOM part follows (which key picks which card, how a dialogue
// pages, how many lines a text field keeps). A panel holds no game logic: prices, money and stock are the caller's.

export const KINDS = ['choice', 'shop', 'inventory', 'dialogue', 'input'];

/** The words a panel says when the caller gives none (a game's own come from its slots: kit/mechanics/panels). */
export const WORDS = {
  choice: { title: 'Choose one', close: 'Close' },
  shop: { title: 'Shop', buy: 'Buy', close: 'Close', empty: 'Nothing for sale right now', balance: '{label}: {amount}' },
  inventory: { title: 'Items', empty: 'Nothing here yet', close: 'Close', use: 'Use', drop: 'Drop' },
  dialogue: { next: 'Next', done: 'Done', skip: 'Skip' },
  input: { title: 'Type here', ok: 'OK', cancel: 'Cancel', hint: 'Ctrl+Enter to confirm', placeholder: '' },
};

/** The word keys each kind brings as slots (kit/mechanics/panels declares one text slot per key, per game). */
export const WORD_KEYS = Object.fromEntries(KINDS.map(k => [k, Object.keys(WORDS[k])]));

/** Which of n options a key press picks: '1'..'9' → 0..8, '0' → 9; null when it is not one of the first n. */
export function digitIndex(key, n) {
  if (typeof key !== 'string' || !/^[0-9]$/.test(key)) return null;
  const i = key === '0' ? 9 : Number(key) - 1;
  return i < n ? i : null;
}

/** Fill {name} holes in a word. */
export const fill = (text, vars = {}) => String(text ?? '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));

/** A text field's value held to `lines` rows and `maxLength` characters (a new line past the last row is dropped). */
export function clampText(value, { lines = 1, maxLength = 80 } = {}) {
  let v = String(value ?? '').replace(/\r/g, '');
  v = lines <= 1 ? v.replace(/\n/g, ' ') : v.split('\n').slice(0, lines).join('\n');
  return v.slice(0, maxLength);
}
/** Is a plain Enter allowed to add a row (it is when there is a row left)? */
export const enterAddsRow = (value, lines) => lines > 1 && String(value ?? '').split('\n').length < lines;

/** A dialogue's lines as a list of strings. */
export const linesOf = l => (Array.isArray(l) ? l : l === undefined || l === null || l === '' ? [] : [l]).map(String).filter(s => s.length);

/** The dialogue's state machine: a key or tap → what to do. s = {i (line), n (lines), typing, choices (the last line asks)}. */
export function dialogueStep(s) {
  if (s.typing) return { act: 'finish-line' };
  if (s.i < s.n - 1) return { act: 'next', i: s.i + 1 };
  if (s.choices) return { act: 'wait-for-choice' };
  return { act: 'end' };
}

const isStr = v => typeof v === 'string' && v.length > 0;
const isSlot = v => v === undefined || v === null || (typeof v === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(v));

/**
 * What is wrong with the options of a panel call (empty when it is whole). `known(slotId)` says whether a picture's
 * slot exists (the game's assets.json); omitted, pictures are not judged. Every message names the fix.
 */
export function problems(kind, o = {}, known = null) {
  const bad = [];
  if (!KINDS.includes(kind)) return [`unknown panel "${kind}": the kinds are ${KINDS.join(', ')}`];
  const items = (list, what) => {
    if (!Array.isArray(list) || !list.length) { bad.push(`${what}: give a non-empty list`); return; }
    const seen = new Set();
    list.forEach((it, i) => {
      if (!it || typeof it !== 'object') { bad.push(`${what}[${i}]: an object {id, name, ...}`); return; }
      if (!isStr(it.id) && typeof it.id !== 'number') bad.push(`${what}[${i}].id: a string or number the panel returns when it is chosen`);
      else if (seen.has(String(it.id))) bad.push(`${what}[${i}].id "${it.id}" is used twice`); else seen.add(String(it.id));
      if (!isStr(it.name) && !isStr(it.text) && !it.node && !it.image && !it.icon) bad.push(`${what}[${i}]: needs a name, text, icon or image to show`);
      if (!isSlot(it.image)) bad.push(`${what}[${i}].image "${it.image}": a picture slot id such as panel.image.sword, never a URL or a path`);
      else if (it.image && known && !known(it.image)) bad.push(`${what}[${i}].image "${it.image}" is not a slot in assets.json: add the picture under assets/panels/ and run slots.mjs --write`);
    });
  };
  if (kind === 'choice') { items(o.cards, 'cards'); if (Array.isArray(o.cards) && o.cards.length > 9) bad.push('cards: at most 9 (the keys 1 to 9)'); }
  if (kind === 'shop') {
    if (!Array.isArray(o.items)) bad.push('items: give a list (it may be empty)'); else if (o.items.length) items(o.items, 'items');
    for (const [i, it] of (o.items ?? []).entries()) if (it && it.price !== undefined && typeof it.price !== 'number' && typeof it.price !== 'string') bad.push(`items[${i}].price: a number (or the text to show)`);
  }
  if (kind === 'inventory') {
    if (o.mode && !['bar', 'grid'].includes(o.mode)) bad.push('mode: "bar" or "grid"');
    if (!Array.isArray(o.items)) bad.push('items: give a list (it may be empty)'); else if (o.items.length) items(o.items, 'items');
  }
  if (kind === 'dialogue') {
    if (!linesOf(o.lines).length) bad.push('lines: a string or a list of strings to say');
    if (!isSlot(o.portrait)) bad.push(`portrait "${o.portrait}": a picture slot id such as panel.image.guide`);
    else if (o.portrait && known && !known(o.portrait)) bad.push(`portrait "${o.portrait}" is not a slot in assets.json`);
    if (o.choices !== undefined) { if (Array.isArray(o.choices)) items(o.choices.map(c => ({ name: c?.text, ...c })), 'choices'); else bad.push('choices: a list of {id, text}'); }
  }
  if (kind === 'input') {
    if (o.lines !== undefined && !(Number.isInteger(o.lines) && o.lines >= 1 && o.lines <= 6)) bad.push('lines: 1 to 6');
    if (o.maxLength !== undefined && !(Number.isInteger(o.maxLength) && o.maxLength >= 1 && o.maxLength <= 400)) bad.push('maxLength: 1 to 400');
  }
  if (o.for !== undefined && !(isStr(o.for) || typeof o.for === 'number')) bad.push('for: a player id (the panel opens only on that player\'s copy)');
  return bad;
}
