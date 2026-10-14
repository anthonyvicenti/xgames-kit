// Asset manifest v1.3 group defaults (docs/asset-manifest.md "Group defaults"). `groups[].defaults` holds slot fields
// that most slots in a group share; normalizeManifest() gives every slot its group's defaults, the slot's own value
// winning (`generate` and `constraints` merge key by key). Every reader of slots goes through it: lib/manifest.mjs
// (Studio's routes, drafts and UI), builder/asset-manifest/validate.mjs, check.mjs, asset-quality.mjs,
// capture-previews.mjs and facets.mjs, and the worker's playtest and edit path.
// No imports on purpose: the worker container mounts studio-lib but not studio-lib/vendor, which
// lib/manifest.mjs imports (the audio kit), so the validator loads this file directly. lib/manifest.mjs re-exports it.

/** Slot fields a group may default. Addresses (id, group, label, type, source), bakes, previews and captures stay per slot. */
export const GROUP_DEFAULT_KEYS = ['tier', 'facet', 'license', 'generate', 'constraints', 'editable', 'readonlyReason', 'lazy', 'probe'];
const MERGED = new Set(['generate', 'constraints']);
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Problems with one group's `defaults` (shape only; the values are checked on every slot they reach). */
export function groupDefaultsProblems(group) {
  const d = group?.defaults;
  if (d === undefined) return [];
  if (!isObject(d)) return ['defaults must be an object of slot fields'];
  const out = [];
  for (const k of Object.keys(d)) if (!GROUP_DEFAULT_KEYS.includes(k)) out.push(`defaults.${k}: not a group default (allowed: ${GROUP_DEFAULT_KEYS.join(', ')})`);
  for (const k of MERGED) if (d[k] !== undefined && !isObject(d[k])) out.push(`defaults.${k} must be an object`);
  return out;
}

/** One slot with its group's defaults applied. A slot that sets `editable` back to true drops a defaulted readonlyReason. */
export function applyGroupDefaults(slot, defaults) {
  if (!isObject(slot) || !isObject(defaults)) return slot;
  const out = {...slot};
  for (const k of GROUP_DEFAULT_KEYS) {
    if (!Object.hasOwn(defaults, k)) continue;
    if (MERGED.has(k) && isObject(defaults[k])) { if (slot[k] === undefined || isObject(slot[k])) out[k] = {...clone(defaults[k]), ...(slot[k] ?? {})}; }
    else if (slot[k] === undefined) out[k] = clone(defaults[k]);
  }
  if (out.editable !== false && slot.readonlyReason === undefined) delete out.readonlyReason;
  return out;
}

/**
 * The manifest as its readers see it: each slot with its group's defaults. Returns `m` itself when no group has
 * defaults (or the shape is too broken to apply them; validators report that), else a shallow copy with new slots.
 */
export function normalizeManifest(m) {
  if (!isObject(m) || !Array.isArray(m.slots) || !Array.isArray(m.groups)) return m;
  const byGroup = new Map();
  for (const g of m.groups) if (isObject(g?.defaults) && Object.keys(g.defaults).length) byGroup.set(g.id, g.defaults);
  if (!byGroup.size) return m;
  return {...m, slots: m.slots.map(s => (isObject(s) && byGroup.has(s.group) ? applyGroupDefaults(s, byGroup.get(s.group)) : s))};
}
