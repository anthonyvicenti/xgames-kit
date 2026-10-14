// The item editor's logic, with no DOM: a game's items as cards. What an item is comes from the game itself, never
// from a list here: assets.json → items (written by gf-three's slots tool from each mechanic's `manifest.items`,
// CONTRACT §2.4) names, per mechanic, either
//
//   a table    { mechanic, as, noun, nouns, table: <json slot id> }   the slot holds the whole list (melee's weapons, loot's
//              upgrade cards); its constraints.item says what one entry is: each field's words, range and unit, the
//              fields a card shows first (`front`), its picture, the least and most entries
//   a single   { mechanic, as, noun, single: true, picture, fields, front }   one thing whose fields are slot ids (a
//              pickup, a shot, a thing to carry, a loot drop)
//
// A card is a view over slots. A number is written through POST /api/game/slots/value, where the kit checks it and
// refuses in words; adding, removing and renaming an entry is one write of its table slot, made with the kit's own
// addLike / removeItem (the game's kit/assets/items.js, passed in as `kit`).

export const PER_CARD = 4;               // numbers a card shows before "More"

const isNumberType = t => t === 'number' || t === 'integer';
const isEditable = s => s.kind === 'value' && (['number', 'integer', 'boolean', 'color', 'enum'].includes(s.type) || (s.type === 'text' && Array.isArray(s.constraints?.enum)));
const cap = t => String(t ?? '').replace(/^./, c => c.toUpperCase());
const esc = t => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => JSON.parse(JSON.stringify(v));
const getAt = (doc, ptr) => String(ptr).split('/').filter(Boolean).reduce((v, k) => (v == null ? undefined : v[k]), doc);

/** The schema of one field inside an entry ('combo/0/damage'), or null. */
export function fieldSchemaOf(item, ptr) {
  let s = item?.schema;
  for (const k of String(ptr).split('/').filter(Boolean)) {
    if (!s) return null;
    s = /^\d+$/.test(k) && s.items ? s.items : s.properties?.[k] ?? null;
  }
  return s ?? null;
}

