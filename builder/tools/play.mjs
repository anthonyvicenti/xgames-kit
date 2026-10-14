#!/usr/bin/env node
// gf-three play: a small black-box play harness for the play-tester (builder/spec/prompts/playtest.md).
// It plays a game the way a new player does, with real keys and mouse in headless Chrome on the real GPU
// (builder/qa/browser.mjs), and records what the player sees: screenshots of their own view and the
// HUD text. It never reads the game's code or config.
//
//   node builder/tools/play.mjs <game dir | url> --script steps.json --out <dir> [--steps '<json>'] [--size 1280x720] [--headed] [--json] [--gpu webgl|webgpu]
//
// A game folder is served by tools/serve.mjs on a free port; a URL is played as it is. The step language is in
// tools/lib/play-script.mjs (start, hold, press, move, look, wait, shot, snap, until, again, click). Prints one line per
// step (the phase, the round clock, my score and state, the HUD meters and hints, any screenshot path) and writes
// <out>/play.json (every step with its state, the console errors) and <out>/NN-<name>.jpg screenshots.
// A friend (gf-forge wave 3): {"do":"start","friend":true} hosts the game on its own friends page (the kit's party server,
// real WebRTC) and joins a second player from a second window; a step with "who":"friend" plays that player, and
// {"do":"face"} turns both to look at each other, so a co-op picture has the friend in it. A game folder only.
// A 60 s script takes about a minute. GF_PLAY_SOFTWARE=1 renders in software (slow; for a machine with no GPU). A scenic
// game (CONTRACT §8) plays in WebGPU Chrome, a party game in WebGL Chrome; --gpu picks one.
// Exit: 0 every step ran, 1 a step failed (play.json still written), 2 bad usage or a bad script.
import { isMain } from './lib/main.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript, judgeExpect } from './lib/play-script.mjs';
import { fightFor } from './lib/forge-fight.mjs';
import { launchChrome, GPU_TROUBLE } from '../qa/browser.mjs';
import { launchForGame, placeOfGame } from './lib/paths.mjs';
import { POINTER_LOCK } from './lib/forge-feel-check.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = v => Math.round(v * 10) / 10;

// What a player can see, read in the page: the phase and clock, every player's score and state, and the HUD's words
// (meters with their fill, the hint line, the banner, toasts, the scoreboard, the help line, a card and its text).
const OBSERVE = () => {
  const s = window.__game?.snapshot?.() ?? null;
  const ui = document.getElementById('gf-ui');
  let hud = null;
  if (ui && ui.style.display !== 'none') {
    const shown = e => { if (!e) return false; const c = getComputedStyle(e); return c.display !== 'none' && c.visibility !== 'hidden' && parseFloat(c.opacity) > 0.05; };
    const q = sel => ui.querySelector(sel);
    const text = e => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const card = document.getElementById('gf-card');
    hud = {
      timer: shown(q('.gf-timer')) ? text(q('.gf-timer')) || null : null,
      meters: [...ui.querySelectorAll('.gf-meter')].filter(shown).map(m => ({ label: text(m.querySelector('b')), pct: Math.round(parseFloat(m.querySelector('u')?.style.width) || 0) })),
      prompt: shown(q('.gf-prompt')) ? text(q('.gf-prompt')) : null,
      banner: q('.gf-banner')?.classList.contains('on') ? text(q('.gf-banner')) : null,
      toasts: [...ui.querySelectorAll('.gf-toast')].map(text).filter(Boolean),
      scores: [...ui.querySelectorAll('.gf-scores > div')].map(d => `${text(d.children[0])} ${text(d.children[1])}`.trim()),
      help: shown(q('.gf-help')) ? text(q('.gf-help')) : null,
      crosshair: shown(q('.gf-cross')),
      card: card && !card.hidden ? { view: card.dataset.view || null, text: (card.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) } : null,
      // the kit's player card and goal line, and the home or pause menu when one is open (CONTRACT §6g)
      player: shown(q('#gf-hud')) ? text(q('#gf-hud')).slice(0, 160) : null,
      goal: shown(q('#gf-goal')) ? text(q('#gf-goal')) : null,
      menu: shown(q('#gf-menu')) ? { view: s?.view ?? null, text: (q('#gf-menu .gf-col')?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) } : null,
    };
  }
  if (!s) return { phase: null, hud };
  // a forge game (first person): what its feel layer shows on screen now (gf/forge/feel.js observe(): the weapon and
  // its rounds, the red edge when hurt, the low-health stage, the combo, the numbers floating over hits, the hit
  // marker, the death recap). Only what is displayed: never the core's own numbers a player cannot see
  let feel = null;
  try {
    const f = window.__game?.forge?.feel?.()?.shown ?? null;
    if (f) feel = { weapon: f.ammo?.name ?? null, rounds: f.ammo?.text ?? null, hurtEdge: Math.round((f.edge ?? 0) * 100), lowHealthStage: f.lowStage ?? 0, combo: f.combo?.text ?? null, numbers: (f.numbers ?? []).filter(n => n.shown).map(n => n.text).slice(0, 6), crosshair: !!f.crosshair, hitMarker: !!f.hitMarker, recap: !!f.recap };
  } catch {}
  const me = s.players?.find(p => p.local) ?? null;
  const pl = p => ({ name: p.name, you: !!p.local, bot: !!p.bot, score: p.score, anim: p.anim ?? null, control: p.control ?? null, alive: p.alive !== false, down: p.down ?? null });
  return {
    phase: s.phase, round: s.round ?? null, t: s.time?.round ?? null, left: s.time?.left ?? null,
    me: me ? { ...pl(me), x: me.x, z: me.z } : null,
    players: (s.players ?? []).map(pl),
    results: s.phase === 'results' ? (s.results ?? []).map(r => ({ name: r.name ?? r.id, value: r.value })) : undefined,
    winners: s.phase === 'results' ? s.winners ?? [] : undefined,
    hud,
    ...(feel ? { feel } : {}),
    locked: document.pointerLockElement != null,
  };
};

