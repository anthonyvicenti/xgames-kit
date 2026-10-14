// verify checks 16 (hits read) and 10's feel half (fair play: never out of control too long) for a forge game (CONTRACT
// §8 forge; research/rust-engine/PLAN.md §4 track F), through the observation interface: window.__game.forge.feel()
// (gf/forge/feel.js: what the feel layer shows, the core's stats, the death recap) and window.__game.camera(). Kept apart
// from tools/verify-forge.mjs, which calls checkForgeHits and checkForgeFair.
//
// 16, hits read (the creator, "Hang Up On Them": "The zombies are instant killed to I couldn't even tell what was
// happened"): a game with a weapon (spec.forge.weapons) on the staged moment ?gf-demo=feel.hit (gf/forge/feel.js: a
// target 6 m ahead with the game's first enemy's hit points, standing again a second after each kill). The scripted
// player aims at it with the mouse and fires with real clicks until KILLS kills or SECONDS. Measured: hits per kill
// (the core's kill log: the median at least MIN_HITS), and for a hit that did not kill, from the player's own screen:
// the core flashed the body (its FLASH event: the renderer draws it), a damage number popped within NEAR px of it, and
// at least CHANGE_MIN of the pixels around it changed beyond the noise of the frames before. No weapon: passes (n/a).
// Since wave 3 (track S3, 2026-10-10; regressions/forge-one-swing-kills) every weapon a player can hold in hand is
// judged, not only the one in hand when the round starts: the wave 1b room's blade (40 against 30 hit points) killed in
// one swing and its charged focus in one shot, and the check never drew either. A row can be held when it starts in
// hand (`start`), a card gives it (spec.forge.cards[].weapon), or the rules arm players themselves (rules.js names
// FEEL_OP.LOADOUT, GIVE or PICKUP: then any row may be). On the staged page each of them starts in the player's hands
// (its `start` set true the way Studio overrides a value) and is brought up with its own key; a melee row walks in to
// its reach first, a charge row holds the trigger its whole interval. Each row's median hits per kill must reach
// MIN_HITS. The quick melee (V) swings the first melee row over the gun: a row that is only that is noted with its
// arithmetic and not failed (feel target 11 has the quick melee kill on contact); held in hand, it is judged.
// A weapon that fires several pellets a pull (a scattergun) is judged by one pellet: the core's kill log counts a
// blast on a body as one hit, and a blast that fells a basic enemy at 6 m is what the weapon is for; it fails when a
// single pellet's damage reaches the enemy's health (then every pellet kills, at any range).
//
// 10, the feel half of fair play. What takes control away from a forge player: the feel's own (an evade's dash, a
// knock-down by a brute's slam, which the core holds to 0.8 s once in 3 s, death) and whatever the rules do (switching
// the player's controller off, rooting it, a card over the screen). A scripted player strafes on a held key, fires,
// evades as fast as the cooldown allows and jumps for SECONDS, sampled every 100 ms: the feel view (evading, down,
// dead) and whether its keys answer (forgeControl: it walked in the last half second, or Space took it off the
// ground). The samples go through fair-check's measure (control while alive: the longest stretch without it, the
// share with it). Fails as fair play does: a stretch over downSeconds + 1 s, or under 85% of the time in control.
// (Until 2026-10-10 only evading and dead were read: a knock-down and a stun by the rules both counted as control.)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { measure as fairMeasure, FAIR_LIMITS } from './fair-check.mjs';
import { EMULATED_LOCK } from './lock.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = v => Math.round(v * 100) / 100;
export const FORGE_HIT_LIMITS = { KILLS: 3, MIN_HITS: 2, SECONDS: 30, NEAR: 120, CHANGE_MIN: 0.03, PIXEL_T: 60, AIM: 0.012, SENS: 0.0024, KEY_TRIES: 4 };

/**
 * The weapons rows a player can hold in hand (pure): a row that starts in hand, one a weapon card gives, or, when the
 * rules arm players themselves (rules.js names FEEL_OP.LOADOUT, GIVE or PICKUP), any row. game: config/game.json (its
 * forge.weapons are the filled rows). → [{row, id, name, kind, slot, why}]
 */
