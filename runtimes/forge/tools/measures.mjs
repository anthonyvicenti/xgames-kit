// forge's own judges for the shared measures whose evidence is forge's (runtimes/CONTRACT.md §7; builder/GATES.md).
// Pure: verify (builder/tools/verify-forge.mjs) measures in the browser and hands the numbers here; the tests hold them.
//
//   39 (gate F) hits per kill as the spec says: the hits per kill the locked spec asks for (spec.forge.hitsPerKill,
//      1 with oneHitKills, else 2: the spec default since 2026-10-12), held two ways: the tables' arithmetic (each
//      weapon a player can hold, one hit's damage against the weakest enemy's health: what config/game.json asks for)
//      and the hits each kill took on measure 16's staged page (the core's kill log). Taste is the spec's default,
//      never a threshold here.

/** The default when the spec asks nothing (the kit's spec default, as the three runtime's waves hitsPerKill). */
export const DEFAULT_HITS_PER_KILL = 2;
const median = a => { if (!a?.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** What the locked spec asks for. spec: spec.json (v2 keeps forge's values in `tables`). → {want, why} */
export function hitsAsked(spec = {}) {
  const t = spec.tables ?? spec.forge ?? {};
  if (Number.isInteger(t.hitsPerKill) && t.hitsPerKill >= 1) return { want: t.hitsPerKill, why: `the spec sets hitsPerKill ${t.hitsPerKill}` };
  if (t.oneHitKills === true) return { want: 1, why: 'the spec sets oneHitKills' };
  return { want: DEFAULT_HITS_PER_KILL, why: `the spec does not set hitsPerKill: the default, ${DEFAULT_HITS_PER_KILL}` };
}

/**
 * The tables' arithmetic: for each weapon row a player can hold (`rows`: [{id, name, row}] as forge-feel-check's
 * holdableWeapons gives them), one hit (one pellet of a scattergun) against the weakest enemy that is not a boss. → [{id,
 * name, damage, hp, hits}]
 */
export function tableHits(game = {}, rows = []) {
  const W = game.forge?.weapons ?? [], E = (game.forge?.enemies ?? []).filter(e => e && (e.archetype ?? 'chaser') !== 'boss');
  const hp = E.length ? Math.min(...E.map(e => Number(e.health) || Infinity)) : null;
  if (!Number.isFinite(hp)) return [];
  return rows.map(r => {
    const w = W[r.row] ?? W.find(x => x.id === r.id) ?? {}, damage = Number(w.damage) || 0;
    return { id: r.id, name: r.name ?? r.id, damage, hp, hits: damage > 0 ? Math.ceil(hp / damage) : null };
  }).filter(x => x.hits !== null);
}

/**
 * Measure 39 on forge. game: config/game.json; spec: spec.json; holdable: the rows a player can hold; measured: measure
 * 16's record.measured ({applies, rows: [{id, name, inHand, kills: [hits per kill], pellets}]}) or null when 16's page
 * did not run. → {ok, detail}
 */
export function judgeHitsPerKill({ game = {}, spec = {}, holdable = [], measured = null }) {
  const { want, why } = hitsAsked(spec);
  if (!(game.forge?.weapons ?? []).length) return { ok: true, detail: 'no weapon (spec.forge.weapons is empty): nothing to count' };
  const fails = [];
  const arith = tableHits(game, holdable);
  for (const a of arith) if (a.hits < want) fails.push(`config/game.json: ${a.name} does ${a.damage} a hit against the weakest enemy's ${a.hp} hit points, ${a.hits} hit${a.hits === 1 ? '' : 's'} a kill, but the locked spec asks for at least ${want} (${why})`);
  const rows = (measured?.rows ?? []).filter(r => r.inHand !== false && (r.pellets ?? 1) <= 1 && r.kills?.length);
  for (const r of rows) { const m = median(r.kills); if (m < want) fails.push(`on measure 16's staged page ${r.name ?? r.id} took ${r.kills.join('/')} hits a kill (median ${m}), under the ${want} the spec asks for`); }
  const head = `${arith.map(a => `${a.name}: ${a.hits} a kill by the tables (${a.damage} against ${a.hp})`).join(', ') || 'no enemy health to count against'}${rows.length ? `; measured ${rows.map(r => `${r.name ?? r.id} median ${median(r.kills)}`).join(', ')}` : measured ? '; no kill measured on 16\'s page' : '; 16\'s page did not run'}`;
  if (fails.length) return { ok: false, detail: `${fails.join('; ')}. Keep a hit's damage under the enemy's health so a basic enemy takes ${want}–${Math.max(4, want + 2)} hits (spec.forge.weapons[].damage against enemies[].health); only the spec sets fewer (hitsPerKill, oneHitKills). Measured: ${head}` };
  return { ok: true, detail: `${head}; the spec asks for at least ${want} (${why})` };
}
