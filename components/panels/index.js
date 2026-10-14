// mechanic: panels (open builder M4-D). The game's door to the shared panels (kit/ui/panels): choice cards, a shop, an
// inventory, a dialogue and a text field. This part holds no behaviour of its own: it brings the panels' words and
// pictures into the game as slots (so a creator can reword and re-draw them) and hands them to rules.js.
//
//   const panels = ctx.mechanics.get('panels');
//   const h = panels.shop({ items: [{ id: 'sword', name: 'Sword', price: 20, image: 'panel.image.sword' }], currency: { label: 'Coins', amount: coins }, onChoose: ({ id }) => buy(id) });
//   h.update({ items, currency });  h.close();  const r = await panels.choice({ cards }).done;
//
// A panel shows and returns a choice. Prices, money, stock and what a purchase does are the game's, in rules.js.
import { KINDS, WORDS, WORD_KEYS } from '../../ui/panels/logic.js';

export const id = 'panels';
export const examples = ['a shop where coins buy upgrades', 'an inventory of items to use', 'a dialogue with a guide', 'pick one of three cards', 'name your pet (a text field)'];

const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const cap = s => s[0].toUpperCase() + s.slice(1);
/** `shopBuy`: the flat param name of a kind's word (loot's pattern: one string a slot, in config/game.json). */
const key = (kind, word) => `${kind}${cap(word)}`;
const WORD_LABEL = { title: 'title', buy: 'Buy button', close: 'Close button', empty: 'empty-list line', balance: 'money line', use: 'Use button', drop: 'Drop button', next: 'Next hint', done: 'Done hint', skip: 'Skip button', ok: 'OK button', cancel: 'Cancel button', hint: 'keyboard hint', placeholder: 'placeholder' };

export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    kinds: { type: 'array', items: { type: 'string', enum: KINDS }, default: ['choice'], minItems: 1, uniqueItems: true, description: 'Which panels this game uses: their words become slots (choice, shop, inventory, dialogue, input)' },
    ...Object.fromEntries(KINDS.flatMap(k => WORD_KEYS[k].map(w => [key(k, w), { type: 'string', default: WORDS[k][w], description: `${cap(k)} panel: the ${WORD_LABEL[w] ?? w}` }]))),
  },
};

const IMG = /^assets\/panels\/([a-z0-9][a-z0-9_-]*)\.(png|jpe?g|webp|svg)$/;
/** The word slots of the kinds the game uses, and a picture slot for each file under assets/panels/. */
export function slotsFor(m = {}, cfg = {}) {
  const kinds = (Array.isArray(m.params?.kinds) ? m.params.kinds : ['choice']).filter(k => KINDS.includes(k)), out = [];
  for (const k of kinds) for (const w of WORD_KEYS[k]) {
    out.push({ id: `mechanic.panels.${kebab(key(k, w))}`, label: `${cap(k)} panel: ${WORD_LABEL[w] ?? w}`, group: 'ui', type: 'text', source: { pointer: `{base}/${key(k, w)}` }, ...(w === 'balance' ? { description: 'The money line: the money name and the amount are filled in where it says label and amount in curly braces' } : {}), constraints: { maxLength: w === 'hint' || w === 'balance' ? 80 : 32 }, tier: w === 'title' ? 'main' : 'advanced', rank: w === 'title' ? 44 : 20, facet: 'text' });
  }
  for (const f of cfg.files ?? []) {
    const g = IMG.exec(f); if (!g) continue;
    out.push({ id: `panel.image.${g[1].replace(/_/g, '-')}`, label: `Panel picture: ${g[1].replace(/[-_]/g, ' ')}`, group: 'ui', type: 'image', source: { file: f }, constraints: { colorSpace: 'srgb', formats: ['png', 'jpg', 'webp', 'svg'], maxBytes: 600000 }, tier: 'main', rank: 43, facet: 'look',
      description: 'A picture a shop item, an inventory slot, a card or a dialogue portrait shows (the panel names it by this slot id)', generate: { prompt: `a clean game icon: ${g[1].replace(/[-_]/g, ' ')}`, style: 'flat, centred, transparent background' } });
  }
  return out;
}
export const slots = [];

