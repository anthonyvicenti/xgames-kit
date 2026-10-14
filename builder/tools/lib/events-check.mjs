// verify gate C, measure 38: every event answered (builder/GATES.md). The general question checks 13, 15, 16
// and 18 each asked of one kind of event: something happened to a player, so did that player see or hear it, soon?
//
// One solo page with 3 bots (the game's own rules, config and weapon, on stepped time when its kit offers it), the
// audio tap on, the round cut short through Studio's overrides. A scripted player walks, stands still, fires the primary
// and presses interact, the way a new player does; the bots and the game do the rest. After every step of the game's
// time verify keeps the player's own screen (a screenshot), the camera and the HUD's words and bars, and reads the
// kit's event log (window.__game.events(), kit/core/events.js).
//
// For every event the log names this player in (a hit they landed or took, a kill, a pickup, a shot fired, a swing, a
// respawn, a gate passed, a tag, a move; a mechanic's manifest marks the few that nothing answers by design `quiet`),
// verify looks for its answer within WINDOW_S seconds, any of:
//   the HUD     the words, bars and meters of #gf-ui changed (the clock, the nameplates and other players' scores aside)
//   a sound     the kit played one there (its log; within SOUND_NEAR_M of the event, or with no place in the same moment) at a
//               level anyone hears: its voice's own level, the loudest sample of its buffer with its gain, over AUDIBLE_DB
//   pixels      where it happened on this player's screen (the event's point, projected; a box sized by distance),
//               at least CHANGE_MIN of the pixels changed beyond the noise between the two frames before it: judged
//               only while the camera stood still (a moving view changes every pixel and proves nothing)
// An event with none of the three while the view moved is unmeasured, not unanswered. A KIND of event (projectile.onHit,
// pickup.onCollect, …) fails when it was measured and never once answered; the detail names it, with when and where.
// And every sound the kit started (on the page, and in the solo round verify hands over) must have put out a level
// anyone hears at least once: its voice's own level, which the kit reports per play (a busy mix cannot single one sound
// out on the audio tap, which stays as the proof the page's audio ran). A dead file or a gain far too low fails it, by id
// (the heard half of check 18; the listed half stays in gate A).
// The two old measures of a kind (13 inputs on a quiet page, 16 a hit's read on an enemy) stay in gate C beside this
// one; this one is the class, so a new kind of event needs no new check.
import { prepareStepped, stepUrl, clockFor, mouseTaken } from './stepped.mjs';
import { regionChange } from './hits-check.mjs';
import { resetAudioTap, audioReport } from '../../audio-gates/qa-gate-v5.mjs';
import { shortRound } from './flow-signs.mjs';
import { turnBy } from './lock.mjs';
import { mechanicParts } from '../catalog.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = v => Math.round(v * 100) / 100;
export const EVENT_LIMITS = { SECONDS: 15, STEP_MS: 150, SOUND_NEAR_M: 4, MIN_PLAYS: 2, WINDOW_S: 0.6, NEAR_M: 24, BOX_K: 900, BOX_MIN: 30, BOX_MAX: 110, CHANGE_MIN: 0.03, PER_KIND: 3, AUDIBLE_DB: -50, TAP_MS: 180, CAM_EPS: 0.002 };

/** The events nothing on screen answers by design: `quiet: true` in their mechanic's manifest. → Set('part.name') */
export async function quietKinds(kit) {
  const out = new Set();
  for (const p of await mechanicParts(kit ? { kit } : {})) for (const e of p.manifest?.events ?? []) if (e.quiet) out.add(`${p.id}.${e.name}`);
  return out;
}

