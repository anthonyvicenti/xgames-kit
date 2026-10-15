// gf-three ui: the kit's HUD (CONTRACT §6g). The kit, not rules.js, shows the local player's own state, read each frame
// from the mechanics the game uses, so no game can ship without it. rules.js adds to it (ctx.ui.meter, ctx.ui.goal);
// it never takes it away. UI only, never art (CONTRACT §2): colours are CSS custom properties and mechanic slots.
//
// What it draws:
//   top left      the menu button (☰): the pause menu (Esc does the same)
//   bottom right  in a frame that allows full screen and isn't the games.fun /play page (which has its own), with a
//                 mouse (touch puts its buttons there), a full-screen button: a post on X (2026-10-08)
//   top middle    the goal line under the round clock: config/game.json → text.goal (ui.goal), else the spec's win line
//   bottom left   the player card: your name in your colour; your health (health with hp > 0: pips up to 10, else a bar
//                 and the number); your state (knocked down, out with the seconds to respawn, protected); and one line
//                 or bar per mechanic that has something of yours to show: the stream's tank, your paint share, what
//                 you hold, your lap and place, whether you are it, your team, the wave and the enemies left, the
//                 task quota. The rules' own meters (ctx.ui.meter) sit in the same card. With the action mechanics
//                 (gf-scenic wave 1, track M): the level ("Level 2/3 · 4 left", "Portal open"), your coins and your
//                 weapon in its rarity colour. Last, the hosting page's economy lines (gf:host → economy, where
//                 'hud'; kit/net/host.js, CONTRACT §6g W2): each its label and the page's gf:economy entry of the same id.
//                 No offer, no line; rules.js never sees them.
//   top middle    the boss's name and its big health bar while a boss fights (the boss mechanic)
//   the edges     a red flash when you are hurt, and a slow pulse while your health is low
//   bottom middle the team health cards (ui.teams, ./widgets.js), for a game with teams and health whose HUD style names
//                 them (config/game.json → ui.style.widgets has 'team-cards': a look target that shows them sets it)
//
// The observation, window.__game.hud() (verify check 21): every widget the game's mechanics call for, whether it is on
// screen, what it shows (read back from the page) and what the kit's state says it should show.
import { host, econText } from '../net/host.js';
import { refusedPress } from '../core/guard.js';

