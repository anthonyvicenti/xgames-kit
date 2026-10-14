// verify check 15: the loop is alive. Each mechanic config/game.json uses shows its own sign of life, read from the
// kit's state (snapshot().shared and the players), and the game's goal is on the player's screen when the round starts.
//
// Creator, "Hang Up On Them" (live Studio, 2026-10-07): "The zombies are instant killed to I couldn't even tell what
// was happened. There was no healthbar or anything. And it also took over an hour to make." Round 1 of that build
// passed verify 13/13 while the play-tester saw no token, no token health on the HUD, zombies standing at the doors and
// no kill in 160 s: waves.target named a prop ("token"), not a world zone, so with aggro "target" the zombies had
// nowhere to go, and check 12 passed on bots shooting zombies that stood still. Two repair rounds (34 min of agent
// time) fixed what this check now fails in the build agent's own `verify --quick` loop.
//
// What it reads (every item names the state it reads; a value the game never reports is "unmeasured", which fails,
// never passes):
//   pages      every page verify opens records the observation 4 times a second (RECORDER, installed by verify's
//              newPage): the solo round, check 10's two pages, check 13's page and this check's own page. A sign seen
//              on any of them counts.
//   undefended this check's own page (only for a game with waves): no bots, the player stands still. Enemies must come,
//              go for their goal, and hurt it: an idle player must lose (genex-desktop's "a do-nothing player must
//              lose"). Then the player aims at the nearest enemy with real mouse moves and fires: the shot must lower
//              its hit points or kill it.
//   first look the goal at round start, in the local player's own view: a config/game.json prop whose role is the
//              thing to defend (window.__game.sight: its share of the view, depth-tested), and the waves target's
//              health meter on the HUD.
//
// Signs, per mechanic. Each one is the mechanic's own: `manifest.signs` in kit/mechanics/<id>/index.js (tools/catalog.mjs
// MANIFEST) holds `sample` (what the page records of its shared state, 4 times a second) and `judge` (what counts, in
// Node); this file reads them from the catalog (mechanicParts) and keeps no table of mechanics. A mechanic folder with a
// manifest gets its sign with no change here. What the kit's mechanics count today (shared key → what counts):
//   waves      shared.waves.e/w: enemies came; one closed ≥ APPROACH_M on its goal (the target zone, else the nearest
//              player) or reached it; with a target: the zone exists in config/world.json, the HUD shows its meter, and
//              undefended its health fell ≥ TARGET_DROP of its max; a player's aimed shot hurt or killed an enemy (else
//              a kill in a round with bots, noted).
//   pickup     shared.pk.p: a spot taken (state 1 → 0) on any page (check 13's E on a pickup counts).
//   projectile shared.prj: shots or streams in flight, and a hit landed: an enemy hurt or killed, a player's hit points
//              fell, a player knocked down, or paint changed.
//   carry      shared.carry.i: an item held.          station   shared.station: progress or quota.
//   paint      shared.paint.g: cells changed.         race      shared.race.r: a gate or lap passed.
//   tag        shared.tag.t: someone is it.           teams     shared.teams.a: players on two teams or more.
//   health     shared.hp.h: reported (hit points that fell), never failed on its own.
// The action mechanics (gf-scenic wave 1, track M):
//   melee      shared.melee.n: swings land (some player's hits); on the undefended page the player walks up to an
//              enemy with real keys, aims at it and swings (the item "a swing hurts an enemy").
//   levels     shared.levels: a cleared level opens its portal and the players move on. A staged page of its own
//              (?gf-demo=levels.clear: the host takes the level's enemies down a moment after they come) where the
//              scripted player walks into the open portal with real keys; the level must move on.
//   boss       shared.boss.a: the boss comes and changes phase. A staged page (?gf-demo=boss.phase: the run starts on
//              the boss level, the boss's hit points just above its first threshold) with 3 bots, the player swinging too.
//   loot       shared.loot: something dropped and something was taken (coins, an opened chest, an upgrade card).
// A staged page is read for these signs only (its label starts "demo-"), never for the others.
//   build      shared.build: the saved edit number moved (reported only: a world is judged by tools/verify-world.mjs).
//   shove      the local player's own count of shoves that landed (reported only).
// Still here, not in a part: the readers several parts share (wavesSigns, otherSigns, actionSigns), the goal on screen,
// and the browser scripts (the undefended page, the aimed shot, the swing, the two staged pages).
import { calibrate, walkToward } from './hits-check.mjs';
import { normalizeWeapons } from '../../../components/melee/logic.js';
import { mechanicParts } from '../catalog.mjs';
import { FLOWS, flowIdOf } from './flow-signs.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;

export const ALIVE_LIMITS = {
  GOAL_MIN_SHARE: 0.003,      // the goal fills ≥ 0.3% of the first look (about 53 × 53 px of a 1280 × 720 screen)
  APPROACH_M: 2,              // an enemy closes at least this far on its goal…
  REACH_SLACK: 0.6,           // …or gets within attackRange + this
  TARGET_DROP: 0.2,           // undefended, the target loses ≥ 20% of its health
  GOAL_AT_TARGET_M: 2.5,      // the goal prop stands within the zone's radius + this of the waves target
  UNDEFENDED_MAX_S: 60,       // the longest the idle player waits
  AIM_SECONDS: 9,             // aim-and-fire: lining up and firing, at most
  SAMPLE_MS: 250,
};
/** A config/game.json prop that is the thing the players defend (the game's goal): its `goal` (the spec's
 *  world.props[].goal) says it; nothing is read from its words. */
export const isGoalProp = p => p?.goal === true;
/** The kit's mechanics with their manifests (tools/catalog.mjs mechanicParts): where every sign comes from. Read once,
 *  when this module is first imported; `partsOf(kit)` reads another kit folder's. */
export const partsOf = kit => mechanicParts(kit ? { kit } : {});
// a flow that keeps state of its own (kit/loops/<id>: turns, match) is sampled and judged like a mechanic, by its own
// manifest's signs; the timed round keeps none and adds nothing
const PARTS = [...await partsOf(), ...FLOWS.filter(f => f.manifest?.state?.key)];

/**
 * In the page (installed with addInitScript): every SAMPLE_MS while a round plays, a compact copy of the observation.
 * window.__gfAlive() → {samples}. A sample: {w (wall s), t (round s), ph, rd, pl: [[id, x, z, score, alive, down,
 * local, bot]], sh: {waves: {e, w}, pk: [state], hp: {id: hp}, carry: [holder], station: [[state, progress]], q,
 * paint: 'hash:length', race, tag, teams, prj: [shots, streams]}, mods: [stand-in mechanic ids]}.
 */
