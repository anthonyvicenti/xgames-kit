// verify check 20's forge leg (CONTRACT §8 forge; §6g the home menu): How to play's key table held to what the keys do.
// Kept apart from tools/verify-forge.mjs, which calls checkForgeKeys after the shared menu check
// (tools/lib/menu-check.mjs checkMenu: the menu's buttons, How to play lists every control, Settings, the wallet, pause).
//
// Why forge has its own (wave 3, track S3, 2026-10-10; regressions/forge-sprint-key): the shared check asks that How to
// play lists every control the game names. It never asks what the table's own rows promise. The first play-test of a
// forge game (gf-forge/evidence/wave2-S2-2026-10-10/playtest/DEFECTS.md) found "How to play says 'Shift:
// Sprint' and Shift is the evade": the kit's table says Shift sprints unless the game's own rows (config/game.json →
// controls.more: [keys, what, touch]) say what Shift does, and on forge Shift evades and nothing sprints. Check 13
// presses the four named actions (jump, primary, secondary, interact) and no other key, so a `more` row whose key does
// nothing, or something else than its words, passed everything.
//
// What it does: one page on the quiet staged moment check 13 uses (?gf-demo=controls: no waves), bots off, with every
// weapon a player can hold in their hands (forge-feel-check.mjs holdableWeapons, each `start` set true as Studio
// overrides a value: the moment a "pick a weapon" row is for).
//   the table   the home menu's How to play is opened and its rows read as a player reads them: the keys and the words
//   each key    Shift and every row of the game's own keys (a letter, a digit, a range like 1–4) is pressed with a
//               real key and the core's answer read from the feel view: an evade (evading), a reload (reloading; a
//               shot is fired first so there is something to load), a swing (the quick melee), another weapon in hand,
//               a jump, a shot; or some other value of the game's state that does not change by itself
//   sprint      a row that says sprint or run is also walked: W held with and without the key, the steady speed after
//               the first 0.4 s (an evade's dash is over by then)
// A row fails when its key changes nothing (DEAD), or when its words name one of those actions and the key did another
// (says "Sprint", evades). Words that name none of them are not held to anything but doing something, and the detail
// says so. Rows the other checks own are left to them: W A S D and the mouse (check 3), Space, click, right click and E
// (check 13), Esc (the menu check). Budget: about 15 s.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { POINTER_LOCK, holdableWeapons } from './forge-feel-check.mjs';
import { flat, changed } from './forge-controls-check.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = v => Math.round(v * 100) / 100;
export const FORGE_KEY_LIMITS = { WATCH_MS: 520, IDLE_READS: 10, SPRINT_TIMES: 1.2, WALK_FROM_MS: 420, WALK_MS: 520, JUMP_RISE: 0.25 };

/** What a row's words say the key does, among the actions the core has (and sprint, which it has not). (pure) */
const SAYS = {
  evade: /\b(evades?|dodges?|dash(es)?|rolls?|side\s?steps?|dives?)\b/i,
  sprint: /\b(sprints?|runs?|running|hurry)\b/i,
  reload: /\b(reloads?|rechamber)\b/i,
  melee: /\b(melee|cuts?|strikes?|slash(es)?|swings?|stabs?|bash(es)?|hacks?|chops?|punch(es)?|kicks?|cleaves?)\b/i,
  switch: /\b(weapons?|swaps?|switch(es)?|picks?|selects?|cycles?)\b/i,
  jump: /\b(jumps?|hops?|vaults?)\b/i,
  fire: /\b(fires?|shoots?|shots?)\b/i,
};
export function wordsSay(words) { return Object.keys(SAYS).filter(k => SAYS[k].test(String(words ?? ''))); }
const DOES = { evade: 'evades (a short dash)', reload: 'reloads', melee: 'swings the quick melee', switch: 'brings up another weapon', jump: 'jumps', fire: 'fires', sprint: 'walks faster while held', other: 'changes the game\'s state' };

/** A key label of the table → the keys to press: "Shift" → [ShiftLeft], "R" → [KeyR], "1–4" → [Digit1..Digit4]; null
 *  for a label this check leaves to another (the mouse, W A S D, Space, clicks, E, Esc) or cannot press. (pure) */
