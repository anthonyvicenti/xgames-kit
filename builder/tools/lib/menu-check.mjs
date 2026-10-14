// verify checks 20, 21 and 22 (CONTRACT §6g): the home menu, the HUD and the wallet in the menu, played with real
// clicks and keys. The creator, 2026-10-08: "our games are all missing a home menu and a lot of user HUDs, especially
// for health and things like that ... Also need to include wallet connect in the home menu for game item integration"
// (research/foundations/evidence/studio-v2-home-menu-hud-wallet-request-2026-10-08.json).
//
//   20 the menu works      a bare page opens on the home menu: Play, Play with friends, How to play, Settings and the
//                          wallet are on screen and nothing covers them, also in the /play page's short stage (1024 x
//                          460) and on a phone (390 x 700); How to play lists every control the game
//                          names and its goal; Settings moves the volume and the mouse sensitivity; the wallet view
//                          says where wallets connect; Play starts the round; Esc pauses it (alone the clock stops),
//                          Resume carries on, Quit to menu goes back to the home menu, and Play starts round 2
//                          On a phone (the creator, 2026-10-12, on the forge zombie game: "Looks like some of the
//                          buttons run off the screen"; Settings ran 20-160 px past a sideways phone): a touch page at
//                          390 x 844, 844 x 390 and 640 x 360, real taps: the home menu, How to play, Settings and the
//                          pause menu (the HUD's menu button in a round) each with every control on the screen or in a
//                          box that scrolls, none cut off, none under 44 px (an input's own label counts), and the main
//                          action (Play, Back, Resume) in view, also with everything else scrolled to its end
//                          (menuOnPhones, tools/lib/phone-fit.mjs)
//   21 the HUD shows you   a round with 3 bots, real keys and clicks, and the QA moment ?gf-demo=health.hurt (the
//                          local player loses 1 hit point every 2.5 s): the player card, the menu button and the goal
//                          line are on screen, and every widget the game's mechanics call for (from config/game.json,
//                          not from the kit's own plan) is on screen and shows what the kit's state says, sampled
//                          twice a second. Health must follow the hit points it loses
//   22 the wallet in menu  the game framed by a stand-in for the games.fun /play page (another origin, the page's own
//                          messages: kit/net/host.js), with one test wallet: the menu lists the wallet, a click asks the
//                          page to connect, the menu shows the address and the items, Wear asks the page, the page's
//                          loadout reaches the game and the player is drawn in the item's colour, Disconnect clears it,
//                          and Play with friends asks the page. The economy's buttons (CONTRACT §6g W2), on a second
//                          page in stepped time (a runtime with no stepped time, forge, passes `clock`: the round's
//                          clock is cut to that many seconds through Studio's overrides and the page plays in real
//                          time to the same results card): with no offer nothing of the economy is on screen (home, wallet view,
//                          HUD, pause, results); then the page offers one button per place (menu, pause, results, hud)
//                          and each shows where its `where` says and nowhere else, a real click sends gf:econ-action
//                          with its id, and the HUD line follows the page's gf:economy state
import { createServer } from 'node:http';
import { PHONE_SIZES, PHONE_CONTEXT, fitScreen } from './phone-fit.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(150); } }
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

/** The widgets a game's HUD must show, from config/game.json alone (never from the kit's plan, which check 21 tests). */
export function expectedHud(game) {
  const out = [];
  for (const m of game.mechanics ?? []) {
    const p = m.params ?? {};
    if (m.id === 'health' && (p.hp ?? 3) > 0) out.push('health');
    if (m.id === 'projectile' && p.kind === 'continuous' && (p.streamTank ?? 0) > 0) out.push('tank');
    if (m.id === 'paint') out.push('paint');
    if (m.id === 'teams') out.push('team');
    if (m.id === 'tag') out.push('tag');
    if (m.id === 'race') out.push('race');
    if (m.id === 'waves') out.push('waves');
    if (m.id === 'station' && (p.quota ?? 0) > 0) out.push('quota');
    // the action mechanics (CONTRACT §8): the level a run is on, and the coins a player holds
    if (m.id === 'levels') out.push('level');
    if (m.id === 'loot') out.push('coins');
  }
  return [...new Set(out)];
}
const MENU_BUTTONS = ['gf-play', 'gf-friends', 'gf-how', 'gf-settings', 'gf-wallet'];

const menuOf = p => p.evaluate(() => window.__game?.menu?.() ?? null);
const snapOf = p => p.evaluate(() => window.__game?.snapshot?.() ?? null);
/** Is the button's middle the button itself (nothing drawn over it)? */
const uncovered = (p, id) => p.evaluate(id => { const b = document.getElementById(id); if (!b) return false; const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!e && (e === b || b.contains(e)); }, id);
async function clickId(p, id) { await p.locator(`#${id}`).click({ timeout: 5000 }); await sleep(250); }
/** A real click on a range input at a fraction of its width. */
async function slide(p, id, frac) { const b = await p.locator(`#${id}`).boundingBox(); if (!b) return false; await p.mouse.click(b.x + 8 + (b.width - 16) * frac, b.y + b.height / 2); await sleep(200); return true; }