export function create(ctx, params = {}) {
  const P = { ...Object.fromEntries(KINDS.flatMap(k => WORD_KEYS[k].map(w => [key(k, w), WORDS[k][w]]))), ...params };
  const V = k => { const sid = `mechanic.panels.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const wordsOf = kind => Object.fromEntries(WORD_KEYS[kind].map(w => [w, V(key(kind, w))]));
  const ui = () => ctx.ui?.panels;
  const stats = { opened: 0, refused: 0, remote: 0, closed: 0 };
  const open = (kind, o = {}) => {
    const h = ui()[kind]({ ...o, words: { ...wordsOf(kind), ...(o.words ?? {}) } });
    if (h.open) stats.opened++; else if (h.remote) stats.remote++; else stats.refused++;
    h.done?.then(() => { stats.closed++; });
    return h;
  };
  return {
    id, params: P, interacts: false, aimed: false, stats,
    /** Cards to pick one of: {title?, cards: [{id, name, text, image?, tag?}], onPick}. done → {id, index} | null */
    choice: o => open('choice', o),
    /** A shop: {items: [{id, name, text, price, image?, disabled?, reason?}], currency: {label, amount}, onChoose}. update({items, currency}) after a purchase */
    shop: o => open('shop', o),
    /** An inventory: {mode: 'bar' | 'grid', items: [{id, name, text, count, image?}], selected, onSelect, actions: [{id, label}], onAction} */
    inventory: o => open('inventory', o),
    /** A dialogue: {speaker, portrait?, lines, choices?: [{id, text}]}. done → {choice, index, lines, skipped} */
    dialogue: o => open('dialogue', o),
    /** A text field: {title, value, lines, maxLength, required}. done → the text | null */
    input: o => open('input', o),
    close: id => ui()?.close(id),
    words: wordsOf,
    update() {}, dispose() { ui()?.close(); },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs MANIFEST). Panels hold no game logic and keep no state, so nothing is shared.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, examples, params,
  describe: 'Panels over the game: a shop, an inventory (bar or grid), choice cards, a dialogue and a text field; they show and return a choice, and never pause the round',
  rank: 145,
  needs: { parts: [], world: [] },
  uses: [],
  owns: () => [],
  state: { key: null, fields: {} },
  events: [],
  sync: { owner: 'none', how: 'a panel is local to the copy that opens it (or the `for` player\'s copy); sending the answer to the host is the game\'s message' },
  note: [
    'A panel only shows and returns a choice: prices, money, stock and what a purchase does are rules.js. Open one on every copy that should see it; `for: player.id` makes it open on that player\'s copy only.',
    'A panel never pauses the round (a live round never does); a modal one takes only your own input. Pictures are slot ids (panel.image.<file under assets/panels/>), words are the part\'s params.',
    'Open: panels.shop({ items, currency, onChoose }), choice({ cards, onPick }), inventory({ items }), dialogue({ speaker, lines, choices }), input({ title, maxLength }); `h.update({ items })` after a purchase, `h.done` is a promise.',
  ],
  stub: {
    as: 'panels',
    worked: 'const shop = panels.shop({ items: [{ id: \'speed\', name: \'Faster shoes\', price: 10 }], currency: { label: \'Coins\', amount: 0 }, onChoose: ({ id }) => { buy(id); shop.update({ currency: { label: \'Coins\', amount: coins } }); } });',
    traps: [
      'a purchase is the game\'s: check the money on the host, take it, give the item, then h.update({ items, currency }) so the panel shows the new state',
      'a panel is local: to show every player a choice call it on every copy; to answer the host send a message (ctx.net.send) from onPick/onChoose',
    ],
  },
  signs: {
    // reported, never failed on its own: a round where no panel is opened is a round
    reportOnly: true,
    sample: (sh, stats) => { const s = stats('panels'); return s ? { panels: [s.opened ?? 0, s.refused ?? 0] } : null; },
    judge: v => {
      let n = null, bad = 0;
      for (const p of v.pages) for (const s of p.samples) { const x = s.sh?.panels; if (x) { n = Math.max(n ?? 0, x[0]); bad = Math.max(bad, x[1]); } }
      v.add('a panel opens', bad ? 'dead' : n ? 'ok' : 'note', 'controls().mechanics[panels].stats (opened, refused)', bad ? `${bad} panel call${bad === 1 ? ' was' : 's were'} refused (the console says why)` : n === null ? 'panels were not seen on these pages' : n ? `${n} opened` : 'no panel was opened in this round', bad ? 'read the console line "gf-three panel refused" and fix the options' : '');
    },
  },
};
