// rules.js: THE GAME AGENT'S FILE. Ruin Watch: gf-forge track A's encounter room (research/rust-engine/PLAN.md §4).
// The kit runs the menu, the HUD, the round, the first-person walk and the weapons (the Rust core: forge-feel), the
// ruins arena (gf/forge/world.js) and the enemies (forge-ai: the wave director starts with the round, gf/forge/ai.js);
// this file says what scores and how a round ends, and what happens between waves.
//
// Win: every wave cleared (waves-done). Lose: every player down. Score: each kill's points to whoever landed it.
// Reward: the third wave asks for one; the three-card table is not built yet, so a banner stands in and the director
// resumes 1.5 s later.
// Test room (?room=1): a panel to raise each enemy type, run the director by hand and read the AI's state.
// (Written for the track A sandbox; kept in runtimes/forge/specs/arena.rules.js and copied in after create. The
// stand-in weapon it carried until the wave 1b integration is gone: forge-feel's weapons hit forge-ai's enemies.)
import { FEEL_OP } from './gf/forge/feel.js';

const coreId = (ctx, p) => ctx.players.nid?.(p.id) ?? null;
const byCore = (ctx, id) => ctx.players.list().find(p => coreId(ctx, p) === id) ?? null;

function panel(ctx) {
  const d = document.createElement('div');
  d.id = 'gf-room';
  d.style.cssText = 'position:fixed;right:8px;top:8px;z-index:30;background:#0b0e18cc;color:#e8e2d6;font:12px/1.4 system-ui;padding:8px 10px;border-radius:8px;max-width:250px;max-height:46vh;overflow:hidden';
  const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'margin:2px;font:12px system-ui;padding:4px 6px;border-radius:6px;border:0;background:#3a2f28;color:#fff;cursor:pointer'; b.onclick = e => { e.stopPropagation(); fn(); ctx.input?.focus?.(); }; d.append(b); return b; };
  d.append(Object.assign(document.createElement('div'), { textContent: 'Encounter room (track A)' }));
  for (const r of ctx.tables.enemies ?? []) btn(`+ ${r.name || r.id}`, () => ctx.ai.spawn(r.id));
  d.append(document.createElement('br'));
  btn('waves ▶', () => ctx.ai.director.start(0));
  btn('next wave', () => ctx.ai.director.skip(Math.min((ctx.ai.director.state().wave || 1), (ctx.tables.waves ?? []).length - 1)));
  btn('boss wave', () => ctx.ai.director.skip(Math.max(0, (ctx.tables.waves ?? []).length - 1)));
  btn('stop + clear', () => ctx.ai.director.stop());
  const info = document.createElement('pre');
  info.style.cssText = 'margin:6px 0 0;white-space:pre-wrap;font:10px ui-monospace,monospace;pointer-events:none';
  d.append(info);
  document.body.append(d);
  return info;
}

export default {
  setup(ctx) {
    ctx.ui.goal?.('Hold the ruin: clear every wave');
    if (new URLSearchParams(location.search).get('room') === '1') {
      ctx.__room = panel(ctx);
      // QA in the test room only: the context, and a crowd raiser (one enemy of a type at an emerge point)
      window.__room = ctx;
      window.__crowd = type => ctx.ai.spawn(type);
    }
  },
  roundStart(ctx) {
    for (const p of ctx.players.list()) p.score = 0;
    ctx.__reward = null;
    if (!ctx.host) return;
    // every player starts over (full health and ammunition) with every weapon of the table (keys 1-4 and the wheel)
    const rows = (ctx.tables.weapons ?? []).map((_, i) => i);
    for (const p of ctx.players.list()) {
      const n = coreId(ctx, p);
      if (n == null) continue;
      ctx.forge.cmd.raw(FEEL_OP.RESET, [n]);
      if (rows.length) ctx.forge.cmd.raw(FEEL_OP.LOADOUT, [n, ...rows]);
    }
  },
  event(ctx, name, d) {
    if (name === 'enemy-down') {
      const p = byCore(ctx, d.d);
      if (p && ctx.host) p.score += Math.max(1, Math.round(d.b || 1));
    } else if (name === 'wave-start') ctx.ui.banner?.(`Wave ${d.a} / ${d.b}`, 1.4);
    else if (name === 'boss-arrive') ctx.ui.banner?.('The bone lord rises', 2);
    else if (name === 'boss-phase') ctx.ui.banner?.(d.a >= 3 ? 'The lord is enraged' : 'The lord calls the dead', 1.6);
    else if (name === 'waves-done' && ctx.host && ctx.round.phase === 'playing') ctx.round.end('cleared', ctx.players.list().filter(p => p.alive !== false).map(p => p.id));
  },
  // between waves: the three-card choice goes here (rules.js + the kit's UI); a banner stands in for it
  reward(ctx, { wave, resume }) {
    ctx.ui.banner?.(`Wave ${wave} held. (The card table comes later.)`, 1.5);
    ctx.__reward = { at: ctx.time.now + 1.5, resume };
  },
  update(ctx) {
    if (ctx.__reward && ctx.time.now >= ctx.__reward.at) { const r = ctx.__reward; ctx.__reward = null; r.resume(); }
    if (ctx.__room) ctx.__room.textContent = JSON.stringify(ctx.ai?.observe?.() ?? null, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v), 1).slice(0, 900);
    if (!ctx.host || ctx.round.phase !== 'playing') return;
    // everyone down: the round is lost
    const all = ctx.players.list();
    if (all.length && all.every(p => p.alive === false)) ctx.round.end('lost', []);
  },
  check() { return null; },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
  // QA (CONTRACT §6b): the AI's state (the director, the boss, enemies by state, the bots)
  observe(ctx) { return ctx.ai?.observe?.() ?? null; },
};