/** Check 20's phone leg: the menu's views on a touch page, turned and resized as a phone is. → {ok, lines, record} */
export async function menuOnPhones({ newPage, url, shot = null }) {
  const T = await newPage('menu-phone', { viewport: { width: PHONE_SIZES[0][0], height: PHONE_SIZES[0][1] }, context: PHONE_CONTEXT });
  const p = T.page, lines = [], record = [];
  const fit = async (where, main) => { const r = await fitScreen(p, where, { main, shot }); record.push({ where, ok: r.ok, sizes: r.record }); if (!r.ok) lines.push(r.summary); };
  const tap = async sel => { await p.locator(sel).first().tap({ timeout: 5000 }); await sleep(350); };
  try {
    await p.goto(`${url}?seed=3&bots=1`, { waitUntil: 'load' });
    await until(async () => (await menuOf(p))?.view === 'home', 90000, 'the home menu on a phone');
    await sleep(500);
    await fit('the home menu', ['#gf-play']);
    await tap('#gf-how'); await fit('How to play', ['#gf-back']); await tap('#gf-back');
    await tap('#gf-settings'); await sleep(300); await fit('Settings', ['#gf-back']); await tap('#gf-back');
    await tap('#gf-play');
    await until(async () => (await snapOf(p))?.phase === 'playing', 20000, 'a tap on Play to start the round');
    await sleep(1500);
    await tap('#gf-menu-button');
    if ((await menuOf(p))?.view !== 'pause') lines.push('a tap on the HUD\'s menu button (#gf-menu-button) opened no pause menu');
    else { await fit('the pause menu', ['#gf-resume']); await tap('#gf-resume').catch(() => {}); }
  } catch (e) { lines.push(`the phone run stopped: ${e.message}`); }
  finally { await T.ctx.close().catch(() => {}); }
  return { ok: lines.length === 0, lines, record };
}

/** Check 20: the home menu works. → {ok, detail, record, warnings} */
export async function checkMenu({ newPage, url, game, log = () => {}, shot = null, phones = true }) {
  const T = await newPage('menu');
  const p = T.page, steps = [], warnings = [], fail = [];
  const step = (name, ok, detail = '') => { steps.push({ name, ok: !!ok, detail }); if (!ok) fail.push(`${name}${detail ? ` (${detail})` : ''}`); return !!ok; };
  try {
    await p.goto(`${url}?seed=3&bots=1`, { waitUntil: 'load' });
    await until(async () => (await snapOf(p))?.phase === 'lobby', 90000, 'the game to boot').catch(() => null);
    const home = await until(async () => { const m = await menuOf(p); return m?.view === 'home' ? m : null; }, 8000, 'the home menu').catch(() => null);
    if (!step('opens on the home menu', home, home ? '' : `view ${(await snapOf(p).catch(() => null))?.view ?? 'none'}, phase ${(await snapOf(p).catch(() => null))?.phase ?? '?'}; the game must open on the kit's menu (rules.js never starts the round or hides it)`)) throw new Error('no home menu');
    if (shot) await shot(p, 'menu-home');
    const ids = home.buttons.filter(b => b.shown && b.rect && b.rect.w > 20 && b.rect.h > 14 && b.rect.x >= 0 && b.rect.y >= 0 && b.rect.x + b.rect.w <= 1280 && b.rect.y + b.rect.h <= 720).map(b => b.id);
    const missing = MENU_BUTTONS.filter(id => !ids.includes(id));
    step('every menu button is on screen', !missing.length, missing.length ? `missing or off screen: ${missing.join(', ')}` : MENU_BUTTONS.join(', '));
    const covered = [];
    for (const id of MENU_BUTTONS.filter(i => ids.includes(i))) if (!(await uncovered(p, id))) covered.push(id);
    step('nothing covers the menu', !covered.length, covered.length ? `covered: ${covered.join(', ')}` : '');
    // the games.fun /play page frames the game in a short stage (about 1280 x 460 on a laptop): every button still fits
    for (const [w, h] of [[1024, 460], [390, 700]]) {
      await p.setViewportSize({ width: w, height: h }); await sleep(400);
      const m = await menuOf(p);
      const off = MENU_BUTTONS.filter(id => { const b = m?.buttons?.find(x => x.id === id); return !(b?.shown && b.rect && b.rect.w > 20 && b.rect.h > 14 && b.rect.x >= 0 && b.rect.y >= 0 && b.rect.x + b.rect.w <= w && b.rect.y + b.rect.h <= h); });
      const hid = []; for (const id of MENU_BUTTONS.filter(i => !off.includes(i))) if (!(await uncovered(p, id))) hid.push(id);
      step(`every menu button fits ${w} x ${h}`, !off.length && !hid.length, [off.length ? `off screen: ${off.join(', ')}` : '', hid.length ? `covered: ${hid.join(', ')}` : ''].filter(Boolean).join('; '));
      if (shot && w === 1024) await shot(p, 'menu-short');
    }
    await p.setViewportSize({ width: 1280, height: 720 }); await sleep(300);
    const title = await p.evaluate(() => document.querySelector('#gf-menu h1')?.textContent ?? '');
    const want = game.text?.title ?? game.title ?? '';
    step('shows the title', title && (!want || title === want), `"${title}"${want && title !== want ? ` (the game is "${want}")` : ''}`);

    // How to play: every control the game names, and the goal
    await clickId(p, 'gf-how');
    const how = await menuOf(p);
    // controls.more (CONTRACT §9): a game's own keys, [[keys, what, touch?], ...], each its own row
    const named = Object.entries(game.controls ?? {}).filter(([k, v]) => v && k !== 'more').map(([k, v]) => ({ k, v: String(v) }))
      .concat((Array.isArray(game.controls?.more) ? game.controls.more : []).filter(r => Array.isArray(r) && r[1]).map(r => ({ k: r[0], v: String(r[1]) })));
    const keys = how?.how?.keys ?? [];
    const lost = named.filter(c => !keys.includes(c.v));
    step('How to play lists every control', how?.view === 'how' && !lost.length, how?.view !== 'how' ? `view ${how?.view}` : lost.length ? `missing: ${lost.map(c => `${c.k} "${c.v}"`).join(', ')}` : `${keys.length} rows`);
    step('How to play says the goal', (how?.how?.goal ?? '').replace(/^Goal/, '').trim().length >= 6, `"${(how?.how?.goal ?? '').slice(0, 80)}"`);
    if (shot) await shot(p, 'menu-how');
    await clickId(p, 'gf-back');

    // Settings: real clicks on the sliders
    await clickId(p, 'gf-settings');
    const s0 = await menuOf(p);
    if (step('Settings opens', s0?.view === 'settings', `view ${s0?.view}`)) {
      const hasVol = await p.locator('#gf-volume').count() > 0, hasSens = await p.locator('#gf-sensitivity').count() > 0;
      if (hasVol) { await slide(p, 'gf-volume', 0.4); const s = (await menuOf(p)).settings; step('the volume slider sets the volume', s.volume !== null && Math.abs(s.volume - 40) <= 6 && s.volume !== s0.settings.volume, `${s0.settings.volume}% → ${s.volume}%`); }
      else step('the volume slider sets the volume', false, 'no #gf-volume');
      if (hasSens) { await slide(p, 'gf-sensitivity', 0.8); const s = (await menuOf(p)).settings; step('mouse sensitivity reaches the input', s.lookScale > 1.5 && Math.abs(s.lookScale - s.sensitivity) < 1e-6, `${s0.settings.lookScale} → ${s.lookScale}`); }
      else if (!['top', 'follow'].includes(game.camera ?? 'third')) step('mouse sensitivity reaches the input', false, 'no #gf-sensitivity');
      if (shot) await shot(p, 'menu-settings');
    }
    await clickId(p, 'gf-back');

    // the wallet view on a bare page: where wallets connect, no error
    await clickId(p, 'gf-wallet');
    const w = await menuOf(p);
    step('the wallet view opens', w?.view === 'items' && w.items?.state, `view ${w?.view}, ${w?.items?.state ?? 'no panel'}`);
    await clickId(p, 'gf-back');

    // Play → the round; Esc pauses; Resume; Quit to menu; Play again
    await clickId(p, 'gf-play');
    const playing = await until(async () => { const s = await snapOf(p); return s?.phase === 'playing' ? s : null; }, 15000, 'the round to start').catch(() => null);
    step('Play starts the round', playing && !playing.view, playing ? '' : `phase ${(await snapOf(p))?.phase}`);
    await sleep(1500);
    const hud0 = await p.evaluate(() => window.__game.hud?.() ?? null);
    step('the menu button shows in the round', hud0?.menuButton?.shown, '');
    await p.keyboard.press('Escape'); await sleep(400);
    const paused = await snapOf(p);
    if (step('Esc opens the pause menu', paused?.view === 'pause', `view ${paused?.view}`)) {
      if (shot) await shot(p, 'menu-pause');
      const t1 = paused.time.round; await sleep(1200); const t2 = (await snapOf(p)).time.round;
      step('alone, the pause menu stops the clock', Math.abs(t2 - t1) < 0.05, `${t1} s → ${t2} s over 1.2 s`);
      await clickId(p, 'gf-resume');
      const r1 = await snapOf(p); await sleep(1000); const r2 = await snapOf(p);
      step('Resume carries on', !r1.view && r2.phase === 'playing' && r2.time.round > r1.time.round + 0.5, `view ${r1.view ?? 'none'}, ${r1.time.round} → ${r2.time.round} s`);
      await p.keyboard.press('Escape'); await sleep(400);
      if ((await snapOf(p))?.view === 'pause') {
        await clickId(p, 'gf-leave');
        const back = await until(async () => { const s = await snapOf(p); return s?.phase === 'lobby' && s.view === 'home' ? s : null; }, 5000, 'the home menu').catch(() => null);
        step('Quit to menu goes back to the home menu', back, back ? `round ${back.round}` : `phase ${(await snapOf(p))?.phase}, view ${(await snapOf(p))?.view}`);
        if (back) {
          await clickId(p, 'gf-play');
          const again = await until(async () => { const s = await snapOf(p); return s?.phase === 'playing' ? s : null; }, 15000, 'round 2').catch(() => null);
          step('Play starts the next round', again && again.round > back.round - 1, again ? `round ${again.round}` : 'no round');
        }
      } else step('Quit to menu goes back to the home menu', false, 'Esc did not open the pause menu a second time');
    }
    step('no console errors', T.errors.length === 0, T.errors.slice(0, 2).join(' | '));
  } catch (e) {
    if (!fail.length) fail.push(e.message);
  } finally { await T.ctx.close().catch(() => {}); }
  // ---- on a phone ----
  if (phones) {
    const ph = await menuOnPhones({ newPage, url, shot }).catch(e => ({ ok: false, lines: [`the phone leg could not run: ${e.message}`], record: null }));
    step('the menu fits a phone', ph.ok, ph.ok ? `home, How to play, Settings and the pause menu fit ${PHONE_SIZES.map(s => s.join('x')).join(', ')}` : ph.lines.join(' · '));
  }
  const ok = fail.length === 0 && steps.length > 0;
  log(`menu: ${ok ? 'ok' : fail.join('; ')}`);
  return { ok, detail: ok ? `home menu with ${MENU_BUTTONS.length} buttons, nothing over them; How to play, Settings (volume, sensitivity), the wallet view, Play, Esc pause (clock stopped), Resume, Quit to menu and Play again all worked` : `the menu: ${fail.slice(0, 5).join('; ')}`, record: { steps }, warnings };
}

