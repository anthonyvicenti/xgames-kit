// verify check 21's forge leg (CONTRACT §8 forge; §6g: "a game with hit points shows health whatever its config
// says"): the player's health is on the HUD and follows the core's. Kept apart from tools/verify-forge.mjs, which calls
// checkForgeHealth after the shared HUD check (tools/lib/menu-check.mjs checkHud: the card, the menu button, the goal).
//
// Why forge has its own (track S2, 2026-10-10; gf-three/regressions/forge-hidden-health): the shared check
// asks for a health widget only when the game has gf-three's `health` mechanic, and no mechanic runs on forge. So the
// wave 1b Forge Room, a player with 100 hit points among skeletons that hit for 13, showed no health anywhere (a red
// edge when hurt and a pulse under 15% are all a player had) and passed check 21. The creator's words about the same
// gap on gf-three, 2026-10-08: "our games are all missing a home menu and a lot of user HUDs, especially for health".
//
// What it does: a game whose player has hit points and whose enemies come in waves (config/game.json → forge.player
// .health > 0, forge.enemies and forge.waves not empty) is played for up to SECONDS in its real first wave, the player
// standing still so the wave reaches it. Every 250 ms: the core's health (window.__game.forge.players(), the local
// player's hp / hpMax) and the HUD's health as a player would find it (READ, below). It needs: a health display whose
// value can be read, on screen in 90% of the samples alive; that value within TOLERANCE of the core's share in 80% of
// them; and when the player lost hit points, a display that moved. Something only named health that says no value
// (an empty box, a picture with no number behind it) does not count: it cannot be held to the player's health. A game
// with nothing that hurts passes as not applicable.
//
// Where the health display is looked for, in this order (any one counts; the kit's HUD and a game's own are both fine):
//   1. the kit's own observation: window.__game.hud().widgets → id "health" (shown, shows.value / shows.max)
//   2. the DOM: a visible element marked as health: [data-widget="health"], [data-hud="health"], a meter or progress
//      bar whose aria-label says health, or an element whose class or id says health, hp or vitals. Its value from
//      data-value / data-max, aria-valuenow / aria-valuemax, a child bar's width in %, or the number it prints
//   3. a kit meter (ctx.ui.meter) labelled health, hp, life or vitals: its fill
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = v => Math.round(v * 100) / 100;
export const FORGE_HUD_LIMITS = { SECONDS: 22, SHOWN_PCT: 90, AGREE_PCT: 80, TOLERANCE: 0.1, ENOUGH: 6 };
/** The selectors a health display is found by (and the ones regressions/forge-hidden-health hides). */
export const HEALTH_SELECTORS = ['[data-widget="health"]', '[data-hud="health"]', '[role="meter"][aria-label*="health" i]', '[role="progressbar"][aria-label*="health" i]', '[class*="health" i]', '[id*="health" i]', '[class*="vitals" i]', '.gf-hp', '[class$="-hp"]', '[class*="-hp "]', '[id$="-hp"]'];