/** In the page: what the player's own screen says now, besides its pixels. */
const OBS = () => {
  const g = window.__game; if (!g) return null;
  const s = g.snapshot(), me = s.players.find(p => p.local);
  // the HUD as it speaks to this player: the kit HUD's widgets (health, a tank, a station's quota, …), the goal line,
  // the meters, a toast, a banner, a prompt, and their own score; never the clock, the nameplates, other players'
  // scores or the bars over enemies (those are in the world: the pixels judge them)
  const ui = document.getElementById('gf-ui');
  let h = null; try { h = g.hud?.() ?? null; } catch {}
  const txt = sel => [...(ui?.querySelectorAll(sel) ?? [])].map(e => e.textContent.replace(/\s+/g, ' ').trim()).join('/');
  const hud = JSON.stringify([h?.goal?.text ?? '', (h?.widgets ?? []).map(w => [w.id, w.shown, w.shows]), h?.meters ?? [], txt('.gf-toasts'), txt('.gf-banner'), txt('.gf-prompt'), me?.score ?? 0]);
  let cam = null; try { const c = g.camera(); cam = [...(c.eye ?? []), ...(c.dir ?? [])]; } catch {}
  return { t: s.time?.now ?? 0, phase: s.phase, me: me?.id ?? null, at: me ? { x: me.x, y: me.y, z: me.z } : null, hud, cam, w: innerWidth, h: innerHeight };
};
/** In the page: the log since `since`, each point projected onto this player's screen. */
const LOG = since => {
  const g = window.__game; if (typeof g?.events !== 'function') return null;
  const r = g.events({ since });
  for (const e of r.entries) if (e.at && typeof g.project === 'function') { try { e.screen = g.project(e.at.x, e.at.y + 0.9, e.at.z); } catch {} }
  return r;
};

/**
 * Each sound the kit started, by id: how many times, and how many of those plays put out a level anyone can hear. The
 * level is the kit's own (kit/core/events.js `db`: the loudest sample of the voice's buffer with the voice's gain,
 * before the bus), so a sound is judged alone however busy the mix is (the tap's recording of the mix cannot single one
 * sound out in a round where several start at once). → [{id, plays, loud, maxDb (null: the kit gave no level)}]
 */
export function soundLevels(plays, L = EVENT_LIMITS) {
  const out = new Map();
  for (const sp of plays) {
    if (!sp.ok) continue;
    const r = out.get(sp.id) ?? { id: sp.id, plays: 0, loud: 0, maxDb: null }; r.plays++;
    if (Number.isFinite(sp.db)) { r.maxDb = r.maxDb === null ? sp.db : Math.max(r.maxDb, sp.db); if (sp.db > L.AUDIBLE_DB) r.loud++; }
    out.set(sp.id, r);
  }
  return [...out.values()];
}

const still = (frames, L) => {
  const c0 = frames[0]?.obs?.cam;
  if (!c0 || c0.length < 6) return false;
  return frames.every(f => f.obs?.cam && f.obs.cam.length === c0.length && f.obs.cam.every((v, i) => Math.abs(v - c0[i]) <= L.CAM_EPS));
};

/**
 * The verdict from the measurements (pure: tests/g-gates.test.mjs holds it). items: [{kind, t, who, at, evidence:
 * {hud, sound, pixels (change share or null), still, onScreen}}]; sounds: [{id, plays, heard (count) | null}].
 * → {ok, detail, kinds}
 */