/** "your water soaker, limited by its tank" → "Water soaker" */
export function firstWords(as) {
  if (!as) return null;
  const head = String(as).split(/[,;:(]/)[0].replace(/^(your|a|an|the)\s+/i, '').trim();
  return head ? cap(head) : null;
}

/** A field's label inside its own card: "Pillow, swing 1: damage" reads "Swing 1: damage" on Pillow's card. */
const ownLabel = (label, name) => cap(String(label).replace(new RegExp(`^${esc(name)}[,:]\\s*`, 'i'), ''));
/** Numbers first (in the slots' own order), then the rest. */
const numbersFirst = list => [...list].sort((a, b) => (isNumberType(a.type) ? 0 : 1) - (isNumberType(b.type) ? 0 : 1));

/**
 * The game's items as cards. slots: GET /api/game/slots?all=1 → slots; index: its `items` (assets.json → items).
 * → { cards, tables: [{ slot, item, ids, mechanic, as, noun, nouns, start }] }; empty when the game has no index
 */
export function itemsOf(slots, index) {
  const byId = new Map(slots.map(s => [s.id, s])), cards = [], tables = [];
  for (const it of Array.isArray(index) ? index : []) {
    if (it.table) {
      const t = byId.get(it.table);
      const item = t?.constraints?.item;
      if (!t || !item) continue;
      const list = Array.isArray(t.value) ? t.value : [];
      const idKey = item.id ?? 'id', nameKey = item.name ?? 'name';
      const ids = list.map(e => (isObj(e) ? e[idKey] : e));
      const start = startSlotOf(slots, it.mechanic, ids);
      const table = { slot: t, item, ids, mechanic: it.mechanic, as: it.as ?? null, noun: it.noun ?? item.noun ?? 'item', nouns: it.nouns ?? item.nouns ?? `${it.noun ?? 'item'}s`, start };
      tables.push(table);
      // a list of the kit's own things (loot's upgrade cards): one card of switches
      if (!(item.schema?.type === 'object' || item.schema?.properties)) {
        const choices = item.schema?.enum ?? ids;
        cards.push({ id: `${t.id}:switches`, kind: 'switches', table: t.id, mechanic: it.mechanic, name: cap(table.nouns), what: it.as ?? `the ${table.nouns} this game may offer`, noun: table.noun, picture: null, show: null, main: [], more: [],
          options: choices.map(c => ({ id: c, name: item.words?.[c]?.name ?? String(c), text: item.words?.[c]?.text ?? '', on: list.includes(c) })) });
        continue;
      }
      list.forEach((entry, i) => {
        if (!isObj(entry)) return;
        const name = String(entry[nameKey] ?? entry[idKey] ?? `${table.noun} ${i + 1}`);
        const base = `${t.pointer}/${i}/`;
        // this entry's own slots: the ones whose pointer is inside it (a number, its colour); its picture by the declaration
        const own = slots.filter(s => s.kind === 'value' && s.file === t.file && typeof s.pointer === 'string' && s.pointer.startsWith(base) && isEditable(s))
          .map(s => ({ ...s, label: ownLabel(s.label ?? s.id, name), field: s.pointer.slice(base.length) }));
        const picSlot = item.picture?.slot ? byId.get(item.picture.slot.replace('<id>', entry[idKey])) : null;
        const front = (item.front ?? []).filter(f => f !== nameKey && f !== idKey);
        const main = [];
        for (const f of front) {
          const s = own.find(x => x.field === f);
          if (s) { main.push(s); continue; }
          // a front field with no slot of its own (a weapon's rarity) is still a field: written as part of the table
          const sch = fieldSchemaOf(item, f);
          if (!sch || !(isNumberType(sch.type) || sch.type === 'boolean')) continue;
          main.push({ id: `${t.id}#${i}/${f}`, label: cap(sch.title ?? f), type: sch.type, kind: 'value', tier: 'main', field: f, via: { table: t.id, index: i, field: f },
            value: getAt(entry, f) ?? sch.default, constraints: { min: sch.minimum, max: sch.maximum, unit: sch.unit }, description: sch.description ?? null });
        }
        const shown = main.slice(0, PER_CARD);
        cards.push({
          id: `${t.id}:${entry[idKey]}`, kind: 'entry', table: t.id, mechanic: it.mechanic, entryId: entry[idKey], index: i, name, noun: table.noun,
          what: list.length > 1 ? `one of ${list.length} ${table.nouns}${it.as ? ` (${it.as})` : ''}` : it.as ?? `a ${table.noun}`,
          picture: picSlot ? { slot: picSlot.id, type: picSlot.type, file: picSlot.file } : null,
          colour: own.find(s => s.type === 'color')?.value ?? entry.color ?? null,
          show: null, starts: !!start && start.value === entry[idKey],
          main: shown, more: numbersFirst([...main.slice(PER_CARD), ...own.filter(s => !shown.includes(s))]),
        });
      });
      continue;
    }
    if (it.single) {
      const pic = it.picture ? byId.get(it.picture) : null;
      const fields = (it.fields ?? []).map(id => byId.get(id)).filter(s => s && isEditable(s));
      const main = (it.front ?? []).map(id => fields.find(s => s.id === id)).filter(Boolean).slice(0, PER_CARD);
      // the picture's own slots (a prop's size and count) sit with the card, behind "More"
      const ownOfPic = pic ? slots.filter(s => s.id.startsWith(`${pic.id}.`) && isEditable(s)) : [];
      cards.push({
        id: `${it.mechanic}:single`, kind: 'single', mechanic: it.mechanic, noun: it.noun ?? 'item',
        name: pic?.label ?? firstWords(it.as) ?? cap(it.noun ?? it.mechanic), what: it.as ?? `a ${it.noun ?? 'thing'}`,
        picture: pic ? { slot: pic.id, type: pic.type, file: pic.file ?? null } : null,
        colour: fields.find(s => s.type === 'color')?.value ?? null,
        show: pic && /^prop\./.test(pic.id) ? pic.id : null,
        main, more: numbersFirst([...fields.filter(s => !main.includes(s)), ...ownOfPic]),
      });
    }
  }
  return { cards, tables };
}

/** The slot that says which entry everyone starts with: a text slot of the same mechanic whose choices are the table's ids
 *  (melee's mechanic.melee.start-weapon). Found by its choices, so no mechanic is named here. */
export function startSlotOf(slots, mechanic, ids) {
  const want = [...ids].map(String).sort().join('\n');
  return slots.find(s => s.kind === 'value' && s.type === 'text' && s.id.startsWith(`mechanic.${mechanic}.`) && Array.isArray(s.constraints?.enum)
    && [...s.constraints.enum].map(String).sort().join('\n') === want) ?? null;
}

/** A slider's range for a number field: the slot's own min and max; a step that suits the range. Null: a number box. */
export function fieldRange(s) {
  const c = s.constraints ?? {};
  if (typeof c.min !== 'number' || typeof c.max !== 'number' || !(c.max > c.min)) return null;
  const span = c.max - c.min, step = s.type === 'integer' ? 1 : span <= 1 ? 0.01 : span <= 10 ? 0.1 : span <= 100 ? 0.5 : 1;
  return { min: c.min, max: c.max, step };
}
/** A number held inside its slot's range and step (what the slider shows and the save sends). */
export function clampField(s, v) {
  const r = fieldRange(s), n = Number(v);
  if (!Number.isFinite(n)) return s.value;
  if (!r) return s.type === 'integer' ? Math.round(n) : n;
  const k = Math.round((Math.min(r.max, Math.max(r.min, n)) - r.min) / r.step) * r.step + r.min;
  return s.type === 'integer' ? Math.round(k) : Math.round(k * 1000) / 1000;
}

/** The same number on the other entries of the same table (see your item beside the others). → [{ name, value }] */
export function peersOf(cards, card, field) {
  if (card.kind !== 'entry' || !field) return [];
  const out = [];
  for (const c of cards) {
    if (c === card || c.table !== card.table) continue;
    const s = [...c.main, ...c.more].find(x => x.field === field && isNumberType(x.type));
    if (s) out.push({ name: c.name, value: s.value });
  }
  return out;
}

/** Does a running game take this field without a reload? Only a number with a slot of its own: the kit answers for it
 *  (gf:slot → live 'taken' or 'on-use'). Anything else (a colour, a model, a name, a new entry) reloads. */
export const takesLive = f => f.kind === 'value' && isNumberType(f.type) && !f.via;

/** Plain words for what happened to the running game after a save. how: the kit's answer ('taken', 'on-use',
 *  'reload'), null when no answer came, or 'saved' for a change that always reloads. */
export function liveWords(how, label) {
  if (how === 'taken') return `${label}: playing now, no reload.`;
  if (how === 'on-use') return `${label}: playing now, no reload. The game uses it the next time it needs it.`;
  if (how === 'saved') return `${label}: saved. The game reloads to show it.`;
  return `${label}: saved. The game reloaded to show it.`;
}

// ---- writes of a table: one slot write each, made by the kit's own functions ----

/** A new entry like `like`, with its own id and name. → { table, entry } | { problem } */
export function addEntry(kit, item, table, { like = null, name = '' } = {}) {
  const words = String(name ?? '').trim();
  if (!words) return { problem: `Give the new ${item?.noun ?? 'item'} a name.` };
  try { return kit.addLike(item, table, { like, name: words }); } catch (e) { return { problem: e.message }; }
}
/** The table without one entry (the kit refuses its last). → { table } | { problem } */
export function removeEntry(kit, item, table, id) { return kit.removeItem(item, table, id); }
/** The table with one entry's name changed (its id, slots and picture stay). → { table } | { problem } */
export function renameEntry(item, table, id, name) {
  const words = String(name ?? '').trim(), idKey = item?.id ?? 'id', nameKey = item?.name ?? 'name';
  if (!words) return { problem: 'A name needs at least one letter.' };
  const i = (table ?? []).findIndex(e => isObj(e) && e[idKey] === id);
  if (i < 0) return { problem: `There is no ${item?.noun ?? 'item'} "${id}".` };
  const next = clone(table); next[i][nameKey] = words;
  return { table: next };
}
/** The table with one field inside one entry changed (a front field with no slot of its own). → { table } */
export function setEntryField(table, index, field, value) {
  const next = clone(table), keys = String(field).split('/').filter(Boolean);
  let cur = next[index];
  for (const k of keys.slice(0, -1)) { cur[k] ??= /^\d+$/.test(k) ? [] : {}; cur = cur[k]; }
  cur[keys.at(-1)] = value;
  return { table: next };
}
/** A list of the kit's own things with one switched on or off (order kept as the kit lists them). → { table } */
export function switchOption(table, choices, id, on) {
  const set = new Set(Array.isArray(table) ? table : []);
  if (on) set.add(id); else set.delete(id);
  return { table: choices.filter(c => set.has(c)) };
}

// ---- what slots cannot do: the person's own session ----

/** The words of a request to the person's own session for a new look for an item (a model or picture from words). */
export function lookRequest(card, words, table = null) {
  const item = table?.item, P = item?.picture;
  const where = card.picture?.slot ? `its ${card.picture.type} slot ${card.picture.slot} (npx gamesfun slots set ${card.picture.slot} --file <path>)`
    : P && card.kind === 'entry' ? `the file ${(P.dir ?? 'assets/models')}/${P.file.replace('<id>', card.entryId)}, then set this ${card.noun}'s "${P.field}" field to that file name in the table slot ${card.table} (npx gamesfun slots set ${card.table} @table.json; the kit checks it)`
      : 'a slot of its own';
  return `Make a new look for "${card.name}" (${card.what}): ${words}. Use the art tool (gamesfun_art_request with this game: it says which maker this machine has and asks before spending), and put the result in ${where}. Keep everything else as it is, then verify.`;
}
/** The words of a request to balance one card's numbers. */
export function balanceRequest(card, goal = '') {
  const nums = [...card.main, ...card.more].filter(s => isNumberType(s.type)).map(s => `${s.label} (${s.via ? `${s.via.table} → ${card.entryId}/${s.via.field}` : s.id}) = ${s.value}${s.constraints?.unit ? ` ${s.constraints.unit}` : ''} [${s.constraints?.min ?? '?'}..${s.constraints?.max ?? '?'}]`).join('; ');
  return `Balance "${card.name}" (${card.what}). ${goal ? `The aim: ${goal}. ` : ''}Its numbers now: ${nums}. Change only these slots (npx gamesfun slots set), each inside its range, say why for each change, then play a round and verify.`;
}
