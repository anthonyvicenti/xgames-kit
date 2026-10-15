// gf-three ui: the home menu (CONTRACT §6g). Every game opens on it, and the kit draws it, never rules.js:
//
//   home      the title screen over the game's own world, the camera circling your character: the title, the tagline,
//             Play (#gf-play: alone with bots), Play with friends (#gf-friends), How to play (#gf-how), Settings
//             (#gf-settings) and the wallet (#gf-wallet: Connect wallet, or your short address and items)
//   how       the goal, every control the game uses (config/game.json → controls) and the rules' summary
//   settings  volume and mute (gf-audio), mouse sensitivity, invert look, graphics (low/high/auto: reloads alone)
//   items     the wallet and the items it owns from this game, with Wear. The game never touches a wallet: the page
//             hosting it connects, reads and builds the loadout (kit/net/host.js); without such a page the view says
//             where wallets connect
//   pause     Esc or the HUD's menu button in a round: Resume (#gf-resume), How to play, Settings, Your items, and
//             Quit to menu (#gf-leave, alone). Alone the game stands still under it; with friends it keeps going, and
//             the room is here (gf-multiplayer 1.4.0, live.hud "game"): its code and players (#gf-room), Copy invite
//             link (#gf-invite), End round for everyone (#gf-end-round, the host) and Leave (#gf-leave-room); where
//             streams are on (gf-multiplayer 1.6.0, research/watch/PLAN.md), Go live (#gf-live): a link that lets anyone
//             watch you play, then join; while live it says so and opens the share sheet
//   economy   what the hosting page's economy offers (gf:host → economy, kit/net/host.js; CONTRACT §6g W2): its 'menu'
//             buttons in the items view, its 'pause' buttons in the pause menu, its 'results' buttons on the results
//             card (alone). A click only tells the page (gf:econ-action); the page signs and answers. No offer, nothing
//
// Words come from config/game.json → text (ui.* slots: ui/slots.js); colours from --gf-accent, --gf-panel, --gf-text.
import { host as pageHost, econLabel } from '../net/host.js';
import { refusedPress } from '../core/guard.js';