/** In the page: the local player's health as the core holds it, and as the HUD shows it. */
const READ = SELECTORS => {
  const g = window.__game; if (!g) return null;
  const s = g.snapshot(), me = s.players.find(p => p.local), core = g.forge?.players?.().find(p => p.local) ?? null;
  const seen = e => {
    if (!e || !e.isConnected) return false;
    const r = e.getBoundingClientRect();
    const vis = typeof e.checkVisibility === 'function' ? e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : e.offsetParent !== null;
    return !!vis && r.width > 3 && r.height > 3 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  };
  const num = v => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const widthShare = e => { for (const c of e.querySelectorAll('*')) { const m = /^([\d.]+)%$/.exec(c.style?.width ?? ''); if (m) return Number(m[1]) / 100; } return null; };
  const max = core?.hpMax || 100;
  // every place a health display may be, in order; the one taken is the first whose value can be read (a box that is
  // only named health and says nothing is kept as a last resort, and the verdict does not count it as showing health)
  const all = [];
  // 1. the kit's own observation
  try { const w = (g.hud?.().widgets ?? []).find(x => x.id === 'health'); if (w?.shown) { const v = num(w.shows?.value), m = num(w.shows?.max); all.push({ by: 'hud().widgets', shown: true, share: v !== null && m ? v / m : null }); } } catch {}
  // 2. the DOM
  for (const e of document.querySelectorAll(SELECTORS.join(','))) {
    if (!seen(e)) continue;
    const v = num(e.dataset?.value) ?? num(e.getAttribute('aria-valuenow')), m = num(e.dataset?.max) ?? num(e.getAttribute('aria-valuemax'));
    let share = v !== null ? v / (m || (v <= 1 ? 1 : max)) : widthShare(e);
    if (share === null) { const t = /(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?/.exec(e.textContent ?? ''); if (t) share = Number(t[1]) / (t[2] ? Number(t[2]) : max); }
    all.push({ by: `the DOM (${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof e.className === 'string' && e.className ? `.${e.className.trim().split(/\s+/)[0]}` : ''})`, shown: true, share });
  }
  // 3. a kit meter labelled health
  for (const m of document.querySelectorAll('#gf-ui .gf-meter')) {
    if (!/\b(health|hp|life|vitals)\b/i.test(m.querySelector('b')?.textContent ?? '') || !seen(m)) continue;
    const w = /^([\d.]+)%$/.exec(m.querySelector('u')?.style.width ?? '');
    all.push({ by: `a kit meter "${m.querySelector('b').textContent}"`, shown: true, share: w ? Number(w[1]) / 100 : null });
  }
  const found = all.find(x => x.share !== null) ?? all[0] ?? null;
  let covered = false; try { covered = !!g.hud?.().covered; } catch {}
  return { phase: s.phase, covered, alive: me?.alive !== false && (core?.alive ?? true), truth: core && core.hpMax > 0 ? core.hp / core.hpMax : null, hp: core?.hp ?? null, max: core?.hpMax ?? null, hud: found };
};

/** Does the game have something that hurts a player with hit points? (pure) */
export function healthApplies(game) {
  const f = game?.forge ?? {};
  const hp = Number(f.player?.health ?? 0);
  if (!(hp > 0)) return { applies: false, why: 'the player has no hit points (forge.player.health)' };
  if (!(f.enemies ?? []).length || !(f.waves ?? []).length) return { applies: false, why: 'nothing in the game hurts a player (no enemies in waves)' };
  return { applies: true, hp };
}

/** The verdict from the samples (pure). samples: [{truth (share 0..1), hud: {by, shown, share} | null}] taken alive, in a round, uncovered. */
export function judgeForgeHealth(samples, { hp = 100, L = FORGE_HUD_LIMITS } = {}) {
  const n = samples.length, pct = k => (n ? Math.round((k / n) * 100) : 0);
  if (n < L.ENOUGH) return { ok: false, detail: `health on the HUD could not be judged: only ${n} samples of a living player in a round`, rows: [] };
  // shown: a health display whose value can be read. Something only named health (an empty box, a picture with no
  // number behind it) is `named`: it cannot be held to the player's health, so it does not count as showing it
  const named = samples.filter(s => s.hud?.shown), shown = named.filter(s => s.hud.share !== null), read = shown.filter(s => s.truth !== null);
  const agree = read.filter(s => Math.abs(s.hud.share - s.truth) <= L.TOLERANCE);
  const truths = new Set(samples.map(s => Math.round((s.truth ?? 1) * 100))), shows = new Set(read.map(s => Math.round(s.hud.share * 100)));
  const by = shown.find(s => s.hud?.by)?.hud.by ?? null;
  const fails = [];
  if (!named.length) fails.push(`no health on the HUD: the player has ${hp} hit points and enemies that hurt, and nothing on screen shows them (looked for the kit's hud() widget "health", a visible element marked health, hp or vitals, and a kit meter labelled health)`);
  else if (!shown.length) fails.push(`no health on the HUD that can be read: ${named[0].hud.by} is on screen and says no value, so nothing holds it to the player's ${hp} hit points (give it data-value and data-max, or aria-valuenow and aria-valuemax)`);
  else if (pct(shown.length) < L.SHOWN_PCT) fails.push(`health was on the HUD in ${pct(shown.length)}% of the round (needs ${L.SHOWN_PCT}%)`);
  if (read.length && Math.round((agree.length / read.length) * 100) < L.AGREE_PCT) { const bad = read.find(s => Math.abs(s.hud.share - s.truth) > L.TOLERANCE); fails.push(`the HUD's health was not the player's in ${100 - Math.round((agree.length / read.length) * 100)}% of the samples (e.g. it showed ${Math.round(bad.hud.share * 100)}% at ${Math.round(bad.truth * 100)}%)`); }
  if (read.length && truths.size >= 2 && shows.size < 2) fails.push('health never moved on the HUD though the player lost hit points');
  const lowest = Math.min(...samples.map(s => s.truth ?? 1));
  const row = shown.length ? `health on the HUD in ${pct(shown.length)}% of ${n} samples (${by}), its value the player's in ${read.length ? Math.round((agree.length / read.length) * 100) : 0}% of ${read.length}; the player's health went down to ${Math.round(lowest * 100)}%` : `the player's health went down to ${Math.round(lowest * 100)}% and no health was on the HUD`;
  return { ok: fails.length === 0, detail: fails.length ? `${fails.join('; ')}. A forge player's health is the core's (window.__game.forge.players() → hp, hpMax; the feel view's health): show it in the HUD as the kit's health widget does (data-widget="health" with data-value and data-max), or with ctx.ui.meter` : row, rows: [row], hurt: truths.size >= 2 };
}

/** Check 21's forge leg. → {ok, detail, record, warnings} */
export async function checkForgeHealth({ newPage, url, game, log = () => {}, shot = null }) {
  const L = FORGE_HUD_LIMITS, warnings = [];
  const a = healthApplies(game);
  if (!a.applies) return { ok: true, detail: `health on the HUD: nothing to judge (${a.why})`, warnings, record: { applies: false, why: a.why } };
  const T = await newPage('hud health', { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 120 }] } });
  const p = T.page, samples = [];
  let lastShot = null;
  try {
    await p.goto(`${url}?seed=5&bots=0`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    await p.click('#gf-play');
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 20000) throw new Error('the round did not start'); await sleep(120); }
    await p.mouse.click(640, 400); await sleep(300);
    // the player stands where it spawned: the first wave rises and comes to it
    for (const t0 = Date.now(); Date.now() - t0 < L.SECONDS * 1000; ) {
      const s = await p.evaluate(READ, HEALTH_SELECTORS).catch(() => null);
      if (!s || s.phase === 'results') break;
      if (s.phase === 'playing' && !s.covered && s.alive && s.truth !== null) samples.push({ t: r2((Date.now() - t0) / 1000), truth: s.truth, hud: s.hud });
      const hurt = new Set(samples.map(x => Math.round(x.truth * 100))).size;
      if (shot && !lastShot && hurt >= 2) lastShot = await shot(p, 'hud-health');
      if (hurt >= 4 && samples.length >= 24) break;                 // hurt three times and long enough seen
      await sleep(250);
    }
    if (shot && !lastShot) lastShot = await shot(p, 'hud-health');
  } catch (e) { warnings.push(`hud health page stopped: ${e.message}`); }
  finally { if (T.errors.length) warnings.push(`hud health page console errors: ${[...new Set(T.errors)].slice(0, 2).join(' | ')}`); await T.ctx.close().catch(() => {}); }
  const j = judgeForgeHealth(samples, { hp: a.hp, L });
  if (j.ok && !j.hurt) warnings.push('hud health: the player was not hurt in the round, so health was only seen full');
  log(`  forge hud health: ${j.ok ? 'ok' : 'FAIL'} ${j.detail.slice(0, 220)}`);
  return { ok: j.ok, detail: j.detail, warnings, record: { applies: true, hp: a.hp, samples: samples.length, by: samples.find(s => s.hud?.shown)?.hud.by ?? null, lowest: samples.length ? r2(Math.min(...samples.map(s => s.truth))) : null, last: samples.at(-1) ?? null, shot: lastShot } };
}