const RECORD = SAMPLERS => {
  if (window.__gfAlive) return;
  const rec = { samples: [], t0: performance.now() };
  const demoName = new URLSearchParams(location.search).get('gf-demo');
  // a staged moment is not a round (the action mechanics' own staged pages are read for their signs only)
  if (demoName && !/^(levels|boss)\./.test(demoName)) { window.__gfAlive = () => rec; return; }
  const R = v => Math.round(v * 100) / 100;
  const take = () => {
    const g = window.__game; if (!g?.snapshot || g.phase === 'show') return;
    let s; try { s = g.snapshot(); } catch { return; }
    if (s.phase !== 'playing' && s.phase !== 'results') return;
    const last = rec.samples[rec.samples.length - 1];
    if (s.phase === 'results' && last?.ph === 'results' && last.rd === s.round) return;
    if (rec.samples.length >= 900) return;
    const sh = s.shared ?? {}, o = {};
    // each mechanic this game uses says what to keep of its own state (its manifest's signs.sample). A sampler may ask
    // for its mechanic's own stats (controls()), which is read once a sample and only when one asks; a kit copy that
    // does not list its mechanics gets every sampler over the shared state alone.
    const used = Array.isArray(s.modules?.mechanics) ? s.modules.mechanics.map(m => m.id) : null;
    if (used && s.flow?.id) used.push(s.flow.id);          // the flow this game is played by, when it publishes one
    let ctl = null;
    const stats = id => { if (!used) return null; try { ctl ??= g.controls?.() ?? {}; return ctl.mechanics?.find(m => m.id === id)?.stats ?? null; } catch { return null; } };
    for (const [id, sample] of SAMPLERS) {
      if (used && !used.includes(id)) continue;
      try { const part = sample(sh, stats); if (part) Object.assign(o, part); } catch {}
    }
    rec.samples.push({ w: R((performance.now() - rec.t0) / 1000), t: R(s.time?.round ?? 0), ph: s.phase, rd: s.round ?? 1,
      pl: (s.players ?? []).map(p => [p.id, R(p.x), R(p.z), p.score ?? 0, p.alive === false ? 0 : 1, p.down ? 1 : 0, p.local ? 1 : 0, p.bot ? 1 : 0]),
      sh: o, mods: (s.modules?.mechanics ?? []).filter(m => m.standin).map(m => m.id), ...(demoName ? { demo: demoName } : {}) });
  };
  setInterval(take, 250);
  window.__gfAlive = () => rec;
};
/** The recorder for a set of parts: one function that stands alone (page.addInitScript sends its text), with each
 *  part's own `signs.sample` written into it. */
export function recorderFor(parts) {
  const list = parts.filter(p => typeof p.manifest?.signs?.sample === 'function').map(p => `[${JSON.stringify(p.id)}, ${p.manifest.signs.sample.toString()}]`);
  return new Function(`(${RECORD.toString()})([\n${list.join(',\n')}\n]);`);
}
export const RECORDER = recorderFor(PARTS);

/** The first round a page played (later rounds are a replay of the same thing). */
export const firstRound = samples => { const rd = samples.find(s => s.ph === 'playing')?.rd; return rd === undefined ? [] : samples.filter(s => s.rd === rd); };

// ---------------------------------------------------------------------------------------------------------------------
// The goal (pure)
// ---------------------------------------------------------------------------------------------------------------------

/** A zone's centre and radius from config/world.json → zones[name], or null. */
export function zoneOf(world, name) {
  const z = name ? world?.zones?.[name] : null; if (!z) return null;
  const a = z.at ?? [0, 0, 0], x = a.x ?? a[0] ?? 0, zz = a.z ?? a[2] ?? 0, s = z.size ?? [1];
  return { name, x, z: zz, r: z.shape === 'box' ? Math.hypot((s[0] ?? 1) / 2, (s[2] ?? s[1] ?? 1) / 2) : (s[0] ?? 1) };
}

/**
 * What the game defends and where: {props: [{name, slot, role, placed: [{x, z}]}], waves: null | {params, aggro,
 * target, zone (or null when the name is not a zone), zones (names), label, hp, height, hittable, attackRange}}.
 */
export function goalOf(game = {}, world = {}) {
  const placedOf = name => (world.props ?? []).filter(p => p.prop === name).map(p => ({ x: p.at?.[0] ?? 0, z: p.at?.[2] ?? 0 }));
  const props = (game.props ?? []).filter(p => p?.name && isGoalProp(p)).map(p => ({ name: p.name, slot: `prop.${p.name}`, role: p.role, placed: placedOf(p.name) }));
  const wm = (game.mechanics ?? []).find(m => m.id === 'waves');
  let waves = null;
  if (wm) {
    const P = wm.params ?? {};
    const target = P.target ?? '';
    waves = { params: P, aggro: P.aggro ?? 'nearest', target, zone: zoneOf(world, target), zones: Object.keys(world.zones ?? {}), label: P.targetLabel ?? 'Core', hp: P.targetHp ?? 20,
      height: P.height ?? 1.5, hittable: P.hittable !== false, attackRange: P.attackRange ?? 1.2, firstDelay: P.firstDelay ?? 3, speed: P.speed ?? 2.6, startCount: P.startCount ?? 3, spawnEvery: P.spawnEvery ?? 0.6 };
  }
  return { props, waves };
}

/** How long an idle player waits for the enemies to come and hurt the goal, from the waves params and the area. */
export function undefendedSeconds(waves, world = {}) {
  const size = world.size ?? [world.half ? world.half * 2 : 24, world.half ? world.half * 2 : 24];
  const half = Math.hypot((Array.isArray(size) ? size[0] : size) / 2, (Array.isArray(size) ? size[1] ?? size[0] : size) / 2);
  const walk = half / Math.max(0.5, waves.speed);
  return Math.min(ALIVE_LIMITS.UNDEFENDED_MAX_S, Math.ceil(waves.firstDelay + waves.startCount * waves.spawnEvery + walk + 10));
}

// ---------------------------------------------------------------------------------------------------------------------
// Signs (pure): samples → what each mechanic did
// ---------------------------------------------------------------------------------------------------------------------

/** Waves on one page: enemies came, how far they closed on their goal, the target's health, kills. */
export function wavesSigns(samples, goal) {
  const W = goal.waves, z = W?.zone;
  const out = { seen: false, maxAlive: 0, firstAt: null, closed: 0, moved: 0, reached: false, hp0: null, hpMin: null, kills: 0, enemyHpDrop: false };
  const track = new Map();       // enemy id → {x0, z0, d0, dmin, hp}
  for (const s of samples) {
    const wv = s.sh?.waves; if (!wv) continue;
    out.seen = true;
    if (Array.isArray(wv.w)) { const hp = Number(wv.w[2]); if (out.hp0 === null) out.hp0 = hp; out.hpMin = out.hpMin === null ? hp : Math.min(out.hpMin, hp); out.kills = Math.max(out.kills, Number(wv.w[1]) || 0); }
    if (wv.e.length && out.firstAt === null) out.firstAt = s.t;
    out.maxAlive = Math.max(out.maxAlive, wv.e.length);
    const players = (s.pl ?? []).filter(p => p[4]).map(p => ({ x: p[1], z: p[2] }));
    for (const [id, x, ez, hp] of wv.e) {
      const goals = [];
      if (W.aggro !== 'players' && z) goals.push(z);
      if (W.aggro !== 'target') goals.push(...players);
      const d = goals.length ? Math.min(...goals.map(g => Math.hypot(g.x - x, g.z - ez))) : null;
      let e = track.get(id);
      if (!e) { e = { x0: x, z0: ez, d0: d, dmin: d, hp }; track.set(id, e); }
      if (d !== null) { if (e.d0 === null) e.d0 = d; e.dmin = Math.min(e.dmin ?? d, d); out.closed = Math.max(out.closed, e.d0 - e.dmin); if (e.dmin <= W.attackRange + ALIVE_LIMITS.REACH_SLACK) out.reached = true; }
      out.moved = Math.max(out.moved, Math.hypot(x - e.x0, ez - e.z0));
      if (hp < e.hp) out.enemyHpDrop = true;
      e.hp = hp;
    }
  }
  out.closed = r1(out.closed); out.moved = r1(out.moved);
  return out;
}