const CSS = `
#gf-ui .gf-menubtn{position:absolute;top:10px;left:10px;width:40px;height:40px;border-radius:12px;border:0;background:var(--gf-panel,#1c2133cc);color:var(--gf-text,#fff);font:800 20px/1 system-ui,sans-serif;cursor:pointer;pointer-events:auto;display:none;box-shadow:0 2px 0 #0003}
#gf-ui .gf-menubtn:hover{filter:brightness(1.25)}
#gf-ui .gf-menubtn.gf-fsbtn{top:auto;left:auto;right:10px;bottom:10px;width:40px;height:40px;display:none;padding:0}#gf-ui .gf-fsbtn svg{width:20px;height:20px;display:block;margin:auto}
#gf-ui .gf-goal{position:absolute;top:58px;left:50%;transform:translateX(-50%);max-width:min(560px,70vw);padding:4px 14px;border-radius:999px;background:#0006;font-size:14px;font-weight:600;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none}
#gf-ui .gf-toasts{top:92px}
#gf-ui .gf-me{position:absolute;left:12px;bottom:12px;display:none;flex-direction:column;gap:6px;min-width:210px;max-width:280px;padding:10px 12px;border-radius:16px;background:var(--gf-panel,#1c2133cc);box-shadow:0 4px 18px #0004}
#gf-ui .gf-me.on{display:flex}
#gf-ui .gf-me-name{display:flex;align-items:center;gap:7px;font-size:15px;font-weight:800}
#gf-ui .gf-me-name i{width:12px;height:12px;border-radius:50%;box-shadow:0 0 0 2px #0005}
#gf-ui .gf-hp{display:flex;align-items:center;gap:8px}
#gf-ui .gf-hp-ico{font-size:15px;line-height:1;color:var(--hp,#ff5e6c);filter:drop-shadow(0 1px 0 #0008)}
#gf-ui .gf-hp-pips{display:flex;gap:4px;flex:1}
#gf-ui .gf-hp-pips u{flex:1;height:14px;border-radius:4px;background:var(--hp,#ff5e6c);box-shadow:inset 0 -3px 0 #0003;transition:background .2s,opacity .2s}
#gf-ui .gf-hp-pips u.off{background:#ffffff26;box-shadow:none}
#gf-ui .gf-hp-bar{flex:1;height:14px;border-radius:7px;background:#ffffff26;overflow:hidden;position:relative}
#gf-ui .gf-hp-bar u{position:absolute;inset:0 auto 0 0;background:#fff;transition:width .35s ease-in .3s}
#gf-ui .gf-hp-bar b{position:absolute;inset:0 auto 0 0;background:var(--hp,#ff5e6c);box-shadow:inset 0 -3px 0 #0003}
#gf-ui .gf-hp-num{font-size:13px;font-variant-numeric:tabular-nums;min-width:42px;text-align:right;opacity:.9}
#gf-ui .gf-hp.hit{animation:gf-shake .28s}
@keyframes gf-shake{25%{transform:translateX(-3px)}50%{transform:translateX(3px)}75%{transform:translateX(-2px)}}
#gf-ui .gf-status{align-self:flex-start;padding:3px 10px;border-radius:999px;font-size:13px;font-weight:700;display:none}
#gf-ui .gf-status.down{display:block;background:#ff5e6c;color:#fff}
#gf-ui .gf-status.out{display:block;background:#2b2f3a;color:#fff;box-shadow:inset 0 0 0 1.5px #ff5e6c}
#gf-ui .gf-status.safe{display:block;background:#3ddc84;color:#0b2a17}
#gf-ui .gf-lines{display:flex;flex-direction:column;gap:5px}
#gf-ui .gf-line{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700}
#gf-ui .gf-line em{font-style:normal;opacity:.8;font-weight:600;min-width:64px}
#gf-ui .gf-line span{flex:1;height:8px;border-radius:4px;background:#ffffff26;overflow:hidden}
#gf-ui .gf-line span u{display:block;height:100%;background:var(--c,var(--gf-accent,#ff7a59));transition:width .2s}
#gf-ui .gf-line b{font-variant-numeric:tabular-nums}
#gf-ui .gf-line.chip b{padding:2px 9px;border-radius:999px;background:var(--c,#ffffff26);color:#fff;text-shadow:0 1px 0 #0006}
#gf-ui .gf-econ .gf-line em{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#gf-ui .gf-econ .gf-line b{flex:0 1 auto;max-width:60%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}
#gf-ui .gf-me .gf-meters{position:static;gap:5px}
#gf-ui .gf-me .gf-meter{display:flex;align-items:center;gap:8px;background:transparent;padding:0;min-width:0;border-radius:0}
#gf-ui .gf-me .gf-meter b{display:inline;font-size:13px;font-weight:600;opacity:.8;min-width:64px}
#gf-ui .gf-me .gf-meter span{flex:1;height:8px}
#gf-ui .gf-bossbar{position:absolute;top:96px;left:50%;transform:translateX(-50%);width:min(620px,72vw);display:none;flex-direction:column;align-items:center;gap:4px}
#gf-ui .gf-bossbar.on{display:flex}
#gf-ui .gf-bossbar i{font-style:normal;font-size:17px;font-weight:900;letter-spacing:.04em;text-shadow:0 2px 0 #000a,0 0 10px #0008}
#gf-ui .gf-bossbar span{position:relative;width:100%;height:16px;border-radius:8px;background:#000b;box-shadow:0 0 0 2px #000d,0 4px 14px #0006;overflow:hidden}
#gf-ui .gf-bossbar span u{position:absolute;inset:0 auto 0 0;background:#fff;transition:width .45s ease-in .35s}
#gf-ui .gf-bossbar span b{position:absolute;inset:0 auto 0 0;background:var(--c,#ff5a4a);box-shadow:inset 0 -4px 0 #0003}
#gf-ui .gf-bossbar span em{position:absolute;top:0;bottom:0;width:2px;background:#000c}
#gf-ui .gf-bossbar.hit span{box-shadow:0 0 0 2px #fff,0 4px 14px #0006}
#gf-ui .gf-vig{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .35s;background:radial-gradient(ellipse at center,transparent 55%,#ff1e3c66 100%)}
#gf-ui .gf-vig.hit{opacity:1;transition:opacity .05s}
#gf-ui .gf-vig.low{animation:gf-low 1.4s ease-in-out infinite}
@keyframes gf-low{0%,100%{opacity:.25}50%{opacity:.7}}
@media (max-width:640px){#gf-ui .gf-me{left:8px;bottom:auto;top:84px;min-width:170px;padding:7px 9px}#gf-ui .gf-goal{top:50px;font-size:12px;max-width:calc(100vw - 24px)}#gf-ui .gf-menubtn{top:8px;left:8px;width:36px;height:36px}}
`;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const kebab = s => s.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
const r2 = v => Math.round(v * 100) / 100;
const cap = t => (t ? t[0].toUpperCase() + t.slice(1) : t);
const ORD = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** A mechanic's value as the mechanic reads it: its slot (Studio overrides) when it has one, else its params. */
function mv(ctx, m, key, fallback) {
  const sid = `mechanic.${m.id}.${kebab(key)}`;
  try { if (ctx.assets?.has?.(sid)) return ctx.assets.value(sid, m.params?.[key] ?? fallback); } catch {}
  return m.params?.[key] ?? fallback;
}