export function holdableWeapons(game, rulesText = '') {
  const W = game?.forge?.weapons ?? [];
  const given = new Set((game?.forge?.cards ?? []).filter(c => c?.kind === 'weapon' && c.weapon).map(c => c.weapon));
  const armed = /FEEL_OP\s*\.\s*(LOADOUT|GIVE|PICKUP)\b/.test(String(rulesText));
  const out = [];
  W.forEach((w, row) => {
    const why = w?.start !== false ? 'in hand at the start' : given.has(w.id) ? 'a card gives it' : armed ? 'the rules arm players' : null;
    if (why) out.push({ row, id: w.id, name: w.name || w.id, kind: w.kind ?? 'projectile', slot: Number(w.slot) || 1, why });
  });
  return out;
}
/** The row the quick melee (V) swings: the table's first melee row (forge-feel config.rs), or -1. (pure) */
export const quickMeleeRow = game => (game?.forge?.weapons ?? []).findIndex(w => w?.kind === 'melee');
const median = list => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
export const FORGE_FAIR_SECONDS = 20;

/** Headless Chrome grants no pointer lock: emulate it so real relative mouse motion reaches the look (the reference
 *  captures did the same: research/rust-engine/feel-targets.md "Input path"). One copy since gf-forge wave 4: it is
 *  tools/lib/lock.mjs's EMULATED_LOCK (the same three overrides, and the page says so in window.__gfEmulatedLock);
 *  the forge checks and tools/play.mjs keep importing it under this name. */
export const POINTER_LOCK = EMULATED_LOCK;

const FEEL = () => window.__game?.forge?.feel?.() ?? null;
const CAM = () => { const c = window.__game?.camera?.(); return c ? { yaw: c.yaw, pitch: c.pitch, eye: c.eye } : null; };

/** The mouse as a person uses it: turn by (dx, dy) px, recentring with the lock released when the cursor nears an edge. */
function mouse(p, vp) {
  const cur = { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) };
  const recenter = async () => { await p.evaluate(() => document.exitPointerLock()); cur.x = Math.round(vp.width / 2); cur.y = Math.round(vp.height / 2); await p.mouse.move(cur.x, cur.y); await p.evaluate(() => document.getElementById('gf-canvas')?.requestPointerLock()); };
  return {
    cur,
    async turn(dx, dy) {
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 40));
      for (let i = 0; i < n; i++) {
        if (cur.x + dx / n < 60 || cur.x + dx / n > vp.width - 60 || cur.y + dy / n < 60 || cur.y + dy / n > vp.height - 60) await recenter();
        cur.x += dx / n; cur.y += dy / n; await p.mouse.move(cur.x, cur.y);
      }
    },
  };
}

/** Turn the camera onto a world point (the core's camera: yaw 0 looks down −Z; the observation's yaw is the kit's). */
async function aimAt(p, m, at, L) {
  for (let k = 0; k < 8; k++) {
    const c = await p.evaluate(CAM); if (!c) return false;
    const [ex, ey, ez] = c.eye, yaw = (c.yaw ?? 0) + Math.PI, pitch = c.pitch ?? 0;
    const want = Math.atan2(-(at[0] - ex), -(at[2] - ez)), wantP = Math.atan2(at[1] - ey, Math.hypot(at[0] - ex, at[2] - ez));
    let dy = want - yaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
    const dp = wantP - pitch;
    if (Math.abs(dy) < L.AIM && Math.abs(dp) < L.AIM) return true;
    await m.turn(-dy / L.SENS, -dp / L.SENS);
    await sleep(60);
  }
  return true;
}

/** Pixel change around a screen box between the frames before (their noise left out) and after. */
async function change(browser, before, after, box, T) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ([B, A, box, T]) => {
      const load = async s => { const im = new Image(); im.src = 'data:image/png;base64,' + s; await im.decode(); const c = new OffscreenCanvas(im.width, im.height); const g = c.getContext('2d'); g.drawImage(im, 0, 0); return { w: im.width, h: im.height, d: g.getImageData(0, 0, im.width, im.height).data }; };
      const bs = []; for (const s of B) bs.push(await load(s));
      const base = bs[bs.length - 1], W = base.w;
      const x0 = Math.max(0, Math.floor(box.x0)), x1 = Math.min(W, Math.ceil(box.x1)), y0 = Math.max(0, Math.floor(box.y0)), y1 = Math.min(base.h, Math.ceil(box.y1));
      const diff = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      const noise = new Uint8Array(W * base.h); let nN = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = y * W + x; n++; for (const b of bs.slice(0, -1)) if (diff(b.d, base.d, k * 4) > T) { noise[k] = 1; nN++; break; } }
      let best = 0;
      for (const s of A) { const a = await load(s); let c = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = y * W + x; if (!noise[k] && diff(a.d, base.d, k * 4) > T) c++; } best = Math.max(best, c / Math.max(1, n)); }
      return { change: best, noise: nN / Math.max(1, n), px: n };
    }, [before.map(b => b.toString('base64')), after.map(b => b.toString('base64')), box, T]);
  } finally { await page.close(); }
}