/** The other mechanics on one page: what changed. */
export function otherSigns(samples) {
  const o = { keys: new Set(), standins: new Set(), pkTaken: 0, pkPresent: 0, hpFell: false, hpMin: null, down: false, carried: false, station: false, paintChanged: false, race: false, it: false, itPassed: false, teams: 0, fired: false, scoreMoved: false };
  let pk = null, paint0 = null, tag0 = null, score0 = null;
  const hp0 = new Map();
  for (const s of samples) {
    for (const k of Object.keys(s.sh ?? {})) o.keys.add(k);
    for (const m of s.mods ?? []) o.standins.add(m);
    const sh = s.sh ?? {};
    if (sh.pk) { o.pkPresent = Math.max(o.pkPresent, sh.pk.filter(v => v === 1).length); if (pk) sh.pk.forEach((v, i) => { if (pk[i] === 1 && v === 0) o.pkTaken++; }); pk = sh.pk; }
    if (sh.hp) for (const [id, v] of Object.entries(sh.hp)) { if (!hp0.has(id)) hp0.set(id, v); else if (v < hp0.get(id)) o.hpFell = true; o.hpMin = o.hpMin === null ? v : Math.min(o.hpMin, v); }
    if ((s.pl ?? []).some(p => p[5])) o.down = true;
    if (sh.carry?.some(h => h !== -1 && h !== null)) o.carried = true;
    if (sh.station?.some(x => (x[1] ?? 0) > 0) || (sh.q?.[0] ?? 0) > 0) o.station = true;
    if (sh.paint !== undefined) { if (paint0 === null) paint0 = sh.paint; else if (sh.paint !== paint0) o.paintChanged = true; }
    if (sh.race && Object.values(sh.race).some(v => (v?.[0] ?? 0) > 0 || (v?.[1] ?? 0) > 0)) o.race = true;
    if (sh.tag) { if (sh.tag.length) o.it = true; const k = [...sh.tag].sort().join(); if (tag0 === null) tag0 = k; else if (k !== tag0 && sh.tag.length) o.itPassed = true; }
    if (sh.teams) o.teams = Math.max(o.teams, new Set(Object.values(sh.teams)).size);
    if (sh.prj && (sh.prj[0] > 0 || sh.prj[1] > 0)) o.fired = true;
    const sc = (s.pl ?? []).map(p => p[3]).join();
    if (score0 === null) score0 = sc; else if (sc !== score0) o.scoreMoved = true;
  }
  return o;
}

/** The action mechanics on one page (track M): swings and hits, levels moved on, the boss's phases, loot. */
export function actionSigns(samples) {
  const o = { swings: 0, hits: 0, levelMax: 0, levelMin: null, opened: false, cleared: 0, travels: 0, bossActive: false, bossPhase: 0, bossHpMin: null, bossMax: 0, drops: 0, coins: 0, upgrades: 0, chestsOpened: 0 };
  for (const s of samples) {
    const sh = s.sh ?? {};
    if (sh.melee) { o.swings = Math.max(o.swings, sh.melee[0]); o.hits = Math.max(o.hits, sh.melee[1]); }
    if (sh.levels) { const [l, ph, c, v] = sh.levels; o.levelMax = Math.max(o.levelMax, l); o.levelMin = o.levelMin === null ? l : Math.min(o.levelMin, l); if (ph === 'open' || ph === 'travel') o.opened = true; o.cleared = Math.max(o.cleared, c); o.travels = Math.max(o.travels, v); }
    if (sh.boss && sh.boss[0]) { o.bossActive = true; o.bossPhase = Math.max(o.bossPhase, sh.boss[3]); o.bossMax = Math.max(o.bossMax, sh.boss[2]); o.bossHpMin = o.bossHpMin === null ? sh.boss[1] : Math.min(o.bossHpMin, sh.boss[1]); }
    if (sh.loot) { o.drops = Math.max(o.drops, sh.loot[0]); o.coins = Math.max(o.coins, sh.loot[1]); o.upgrades = Math.max(o.upgrades, sh.loot[2]); o.chestsOpened = Math.max(o.chestsOpened, sh.loot[3]); }
  }
  o.movedOn = o.travels > 0 || (o.levelMin !== null && o.levelMax > o.levelMin);
  return o;
}
/** Action signs over several pages, merged (the best each page showed). */
export function mergeAction(list) {
  const o = actionSigns([]);
  for (const x of list) {
    for (const k of ['swings', 'hits', 'levelMax', 'cleared', 'travels', 'bossPhase', 'bossMax', 'drops', 'coins', 'upgrades', 'chestsOpened']) o[k] = Math.max(o[k], x[k]);
    for (const k of ['opened', 'bossActive', 'movedOn']) o[k] = o[k] || x[k];
    if (x.bossHpMin !== null) o.bossHpMin = o.bossHpMin === null ? x.bossHpMin : Math.min(o.bossHpMin, x.bossHpMin);
  }
  return o;
}

/** Signs over several pages: each page measured on its own (a change between two pages is not a change), then merged. */
export function mergeSigns(list) {
  const o = otherSigns([]);
  for (const x of list) {
    for (const k of x.keys) o.keys.add(k); for (const m of x.standins) o.standins.add(m);
    o.pkTaken += x.pkTaken; o.pkPresent = Math.max(o.pkPresent, x.pkPresent); o.teams = Math.max(o.teams, x.teams);
    if (x.hpMin !== null) o.hpMin = o.hpMin === null ? x.hpMin : Math.min(o.hpMin, x.hpMin);
    for (const k of ['hpFell', 'down', 'carried', 'station', 'paintChanged', 'race', 'it', 'itPassed', 'fired', 'scoreMoved']) o[k] = o[k] || x[k];
  }
  return o;
}

