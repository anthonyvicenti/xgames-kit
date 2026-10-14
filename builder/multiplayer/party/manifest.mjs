// The multiplayer manifest and the kit's file list, with no dependency beyond Node itself, so anything can load it.
//   validateMultiplayer() the multiplayer.json every game carries (multiplayer/STANDARD.md)
//   kitFiles()            the files a game vendors at <game>/gf/mp/: the one copy in builder/gf-multiplayer/source
//   checkKit()            is a game's gf/mp/ that copy, byte for byte?
//   checkKitReleased()    the same against its SHA256SUMS (the gate's form: which version matched, and what differs)
// There is one copy of the kit (no version folders, no older releases): its version is the one in its kit.json.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(here, '../../..');
export const KIT_NAME = 'gf-multiplayer';
/** The kit every game vendors: builder/gf-multiplayer/ (README.md, SHA256SUMS, source/ with kit.json). */
export const KIT_HOME = join(repo, 'builder', KIT_NAME);
const KIT_SOURCE = join(KIT_HOME, 'source');
// History: 1.7.8: spectator lobby status and round phase (2026-10-13); 1.7.7: send the viewer roster again after each round or game reload (2026-10-13); 1.7.6: the stream bar's ended / not-live words back (a comment had cut them off in 1.7.5) (2026-10-13); 1.7.5: a seat gone a minute is freed, an unknown resume token is a new player, no round words on a stream's bar (2026-10-12); 1.7.4: voice chat easier to find: Join voice chat in the waiting room and a Voice chat row in the game's pause menu under Studio's page, a line to Studio's page on the game's own link, gf:room's phase (2026-10-12); 1.7.3: the friends home, the waiting room (with the host's Remove) and the stream panel fit every phone, upright and sideways, with every button at least 44 px (2026-10-12); 1.7.2: voice chat between players on Studio's play page, the host's Remove (2026-10-12); 1.7.1: the stream panel offers Turn on mic as soon as you're live, through Studio's play page or its mic window (2026-10-12); 1.7.0: the streamer's voice, from Studio's play page through the friends page to viewers who tap for sound (2026-10-12); the default
export const KIT_VERSION = JSON.parse(readFileSync(join(KIT_SOURCE, 'kit.json'), 'utf8')).version;
export const KIT_DIR = 'gf/mp';                      // where a game vendors the kit, relative to its served folder
export const MANIFEST = 'multiplayer.json';          // at the root of the served folder, beside assets.json

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/**
 * The kit as Map(path under gf/mp/ → Buffer), kit.json included (the list of files and their sha256). `version` may
 * name the kit's own version (or 'dev', the same copy): this kit carries no other.
 */
export async function kitFiles({ version = KIT_VERSION } = {}) {
  if (version !== KIT_VERSION && version !== 'dev') throw new Error(`gf-multiplayer ${version} is not in this kit: it carries ${KIT_VERSION} only (builder/gf-multiplayer)`);
  const files = new Map();
  for (const rel of await walk(KIT_SOURCE)) files.set(rel, await readFile(join(KIT_SOURCE, rel)));
  return files;
}

export async function walk(dir, base = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out);
    else if (e.isFile()) out.push(p.slice(base.length + 1).split(sep).join('/'));
  }
  return out;
}

// ---------------- multiplayer.json ----------------
export const MODES = ['room', 'live', 'race', 'solo', 'world'];
// What a player can see of their friends in each mode. "race" shows a number in a rail and nothing of the friend, which
// the creator ruled out on 2026-10-05 ("No point in multiplayer if you can't see your friends"): it is still a valid
// manifest, and status.mjs reports it as below the bar. "world" (kit 1.5.0): a live, persistent room per game.
export const SEES_FRIENDS = { room: true, live: true, race: false, solo: null, world: true };
/** The first kit version that has world rooms (mode "world"). */
export const WORLD_SINCE = '1.5.0';
const METRICS = ['score', 'time', 'count'];
const OPS = ['in', 'is', 'gte', 'gt', 'lte', 'lt', 'truthy'];
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isPath = v => typeof v === 'string' && /^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(v);

