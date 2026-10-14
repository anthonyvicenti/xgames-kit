// mechanic: teams (track K2). Team assignment (balanced, by seat or random), team colours on nameplates and rings,
// team scores and a team scoreboard. Other mechanics read it: projectile's friendly fire, paint by team.
// README.md has ownership and API.
//
//   const teams = ctx.mechanics.get('teams');
//   teams.teamOf(ctx.me);          // 0, 1 ... (every copy)
//   check(ctx) { return teams.check(); }     // { winners: [player ids], reason } once a team leads at time up
import { pickTeam, shuffleTeams, totals, standings, winnerOf } from './logic.js';

export const id = 'teams';
export const examples = ['red vs blue', 'two teams, shared score', 'three-way team battle'];

const D = {
  count: 2, names: ['Red', 'Blue', 'Green', 'Yellow'], colors: ['#ff5e6c', '#4f7cff', '#3ddc84', '#ffd166'], assign: 'balanced', friendlyFire: false,
  scoreMode: 'sum', tint: true, scoreboard: true, bannerOnStart: true, youAreText: 'You are on the {team} team', spawnZones: [],
};
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    count: { type: 'integer', minimum: 2, maximum: 4, default: D.count, description: 'Number of teams' },
    names: { type: 'array', items: { type: 'string' }, default: D.names, description: 'Team names, in order' },
    colors: { type: 'array', items: { type: 'string' }, default: D.colors, description: 'Team colours, in order' },
    assign: { type: 'string', enum: ['balanced', 'seat', 'random'], default: D.assign, description: 'balanced: the smallest team; seat: seat number; random: a random one of the smallest teams' },
    friendlyFire: { type: 'boolean', default: D.friendlyFire, description: 'Whether teammates can hurt each other (read by the projectile mechanic)' },
    scoreMode: { type: 'string', enum: ['sum', 'manual'], default: D.scoreMode, description: 'sum: a team\'s score is its players\' scores added; manual: only addScore() counts' },
    tint: { type: 'boolean', default: D.tint, description: 'Nameplates and floor rings take the team colour' },
    scoreboard: { type: 'boolean', default: D.scoreboard, description: 'Replace the kit scoreboard with one row per team' },
    bannerOnStart: { type: 'boolean', default: D.bannerOnStart, description: 'Tell the local player their team when play starts' },
    youAreText: { type: 'string', default: D.youAreText, description: 'That banner; {team} is the team name' },
    spawnZones: { type: 'array', items: { type: 'string' }, default: D.spawnZones, description: 'World zone each team starts in (spawnPoint(player) reads it)' },
  },
};
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.teams.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : type === 'text' ? 'text' : 'gameplay', ...extra });
export const slots = [
  vs('count', 'Number of teams', 'integer', { tier: 'main', rank: 56, constraints: { min: 2, max: 4 } }),
  { ...vs('colors', 'Team colours', 'json', { tier: 'main', rank: 52 }) },
  vs('names', 'Team names', 'json', { tier: 'main', rank: 50, facet: 'text' }),
  vs('friendlyFire', 'Teammates can hurt each other', 'boolean', { rank: 40 }),
  vs('youAreText', 'Team banner text', 'text', { constraints: { maxLength: 60 } }),
  vs('tint', 'Team colours on players', 'boolean'),
  vs('scoreboard', 'Team scoreboard', 'boolean'),
];

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.teams.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const count = () => Math.max(2, Math.min(4, V('count')));
  let S = null, announced = false, lastKey = '', started = false;
  const applied = new Map();        // every copy: player id → team the look was applied for
  let manual = Array(4).fill(0);
  const players = () => ctx.players.list();
  const assignment = () => (S?.a ?? {});

  function applyLook(p, t) {
    const color = V('colors')[t] ?? '#ffffff';
    if (!V('tint')) return;
    p.color = color;
    const ring = p.character?.object3d?.getObjectByName?.('ring'); ring?.material?.color?.set(color);
    p.character?.setTint?.(color);
  }

  const api = {
    id, params: P,
    /** Team index of a player on any copy (-1 until assigned). */
    teamOf(p) { const t = assignment()[p?.id]; return t === undefined ? -1 : t; },
    teamCount: count,
    nameOf: t => V('names')[t] ?? `Team ${t + 1}`,
    colorOf: t => V('colors')[t] ?? '#ffffff',
    members: t => players().filter(p => api.teamOf(p) === t),
    sameTeam: (a, b) => { const x = api.teamOf(a); return x >= 0 && x === api.teamOf(b); },
    get friendlyFire() { return !!V('friendlyFire'); },
    /** Host: move a player to a team (or deal everyone again with shuffle()). */
    assignTo(p, t) { if (!ctx.host || !S) return; S.a = { ...S.a, [p.id]: Math.max(0, Math.min(count() - 1, t)) }; },
    shuffle() { if (!ctx.host || !S) return; S.a = shuffleTeams(players(), count(), ctx.rng); },
    /** Host: add points to a team (scoreMode manual, or bonuses on top of the players' scores). */
    addScore(t, n = 1) { if (!ctx.host || !S || t < 0 || t >= count()) return; manual[t] += n; S.m = manual.slice(0, count()); },
    /** Every copy: a team's score. */
    score: t => api.scores()[t] ?? 0,
    scores() {
      const sc = Object.fromEntries(players().map(p => [p.id, p.score]));
      return totals(assignment(), V('scoreMode') === 'manual' ? {} : sc, count(), S?.m ?? null);
    },
    /** Every copy: [{team, name, color, score, members}] best first. */
    standings() { return standings(api.scores()).map(s => ({ ...s, name: api.nameOf(s.team), color: api.colorOf(s.team), members: api.members(s.team).map(p => p.id) })); },
    /** Every copy: the leading team(s) {teams, tie}. */
    leader: () => winnerOf(api.scores()),
    /** Host `check()` helper: null while nobody leads or time remains; else {winners: [player ids of the leading team], reason}. Call it from rules.check when the round should end on its own terms. */
    check() { const w = winnerOf(api.scores()); if (!w.teams.length) return null; return { winners: players().filter(p => w.teams.includes(api.teamOf(p))).map(p => p.id), reason: w.tie ? 'tie' : 'team' }; },
    /** The winners to hand to ctx.round.end(reason, winners) right now. */
    winnerIds() { const w = winnerOf(api.scores()); return players().filter(p => w.teams.includes(api.teamOf(p))).map(p => p.id); },
    /** Where a player of this team starts: a point in the team's spawn zone, or null. */
    spawnPoint(p) { const z = V('spawnZones')?.[api.teamOf(p)]; const zn = z && ctx.world.zone?.(z); return zn ? zn.random(ctx.rng) : null; },
    reset() { manual = Array(4).fill(0); applied.clear(); announced = false; started = false; lastKey = ''; },
    update() {
      if (!S) { if (!(ctx.shared && ctx.players && ctx.me)) return; S = ctx.shared.register('teams', { a: {}, m: [] }); }
      if (ctx.host) {
        let changed = false; const a = { ...S.a };
        for (const p of players()) if (a[p.id] === undefined) { a[p.id] = pickTeam(p, a, count(), V('assign'), () => ctx.rng()); changed = true; }
        for (const id of Object.keys(a)) if (!ctx.players.get(id)) { delete a[id]; changed = true; }
        if (changed) S.a = a;
      }
      const a = assignment();
      for (const p of players()) {
        const t = a[p.id]; if (t === undefined) continue;
        if (applied.get(p.id) !== t) { applied.set(p.id, t); applyLook(p, t); }
        p.data.team = t;
      }
      if (ctx.round?.phase === 'playing' && !started) {
        started = true;
        const t = api.teamOf(ctx.me);
        if (V('bannerOnStart') && t >= 0) ctx.ui?.banner(V('youAreText').replace('{team}', api.nameOf(t)), 2.2);
      }
      if (V('scoreboard') && ctx.ui?.score) {
        const rows = api.standings().map(s => ({ name: s.name, value: s.score, color: s.color }));
        const key = JSON.stringify(rows); if (key !== lastKey) { lastKey = key; ctx.ui.score(rows); }
      }
    },
    dispose() { ctx.ui?.score?.(null); },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs MANIFEST lists the fields): what `create` composes and refuses by, what the