/** Waves over several pages, merged the same way. */
export function mergeWaves(list) {
  const o = { seen: false, maxAlive: 0, firstAt: null, closed: 0, moved: 0, reached: false, hp0: null, hpMin: null, kills: 0, enemyHpDrop: false };
  for (const x of list) {
    o.seen ||= x.seen; o.reached ||= x.reached; o.enemyHpDrop ||= x.enemyHpDrop;
    o.maxAlive = Math.max(o.maxAlive, x.maxAlive); o.closed = Math.max(o.closed, x.closed); o.moved = Math.max(o.moved, x.moved); o.kills = Math.max(o.kills, x.kills);
    if (x.firstAt !== null) o.firstAt = o.firstAt === null ? x.firstAt : Math.min(o.firstAt, x.firstAt);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------------------------------
// The judgement (pure)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * pages: [{label, samples}] (every recorded page; this check's own page is labelled 'alive'); firstLook: {sight,
 * meters, phase} or null; aim: the aim-and-fire result or null. → {ok, items, detail}
 * An item: {mechanic, item, status: 'ok' | 'dead' | 'unmeasured' | 'note', reads, saw, fix}.
 */
export function judgeAlive({ game = {}, world = {}, pages = [], firstLook = null, aim = null, parts = PARTS }) {
  const L = ALIVE_LIMITS, goal = goalOf(game, world), items = [];
  const add = (mechanic, item, status, reads, saw, fix = '') => items.push({ mechanic, item, status, reads, saw, ...(fix ? { fix } : {}) });
  const used = [...new Set((game.mechanics ?? []).map(m => m.id))];
  // the game's flow, when it is a part with state of its own (turns, match): its sign is judged with the mechanics'
  { const fid = flowIdOf(game); if (fid && fid !== 'round' && parts.some(p => p.id === fid) && !used.includes(fid)) used.push(fid); }
  const allRounds = pages.map(p => ({ label: p.label, samples: firstRound(p.samples ?? []) })).filter(p => p.samples.length);
  // the action mechanics' staged pages ("demo-…") count for their own signs only
  const rounds = allRounds.filter(p => !String(p.label).startsWith('demo-'));
  const action = mergeAction(allRounds.map(p => actionSigns(p.samples)));
  const demoPage = name => allRounds.find(p => p.label === name) ?? null;
  const alive = rounds.find(p => p.label === 'alive');
  const others = mergeSigns(rounds.map(p => otherSigns(p.samples)));
  const wavesAll = goal.waves ? mergeWaves(rounds.map(p => wavesSigns(p.samples, goal))) : null;
  const names = rounds.map(p => p.label).join(', ') || 'none';
  const secs = p => r1((p.samples.at(-1)?.t ?? 0) - (p.samples[0]?.t ?? 0));

  if (!rounds.length) add('kit', 'recording', 'unmeasured', 'window.__game.snapshot() on every page', 'no page recorded a round (the game never reached "playing", or the page has no window.__game)', 'run the game: ?bots=3 must reach a playing round');

  // ---- the goal on screen ----
  const W = goal.waves;
  for (const g of goal.props) {
    const s = firstLook?.sight ?? null;
    const what = `the ${g.name} (config/game.json → props, role "${g.role}")`;
    if (!firstLook) add('goal', 'first look', 'unmeasured', `window.__game.sight(['${g.slot}'])`, 'no first look was taken (the solo round did not start)');
    else if (s?.error) add('goal', 'first look', 'unmeasured', `window.__game.sight(['${g.slot}'])`, `sight() threw: ${s.error}`);
    else if (!s || typeof s.share !== 'number') add('goal', 'first look', 'unmeasured', `window.__game.sight(['${g.slot}'])`, 'the game has no window.__game.sight (its kit copy predates check 15)', 'node builder/tools/create.mjs <game>/spec.json <game> brings the kit copy up to date');
    else if (!s.drawables) add('goal', 'in the world', 'dead', `window.__game.sight(['${g.slot}']).drawables`, `${what} is not in the world when the round starts: nothing is drawn with slot ${g.slot}`,
      `place it where the game is played: config/world.json → props gets {"prop": "${g.name}", "at": [x, 0, z], "rot": 0, "scale": 1}${W?.zone ? ` at the waves target zone "${W.zone.name}" (${r1(W.zone.x)}, ${r1(W.zone.z)})` : ''} and config/props.json its catalog entry, or spawn it in rules.setup with ctx.assets.model('${g.slot}')`);
    else if (s.share < L.GOAL_MIN_SHARE) add('goal', 'readable at round start', 'dead', `window.__game.sight(['${g.slot}']).share`,
      `${what} fills ${r2(s.share * 100)}% of the player's first look (needs ${L.GOAL_MIN_SHARE * 100}%): it is ${s.size ? `${r1(Math.max(s.size.x, s.size.z))} m wide and ${r1(s.size.y)} m tall, ` : ''}${s.distance ?? '?'} m from the camera${s.open === 0 ? ', and out of view (behind the camera or off screen)' : s.open > s.share * 2 ? `, and mostly hidden behind something (${r2(s.open * 100)}% with nothing in front)` : ''}`,
      'make it big enough to read (config/world.json → props[…].scale for this prop, or its size), and put it where the player looks at round start (spawns face the middle of the play area)');
    else add('goal', 'readable at round start', 'ok', `window.__game.sight(['${g.slot}']).share`, `${what} fills ${r2(s.share * 100)}% of the first look, ${s.distance} m away`);
    // the thing to defend is where the enemies go
    if (W && W.zone && s?.center) {
      const d = Math.hypot(s.center.x - W.zone.x, s.center.z - W.zone.z);
      if (d > W.zone.r + L.GOAL_AT_TARGET_M) add('goal', 'at the waves target', 'dead', 'sight().center vs config/world.json → zones', `the enemies go for zone "${W.zone.name}" at (${r1(W.zone.x)}, ${r1(W.zone.z)}), but the ${g.name} stands at (${r1(s.center.x)}, ${r1(s.center.z)}), ${r1(d)} m away`, `move the ${g.name} into zone "${W.zone.name}" (config/world.json → props) or point waves.target at a zone around it`);
    }
  }
  if (W && (W.target || goal.props.length || W.aggro === 'target')) {
    const meter = firstLook?.meters?.find(m => String(m.label ?? '').trim().toLowerCase() === String(W.label).trim().toLowerCase());
    const zonesTxt = W.zones.length ? W.zones.join(', ') : 'none';
    const near = goal.props[0] && firstLook?.sight?.center ? nearestZone(world, firstLook.sight.center) : null;
    const nearTxt = near ? `; the ${goal.props[0].name} stands in or near zone "${near.name}" (${r1(near.d)} m)` : '';
    if (!W.target) add('waves', 'target', 'dead', 'config/game.json → mechanics[waves].params.target', `waves has no target (target is "")${goal.props.length ? ` although the ${goal.props[0].name} is the thing to defend` : ''}${W.aggro === 'target' ? ', and with aggro "target" the enemies have nothing to go for' : ''}`,
      `set mechanics[waves].params.target to the world zone the ${goal.props[0]?.name ?? 'goal'} stands in (config/world.json → zones: ${zonesTxt}${nearTxt})`);
    else if (!W.zone) add('waves', 'target', 'dead', 'config/game.json → mechanics[waves].params.target, config/world.json → zones', `waves.target is "${W.target}", which is not a zone in config/world.json (zones: ${zonesTxt}): the enemies have no target${W.aggro === 'target' ? ' (aggro "target": they stand where they came in)' : ''} and the HUD shows no "${W.label}" meter`,
      `set mechanics[waves].params.target to a zone name${nearTxt}; a prop's name is not a zone`);
    if (W.target && W.zone && firstLook) {
      if (meter) add('waves', 'target health on the HUD', 'ok', `the HUD's .gf-meter "${W.label}"`, `"${W.label}" ${meter.pct}% at round start`);
      else add('waves', 'target health on the HUD', 'dead', `the HUD's .gf-meter "${W.label}"`, `no "${W.label}" meter on the HUD at round start (meters: ${(firstLook.meters ?? []).map(m => m.label).join(', ') || 'none'})`, 'the kit draws it when waves.target names a zone and the HUD is on; do not hide #gf-ui meters in rules');
    }
    if (W.aggro === 'players' && goal.props.length) add('waves', 'goes for the goal', 'dead', 'config/game.json → mechanics[waves].params.aggro', `aggro is "players": the enemies never go for the ${goal.props[0].name}`, 'set aggro to "target" (only the goal) or "nearest" (the goal or a player, whichever is closer)');
  }

  // ---- each mechanic's sign of life: its own (manifest.signs.judge), over what its own sample recorded ----
  const byId = new Map(parts.map(p => [p.id, p]));
  for (const id of used) {
    const man = byId.get(id)?.manifest, signs = man?.signs, key = man?.state?.key ?? null;
    if (typeof signs?.judge !== 'function') { add(id, 'sign of life', 'note', '—', `check 15 has no sign defined for "${id}"`); continue; }
    if (others.standins.has(id)) { add(id, 'sign of life', 'unmeasured', `snapshot().modules.mechanics`, `"${id}" runs as a stand-in, so nothing it does is real`, 'the game\'s kit copy lacks the module: node builder/tools/create.mjs <game>/spec.json <game>'); continue; }
    if (!signs.reportOnly && key && rounds.length && !others.keys.has(key)) { add(id, 'sign of life', 'unmeasured', `snapshot().shared.${key}`, `the ${id} mechanic never published its state (shared.${key}) on any page (${names})`, `is "${id}" in config/game.json → mechanics with the kit's module? rules must not replace it`); continue; }
    if (!rounds.length) continue;
    // what a part's judge is handed: its own `add`, the game, the pages' samples, and the readers parts share
    const view = {
      id, add: (item, status, reads, saw, fix = '') => add(id, item, status, reads, saw, fix),
      game, world, goal, limits: L, aim, names, secs, r1, r2,
      pages: rounds, allPages: allRounds, alive: alive ?? null, page: demoPage, has: x => used.includes(x),
      others, action, waves: wavesAll,
      othersOn: p => otherSigns(p.samples), actionOn: p => actionSigns(p.samples), wavesOn: p => wavesSigns(p.samples, goal),
    };
    try { signs.judge(view); } catch (e) { add(id, 'sign of life', 'unmeasured', `kit/mechanics/${id}/index.js → manifest.signs.judge`, `the ${id} mechanic's own sign threw: ${String(e?.message ?? e).split('\n')[0]}`); }
  }

  const bad = items.filter(i => i.status === 'dead' || i.status === 'unmeasured');
  const line = i => `${i.mechanic} ${i.item}: ${i.status === 'ok' ? 'ok' : i.status.toUpperCase()}, ${i.saw}${i.status !== 'ok' && i.status !== 'note' ? ` [reads ${i.reads}]${i.fix ? `. Fix: ${i.fix}` : ''}` : ''}`;
  const ok = bad.length === 0;
  const detail = ok
    ? items.filter(i => i.status === 'ok').map(line).join('; ')
    : `${bad.map(line).join('; ')}. The loop must be alive in the player's first minute: the goal on screen with its health, the enemies or other players doing what the rules say, a shot that lands. ${items.some(i => i.status === 'ok') ? `Working: ${items.filter(i => i.status === 'ok').map(i => `${i.mechanic} ${i.item}`).join(', ')}.` : ''}`;
  return { ok, items, detail, goal: { props: goal.props.map(g => g.name), target: W?.target ?? null, zone: W?.zone?.name ?? null } };
}

/** The zone nearest a point (for the repair hint). */
function nearestZone(world, p) {
  let best = null;
  for (const name of Object.keys(world.zones ?? {})) { const z = zoneOf(world, name); const d = Math.max(0, Math.hypot(z.x - p.x, z.z - p.z) - (z.r ?? 0)); if (!best || d < best.d) best = { name, d }; }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------------
// The browser side
// ---------------------------------------------------------------------------------------------------------------------

/** The goal and the HUD at round start, from the local player's view: {sight, meters, phase, at}. */
export async function firstLook(page, game, world) {
  const goal = goalOf(game, world);
  // sight() returns a promise on the scenic-3d profile (WebGPU readback is asynchronous; kit/core/sight.js): await it
  return page.evaluate(async ids => {
    const g = window.__game, ui = document.getElementById('gf-ui');
    const shown = e => { if (!e) return false; const c = getComputedStyle(e); return c.display !== 'none' && c.visibility !== 'hidden' && parseFloat(c.opacity) > 0.05; };
    const meters = ui ? [...ui.querySelectorAll('.gf-meter')].filter(shown).map(m => ({ label: (m.querySelector('b')?.textContent ?? '').trim(), pct: Math.round(parseFloat(m.querySelector('u')?.style.width) || 0) })) : [];
    let sight = null;
    if (ids.length) { try { sight = typeof g?.sight === 'function' ? await g.sight(ids) : null; } catch (e) { sight = { error: String(e?.message ?? e) }; } }
    return { phase: g?.phase ?? null, t: g?.snapshot?.()?.time?.round ?? null, meters, sight };
  }, goal.props.map(p => p.slot)).catch(e => ({ error: e.message, meters: [], sight: null }));
}

/** Read a page's recording (verify harvests every page this way just before it closes). */
export const recordingOf = page => Promise.race([page.evaluate(() => window.__gfAlive?.() ?? null), sleep(2500).then(() => null)]).catch(() => null);

const OBS = () => {
  const g = window.__game; const s = g.snapshot(); let c = null; try { c = g.controls?.() ?? null; } catch {}
  return { me: s.players.find(x => x.local), e: s.shared.waves?.e ?? [], w: s.shared.waves?.w ?? null, aim: c?.aim ?? null, phase: s.phase };
};
const yawOf = d => Math.atan2(d[0], d[2]);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * The enemy to aim at: the nearest within 2.5–26 m whose line from the player does not pass the goal zone first
 * (a shot at a zombie behind the token hits the token). → {id, x, z, hp, d} or null
 */
export function pickEnemy(me, enemies, { avoid = null, skip = new Set() } = {}) {
  let best = null;
  for (const [id, x, z, hp] of enemies) {
    if (skip.has(id)) continue;
    const d = Math.hypot(x - me.x, z - me.z);
    if (d < 2.5 || d > 26) continue;
    if (avoid) {
      const ux = (x - me.x) / d, uz = (z - me.z) / d, ax = avoid.x - me.x, az = avoid.z - me.z, along = ax * ux + az * uz;
      if (along > 0 && along < d && Math.abs(ax * uz - az * ux) < Math.min(1.2, avoid.r ?? 1)) continue;
    }
    if (!best || d < best.d) best = { id, x, z, hp, d };
  }
  return best;
}

/**
 * Aim at an enemy with real mouse moves (pointer lock: the view turns with the movement between mouse events), hold
 * primary, and watch its hit points; up to three enemies in `seconds`. → {measured, hit, kill, distance, hpBefore,
 * hpAfter, tries, why}
 */
export async function aimAndFire(p, { height = 1.5, avoid = null, seconds = ALIVE_LIMITS.AIM_SECONDS } = {}) {
  const t0 = Date.now(), obs = () => p.evaluate(OBS);
  const cur = { x: 640, y: 360 };
  const move = async (dx, dy) => { const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 25)); for (let i = 0; i < n; i++) { cur.x += dx / n; cur.y += dy / n; await p.mouse.move(cur.x, cur.y); } await sleep(160); };
  let o = await obs();
  if (!o.aim?.dir?.length || o.aim.dist === null) return { measured: false, hit: false, why: 'the game reports no crosshair aim (window.__game.controls().aim)' };
  // calibrate: how far the view turns per pixel, sideways and up
  const a0 = o.aim.dir; await move(60, 0); o = await obs(); const kx = wrap(yawOf(o.aim.dir) - yawOf(a0)) / 60;
  const s0 = o.aim.dir[1]; await move(0, 30); o = await obs(); let ky = (o.aim.dir[1] - s0) / 30; await move(0, -30);
  if (Math.abs(kx) < 1e-4) return { measured: false, hit: false, why: 'moving the mouse did not turn the view (no pointer lock?)' };
  if (Math.abs(ky) < 1e-5) ky = -Math.abs(kx);
  const errors = (s, t) => {
    const dir = s.aim?.dir; if (!dir) return null;
    const hl = Math.hypot(dir[0], dir[2]) || 1e-6, d = Math.hypot(t.x - s.me.x, t.z - s.me.z);
    return { yawErr: wrap(Math.atan2(t.x - s.me.x, t.z - s.me.z) - yawOf(dir)), slopeErr: (height * 0.45 - 1.2) / d - dir[1] / hl, tol: Math.atan(0.3 / d), d };
  };
  const tried = new Set(), notes = [];
  let last = null;
  while (Date.now() - t0 < seconds * 1000 && tried.size < 3) {
    o = await obs();
    const t = pickEnemy(o.me, o.e, { avoid, skip: tried });
    if (!t) { if (!tried.size) { await sleep(400); if (Date.now() - t0 > seconds * 500) break; continue; } break; }
    tried.add(t.id);
    // line up (yaw within the enemy's half-width, the slope crossing it at 45% of its height)
    let e = null;
    for (let i = 0; i < 7; i++) {
      o = await obs(); const now = o.e.find(x => x[0] === t.id); if (!now) break;
      Object.assign(t, { x: now[1], z: now[2], hp: now[3] });
      e = errors(o, t); if (!e) break;
      if (Math.abs(e.yawErr) < e.tol && Math.abs(e.slopeErr) < 0.12) break;
      await move(Math.max(-500, Math.min(500, e.yawErr / kx * 0.85)), Math.max(-150, Math.min(150, e.slopeErr / ky * 0.7)));
    }
    if (!e) continue;
    const before = await obs(), kills0 = Number(before.w?.[1] ?? 0), hp0 = new Map(before.e.map(x => [x[0], x[3]]));
    let hit = false, kill = false, hpAfter = t.hp;
    await p.mouse.down();
    try {
      for (const end = Date.now() + 1800; Date.now() < end && !hit; ) {
        await sleep(200);
        const s = await obs();
        if (Number(s.w?.[1] ?? 0) > kills0) { kill = true; hit = true; hpAfter = 0; }
        for (const [id, , , hp] of s.e) if (hp0.has(id) && hp < hp0.get(id)) { hit = true; if (id === t.id) hpAfter = hp; }
        const now = s.e.find(x => x[0] === t.id), er = now && errors(s, { x: now[1], z: now[2] });
        if (er && Math.abs(er.yawErr) > er.tol) await move(Math.max(-200, Math.min(200, er.yawErr / kx * 0.8)), 0);
      }
    } finally { await p.mouse.up(); }
    last = { distance: r1(e.d), hpBefore: t.hp, hpAfter, yawErrDeg: r1(e.yawErr * 180 / Math.PI) };
    if (hit) return { measured: true, hit, kill, ...last, tries: tried.size, why: 'hit' };
    notes.push(`an enemy ${r1(e.d)} m away (aim ${r1(Math.abs(e.yawErr) * 180 / Math.PI)}° off its middle) kept ${t.hp} hit points through 1.8 s of fire`);
    await sleep(300);
  }
  if (!last) return { measured: false, hit: false, why: tried.size ? 'the enemies left before the aim lined up' : 'no enemy came within 2.5–26 m of the player in a clear line' };
  return { measured: true, hit: false, kill: false, ...last, tries: tried.size, why: notes.join('; ') };
}