function condProblems(c, where, out, depth = 0) {
  if (!isObj(c)) return void out.push(`${where} must be a condition object`);
  if (depth > 4) return void out.push(`${where} is nested too deep`);
  for (const k of ['any', 'all']) if (k in c) {
    if (!Array.isArray(c[k]) || !c[k].length) return void out.push(`${where}.${k} must be a non-empty list of conditions`);
    c[k].forEach((x, i) => condProblems(x, `${where}.${k}[${i}]`, out, depth + 1));
    return;
  }
  if ('not' in c) return condProblems(c.not, `${where}.not`, out, depth + 1);
  if (!isPath(c.path)) out.push(`${where}.path must be a dot path into the observation (e.g. "phase", "cards.end")`);
  const ops = OPS.filter(k => k in c);
  if (ops.length !== 1) out.push(`${where} needs exactly one of ${OPS.join(', ')}`);
  if ('in' in c && !(Array.isArray(c.in) && c.in.length)) out.push(`${where}.in must be a non-empty list`);
  for (const k of ['gte', 'gt', 'lte', 'lt']) if (k in c && typeof c[k] !== 'number') out.push(`${where}.${k} must be a number`);
  if ('truthy' in c && typeof c.truthy !== 'boolean') out.push(`${where}.truthy must be true or false`);
}

/** → {ok, problems: [...], warnings: [...]}. The gate and every tool refuse a manifest with problems. */
const TOP_KEYS = ['schemaVersion', 'mode', 'title', 'players', 'race', 'live', 'room', 'world', 'reason', 'upgrade', 'theme', 'inviteParams', 'check', 'kit', 'note'];
const WORLD_KEYS = ['entry', 'query', 'key', 'tagline', 'sees', 'shares', 'hud'];
const LIVE_KEYS = ['entry', 'query', 'seedParam', 'content', 'team', 'metric', 'direction', 'unit', 'maxSeconds', 'sees', 'shares', 'backdrop', 'hud'];
const RACE_KEYS = ['entry', 'query', 'seedParam', 'content', 'metric', 'direction', 'unit', 'maxSeconds', 'adapter', 'observe', 'progress'];
const OBSERVE_KEYS = ['object', 'call', 'value', 'ended', 'won', 'started', 'progress'];
const CHECK_KEYS = ['query', 'steps', 'repeat', 'seconds', 'avoidKeys', 'near'];
// A misplaced or misspelt key is silently ignored by the shell and the gate, so it is a problem here, with where it belongs.
function unknownKeys(obj, known, where, out) {
  for (const k of Object.keys(obj)) if (!known.includes(k)) out.push(`${where}${k}: unknown key${k === 'check' ? ' ("check" goes at the top level of the file, beside "race")' : TOP_KEYS.includes(k) && where ? ` ("${k}" goes at the top level of the file)` : ''}; known: ${known.join(', ')}`);
}