/** One compact line for a state (what a player would glance at). */
export function stateLine(st) {
  if (!st) return 'no state';
  if (!st.phase) return 'no game on the page (window.__game is missing)';
  const parts = [`${st.phase}${st.t != null ? ` t=${r1(st.t)}s` : ''}`];
  if (st.hud?.timer) parts.push(`clock ${st.hud.timer}`);
  if (st.me) parts.push(`me: ${st.me.score} pts, ${st.me.anim ?? '?'}${st.me.control === false ? ', NOT in control' : ''}${st.me.alive ? '' : ', out'}`);
  if (st.hud?.player) parts.push(`card "${st.hud.player}"`);
  for (const m of st.hud?.meters ?? []) parts.push(`${m.label || 'meter'} ${m.pct}%`);
  if (st.feel) {
    const f = st.feel;
    if (f.weapon || f.rounds) parts.push(`weapon ${f.weapon ?? '?'}${f.rounds ? ` ${f.rounds}` : ''}`);
    if (f.hurtEdge > 5) parts.push(`red edge ${f.hurtEdge}%`);
    if (f.lowHealthStage) parts.push(`low health stage ${f.lowHealthStage}`);
    if (f.combo) parts.push(`combo ${f.combo}`);
    if (f.numbers.length) parts.push(`numbers on screen ${f.numbers.join(' ')}`);
    if (f.hitMarker) parts.push('hit marker');
    if (f.recap) parts.push('death recap shown');
  }
  if (st.hud?.prompt) parts.push(`hint "${st.hud.prompt}"`);
  if (st.hud?.banner) parts.push(`banner "${st.hud.banner}"`);
  if (st.hud?.toasts?.length) parts.push(`toast "${st.hud.toasts.at(-1)}"`);
  if (st.hud?.card) parts.push(`card ${st.hud.card.view}: "${st.hud.card.text.slice(0, 90)}"`);
  if (st.hud?.menu) parts.push(`menu ${st.hud.menu.view}: "${st.hud.menu.text.slice(0, 90)}"`);
  return parts.join(' | ');
}

/**
 * Plays `script` (parsed or not) on `target` (a game folder or a URL). → the record written to <out>/play.json.
 * Options: out (required), log (a line printer), size ('1280x720'), headed, gpu ('webgl' | 'webgpu'; default: the game's).
 */