/** Check 21: the HUD shows the player's state. → {ok, detail, record, warnings} */
export async function checkHud({ newPage, url, game, log = () => {}, shot = null, seconds = 22 }) {
  const want = expectedHud(game);
  const T = await newPage('hud');
  const p = T.page, warnings = [], fail = [], samples = [];
  const hasHealth = want.includes('health');
  try {
    await p.goto(`${url}?seed=5&bots=3${hasHealth ? '&gf-demo=health.hurt' : ''}`, { waitUntil: 'load' });
    await until(async () => (await snapOf(p))?.phase === 'lobby', 90000, 'the game to boot');
    const play = await p.locator('#gf-play').boundingBox();
    await p.mouse.click(play.x + play.width / 2, play.y + play.height / 2);
    await until(async () => (await snapOf(p))?.phase === 'playing', 15000, 'the round to start');
    await p.mouse.click(640, 400); await sleep(300);          // takes the mouse, as a player does
    const t0 = Date.now(); let k = 0, shotTaken = false;
    const keys = ['KeyW', 'KeyA', 'KeyW', 'KeyD', 'KeyS'];
    while (Date.now() - t0 < seconds * 1000) {
      const key = keys[k++ % keys.length];
      await p.keyboard.down(key);
      if (k % 2 === 0) await p.mouse.down();
      for (let i = 0; i < 3; i++) { await sleep(500); const h = await p.evaluate(() => window.__game.hud?.() ?? null).catch(() => null); if (h) samples.push({ t: Math.round((Date.now() - t0) / 100) / 10, ...h }); }
      await p.mouse.up().catch(() => {}); await p.keyboard.up(key);
      await p.mouse.move(640 + ((k % 3) - 1) * 60, 400, { steps: 4 });
      if (!shotTaken && Date.now() - t0 > 9000 && shot) { shotTaken = true; await shot(p, 'hud'); }
    }
  } catch (e) { fail.push(e.message); }
  finally { await T.ctx.close().catch(() => {}); }

  const live = samples.filter(s => s.phase === 'playing' && !s.covered);
  const rows = [];
  if (!live.length) fail.push(samples.length ? 'the HUD was never seen in a round (covered or not playing)' : 'no HUD observation (window.__game.hud missing: the kit is older than the HUD)');
  else {
    const n = live.length, share = f => pct(live.filter(f).length, n);
    const card = share(s => s.card?.shown), btn = share(s => s.menuButton?.shown), goal = share(s => s.goal?.shown && (s.goal.text ?? '').trim().length >= 6);
    rows.push(`player card ${card}%`, `menu button ${btn}%`, `goal line ${goal}%`);
    if (card < 90) fail.push(`the player card was on screen in ${card}% of the round`);
    if (btn < 90) fail.push(`the menu button was on screen in ${btn}% of the round`);
    if (goal < 90) fail.push(`the goal line was on screen in ${goal}% of the round${live[0].goal?.text ? '' : ' (no goal text: config/game.json → text.goal)'}`);
    for (const id of want) {
      const ws = live.map(s => ({ s, w: (s.widgets ?? []).find(x => x.id === id) }));
      const have = ws.filter(x => x.w);
      if (!have.length) { fail.push(`no ${id} on the HUD (the game has ${id === 'health' ? 'health with hit points' : `the ${id} mechanic`})`); continue; }
      const relevant = have.filter(x => x.w.truth && !x.w.truth.error);
      const shown = relevant.filter(x => x.w.shown);
      const agree = relevant.filter(x => matches(id, x.w));
      const sh = pct(shown.length, relevant.length), ag = pct(agree.length, relevant.length);
      let line = `${id} on screen ${sh}%, shows the state ${ag}%`;
      if (relevant.length && sh < 90) fail.push(`${id} was on screen in ${sh}% of the round`);
      if (relevant.length && ag < 90) fail.push(`${id} showed something else than the game's state in ${100 - ag}% of samples (e.g. shows ${JSON.stringify(relevant.find(x => !matches(id, x.w))?.w.shows)}, state ${JSON.stringify(relevant.find(x => !matches(id, x.w))?.w.truth)})`);
      if (id === 'health') {
        const truths = new Set(relevant.map(x => x.w.truth.value)), shownVals = new Set(shown.map(x => x.w.shows.value));
        line += `, ${truths.size} hit-point values seen, ${shownVals.size} shown`;
        if (truths.size >= 2 && shownVals.size < 2) fail.push('health never moved on the HUD though the player lost hit points');
        if (truths.size < 2) warnings.push('hud: the player\'s hit points never changed in the round (?gf-demo=health.hurt was refused?), so health was only seen full');
      }
      rows.push(line);
    }
    // the knocked-down or out state, when it happened
    const downs = live.filter(s => { const st = (s.widgets ?? []).find(x => x.id === 'status'); return st?.truth?.state === 'down' || st?.truth?.state === 'out'; });
    if (downs.length) {
      const seen = pct(downs.filter(s => (s.widgets ?? []).find(x => x.id === 'status')?.shown).length, downs.length);
      rows.push(`down or out ${downs.length} samples, shown ${seen}%`);
      if (seen < 80) fail.push(`the player was down or out in ${downs.length} samples and the HUD said so in ${seen}%`);
    }
  }
  const ok = fail.length === 0;
  log(`hud: ${ok ? 'ok' : fail.join('; ')}`);
  return { ok, detail: ok ? `${live.length} samples in a ${seconds} s round with 3 bots: ${rows.join('; ')}` : `the HUD: ${fail.slice(0, 5).join('; ')}${rows.length ? ` (${rows.join('; ')})` : ''}`, record: { expected: want, samples: live.length, rows, last: live.at(-1) ?? null }, warnings };
}
function matches(id, w) {
  const a = w.shows ?? {}, b = w.truth ?? {};
  if (id === 'health') return Math.abs(Number(a.value) - Math.round(b.value * 10) / 10) < 0.051 && Number(a.max) === Number(b.max);
  // a wave a runtime draws in its own words (forge: "Wave 1 of 3 · 4 remain"): the numbers, not the card's wording; it
  // may count what is still to fall in the wave (alive and yet to rise), never fewer than are alive
  if (w.by === 'runtime' && b.wave !== undefined) return Number(a.wave) === Number(b.wave) && Number(a.alive) >= Number(b.alive);
  if (Number.isFinite(b.value) && b.text === undefined) return Math.abs(Number(a.value) - b.value) < 0.021;
  if (w.by === 'runtime' && Number.isFinite(b.value)) return Math.abs(Number(a.value) - b.value) < 0.021;
  if (b.text !== undefined) return a.text === b.text;
  return true;
}