export function judgeEvents({ items = [], sounds = [], log = true, tap = true, seconds = 0 }, L = EVENT_LIMITS) {
  if (!log) return { ok: false, detail: 'the game\'s kit copy keeps no event log (window.__game.events: gf/three/core/events.js), so no event can be traced to what the player saw: create the game again (tools/create.mjs)', kinds: {} };
  const kinds = {};
  for (const it of items) {
    const k = kinds[it.kind] ??= { n: 0, measured: 0, answered: 0, how: {}, unanswered: [] };
    k.n++;
    const e = it.evidence, by = e.hud ? 'the HUD' : e.sound ? 'a sound' : e.pixels !== null && e.pixels >= L.CHANGE_MIN ? 'pixels' : null;
    const measured = !!by || (e.still && e.onScreen && e.pixels !== null);
    if (!measured) continue;
    k.measured++;
    if (by) { k.answered++; k.how[by] = (k.how[by] ?? 0) + 1; }
    else k.unanswered.push(`${it.t} s${it.at ? ` at (${it.at.x}, ${it.at.z})` : ''}: ${e.pixels !== null ? `${r2(e.pixels * 100)}% of the pixels there changed` : 'nothing changed'}, the HUD did not change, no sound`);
  }
  const fails = [];
  for (const [kind, k] of Object.entries(kinds)) if (k.measured && !k.answered) fails.push(`${kind} happened to you ${k.n} time${k.n === 1 ? '' : 's'} (${k.measured} with your view still) and nothing on your screen answered it: ${k.unanswered.slice(0, 2).join('; ')}`);
  const deaf = sounds.filter(s => s.plays >= L.MIN_PLAYS && s.maxDb !== null && s.loud === 0);
  for (const s of deaf) fails.push(`the sound "${s.id}" started ${s.plays} times and never reached the speakers: its loudest play put out ${s.maxDb <= -999 ? 'nothing (a silent file)' : `${s.maxDb} dB`}, under the ${L.AUDIBLE_DB} dB anyone hears (a dead file, a gain far too low)`);
  const answered = Object.entries(kinds).filter(([, k]) => k.answered).map(([kind, k]) => `${kind} ${k.answered}/${k.measured} (${Object.entries(k.how).map(([h, n]) => `${h} ${n}`).join(', ')})`);
  const unmeasured = Object.entries(kinds).filter(([, k]) => !k.measured).map(([kind, k]) => `${kind} ${k.n}`);
  const heard = sounds.filter(s => s.loud > 0).map(s => s.id);
  const head = `${items.length} event${items.length === 1 ? '' : 's'} named you in ${seconds} s with 3 bots`;
  const tail = `${answered.length ? `; answered: ${answered.join('; ')}` : ''}${unmeasured.length ? `; not measured (the view moved, nothing on the HUD or heard): ${unmeasured.join(', ')}` : ''}; sounds heard: ${heard.length ? heard.join(', ') : 'none'}${tap ? '' : ' (the audio tap heard nothing on the page: its audio may not have run)'}`;
  if (fails.length) return { ok: false, detail: `${fails.join(' | ')}. Measured: ${head}${tail}. Every event a player takes part in must show on their own screen or be heard: keep the kit's answer (its effect, sound or HUD line) and give the game's own events one (ctx.audio.play at the place, ctx.ui.toast, a mechanic's vfx); a sound must be a real file at a real level`, kinds };
  return { ok: true, detail: items.length || sounds.length ? `${head}${tail}` : `${head}: nothing to answer (no event named the player)`, kinds };
}

/**
 * Measure 38. newPage(label, {overrides, audio}) → {ctx, page, errors} (verify's own); browser: for the pixel analysis;
 * url: the served game; game: config/game.json; walkKeys: the game's own walk keys (tools/lib/flat-reads.mjs walkOf).
 * → {ok, detail, record, warnings}
 */