const CSS = `
#gf-menu{position:absolute;inset:0;pointer-events:auto;display:none;color:var(--gf-text,#fff)}
#gf-menu.on{display:block}
#gf-menu.home{background:linear-gradient(90deg,#0b0e18e6 0%,#0b0e18b8 30%,#0b0e1800 58%)}
#gf-menu.pause{background:#0b0e1899;backdrop-filter:blur(3px)}
#gf-menu .gf-col{position:absolute;left:clamp(16px,6vw,72px);top:50%;transform:translateY(-50%);width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin}
#gf-menu.pause .gf-col{left:50%;transform:translate(-50%,-50%);background:var(--gf-panel,#1c2133ee);padding:22px 22px 18px;border-radius:20px;box-shadow:0 16px 50px #0007;width:min(400px,calc(100vw - 32px))}
#gf-menu h1{margin:0;font-size:clamp(34px,5.4vw,56px);line-height:1.02;font-weight:900;letter-spacing:-.5px;text-shadow:0 4px 0 #0005,0 0 30px #0006}
#gf-menu.pause h1{font-size:30px;text-shadow:none}
#gf-menu h2{margin:0 0 2px;font-size:24px;font-weight:850}
#gf-menu .gf-hook{margin:0 0 10px;font-size:17px;font-weight:550;opacity:.92;line-height:1.35;text-shadow:0 2px 6px #000a}
#gf-menu .gf-note{margin:0;font-size:14px;opacity:.85;font-weight:500;line-height:1.4}
#gf-menu .gf-credits{font-size:12.5px;opacity:.7}#gf-menu .gf-credits a{color:inherit}
#gf-menu button{font:700 17px/1.1 system-ui,-apple-system,"Segoe UI",sans-serif;color:inherit;cursor:pointer;border:0}
#gf-menu .gf-btn{display:flex;align-items:center;gap:12px;width:100%;padding:13px 18px;border-radius:14px;background:#ffffff1c;box-shadow:inset 0 0 0 1.5px #ffffff22;text-align:left;transition:background .12s,transform .12s}
#gf-menu .gf-btn:hover,#gf-menu .gf-btn:focus-visible{background:#ffffff33;transform:translateX(3px);outline:none}
#gf-menu .gf-col{padding-right:5px}      /* room for the hovered button's 3px slide: the column scrolls, so it clipped the right border */
#gf-menu .gf-btn svg{width:20px;height:20px;flex:none;opacity:.9}
#gf-menu .gf-btn small{display:block;font-size:12.5px;font-weight:550;opacity:.75;margin-top:3px}
#gf-menu .gf-btn.live svg{color:#ff4d5e;opacity:1}
#gf-menu .gf-btn.live.on{box-shadow:inset 0 0 0 1.5px #ff4d5e88}
#gf-menu .gf-btn.voice svg{color:#3ddc84;opacity:1}
#gf-menu .gf-btn.voice.on{box-shadow:inset 0 0 0 1.5px #3ddc8488}
#gf-menu .gf-btn.primary{background:var(--gf-accent,#ff7a59);font-size:22px;padding:16px 20px;box-shadow:0 5px 0 #0004,inset 0 -3px 0 #0002}
#gf-menu .gf-btn.primary:hover{filter:brightness(1.08)}
#gf-menu .gf-btn.wallet{margin-top:8px;background:#0006;box-shadow:inset 0 0 0 1.5px #ffffff30}
#gf-menu .gf-btn.wallet.on{box-shadow:inset 0 0 0 1.5px var(--gf-accent,#ff7a59)}
#gf-menu .gf-btn.wallet img{width:22px;height:22px;border-radius:6px}
#gf-menu .gf-head{display:flex;align-items:center;gap:10px;margin-bottom:4px}
#gf-menu .gf-back{min-width:44px;min-height:44px;padding:0 14px;border-radius:12px;background:#ffffff22;font-size:17px;flex:none;white-space:nowrap}
#gf-menu .gf-panel{background:#0b0e18b3;border-radius:16px;padding:14px 16px;box-shadow:inset 0 0 0 1.5px #ffffff18}
#gf-menu.pause .gf-panel{background:#ffffff10}
#gf-menu .gf-keys{display:grid;grid-template-columns:auto 1fr;gap:8px 14px;margin:0;font-size:15px;font-weight:550;align-items:center}
#gf-menu .gf-keys dt{justify-self:start}
#gf-menu .gf-keys kbd{display:inline-block;min-width:22px;padding:3px 8px;border-radius:7px;background:#ffffff26;box-shadow:inset 0 -2px 0 #0004;font:700 13px system-ui;text-align:center;white-space:nowrap}
#gf-menu .gf-keys dd{margin:0;opacity:.92}
#gf-menu .gf-keys dd::first-letter{text-transform:uppercase}
#gf-menu .gf-keys dt .or{opacity:.7;font-size:.86em;margin:0 2px}
#gf-menu .gf-goalbox{font-size:16px;font-weight:650;line-height:1.35}
#gf-menu .gf-goalbox b{display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin-bottom:3px}
#gf-menu label.gf-set{display:grid;grid-template-columns:1fr auto;gap:6px 12px;align-items:center;font-size:15px;font-weight:600;padding:8px 0;border-bottom:1px solid #ffffff14}
#gf-menu label.gf-set:last-child{border-bottom:0}
#gf-menu label.gf-set input[type=range]{grid-column:1/-1;width:100%;accent-color:var(--gf-accent,#ff7a59)}
#gf-menu label.gf-set input[type=checkbox]{width:20px;height:20px;accent-color:var(--gf-accent,#ff7a59)}
#gf-menu label.gf-set output{font-variant-numeric:tabular-nums;opacity:.8;font-size:14px}
#gf-menu .gf-seg{display:flex;gap:4px;background:#ffffff14;border-radius:10px;padding:3px}
#gf-menu .gf-seg button{padding:6px 10px;border-radius:8px;font-size:13px;background:transparent}
#gf-menu .gf-seg button.on{background:var(--gf-accent,#ff7a59)}
#gf-menu .gf-wallets{display:flex;flex-direction:column;gap:6px;margin-top:10px}
#gf-menu .gf-wallets button{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:#ffffff1c;font-size:15px}
#gf-menu .gf-wallets button:hover{background:#ffffff33}
#gf-menu .gf-wallets img{width:24px;height:24px;border-radius:6px}
#gf-menu .gf-who{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px}
#gf-menu .gf-who img{width:22px;height:22px;border-radius:6px}
#gf-menu .gf-who span{flex:1}
#gf-menu .gf-who button{font-size:13px;padding:6px 10px;border-radius:9px;background:#ffffff1c}
#gf-menu .gf-items{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
#gf-menu .gf-item{display:grid;grid-template-columns:48px 1fr auto;gap:10px;align-items:center;padding:8px;border-radius:12px;background:#ffffff12}
#gf-menu .gf-item.on{box-shadow:inset 0 0 0 2px var(--gf-accent,#ff7a59)}
#gf-menu .gf-item .pic{width:48px;height:48px;border-radius:10px;background:#ffffff1c;display:grid;place-items:center;overflow:hidden;font-size:22px}
#gf-menu .gf-item .pic img{width:100%;height:100%;object-fit:cover}
#gf-menu .gf-item strong{display:block;font-size:15px}
#gf-menu .gf-item em{font-style:normal;font-size:12px;font-weight:700;padding:1px 7px;border-radius:999px;background:#ffffff22;margin-right:6px}
#gf-menu .gf-item em.r1{background:#3ddc8455}#gf-menu .gf-item em.r2{background:#4f7cff66}#gf-menu .gf-item em.r3{background:#b05cff66}#gf-menu .gf-item em.r4{background:#ffb02e77}
#gf-menu .gf-item small{font-size:12px;opacity:.75}
#gf-menu .gf-item button{padding:8px 12px;border-radius:10px;font-size:14px;background:#ffffff22}
#gf-menu .gf-item.on button{background:var(--gf-accent,#ff7a59)}
#gf-menu .gf-boxes{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
#gf-menu .gf-boxes button{font-size:13px;padding:6px 10px;border-radius:999px;background:#ffffff1c}
#gf-menu .gf-error{color:#ffb4bd;font-weight:600}
#gf-menu .gf-hint{font-size:12.5px;opacity:.65;font-weight:550;margin-top:2px}
#gf-menu .gf-room{display:flex;flex-direction:column;gap:8px}
#gf-menu .gf-room-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:12px;font-weight:750;letter-spacing:.08em;text-transform:uppercase;opacity:.85}
#gf-menu .gf-room-head b{font:800 20px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.14em;text-transform:none;color:var(--gf-accent,#ffd166)}
#gf-menu .gf-room ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
#gf-menu .gf-room li{display:flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;background:#ffffff14;font-size:13.5px;font-weight:650}
#gf-menu .gf-room li i{width:10px;height:10px;border-radius:50%;flex:none}
#gf-menu .gf-room li.me{box-shadow:inset 0 0 0 1.5px #ffffff66}
#gf-menu .gf-row{display:flex;gap:8px;flex-wrap:wrap}#gf-menu .gf-row .gf-btn{flex:1 1 140px;padding:10px 14px;font-size:15px}
#gf-menu .gf-econ{display:flex;flex-direction:column;gap:8px}
#gf-menu .gf-econ .gf-btn{background:#ffffff14;box-shadow:inset 0 0 0 1.5px var(--gf-accent,#ff7a59)}
#gf-menu .gf-econ .gf-btn:disabled{opacity:.6;cursor:wait;transform:none}
#gf-ui .gf-card .gf-econ{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:6px}
#gf-ui .gf-card .gf-econ button{background:#ffffff1f;box-shadow:inset 0 0 0 2px var(--gf-accent,#ff7a59);padding:8px 20px;font-size:16px}
#gf-ui .gf-card .gf-econ button:disabled{opacity:.6;cursor:wait}
#gf-ui .gf-card .gf-econ p{flex-basis:100%;margin:2px 0 0;font-size:13px}
#gf-ui:has(#gf-menu.on) .gf-help,#gf-ui:has(#gf-menu.home.on) .gf-scores,#gf-ui:has(#gf-menu.home.on) .gf-plates,#gf-ui:has(#gf-menu.on) .gf-cross,#gf-ui:has(#gf-menu.on) .gf-prompt{display:none!important}
@media (max-height:660px){#gf-menu .gf-col{gap:7px;max-height:calc(100vh - 20px)}#gf-menu h1{font-size:clamp(26px,4vw,40px)}#gf-menu .gf-hook{font-size:14px;margin:0 0 4px}#gf-menu .gf-btn{padding:8px 14px;font-size:15px}#gf-menu .gf-btn small{display:none}#gf-menu .gf-btn.primary{font-size:18px;padding:10px 16px}#gf-menu .gf-btn.wallet{margin-top:4px}#gf-menu.pause .gf-col{padding:14px 16px 12px}#gf-menu.pause h1{font-size:22px}#gf-menu .gf-panel{padding:10px 12px}}
@media (max-height:420px){#gf-menu .gf-hook{display:none}#gf-menu h1{font-size:clamp(22px,3.4vw,32px)}#gf-menu .gf-btn{padding:6px 12px}#gf-menu .gf-btn.primary{padding:8px 14px}}
@media (max-width:640px){#gf-menu.home{background:linear-gradient(0deg,#0b0e18f0 0%,#0b0e18b0 55%,#0b0e1830 100%)}#gf-menu.home .gf-col{top:auto;bottom:16px;transform:none;left:16px}#gf-menu .gf-btn{padding:11px 14px}#gf-menu .gf-btn.primary{font-size:19px;padding:13px 16px}}
#gf-menu .gf-col{box-sizing:border-box;max-height:calc(100dvh - 40px)}
#gf-menu.pause .gf-col{width:min(444px,calc(100vw - 24px))}
@media (max-height:660px){#gf-menu .gf-col{max-height:calc(100dvh - 20px)}}
#gf-menu .gf-col:has(>.gf-body){overflow:hidden}
#gf-menu .gf-body{display:flex;flex-direction:column;gap:inherit;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;padding-right:5px;margin-right:-5px}
#gf-menu .gf-btn,#gf-menu .gf-row .gf-btn{box-sizing:border-box;min-height:44px}
#gf-menu label.gf-set{box-sizing:border-box;min-height:44px}
#gf-menu label.gf-set input[type=range]{height:44px;margin:-10px 0 -12px}
#gf-menu .gf-seg button,#gf-menu .gf-who button,#gf-menu .gf-item button,#gf-menu .gf-boxes button,#gf-menu .gf-wallets button{box-sizing:border-box;min-height:44px;min-width:44px}
@media (max-height:540px){#gf-menu.pause #gf-resume{position:sticky;top:0;z-index:1}}
@media (max-height:540px) and (min-width:560px){#gf-menu .gf-col:has(>.gf-body){width:min(560px,calc(100vw - 32px))}#gf-menu .gf-head{margin-bottom:0}}
`;

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
  friends: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.8"/><path d="M16 14.6c2.7-.3 4.8 1.4 5.5 4.4"/></svg>',
  how: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="2.5" y="6.5" width="19" height="11" rx="3"/><path d="M7 10.5v3M5.5 12h3M15.5 11h.01M18 13h.01"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h11.5v3"/><rect x="3.5" y="8" width="17" height="11.5" rx="2.5"/><circle cx="16.3" cy="13.8" r="1.3" fill="currentColor"/></svg>',
  resume: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
  live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="2.6" fill="currentColor"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>',
  leave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/></svg>',
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const svg = name => { const s = el('span'); s.innerHTML = ICON[name] ?? ''; return s.firstChild; };