// ---- check 22: the stand-in for the games.fun /play page ----
const HOST_HTML = gameUrl => `<!doctype html><meta charset="utf-8"><title>host</title>
<style>html,body{margin:0;height:100%;background:#111}iframe{border:0;width:100%;height:100%;display:block}</style>
<iframe id="game" src="${gameUrl}" allow="autoplay; fullscreen" sandbox="allow-scripts allow-same-origin allow-pointer-lock"></iframe>
<script>
// The /play page's side of kit/net/host.js (creator-studio/components/play/play-room.tsx), with one test wallet.
const ICON = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" rx="2" fill="#7b5cff"/></svg>');
const ITEMS = [
  { itemId: 1, name: 'Test colour', rarity: 3, rarityName: 'Epic', image: null, wearable: true, count: 1, what: 'Changes how you look', look: { 'character.tint.player': '#23c64a' } },
  { itemId: 2, name: 'Test badge', rarity: 0, rarityName: 'Common', image: null, wearable: false, count: 2, what: 'A collectible' },
];
const H = window.__host = { log: [], game: null, status: 'none', worn: [], address: '', econ: false, gold: 12, claim: 3, staked: 0, pending: [] };
// the economy (CONTRACT §6g W2): offered only once the check asks (H.offer), one button per place; the page's state after
// each click is its own make-believe (no wallet, no network, no money)
const ECON = { actions: [
  { id: 'shop-sword', kind: 'buy', label: 'Buy a test sword', price: { amount: '0.1', currency: 'SOL' }, says: 'A test item', where: 'menu' },
  { id: 'stake-gold', kind: 'stake', label: 'Stake 5 gold', price: { amount: '5', currency: 'GOLD' }, says: 'Earn while you play', where: 'pause' },
  { id: 'claim-prize', kind: 'claim', label: 'Claim', where: 'results' },
  { id: 'gold', kind: 'hold', label: 'Gold', where: 'hud' },
] };
const hostMsg = () => ({ type: 'gf:host', v: 1, wallet: true, friends: true, shop: true, ...(H.econ ? { economy: ECON } : {}) });
const econ = () => ({ type: 'gf:economy', v: 1, balances: [{ id: 'gold', label: 'Gold', amount: H.gold, symbol: 'GOLD' }], tickets: [], stakes: [{ id: 'stake-gold', amount: H.staked, symbol: 'GOLD' }], claimable: [{ id: 'claim-prize', amount: H.claim, symbol: 'GOLD' }], pending: H.pending, error: '' });
H.offer = () => { H.econ = true; post(hostMsg()); post(econ()); };
H.setGold = n => { H.gold = n; post(econ()); };
const wallet = () => ({ type: 'gf:wallet', status: H.status, wallets: [{ name: 'Test Wallet', icon: ICON }], address: H.address, short: H.address ? H.address.slice(0, 4) + '…' + H.address.slice(-4) : '', name: H.status === 'none' ? '' : 'Test Wallet', icon: H.status === 'connected' ? ICON : null, error: '',
  items: H.status === 'connected' ? ITEMS.map(({ look, ...i }) => ({ ...i, worn: H.worn.includes(i.itemId) })) : null, boxes: [{ name: 'Test box', price: '5', symbol: 'TEST', url: location.origin + '/box/test/1' }] });
const loadout = () => { const values = {}; for (const id of H.worn) Object.assign(values, ITEMS.find(i => i.itemId === id)?.look ?? {}); return Object.keys(values).length ? { values, files: {}, pass: null } : null; };
const post = m => { try { H.game?.postMessage(m, '*'); } catch {} };
addEventListener('message', e => {
  const d = e.data; if (!d || typeof d !== 'object' || typeof d.type !== 'string' || !d.type.startsWith('gf:')) return;
  H.log.push({ type: d.type, ...(d.wallet !== undefined ? { wallet: d.wallet } : {}), ...(d.item !== undefined ? { item: d.item, on: d.on } : {}), ...(d.key !== undefined ? { key: d.key } : {}), ...(d.id !== undefined ? { id: d.id } : {}) });
  if (d.type === 'gf:loadout-ready' || d.type === 'gf:host-ready') { H.game = e.source; post({ type: 'gf:loadout', loadout: loadout() }); post(hostMsg()); post(wallet()); if (H.econ) post(econ()); return; }
  if (e.source !== H.game) return;
  if (d.type === 'gf:econ-action' && H.econ && ECON.actions.some(a => a.id === d.id)) {
    H.pending = [d.id]; post(econ());
    setTimeout(() => { H.pending = []; if (d.id === 'claim-prize') { H.gold += H.claim; H.claim = 0; } if (d.id === 'stake-gold') { H.gold -= 5; H.staked += 5; } post(econ()); }, 300);
  }
  if (d.type === 'gf:wallet-connect' && d.wallet === 'Test Wallet' && H.status !== 'connected') { H.status = 'connecting'; post(wallet()); setTimeout(() => { H.status = 'connected'; H.address = 'GfTe5tWa11etAddre55000000000000000000000001'; post(wallet()); }, 400); }
  if (d.type === 'gf:wallet-disconnect') { H.status = 'none'; H.address = ''; H.worn = []; post(wallet()); post({ type: 'gf:loadout', loadout: null }); }
  if (d.type === 'gf:wear' && H.status === 'connected') { const i = ITEMS.find(x => x.itemId === d.item); if (i?.wearable) { H.worn = d.on ? [...new Set([...H.worn, i.itemId])] : H.worn.filter(x => x !== i.itemId); post(wallet()); post({ type: 'gf:loadout', loadout: loadout() }); } }
});
</script>`;

