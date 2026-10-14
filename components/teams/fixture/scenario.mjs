// Two players, balanced onto different teams, with the team colours on both copies; a point moves the team score on both.
export default async function scenario({ H, J, ev, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return Object.values(a.teams).every(t => t.team >= 0) && Object.values(b.teams).every(t => t.team >= 0) ? true : null; }, 6000, 'assignment');
  const [a, b] = [await info(H), await info(J)];
  const ids = Object.keys(a.teams);
  check('different-teams-balanced', ids.length === 2 && a.teams[ids[0]].team !== a.teams[ids[1]].team, JSON.stringify(a.teams));
  check('both-copies-agree-on-teams', ids.every(id => a.teams[id].team === b.teams[id].team));
  check('team-colour-on-every-player-on-both', ids.every(id => a.teams[id].color === a.colors[a.teams[id].team] && b.teams[id].color === b.colors[b.teams[id].team]), JSON.stringify([a.teams, a.colors]));
  await ev(H, () => window.__fx.score(2));
  await until(async () => { const [x, y] = [await info(H), await info(J)]; const t = x.teams[x.me].team; return x.scores[t] === 2 && y.scores[t] === 2 ? true : null; }, 6000, 'the score').then(() => check('team-score-agrees-on-both', true), () => check('team-score-agrees-on-both', false, 'scores differ'));
}