/**
 * The verdict from the measurements (pure). m: {applies, why, seconds, shots, hits, kills: [hits per kill], targets,
 * hit: {flash, number, change, noise} | null, rows?: [{id, name, slot, kind, why, inHand, shots, hits, kills}] (every
 * weapon a player can hold; without it the totals are one row; pellets and damage: a row with several pellets a pull is
 * judged by one pellet against hp), hp (the staged target's hit points), quick?: {name, damage, hp, held} (the quick
 * melee's row)}.
 */
export function judgeForgeHits(m, L = FORGE_HIT_LIMITS) {
  if (!m.applies) return { ok: true, detail: m.why };
  const rows = m.rows?.length ? m.rows : [{ id: null, name: null, inHand: true, shots: m.shots ?? 0, hits: m.hits ?? 0, kills: m.kills ?? [] }];
  const judged = rows.filter(r => r.inHand !== false), unheld = rows.filter(r => r.inHand === false);
  const shots = judged.reduce((n, r) => n + (r.shots ?? 0), 0), hits = judged.reduce((n, r) => n + (r.hits ?? 0), 0);
  const fails = [];
  if (!m.targets) fails.push(`no target stood in front of the player in ${m.seconds} s (?gf-demo=feel.hit: gf/forge/feel.js stages it)`);
  else if (!hits) fails.push(`${shots} shots at the target under the crosshair and none hit it`);
  const blast = r => (r.pellets ?? 1) > 1 && Number.isFinite(r.damage) && Number.isFinite(m.hp);
  for (const r of judged.filter(r => blast(r) && r.damage >= m.hp)) fails.push(`one pellet of ${r.name} (key ${r.slot}; ${r.why}) does ${r.damage} against ${m.hp} hit points: every hit kills, so nobody sees a hit land`);
  const oneHit = judged.filter(r => !blast(r) && r.kills.length && median(r.kills) < L.MIN_HITS);
  for (const r of oneHit) { const med = median(r.kills); fails.push(`${med} hit${med === 1 ? '' : 's'} per kill (${r.kills.join('/')})${r.name ? ` with ${r.name} (key ${r.slot}; ${r.why})` : ''}: every hit kills, so nobody sees a hit land`); }
  if (oneHit.length || judged.some(r => blast(r) && r.damage >= m.hp)) fails.push('the creator: "The zombies are instant killed to I couldn\'t even tell what was happened". Keep each weapon\'s damage (spec.forge.weapons[].damage, times its crit multiplier on a head; a charge weapon at its full charge) below the enemies\' health (spec.forge.enemies[].health) so a basic enemy takes 2-4 hits from any weapon a player can hold');
  const h = m.hit;
  if (hits && judged.some(r => !blast(r) && (median(r.kills) ?? Infinity) >= L.MIN_HITS)) {
    if (!h) fails.push('no hit that left the target standing was seen on the player\'s screen');
    else {
      const why = [];
      if (!h.flash) why.push('the core sent no flash for the hit body');
      if (!h.number) why.push(`no damage number within ${L.NEAR} px of it`);
      if (!(h.change >= L.CHANGE_MIN)) why.push(`only ${r2(h.change * 100)}% of the pixels around it changed (needs ${L.CHANGE_MIN * 100}%; noise ${r2(h.noise * 100)}%)`);
      if (why.length) fails.push(`a hit that did not kill did not read: ${why.join('; ')}`);
    }
  }
  const per = r => { const med = median(r.kills); return `${r.kills.length} kill${r.kills.length === 1 ? '' : 's'}${r.kills.length ? `, ${r.kills.join('/')} hits per kill (median ${med})` : ''}; ${r.hits} hit${r.hits === 1 ? '' : 's'} from ${r.shots} shot${r.shots === 1 ? '' : 's'}${blast(r) ? ` (${r.pellets} pellets a pull, ${r.damage} each against ${m.hp} hit points: judged by one pellet)` : ''}`; };
  const head = judged.length === 1 && !judged[0].name
    ? `${judged[0].kills.length} kill${judged[0].kills.length === 1 ? '' : 's'} in ${m.seconds} s, ${judged[0].kills.length ? `${judged[0].kills.join('/')} hits per kill (median ${median(judged[0].kills)})` : 'no kill'}; ${hits} hit${hits === 1 ? '' : 's'} from ${shots} shot${shots === 1 ? '' : 's'}`
    : `${judged.length} weapon${judged.length === 1 ? '' : 's'} a player can hold, each in hand, in ${m.seconds} s: ${judged.map(r => `${r.name} ${per(r)}`).join(' · ') || 'none'}`;
  const notHeld = unheld.length ? `; not judged (its key ${unheld.map(r => `${r.slot} never brought ${r.name} into the hand on the staged page`).join(', ')})` : '';
  const q = m.quick, quick = q ? `; the quick melee (V) swings ${q.name}: ${q.damage} a hit against ${q.hp} hit points${q.held ? '' : `${q.damage >= q.hp ? ', one cut kills' : ''} (never held in hand: not judged; feel target 11 has a quick melee kill on contact)`}` : '';
  const seen = h ? `a hit that did not kill: the body's flash ${h.flash ? 'sent' : 'missing'}, a damage number ${h.number ? `"${h.number}" by it` : 'missing'}, ${r2(h.change * 100)}% of the pixels around it changed (noise ${r2(h.noise * 100)}%)` : 'no hit left the target standing';
  return { ok: fails.length === 0, detail: fails.length ? `${fails.join('; ')}. Measured: ${head}${notHeld}; ${seen}${quick}` : `${head}${notHeld}; ${seen}${quick}` };
}