/** Check 22: the wallet in the home menu, through a stand-in for the /play page. → {ok, detail, record, warnings}
 * clock: for a runtime with no stepped time (forge: kit/core/boot-forge.js has no window.__game.step), the economy page
 * plays in real time on a round cut to `clock` seconds (config/game.json /round/seconds through the overrides, as check 6
 * does), and still reaches the results card. 0 (the party and scenic boots): stepped time.
 * world: a world (CONTRACT §9) has no round and no results card, so the economy's page is not played there (a note says
 * so). Until 2026-10-12 it was: the round never ended, and the stepped frames' world polls ran the world server's limit
 * of 120 reads a minute out, so every world check after 22 read 429 (Blockhaven's release verify). */
export async function checkWallet({ newPage, url, log = () => {}, shot = null, clock = 0, world = false }) {
  const gameUrl = `${url}${url.includes('?') ? '&' : '?'}seed=4&bots=1`;
  const html = HOST_HTML(gameUrl), htmlStep = HOST_HTML(`${gameUrl}&gf-step=1`);
  // /step: the economy's page, the game in stepped time (kit/core/step.js) so a whole round ends in seconds
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(req.url.startsWith('/step') ? htmlStep : html); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const hostUrl = `http://127.0.0.1:${server.address().port}/`;
  const T = await newPage('wallet');
  const p = T.page, steps = [], fail = [], warnings = [];
  const step = (name, ok, detail = '') => { steps.push({ name, ok: !!ok, detail }); if (!ok) fail.push(`${name}${detail ? ` (${detail})` : ''}`); return !!ok; };
  const F = p.frameLocator('#game');
  const frame = () => p.frames().find(f => f !== p.mainFrame());
  const gm = () => frame()?.evaluate(() => window.__game?.menu?.() ?? null).catch(() => null);
  const hostLog = () => p.evaluate(() => window.__host.log.map(x => x.type));
  const click = async sel => { await F.locator(sel).first().click({ timeout: 5000 }); await sleep(300); };
  try {
    await p.goto(hostUrl, { waitUntil: 'load' });
    await until(async () => { const m = await gm(); return m?.view === 'home' ? m : null; }, 90000, 'the game\'s home menu');
    const m0 = await until(async () => { const m = await gm(); return m?.wallet?.present ? m : null; }, 8000, 'the game to hear the page').catch(() => null);
    if (!step('the game hears the page', m0, m0 ? '' : `the game never took the page's gf:host (page heard: ${(await hostLog()).join(', ') || 'nothing'})`)) throw new Error('no host');
    await noEconomy(frame, step, 'the home menu', m0);
    await click('#gf-wallet');
    const m1 = await gm();
    step('the wallet view lists the page\'s wallets', m1?.view === 'items' && m1.items?.picks?.includes('Test Wallet'), `view ${m1?.view}, state ${m1?.items?.state}, wallets ${JSON.stringify(m1?.items?.picks ?? [])}`);
    if (shot) await shot(p, 'wallet-pick');
    await click('.gf-wallet-pick[data-wallet="Test Wallet"]');
    step('a click asks the page to connect', (await hostLog()).includes('gf:wallet-connect'), '');
    const m2 = await until(async () => { const m = await gm(); return m?.items?.state === 'connected' && m.items.list.length ? m : null; }, 6000, 'connected').catch(() => null);
    step('the menu shows the wallet and its items', m2, m2 ? `${m2.wallet.short}, items ${m2.items.list.map(i => i.itemId).join(', ')}` : `state ${(await gm())?.items?.state}`);
    if (shot) await shot(p, 'wallet-items');
    if (m2) await noEconomy(frame, step, 'the wallet view', m2);
    if (m2) {
      await click('.gf-item[data-item="1"] .gf-wear');
      const asked = (await p.evaluate(() => window.__host.log.filter(x => x.type === 'gf:wear'))).find(x => x.item === 1 && x.on === true);
      step('Wear asks the page', asked, '');
      const looked = await until(async () => {
        const L = await frame()?.evaluate(() => window.__game?.looks?.() ?? null).catch(() => null);
        const me = L?.players?.find(x => x.local);
        return me && me.values?.['character.tint.player']?.toLowerCase() === '#23c64a' ? { L, me } : null;
      }, 6000, 'the loadout').catch(() => null);
      step('the page\'s loadout reaches the game', looked, looked ? `key ${looked.me.key}` : 'the local player never took the item\'s colour');
      if (looked) {
        const d = looked.me.drawn ?? {};
        const drawn = [d.bodyTint, d.material, d.tint].filter(Boolean).map(x => String(x).toLowerCase());
        if (drawn.length) step('the player is drawn in the item\'s colour', drawn.includes('#23c64a'), `drawn ${JSON.stringify(d)}`);
        else warnings.push(`wallet: the looks observation has no drawn colour to compare (${JSON.stringify(d)})`);
      }
      const m3 = await gm();
      step('the menu marks the item worn', m3?.items?.list?.find(i => i.itemId === 1)?.worn, '');
      await click('#gf-back');
      const m4 = await gm();
      const wb = m4?.buttons?.find(b => b.id === 'gf-wallet');
      step('the home menu shows the connected wallet', wb && wb.label.includes('…'), `"${wb?.label ?? ''}"`);
      await click('#gf-wallet'); await click('#gf-disconnect');
      const m5 = await until(async () => { const m = await gm(); return m?.items?.state === 'none' ? m : null; }, 4000, 'disconnected').catch(() => null);
      step('Disconnect clears it', m5 && (await hostLog()).includes('gf:wallet-disconnect'), m5 ? '' : `state ${(await gm())?.items?.state}`);
      await click('#gf-back');
    }
    await click('#gf-friends');
    step('Play with friends asks the page', (await hostLog()).includes('gf:friends'), '');
    step('no console errors', T.errors.length === 0, T.errors.slice(0, 2).join(' | '));
  } catch (e) { if (!fail.length) fail.push(e.message); }
  finally { await T.ctx.close().catch(() => {}); }
  // the economy's buttons (CONTRACT §6g W2), on a page of their own
  const E = { steps: [], fail: [] };
  if (world) warnings.push('the wallet in the menu: a world has no round or results card; the economy\'s buttons are not played here (check 22\'s economy page)');
  else if (!fail.length) {
    try { await checkEconomy({ newPage, hostUrl: clock ? `${hostUrl}real` : `${hostUrl}step`, shot, E, clock }); }
    catch (e) { if (!E.fail.length) E.fail.push(`the economy: ${e.message}`); }
  }
  await new Promise(r => server.close(r));
  steps.push(...E.steps); fail.push(...E.fail);
  const ok = fail.length === 0 && steps.length > 0;
  log(`wallet: ${ok ? 'ok' : fail.join('; ')}`);
  return { ok, detail: ok ? 'framed by a stand-in /play page: the menu listed its wallet, connected through the page, showed the address and 2 items, wore one through the page (the player drawn in its colour), disconnected, and Play with friends asked the page' + (world ? ' (a world: no round or results card, so the economy\'s page was not played)' : '; with no economy offered nothing of it showed (home, wallet view, HUD, pause, results), then each of the page\'s economy buttons showed only where it said (results card, wallet view, pause menu) and a real click asked the page, and the HUD line showed and followed the page\'s state') + (clock ? ` (the economy page in real time on a ${clock} s round: this runtime has no stepped time)` : '') : `the wallet in the menu: ${fail.slice(0, 5).join('; ')}`, record: { steps }, warnings };
}