export function keysOf(label) {
  const s = String(label ?? '').trim();
  if (/^shift$/i.test(s)) return ['ShiftLeft'];
  if (/^(ctrl|control)$/i.test(s)) return ['ControlLeft'];
  if (/^tab$/i.test(s)) return ['Tab'];
  if (/^[A-Za-z]$/.test(s)) return /^[wasdeWASDE]$/.test(s) ? null : [`Key${s.toUpperCase()}`];
  if (/^[0-9]$/.test(s)) return [`Digit${s}`];
  const range = /^([0-9])\s*[–—-]\s*([0-9])$/.exec(s);
  if (range) { const out = []; for (let d = Number(range[1]); d <= Number(range[2]); d++) out.push(`Digit${d}`); return out.length ? out : null; }
  return null;
}

/**
 * The verdict on one row (pure). row: {keys: 'Shift', words: 'Sprint'}; did: the effects its keys had (a list among
 * evade, reload, melee, switch, jump, fire, sprint, other); walk: {plain, held} m/s when the row was walked.
 * → {ok, why}
 */
export function judgeKeyRow(row, did, walk = null) {
  const says = wordsSay(row.words), known = did.filter(d => d !== 'other');
  const speeds = walk ? ` (W alone ${r2(walk.plain)} m/s, with it ${r2(walk.held)} m/s)` : '';
  if (!did.length) return { ok: false, why: `"${row.keys}" says "${row.words}": DEAD, the key changed nothing in the game${says.includes('sprint') ? `, and holding it walks no faster${speeds}` : ''}` };
  if (says.some(s => did.includes(s))) return { ok: true, why: `${row.keys} "${row.words}": it ${DOES[says.find(s => did.includes(s))]}` };
  if (says.length && known.length) return { ok: false, why: `"${row.keys}" says "${row.words}"; ${row.keys} ${known.map(d => DOES[d]).join(' and ')}${says.includes('sprint') ? `, and holding it walks no faster${speeds}` : ''}` };
  if (says.length) return { ok: false, why: `"${row.keys}" says "${row.words}"; ${row.keys} did none of that (the game's state changed some other way)` };
  return { ok: true, why: `${row.keys} "${row.words}": the key ${known.length ? known.map(d => DOES[d]).join(' and ') : 'changes the game\'s state'} (its words name no action of the core, so only that it does something was held)`, unheld: true };
}

/** In the page: what a key could change. */
const READ = () => {
  const g = window.__game; if (!g) return null;
  const s = g.snapshot(), f = g.forge?.feel?.() ?? null, c = g.forge?.players?.().find(p => p.local) ?? null, d = g.forge?.drawn?.() ?? null;
  const v = f?.shown?.view ?? null;
  return { phase: s.phase, v, x: c?.x ?? null, y: c?.y ?? null, z: c?.z ?? null,
    sig: { view: v && Object.fromEntries(Object.entries(v).filter(([k]) => !['swayX', 'swayY', 'bobX', 'bobY', 'viewKick', 'recoil', 'shake', 'fov', 'tint'].includes(k))), swings: d?.swings ?? null, shared: s.shared ?? null, rules: s.rules ?? null, scores: s.players.map(p => p.score) } };
};
/** In the page: How to play's rows as shown: [{keys: 'Click · F', words}] (the menu must be on its How to play view). */
const ROWS = () => {
  const dl = document.getElementById('gf-how-keys'); if (!dl) return null;
  const out = []; let keys = null;
  for (const e of dl.children) {
    if (e.tagName === 'DT') keys = [...e.querySelectorAll('kbd')].map(k => k.textContent.trim()).join(' · ') || e.textContent.trim();
    else if (e.tagName === 'DD' && keys !== null) { out.push({ keys, words: e.textContent.trim() }); keys = null; }
  }
  return out;
};