/**
 * The undefended page (a game with waves): no bots, the player stands still until the enemies hurt the goal (or the
 * time is up), then aims and fires. newPage is verify's (it installs RECORDER and keeps the recording as 'alive' when
 * the page closes). → {aim, seconds, waited}
 */
export async function undefended({ newPage, url, game, world, shot = async () => null, log = () => {} }) {
  const goal = goalOf(game, world), W = goal.waves, wait = undefendedSeconds(W, world);
  const T = await newPage('alive', { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: wait + 40 }] } });
  const p = T.page, t0 = Date.now();
  let aim = null, waited = 0;
  try {
    await p.goto(`${url}?seed=7&bots=0`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    const play = await p.locator('#gf-play').boundingBox().catch(() => null);
    if (play) await p.mouse.click(play.x + play.width / 2, play.y + play.height / 2); else await p.keyboard.press('Enter');
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 20000) throw new Error('the round did not start'); await sleep(120); }
    // stand still (no click: a click fires) until the goal is hurt or the time is up
    const t1 = Date.now(), end = t1 + wait * 1000, hurtAt = W.hp * (1 - ALIVE_LIMITS.TARGET_DROP);
    for (;;) {
      await sleep(1000);
      const rec = await p.evaluate(() => window.__gfAlive?.() ?? null).catch(() => null);
      const samples = firstRound(rec?.samples ?? []), s = samples.at(-1), w = s?.sh?.waves?.w;
      if (s?.ph === 'results' || Date.now() > end) break;
      if (W.zone && w && Number(w[2]) <= hurtAt) break;
      if (!W.zone && (otherSigns(samples).hpFell || otherSigns(samples).down)) break;
    }
    waited = Math.round((Date.now() - t1) / 1000);
    await shot(p, 'alive-undefended');
    // melee (track M): walk up to an enemy with real keys, aim at it and swing
    const melee = (game.mechanics ?? []).find(m => m.id === 'melee');
    if (W.hittable && melee && !(game.mechanics ?? []).some(m => m.id === 'projectile') && (await p.evaluate(() => window.__game?.phase).catch(() => null)) === 'playing') {
      aim = await walkAndSwing(p, { game, melee }).catch(e => ({ melee: true, measured: false, hit: false, why: `the swing script stopped: ${e.message.split('\n')[0]}` }));
      await shot(p, 'alive-swung');
      log(`alive: the player's swing ${aim.hit ? 'hit' : 'did not hit'} (${aim.why})`);
    }
    // aim and fire (a click takes the mouse first; that click may fire one shot, before anything is measured)
    else if (W.hittable && (game.mechanics ?? []).some(m => m.id === 'projectile') && game.controls?.primary && (await p.evaluate(() => window.__game?.phase).catch(() => null)) === 'playing') {
      await p.mouse.click(640, 360); await sleep(400);
      aim = await aimAndFire(p, { height: W.height, avoid: W.zone }).catch(e => ({ measured: false, hit: false, why: `the aim script stopped: ${e.message.split('\n')[0]}` }));
      await shot(p, 'alive-aimed');
      log(`alive: the aimed shot ${aim.hit ? 'hit' : 'did not hit'} (${aim.why})`);
    }
  } finally {
    await T.ctx.close().catch(() => {});
  }
  // the action mechanics' staged pages (track M): a level's portal walked into; the boss's phase changing
  const has = id => (game.mechanics ?? []).some(m => m.id === id);
  const staged = {};
  if (has('levels')) staged.levels = await levelsPage({ newPage, url, game, shot, log }).catch(e => ({ error: e.message }));
  if (has('boss')) staged.boss = await bossPage({ newPage, url, game, shot, log }).catch(e => ({ error: e.message }));
  return { aim, waited, staged, seconds: Math.round((Date.now() - t0) / 1000), errors: T.errors.slice(0, 3) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The action mechanics (gf-scenic wave 1, track M): a swing at an enemy, a portal walked into, the boss's phases
// ---------------------------------------------------------------------------------------------------------------------
const MOBS = () => {
  const g = window.__game, s = g.snapshot(), c = g.controls(), st = id => c.mechanics.find(m => m.id === id)?.stats ?? null;
  return { phase: s.phase, me: s.players.find(x => x.local), waves: st('waves'), melee: st('melee'), levels: st('levels'), boss: st('boss'), view: { w: innerWidth, h: innerHeight } };
};
const reachOf = melee => { const ws = normalizeWeapons(melee?.params?.weapons); return (ws.find(w => w.id === melee?.params?.weapon) ?? ws[0]).combo[0].reach; };

/** Walk up to the nearest enemy (or the boss) with real keys, aim (the cursor with the follow camera, the crosshair
 *  else) and swing with real clicks; watch its hit points. → {melee: true, measured, hit, kill, hpBefore, hpAfter, why} */
export async function walkAndSwing(p, { game, melee, seconds = 14, boss = false } = {}) {
  const t0 = Date.now(), obs = () => p.evaluate(MOBS), mode = game.camera ?? 'third', reach = reachOf(melee);
  const sens = game.controller?.camera?.[mode]?.sensitivity ?? 0.0026, fov = game.controller?.camera?.[mode]?.fov ?? 60;
  let F = null, R = null, last = null, swings = 0;
  const cur = { x: 640, y: 360 };
  while (Date.now() - t0 < seconds * 1000) {
    const o = await obs(); if (o.phase !== 'playing') break;
    const me = o.me; if (!me?.alive) { await sleep(300); continue; }
    let t = null;
    if (boss && o.boss?.active && !o.boss.dead && o.boss.screen) t = { id: 'boss', x: o.boss.x, z: o.boss.z, hp: o.boss.hp, sx: o.boss.screen.x, sy: o.boss.screen.y, front: o.boss.screen.front, r: 1 };
    else for (const e of o.waves?.enemies ?? []) { if (!(e.hp > 0) || !e.body) continue; const d = Math.hypot(e.x - me.x, e.z - me.z); if (!t || d < t.d) t = { id: e.id, x: e.x, z: e.z, hp: e.hp, sx: e.body.x, sy: e.body.y, front: e.body.front, d, r: 0.45 }; }
    if (!t) { await sleep(300); continue; }
    const d = Math.hypot(t.x - me.x, t.z - me.z) - t.r;
    // aim
    if (mode === 'follow' || mode === 'top') { if (t.front) await p.mouse.move(t.sx, t.sy); }
    else {
      const off = [t.sx - o.view.w / 2, t.sy - o.view.h / 2], f = (o.view.h / 2) / Math.tan((fov * Math.PI / 180) / 2);
      if (!t.front || Math.abs(off[0]) > 12) {
        // pointer lock: the view turns by the mouse's movement (one move of dx, in steps)
        const dx = t.front ? Math.atan(off[0] / f) / sens * 0.8 : 500, n = Math.max(1, Math.ceil(Math.abs(dx) / 30));
        for (let i = 0; i < n; i++) { cur.x += dx / n; await p.mouse.move(cur.x, cur.y); }
        await sleep(90); continue;
      }
    }
    if (d > reach * 0.75) {
      if (mode !== 'follow' && mode !== 'top') { await p.keyboard.down('KeyW'); await sleep(Math.min(260, 60 + d * 70)); await p.keyboard.up('KeyW'); continue; }
      if (!F) { const k = await calibrate(p, obs); if (!k) return { melee: true, measured: false, hit: false, why: 'the player did not move on W or D' }; F = k.F; R = k.R; continue; }
      await walkToward(p, F, R, t.x - me.x, t.z - me.z, Math.min(260, 60 + d * 70)); continue;
    }
    // in reach: swing
    const hp0 = t.hp; swings++;
    await p.mouse.down(); await sleep(70); await p.mouse.up();
    for (const end = Date.now() + 1000; Date.now() < end; ) {
      await sleep(80);
      const q = await obs();
      const now = boss ? (q.boss?.active ? { hp: q.boss.hp } : null) : (q.waves?.enemies ?? []).find(e => e.id === t.id);
      if (!now || now.hp < hp0) { last = { distance: r1(d + t.r), hpBefore: hp0, hpAfter: now ? now.hp : 0 }; return { melee: true, measured: true, hit: true, kill: !now, ...last, swings, why: 'hit' }; }
    }
    last = { distance: r1(d + t.r), hpBefore: hp0, hpAfter: hp0 };
  }
  return { melee: true, measured: swings > 0, hit: false, kill: false, ...(last ?? {}), swings, why: swings ? `${swings} swings in reach and no hit point fell` : 'never got within reach of an enemy' };
}

/**
 * Where a player in a level made of rooms should walk next to reach `to`: through the level's doors. The rooms are
 * joined as a graph by `doors` (each door joins two rooms whose middles line up, so the line between their middles
 * passes through the doorway); the route is the shortest chain of room middles from the player's room to the room
 * that holds `to`, and the next point is the first middle not yet reached. A level with no rooms (an island) → `to`.
 * Pure. level: {rooms: [{id, rect}], doors: [{rooms: [a, b]}]}; me, to: {x, z}. → {x, z}
 */
export function roomRoute(level, me, to) {
  const rooms = level?.rooms ?? [];
  if (!rooms.length) return to;
  const mid = r => ({ x: (r.rect[0] + r.rect[2]) / 2, z: (r.rect[1] + r.rect[3]) / 2 });
  const inside = (r, q) => q.x >= r.rect[0] && q.x <= r.rect[2] && q.z >= r.rect[1] && q.z <= r.rect[3];
  const closest = q => rooms.reduce((best, r) => (Math.hypot(mid(r).x - q.x, mid(r).z - q.z) < Math.hypot(mid(best).x - q.x, mid(best).z - q.z) ? r : best));
  const goal = rooms.find(r => inside(r, to)) ?? closest(to);
  // hops from every room to the goal room, over the doors
  const hops = new Map([[goal.id, 0]]), queue = [goal.id];
  while (queue.length) {
    const id = queue.shift();
    for (const d of level.doors ?? []) { const other = d.rooms[0] === id ? d.rooms[1] : d.rooms[1] === id ? d.rooms[0] : null; if (other && !hops.has(other)) { hops.set(other, hops.get(id) + 1); queue.push(other); } }
  }
  const here = rooms.find(r => inside(r, me));
  if (here?.id === goal.id) return to;
  if (here) {
    const nextId = (level.doors ?? []).map(d => (d.rooms[0] === here.id ? d.rooms[1] : d.rooms[1] === here.id ? d.rooms[0] : null)).filter(id => id && hops.has(id)).sort((x, y) => hops.get(x) - hops.get(y))[0];
    if (nextId === undefined || hops.get(nextId) >= (hops.get(here.id) ?? Infinity)) return to;
    const from = mid(here), next = mid(rooms.find(r => r.id === nextId));
    // off the line through the doorway (a doorway is one 3 m module wide): first back to the middle of this room
    const ux = next.x - from.x, uz = next.z - from.z, len = Math.hypot(ux, uz) || 1;
    return Math.abs((me.x - from.x) * uz - (me.z - from.z) * ux) / len > 1.0 ? from : next;
  }
  // in a doorway (between two rooms): on to the room of its two that is nearer the goal
  const door = (level.doors ?? []).find(d => {
    const [p, q] = d.rooms.map(id => mid(rooms.find(r => r.id === id))), len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const t = ((me.x - p.x) * (q.x - p.x) + (me.z - p.z) * (q.z - p.z)) / (len * len);
    return t >= 0 && t <= 1 && Math.abs((me.x - p.x) * (q.z - p.z) - (me.z - p.z) * (q.x - p.x)) / len < 1.5;
  });
  const pick = door ? door.rooms.map(id => rooms.find(r => r.id === id)).sort((x, y) => (hops.get(x.id) ?? Infinity) - (hops.get(y.id) ?? Infinity))[0] : closest(me);
  return mid(pick);
}

/** ?gf-demo=levels.clear, no bots: the level's enemies come and are taken down by the host; once the portal opens the
 *  scripted player walks into it with real keys; the level must move on. → {opened, moved, seconds} */
async function levelsPage({ newPage, url, game, shot, log }) {
  const T = await newPage('demo-levels', { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 120 }] } });
  const p = T.page, t0 = Date.now(), obs = () => p.evaluate(MOBS);
  let opened = false, moved = false;
  try {
    await p.goto(`${url}?seed=7&bots=0&gf-demo=levels.clear`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    const play = await p.locator('#gf-play').boundingBox().catch(() => null);
    if (play) await p.mouse.click(play.x + play.width / 2, play.y + play.height / 2); else await p.keyboard.press('Enter');
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 20000) throw new Error('the round did not start'); await sleep(120); }
    let L0 = null;
    for (let t = Date.now(); Date.now() - t < 25000; await sleep(300)) { const o = await obs(); L0 ??= o.levels?.level ?? 0; if (o.levels?.portal?.open) { opened = true; break; } }
    if (opened) {
      await shot(p, 'alive-portal-open');
      const k = await calibrate(p, obs);
      // a level made of rooms (a dungeon) has walls: the portal is behind a doorway, so the route goes through the level's doors
      const rooms = await p.evaluate(async () => { try { return (await (await fetch('config/world.json')).json()).levels.map(l => ({ rooms: l.rooms ?? [], doors: l.doors ?? [] })); } catch { return null; } }).catch(() => null);
      for (let t = Date.now(); k && Date.now() - t < 20000; ) {
        const o = await obs();
        if ((o.levels?.level ?? 0) > L0) { moved = true; break; }
        const pt = o.levels?.portal; if (!pt || !o.me) { await sleep(200); continue; }
        const aim = roomRoute(rooms?.[o.levels?.level ?? 0], o.me, pt);
        await walkToward(p, k.F, k.R, aim.x - o.me.x, aim.z - o.me.z, 220);
      }
      await sleep(900);
      await shot(p, 'alive-next-level');
    }
    log(`alive: levels: the portal ${opened ? 'opened' : 'never opened'}${opened ? `, walking in ${moved ? 'moved the run on' : 'did not move the run on'}` : ''}`);
  } finally { await T.ctx.close().catch(() => {}); }
  return { opened, moved, seconds: Math.round((Date.now() - t0) / 1000) };
}

