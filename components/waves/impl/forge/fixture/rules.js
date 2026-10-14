// Waves fixture on forge: the plan comes from the mechanic's params; the host fells enemies in the joiner's name.
// Exposes window.__fx (QA only).
const other = ctx => ctx.players.list().find(p => !p.local && !p.ghost) ?? null;
export default {
  setup(ctx) {
    const w = ctx.mechanics.get('waves');
    const heard = { start: [], clear: [], all: 0, kills: 0 };
    w.onWaveStart(d => heard.start.push(d.wave)); w.onWaveClear(d => heard.clear.push(d.wave)); w.onAllClear(() => heard.all++); w.onKill(() => heard.kills++);
    window.__fx = {
      info: () => ({ me: ctx.me.id, state: w.state(), plan: (ctx.tables?.waves ?? []).map(x => x.enemies.reduce((n, g) => n + g.count, 0)), scores: Object.fromEntries(ctx.players.list().map(p => [p.id, p.score])), heard: JSON.parse(JSON.stringify(heard)) }),
      // QA: every standing enemy takes a killing blow from the joiner (the host's core decides the kill)
      fellAll: () => { const o = other(ctx), by = ctx.players.nid(o.id); let n = 0; for (const e of ctx.forge.entities(2)) { if (e.flags & 1) continue; ctx.forge.cmd.damage(e.net, 9999, by, [0, 0, 1]); n++; } return n; },
      faceEnemy: () => { const e = ctx.forge.entities(2).find(x => !(x.flags & 1)); if (e) window.__game.forge.face?.(e.x, e.y + 1, e.z); return !!e; },
    };
  },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