/**
 * The widgets a game's mechanics call for, in card order. Each reader returns what the HUD should show now, for the
 * local player: { value, max } (a bar), { text } (a line), or null (nothing to show this frame). need: the widget is
 * part of the game's HUD whenever the round is on (verify check 21 holds the page to it).
 */
export function hudPlan(ctx) {
  const plan = [], M = id => { const m = ctx.mechanics?.get?.(id); return m && !m.standin ? m : null; };
  const me = () => ctx.me;
  const health = M('health'), prj = M('projectile'), paint = M('paint'), carry = M('carry'), race = M('race'), tag = M('tag');
  const teams = M('teams'), waves = M('waves'), station = M('station');
  const melee = M('melee'), levels = M('levels'), boss = M('boss'), loot = M('loot');
  if (health && (mv(ctx, health, 'hp', 3) ?? 0) > 0) {
    plan.push({ id: 'health', kind: 'health', from: 'health', need: true, label: mv(ctx, health, 'label', 'Health') || 'Health', color: mv(ctx, health, 'color', '#ff5e6c'),
      read: () => ({ value: Math.max(0, health.hpOf(me()) ?? 0), max: health.maxHp?.() ?? mv(ctx, health, 'hp', 3) }) });
  }
  if (health || ctx.fair?.on) {
    plan.push({ id: 'status', kind: 'status', from: health ? 'health' : 'fair', need: false,
      read: () => {
        const p = me(); if (!p) return null;
        const f = ctx.fair?.observe?.(p) ?? {};
        if (p.alive === false) return { state: 'out', text: 'Out' };
        if (f.down || health?.isDown?.(p)) return { state: 'down', text: 'Knocked down' };
        if (f.protected) return { state: 'safe', text: 'Protected' };
        return null;
      } });
  }
  if (prj && mv(ctx, prj, 'kind', 'discrete') === 'continuous' && (mv(ctx, prj, 'streamTank', 0) ?? 0) > 0) {
    plan.push({ id: 'tank', kind: 'bar', from: 'projectile', need: true, label: ctx.config?.text?.tank || 'Tank', color: mv(ctx, prj, 'color', null),
      read: () => ({ value: r2(prj.tankOf(me()) ?? 0), max: 1 }) });
  }
  if (paint) {
    plan.push({ id: 'paint', kind: 'bar', from: 'paint', need: true, label: ctx.config?.text?.paint || (mv(ctx, paint, 'by', 'player') === 'team' ? 'Team ground' : 'Your ground'), color: null, pct: true,
      read: () => ({ value: r2(paint.coverageOf(me()) ?? 0), max: 1 }) });
  }
  if (teams) {
    plan.push({ id: 'team', kind: 'chip', from: 'teams', need: true, label: 'Team',
      read: () => { const t = teams.teamOf(me()); return t < 0 ? null : { text: teams.nameOf(t), color: teams.colorOf(t) }; } });
  }
  if (tag) {
    plan.push({ id: 'tag', kind: 'chip', from: 'tag', need: true, label: 'You are',
      read: () => (tag.isIt(me()) ? { text: ctx.config?.text?.it || 'It!', color: mv(ctx, tag, 'color', '#ff5e6c') } : { text: ctx.config?.text?.notIt || 'Not it', color: '#ffffff26' }) });
  }
  if (race) {
    plan.push({ id: 'race', kind: 'line', from: 'race', need: true, label: 'Race',
      read: () => { const r = race.progress(me()); if (!r) return null; const laps = mv(ctx, race, 'laps', 1);
        return { text: r.done ? `Finished ${ORD(r.place)}` : `Lap ${Math.min(laps, r.lap + 1)}/${laps}`, value: r2(r.fraction ?? 0), max: 1 }; } });
  }
  if (carry) {
    plan.push({ id: 'holding', kind: 'line', from: 'carry', need: false, label: 'Holding',
      read: () => { const n = carry.heldCount?.(me()) ?? 0; if (!n) return null; const h = carry.held(me()); return { text: `${String(h?.prop ?? 'item').replace(/[-_]/g, ' ')}${n > 1 ? ` ×${n}` : ''}` }; } });
  }
  if (waves) {
    plan.push({ id: 'waves', kind: 'line', from: 'waves', need: true, label: 'Wave',
      read: () => { const w = waves.state(); return { text: `${w.wave || 1}${mv(ctx, waves, 'maxWaves', 0) ? `/${mv(ctx, waves, 'maxWaves', 0)}` : ''} · ${w.alive} left`, wave: w.wave, alive: w.alive }; } });
  }
  if (levels) {
    plan.push({ id: 'level', kind: 'line', from: 'levels', need: true, label: 'Level',
      read: () => { const s = levels.state(); const open = s.phase === 'open' || s.phase === 'travel';
        return { text: `${s.level + 1}/${s.count}${s.boss ? ' · Boss' : ''} · ${open ? (mv(ctx, levels, 'openText', 'Portal open') || 'Portal open') : `${s.left} left`}`, level: s.level + 1, count: s.count, open, left: s.left }; } });
  }
  if (loot) {
    plan.push({ id: 'coins', kind: 'line', from: 'loot', need: true, label: mv(ctx, loot, 'label', 'Coins') || 'Coins',
      read: () => { const n = loot.coinsOf(me()) ?? 0; return { text: String(n), value: n }; } });
  }
  if (melee) {
    plan.push({ id: 'weapon', kind: 'chip', from: 'melee', need: false, label: 'Weapon',
      read: () => { const w = melee.weaponOf(me()); return w ? { text: w.name, color: melee.rarityColor?.(w.rarity) ?? null, rarity: w.rarity } : null; } });
  }
  if (boss) {
    plan.push({ id: 'boss', kind: 'bossbar', from: 'boss', need: false, label: 'Boss', color: mv(ctx, boss, 'barColor', '#ff5a4a'),
      read: () => { const s = boss.state(); return s.active && !s.dead ? { text: s.name, value: Math.max(0, s.hp), max: s.max, phase: s.phase, phases: s.phases } : null; } });
  }
  if (station && (mv(ctx, station, 'quota', 0) ?? 0) > 0) {
    plan.push({ id: 'quota', kind: 'bar', from: 'station', need: true, label: mv(ctx, station, 'quotaLabel', 'Done') || 'Done', color: null, count: true,
      read: () => { const q = station.quota(); return { value: q.done, max: q.needed }; } });
  }
  return plan;
}