/** ?gf-demo=boss.phase with 3 bots: the run starts on the boss level, its hit points just above its first threshold;
 *  the scripted player walks up and swings too (melee). → {came, phase, seconds} */
async function bossPage({ newPage, url, game, shot, log }) {
  const T = await newPage('demo-boss', { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 120 }] } });
  const p = T.page, t0 = Date.now(), obs = () => p.evaluate(MOBS);
  let came = false, phase = 0;
  const melee = (game.mechanics ?? []).find(m => m.id === 'melee');
  try {
    await p.goto(`${url}?seed=7&bots=3&gf-demo=boss.phase`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    const play = await p.locator('#gf-play').boundingBox().catch(() => null);
    if (play) await p.mouse.click(play.x + play.width / 2, play.y + play.height / 2); else await p.keyboard.press('Enter');
    for (let t = Date.now(); Date.now() - t < 35000; ) {
      const o = await obs().catch(() => null);
      if (o?.boss?.active) came = true;
      phase = Math.max(phase, o?.boss?.phase ?? 0);
      if (phase >= 1 || o?.phase === 'results') break;
      if (came && melee && o?.phase === 'playing') await walkAndSwing(p, { game, melee, seconds: 4, boss: true }).catch(() => null);
      else await sleep(400);
    }
    await sleep(800);                                              // the recorder samples 4 times a second: let it see the phase
    await shot(p, 'alive-boss');
    log(`alive: boss: ${came ? `came, phase ${phase + 1}` : 'never came'}`);
  } finally { await T.ctx.close().catch(() => {}); }
  return { came, phase, seconds: Math.round((Date.now() - t0) / 1000) };
}
