// gf-forge's feel, the DOM side (track F; research/rust-engine/feel-targets.md), vendored into a game as gf/forge/feel.js
// (never edited there). The Rust core (forge-feel) decides what happens and when, on its 120 Hz steps; this draws the
// parts that are UI, on the shared HUD's layer (#gf-ui), in the "grim" theme's type and colours (gf/three/ui/theme.js;
// wave 2, track U: research/gf-forge/hud/DESIGN.md). No art: CSS custom properties and words from config/game.json → text.
//
//   damage numbers   pop at the hit and float up for about 0.8 s: white, or larger and gold with a small tag on a
//                    critical hit (moment 12); a word floats where debris launched an enemy (moment 11)
//   the combo        low in the centre: the multiplier (×1.1, ×1.2, …), the kills in it and its draining timer bar;
//                    a "×n" burst where the kill was (moment 12)
//   the red edge     the core's tint (+0.6 a hit, fading at 1.5 a second: target 10), edge-weighted: at full tint the
//                    red rises about +16 at the centre, +39 mid-screen and +50 at the edges (out of 255, moment 14)
//   low health       three stages at 15, 10 and 5% (the feel table): the edges darken and beat faster at each, a blood
//                    line frames the screen from the second, and the HUD's health says the stage in a word
//   the crosshair    a small cross in the middle, its gap the weapon's spread; a hit marker on each hit
//   the weapon       bottom right: its name and a large rounds counter, a reload bar and word, and the other weapons
//                    held, by key
//   the death recap  on the results after the local player died: what felled them and their last 8 s of hits (moment 19)
//
// Wave 2 (track U): it also makes the forge HUD (gf/forge/hud.js: health and stamina, the wave, score, coins, friends,
// banners, the touch buttons) and the forge sound side (gf/forge/sound.js: the night bed, the heartbeat, the wave's bell).
//
//   import { createFeel } from './gf/forge/feel.js';
//   const feel = createFeel(ctx);          // ctx.forge (the host), ctx.ui (its root), ctx.tables (names), ctx.input
//   feel.update(dt) every frame (after the host's tick); feel.observe() for verify; feel.recap() → the core's JSON
//   feel.touch() → {held, pressed}: the touch buttons' BTN bits for this frame's INPUT (the boot ORs them in)
//   feel.hud, feel.sound                    the HUD and the sound side (rules.js: feel.hud.coins(n))
//
// It reads the core's feel view every frame (forge.feel_view(): forge_feel::view::NAMES) and listens to the host's UI and
// custom events; it never writes the core's state but to tell it which input the local player uses (aim help on touch).
//
// Wave 4, a stream's viewer (CONTRACT §9b; `ctx.watching()`): the core's feel view is the watched player's (forge-core
// net.rs), so everything here shows what the streamer's own screen does, their numbers, their red edge, their
// crosshair, with no change in this file but the settings (theirs are their own copy's). What a viewer keeps of it on
// screen is the boot's list (gf/three/core/boot-forge.js).
import { createForgeHud } from './hud.js';
import { createForgeSound } from './sound.js';
import { aimOf } from './observe.js';