/** Check 16 on forge. dir: the game folder (its rules.js says whether the rules arm players). → {ok, detail, record, warnings} */
export async function checkForgeHits({ newPage, browser, url, game, dir = null, shot = async () => null, log = () => {} }) {
  const L = FORGE_HIT_LIMITS, warnings = [], t0 = Date.now();
  const weapons = game.forge?.weapons ?? [];
  const m = { applies: weapons.length > 0, why: 'no weapon (spec.forge.weapons is empty): nothing to hit', seconds: 0, shots: 0, hits: 0, kills: [], hit: null, targets: 0, rows: [], quick: null, hp: null };
  if (!m.applies) { const j = judgeForgeHits(m, L); return { ok: j.ok, detail: j.detail, warnings, record: { applies: false } };
  }
  const rulesText = dir ? await readFile(join(dir, 'rules.js'), 'utf8').catch(() => '') : '';
  // every weapon a player can hold, guns first: for a melee row the player walks in to its reach and stays there
  const hold = holdableWeapons(game, rulesText).sort((a, b) => (a.kind === 'melee') - (b.kind === 'melee'));
  const hp = m.hp = Number(game.forge?.enemies?.[0]?.health) || 60;
  const qr = quickMeleeRow(game);
  if (qr >= 0) m.quick = { name: weapons[qr].name || weapons[qr].id, damage: Number(weapons[qr].damage) || 0, hp, held: hold.some(x => x.row === qr) };
  // the staged page: every one of them starts in the player's hands (as Studio overrides a value), so its key brings it up
  const patches = [{ file: 'config/game.json', pointer: '/round/seconds', value: 300 }, ...hold.filter(x => weapons[x.row].start === false).map(x => ({ file: 'config/game.json', pointer: `/forge/weapons/${x.row}/start`, value: true }))];
  const T = await newPage('forge hits', { overrides: { patches } });
  const p = T.page;
  await p.addInitScript(POINTER_LOCK);
  const vp = p.viewportSize() ?? { width: 1280, height: 720 };
  const ms = mouse(p, vp);
  const png = () => p.screenshot({ type: 'png' });
  const record = { url: '?seed=7&gf-demo=feel.hit', limits: L, holdable: hold, shotsLog: [] };
  const mineOf = (f, local) => (f?.stats?.kills ?? []).filter(k => k.by === local);
  try {
    await p.goto(`${url}?seed=7&gf-demo=feel.hit`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    await p.click('#gf-play');
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 20000) throw new Error('the round did not start'); await sleep(120); }
    await sleep(1400);
    await p.mouse.move(ms.cur.x, ms.cur.y); await p.mouse.click(ms.cur.x, ms.cur.y); await sleep(300);
    let local = 0;
    for (const w of hold.length ? hold : [{ row: -1, id: null, name: null, kind: weapons[0]?.kind, slot: 1, why: 'in hand' }]) {
      const d = weapons[w.row] ?? weapons[0] ?? {}, melee = w.kind === 'melee', reach = Number(d.melee?.reach) || 2.2;
      const row = { ...w, pellets: Number(d.pellets) || 1, damage: Number(d.damage) || 0, inHand: w.row < 0, shots: 0, hits: 0, kills: [], seconds: 0 };
      m.rows.push(row);
      // its key until it is the one in hand (two rows can share a key: it takes turns)
      for (let i = 0; i <= L.KEY_TRIES && !row.inHand; i++) {
        const v = (await p.evaluate(FEEL))?.shown?.view;
        if (v && (v.weapon | 0) === w.row) { row.inHand = true; break; }
        if (i === L.KEY_TRIES) break;
        await p.keyboard.press(`Digit${w.slot}`); await sleep(300 + (Number(d.raise) || 0.2) * 1000);
      }
      if (!row.inHand) { warnings.push(`forge hits: ${w.name} (${w.why}) never came into the hand on its key ${w.slot} on the staged page, so its hits were not judged`); continue; }
      const start = Date.now();
      let before0 = null, dropFirst = false;
      while (Date.now() - start < L.SECONDS * 1000) {
        const f = await p.evaluate(FEEL);
        if (!f?.shown) { await sleep(150); continue; }
        local = f.shown.view.player;
        const mine = mineOf(f, local);
        if (before0 === null) before0 = mine.length;
        if (mine.length - before0 >= L.KILLS + (dropFirst ? 1 : 0)) break;
        const tg = f.shown.targets.filter(t => t.hp > 0).sort((a, b) => (a.body ? Math.hypot(a.body.x - vp.width / 2, a.body.y - vp.height / 2) : 1e9) - (b.body ? Math.hypot(b.body.x - vp.width / 2, b.body.y - vp.height / 2) : 1e9))[0];
        if (!tg) { await sleep(150); continue; }
        m.targets = Math.max(m.targets, 1);
        // a target the weapon before left hurt: its kill would count that weapon's hits too
        if (!row.shots && tg.hp < 0.999) dropFirst = true;
        await aimAt(p, ms, [tg.at[0], tg.at[1] + 1.15, tg.at[2]], L);
        if (melee) {
          // a blade: walk in to its reach, as a player does
          for (let i = 0; i < 40; i++) {
            const me = await p.evaluate(() => { const c = window.__game?.forge?.players?.().find(x => x.local); return c ? [c.x, c.z] : null; }).catch(() => null);
            const far = me ? Math.hypot(tg.at[0] - me[0], tg.at[2] - me[1]) : 0;
            if (!me || far <= reach * 0.72) break;
            await p.keyboard.down('KeyW'); await sleep(far > reach + 1.2 ? 130 : 45); await p.keyboard.up('KeyW'); await sleep(90);
            await aimAt(p, ms, [tg.at[0], tg.at[1] + 1.15, tg.at[2]], L);
          }
        }
        const measuring = !m.hit;
        const before = measuring ? [await png(), (await sleep(110), await png())] : [];
        const hits0 = (f.stats?.hits ?? []).length, kills0 = mine.length, flashes0 = tg.flashes;
        row.shots++;
        // a charge weapon fires on release with the share of its interval it was held: the whole of it, its hardest shot
        await p.mouse.down(); await sleep(w.kind === 'charge' ? (Number(d.fireInterval) || 0.8) * 1000 + 90 : w.kind === 'beam' ? 220 : 60); await p.mouse.up();
        let outcome = 'miss', after = null, f2 = null;
        for (let t = Date.now(); Date.now() - t < 900; ) {
          f2 = await p.evaluate(FEEL);
          const kills = mineOf(f2, local).length, hitsN = (f2?.stats?.hits ?? []).length;
          if (kills > kills0) { outcome = 'kill'; break; }
          if (hitsN > hits0) { outcome = 'hit'; if (measuring) after = [await png(), (await sleep(40), await png())]; break; }
          await sleep(20);
        }
        record.shotsLog.push({ weapon: w.id, target: tg.net, hp: tg.hp, outcome });
        if (outcome !== 'miss') row.hits++;
        if (outcome === 'hit' && after && !m.hit) {
          const g = await p.evaluate(FEEL);
          const now = g.shown.targets.find(t => t.net === tg.net) ?? tg;
          const head = now.head ?? tg.head, feet = now.feet ?? tg.feet;
          const hgt = Math.max(40, (feet?.y ?? vp.height / 2) - (head?.y ?? vp.height / 2)), cx = ((head?.x ?? vp.width / 2) + (feet?.x ?? vp.width / 2)) / 2;
          const box = { x0: cx - Math.max(50, hgt * 0.6), x1: cx + Math.max(50, hgt * 0.6), y0: (head?.y ?? 0) - 60, y1: (feet?.y ?? vp.height) + 10 };
          // the number pops for a moment: read it from the snapshot that saw the hit and, the screenshots taken, for a
          // little longer (2026-10-13: under load the two screenshots outlasted the number, and a hit that read was
          // judged missing; ruin-hold beside another verify)
          const near = list => (list ?? []).find(n => !n.word && Math.hypot(n.x + n.w / 2 - cx, n.y + n.h - ((head?.y ?? 0) + (feet?.y ?? 0)) / 2) < L.NEAR + hgt / 2);
          let num = near(f2?.shown?.numbers) ?? near(g.shown.numbers);
          for (let t = Date.now(); !num && Date.now() - t < 600; ) { await sleep(40); num = near((await p.evaluate(FEEL))?.shown?.numbers); }
          const c = await change(browser, before, after, box, L.PIXEL_T);
          m.hit = { weapon: w.id, flash: (now.flashes ?? 0) > flashes0, number: num?.text ?? null, change: c.change, noise: c.noise, box: Object.fromEntries(Object.entries(box).map(([k, v]) => [k, Math.round(v)])) };
          await shot(p, 'hits-hit', after[0]);
        }
        await sleep(Math.max(80, (Number(d.fireInterval) || 0.3) * 1000 - 40));
      }
      const f = await p.evaluate(FEEL);
      row.kills = mineOf(f, local).slice((before0 ?? 0) + (dropFirst ? 1 : 0)).map(k => k.hits);
      row.seconds = Math.round((Date.now() - start) / 1000);
      if (melee) await shot(p, `hits-${String(w.id ?? 'melee').replace(/[^a-z0-9]+/gi, '-')}`);
    }
    const f = await p.evaluate(FEEL);
    record.kills = f?.stats?.kills ?? [];
  } catch (e) {
    warnings.push(`forge hits page stopped: ${e.message}`);
  } finally {
    m.seconds = Math.round((Date.now() - t0) / 1000);
    if (T.errors.length) warnings.push(`forge hits page console errors: ${[...new Set(T.errors)].slice(0, 2).join(' | ')}`);
    await T.ctx.close().catch(() => {});
  }
  // the totals, as before: every judged row's shots and hits, the first row's kills
  m.shots = m.rows.reduce((n, r) => n + r.shots, 0); m.hits = m.rows.reduce((n, r) => n + r.hits, 0); m.kills = m.rows.find(r => r.inHand)?.kills ?? [];
  if (m.rows.length === 1 && m.rows[0].row < 0) m.rows[0].name = null;
  const j = judgeForgeHits(m, L);
  record.measured = { ...m };
  log(`  forge hits: ${j.ok ? 'ok' : 'FAIL'} ${j.detail.slice(0, 260)}`);
  return { ok: j.ok, detail: j.detail, warnings, record };
}