/** The control rows for How to play: [keys, what] from config/game.json → controls (CONTRACT §6d). */
/** The credits a game's art asks for: each slot whose licence names its licence page (CC BY), once per file. */
export function creditsOf(manifest) {
  const out = [], seen = new Set();
  for (const s of manifest?.slots ?? []) {
    const l = s.license, file = s.source?.file ?? s.id;
    if (!l?.licenseUrl || seen.has(file)) continue;
    seen.add(file); out.push({ title: l.title ?? s.label ?? s.id, author: l.author ?? '', source: l.url ?? '', spdx: l.spdx ?? '', licenseUrl: l.licenseUrl, modified: !!l.modified });
  }
  return out;
}

export function controlRows(controls = {}, { touch = false, camera = 'third', world = false, free = false } = {}) {
  // the orbit camera (worlds, CONTRACT §9): the mouse is free; a drag turns the camera, a click is the action where
  // it points. controls.more: [[keys, what, touch?], ...] for a game's own keys (a hotbar, a tool); `touch` names the
  // on-screen control that does it on a phone (a row without one is left out there). First person in a world: the
  // mouse looks once a click has taken it, and a click is the action at the crosshair; `free` (the page refused the
  // lock: a post on X) makes it the orbit camera's drag and click
  const more = Array.isArray(controls.more) ? controls.more.filter(r => Array.isArray(r) && r.length >= 2) : [];
  const first = camera === 'first' && world;
  if (camera === 'orbit' || first) {
    if (touch) {
      const rows = [['Left thumb', 'Move'], ['Right thumb drag', first ? 'Look around' : 'Turn the camera']];
      if (controls.primary) rows.push(['Tap', controls.primary]);
      if (controls.secondary) rows.push(['Long press', controls.secondary]);
      rows.push(['Jump button', controls.jump || 'Jump']);
      for (const r of more) if (r[2]) rows.push([r[2], r[1]]);
      return rows.filter(r => r[1]);
    }
    const rows = [['W A S D', 'Move'], ['Shift', 'Sprint'], ['Space', controls.jump || 'Jump']];
    if (!first) rows.push(['Drag', 'Turn the camera'], ['Wheel', 'Zoom']);
    else if (free) rows.push(['Drag', 'Look around']);
    else rows.push(['Mouse', 'Look around (a first click takes the mouse)']);
    if (controls.primary) rows.push(['Click', controls.primary]);
    if (controls.secondary) rows.push(['Right click', controls.secondary]);
    if (controls.interact) rows.push(['E', controls.interact]);
    for (const r of more) rows.push([r[0], r[1]]);
    rows.push(['Esc', 'Menu']);
    return rows;
  }
  if (touch) {
    const rows = [['Left thumb', 'Move'], ['Right thumb', camera === 'top' || camera === 'follow' ? '' : 'Look']];
    for (const [k, label] of [['primary', 'Action'], ['secondary', ''], ['interact', 'Use'], ['jump', 'Jump']]) if (controls[k] || k === 'jump') rows.push([`${k === 'jump' ? 'Jump' : (String(controls[k] ?? label).split(/\s+/)[0] || label)} button`, controls[k] ?? 'Jump']);
    for (const r of more) if (r[2]) rows.push([r[2], r[1]]);
    // a game with its own keys names its touch controls: a control it says does nothing yet has no button to name
    return rows.filter(r => r[1] && !(more.length && /^nothing\b/i.test(String(r[1]))));
  }
  // Shift sprints, unless the game's own keys say what Shift does (a forge game: it evades); a side-on view runs with
  // A and D, has no sprint, and aims with the mouse only when the game says so (controls.aim) or has a click action
  const side = camera === 'side';
  const rows = side ? [['A D', controls.move || 'Move']] : [['W A S D', controls.move || 'Move'], ...(more.some(r => /^shift$/i.test(String(r[0]).trim())) ? [] : [['Shift', 'Sprint']])];
  if (side) { if (controls.aim || (controls.aim === undefined && controls.primary)) rows.push(['Mouse', controls.aim || 'Aim']); }
  else if (camera === 'follow') rows.push(['Mouse', controls.aim || 'Aim'], ['Wheel', 'Zoom']);
  else if (camera !== 'top') rows.push(['Mouse', controls.aim || 'Look and aim']);
  rows.push(['Space', controls.jump || 'Jump']);
  if (controls.primary) rows.push(['Click · F', controls.primary]);
  if (controls.secondary) rows.push(['Right click · Q', controls.secondary]);
  if (controls.interact) rows.push(['E', controls.interact]);
  for (const r of more) rows.push([r[0], r[1]]);      // a game's own keys (a forge game's evade, reload, melee, weapons)
  rows.push(['Esc', 'Menu']);
  return rows;
}