export async function checkEvents({ newPage, browser, url, game, walkKeys = { forward: 'KeyW' }, shot = async () => null, log = () => {}, stepped = true, kit = null, heardAlso = [] }, L = EVENT_LIMITS) {
  const t0 = Date.now(), warnings = [];
  const quiet = await quietKinds(kit).catch(() => new Set());
  const T = await newPage('events', { audio: true, overrides: { patches: shortRound(game, L.SECONDS + 14) } });
  const p = T.page;
  const record = { url: '?seed=11&bots=3', limits: L, steps: 0, items: [], sounds: [], clock: null };
  const items = [], soundPlays = [];
  let hasLog = true, raw = null, tapRan = false, seconds = 0;
  const frames = [];                        // {i, t, img, obs}
  const pending = [];                       // {item, before: [frame, frame], after: [frames]}
  const done = [];
  // one event once its window has passed: the HUD, the still view, and the pixels where they can tell (the sound is
  // judged after the page, when the tap's recording is in)
  const perKind = {};
  const settle = async q => {
    const it = q.item, b = q.before.at(-1), afters = q.after.filter(x => x.t > (b?.t ?? -1));
    // the HUD answers only when it stood still over the two frames before (a HUD that changes all the time, a world
    // widget in a busy round, proves nothing about this one event)
    const hudStill = q.before.length === 2 && q.before[0].obs?.hud === q.before[1].obs?.hud;
    const hud = !!(b && hudStill && afters.some(x => x.obs?.hud !== b.obs?.hud));
    const st = q.before.length === 2 && still([...q.before, ...afters], L);
    let pixels = null;
    perKind[it.kind] ??= 0;
    if (!hud && st && q.onScreen && perKind[it.kind] < L.PER_KIND && q.before.every(x => x.img) && afters.some(x => x.img)) {
      perKind[it.kind]++;
      const d = Math.max(1, it.d ?? 6), half = Math.max(L.BOX_MIN, Math.min(L.BOX_MAX, L.BOX_K / d));
      const box = { x0: it.screen.x - half, x1: it.screen.x + half, y0: it.screen.y - half * 1.2, y1: it.screen.y + half * 0.8 };
      try { pixels = (await regionChange(browser, q.before.map(x => x.img), afters.filter(x => x.img).map(x => x.img), box, { mime: 'image/jpeg' })).change; } catch (e) { warnings.push(`events: pixel analysis: ${e.message}`); }
    }
    return { item: it, hud, still: st, onScreen: q.onScreen, pixels };
  };
  try {
    if (stepped) await prepareStepped(p);
    await p.goto(stepped ? stepUrl(`${url}?seed=11&bots=3`) : `${url}?seed=11&bots=3`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    hasLog = await p.evaluate(() => typeof window.__game?.events === 'function').catch(() => false);
    const play = await p.locator('#gf-play').boundingBox().catch(() => null);
    if (play) await p.mouse.click(play.x + play.width / 2, play.y + play.height / 2); else await p.keyboard.press('Enter');
    const clock = await clockFor(p, { real: !stepped });
    record.clock = clock.stepped ? 'stepped' : 'wall';
    for (let t = clock.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (clock.now() - t > 20000) throw new Error('the round did not start'); await clock.wait(120); }
    await clock.wait(800);
    const vp = p.viewportSize() ?? { width: 1280, height: 720 }, cursor = { x: Math.round(vp.width / 2), y: Math.round(vp.height * 0.55) };
    await p.mouse.move(cursor.x, cursor.y); await p.mouse.click(cursor.x, cursor.y); await mouseTaken(p); await clock.wait(200);
    await resetAudioTap(p).catch(() => {});
    if (!hasLog) throw new Error('no event log');
    let since = (await p.evaluate(LOG, 0))?.next ?? 0;
    const take = async () => { const f = { i: frames.length, img: await p.screenshot({ type: 'jpeg', quality: 88 }), obs: await p.evaluate(OBS) }; f.t = f.obs?.t ?? 0; frames.push(f); return f; };
    await take(); await clock.wait(L.STEP_MS); await take();
    const steps = Math.round(L.SECONDS * 1000 / L.STEP_MS);
    let down = new Set();
    const key = async (k, on) => { if (on && !down.has(k)) { await p.keyboard.down(k); down.add(k); } if (!on && down.has(k)) { await p.keyboard.up(k); down.delete(k); } };
    const cycleS = 2;
    for (let s = 0; s < steps; s++) {
      // the scripted player: a 2 s cycle of walking 0.7 s, then standing still (the camera too), firing the primary from
      // 1.0 to 1.4 s and pressing interact at 1.7 s; every third cycle it turns first, to face somewhere new
      const at = s * L.STEP_MS / 1000, c = at % cycleS, prev = s === 0 ? -1 : ((s - 1) * L.STEP_MS / 1000) % cycleS, cycle = Math.floor(at / cycleS);
      const cross = x => c >= x && (prev < x || prev > c);      // this step reached the moment x of the cycle
      if (c < L.STEP_MS / 1000 && cycle % 3 === 2) await turnBy(p, cursor, 260, 0).catch(() => {});
      await key(walkKeys.forward, c < 0.7);
      if (cross(1.0)) await p.mouse.down().catch(() => {});
      if (cross(1.4)) await p.mouse.up().catch(() => {});
      if (cross(1.7)) await p.keyboard.press('KeyE');
      await clock.wait(L.STEP_MS);
      const f = await take();
      if (f.obs?.phase !== 'playing') { warnings.push(`events: the round left play (${f.obs?.phase ?? 'no observation'}) after ${r2(f.t)} s`); break; }
      const lg = await p.evaluate(LOG, since).catch(() => null);
      if (lg) {
        since = lg.next;
        for (const e of lg.entries) {
          if (e.k === 'sound') { soundPlays.push(e); continue; }
          if (e.k !== 'event') continue;
          const kind = `${e.part}.${e.name}`;
          if (quiet.has(kind)) continue;
          const named = Object.values(e.who ?? {}).flat();
          if (!named.includes(f.obs.me)) continue;
          const sc = e.screen, near = e.at && f.obs.at ? Math.hypot(e.at.x - f.obs.at.x, e.at.z - f.obs.at.z) : null;
          const onScreen = !!(sc && sc.front && sc.x >= 0 && sc.y >= 0 && sc.x <= f.obs.w && sc.y <= f.obs.h && (near === null || near <= L.NEAR_M));
          const before = frames.slice(-3, -1);       // the two frames before the step this event happened in
          pending.push({ item: { kind, t: e.t, who: e.who, at: e.at ?? null, screen: sc ?? null, d: near === null ? null : r2(near) }, onScreen, before, after: [f], i: e.i });
        }
      }
      // pending events whose window has passed: judged now (time stands still on a stepped page), so their frames go
      for (const q of pending.splice(0)) {
        if (q.after.at(-1) !== f) q.after.push(f);
        if (f.t < q.item.t + L.WINDOW_S && s < steps - 1) { pending.push(q); continue; }
        done.push(await settle(q));
      }
      // keep only the frames something still needs (a pending event's, and the last three)
      const keep = new Set(frames.slice(-3).map(x => x.i));
      for (const q of pending) for (const x of [...q.before, ...q.after]) keep.add(x.i);
      for (const x of frames) if (!keep.has(x.i) && x.img) x.img = null;
      record.steps = s + 1;
    }
    for (const k of [...down]) await p.keyboard.up(k).catch(() => {});
    await p.mouse.up().catch(() => {});
    for (const q of pending.splice(0)) done.push(await settle(q));
    seconds = Math.round(record.steps * L.STEP_MS / 100) / 10;
    // what the tap heard (and v5's hidden-tab leg, which this page does not judge)
    const a = await audioReport(p, { raw: true, hiddenSeconds: 0.2 }).catch(e => { warnings.push(`events: the audio tap: ${e.message}`); return null; });
    raw = a?.raw ?? null; tapRan = !!(a && a.contexts > 0 && raw?.L?.length);
    await shot(p, 'events');
  } catch (e) {
    if (e.message !== 'no event log') warnings.push(`events page stopped: ${e.message}`);
  } finally {
    const errors = T.errors.slice();
    await T.ctx.close().catch(() => {});
    if (errors.length) warnings.push(`events page console errors: ${[...new Set(errors)].slice(0, 2).join(' | ')}`);
  }
  // the evidence for each event: the HUD and the pixels (settled above), and a sound the kit played that the tap heard
  for (const q of done) {
    const it = q.item;
    // a sound is this event's when the kit played it where the event was (within SOUND_NEAR_M), or, a sound with no
    // place (the interface's), in the same moment: in a busy round some sound always plays somewhere
    const near = soundPlays.filter(sp => sp.ok && sp.t >= it.t - 0.05 && sp.t <= it.t + L.WINDOW_S
      && (sp.at && it.at ? Math.hypot(sp.at.x - it.at.x, sp.at.z - it.at.z) <= L.SOUND_NEAR_M : !sp.at && Math.abs(sp.t - it.t) <= 0.06));
    const sound = near.some(sp => !Number.isFinite(sp.db) || sp.db > L.AUDIBLE_DB);   // (a play at no level anyone hears answers nothing)
    items.push({ ...it, evidence: { hud: q.hud, sound, pixels: q.pixels, still: q.still, onScreen: q.onScreen } });
  }
  // every sound the kit started on the page, and whether the tap heard one of its plays
  // every sound the kit started on this page and in the solo round verify passes (heardAlso: [{plays}])
  const sounds = soundLevels([...soundPlays, ...heardAlso.flatMap(h => h?.plays ?? [])], L);
  const j = judgeEvents({ items, sounds, log: hasLog, tap: tapRan, seconds }, L);
  record.items = items.slice(0, 80).map(x => ({ kind: x.kind, t: x.t, d: x.d, ...x.evidence, pixels: x.evidence.pixels === null ? null : r2(x.evidence.pixels) }));
  record.itemCount = items.length;
  record.sounds = sounds; record.kinds = j.kinds; record.tap = tapRan; record.seconds = Math.round((Date.now() - t0) / 1000);
  log(`  events: ${j.ok ? 'ok' : 'FAIL'} ${j.detail.slice(0, 220)}`);
  return { ok: j.ok, detail: j.detail, record, warnings };
}
