// teams: the pure logic (no three.js, no DOM): who goes on which team, and the standings.
// Node tests: research/gf-three/tests/k2-teams.test.mjs.

/**
 * Which team a new player joins. current: {id: team} of everyone already placed. mode: 'balanced' (the smallest team,
 * ties to the lowest index), 'seat' (seat % count), 'random' (a random one of the smallest teams). rng() → 0..1
 */
export function pickTeam(player, current, count, mode = 'balanced', rng = Math.random) {
  if (mode === 'seat') return ((player.seat ?? 0) % count + count) % count;
  const sizes = Array(count).fill(0);
  for (const t of Object.values(current)) if (t >= 0 && t < count) sizes[t]++;
  const min = Math.min(...sizes), smallest = sizes.map((n, i) => (n === min ? i : -1)).filter(i => i >= 0);
  return mode === 'random' ? smallest[Math.floor(rng() * smallest.length) % smallest.length] : smallest[0];
}

/** Everyone re-dealt evenly in a random order. players: [{id, seat}] → {id: team} */
export function shuffleTeams(players, count, rng) {
  const order = players.map(p => p.id);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return Object.fromEntries(order.map((id, i) => [id, i % count]));
}

/** Team totals from assignments and per-player scores (mode 'sum'), or manual points. → number[] */
export function totals(assign, scores, count, manual = null) {
  const out = Array(count).fill(0);
  if (manual) manual.forEach((v, i) => { if (i < count) out[i] += v; });
  for (const [id, t] of Object.entries(assign)) if (t >= 0 && t < count) out[t] += scores[id] ?? 0;
  return out;
}

/** Standings: [{team, score}] best first. Ties keep the lower team index first. */
export const standings = tot => tot.map((score, team) => ({ team, score })).sort((a, b) => b.score - a.score || a.team - b.team);

/** The winning team(s): {teams: [index], tie}. Nobody wins at 0-0 unless allowZero. */
export function winnerOf(tot, { allowZero = false } = {}) {
  const best = Math.max(...tot);
  if (best <= 0 && !allowZero) return { teams: [], tie: false };
  const teams = tot.map((v, i) => (v === best ? i : -1)).filter(i => i >= 0);
  return { teams, tie: teams.length > 1 };
}