/**
 * Is the player in control at a sample (pure)? Not when dead, mid-evade or knocked down (the core's own, read from the
 * feel view); and not when its keys do nothing. The scripted player holds a strafe key the whole time, so a player in
 * control has walked `MOVE_M` in the last `MOVE_S` seconds; one a wall or a crowd is holding still jumps, and has been
 * off the ground within `AIR_S`. A player that neither walks nor leaves the ground on Space has had its input taken
 * away, however the game did it (the rules switching its controller off, rooting it with teleports, a card over the
 * screen): track S2, 2026-10-10, regressions/forge-stun-chain. Before it, only the evade and death were counted, and
 * the kit's players[].control never changes on forge.
 * s: {alive, dead, evading, down, walked (m in the last MOVE_S s; null: too early to say), sinceAir (s since last off the ground)}
 */
export const FORGE_FAIR = { MOVE_S: 0.5, MOVE_M: 0.3, AIR_S: 0.9 };
export function forgeControl(s, L = FORGE_FAIR) {
  if (!s.alive || s.dead) return { control: false, why: 'dead' };
  if (s.down) return { control: false, why: 'knocked down' };
  if (s.evading) return { control: false, why: 'evading' };
  if (s.walked === null || s.walked >= L.MOVE_M || s.sinceAir <= L.AIR_S) return { control: true, why: '' };
  return { control: false, why: 'keys did nothing' };
}

