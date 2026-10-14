// What the loop asks the registry, and nothing more. The registry answers from manifests (registry/, its queries in
// contracts/registry/build-catalog.mjs); the loop never names a runtime, a loop or a kind in its own code, and never
// routes on a word of the idea. Every answer below comes from data.
//
// The interface (all synchronous or async; the loop awaits each):
//   runtimes()     → [{id, status: {exists, tested, open}, rank, profiles: [{id, dimension, cameras, devices, graphics,
//                      capabilities}], limits: 'plain words a pitch says about it (devices, browsers)', defaultKind}]
//   compat(limits) → {ok, problems, findings, runtimes: {'<runtime>' | '<runtime>/<profile>': {runtime, profile, open,
//                      fits, misses: [{limit, need, has}], lacks: [capability]}}}, where limits = {devices, graphics, camera, dimension, needs}
//   loops()        → [{id, acts, describe, status: {open}, near: [loop ids]}]   acts: who acts when, one word per loop
//   kinds()        → [{id, describe, proven: ['<runtime>/<profile>' | '<runtime>'], packs}]
//   mechanics()    → [{id, describe, runtimes: [...], capabilities: [...]}]
//   capabilities() → [{id, describe}]                                   what a ledger line's `needs` may name
//   vocabulary()   → {devices: [...], graphics: [...], cameras: [...], dimensions: [...], together: [...], bodies: [...]}
//   manifest(type, id) → the manifest of one runtime ('runtime', '<runtime>/<profile>'), loop, mechanic, kind or pack:
//                      {id, describe, note: [...], traps: [...], events, sync, gates: {A..F: {measures, skips}}, promise?}
export const REGISTRY_CALLS = ['runtimes', 'compat', 'loops', 'kinds', 'mechanics', 'capabilities', 'vocabulary', 'manifest'];

/** Throws when a registry lacks a call the loop makes. */
export function checkRegistry(r) {
  const missing = REGISTRY_CALLS.filter(k => typeof r?.[k] !== 'function');
  if (missing.length) throw new Error(`the registry the loop was given has no ${missing.join(', ')} (builder/loop/registry.mjs lists the calls)`);
  return r;
}

/** The runtime ids that are open to pitches, with their profiles. */
export async function openRuntimes(r) {
  return (await r.runtimes()).filter(x => x.status?.open);
}

/** A kind's proof on a runtime: proven on the runtime as a whole, or on that profile. */
export const provenOn = (kind, runtime, profile) => !!kind?.proven?.some(p => p === runtime || (profile && p === `${runtime}/${profile}`));

/** A runtime with its profile, as one id: 'three/standard-3d', or 'forge' for a runtime with no profiles. */
export const rid = (runtime, profile) => (profile ? `${runtime}/${profile}` : runtime);

/** 'mechanic:tag', 'loop:turns', 'runtime:three', 'kind:silly', 'capability:vehicle' → {type, id}. */
export function parseBy(by) {
  const m = /^(mechanic|loop|runtime|kind|capability|pack):([a-z0-9][a-z0-9._/-]*)$/.exec(String(by ?? ''));
  return m ? { type: m[1], id: m[2] } : null;
}

/** Does the registry know what `by` names? → null when it does, else the reason. */
export async function byProblem(r, by) {
  const ref = parseBy(by);
  if (!ref) return `"${by}" is not a registry reference: write mechanic:<id>, loop:<id>, runtime:<id>, kind:<id>, capability:<id> or pack:<id>`;
  const list = ref.type === 'mechanic' ? await r.mechanics() : ref.type === 'loop' ? await r.loops() : ref.type === 'runtime' ? await r.runtimes()
    : ref.type === 'kind' ? await r.kinds() : ref.type === 'capability' ? await r.capabilities() : null;
  if (!list) return null;      // packs are the library's: the resolver answers for them at create
  return list.some(x => x.id === ref.id) ? null : `the registry has no ${ref.type} "${ref.id}"`;
}