// ---- check 22, the economy (CONTRACT §6g W2): the page's buttons and lines, drawn by the kit, clicks told to the page ----
/** Every economy element on screen in the game's frame: [{id, where, text, clear}] (clear: nothing drawn over its middle). */
async function econOnScreen(frame) {
  const f = frame(); if (!f) return null;
  return f.evaluate(() => [...document.querySelectorAll('[data-econ], .gf-econ')].map(e => {
    const r = e.getBoundingClientRect();
    const vis = typeof e.checkVisibility === 'function' ? e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : e.offsetParent !== null;
    const inView = r.width > 2 && r.height > 2 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
    const at = inView ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
    return { id: e.dataset.econ ?? null, where: e.closest('[data-where]')?.dataset.where ?? null, text: e.textContent.trim().slice(0, 60), seen: (e.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80), shown: !!(vis && inView), clear: !!at && (at === e || e.contains(at)) };
  }).filter(x => x.shown)).catch(() => null);
}
const econNames = on => on.map(x => x.id ?? `a '${x.where}' box`).join(', ');
/** With no economy offered, nothing of it is on screen, and the observation has no offer. */
async function noEconomy(frame, step, place, m) {
  const on = await econOnScreen(frame), offers = m?.economy?.offers?.length ?? 0;
  return step(`no economy offered: nothing of it in ${place}`, on && !on.length && !offers, on === null ? 'could not read the page' : on.length ? `on screen: ${econNames(on)}` : offers ? `${offers} offers the page never made` : '');
}