export function createHud(ctx, ui, { onMenu = () => {} } = {}) {
  const style = el('style'); style.textContent = CSS; document.head.append(style);
  const root = ui.root;
  const vig = el('div', 'gf-vig');
  const btn = el('button', 'gf-menubtn', '☰'); btn.id = 'gf-menu-button'; btn.title = 'Menu (Esc)'; btn.setAttribute('aria-label', 'Menu');
  btn.addEventListener('click', e => { e.stopPropagation(); if (refusedPress(e, 'menu button (#gf-menu-button)')) return; onMenu(); });
  // full screen: only where the frame allows it and no /play page hosts the game (that page has its own button). In a
  // post on X the card is small and the mouse can't be locked; full screen keeps the cursor on the game.
  const FS_IN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  const FS_OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
  const fsBtn = el('button', 'gf-menubtn gf-fsbtn'); fsBtn.id = 'gf-fullscreen'; fsBtn.title = 'Full screen'; fsBtn.setAttribute('aria-label', 'Full screen');
  let framed = false; try { framed = window.top !== window; } catch { framed = true; }
  const fsOffered = () => !!document.fullscreenEnabled && framed && !host.present && !ctx.input?.touch;
  const fsOn = () => !!document.fullscreenElement;
  const fsDraw = () => { fsBtn.innerHTML = fsOn() ? FS_OUT : FS_IN; fsBtn.title = fsOn() ? 'Leave full screen' : 'Full screen'; };
  fsDraw(); document.addEventListener('fullscreenchange', fsDraw);
  fsBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (refusedPress(e, 'full-screen button (#gf-fullscreen)')) return;
    const r = fsOn() ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    r?.catch?.(err => console.warn('full screen:', err?.message ?? err));
  });
  const goal = el('div', 'gf-goal'); goal.id = 'gf-goal';
  const card = el('div', 'gf-me'); card.id = 'gf-hud';
  const name = el('div', 'gf-me-name'), dot = el('i'), nameText = el('span'); name.append(dot, nameText);
  const hp = el('div', 'gf-hp'); hp.dataset.widget = 'health';
  const status = el('div', 'gf-status'); status.dataset.widget = 'status';
  const lines = el('div', 'gf-lines');
  const econ = el('div', 'gf-lines gf-econ'); econ.id = 'gf-econ-hud'; econ.dataset.where = 'hud';
  card.append(name, hp, status, lines);
  // the economy's HUD lines: drawn again whenever the page says something (gf:host, gf:economy), never each frame
  function drawEcon() {
    const rowsOut = [];
    for (const a of host.econAt?.('hud') ?? []) {
      const v = host.econValue?.(a.id); if (!v) continue;      // nothing to say until the page's state has it
      const row = el('div', 'gf-line'); row.dataset.econ = a.id; row.dataset.kind = a.kind;
      row.append(el('em', null, a.label), el('b', null, econText(v))); rowsOut.push(row);
    }
    econ.replaceChildren(...rowsOut);
    econ.style.display = rowsOut.length ? '' : 'none';
  }
  host.onChange?.(drawEcon); drawEcon();
  // the boss's bar across the top (the boss mechanic)
  const bossBar = el('div', 'gf-bossbar'); bossBar.id = 'gf-bossbar'; bossBar.dataset.widget = 'boss';
  const bossName = el('i'), bossTrack = el('span'), bossLag = el('u'), bossFill = el('b'); bossTrack.append(bossLag, bossFill); bossBar.append(bossName, bossTrack);
  let bossKey = '', bossLast = null, bossHitT = 0;
  // the rules' own meters live in the card (ui.meter)
  if (ui.parts?.meters) card.append(ui.parts.meters);
  card.append(econ);          // the page's lines last: the game's own state first
  root.prepend(vig);
  root.append(btn, fsBtn, goal, card, bossBar);

  let plan = null, goalText = '', goalSet = null, hpKey = '', lastHp = null, hitT = 0, built = false, teamCards = null, teamKey = '', cardOn = null;
  const rows = new Map();     // id → { box, fill, num } for bar/line/chip widgets
  const drawn = new Map();    // id → read(): a widget a runtime draws itself (drawnBy)

  function build() {
    plan = hudPlan(ctx); built = true;
    lines.replaceChildren(); rows.clear();
    for (const w of plan) {
      if (w.kind === 'health' || w.kind === 'status' || w.kind === 'bossbar') continue;
      const box = el('div', `gf-line${w.kind === 'chip' ? ' chip' : ''}`); box.dataset.widget = w.id;
      const lab = el('em', null, w.label), b = el('b'); let fill = null;
      if (w.kind === 'bar' || (w.kind === 'line' && w.id === 'race')) { const s = el('span'); fill = el('u'); s.append(fill); box.append(lab, s, b); if (w.color) box.style.setProperty('--c', w.color); }
      else box.append(lab, b);
      lines.append(box); rows.set(w.id, { box, fill, num: b, key: '' });
    }
    const h = plan.find(w => w.id === 'health');
    hp.style.display = h ? '' : 'none';
    if (h) { hp.style.setProperty('--hp', h.color || '#ff5e6c'); card.style.setProperty('--hp', h.color || '#ff5e6c'); }
    const hurtable = ctx.mechanics?.get?.('health');
    if (hurtable?.onHurt && !hurtable.standin) hurtable.onHurt(({ player, delta }) => { if (player === ctx.me && delta < 0) hurt(); });
    // team health cards: each team's hit points summed over its members (the health mechanic's), in the team's colour
    const teams = ctx.mechanics?.get?.('teams'), hm = hurtable && !hurtable.standin ? hurtable : null;
    const want = ctx.config?.ui?.style?.widgets;
    teamCards = Array.isArray(want) && want.includes('team-cards') && teams && !teams.standin && hm && typeof ui.teams === 'function' && (hm.maxHp?.() ?? 0) > 0
      ? () => (teams.standings?.() ?? []).map(t => { const ms = (t.members ?? []).map(id => ctx.players?.get?.(id)).filter(Boolean);
        return { id: `t${t.team}`, name: t.name, color: t.color, value: ms.reduce((a, p) => a + Math.max(0, hm.hpOf(p) ?? 0), 0), max: Math.max(1, ms.length * hm.maxHp()) }; })
      : null;
  }
  function hurt() { hitT = 0.25; vig.classList.add('hit'); hp.classList.remove('hit'); void hp.offsetWidth; hp.classList.add('hit'); }

  function drawHealth(w) {
    const r = w.read(); if (!r) return;
    const v = Math.max(0, Math.round(r.value * 10) / 10), max = Math.max(1, r.max), key = `${v}/${max}`;
    if (key === hpKey) return; hpKey = key;
    hp.dataset.value = String(v); hp.dataset.max = String(max);
    hp.setAttribute('aria-label', `${w.label}: ${v} of ${max}`);
    if (max <= 10 && Number.isInteger(max)) {
      let pips = hp.querySelector('.gf-hp-pips');
      if (!pips || pips.children.length !== max) { hp.replaceChildren(el('span', 'gf-hp-ico', '♥')); pips = el('div', 'gf-hp-pips'); for (let i = 0; i < max; i++) pips.append(el('u')); hp.append(pips, el('span', 'gf-hp-num')); }
      [...pips.children].forEach((u, i) => u.classList.toggle('off', i >= Math.ceil(v - 1e-6)));
      hp.querySelector('.gf-hp-num').textContent = `${v}/${max}`;
    } else {
      let bar = hp.querySelector('.gf-hp-bar');
      if (!bar) { hp.replaceChildren(el('span', 'gf-hp-ico', '♥')); bar = el('div', 'gf-hp-bar'); bar.append(el('u'), el('b')); hp.append(bar, el('span', 'gf-hp-num')); }
      const pct = `${Math.max(0, Math.min(1, v / max)) * 100}%`; bar.firstChild.style.width = pct; bar.lastChild.style.width = pct;
      hp.querySelector('.gf-hp-num').textContent = `${Math.round(v)}/${max}`;
    }
    if (lastHp !== null && v < lastHp - 1e-6) hurt();
    lastHp = v;
    vig.classList.toggle('low', v > 0 && v / max <= 0.34);
  }

  function drawBoss(w, r, dt) {
    bossBar.classList.toggle('on', !!r);
    if (!r) { bossBar.dataset.value = ''; bossLast = null; return; }
    if (bossHitT > 0 && (bossHitT -= dt) <= 0) bossBar.classList.remove('hit');
    const key = `${r.text}|${r.value}|${r.max}|${r.phases}`; if (key === bossKey) return; bossKey = key;
    if (bossName.textContent !== r.text) bossName.textContent = r.text;
    const pct = `${Math.max(0, Math.min(1, r.value / (r.max || 1))) * 100}%`;
    bossFill.style.width = pct; bossLag.style.width = pct; bossBar.style.setProperty('--c', w.color || '#ff5a4a');
    bossBar.dataset.value = String(r.value); bossBar.dataset.max = String(r.max); bossBar.dataset.phase = String(r.phase ?? 0);
    // the phase marks (thresholds) on the bar
    const marks = (ctx.mechanics?.get?.('boss')?.params?.phases ?? []).filter(x => x > 0 && x < 1);
    if (bossTrack.querySelectorAll('em').length !== marks.length) { bossTrack.querySelectorAll('em').forEach(e => e.remove()); for (const m of marks) { const e = el('em'); e.style.left = `${m * 100}%`; bossTrack.append(e); } }
    if (bossLast !== null && r.value < bossLast - 1e-6) { bossBar.classList.add('hit'); bossHitT = 0.14; }
    bossLast = r.value;
  }

  const api = {
    /** rules.js: set the goal line (null gives back the game's own). */
    goal(t) { goalSet = t === null || t === undefined ? null : cap(String(t).trim()); },
    get goalText() { return goalSet ?? goalText; },
    /** Every frame. phase: the round's phase; on: the HUD shows (playing, alone or live; never over a menu). */
    update(dt, { phase, covered }) {
      if (!built && ctx.me) build();
      const playing = phase === 'playing' || phase === 'countdown';
      const on = playing && !covered;
      btn.style.display = playing ? 'block' : 'none';
      fsBtn.style.display = playing && fsOffered() ? 'block' : 'none';
      card.classList.toggle('on', on && !!ctx.me);
      const g = api.goalText;
      goal.style.display = on && g ? 'block' : 'none'; if (goal.textContent !== g) goal.textContent = g;
      if (hitT > 0 && (hitT -= dt) <= 0) vig.classList.remove('hit');
      const showCard = on && !!ctx.me;
      if (showCard !== cardOn) { cardOn = showCard; ui.place?.(); }
      if (teamCards) {
        if (on) { let rows = []; try { rows = teamCards(); } catch {} const k = JSON.stringify(rows); if (k !== teamKey) { teamKey = k; ui.teams(rows); } }
        else if (teamKey) { teamKey = ''; ui.teams(null); }
      }
      if (!on || !plan || !ctx.me) { if (!on) { vig.classList.remove('low'); bossBar.classList.remove('on'); } return; }
      const me = ctx.me;
      if (nameText.textContent !== me.name) nameText.textContent = me.name;
      if (dot.style.background !== me.color) dot.style.background = me.color;
      for (const w of plan) {
        let r = null; try { r = w.read(); } catch (e) { r = null; }
        if (w.kind === 'health') { drawHealth(w); continue; }
        if (w.kind === 'bossbar') { drawBoss(w, r, dt); continue; }
        if (w.kind === 'status') {
          let text = r?.text ?? '', cls = r?.state ?? '';
          if (cls === 'out') { const s = ctx.mechanics?.get?.('health')?.respawnIn?.(me); text = Number.isFinite(s) && s > 0 ? `Out · back in ${Math.ceil(s)}` : 'Out'; }
          if (status.textContent !== text) status.textContent = text;
          const c = `gf-status ${cls === 'safe' ? 'safe' : cls}`; if (status.className !== c) status.className = c;
          status.dataset.state = cls;
          continue;
        }
        const row = rows.get(w.id); if (!row) continue;
        row.box.style.display = r ? '' : 'none';
        if (!r) { row.box.dataset.value = ''; continue; }
        const key = JSON.stringify(r); if (key === row.key) continue; row.key = key;
        if (row.fill && Number.isFinite(r.value)) row.fill.style.width = `${Math.max(0, Math.min(1, r.value / (r.max || 1))) * 100}%`;
        row.num.textContent = r.text ?? (w.pct ? `${Math.round((r.value / (r.max || 1)) * 100)}%` : w.count ? `${r.value}/${r.max}` : `${Math.round((r.value / (r.max || 1)) * 100)}%`);
        if (r.color) row.box.style.setProperty('--c', r.color);
        row.box.dataset.value = Number.isFinite(r.value) ? String(r.value) : (r.text ?? '');
      }
    },
    setGoal(t) { goalText = cap(String(t ?? '').trim()); },
    /** The kit's own elements here, and whether the kit shows each now (kit/core/guard.js watchKit keeps them). */
    kitItems: () => [
      { el: card, name: "the HUD's player card (#gf-hud)", want: card.classList.contains('on'), cover: true },
      { el: goal, name: 'the goal line (#gf-goal)', want: goal.style.display === 'block' },
      { el: btn, name: 'the menu button (#gf-menu-button)', want: btn.style.display === 'block', cover: true },
      { el: fsBtn, name: 'the full-screen button (#gf-fullscreen)', want: fsBtn.style.display === 'block', cover: true },
    ],
    /** The observation (verify check 21): what the page shows, and what the kit's state says it should. */
    /** verify check 24: whether the full-screen button is offered, shown, and the page is full screen. */
    fullscreen() {
      const r = fsBtn.getBoundingClientRect(), cs = getComputedStyle(fsBtn);
      const shown = fsBtn.isConnected && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 && r.width > 2 && r.height > 2 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
      return { offered: fsOffered(), shown, on: fsOn() };
    },
    /**
     * A widget a runtime (or a game) draws itself (forge's vitals, wave and purse; its CSS hides the card's own rows for
     * the same facts): read(): {node, shows} — the element a player finds it in, and what it says, in the shape of the
     * card's widget of that id ({value, max} for health; {wave, alive} for waves; {value, text} for coins). Measure 21
     * then reads that element instead of the hidden row; the truth stays the mechanic's.
     */
    drawnBy(id, read) { if (typeof read === 'function') drawn.set(String(id), read); },
    observe() {
      const seen = elx => {
        if (!elx || !elx.isConnected) return { shown: false, rect: null };
        const r = elx.getBoundingClientRect();
        const vis = typeof elx.checkVisibility === 'function' ? elx.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : elx.offsetParent !== null;
        const inView = r.width > 2 && r.height > 2 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
        return { shown: !!(vis && inView), rect: { x: r2(r.x), y: r2(r.y), w: r2(r.width), h: r2(r.height) } };
      };
      const widgets = (plan ?? []).map(w => {
        let truth = null; try { truth = w.read(); } catch (e) { truth = { error: String(e?.message ?? e) }; }
        const own = drawn.get(w.id); let o = null;
        if (own) { try { o = own(); } catch { o = null; } }
        if (o) return { id: w.id, kind: w.kind, from: w.from, need: w.need, label: w.label, by: 'runtime', ...seen(o.node), shows: JSON.parse(JSON.stringify(o.shows ?? {})), truth: truth ? JSON.parse(JSON.stringify(truth)) : null };
        const node = w.kind === 'health' ? hp : w.kind === 'status' ? status : w.kind === 'bossbar' ? bossBar : rows.get(w.id)?.box;
        const s = seen(node);
        const shows = w.kind === 'health' ? { value: Number(hp.dataset.value), max: Number(hp.dataset.max), text: hp.textContent }
          : w.kind === 'status' ? { state: status.dataset.state ?? '', text: status.textContent }
            : w.kind === 'bossbar' ? { value: bossBar.dataset.value ?? '', max: bossBar.dataset.max ?? '', text: bossName.textContent }
            : { value: node?.dataset.value ?? '', text: node?.querySelector('b')?.textContent ?? '' };
        return { id: w.id, kind: w.kind, from: w.from, need: w.need, label: w.label, ...s, shows, truth: truth ? JSON.parse(JSON.stringify(truth)) : null };
      });
      const economy = [...econ.children].map(r => ({ id: r.dataset.econ, label: r.querySelector('em')?.textContent ?? '', text: r.querySelector('b')?.textContent ?? '', ...seen(r) }));
      return { economy, card: seen(card), goal: { text: goal.textContent, ...seen(goal) }, menuButton: seen(btn), widgets, meters: [...(ui.parts?.meters?.children ?? [])].map(m => m.querySelector('b')?.textContent ?? '') };
    },
  };
  return api;
}