export async function play(target, script, { out, log = console.log, size = '1280x720', headed = false, gpu: gpuFlag = null } = {}) {
  if (!out) throw new Error('play: --out <dir> is required');
  const parsed = script?.steps && Array.isArray(script.steps) && script.seconds !== undefined ? script : parseScript(script);
  const outDir = resolve(out); await mkdir(outDir, { recursive: true });
  const [w, h] = String(size).split('x').map(Number);
  const isUrl = /^https?:\/\//.test(String(target));
  if (!isUrl && !(existsSync(target) && statSync(target).isDirectory())) throw new Error(`play: ${target} is neither a URL nor a game folder`);
  const t0 = Date.now();
  const rec = { schema: 'gf-three-play/1', target: isUrl ? target : resolve(target), started: new Date().toISOString(), size: `${w}x${h}`, notes: [...parsed.notes], steps: [], shots: [], errors: [], ok: true };
  for (const n of parsed.notes) log(`note: ${n}`);
  let srv = null, browser = null;
  try {
    let url = target;
    // a friend (wave 3): the game's own friends page, hosted and joined over real WebRTC (the kit's party server, as
    // verify's two-player checks use it); a round alone: the game served as it is
    const friendly = parsed.steps[0]?.friend === true;
    if (friendly && isUrl) throw new Error('a friend needs a game folder: a link is somebody else\'s room to host (play it alone, and say the friend could not be tried)');
    let party = null;
    if (friendly) { const { startParty } = await import('../multiplayer/party/lib.mjs'); srv = party = await startParty({ dir: resolve(target), port: 0 }); url = party.url; }
    else if (!isUrl) { const { serve } = await import('./serve.mjs'); srv = await serve(target, { port: 0 }); url = srv.url; }
    url = String(url).replace(/[?#].*$/, '');
    const software = process.env.GF_PLAY_SOFTWARE === '1';
    // the game's own renderer (CONTRACT §8): WebGPU for scenic-3d, forge and vista, WebGL for standard-3d and flat-2d. A
    // URL says which through the gf-three.json it serves; --gpu webgl|webgpu overrides
    const served = isUrl ? await fetch(new URL('gf-three.json', url.endsWith('/') ? url : `${url}/`)).then(r => r.ok ? r.json() : null).then(j => (j?.kit?.runtime ? { runtime: j.kit.runtime, profile: j.kit.profile ?? null } : null)).catch(() => null) : null;
    const launched = gpuFlag ? { browser: await launchChrome({ headless: !headed, gpu: gpuFlag }), gpu: gpuFlag, note: null }
      : await launchForGame(launchChrome, isUrl ? null : target, { software, headless: !headed, ...(served ? { place: served } : {}) });
    browser = launched.browser;
    if (launched.note) { rec.notes.push(launched.note); log(`note: ${launched.note}`); }
    rec.chrome = browser.version(); rec.renderer = software ? 'software' : `gpu (${launched.gpu})`;
    // a phone ({"do":"start","touch":true}): a touch screen at --size, fingers through CDP touch events
    const touch = parsed.steps[0]?.touch === true;
    const runtime = (served ?? (isUrl ? null : await placeOfGame(resolve(target))))?.runtime ?? 'three';
    const forge = runtime === 'forge';
    // a forge or vista game is first person, and headless Chrome grants no pointer lock: emulate it, so the mouse's real
    // relative motion turns the view (as every forge check does: tools/lib/forge-feel-check.mjs POINTER_LOCK; a vista
    // game the same: tools/lib/lock.mjs)
    const emulatedLock = (forge || runtime === 'vista') && !touch && !headed;
    const center = { x: Math.round(w / 2), y: Math.round(h / 2) };
    /** A window with a player in it. `framed`: the game is in the friends page's frame (the page around it is the room's). */
    const open = async (who, framed, round) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
      if (emulatedLock) await ctx.addInitScript(POINTER_LOCK);
      if (round) await ctx.addInitScript(o => { globalThis.__GF_ASSET_OVERRIDES = o; }, { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: round }] });
      const page = await ctx.newPage();
      page.on('pageerror', e => rec.errors.push(`${who === 'me' ? '' : `${who}: `}${String(e.message).slice(0, 300)}`));
      page.on('console', m => { if (m.type() === 'error' && !GPU_TROUBLE.test(m.text())) rec.errors.push(`${who === 'me' ? '' : `${who}: `}${m.text().slice(0, 300)}`); });
      const cursor = { ...center };
      // where the game is: the page itself, or its frame inside the friends page
      const G = () => (framed ? page.frames().find(f => f.parentFrame() === page.mainFrame()) ?? page : page);
      const down = async k => { if (k === 'Mouse') await page.mouse.down({ button: 'left' }); else if (k === 'MouseRight') await page.mouse.down({ button: 'right' }); else await page.keyboard.down(k); };
      const up = async k => { if (k === 'Mouse') await page.mouse.up({ button: 'left' }); else if (k === 'MouseRight') await page.mouse.up({ button: 'right' }); else await page.keyboard.up(k); };
      // Turning: with the mouse taken (pointer lock) the game reads the movement between mouse events. Under the emulated
      // lock the cursor is still a cursor: before it would leave the screen it goes back to the middle with the lock
      // released, so a long turn never stops at an edge
      const recentre = async () => {
        await G().evaluate(() => document.exitPointerLock()).catch(() => {});
        Object.assign(cursor, center); await page.mouse.move(cursor.x, cursor.y);
        await G().evaluate(() => document.getElementById('gf-canvas')?.requestPointerLock()).catch(() => {});
      };
      const turn = async (dx, dy, ms = 0) => {
        const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 30)), each = ms / n;
        for (let i = 1; i <= n; i++) {
          if (emulatedLock && (cursor.x + dx / n < 60 || cursor.x + dx / n > w - 60 || cursor.y + dy / n < 60 || cursor.y + dy / n > h - 60)) await recentre();
          cursor.x += dx / n; cursor.y += dy / n; await page.mouse.move(cursor.x, cursor.y); if (each) await sleep(each);
        }
      };
      return {
        who, ctx, page, cursor, G, down, up, turn,
        observe: () => G().evaluate(OBSERVE).catch(e => ({ phase: null, error: e.message.split('\n')[0] })),
        phase: () => G().evaluate(() => window.__game?.phase ?? null).catch(() => null),
        takeMouse: async () => { await page.mouse.click(cursor.x, cursor.y); await sleep(250); return G().evaluate(() => document.pointerLockElement != null).catch(() => false); },
      };
    };
    const me = await open('me', friendly, parsed.steps[0]?.round);
    const friend = friendly ? await open('friend', true, parsed.steps[0]?.round) : null;
    const page = me.page, cursor = me.cursor;
    const cdp = touch ? await me.ctx.newCDPSession(page) : null;
    if (touch) rec.touch = true;
    const observe = me.observe, phase = me.phase;
    const until = async (want, seconds) => { const end = Date.now() + seconds * 1000; for (;;) { const p = await phase(); if (want.includes(p)) return p; if (Date.now() > end) throw new Error(`the game did not reach ${want.join(' or ')} within ${seconds} s (it is in ${p ?? 'no phase'})`); await sleep(200); } };
    const shoot = async (n, name, A = me) => { const f = `${String(n).padStart(2, '0')}-${name}.jpg`; await A.page.screenshot({ path: join(outDir, f), type: 'jpeg', quality: 80 }); rec.shots.push(f); return join(outDir, f); };
    // Fingers (a phone): touch points through CDP, so two can be down at once (walk while looking or firing)
    const fingers = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, id) => ({ x: Math.round(p[0]), y: Math.round(p[1]), id, radiusX: 8, radiusY: 8, force: 1 })) });
    const dragFor = async (st) => {
      if (!cdp) throw new Error('fingers need a touch screen: start with {"do":"start","touch":true}');
      const tracks = [{ from: st.from, to: st.to }, ...(st.with ? [st.with] : [])], slide = Math.min(st.seconds * 1000 * 0.4, 400), steps = 8;
      await fingers('touchStart', tracks.map(t => t.from));
      try {
        for (let i = 1; i <= steps; i++) { await sleep(slide / steps); await fingers('touchMove', tracks.map(t => [t.from[0] + (t.to[0] - t.from[0]) * i / steps, t.from[1] + (t.to[1] - t.from[1]) * i / steps])); }
        await sleep(Math.max(0, st.seconds * 1000 - slide));
        return st.shot ? await shoot(rec.steps.length + 1, st.shot) : null;
      } finally { await fingers('touchEnd', []).catch(() => {}); }
    };
    const holdFor = async (st, A = me) => {
      for (const k of st.keys) await A.down(k);
      try {
        if (st.look) await A.turn(st.look.dx, st.look.dy, st.seconds * 1000 * 0.9);
        else await sleep(st.seconds * 1000);
        return st.shot ? await shoot(rec.steps.length + 1, st.shot, A) : null;
      } finally { for (const k of [...st.keys].reverse()) await A.up(k).catch(() => {}); }
    };
    /** With a friend: host the room on the game's own friends page, join the friend with the invite, start the round. */
    const startFriends = async () => {
      const wait = async (fn, seconds, what) => { const end = Date.now() + seconds * 1000; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`the friends page did not get to ${what} within ${seconds} s`); await sleep(200); } };
      await me.page.goto(`${party.partyUrl}?max=300`, { waitUntil: 'load', timeout: 90000 });
      await wait(() => me.page.locator('#gfp-host').isVisible(), 30, 'its home');
      await me.page.fill('#gfp-name', 'Me'); await me.page.click('#gfp-host');
      const invite = await wait(async () => (await me.page.locator('#mp-invite').isVisible()) && (await me.page.inputValue('#mp-invite')), 30, 'a room with an invite');
      await friend.page.goto(invite, { waitUntil: 'load', timeout: 90000 });
      await wait(() => friend.page.locator('#gfp-join').isVisible(), 30, 'the friend\'s join');
      await friend.page.fill('#gfp-name', 'Friend'); await friend.page.click('#gfp-join');
      await wait(() => me.page.locator('#mp-start').isEnabled(), 40, 'both players in the room');
      await shoot(0, 'room');
      await me.page.click('#mp-start');
      await wait(async () => (await me.G().evaluate(() => window.__game?.snapshot?.()?.net?.started).catch(() => false)) && (await friend.G().evaluate(() => window.__game?.snapshot?.()?.net?.started).catch(() => false)), 120, 'both games started');
      await until(['playing'], 30);
      await sleep(1200);
      // the keys go to each game's canvas (no click: each player looks where it spawned until a step turns it)
      for (const A of [me, friend]) { await A.G().focus('#gf-canvas').catch(() => {}); await A.page.mouse.move(center.x, center.y); }
    };
    /** Both players turn to look at each other where they stand, as each would with the mouse (QA: the core's own look
     *  command, window.__game.forge.face; a first-person forge game). */
    const face = async () => {
      const at = async A => A.G().evaluate(() => { const g = window.__game; const o = g?.forge?.players?.().find(p => !p.local) ?? null; if (!o || typeof g.forge.face !== 'function') return null; g.forge.face(o.x, o.y + 1.25, o.z); const m = g.forge.players().find(p => p.local); return { friend: [o.x, o.y, o.z].map(v => Math.round(v * 100) / 100), apart: Math.round(Math.hypot(o.x - m.x, o.z - m.z) * 100) / 100 }; }).catch(() => null);
      const a = await at(me), b = await at(friend);
      if (!a || !b) throw new Error('"face" turns two first-person players of a forge game; this game has no friend in it or no first-person look to turn');
      await sleep(350);
      return { apart: a.apart };
    };

    /** "fight": the script's eyes and hand in a first-person fight for N seconds (lib/forge-fight.mjs). */
    const fight = async st => {
      const did = await fightFor({ frame: () => me.G(), down: k => me.down(k), up: k => me.up(k) }, { seconds: st.seconds, keys: st.keys ?? [], seed: rec.steps.length + 1 });
      if (did.cannot) throw new Error('"fight" is for a first-person fight (a forge game with enemies): this game reports no enemies, or has no first-person look to turn');
      const shot = st.shot ? await shoot(rec.steps.length + 1, st.shot) : null;
      return { did: { shots: did.shots, lookedAround: did.lookedAround, firedAt: did.firedAt, fell: did.fell }, shot };
    };

    const snaps = new Map();       // the observation at each snap (and at the start), for an expect's "since"
    for (const [i, st] of parsed.steps.entries()) {
      const n = i + 1, ts = Date.now(), entry = { n, ...st };
      const A = st.who === 'friend' ? friend : me;
      let shot = null;
      try {
        switch (st.do) {
          case 'start': {
            if (friendly) { await startFriends(); entry.friend = true; entry.mouseTaken = false; rec.friend = true; rec.notes.push('two players in one game: every step plays me (the host) unless it says "who":"friend"; "face" turns both to look at each other'); break; }
            const q = new URLSearchParams({ seed: String(st.seed), bots: String(st.bots), ...(st.quality ? { quality: st.quality } : {}) });
            await page.goto(`${url}?${q}`, { waitUntil: 'load', timeout: 90000 });
            await until(['lobby', 'countdown', 'playing'], 90);
            shot = await shoot(0, 'lobby');
            if (await phase() === 'lobby') {
              const b = await page.locator('#gf-play').boundingBox().catch(() => null);
              if (b && touch) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
              else if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); else await page.keyboard.press('Enter');
            }
            await until(['playing'], 20);
            // a phone has no mouse to take: the fingers are the input from here on
            if (touch) { entry.mouseTaken = false; rec.notes.push('a phone: a touch screen, no mouse and no keys; use tap and drag'); break; }
            await page.mouse.move(center.x, center.y); Object.assign(cursor, center);
            entry.mouseTaken = await me.takeMouse();
            snaps.set('start', await me.G().evaluate(() => { try { return JSON.parse(JSON.stringify(window.__game?.snapshot?.() ?? null)); } catch { return null; } }).catch(() => null));
            // the follow camera (CONTRACT §8) never takes the mouse: the cursor itself aims, so `look` moves the aim point
            entry.cursorAims = !entry.mouseTaken && await page.evaluate(() => [...document.querySelectorAll('canvas')].some(c => c.style.cursor === 'crosshair')).catch(() => false);
            if (entry.cursorAims) rec.notes.push('the mouse cursor aims (a camera from above that follows the player): `look` moves the cursor, and so the aim, across the screen');
            else if (!entry.mouseTaken) rec.notes.push('the page did not take the mouse (no pointer lock): looking turns only while a button is held');
            break;
          }
          case 'hold': case 'move': shot = await holdFor(st, A); break;
          case 'press':
            for (let k = 0; k < st.times; k++) { await A.down(st.key); await sleep(90); await A.up(st.key); await sleep(60); }
            if (st.shot) { await sleep(250); shot = await shoot(n, st.shot, A); }
            break;
          case 'look': await A.turn(st.dx, st.dy, 250); break;
          case 'fight': { const f = await fight(st); entry.fought = f.did; shot = f.shot; break; }
          case 'wait': case 'step': await sleep(st.seconds * 1000); break;     // the play-tester plays in real time: a step is a wait here
          case 'expect': {
            const now = await me.G().evaluate(() => { try { return JSON.parse(JSON.stringify(window.__game?.snapshot?.() ?? null)); } catch { return null; } }).catch(() => null);
            const j = judgeExpect(st, now, snaps.get(st.since ?? 'start') ?? null);
            entry.expect = { ok: j.ok, line: j.line };
            if (!j.ok) throw new Error(`expect: ${j.line}`);
            break;
          }
          case 'shot': shot = await shoot(n, st.name, A); break;
          case 'snap': snaps.set(st.name, await A.G().evaluate(() => { try { return JSON.parse(JSON.stringify(window.__game?.snapshot?.() ?? null)); } catch { return null; } }).catch(() => null)); break;
          case 'until': await until([st.phase], st.timeout); break;
          case 'face':
            if (st.walk) { await friend.down('KeyW'); await sleep(st.walk * 1000); await friend.up('KeyW'); await sleep(500); }
            entry.faced = await face();
            break;
          case 'again': {
            const b = await page.locator('#gf-again').boundingBox().catch(() => null);
            if (!b) throw new Error('no "Play again" button on screen (is the round over? this game may not replay)');
            if (touch) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); else await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
            await until(['countdown', 'playing'], 15); await until(['playing'], 15);
            if (touch) { entry.mouseTaken = false; break; }
            await page.mouse.move(center.x, center.y); Object.assign(cursor, center);
            entry.mouseTaken = await me.takeMouse();
            break;
          }
          case 'click': await page.mouse.click(st.x, st.y, { button: st.button }); Object.assign(cursor, { x: st.x, y: st.y }); break;
          case 'tap': shot = await dragFor({ from: [st.x, st.y], to: [st.x, st.y], seconds: st.seconds, shot: st.shot }); break;
          case 'drag': shot = await dragFor(st); break;
        }
      } catch (e) { entry.error = e.message.split('\n')[0]; rec.ok = false; }
      const state = await A.observe();
      entry.state = st.do === 'snap' ? state : { phase: state.phase, t: state.t, left: state.left, me: state.me, hud: state.hud ? { meters: state.hud.meters, prompt: state.hud.prompt, banner: state.hud.banner, toasts: state.hud.toasts, card: state.hud.card } : null, ...(state.feel ? { feel: state.feel } : {}) };
      if (shot) entry.shot = shot;
      entry.took = r1((Date.now() - ts) / 1000);
      rec.steps.push(entry);
      const whose = st.who === 'friend' ? 'the friend: ' : '';
      const what = whose + (st.do === 'hold' || st.do === 'move' ? `${st.do} ${st.keys.join('+')} ${st.seconds}s` : st.do === 'press' ? `press ${st.key}${st.times > 1 ? ` x${st.times}` : ''}` : st.do === 'look' ? `look ${st.dx},${st.dy}` : st.do === 'wait' ? `wait ${st.seconds}s` : st.do === 'until' ? `until ${st.phase}` : st.do === 'shot' || st.do === 'snap' ? `${st.do} ${st.name}` : st.do === 'tap' ? `tap ${st.x},${st.y} ${st.seconds}s` : st.do === 'drag' ? `drag ${st.from.join(',')}→${st.to.join(',')}${st.with ? ` with ${st.with.from.join(',')}→${st.with.to.join(',')}` : ''} ${st.seconds}s` : st.do === 'face' ? `face each other${entry.faced ? ` (${entry.faced.apart} m apart)` : ''}` : st.do === 'fight' ? `fight ${st.seconds}s${st.keys ? ` moving ${st.keys.join('+')}` : ''}${entry.fought ? ` (${entry.fought.shots} shots at ${entry.fought.firedAt} of them, ${entry.fought.fell} fell${entry.fought.lookedAround ? `, looked around ${entry.fought.lookedAround} times` : ''})` : ''}` : st.do);
      log(`#${n} ${what} → ${entry.error ? `FAILED: ${entry.error} | ` : ''}${stateLine(state)}${shot ? ` | shot ${shot}` : ''}`);
      if (st.do === 'snap') log(`   snap ${st.name}: ${JSON.stringify({ players: state.players?.map(p => `${p.you ? 'YOU' : p.name} ${p.score}${p.bot ? ' (bot)' : ''} ${p.anim ?? ''}${p.control === false ? ' not-in-control' : ''}`), hud: state.hud ? { help: state.hud.help, scores: state.hud.scores, crosshair: state.hud.crosshair } : null, results: state.results })}`);
      if (entry.error || (state.phase === null && st.do !== 'start')) { if (!entry.error) { entry.error = 'the game is gone from the page'; rec.ok = false; } break; }
    }
  } catch (e) {
    rec.ok = false; rec.error = e.message.split('\n')[0]; log(`play stopped: ${rec.error}`);
  } finally {
    await browser?.close().catch(() => {});
    await srv?.close().catch(() => {});
  }
  rec.errors = [...new Set(rec.errors)].slice(0, 20);
  rec.seconds = r1((Date.now() - t0) / 1000);
  await writeFile(join(outDir, 'play.json'), JSON.stringify(rec, null, 2) + '\n');
  log(`play ${rec.ok ? 'ran' : 'FAILED'}: ${rec.steps.length}/${parsed.steps.length} steps in ${rec.seconds} s, ${rec.shots.length} screenshots, ${rec.errors.length} console errors${rec.errors.length ? ` (first: ${rec.errors[0].slice(0, 120)})` : ''} → ${relative(process.cwd(), join(outDir, 'play.json')) || join(outDir, 'play.json')}`);
  return rec;
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2);
  const opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const target = a.find((x, i) => !x.startsWith('--') && !['--script', '--out', '--steps', '--size', '--gpu'].includes(a[i - 1]));
  const usage = 'usage: play.mjs <game dir | url> --script steps.json --out <dir> [--steps \'<json>\'] [--size 1280x720] [--headed] [--json] [--gpu webgl|webgpu]';
  if (!target || !opt('--out') || !(opt('--script') || opt('--steps'))) { console.error(usage); process.exit(2); }
  let parsed;
  try { parsed = parseScript(opt('--steps') ?? await readFile(opt('--script'), 'utf8')); }
  catch (e) { console.error(`bad script:\n${e.message}`); process.exit(2); }
  const json = a.includes('--json');
  try {
    const rec = await play(target, parsed, { out: opt('--out'), size: opt('--size') ?? '1280x720', headed: a.includes('--headed'), gpu: opt('--gpu'), log: json ? () => {} : console.log });
    if (json) process.stdout.write(JSON.stringify(rec, null, 2) + '\n');
    process.exitCode = rec.ok ? 0 : 1;
  } catch (e) { console.error(e.message); process.exit(2); }
}
