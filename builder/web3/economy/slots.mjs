// Every number in an economy as a value slot (gf-assets/1, gf-three CONTRACT §2): an id, a label, a type and a
// JSON pointer into gamesfun.json, so the studio and `gamesfun slots set` change it with no code. Ids read
// `economy.<kind>.<key>.<field>`: economy.box.flip.price, economy.box.flip.outcomes.0.chance. Pure.
import { KINDS } from './model.mjs';

/** Fields that are structure, not tuning: the program's ids and the places a recipe points at. */
const STRUCTURE = new Set(['id', 'index', 'version', 'decimals', 'place', 'from', 'to', 'sides']);
const INTEGER = new Set(['supply', 'uses', 'count', 'weight', 'halveEvery', 'maxRuns', 'atLeast']);
const PERCENT = new Set(['percent', 'chance', 'growthPercent', 'cutPercent', 'royaltyPercent', 'transferFeePercent']);
/** The few a creator tunes most, shown first; the rest are "advanced". */
const MAIN = new Set(['price', 'chance', 'seed', 'amount', 'places', 'percent', 'lock', 'every']);

const escape = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

function slot(id, label, pointer, value, field) {
  const duration = typeof value === 'string' && /^\d+(\.\d+)?(s|m|h|d|w)$/.test(value);
  const type = typeof value === 'string' ? 'text' : INTEGER.has(field) ? 'integer' : 'number';
  const constraints = PERCENT.has(field) ? { min: 0, max: 100 } : typeof value === 'number' ? { min: 0 } : duration ? { pattern: '^\\d+(\\.\\d+)?(s|m|h|d|w)$' } : { pattern: '^\\d+(\\.\\d+)?$' };
  return { id, label, group: 'economy', type, source: { file: 'gamesfun.json', pointer }, constraints, tier: MAIN.has(field) ? 'main' : 'advanced' };
}

/** The value slots of an economy section. */
export function economySlots(economy) {
  const slots = [];
  const walk = (value, idPath, pointer, label, field) => {
    if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?(s|m|h|d|w)?$/.test(value))) {
      if (!STRUCTURE.has(field)) slots.push(slot(idPath.join('.'), label, pointer, value, field));
      return;
    }
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...idPath, i], `${pointer}/${i}`, `${label} ${i + 1}`, field));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, [...idPath, k], `${pointer}/${escape(k)}`, `${label} ${k}`, k);
  };
  // A token's numbers (decimals, a mint's transfer fee) are facts about the mint, not tuning: no slots.
  for (const [list, kind] of Object.entries(KINDS).filter(([list]) => list !== 'tokens'))
    (economy?.[list] ?? []).forEach((part, i) => {
      for (const [k, v] of Object.entries(part)) if (k !== 'key') walk(v, ['economy', kind, part.key, k], `/economy/${list}/${i}/${escape(k)}`, `${part.name ?? part.key}: ${k}`, k);
    });
  if (economy?.collection?.royaltyPercent !== undefined) slots.push(slot('economy.collection.royaltyPercent', 'Collection: royalty', '/economy/collection/royaltyPercent', economy.collection.royaltyPercent, 'royaltyPercent'));
  if (economy?.scenario) walk(economy.scenario, ['economy', 'scenario'], '/economy/scenario', 'Scenario', 'scenario');
  return slots;
}