// catalog tells a pitch, the handlers and traps of the rules.js stub, and verify check 15's sign of life. The tools
// read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, examples, params,
  describe: 'Team assignment, team score',
  rank: 100,
  needs: { parts: [], world: [] },
  uses: ['projectile', 'paint'],
  owns: p => (p.scoreboard ? [{ res: 'hud.scoreboard', why: 'one row per team replaces the kit\'s scoreboard (params.scoreboard)', free: 'set teams params.scoreboard to false' }] : []),
  state: { key: 'teams', fields: { a: '{ playerId: team index }', m: 'points added by hand, per team' } },
  events: [],
  sync: { owner: 'host', how: 'the host owns the assignment and hand-added points; team scores are summed on every copy from the players\' scores' },
  note: [
    'Players are put on teams at round start and wear their team\'s colour; a team\'s score is the sum of its players\' scores, so score players as usual.',
    'teams.teamOf(p), teams.sameTeam(a, b) and teams.standings() are the same on every copy; projectile reads friendlyFire by itself.',
    'The round ends on a team only when rules.check returns teams.check().',
  ],
  stub: {
    as: 'teams',
    worked: 'check(ctx) { return ctx.time.left <= 0 ? teams.check() : null; }   // { winners: [the leading team\'s player ids], reason }',
    traps: [
      'results() still returns one row per player: the team scoreboard is the kit\'s, from teams.standings()',
      'teams.addScore(t, n) is for bonuses: with scoreMode "sum" a point given to a player already counts for their team',
    ],
  },
  signs: {
    sample: sh => (sh.teams ? { teams: sh.teams.a ?? {} } : null),
    judge: v => {
      const ok = v.others.teams >= 2;
      v.add('two teams', ok ? 'ok' : 'dead', 'shared.teams.a', ok ? 'yes' : `players were on ${v.others.teams} team(s) on any page (${v.names})`, ok ? '' : 'check players.teams in config/game.json and that rules do not reassign everyone');
    },
  },
};