async function checkEconomy({ newPage, hostUrl, shot, E, clock = 0 }) {
  // real time (clock > 0): the round's clock cut to `clock` seconds, the same overrides check 6 uses on forge
  const T = await newPage('economy', clock ? { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: clock }] } } : {});
  const p = T.page;
  const step = (name, ok, detail = '') => { E.steps.push({ name, ok: !!ok, detail }); if (!ok) E.fail.push(`${name}${detail ? ` (${detail})` : ''}`); return !!ok; };
  const F = p.frameLocator('#game');
  const frame = () => p.frames().find(f => f !== p.mainFrame());
  const gm = () => frame()?.evaluate(() => window.__game?.menu?.() ?? null).catch(() => null);
  const gs = () => frame()?.evaluate(() => window.__game?.snapshot?.() ?? null).catch(() => null);
  // stepped time: one step of ms; real time: ms of the wall clock, then the game's state (a frame is drawn on its own)
  const advance = clock ? async ms => { if (ms) await sleep(ms); return gs(); }
    : (ms, draw = true) => frame()?.evaluate(([ms, draw]) => window.__game?.step?.(ms, { draw }) ?? null, [ms, draw]).catch(() => null);
  const econAsked = () => p.evaluate(() => window.__host.log.filter(x => x.type === 'gf:econ-action').map(x => x.id));
  const click = async sel => { await F.locator(sel).first().click({ timeout: 5000 }); await sleep(300); };
  const has = async sel => (await F.locator(sel).count()) > 0;
  /** Play the round in stepped time until it reaches a phase (draw only the last frame). */
  async function stepTo(phase, ms, chunk) {
    if (clock) return until(async () => { const s = await gs(); return s?.phase === phase ? s : null; }, phase === 'results' ? (clock + 10) * 1000 : Math.max(ms, 15000), `phase ${phase}`).catch(() => null);
    for (let t = 0; t <= ms; t += chunk) { const r = await advance(chunk, false); if (!r) return null; if (r.phase === phase) { await advance(50); return r; } } return null; }
  /** One place: its button is on screen, in that place, with nothing over it, and no other economy button is. */
  async function placeHolds(where, id, what, price = null) {
    const on = (await econOnScreen(frame)) ?? [];
    // a paid button shows its price in the text a player can read (not in a line that hides in a short window)
    if (price) { const b = on.find(x => x.id === id); step(`the '${where}' button shows its price (${price}) on screen at ${p.viewportSize()?.height ?? '?'} px high`, b && b.seen.includes(price), b ? `reads "${b.seen}"` : 'not on screen'); }
    const btn = on.find(x => x.id === id), others = on.filter(x => x.id && x.id !== id);
    return step(`the economy's '${where}' button is ${what}, and only it`, btn && btn.where === where && btn.clear && !others.length,
      !btn ? `not on screen (on screen: ${econNames(on) || 'nothing of the economy'})` : btn.where !== where ? `drawn in '${btn.where}'` : !btn.clear ? 'something is drawn over it' : others.length ? `also on screen: ${others.map(x => x.id).join(', ')}` : `"${btn.text}"`);
  }
  /** Run a look at the studio preview's short window (787 x 613), then put the window back. */
  async function shortWindow(fn) {
    const was = p.viewportSize(); await p.setViewportSize({ width: 787, height: 613 }); await sleep(500); await advance(50);
    try { return await fn(); } finally { if (was) { await p.setViewportSize(was); await sleep(400); await advance(50); } }
  }
  /** A real click on a place's button sends gf:econ-action with its id to the page. */
  async function clickAsks(where, id) {
    const before = (await econAsked()).length, sel = `[data-where="${where}"] [data-econ="${id}"]`;
    if (await has(sel)) await click(sel);
    const asked = await until(async () => { const l = await econAsked(); return l.length > before && l.at(-1) === id ? l : null; }, 3000, 'gf:econ-action').catch(() => null);
    step(`a click on the '${where}' button asks the page (gf:econ-action ${id})`, asked, asked ? '' : `the page heard ${JSON.stringify((await econAsked()).slice(before))}`);
    await sleep(500);       // the page's answer: pending, then its new state
  }
  try {
    await p.goto(hostUrl, { waitUntil: 'load' });
    await until(async () => { const m = await gm(); return m?.view === 'home' && m.wallet?.present ? m : null; }, 90000, 'the economy page\'s game to hear the page');
    if (clock) { const s0 = await gs(); if (!step(`the economy page runs in real time, its round cut to ${clock} s (no stepped time on this runtime)`, s0, s0 ? `phase ${s0.phase}` : 'no window.__game.snapshot')) throw new Error('no game state'); }
    else if (!step('the economy page runs in stepped time', await advance(0), 'no window.__game.step (?gf-step=1)')) throw new Error('no stepped time');
    // with no offer: nothing in the HUD, the pause menu or the results card
    await click('#gf-play');
    if (!step('Play starts the round', await stepTo('playing', 8000, 500), `phase ${(await gs())?.phase}`)) throw new Error('no round');
    await advance(600);
    await noEconomy(frame, step, 'the HUD', await gm());
    await F.locator('body').press('Escape'); await sleep(300); await advance(50);      // a frame, so the HUD hides under the menu
    if ((await gm())?.view === 'pause') { await noEconomy(frame, step, 'the pause menu', await gm()); await click('#gf-resume'); }
    else step('Esc opens the pause menu', false, `view ${(await gm())?.view}`);
    const tEnd = Date.now(), ended = await stepTo('results', 900000, 10000);
    if (!step(clock ? `the round ends (real time, a ${clock} s clock)` : 'the round ends (stepped time)', ended, !clock ? `phase ${(await gs())?.phase}`
      : ended ? `results ${((Date.now() - tEnd) / 1000).toFixed(1)} s after Resume` : `phase ${(await gs())?.phase} ${clock + 10} s after Resume (the round's clock was cut to ${clock} s through the overrides)`)) throw new Error('no results');
    await sleep(200);
    await noEconomy(frame, step, 'the results card', await gm());
    // the page offers one button per place, and its state
    await p.evaluate(() => window.__host.offer());
    const m1 = (await until(async () => { const m = await gm(); return m?.economy?.offers?.length ? m : null; }, 3000, 'the offer').catch(() => null)) ?? await gm();
    step('the game takes the page\'s economy offer', m1?.economy?.offers?.length === 4 && m1.economy.state, `the game took ${m1?.economy?.offers?.length ?? 0} of the page's 4 economy offers${m1?.economy?.state ? '' : ', and no gf:economy state'}`);
    await placeHolds('results', 'claim-prize', 'on the results card');
    if (shot) await shot(p, 'economy-results');
    await clickAsks('results', 'claim-prize');
    // the wallet view has the 'menu' button; the home view itself has none
    if (await has('#gf-to-menu')) { await click('#gf-to-menu'); await advance(50); }
    await until(async () => (await gm())?.view === 'home', 4000, 'the home menu').catch(() => null);
    const home = (await econOnScreen(frame)) ?? [];
    step('the home view shows no economy button (\'menu\' ones are in the wallet view)', !home.length, econNames(home));
    await click('#gf-wallet');
    await placeHolds('menu', 'shop-sword', 'in the wallet view', '0.1 SOL');
    await shortWindow(async () => { await placeHolds('menu', 'shop-sword', 'in the wallet view', '0.1 SOL'); if (shot) await shot(p, 'economy-menu-613'); });
    if (shot) await shot(p, 'economy-menu');
    await clickAsks('menu', 'shop-sword');
    await click('#gf-back');
    // the HUD line, from the page's state, and following it
    await click('#gf-play');
    if (!step('Play starts the next round', await stepTo('playing', 8000, 500), `phase ${(await gs())?.phase}`)) throw new Error('no second round');
    await advance(600);
    const gold = await p.evaluate(() => window.__host.gold);
    const line = async () => ((await econOnScreen(frame)) ?? []).find(x => x.id === 'gold');
    const l1 = await line(), onHud = ((await econOnScreen(frame)) ?? []).filter(x => x.id);
    step('the economy\'s \'hud\' line is in the HUD\'s player card, and only it', l1 && l1.where === 'hud' && onHud.length === 1, l1 ? `"${l1.text}"${onHud.length > 1 ? `; also ${onHud.filter(x => x.id !== 'gold').map(x => x.id).join(', ')}` : ''}` : `not on screen (${econNames(onHud) || 'nothing of the economy'})`);
    step('the HUD line shows the page\'s state', l1?.text?.includes(`${gold} GOLD`), `"${l1?.text ?? ''}", the page's gold ${gold}`);
    if (shot) await shot(p, 'economy-hud');
    await p.evaluate(() => window.__host.setGold(42));
    await sleep(300); await advance(100);
    const l2 = await until(async () => { const l = await line(); return l?.text?.includes('42 GOLD') ? l : null; }, 3000, 'the HUD line').catch(() => null);
    step('the HUD line follows a gf:economy change', l2, `"${(await line())?.text ?? ''}" after the page said 42`);
    // the pause menu has the 'pause' button
    await F.locator('body').press('Escape'); await sleep(300); await advance(50);      // a frame, so the HUD hides under the menu
    await placeHolds('pause', 'stake-gold', 'in the pause menu', '5 GOLD');
    await shortWindow(() => placeHolds('pause', 'stake-gold', 'in the pause menu', '5 GOLD'));
    if (shot) await shot(p, 'economy-pause');
    await clickAsks('pause', 'stake-gold');
    const m2 = await gm(), sent = m2?.economy?.sent ?? [];
    step('the observation has the offers, the state and the clicks', m2?.economy?.offers?.length === 4 && m2.economy.state && ['claim-prize', 'shop-sword', 'stake-gold'].every(id => sent.includes(id)), `offers ${m2?.economy?.offers?.length ?? 0}, state ${m2?.economy?.state ? 'yes' : 'none'}, sent ${JSON.stringify(sent)}`);
    step('no console errors (the economy page)', T.errors.length === 0, T.errors.slice(0, 2).join(' | '));
  } finally { await T.ctx.close().catch(() => {}); }
}