const CSS = `
#gf-ui{--gf-feel-serif:var(--gf-forge-serif,system-ui,sans-serif);--gf-feel-display:var(--gf-forge-display,system-ui,sans-serif);--gf-feel-ember:var(--gf-forge-accent,#ffb347);--gf-feel-bone:var(--gf-forge-bone,#fff);--gf-feel-dim:var(--g-dim,#d8ccae);--gf-feel-blood:var(--gf-forge-blood,#c8242c);--gf-feel-gold:#f6cb4c;--gf-feel-ts:0 1px 0 #000d,0 0 6px #000c,0 0 14px #0009}
#gf-ui .gf-feel-edge{position:absolute;inset:0;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center,rgba(255,24,32,.063) 0%,rgba(255,24,32,.153) 45%,rgba(255,24,32,.2) 75%,rgba(255,24,32,.26) 100%)}
#gf-ui .gf-feel-low{position:absolute;inset:0;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center,transparent 40%,rgba(120,0,8,.55) 100%)}
#gf-ui .gf-feel-low.s1{opacity:.5;animation:gf-feel-beat 1.1s ease-in-out infinite}
#gf-ui .gf-feel-low.s2{opacity:.78;animation:gf-feel-beat .85s ease-in-out infinite;box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--gf-feel-blood) 70%,transparent)}
#gf-ui .gf-feel-low.s3{opacity:1;animation:gf-feel-beat .6s ease-in-out infinite;box-shadow:inset 0 0 0 4px var(--gf-feel-blood),inset 0 0 110px 26px rgba(70,0,6,.62)}
@keyframes gf-feel-beat{0%,100%{filter:brightness(.8)}45%{filter:brightness(1.35)}}
#gf-ui .gf-feel-cross{position:absolute;left:50%;top:50%;width:0;height:0;display:none}
#gf-ui .gf-feel-cross i{position:absolute;left:0;top:0;background:var(--gf-cross,#fff);box-shadow:0 0 0 1px #000a;border-radius:1px;will-change:transform}
#gf-ui .gf-feel-cross i.h{width:7px;height:2px;top:-1px}
#gf-ui .gf-feel-cross i.v{width:2px;height:7px;left:-1px}
#gf-ui .gf-feel-cross b{position:absolute;left:-1px;top:-1px;width:2px;height:2px;background:var(--gf-cross,#fff);box-shadow:0 0 0 1px #000a}
#gf-ui .gf-feel-cross.dim{opacity:.4}
#gf-ui .gf-feel-cross u{position:absolute;width:9px;height:2px;background:#fff;opacity:0;transition:opacity .12s}
#gf-ui .gf-feel-cross.hit u{opacity:1;transition:none}
#gf-ui .gf-feel-num{position:absolute;left:0;top:0;font:800 22px/1 var(--gf-feel-serif);font-variant-numeric:lining-nums;color:#fff;text-shadow:0 2px 0 #000c,0 0 6px #000b;white-space:nowrap;will-change:transform,opacity}
#gf-ui .gf-feel-num.crit{font-size:33px;color:var(--gf-feel-gold);text-shadow:0 2px 0 #000c,0 0 12px #f08a2c88}
#gf-ui .gf-feel-num.crit small{display:block;margin-top:2px;font:700 10.5px/1 var(--gf-feel-serif);letter-spacing:.22em;text-transform:uppercase;color:#fbe7ae;text-align:center}
#gf-ui .gf-feel-num.word{font:700 15px/1 var(--gf-feel-serif);color:var(--gf-feel-dim);letter-spacing:.2em;text-transform:uppercase}
#gf-ui .gf-feel-num.burst{font:700 27px/1 var(--gf-feel-display);color:var(--gf-feel-ember)}
#gf-ui .gf-feel-combo{position:absolute;left:50%;bottom:max(96px,calc(env(safe-area-inset-bottom) + 86px));transform:translateX(-50%);display:none;flex-direction:column;align-items:center;gap:4px;text-shadow:var(--gf-feel-ts)}
#gf-ui .gf-feel-combo.on{display:flex}
#gf-ui .gf-feel-combo b{font:700 40px/.95 var(--gf-feel-display);font-variant-numeric:lining-nums;color:var(--gf-feel-ember)}
#gf-ui .gf-feel-combo em{font:600 11px/1 var(--gf-feel-serif);font-style:normal;letter-spacing:.2em;text-transform:uppercase;color:var(--gf-feel-dim)}
#gf-ui .gf-feel-combo span{width:128px;height:3px;background:#0009;box-shadow:0 0 0 1px #000b;overflow:hidden}
#gf-ui .gf-feel-combo span u{display:block;height:100%;background:var(--gf-feel-ember);transform-origin:0 50%;will-change:transform}
#gf-ui .gf-feel-combo.pop b{animation:gf-feel-pop .22s ease-out}
@keyframes gf-feel-pop{0%{transform:scale(1.45)}100%{transform:scale(1)}}
#gf-ui .gf-feel-ammo{position:absolute;right:max(16px,env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom));display:none;flex-direction:column;align-items:flex-end;gap:3px;text-shadow:var(--gf-feel-ts)}
#gf-ui:has(#gf-fullscreen[style*="block"]) .gf-feel-ammo{right:max(62px,calc(env(safe-area-inset-right) + 62px))}
#gf-ui .gf-feel-ammo.on{display:flex}
#gf-ui .gf-feel-held{display:flex;gap:12px;margin-bottom:5px;font:600 12px/1 var(--gf-feel-serif);letter-spacing:.06em;color:var(--gf-feel-dim)}
#gf-ui .gf-feel-held span{display:flex;align-items:center;gap:5px;opacity:.78;white-space:nowrap}
#gf-ui .gf-feel-held span.cur{opacity:1;color:var(--gf-feel-bone)}
#gf-ui .gf-feel-held kbd{display:inline-grid;place-items:center;min-width:15px;height:15px;font:700 10px/1 var(--gf-feel-serif);font-variant-numeric:lining-nums;box-shadow:inset 0 0 0 1px currentColor;border-radius:1px;padding:0 2px}
#gf-ui .gf-feel-held span.cur kbd{background:var(--gf-feel-bone);color:#0b0d10;box-shadow:none}
#gf-ui .gf-feel-ammo em{font:600 11px/1 var(--gf-feel-serif);font-style:normal;letter-spacing:.2em;text-transform:uppercase;color:var(--gf-feel-dim)}
#gf-ui .gf-feel-ammo b{font:800 58px/.82 var(--gf-feel-serif);font-variant-numeric:lining-nums tabular-nums;letter-spacing:-.015em;color:var(--gf-feel-bone)}
#gf-ui .gf-feel-ammo b small{font:600 20px/1 var(--gf-feel-serif);letter-spacing:0;color:var(--gf-feel-dim);margin-left:3px}
#gf-ui .gf-feel-ammo.empty b{color:color-mix(in srgb,var(--gf-feel-blood) 70%,#fff)}
#gf-ui .gf-feel-ammo.melee b{font:700 30px/1 var(--gf-feel-display);letter-spacing:.02em}
#gf-ui .gf-feel-ammo.melee em{display:none}
#gf-ui .gf-feel-ammo span.bar{width:120px;height:3px;margin-top:5px;background:#0009;box-shadow:0 0 0 1px #000b;overflow:hidden;visibility:hidden}
#gf-ui .gf-feel-ammo span.bar.on{visibility:visible}
#gf-ui .gf-feel-ammo span.bar u{display:block;height:100%;background:var(--gf-feel-ember);transform-origin:0 50%;will-change:transform}
#gf-ui .gf-feel-ammo i{font:700 10.5px/1 var(--gf-feel-serif);font-style:normal;letter-spacing:.2em;text-transform:uppercase;color:var(--gf-feel-ember);visibility:hidden}
#gf-ui .gf-feel-ammo.reloading i{visibility:visible}
#gf-ui .gf-feel-ammo.reloading b{opacity:.45}
#gf-ui .gf-feel-recap{margin:14px 0 2px;padding:12px 0 0;border-top:1px solid var(--g-rule,#ffffff33);text-align:left;font:500 13.5px/1.35 var(--gf-feel-serif);max-width:440px}
#gf-ui .gf-feel-recap h2{margin:0 0 2px;font:600 10.5px/1.3 var(--gf-feel-serif);letter-spacing:.2em;text-transform:uppercase;color:var(--gf-feel-blood)}
#gf-ui .gf-feel-recap strong{display:block;font:700 19px/1.15 var(--gf-feel-display);color:var(--gf-feel-bone)}
#gf-ui .gf-feel-recap p{margin:2px 0 8px!important;color:var(--gf-feel-dim)}
#gf-ui .gf-feel-recap ol{list-style:none;margin:0;padding:0;max-height:132px;overflow:auto;scrollbar-width:thin}
#gf-ui .gf-feel-recap li{display:flex;gap:10px;padding:1px 0;font-variant-numeric:lining-nums tabular-nums;color:var(--gf-feel-dim)}
#gf-ui .gf-feel-recap li span:first-child{flex:none;width:52px;color:var(--gf-feel-ember)}
#gf-ui .gf-feel-recap li span:last-child{margin-left:auto;color:var(--gf-feel-bone)}
#gf-ui.gf-fh-touch .gf-feel-num.crit small,#gf-ui.gf-fh-touch .gf-feel-combo em,#gf-ui.gf-fh-touch .gf-feel-held kbd,#gf-ui.gf-fh-touch .gf-feel-ammo em,#gf-ui.gf-fh-touch .gf-feel-ammo i,#gf-ui.gf-fh-touch .gf-feel-recap h2{font-size:12px;letter-spacing:.1em}
@media (orientation:landscape){
#gf-ui.gf-fh-touch .gf-feel-ammo{left:calc(50% + 14px);right:auto;bottom:max(8px,env(safe-area-inset-bottom));flex-direction:row;align-items:baseline;gap:9px}
#gf-ui.gf-fh-touch .gf-feel-ammo b{order:1;font-size:38px}
#gf-ui.gf-fh-touch .gf-feel-ammo b small{font-size:15px}
#gf-ui.gf-fh-touch .gf-feel-ammo em{order:2}
#gf-ui.gf-fh-touch .gf-feel-ammo i{order:3;display:none}
#gf-ui.gf-fh-touch .gf-feel-ammo.reloading em{display:none}
#gf-ui.gf-fh-touch .gf-feel-ammo.reloading i{display:inline}
#gf-ui.gf-fh-touch .gf-feel-ammo span.bar{position:absolute;left:0;bottom:-5px;width:112px;margin:0}
#gf-ui.gf-fh-touch .gf-feel-ammo.melee b{font-size:22px}
#gf-ui.gf-fh-touch .gf-feel-combo{bottom:max(62px,calc(env(safe-area-inset-bottom) + 56px));gap:3px}
#gf-ui.gf-fh-touch .gf-feel-combo b{font-size:30px}
}
@media (orientation:portrait){
#gf-ui.gf-fh-touch .gf-feel-ammo{right:max(12px,env(safe-area-inset-right));top:calc(max(9px,env(safe-area-inset-top)) + 78px);bottom:auto}
#gf-ui.gf-fh-touch .gf-feel-ammo b{font-size:40px}
#gf-ui.gf-fh-touch .gf-feel-ammo b small{font-size:15px}
#gf-ui.gf-fh-touch .gf-feel-ammo.melee b{font-size:22px}
#gf-ui.gf-fh-touch .gf-feel-combo{bottom:max(312px,calc(env(safe-area-inset-bottom) + 300px))}
#gf-ui.gf-fh-touch .gf-feel-combo b{font-size:32px}
}
#gf-ui.gf-fh-touch .gf-feel-held{display:none}
#gf-ui .gf-feel-recap h2.dim{color:var(--gf-feel-dim)}
@media (max-width:640px){#gf-ui .gf-feel-num{font-size:19px}#gf-ui .gf-feel-num.crit{font-size:27px}}
@media (min-width:1500px) and (min-height:880px){#gf-ui:not(.gf-fh-touch) .gf-feel-ammo,#gf-ui:not(.gf-fh-touch) .gf-feel-combo{zoom:1.3}#gf-ui .gf-feel-num{font-size:27px}#gf-ui .gf-feel-num.crit{font-size:40px}}
`;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const r2 = v => Math.round(v * 100) / 100;
const fmt = (t, v = {}) => String(t ?? '').replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined && v[k] !== null ? String(v[k]) : ''));
/** The custom event kinds forge-feel emits (forge_feel::ev); the core also says them (forge.feel_protocol()). */
export const FEEL_EVENT = { FLASH: 32, TRACER: 33, SEVER: 34, KNOCK: 35, LABEL: 36, WEAPON: 37 };
export const FEEL_OP = { LOADOUT: 65, GIVE: 66, EQUIP: 67, DUMMY: 68, PICKUP: 69, SETTINGS: 70, REFILL: 71, RESET: 72, CLEAR: 73 };