/** Check 10's feel half on forge. → {ok, detail, record, warnings} */
export async function checkForgeFair({ newPage, url, game, log = () => {}, seconds = FORGE_FAIR_SECONDS }) {
  const warnings = [];
  const downSeconds = 1.2;
  const trail = [];           // the local player's last places: {wall, x, z}
  const whys = {};            // why control was away, by sample count
  let lastAir = -1e9, stuck = 0;
  const T = await newPage('forge fair', { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: Math.ceil(seconds) + 10 }] } });
  const p = T.page;
  await p.addInitScript(POINTER_LOCK);
  const samples = [];
  try {
    await p.goto(`${url}?seed=7`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    await p.click('#gf-play');
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 20000) throw new Error('the round did not start'); await sleep(120); }
    await p.mouse.click(640, 360);
    // side to side along where the player stands (a round won by walking somewhere is not ended by this), evading as
    // often as the cooldown lets it, jumping, firing in bursts; a round that ends anyway is played again
    await p.keyboard.down('KeyA');
    const start = Date.now();
    let k = 0, held = false, side = 'KeyA', rounds = 1;
    const wall = () => (Date.now() - start) / 1000;
    while (wall() < seconds) {
      const s = await p.evaluate(() => { const g = window.__game; const f = g?.forge?.feel?.(); const snap = g?.snapshot?.(); const me = snap?.players?.find(x => x.local); const c = g?.forge?.players?.().find(x => x.local) ?? null; return f && snap ? { phase: snap.phase, t: snap.time?.round ?? 0, v: f.shown?.view ?? null, me: me ? { id: me.id, alive: me.alive } : null, core: c && { x: c.x, z: c.z, grounded: c.grounded } } : null; }).catch(() => null);
      if (!s?.v || !s.me) { await sleep(100); continue; }
      if (s.phase === 'results') {
        const again = await p.$('#gf-again');
        if (!again) break;
        await again.click(); rounds++;
        for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 15000) break; await sleep(120); }
        await p.mouse.click(640, 360);
        trail.length = 0; lastAir = -1e9;
        continue;
      }
      // in control (forgeControl): alive, not carried by the feel (an evade's dash, a knock-down), and its keys answer
      // (the held strafe key walks it, or Space lifts it off the ground)
      const now = wall();
      if (s.phase !== 'playing') trail.length = 0;                   // a countdown is not a stun
      else if (s.core) { trail.push({ wall: now, x: s.core.x, z: s.core.z }); while (trail.length && now - trail[0].wall > FORGE_FAIR.MOVE_S + 0.15) trail.shift(); if (!s.core.grounded) lastAir = now; }
      const full = s.core && trail.length > 1 && now - trail[0].wall >= FORGE_FAIR.MOVE_S - 0.05;
      const walked = full ? trail.slice(1).reduce((n, q, i) => n + Math.hypot(q.x - trail[i].x, q.z - trail[i].z), 0) : null;
      const c = forgeControl({ alive: s.me.alive !== false, dead: !!s.v.dead, evading: !!s.v.evading, down: (s.v.down ?? 0) > 0, walked, sinceAir: now - lastAir });
      if (s.phase === 'playing') { samples.push({ phase: s.phase, t: s.t, wall: now, players: [{ id: s.me.id, local: true, alive: s.me.alive !== false && !s.v.dead, control: c.control }] }); if (!c.control && c.why !== 'dead') whys[c.why] = (whys[c.why] ?? 0) + 1; }
      // a player that is not walking tries Space more often: a wall or a crowd lets it jump, a stun does not
      stuck = walked !== null && walked < FORGE_FAIR.MOVE_M ? stuck + 1 : 0;
      k++;
      if (k % 6 === 0) { await p.keyboard.down('ShiftLeft'); await sleep(50); await p.keyboard.up('ShiftLeft'); }
      if (k % 9 === 4 || (stuck > 0 && stuck % 3 === 1)) { await p.keyboard.down('Space'); await sleep(50); await p.keyboard.up('Space'); }
      if (k % 14 === 0) { await p.mouse.down(); held = true; }
      if (k % 14 === 7 && held) { await p.mouse.up(); held = false; }
      if (k % 12 === 0) { await p.keyboard.up(side); side = side === 'KeyA' ? 'KeyD' : 'KeyA'; await p.keyboard.down(side); }
      await sleep(100);
    }
    if (held) await p.mouse.up().catch(() => {});
    await p.keyboard.up(side).catch(() => {});
    if (rounds > 1) warnings.push(`forge fair: ${rounds} rounds were played to fill ${seconds} s (the rules ended one)`);
  } catch (e) { warnings.push(`forge fair page stopped: ${e.message}`); }
  finally { if (T.errors.length) warnings.push(`forge fair page console errors: ${[...new Set(T.errors)].slice(0, 2).join(' | ')}`); await T.ctx.close().catch(() => {}); }
  const r = fairMeasure(samples, { downSeconds });
  const m = { samples: samples.length, longest: r.longestNoControlSec ?? 0, pct: r.controlPct ?? 0, aliveSec: r.aliveSec, deaths: r.deaths ?? 0, whys, downSeconds, note: warnings[0] ?? '' };
  const j = judgeForgeFair(m);
  log(`  forge fair: ${j.ok ? 'ok' : 'FAIL'} ${j.detail}`);
  return { ok: j.ok, detail: j.detail, warnings, record: { samples: samples.length, longest: m.longest, controlPct: m.pct, away: whys } };
}