/** Check 20's forge leg. dir: the game folder (rules.js says whether the rules arm players). → {ok, detail, record, warnings} */
export async function checkForgeKeys({ newPage, url, game, dir = null, shot = async () => null, log = () => {} }) {
  const L = FORGE_KEY_LIMITS, warnings = [], t0 = Date.now();
  const weapons = game.forge?.weapons ?? [];
  const rulesText = dir ? await readFile(join(dir, 'rules.js'), 'utf8').catch(() => '') : '';
  const hold = holdableWeapons(game, rulesText);
  const patches = [{ file: 'config/game.json', pointer: '/round/seconds', value: 180 }, ...hold.filter(x => weapons[x.row].start === false).map(x => ({ file: 'config/game.json', pointer: `/forge/weapons/${x.row}/start`, value: true }))];
  const T = await newPage('how to play keys', { overrides: { patches } });
  const p = T.page;
  await p.addInitScript(POINTER_LOCK);
  const read = () => p.evaluate(READ);
  const record = { url: '?seed=7&bots=0&gf-demo=controls', holdable: hold.map(x => x.id), rows: [], results: [] };
  const results = [];
  let stopped = null;
  try {
    await p.goto(`${url}?seed=7&bots=0&gf-demo=controls`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    // the table as a player reads it
    await p.locator('#gf-how').click({ timeout: 8000 }); await sleep(300);
    const rows = await p.evaluate(ROWS);
    if (!rows) throw new Error('How to play shows no key table (#gf-how-keys)');
    record.rows = rows;
    await shot(p, 'how-keys');
    await p.locator('#gf-back').click({ timeout: 5000 }); await sleep(250);
    await p.click('#gf-play');
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 20000) throw new Error('the round did not start'); await sleep(120); }
    await sleep(2400);                                              // the "Go!" banner and the opening grace
    const vp = p.viewportSize() ?? { width: 1280, height: 720 };
    await p.mouse.move(vp.width / 2, vp.height / 2); await p.mouse.click(vp.width / 2, vp.height / 2); await sleep(900);   // takes the mouse (a click is a shot: something to reload)

    // what changes by itself, with no key down
    const noisy = new Set();
    let prev = flat((await read()).sig);
    for (let i = 0; i < L.IDLE_READS; i++) { await sleep(90); const cur = flat((await read()).sig); for (const k of changed(prev, cur)) noisy.add(k); prev = cur; }

    /** One key, pressed as a player presses it: what the core did while it was down and just after. */
    const press = async code => {
      const a = await read(), before = flat(a.sig), did = new Set();
      let top = a.y ?? 0;
      await p.keyboard.down(code);
      for (const t1 = Date.now(); Date.now() - t1 < L.WATCH_MS; ) {
        if (Date.now() - t1 > 110) await p.keyboard.up(code).catch(() => {});
        const b = await read(); if (!b?.v) { await sleep(30); continue; }
        if (b.v.evading > 0 || (b.v.evadeCool ?? 0) > (a.v?.evadeCool ?? 0) + 0.05) did.add('evade');
        if (b.v.reloading > 0 && !(a.v?.reloading > 0)) did.add('reload');
        if (b.v.swing >= 0 && !(a.v?.swing >= 0)) did.add('melee');
        if ((b.v.weapon | 0) !== (a.v?.weapon | 0)) did.add('switch');
        if ((b.v.shots | 0) > (a.v?.shots | 0)) did.add('fire');
        top = Math.max(top, b.y ?? 0);
        for (const k of changed(before, flat(b.sig))) if (!noisy.has(k)) did.add('other');
        await sleep(30);
      }
      await p.keyboard.up(code).catch(() => {});
      if (top - (a.y ?? 0) >= L.JUMP_RISE) did.add('jump');
      return [...did];
    };
    /** W held, with or without a key: the steady speed once a dash would be over. */
    const walk = async code => {
      await p.keyboard.down('KeyW'); if (code) await p.keyboard.down(code);
      await sleep(L.WALK_FROM_MS);
      const a = await read(), ta = Date.now(); await sleep(L.WALK_MS); const b = await read(), tb = Date.now();
      if (code) await p.keyboard.up(code); await p.keyboard.up('KeyW');
      await sleep(350);
      // back to where it stood, so the next walk has the same floor ahead
      await p.keyboard.down('KeyS'); await sleep(L.WALK_FROM_MS + L.WALK_MS); await p.keyboard.up('KeyS'); await sleep(300);
      return a && b && a.x !== null ? Math.hypot(b.x - a.x, b.z - a.z) / ((tb - ta) / 1000) : 0;
    };

    for (const row of rows) {
      const labels = row.keys.split(' · ').map(s => s.trim()), codes = labels.map(keysOf);
      if (codes.some(c => !c)) continue;                            // another check's row (the mouse, W A S D, Space, clicks, E, Esc)
      const wants = wordsSay(row.words), did = new Set();
      // something to reload: a gun in hand that is not full
      if (wants.includes('reload')) {
        const v = (await read())?.v;
        if (v && !(v.magazine > 0)) { const gun = hold.find(x => (Number(weapons[x.row].magazine) || 0) > 0); if (gun) for (let i = 0; i < 3 && ((await read())?.v?.weapon | 0) !== gun.row; i++) { await p.keyboard.press(`Digit${gun.slot}`); await sleep(650); } }
        const w = (await read())?.v;
        if (w && w.magazine > 0 && w.ammo >= w.magazine) { await p.mouse.down(); await sleep(60); await p.mouse.up(); await sleep(500); }
      }
      for (const code of codes.flat()) { for (const d of await press(code)) did.add(d); await sleep(code.startsWith('Digit') ? 420 : 250); }
      let speeds = null;
      if (wants.includes('sprint')) {
        await sleep(1500);                                          // an evade's cooldown
        const plain = await walk(null), held = await walk(codes.flat()[0]);
        speeds = { plain, held };
        // faster than the core walks (forge.player.walk), not only than this walk: a walk that ran into something is
        // slow, and the dash before the held one can carry the player past what stopped it (the wave 3 arena: 0.83 m/s
        // against 4.76, read as a sprint; the example forge-sprint-key stopped failing for its reason)
        const base = Math.max(plain, Number(game?.forge?.player?.walk) || 0);
        if (base > 0.5 && held >= base * L.SPRINT_TIMES) did.add('sprint');
      }
      const j = judgeKeyRow(row, [...did], speeds);
      results.push({ ...row, pressed: codes.flat(), did: [...did], walk: speeds && { plain: r2(speeds.plain), held: r2(speeds.held) }, ok: j.ok, why: j.why, unheld: !!j.unheld });
      await sleep(1500);                                            // the evade's cooldown, a reload, a swing's recovery
    }
  } catch (e) { stopped = e.message; }
  finally {
    if (T.errors.length) warnings.push(`how to play keys page console errors: ${[...new Set(T.errors)].slice(0, 2).join(' | ')}`);
    await T.ctx.close().catch(() => {});
  }
  record.results = results; record.seconds = Math.round((Date.now() - t0) / 1000);
  for (const r of results.filter(x => x.unheld)) warnings.push(`how to play keys: ${r.why}`);
  const bad = results.filter(r => !r.ok);
  const ok = !stopped && bad.length === 0;
  const detail = stopped ? `How to play's keys could not be played: ${stopped}`
    : bad.length ? `How to play's keys: ${bad.map(r => r.why).join('; ')}. How to play prints config/game.json → controls; its \`more\` rows are the game's own keys ([keys, what, touch button]), and with no row for Shift the kit says "Sprint". On forge Shift evades, R reloads, V is the quick melee and the number keys bring up a weapon the player holds: say what each key does, and take out a row whose key does nothing in this game.${results.some(r => r.ok) ? ` Doing what they say: ${results.filter(r => r.ok).map(r => r.keys).join(', ')}.` : ''}`
      : results.length ? `How to play's keys do what they say: ${results.map(r => r.why).join('; ')}` : 'How to play lists no key of the game\'s own beside the ones checks 3 and 13 press';
  log(`  forge how-to-play keys: ${ok ? 'ok' : 'FAIL'} ${detail.slice(0, 240)}`);
  return { ok, detail, warnings, record };
}