export function validateMultiplayer(m) {
  const problems = [], warnings = [];
  const done = () => ({ ok: problems.length === 0, problems, warnings });
  if (!isObj(m)) { problems.push('multiplayer.json must be a JSON object'); return done(); }
  unknownKeys(m, TOP_KEYS, '', problems);
  if (m.schemaVersion !== 2) problems.push('schemaVersion must be 2');
  if (!MODES.includes(m.mode)) { problems.push(`mode must be one of ${MODES.join(', ')}`); return done(); }
  if (m.title !== undefined && !(typeof m.title === 'string' && m.title.trim() && m.title.length <= 60)) problems.push('title must be 1 to 60 characters');
  if (m.upgrade !== undefined && typeof m.upgrade !== 'string') problems.push('upgrade must be a sentence (what a shared-world version would be)');
  if (m.theme !== undefined && !isObj(m.theme)) problems.push('theme must be an object');
  if (m.inviteParams !== undefined && !(Array.isArray(m.inviteParams) && m.inviteParams.every(s => typeof s === 'string'))) problems.push('inviteParams must be a list of query names');

  // check: hints for the gate only (never used in real play): how to finish a run quickly.
  if (m.check !== undefined) {
    if (!isObj(m.check)) problems.push('check must be an object');
    else {
      unknownKeys(m.check, CHECK_KEYS, 'check.', problems);
      if (m.check.avoidKeys !== undefined && !(Array.isArray(m.check.avoidKeys) && m.check.avoidKeys.every(k => typeof k === 'string'))) problems.push('check.avoidKeys must be a list of key codes the scripted player never presses (e.g. ["KeyR", "KeyP", "Escape"])');
      if (m.check.near !== undefined && !(typeof m.check.near === 'number' && m.check.near > 0)) problems.push('check.near must be a positive number: how far, in the game\'s world units, a drawn friend may be from where that friend really is (live games; default 2.5)');
      if (m.check.query !== undefined && typeof m.check.query !== 'string') problems.push('check.query must be a query string without the "?" (a short run for the gate, e.g. "laps=1")');
      if (m.check.steps !== undefined && !Array.isArray(m.check.steps)) problems.push('check.steps must be a list of play-driver steps that finish a run');
      if (m.check.seconds !== undefined && !(Number.isInteger(m.check.seconds) && m.check.seconds >= 20 && m.check.seconds <= 600)) problems.push('check.seconds must be 20 to 600');
      if (m.check.repeat !== undefined && !(Number.isInteger(m.check.repeat) && m.check.repeat >= 1 && m.check.repeat <= 5000 && Array.isArray(m.check.steps))) problems.push('check.repeat must be 1 to 5000, with check.steps (the steps are run that many times, until the run ends)');
      if (Array.isArray(m.check.steps) && m.check.steps.length > 60) problems.push('check.steps is at most 60 steps: use check.repeat for a pattern that repeats');
    }
  }

  if (m.mode === 'solo') {
    if (!(typeof m.reason === 'string' && m.reason.trim().length >= 20)) problems.push('a solo game says why in "reason" (a full sentence: what about this game makes playing with friends not make sense)');
    return done();
  }
  const p = m.players;
  if (!isObj(p) || !Number.isInteger(p.min) || !Number.isInteger(p.max) || p.min < 1 || p.max < p.min || p.max > 16) problems.push('players must be {min, max} with 1 <= min <= max <= 16');
  else if (p.max < 2) problems.push('players.max must be at least 2 for a multiplayer mode');

  // kit 1.5.0: a world. One room per game, found by its key; no rounds, so no metric, cap or result.
  if (m.mode === 'world') {
    const w = m.world;
    if (!isObj(w)) { problems.push('mode "world" needs a "world" block'); return done(); }
    unknownKeys(w, WORLD_KEYS, 'world.', problems);
    if (p && p.max > 8) problems.push('players.max is at most 8 in a world (one room per world; the 9th visitor waits for a seat)');
    if (w.entry !== undefined && !(typeof w.entry === 'string' && w.entry && !/^([a-z]+:)?\/\//i.test(w.entry) && !w.entry.startsWith('/'))) problems.push('world.entry must be a path relative to the game folder');
    if (w.query !== undefined && !(typeof w.query === 'string' && w.query.length <= 200 && !w.query.startsWith('?'))) problems.push('world.query must be a query string without the "?" (added to the game\'s page after gf-world=1)');
    if (w.key !== undefined && w.key !== 'auto') problems.push('world.key must be "auto": world:<slug> on a published game (/p/<slug>/), world:local-<hash> anywhere else');
    if (w.tagline !== undefined && !(typeof w.tagline === 'string' && w.tagline.trim() && w.tagline.length <= 120)) problems.push('world.tagline must be 1 to 120 characters (the line under the title on the world card)');
    if (!(typeof w.sees === 'string' && w.sees.trim().length >= 20)) problems.push('world.sees must say, in a full sentence, how each player sees the others (e.g. "Each player sees the others as a builder with their name above")');
    if (!(typeof w.shares === 'string' && w.shares.trim().length >= 10)) problems.push('world.shares must say what is the same for everyone and kept (e.g. "Every block placed, broken, painted or written, saved on the play host")');
    if (w.hud !== undefined && w.hud !== 'game') problems.push('world.hud must be "game" (the game shows the room in its own menu, so the party page draws nothing over it) or absent (a small "3 here" pill)');
    return done();
  }

  if (m.mode === 'room') {
    const r = m.room;
    if (!isObj(r)) { problems.push('mode "room" needs a "room" block'); return done(); }
    for (const k of ['entry', 'module', 'bot']) if (!(typeof r[k] === 'string' && r[k])) problems.push(`room.${k} must be a path relative to the game folder`);
    if (r.start !== undefined && !['lobby', 'live'].includes(r.start)) problems.push('room.start must be "lobby" or "live"');
    return done();
  }

  if (m.mode === 'live') {
    const l = m.live;
    if (!isObj(l)) { problems.push('mode "live" needs a "live" block'); return done(); }
    unknownKeys(l, LIVE_KEYS, 'live.', problems);
    if (p && p.max > 8) problems.push('players.max is at most 8 in live mode');
    if (l.entry !== undefined && !(typeof l.entry === 'string' && l.entry && !/^([a-z]+:)?\/\//i.test(l.entry) && !l.entry.startsWith('/'))) problems.push('live.entry must be a path relative to the game folder');
    if (l.query !== undefined && typeof l.query !== 'string') problems.push('live.query must be a query string without the "?"');
    // kit 1.4.0: the waiting room's backdrop (the game's page with this query: silent, no menu, nothing to click) and who
    // draws the standings in a round ("game": the game's own HUD and room menu, so the party page shows no rail)
    if (l.backdrop !== undefined && !(typeof l.backdrop === 'string' && l.backdrop.length <= 200 && !l.backdrop.startsWith('?') && /^[\w.~%-]+=[\w.~%-]*(&[\w.~%-]+=[\w.~%-]*)*$/.test(l.backdrop))) problems.push('live.backdrop must be a query string without the "?" (e.g. "gf-backdrop=1"): the game\'s page behind the waiting room');
    if (l.hud !== undefined && !['game', 'rail'].includes(l.hud)) problems.push('live.hud must be "game" (the game draws everyone\'s scores and the room in its own HUD and menu) or "rail" (the party page\'s standings rail, the default)');
    if (!(l.seedParam === null || (typeof l.seedParam === 'string' && /^[\w-]+$/.test(l.seedParam)))) problems.push('live.seedParam must be the query name the game reads its seed from, or null when the game takes the seed from net.seed or has none');
    if (typeof l.team !== 'boolean') problems.push('live.team must be true (one result for everybody: co-op) or false (each player has their own result)');
    if (!METRICS.includes(l.metric)) problems.push(`live.metric must be one of ${METRICS.join(', ')}`);
    if (!['higher', 'lower'].includes(l.direction)) problems.push('live.direction must be "higher" or "lower" (which is better)');
    if (l.unit !== undefined && !(typeof l.unit === 'string' && l.unit.length <= 8)) problems.push('live.unit must be at most 8 characters');
    if (l.metric === 'time' && l.unit !== 's' && l.unit !== 'ms') problems.push('a time metric says its unit: live.unit "s" or "ms"');
    if (!(Number.isInteger(l.maxSeconds) && l.maxSeconds >= 30 && l.maxSeconds <= 3600)) problems.push('live.maxSeconds must be 30 to 3600');
    if (!(typeof l.sees === 'string' && l.sees.trim().length >= 20)) problems.push('live.sees must say, in a full sentence, how each player sees the others (e.g. "Each player sees the others as a survivor carrying a shotgun, with their name above")');
    if (!(typeof l.shares === 'string' && l.shares.trim().length >= 10)) problems.push('live.shares must say what is the same for everyone and owned by the host\'s copy (e.g. "The zombies, the waves and the clock"), or "Nothing but the level" when players only see each other');
    return done();
  }

  const r = m.race;
  if (!isObj(r)) { problems.push('mode "race" needs a "race" block'); return done(); }
  unknownKeys(r, RACE_KEYS, 'race.', problems);
  if (isObj(r.observe)) unknownKeys(r.observe, OBSERVE_KEYS, 'race.observe.', problems);
  if (p && p.max > 8) problems.push('players.max is at most 8 in race mode');
  if (r.entry !== undefined && !(typeof r.entry === 'string' && r.entry && !/^([a-z]+:)?\/\//i.test(r.entry) && !r.entry.startsWith('/'))) problems.push('race.entry must be a path relative to the game folder');
  if (r.query !== undefined && typeof r.query !== 'string') problems.push('race.query must be a query string without the "?"');
  if (!(r.seedParam === null || (typeof r.seedParam === 'string' && /^[\w-]+$/.test(r.seedParam)))) problems.push('race.seedParam must be the query name the game reads its seed from, or null when the game has none');
  if (r.seedParam === null) {
    if (!['fixed', 'random'].includes(r.content)) problems.push('race.content must say what a game with no seed gives each player: "fixed" (the same content every run) or "random" (each player gets different content)');
    else if (r.content === 'random') warnings.push('each player gets different random content: the round is not a like-for-like comparison until the game takes a seed');
  }
  if (!METRICS.includes(r.metric)) problems.push(`race.metric must be one of ${METRICS.join(', ')}`);
  if (!['higher', 'lower'].includes(r.direction)) problems.push('race.direction must be "higher" or "lower" (which is better)');
  if (r.unit !== undefined && !(typeof r.unit === 'string' && r.unit.length <= 8)) problems.push('race.unit must be at most 8 characters');
  if (r.metric === 'time' && r.unit !== 's' && r.unit !== 'ms') problems.push('a time metric says its unit: race.unit "s" or "ms"');
  if (!(Number.isInteger(r.maxSeconds) && r.maxSeconds >= 30 && r.maxSeconds <= 3600)) problems.push('race.maxSeconds must be 30 to 3600 (the round ends then, whoever is still playing)');
  if (!['observe', 'hooks'].includes(r.adapter)) { problems.push('race.adapter must be "observe" or "hooks"'); return done(); }
  if (r.adapter === 'observe') {
    const o = r.observe;
    if (!isObj(o)) { problems.push('adapter "observe" needs an "observe" block'); return done(); }
    if (o.object !== undefined && !/^[A-Za-z_$][\w$]*$/.test(String(o.object))) problems.push('observe.object must be a window property name (default "__game")');
    if (o.call !== undefined && o.call !== null && !/^[A-Za-z_$][\w$]*$/.test(String(o.call))) problems.push('observe.call must be a method name or null (default "snapshot")');
    const isSum = isObj(o.value) && Array.isArray(o.value.sum) && o.value.sum.length >= 2 && o.value.sum.length <= 6 && o.value.sum.every(isPath) && Object.keys(o.value).length === 1;
    if (!isPath(o.value) && !isSum) problems.push('observe.value must be a dot path to the number that ranks a run, or {"sum": [2 to 6 paths]} when the result is kept in parts');
    condProblems(o.ended, 'observe.ended', problems);
    if (o.won !== undefined) condProblems(o.won, 'observe.won', problems);
    if (o.started !== undefined) condProblems(o.started, 'observe.started', problems);
    if (o.progress !== undefined) {
      if (!isObj(o.progress) || !isPath(o.progress.path)) problems.push('observe.progress must be {path} (a 0..1 share) or {path, max}');
      else if (o.progress.max !== undefined && !(typeof o.progress.max === 'number' && o.progress.max > 0)) problems.push('observe.progress.max must be a positive number');
    }
    if (r.direction === 'lower' && o.won === undefined) warnings.push('lower is better but there is no observe.won: a lost run will rank as if it finished');
  } else if (r.progress !== undefined) {
    if (!isObj(r.progress) || !['fraction', 'score'].includes(r.progress.kind)) problems.push('race.progress.kind must be "fraction" or "score"');
  }
  return done();
}

export async function readManifest(gameDir) {
  const path = join(resolve(gameDir), MANIFEST);
  let manifest = null, error = null;
  try { manifest = JSON.parse(await readFile(path, 'utf8')); } catch (e) { error = e.code === 'ENOENT' ? 'missing' : `not valid JSON: ${e.message}`; }
  return { path, manifest, error };
}

/** Compare a game's gf/mp/ with the kit: → {ok, version, missing, changed, extra}. */
export async function checkKit(gameDir, { version = KIT_VERSION } = {}) {
  const dir = join(resolve(gameDir), KIT_DIR);
  const want = await kitFiles({ version });
  const missing = [], changed = [];
  for (const [rel, buf] of want) {
    const cur = await readFile(join(dir, rel)).catch(() => null);
    if (!cur) missing.push(rel); else if (!cur.equals(buf)) changed.push(rel);
  }
  const have = existsSync(dir) ? await walk(dir) : [];
  const extra = have.filter(f => !want.has(f));
  return { ok: !missing.length && !changed.length && !extra.length, version, missing, changed, extra };
}

/** a < b → negative (semver, numbers only). */
export function compareVersions(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** The kit versions this checkout carries: its one copy's. */
export async function releasedVersions() {
  return existsSync(join(KIT_HOME, 'SHA256SUMS')) ? [KIT_VERSION] : [];
}

/**
 * Is a game's gf/mp/ an exact copy of the kit, file for file against its SHA256SUMS? There is no backwards
 * compatibility: a game on another version is remade with create. → {ok, version, latest, missing, changed, extra}.
 */
export async function checkKitReleased(gameDir) {
  const dir = join(resolve(gameDir), KIT_DIR);
  const have = existsSync(dir) ? await walk(dir) : [];
  let claimed = null;
  try { claimed = JSON.parse(await readFile(join(dir, 'kit.json'), 'utf8')).version; } catch {}
  const versions = await releasedVersions();
  const order = [...new Set([claimed, KIT_VERSION, ...[...versions].reverse()])].filter(v => versions.includes(v));
  let best = null;
  for (const version of order) {
    const sums = new Map();
    for (const line of (await readFile(join(KIT_HOME, 'SHA256SUMS'), 'utf8')).split('\n')) { const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim()); if (m) sums.set(m[2], m[1]); }
    const missing = [], changed = [];
    for (const [rel, h] of sums) { const cur = await readFile(join(dir, rel)).catch(() => null); if (!cur) missing.push(rel); else if (sha256(cur) !== h) changed.push(rel); }
    const r = { ok: !missing.length && !changed.length, version, latest: version === KIT_VERSION, missing, changed, extra: have.filter(f => !sums.has(f)) };
    r.ok &&= !r.extra.length;
    if (r.ok) return r;
    best ??= r;
  }
  return best ?? { ok: false, version: null, latest: false, missing: [], changed: [], extra: have };
}

/** Whether a kit version's gf.js knows ?signal=http|ws (HTTP signaling, 1.3.0+). */
export const SIGNAL_SINCE = '1.3.0';
export const kitHasSignal = version => !!version && compareVersions(version, SIGNAL_SINCE) >= 0;
