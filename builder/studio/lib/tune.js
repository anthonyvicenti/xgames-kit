// The Tune tab's logic, with no DOM. A tunable is a main-tier value slot whose type a control can edit safely
// (number, integer, boolean, enum): no free code, no file slots. EVERY change the kit allows today writes the config
// file the slot points at, and the dev server's file watcher then reloads the preview, so every change is "reload".
// (A live in-round hook does not exist in gf-three; when one does, set LIVE_IDS or `live: true` in the slot.)

export const TUNE_TYPES = ['number', 'integer', 'boolean', 'enum'];
export const APPLIES = { reload: 'Applies with a reload of the preview (automatic)', live: 'Applies at once, in the round' };

export function tunables(slots) {
  return slots.filter(s => s.kind === 'value' && TUNE_TYPES.includes(s.type) && (s.tier ?? 'main') === 'main')
    .map(s => ({ ...s, applies: s.constraints?.live === true ? 'live' : 'reload' }));
}

/** Staged edits → the changes to post (only those that differ from the slot's current value). */
export function pendingChanges(slots, staged) {
  const out = [];
  for (const [id, value] of Object.entries(staged)) {
    const s = slots.find(x => x.id === id);
    if (s && !sameValue(s.value, value)) out.push({ id, value });
  }
  return out;
}
export const sameValue = (a, b) => (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : String(a) === String(b));

/** The range of a number slot for a slider: both ends known, else null (then a number box). */
export function sliderRange(s) {
  const c = s.constraints ?? {};
  if (typeof c.min !== 'number' || typeof c.max !== 'number' || !(c.max > c.min)) return null;
  const step = s.type === 'integer' ? 1 : (c.step ?? (c.max - c.min) / 100);
  return { min: c.min, max: c.max, step };
}