/** The verdict on fair play's forge half from the measurements (pure). m: {samples, longest (s), pct, aliveSec, deaths,
 *  whys: {'evading' | 'knocked down' | 'keys did nothing': samples}, downSeconds, note} */
export function judgeForgeFair(m) {
  const limit = m.downSeconds + FAIR_LIMITS.slackSeconds;
  if (m.samples <= 20) return { ok: false, detail: `too few samples (${m.samples}) to judge${m.note ? `: ${m.note}` : ''}` };
  const away = Object.entries(m.whys ?? {}).map(([w, n]) => `${w} in ${n} sample${n === 1 ? '' : 's'}`).join(', ') || 'never away';
  const fails = [];
  if (m.longest > limit) fails.push(`the player was out of control for ${r2(m.longest)} s at once while alive (limit ${limit} s)`);
  if (m.pct < FAIR_LIMITS.minControlPct) fails.push(`the player was in control ${Math.round(m.pct)}% of the time alive (needs ${FAIR_LIMITS.minControlPct}%)`);
  const measured = `in control ${Math.round(m.pct)}% of ${m.aliveSec} s alive, the longest stretch without it ${r2(m.longest)} s (limit ${limit} s); control was away: ${away}${m.deaths ? `; died ${m.deaths} time${m.deaths === 1 ? '' : 's'}` : ''}`;
  if (!fails.length) return { ok: true, detail: `the feel's half (forge: a scripted player strafes on a held key, evades as fast as the cooldown allows, jumps and fires): ${measured}` };
  return { ok: false, detail: `${fails.join('; ')}. Measured: ${measured}. On forge the core already limits what an enemy does to a player (one knock-down in 3 s, 0.8 s at most), so a longer stretch is the rules': never switch a player's controller off, root it with teleports or cover the screen for seconds at a time; a hit may slow or push, and the evade and death are the only ways control goes` };
}