const SETTINGS_KEY = game => `gf3-settings:${game}`;
/** The player's own settings for this game, saved in the browser: { sensitivity, invertY, quality, reduceMotion (true,
 *  false, or null: what the browser says) }. */
export function loadSettings(game) {
  let s = {}; try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY(game)) ?? '{}') ?? {}; } catch {}
  return { sensitivity: Number.isFinite(s.sensitivity) ? Math.max(0.25, Math.min(3, s.sensitivity)) : 1, invertY: !!s.invertY, quality: ['low', 'high'].includes(s.quality) ? s.quality : 'auto', reduceMotion: typeof s.reduceMotion === 'boolean' ? s.reduceMotion : null };
}
function saveSettings(game, s) { try { localStorage.setItem(SETTINGS_KEY(game), JSON.stringify(s)); } catch {} }

export function createMenu(ctx, ui, { game = {}, live = false, world = false, gameId = 'game', host = pageHost, onPlay, onFriends, onResume, onLeave, onQuality, players = () => [], room = null } = {}) {
  const T = game.text ?? {};
  const style = el('style'); style.textContent = CSS; document.head.append(style);
  const root = el('div'); root.id = 'gf-menu';
  const col = el('div', 'gf-col'); root.append(col);
  ui.root.append(root);
  const settings = loadSettings(gameId);
  const apply = () => { if (ctx.input) { ctx.input.lookScale = settings.sensitivity; ctx.input.invertY = settings.invertY; } ctx.juice?.setComfort?.({ reduceMotion: settings.reduceMotion }); };
  apply();

  let view = null, from = null, last = { b: null, t: 0 };
  const shown = new Map();      // button id → label, for the observation
  const go = (v, back = null) => { from = back; view = v; draw(); };
  // a second click on the same button within 250 ms is one click (a double click never wears and takes off at once)
  // a press the game's own code made (el.click()) is refused: only the player drives the kit's menu (kit/core/guard.js)
  const click = (fn, what = 'menu button') => e => { e.preventDefault(); e.stopPropagation(); if (refusedPress(e, what)) return; const t = performance.now(), b = e.currentTarget; if (b && b === last.b && t - last.t < 250) return; last = { b, t }; ctx.audio?.play?.('ui-click', { optional: true }); fn(); };

  function button(id, icon, label, sub, fn, cls = '') {
    const b = el('button', `gf-btn ${cls}`.trim()); b.id = id; b.type = 'button';
    if (icon) b.append(svg(icon));
    const t = el('span', null, label); if (sub) t.append(el('small', null, sub)); b.append(t);
    b.addEventListener('click', click(fn, `${label} button (#${id})`));
    shown.set(id, label);
    return b;
  }
  function head(title) {
    const h = el('div', 'gf-head'), back = el('button', 'gf-back', `← ${T.back ?? 'Back'}`); back.id = 'gf-back'; back.type = 'button'; back.setAttribute('aria-label', 'Back');
    back.addEventListener('click', click(() => go(from ?? 'home')));
    h.append(back, el('h2', null, title)); return h;
  }
  const isPause = () => view === 'pause' || from === 'pause';
  const wallet = () => host.wallet;
  function walletLabel() {
    const w = wallet();
    if (!host.present || !host.offers.wallet) return { label: T.wallet ?? 'Connect wallet', sub: 'Wear the items you own' };
    if (w.status === 'connected') { const n = w.items?.length ?? 0; return { label: w.short || 'Wallet connected', sub: w.items === null ? 'Reading your items…' : n ? `${n} item${n === 1 ? '' : 's'} from this game` : 'No items from this game yet', on: true, icon: w.icon }; }
    if (w.status === 'connecting') return { label: `Approve in ${w.name || 'your wallet'}…`, sub: 'Waiting for the wallet' };
    return { label: T.wallet ?? 'Connect wallet', sub: 'Wear the items you own' };
  }

  // the economy's buttons at one place (CONTRACT §6g W2): what the page offers there, or nothing at all
  function econStrip(where, inCard = false) {
    const acts = host.econAt?.(where) ?? [];
    if (!acts.length) return null;
    const st = host.econState ?? null, pending = new Set(st?.pending ?? []);
    const s = el('div', 'gf-econ'); s.id = `gf-econ-${where}`; s.dataset.where = where;
    for (const a of acts) {
      // the price is part of the label, never only the small line under it (that line hides in a short window)
      const wait = pending.has(a.id), label = econLabel(a, wait), sub = a.says || '';
      let b;
      if (inCard) { b = el('button', 'gf-econ-btn', label); b.type = 'button'; if (a.says) b.title = a.says; b.addEventListener('click', click(() => host.econAction(a.id))); }
      else { b = button(`gf-econ-${where}-${a.id}`, null, label, sub || null, () => host.econAction(a.id), 'gf-econ-btn'); b.removeAttribute('id'); shown.delete(`gf-econ-${where}-${a.id}`); }
      b.dataset.econ = a.id; b.dataset.kind = a.kind; b.disabled = wait;
      s.append(b);
    }
    if (st?.error) s.append(el('p', 'gf-note gf-error', st.error));
    return s;
  }
  // the results card is ui.js's: the economy's 'results' buttons go on it (alone; with friends the party page's card is the result)
  ui.resultsExtra = () => econStrip('results', true);
  function redrawResults() {
    const card = ui.parts?.card; if (!card || ui.view !== 'results') return;
    const old = card.querySelector('.gf-econ'), fresh = econStrip('results', true);
    if (old) { if (fresh) old.replaceWith(fresh); else old.remove(); return; }
    if (!fresh) return;
    const row = [...card.children].find(c => c.querySelector?.('#gf-again, #gf-to-menu'));
    if (row) card.insertBefore(fresh, row); else card.append(fresh);
  }

  function draw() {
    shown.clear();
    col.replaceChildren();
    root.className = view ? `on ${isPause() ? 'pause' : 'home'}` : '';
    ui.cover('menu', !!view);
    if (!view) return;
    if (view === 'home') drawHome();
    else if (view === 'pause') drawPause();
    else if (view === 'how') drawHow();
    else if (view === 'settings') drawSettings();
    else if (view === 'items') drawItems();
    // a view with a Back button: everything under it scrolls on its own, so Back stays on a short screen (a phone held
    // sideways; the creator, 2026-10-12: "Looks like some of the buttons run off the screen")
    const h = col.querySelector(':scope > .gf-head');
    if (h && h.nextSibling) { const body = el('div', 'gf-body'); while (h.nextSibling) body.append(h.nextSibling); col.append(body); }
    col.querySelector('button')?.focus?.({ preventScroll: true });
  }
  function walletButton(back) {
    const w = walletLabel();
    const b = button('gf-wallet', w.icon ? null : 'wallet', w.label, w.sub, () => go('items', back), `wallet${w.on ? ' on' : ''}`);
    if (w.icon) { const i = el('img'); i.src = w.icon; i.alt = ''; b.prepend(i); }
    return b;
  }
  function drawHome() {
    const ps = players(), bots = ps.filter(p => p.isBot).length;
    col.append(el('h1', null, T.title ?? game.title ?? 'Play'));
    if (T.hook ?? game.hook) col.append(el('p', 'gf-hook', T.hook ?? game.hook));
    if (world && !live) {
      // a world (CONTRACT §9) on its own page: Enter the world (#gf-friends, first) opens the world everyone shares
      // through its card; Play (#gf-play) is a practice copy that saves nothing (play-test 2026-10-09: the bare page
      // changed the shared world unseen, outside its 8 seats)
      col.append(button('gf-friends', 'friends', T.enter ?? 'Enter the world', T.enterSub ?? 'Build with everyone here: it is all saved', () => onFriends?.(), 'primary'));
      col.append(button('gf-play', 'play', T.practice ?? 'Try it on your own', T.practiceSub ?? 'A practice copy: nothing you build is saved', () => onPlay?.()));
    } else {
      // a world with friends has no rounds: Play goes in
      const playSub = world ? (T.playSub ?? 'Build, break and paint anything') : live ? null : bots ? `You and ${bots} bot${bots === 1 ? '' : 's'}` : 'On your own';
      col.append(button('gf-play', 'play', T.play ?? 'Play', playSub, () => onPlay?.(), 'primary'));
      if (!live) col.append(button('gf-friends', 'friends', T.friends ?? 'Play with friends', 'One of you hosts, the others join', () => onFriends?.()));
    }
    col.append(button('gf-how', 'how', T.how ?? 'How to play', null, () => go('how', 'home')));
    col.append(button('gf-settings', 'settings', T.settings ?? 'Settings', null, () => go('settings', 'home')));
    col.append(walletButton('home'));
  }
  // voice chat (gf-multiplayer 1.7.4; the creator, 2026-10-12: "It should go away and only be accessable by clicking
  // escape and looking at the menue options"): under Studio's play page only, right under Resume so a short phone screen
  // shows it without scrolling; a press opens Studio's voice panel over the game, and closing this menu closes it
  function voiceButton() {
    const vc = room?.voice?.();
    if (!vc?.available) return null;
    const label = vc.joined ? `${T.voice ?? 'Voice chat'} · mic ${vc.mic ? 'on' : 'off'}${vc.n > 0 ? ` · ${vc.n} in voice` : ''}` : (T.voice ?? 'Voice chat');
    return button('gf-voice', 'mic', label, vc.joined ? null : 'Talk with the others in this room', () => { room.voiceOpen?.(); }, `voice${vc.joined ? ' on' : ''}${vc.open ? ' open' : ''}`);
  }
  function drawPause() {
    col.append(el('h1', null, live || world ? (T.menu ?? 'Menu') : (T.paused ?? 'Paused')));
    if (live) col.append(el('p', 'gf-note', world ? 'The world keeps going while you are here.' : 'The round keeps going while you are here.'));
    col.append(button('gf-resume', 'resume', T.resume ?? 'Resume', null, () => onResume?.(), 'primary'));
    if (live && room) { const v = voiceButton(); if (v) col.append(v); }
    col.append(button('gf-how', 'how', T.how ?? 'How to play', null, () => go('how', 'pause')));
    col.append(button('gf-settings', 'settings', T.settings ?? 'Settings', null, () => go('settings', 'pause')));
    col.append(walletButton('pause'));
    const econ = econStrip('pause'); if (econ) col.append(econ);
    if (!live) col.append(button('gf-leave', 'leave', T.leave ?? 'Quit to menu', world ? 'Everything stays as it is' : 'The round ends', () => onLeave?.()));
    if (live && room) drawRoom();
  }
  // With friends: the room, in the game's own menu (the party page leaves the whole stage to the game)
  function drawRoom() {
    const r = room.info?.(); if (!r) return;
    const p = el('div', 'gf-panel gf-room'); p.id = 'gf-room';
    const h = el('div', 'gf-room-head'); h.append(el('span', null, world ? 'In this world' : 'Room'), el('b', null, world ? `${(r.players ?? []).length} of ${r.max ?? 8}` : r.code ?? '')); h.lastChild.id = 'gf-room-code';
    const ul = el('ul');
    for (const x of r.players ?? []) { const li = el('li', x.you ? 'me' : ''); const i = el('i'); i.style.background = x.color; li.append(i, `${x.name}${x.you ? ' (you)' : ''}${x.host ? ' · host' : ''}`); ul.append(li); }
    p.append(h, ul);
    col.append(p);
    // watch then play (gf-multiplayer 1.6.0): stream this game; the party page shows the link, Post on X and Stop
    const lv = room.live?.();
    if (lv?.available) {
      const on = lv.state === 'on' || lv.state === 'starting';
      col.append(on ? button('gf-live', 'live', lv.state === 'on' ? `You’re live · ${lv.viewers} watching` : 'Going live…', 'Your link, Post on X, Stop', () => room.showLive?.(), 'live on')
        : button('gf-live', 'live', T.goLive ?? 'Go live', T.goLiveSub ?? 'Anyone with your link watches you play, then joins', () => room.goLive?.(), 'live'));
    }
    if (world) {
      // a world's link is the page itself (the post, the published game): anyone who opens it lands here
      const inv = button('gf-invite', 'friends', 'Copy link to this world', null, () => {
        const url = r.invite ?? (() => { try { return window.top.location.href; } catch { return location.href; } })();
        const done = () => { const t = inv.querySelector('span'); if (t) { t.firstChild.textContent = 'Copied!'; setTimeout(() => { if (t.isConnected) t.firstChild.textContent = 'Copy link to this world'; }, 1400); } };
        try { navigator.clipboard?.writeText(url).then(done, done); } catch { done(); }
      });
      col.append(inv);
      col.append(button('gf-leave-room', 'leave', 'Leave the world', 'Everything you built stays', () => room.leave?.()));
      return;
    }
    const inv = button('gf-invite', 'friends', 'Copy invite link', null, () => {
      const done = () => { const t = inv.querySelector('span'); if (t) { t.firstChild.textContent = 'Copied!'; setTimeout(() => { if (t.isConnected) t.firstChild.textContent = 'Copy invite link'; }, 1400); } };
      try { navigator.clipboard?.writeText(r.invite).then(done, done); } catch { done(); }
    });
    const row = el('div', 'gf-row'); row.append(inv);
    if (r.host && r.canEnd) row.append(button('gf-end-round', 'leave', 'End round', 'For everyone', () => room.end?.()));
    col.append(row);
    col.append(button('gf-leave-room', 'leave', r.host ? 'Close the room' : 'Leave the game', r.host ? 'Ends the game for everyone' : null, () => room.leave?.()));
  }
  function drawHow() {
    col.append(head(T.how ?? 'How to play'));
    const goal = ctx.hud?.goalText || T.goal || game.rules?.summary || '';
    if (goal) { const g = el('div', 'gf-panel gf-goalbox'); g.id = 'gf-how-goal'; g.append(el('b', null, 'Goal'), document.createTextNode(goal)); col.append(g); }
    const p = el('div', 'gf-panel'), dl = el('dl', 'gf-keys'); dl.id = 'gf-how-keys';
    for (const [keys, what] of controlRows(game.controls ?? {}, { touch: !!ctx.input?.touch, camera: game.camera ?? 'third', world, free: !!ctx.input?.lockRefused })) {
      // keys that do the same are read as alternatives ("Click or F: fire", not "Click F fire")
      const dt = el('dt'); for (const k of keys.split(' · ')) { if (dt.childNodes.length) dt.append(' ', el('span', 'or', 'or'), ' '); dt.append(el('kbd', null, k)); }
      const dd = el('dd', null, what); dd.dataset.does = what; dl.append(dt, dd);
    }
    p.append(dl); col.append(p);
    const summary = game.rules?.summary;
    if (summary && summary !== goal) col.append(el('p', 'gf-note', summary));
    // credits a licence asks for (CC BY art the game uses: assets.json → a slot's license with its licenseUrl), so a
    // player can find them (kit docs/LICENSING.md)
    const credits = creditsOf(ctx.assets?.manifest);
    if (credits.length) {
      const c = el('p', 'gf-note gf-credits'); c.id = 'gf-how-credits'; c.append('Art credits: ');
      credits.forEach((l, i) => {
        if (i) c.append('; ');
        c.append(`“${l.title}” by ${l.author}${l.source ? ' (' : ''}`);
        if (l.source) { const a = el('a', null, 'source'); a.href = l.source; a.target = '_blank'; a.rel = 'noopener'; c.append(a, ')'); }
        c.append(', ');
        const b = el('a', null, l.spdx.replace(/^CC-BY-/, 'CC BY ')); b.href = l.licenseUrl; b.target = '_blank'; b.rel = 'noopener'; c.append(b);
        if (l.modified) c.append(', changed');
      });
      col.append(c);
    }
  }
  function drawSettings() {
    col.append(head(T.settings ?? 'Settings'));
    const p = el('div', 'gf-panel'); p.id = 'gf-settings-panel';
    const audio = ctx.audio?.raw;
    const range = (id, label, value, min, max, step, fmt, set) => {
      const l = el('label', 'gf-set'), o = el('output', null, fmt(value)), r = el('input'); r.type = 'range'; r.id = id; r.min = min; r.max = max; r.step = step; r.value = String(value);
      r.addEventListener('input', () => { set(r.valueAsNumber); o.textContent = fmt(r.valueAsNumber); });
      l.append(el('span', null, label), o, r); return l;
    };
    const check = (id, label, value, set) => { const l = el('label', 'gf-set'), c = el('input'); c.type = 'checkbox'; c.id = id; c.checked = !!value; c.addEventListener('change', () => set(c.checked)); l.append(el('span', null, label), c); return l; };
    if (audio) {
      p.append(range('gf-volume', 'Volume', Math.round((audio.volume ?? 1) * 100), 0, 100, 1, v => `${v}%`, v => { audio.volume = v / 100; if (audio.muted && v > 0) audio.muted = false; }));
      p.append(check('gf-mute', 'Mute', audio.muted, v => { audio.muted = v; }));
    }
    if (!['top', 'follow'].includes(game.camera ?? 'third')) {      // orbit keeps them: a drag turns it
      p.append(range('gf-sensitivity', 'Mouse sensitivity', settings.sensitivity, 0.25, 3, 0.05, v => `${v.toFixed(2)}×`, v => { settings.sensitivity = v; apply(); saveSettings(gameId, settings); }));
      p.append(check('gf-invert', 'Invert look up and down', settings.invertY, v => { settings.invertY = v; apply(); saveSettings(gameId, settings); }));
    }
    // comfort: no screen shake or slow motion (ctx.juice); unset follows the browser's own setting
    if (ctx.juice) p.append(check('gf-reduce-motion', 'Reduce motion (no shake or slow motion)', ctx.juice.reduceMotion, v => { settings.reduceMotion = v; apply(); saveSettings(gameId, settings); }));
    const l = el('label', 'gf-set'), seg = el('div', 'gf-seg'); seg.id = 'gf-quality';
    for (const q of ['auto', 'low', 'high']) {
      const b = el('button', settings.quality === q ? 'on' : '', q[0].toUpperCase() + q.slice(1)); b.type = 'button'; b.dataset.quality = q;
      b.addEventListener('click', click(() => { if (settings.quality === q) return; settings.quality = q; saveSettings(gameId, settings); onQuality?.(q); draw(); }));
      seg.append(b);
    }
    l.append(el('span', null, 'Graphics'), seg); p.append(l);
    col.append(p);
    col.append(el('p', 'gf-hint', live ? 'Graphics changes apply next time you play.' : 'Graphics changes restart the game.'));
  }
  function drawItems() {
    col.append(head(T.items ?? 'Your items'));
    const p = el('div', 'gf-panel'); p.id = 'gf-items-panel';
    const w = wallet();
    if (!host.present || !host.offers.wallet) {
      host.hello?.();
      p.append(el('p', 'gf-note', 'Wallets connect on this game’s games.fun page. Open it there to wear the items you own.'));
      p.dataset.state = 'no-host';
    } else if (w.status !== 'connected') {
      p.dataset.state = w.status;
      p.append(el('p', 'gf-note', w.status === 'connecting' ? `Approve the connection in ${w.name || 'your wallet'}.` : 'Connect a wallet to wear the items you own from this game. Everyone in your match sees them.'));
      if (w.error) p.append(el('p', 'gf-note gf-error', w.error));
      const list = el('div', 'gf-wallets');
      if (w.wallets.length) for (const x of w.wallets) {
        const b = el('button'); b.type = 'button'; b.className = 'gf-wallet-pick'; b.dataset.wallet = x.name; b.disabled = w.status === 'connecting';
        if (x.icon) { const i = el('img'); i.src = x.icon; i.alt = ''; b.append(i); }
        b.append(el('span', null, x.name)); b.addEventListener('click', click(() => host.connect(x.name))); list.append(b);
      }
      else list.append(el('p', 'gf-note', 'No Solana wallet found. Install Phantom, Backpack or Solflare, then reload.'));
      p.append(list);
    } else {
      p.dataset.state = 'connected';
      const who = el('div', 'gf-who'); if (w.icon) { const i = el('img'); i.src = w.icon; i.alt = ''; who.append(i); }
      who.append(el('span', null, w.short || w.address));
      const d = el('button', null, 'Disconnect'); d.type = 'button'; d.id = 'gf-disconnect'; d.addEventListener('click', click(() => host.disconnect())); who.append(d);
      p.append(who);
      if (!host.offers.shop) p.append(el('p', 'gf-note', 'This game has no items yet.'));
      else if (w.items === null) p.append(el('p', 'gf-note', 'Reading your items…'));
      else if (!w.items.length) p.append(el('p', 'gf-note', 'You don’t own any items from this game yet.'));
      else {
        const ul = el('ul', 'gf-items');
        for (const it of w.items) {
          const li = el('li', `gf-item${it.worn ? ' on' : ''}`); li.dataset.item = String(it.itemId);
          const pic = el('span', 'pic'); if (it.image) { const i = el('img'); i.src = it.image; i.alt = ''; pic.append(i); } else pic.textContent = '✦';
          const mid = el('div'); mid.append(el('strong', null, `${it.name}${it.count > 1 ? ` ×${it.count}` : ''}`));
          const r = el('em', `r${Math.max(0, Math.min(4, it.rarity))}`, it.rarityName || 'Item'); mid.append(r, el('small', null, it.what || (it.wearable ? 'Changes how you look' : 'A collectible')));
          li.append(pic, mid);
          if (it.wearable) { const b = el('button', 'gf-wear', it.worn ? 'Wearing' : 'Wear'); b.type = 'button'; b.addEventListener('click', click(() => host.wear(it.itemId, !it.worn))); li.append(b); }
          else li.append(el('span'));
          ul.append(li);
        }
        p.append(ul);
      }
      if (w.boxes.length) {
        const bx = el('div', 'gf-boxes');
        for (const b of w.boxes) { const x = el('button', null, `${b.name} · ${b.price} ${b.symbol}`); x.type = 'button'; x.addEventListener('click', click(() => host.open(b.url))); bx.append(x); }
        p.append(el('p', 'gf-hint', 'Get items:'), bx);
      }
    }
    col.append(p);
    const econ = econStrip('menu'); if (econ) col.append(econ);
  }
  host.onChange(() => { if (view === 'items' || view === 'home' || view === 'pause') draw(); redrawResults(); });

  addEventListener('keydown', e => {
    if (e.code !== 'Escape' || !view) return;
    if (view === 'how' || view === 'settings' || view === 'items') { e.preventDefault(); go(from ?? 'home'); }
    else if (view === 'pause') { e.preventDefault(); onResume?.(); }
  });

  return {
    root,
    home() { go('home'); },
    pause() { go('pause'); },
    /** Draw the open view again (the stream's state changed under it). */
    redraw() { if (view) draw(); },
    close() { view = null; from = null; draw(); if (room?.voice?.()?.open) room.voiceClose?.(); },
    /** The kit's own elements here, and whether the kit shows each now (kit/core/guard.js watchKit keeps them). */
    kitItems: () => [{ el: root, name: 'the menu (#gf-menu)', want: !!view }, ...(view ? [...col.querySelectorAll('button[id]')].map(b => ({ el: b, name: `the menu's ${shown.get(b.id) ?? b.id} button (#${b.id})`, want: true, cover: true })) : [])],
    redraw() { if (view) draw(); },
    get view() { return view; },
    get paused() { return view !== null && isPause(); },
    settings,
    /** The observation (verify checks 20 and 22): what the menu shows now, its buttons, and the wallet as the page said. */
    observe() {
      const rect = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const buttons = [...col.querySelectorAll('button[id]')].map(b => ({ id: b.id, label: shown.get(b.id) ?? b.textContent.trim(), rect: rect(b), shown: typeof b.checkVisibility === 'function' ? b.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true, disabled: !!b.disabled }));
      const keys = [...col.querySelectorAll('#gf-how-keys dd')].map(d => d.dataset.does);
      const items = [...col.querySelectorAll('.gf-item')].map(li => ({ itemId: Number(li.dataset.item), worn: li.classList.contains('on') }));
      return {
        view, pause: view !== null && isPause(), live, buttons, how: { goal: col.querySelector('#gf-how-goal')?.textContent ?? null, keys },
        settings: { ...settings, reduceMotion: ctx.juice?.reduceMotion ?? null, volume: ctx.audio?.raw ? Math.round((ctx.audio.raw.volume ?? 1) * 100) : null, muted: ctx.audio?.raw?.muted ?? null, lookScale: ctx.input?.lookScale ?? null, invertY: ctx.input?.invertY ?? null },
        items: { state: col.querySelector('#gf-items-panel')?.dataset.state ?? null, picks: [...col.querySelectorAll('.gf-wallet-pick')].map(b => b.dataset.wallet), list: items },
        wallet: host.observe(),
        economy: host.observeEconomy?.() ?? { offers: [], state: null, sent: [] },
      };
    },
  };
}