/** World point → CSS pixels on the screen for the drawn camera ({x, y, z, yaw, pitch, fov: vertical °}); null behind. */
export function project(eye, p, w, h) {
  const sy = Math.sin(eye.yaw), cy = Math.cos(eye.yaw), sp = Math.sin(eye.pitch), cp = Math.cos(eye.pitch);
  const f = [-sy * cp, sp, -cy * cp], r = [cy, 0, -sy], u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const d = [p[0] - eye.x, p[1] - eye.y, p[2] - eye.z];
  const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  if (z < 0.05) return null;
  const tv = Math.tan(((eye.fov || 68) * Math.PI) / 360), th = tv * (w / Math.max(1, h));
  const x = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / (z * th), y = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / (z * tv);
  return { x: ((x + 1) / 2) * w, y: ((1 - y) / 2) * h, z };
}

export function createFeel(ctx, { host = ctx.forge, root = ctx.ui?.root } = {}) {
  const forge = host?.forge;
  if (!host || !forge?.feel_view || !root) return null;
  if (!document.getElementById('gf-feel-css')) { const s = el('style'); s.id = 'gf-feel-css'; s.textContent = CSS; document.head.append(s); }
  const T = ctx.config?.text ?? {};
  const W = { reloading: T.reloading ?? 'Reloading', kills: T.kills ?? '{n} felled', critical: T.critical ?? 'critical' };
  const names = forge.feel_view_names().split(',');
  const F = Object.fromEntries(names.map((n, i) => [n, i]));
  const edge = el('div', 'gf-feel-edge'), low = el('div', 'gf-feel-low');
  const cross = el('div', 'gf-feel-cross');
  const arms = ['h', 'h', 'v', 'v'].map(c => el('i', c));
  let lastGap = null;
  const marks = [0, 1, 2, 3].map(() => el('u'));
  cross.append(...arms, el('b'), ...marks);
  const nums = el('div', 'gf-feel-nums'); nums.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
  const combo = el('div', 'gf-feel-combo'), comboN = el('b'), comboK = el('em'), comboBar = el('span'), comboFill = el('u');
  comboBar.append(comboFill); combo.append(comboN, comboK, comboBar);
  const ammo = el('div', 'gf-feel-ammo'), heldRow = el('div', 'gf-feel-held'), ammoName = el('em'), ammoN = el('b'), reloadBar = el('span', 'bar'), reloadFill = el('u'), reloadWord = el('i', null, W.reloading);
  reloadBar.append(reloadFill); ammo.append(heldRow, ammoName, ammoN, reloadBar, reloadWord);
  // behind everything else of the HUD: the edge and the low-health layers first
  root.prepend(low); root.prepend(edge);
  root.append(nums, cross, combo, ammo);
  // the forge HUD (health, the wave, score, coins, friends, banners, touch) and the sound side
  let hud = null, sound = null;
  try { hud = createForgeHud(ctx, { host }); } catch (e) { console.error(e); }
  try { sound = createForgeSound(ctx, { host }); } catch (e) { console.error(e); }
  const live = [];                     // floating words: {e, x, y, z (world), t, life, rise}
  let view = new Float32Array(names.length), hitMark = 0, lastCombo = 0, lastAmmoKey = '', lastHeldKey = '', lastSettings = null, recapShown = false;
  const weaponRow = row => ctx.tables?.weapons?.[row] ?? null;
  const weaponName = row => weaponRow(row)?.name || weaponRow(row)?.id || '';
  const local = () => view[F.player] || 0;
  const offs = [];
  // numbers and words: anchored in the world, floating up
  const float = (text, at, cls, life = 0.85, small = null) => {
    const e = el('div', `gf-feel-num ${cls}`, text);
    if (small) e.append(el('small', null, small));
    nums.append(e);
    live.push({ e, at: [...at], t: 0, life, jitter: (Math.random() - 0.5) * 18 });
    if (live.length > 40) { const o = live.shift(); o.e.remove(); }
  };
  offs.push(host.on('ui', e => {
    if (e.player && e.player !== local()) return;
    if (e.what === 'damage') {
      const v = Math.round(e.value);
      float(String(v), e.at, e.crit ? 'crit' : '', e.crit ? 1.0 : 0.8, e.crit ? W.critical : null);
      hitMark = 0.12;
    } else if (e.what === 'combo' && e.count > 0) {
      float(`×${e.count}`, [e.at[0], e.at[1] + 1.2, e.at[2]], 'burst', 0.7);
    }
  }));
  offs.push(host.on(`custom-${FEEL_EVENT.LABEL}`, e => {
    const f32 = new Float32Array(new Uint32Array(e.words).buffer);
    const player = e.words[4];
    if (player && player !== local()) return;
    float(host.name(e.words[0]) || '', [f32[1], f32[2], f32[3]], 'word', 1.1);
  }));
  // every hit body's flash (forge_feel::ev::FLASH), counted per target: verify reads that hits flash
  const flashes = new Map();
  offs.push(host.on(`custom-${FEEL_EVENT.FLASH}`, e => flashes.set(e.words[0], (flashes.get(e.words[0]) ?? 0) + 1)));
  // the staged moment (verify check 16, ?gf-demo=feel.hit): a target 6 m in front of the player with the game's first
  // enemy's hit points (60 with none), standing again a second after each kill
  const demo = new URLSearchParams(location.search).get('gf-demo') === 'feel.hit' ? { placed: false, at: null } : null;
  // (it stands where the line from the eyes to its chest is clear of the world's boxes: on some seeds a brazier or a
  // grave stood straight ahead of the first spawn, and every shot of the check hit it)
  const clearAt = me => {
    const boxes = (ctx.assets?.config?.('world')?.colliders ?? []).filter(b => b.kind !== 'ground');
    const eye = [me.x, me.y + 1.75, me.z];
    for (const turn of [0, 0.25, -0.25, 0.5, -0.5, 0.8, -0.8]) for (const d of [6, 5, 7]) {
      const y = me.yaw + turn, at = [me.x - Math.sin(y) * d, me.y, me.z - Math.cos(y) * d];
      const to = [at[0] - eye[0], at[1] + 1.15 - eye[1], at[2] - eye[2]], len = Math.hypot(...to);
      const a = aimOf(eye, to.map(v => v / len), { colliders: boxes, far: len });
      if (a.hit !== 'world') return { at, yaw: y };
    }
    return { at: [me.x - Math.sin(me.yaw) * 6, me.y, me.z - Math.cos(me.yaw) * 6], yaw: me.yaw };
  };
  const stageDemo = () => {
    if (!demo || demo.placed || ctx.round?.phase !== 'playing') return;
    const me = host.players().find(p => p.local); if (!me) return;
    const { at, yaw } = clearAt(me);
    const hp = Number(ctx.tables?.enemies?.[0]?.health) || 60;
    host.cmd.raw(FEEL_OP.DUMMY, [], [...at, yaw + Math.PI, hp, 1]);
    demo.placed = true; demo.at = at; demo.hp = hp;
  };
  // aim help: tell the core which input the local player uses (1 touch, 2 mouse)
  // (a stream's viewer, wave 4: the view's player is the one being watched, whose settings are their own copy's)
  const settings = () => {
    const id = local(); if (!id || ctx.watching?.()) return;
    const mode = ctx.input?.touch || matchMedia?.('(pointer: coarse)')?.matches ? 1 : 2;
    const key = `${id}:${mode}`;
    if (key === lastSettings) return;
    lastSettings = key;
    host.cmd.raw(FEEL_OP.SETTINGS, [id, mode]);
  };
  const recapPanel = () => {
    const card = root.querySelector('.gf-card[data-view="results"]');
    if (!card || card.querySelector('.gf-feel-recap')) return !!card?.querySelector('.gf-feel-recap');
    const r = api.recap();
    if (!r?.dead) return false;
    const box = el('div', 'gf-feel-recap');
    const who = h => (h.kind === 2 ? (ctx.tables?.enemies?.[h.type]?.name || 'An enemy') : h.kind === 17 ? 'A target' : h.by ? `Player ${h.by}` : 'The world');
    box.append(el('h2', null, 'What felled you'), el('strong', null, who(r.final)),
      el('p', null, `${Math.round(r.final.damage)} damage at ${Math.round(r.final.hpBefore)} health${r.final.armor > 0 ? `, ${Math.round(r.final.armor)} taken by armour` : ''}`));
    const ol = el('ol');
    for (const h of [...r.hits].reverse()) { const li = el('li'); li.append(el('span', null, `−${h.ago.toFixed(1)} s`), el('span', null, `${who(h)}${h.part && h.part !== 'body' ? `, ${h.part}` : ''}`), el('span', null, `${Math.round(h.damage)} · ${Math.round(h.hpBefore)} → ${Math.round(h.hpAfter)}`)); ol.append(li); }
    if (r.hits.length) box.append(el('h2', 'dim', `Your last ${r.seconds} seconds`), ol);
    card.insertBefore(box, card.querySelector('div') ?? null);
    return true;
  };
  const api = {
    hud, sound,
    /** The touch buttons' BTN bits for this frame's INPUT (gf/forge/hud.js): {held, pressed}. */
    touch: () => hud?.touch() ?? { held: 0, pressed: 0 },
    /** Every frame, after the host's tick. */
    update(dt) {
      view = forge.feel_view();
      settings();
      stageDemo();
      const phase = ctx.round?.phase ?? 'playing', playing = phase === 'playing' || phase === 'countdown';
      const W_ = innerWidth, H = innerHeight;
      // the red edge and the low-health stages
      const tint = playing ? String(Math.round(Math.min(1, view[F.tint]) * 1000) / 1000) : '0';
      if (edge.style.opacity !== tint) edge.style.opacity = tint;
      const stage = playing && !view[F.dead] ? view[F.stage] | 0 : 0, lowCls = `gf-feel-low${stage ? ` s${stage}` : ''}`;
      if (low.className !== lowCls) low.className = lowCls;
      // the crosshair: shown while a weapon is drawn
      const weapon = view[F.weapon] | 0, armed = weapon >= 0 && playing && !view[F.dead], shown = armed && !ctx.ui?.covered;
      cross.style.display = armed ? 'block' : 'none';
      if (armed) {
        const gap = 4 + Math.min(40, view[F.spread] * 2.2) + view[F.recoil] * 6;
        // moved by a transform on its own layer, never by left/top: held fire changes the gap every frame, and left/top
        // laid the whole HUD out and painted it again each time (wave 2, track G: the low tier at 4× CPU lost its frames there)
        const g = Math.round(gap * 2) / 2;
        if (g !== lastGap) {
          lastGap = g;
          arms[0].style.transform = `translateX(${-g - 7}px)`; arms[1].style.transform = `translateX(${g}px)`;
          arms[2].style.transform = `translateY(${-g - 7}px)`; arms[3].style.transform = `translateY(${g}px)`;
        }
        cross.classList.toggle('dim', view[F.reloading] > 0 || view[F.raise] > 0);
        hitMark = Math.max(0, hitMark - dt);
        cross.classList.toggle('hit', hitMark > 0);
        marks.forEach((m, i) => { const a = Math.PI / 4 + (i * Math.PI) / 2; m.style.transform = `translate(${Math.cos(a) * 9 - 4}px, ${Math.sin(a) * 9 - 1}px) rotate(${a}rad)`; });
      }
      // the weapon in hand: its name, its rounds, the reload, the others held
      let ammoCls = 'gf-feel-ammo';
      if (shown && view[F.magazine] > 0) {
        ammoCls = `gf-feel-ammo on${view[F.reloading] > 0 ? ' reloading' : ''}${(view[F.ammo] | 0) === 0 ? ' empty' : ''}`;
        const key = `${weapon}|${view[F.ammo]}|${view[F.magazine]}`;
        if (key !== lastAmmoKey) { lastAmmoKey = key; ammoName.textContent = weaponName(weapon); ammoN.replaceChildren(String(view[F.ammo] | 0), el('small', null, ` / ${view[F.magazine] | 0}`)); }
        reloadBar.classList.toggle('on', view[F.reloading] > 0);
        if (view[F.reloading] > 0) reloadFill.style.transform = `scaleX(${Math.round(view[F.reload] * 100) / 100})`; // a transform: a width would lay the HUD out every frame of a reload
      } else if (shown && weapon >= 0) {
        ammoCls = 'gf-feel-ammo on melee';
        if (lastAmmoKey !== `${weapon}`) { lastAmmoKey = `${weapon}`; ammoName.textContent = weaponName(weapon); ammoN.replaceChildren(weaponName(weapon)); }
        reloadBar.classList.remove('on');
      }
      if (ammo.className !== ammoCls) ammo.className = ammoCls;
      const heldBits = view[F.held] >>> 0, heldKey = `${heldBits}|${weapon}`;
      if (heldKey !== lastHeldKey) {
        lastHeldKey = heldKey;
        const rows = []; for (let r = 0; r < 24; r++) if (heldBits & (1 << r)) rows.push(r);
        heldRow.replaceChildren(...(rows.length > 1 ? rows : []).map(r => { const s = el('span', r === weapon ? 'cur' : ''); s.dataset.row = String(r); s.append(el('kbd', null, String(weaponRow(r)?.slot ?? r + 1)), weaponName(r)); return s; }));
      }
      // the combo
      const n = view[F.combo] | 0;
      combo.classList.toggle('on', playing && n > 0 && !ctx.ui?.covered);
      if (n > 0) {
        comboN.textContent = `×${view[F.comboMult].toFixed(1)}`;
        comboK.textContent = fmt(W.kills, { n });
        comboFill.style.transform = `scaleX(${Math.round(Math.max(0, Math.min(1, view[F.comboLeft])) * 100) / 100})`;
        if (n !== lastCombo) { combo.classList.remove('pop'); void combo.offsetWidth; combo.classList.add('pop'); }
      }
      lastCombo = n;
      // floating numbers and words, where they are in the world
      const eye = host.eye();
      for (let i = live.length - 1; i >= 0; i--) {
        const o = live[i];
        o.t += dt;
        if (o.t >= o.life) { o.e.remove(); live.splice(i, 1); continue; }
        const s = project(eye, o.at, W_, H);
        if (!s) { o.e.style.opacity = '0'; continue; }
        const k = o.t / o.life, rise = 46 * Math.sqrt(k), scale = o.t < 0.08 ? 1.35 - (o.t / 0.08) * 0.35 : 1;
        o.e.style.opacity = String(k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3);
        o.e.style.transform = `translate(${Math.round(s.x + o.jitter)}px, ${Math.round(s.y - rise)}px) translate(-50%, -100%) scale(${scale.toFixed(2)})`;
      }
      // the HUD and the sound side follow the same view
      try { hud?.update(dt, view, F); } catch (e) { console.error(e); }
      try { sound?.update(dt, view, F); } catch (e) { console.error(e); }
      // the death recap on the shared results
      if (phase === 'results' && !recapShown) recapShown = recapPanel();
      if (phase !== 'results') recapShown = false;
    },
    /** The core's feel view, by name. */
    view: () => Object.fromEntries(names.map((n, i) => [n, r2(view[i])])),
    /** The local player's last seconds (the core's JSON, parsed). */
    recap: () => { try { return JSON.parse(forge.feel_recap(local())); } catch { return null; } },
    /** The hits and kills on the enemies' side (verify's check 16). */
    stats: () => { try { return JSON.parse(forge.feel_stats()); } catch { return null; } },
    /** For verify: what this layer shows now; the targets on the enemies' side, where they are on the screen. */
    observe() {
      const box = e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const eye = host.eye(), W_ = innerWidth, H = innerHeight;
      const targets = host.entities().filter(e => (e.kind === 2 || e.kind === 17) && !(e.flags & 1)).map(e => {
        const feet = project(eye, [e.x, e.y, e.z], W_, H), head = project(eye, [e.x, e.y + 1.75, e.z], W_, H), body = project(eye, [e.x, e.y + 1.15, e.z], W_, H);
        return { net: e.net, kind: e.kind, hp: r2(e.hp), at: [r2(e.x), r2(e.y), r2(e.z)], flashes: flashes.get(e.net) ?? 0, front: !!(feet && head && body), feet, head, body };
      });
      return {
        targets, demo: demo ? { placed: demo.placed, at: demo.at, hp: demo.hp } : null,
        view: api.view(),
        numbers: live.map(o => ({ text: o.e.firstChild?.textContent ?? '', crit: o.e.classList.contains('crit'), word: o.e.classList.contains('word'), age: r2(o.t), shown: o.e.style.opacity !== '0', ...box(o.e) })),
        crosshair: cross.style.display === 'block', hitMarker: cross.classList.contains('hit'),
        edge: Number(edge.style.opacity || 0), lowStage: Number(view[F.stage] | 0),
        combo: combo.classList.contains('on') ? { text: comboN.textContent, kills: view[F.combo] | 0, left: r2(view[F.comboLeft]), ...box(combo) } : null,
        ammo: ammo.classList.contains('on') ? { name: ammoName.textContent, text: ammoN.textContent, reloading: ammo.classList.contains('reloading'), held: [...heldRow.children].map(s => ({ row: Number(s.dataset.row), name: s.lastChild?.textContent ?? '', current: s.classList.contains('cur') })), ...box(ammo) } : null,
        recap: !!root.querySelector('.gf-feel-recap'),
        hud: hud?.observe() ?? null, sound: sound?.observe() ?? null,
      };
    },
    dispose() { for (const off of offs) off(); hud?.dispose(); sound?.dispose(); for (const e of [edge, low, cross, nums, combo, ammo]) e.remove(); },
  };
  return api;
}
