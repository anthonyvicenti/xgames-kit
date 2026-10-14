// Teams fixture rules. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const teams = ctx.mechanics.get('teams');
    window.__fx = {
      score: n => { ctx.me.score += n; },
      info: () => ({ me: ctx.me.id, teams: Object.fromEntries(ctx.players.list().map(p => [p.id, { team: teams.teamOf(p), color: p.color }])), scores: teams.scores(), standings: teams.standings().map(s => ({ team: s.team, score: s.score })), colors: [teams.colorOf(0), teams.colorOf(1)] }),
    };
  },
};
