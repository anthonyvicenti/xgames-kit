// rules.js: THE GAME AGENT'S FILE. Forge Room: gf-forge's integrated test room (the wave 1b integration,
// gf-forge/INTEGRATION.md; port 5823; not a game for anyone yet). All four tracks in one game: the kit runs the
// menu, the HUD, the round and live co-op for 2-4 (track S), the first-person controller and weapons (forge-feel, track
// F), the ruins arena, the enemies and the wave director (forge-ai and gf/forge/world.js, track A), and the Rust
// renderer draws all of it (track R). This file says what scores, how a round ends and what happens between waves.
//
// Win: every wave cleared (waves-done). Lose: every player down. Score: each kill's points to whoever landed it, and a
// point a coin. Every player holds every weapon of the table from the start (keys 1-4 and the wheel; the focus shares
// key 1 with the sidearm: press it again). Reward: the third wave asks for one; a banner stands in for the card table.
// Test room (?room=1): a panel to raise each enemy type, run the director by hand and read both the AI's and the feel's
// state. (Kept in runtimes/forge/specs/room.rules.js and copied in after create.)
import { FEEL_OP } from './gf/forge/feel.js';

const coreId = (ctx, p) => ctx.players.nid?.(p.id) ?? null;
const byCore = (ctx, id) => ctx.players.list().find(p => coreId(ctx, p) === id) ?? null;

// every player starts over (full health and ammunition); `loadout`: holding every weapon of the table, the first in hand
function arm(ctx, loadout = true) {
  const rows = (ctx.tables.weapons ?? []).map((_, i) => i);
  for (const p of ctx.players.list()) {
    const n = coreId(ctx, p);
    if (n == null) continue;
    ctx.forge.cmd.raw(FEEL_OP.RESET, [n]);
    if (loadout && rows.length) ctx.forge.cmd.raw(FEEL_OP.LOADOUT, [n, ...rows]);
  }
}

function panel(ctx) {
  const d = document.createElement('div');
  d.id = 'gf-room';
  d.style.cssText = 'position:fixed;right:8px;top:8px;z-index:30;background:#0b0e18cc;color:#e8e2d6;font:12px/1.4 system-ui;padding:8px 10px;border-radius:8px;max-width:260px;max-height:52vh;overflow:hidden';
  const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'margin:2px;font:12px system-ui;padding:4px 6px;border-radius:6px;border:0;background:#3a2f28;color:#fff;cursor:pointer'; b.onclick = e => { e.stopPropagation(); fn(); ctx.input?.focus?.(); }; d.append(b); return b; };
  d.append(Object.assign(document.createElement('div'), { textContent: 'Forge room (wave 1b)' }));
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
    const q = new URLSearchParams(location.search);
    if (q.get('room') === '1') {
      ctx.__room = panel(ctx);
      // QA in the test room only: the context, and a crowd raiser (one enemy of a type at an emerge point)
      window.__room = ctx;
      window.__crowd = type => ctx.ai.spawn(type);
      // every player back to full health and ammunition, the weapon in hand kept (the host's word)
      window.__heal = () => { if (ctx.host) arm(ctx, false); };
    }
  },
  roundStart(ctx) {
    for (const p of ctx.players.list()) p.score = 0;
    ctx.__reward = null;
    if (ctx.host) arm(ctx);
  },
  event(ctx, name, d) {
    if (name === 'enemy-down') {
      const p = byCore(ctx, d.d);
      if (p && ctx.host) p.score += Math.max(1, Math.round(d.b || 1));
    } else if (name === 'coin') {
      const p = byCore(ctx, d.entity);
      if (p && ctx.host) p.score += Math.max(0, Math.round(d.a || 0));
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
    if (ctx.__room) {
      const v = ctx.feel?.view?.() ?? {};
      ctx.__room.textContent = JSON.stringify({ ai: ctx.ai?.observe?.() ?? null, feel: { weapon: ctx.tables.weapons?.[v.weapon]?.id ?? null, ammo: v.ammo, kills: v.kills, combo: v.combo, tint: v.tint, down: v.down }, draw: ctx.render?.stats?.() }, (k, x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x), 1).slice(0, 1100);
    }
    if (!ctx.host || ctx.round.phase !== 'playing') return;
    // everyone down: the round is lost
    const all = ctx.players.list();
    if (all.length && all.every(p => p.alive === false)) ctx.round.end('lost', []);
  },
  check() { return null; },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
  // QA (CONTRACT §6b): the AI's state, the feel's, and what the renderer drew
  observe(ctx) {
    const v = ctx.feel?.view?.() ?? null;
    return { ai: ctx.ai?.observe?.() ?? null, feel: v && { weapon: v.weapon, ammo: v.ammo, kills: v.kills, hits: v.hits, combo: v.combo, tint: v.tint, stage: v.stage, down: v.down, debris: v.debris }, fight: ctx.fight?.observe?.() ?? null };
  },
};
