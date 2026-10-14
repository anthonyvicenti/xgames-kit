// The game spec v2 (builder/spec/game-spec.v2.schema.json): read one, refuse anything else, hold it to the schema and
// to the registry, and answer what the spec leaves to its kind or its runtime. A game is placed by `runtime` (with its
// `profile`), `loop` and `kind`; there is no `engine` and no reading of an older spec (the creator, 2026-10-13: no
// backwards compatibility). An older spec is refused with what to do instead: write it again as v2.
//
//   const { spec, problems, findings } = await readSpec(file);      // problems: the schema's, then the registry's
//   const look = lookOf(spec, catalog);                              // {preset, time, palette?}: the spec's, else its kind's
import { readFile } from 'node:fs/promises';
import { CATALOG } from './paths.mjs';
import { loadSchemas, SCHEMA } from '../../../registry/schemas.mjs';
import { checkSpec } from '../../../registry/build-catalog.mjs';

export const SPEC_VERSION = 2;

/**
 * Is this a spec v2 at all? → [] or one problem that says what it is and what to do. A spec with an `engine`, a
 * `specVersion` other than 2 or none is an older spec: nothing reads it (no upgrade, no normalizing).
 */
export function versionProblems(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['spec: a game spec is a JSON object'];
  if (spec.specVersion === SPEC_VERSION && !('engine' in spec)) return [];
  const was = [`specVersion ${spec.specVersion === undefined ? '(none)' : JSON.stringify(spec.specVersion)}`, ...('engine' in spec ? [`engine ${JSON.stringify(spec.engine)}`] : [])].join(', ');
  return [`spec: this is not a spec v2 (${was}). xgames-kit reads spec v2 only: "specVersion": 2 with "runtime", "profile" (for a runtime that has profiles), "loop" and "kind" in place of "engine" (builder/spec/game-spec.v2.schema.json). Nothing upgrades an older spec: write it again as v2 (npx gamesfun catalog lists the runtimes, profiles, loops and kinds).`];
}

let schemas = null;
/** The schema's problems with a spec v2 (ajv, every $ref resolved). → ['/players/max: must be <= 16', …] */
export async function schemaProblems(spec) {
  schemas ??= await loadSchemas();
  return schemas.validate(SCHEMA.spec, spec).map(p => `spec ${p}`);
}

let cached = null;
/** registry/catalog.json, read once a process (node registry/build-catalog.mjs writes it; a test fails when it is stale). */
export async function readCatalog() {
  cached ??= JSON.parse(await readFile(CATALOG, 'utf8'));
  return cached;
}

/**
 * A spec v2 held to its version, its schema and the registry, in that order (each step only when the one before found
 * nothing). → {problems, findings}: problems stop create; findings are said plainly and never stop a build (an
 * untested device, a kind this game proves, a loop it builds).
 */
export async function checkSpecV2(spec, { catalog = null } = {}) {
  const v = versionProblems(spec);
  if (v.length) return { problems: v, findings: [] };
  const s = await schemaProblems(spec);
  if (s.length) return { problems: s, findings: [] };
  const r = checkSpec(catalog ?? await readCatalog(), spec);
  return { problems: r.problems.map(p => `spec ${p}`), findings: r.findings };
}

/** Read and check a spec file. → {spec, bytes, problems, findings} (spec null when the file is not JSON). */
export async function readSpec(file, opts = {}) {
  const bytes = await readFile(file);
  let spec;
  try { spec = JSON.parse(bytes.toString('utf8')); } catch (e) { return { spec: null, bytes, problems: [`spec is not JSON: ${e.message}`], findings: [] }; }
  return { spec, bytes, ...(await checkSpecV2(spec, opts)) };
}

const byId = (list, id) => (list ?? []).find(x => x.id === id) ?? null;
const inProfile = (x, profile) => !x?.profiles || !profile || x.profiles.includes(profile);

/**
 * The look a game is made with: the spec's own `look.preset` when it names one, else its kind's look on this runtime
 * (and profile), else the runtime's first look for the profile (a kind with no look here is built by the game: a build
 * item with that kind). time: the spec's, else the kind's, else the look's first. → {preset, time, palette?, from}
 */
export function lookOf(spec, catalog) {
  const rt = byId(catalog.runtimes, spec.runtime), profile = spec.profile ?? null;
  const looks = (rt?.looks ?? []).filter(l => inProfile(l, profile));
  const kindLook = byId(catalog.kinds, spec.kind)?.look?.[spec.runtime];
  const kindHere = kindLook && (!kindLook.profile || !profile || kindLook.profile === profile) ? kindLook : null;
  const preset = spec.look?.preset ?? kindHere?.preset ?? looks[0]?.id ?? null;
  const times = byId(looks, preset)?.times ?? [];
  const time = spec.look?.time ?? (kindHere?.preset === preset ? kindHere.time : null) ?? times[0] ?? 'day';
  const from = spec.look?.preset ? 'spec' : kindHere ? `kind ${spec.kind}` : `${spec.runtime}${profile ? `/${profile}` : ''}'s first look (kind ${spec.kind} has no look here: the game builds it)`;
  return { preset, time, ...(spec.look?.palette ? { palette: spec.look.palette } : {}), from };
}

/** A flat-2d game's plane, from its camera (a hard limit of the profile): side-on with gravity, or from above. */
export const planeOf = spec => (spec?.camera === 'side' ? 'side' : 'top');

/** How friends play (spec.multiplayer.together), as config/game.json → players.mode says it to the kit's parts. */
export const playersModeOf = spec => ({ coop: 'coop', teams: 'teams' })[spec?.multiplayer?.together] ?? 'versus';

/** The asset id of a library reference (`<pack>/<asset>`), or null. */
export const assetIdOf = ref => (typeof ref === 'string' && ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : null);

/** A slot's fill as the art order reads it: is a made (generated or from a reference) file asked for? */
export const isMade = fill => fill?.from === 'generate' || fill?.from === 'reference';
