// Real play for the play judge (builder/play/JUDGE.md): the game served as a player gets it, played by its bots and
// the scripted player (agent.mjs) on real keys and the mouse, at two and four players where the game allows, for
// several rounds of the game's own length, on the game's own clock (stepped time, kit/core/step.js: a loaded machine
// does not change what is measured). Each round's play feed (window.__game.play(), kit/core/play.js) is read at its end;
// a frame of the player's own screen is kept every second for the clips. With friends (a live game), one more round
// is played by two scripted players over real WebRTC through the game's friends page, both screens kept.
//
//   const r = await playGame(dir, { outDir, log });
//   // → { runs: [{label, players, bots, clock, feed, agent, frames: [{file, t, round}], errors, noFeed?}],
//   //     duo: {feeds: [host, friend], frames: {host: [...], friend: [...]}, errors} | {skipped}, round: {seconds, cut} }
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchChrome, GPU_TROUBLE } from '../qa/browser.mjs';
import { launchForGame, placeOfGame } from '../tools/lib/paths.mjs';
import { startParty, readManifest } from '../multiplayer/party/lib.mjs';
import { kitEditsOverlay } from '../tools/lib/kit-check.mjs';
import { lockFor } from '../tools/lib/lock.mjs';
import { STEP_PRE, STEP_POST, stepUrl, clockFor, mouseTaken } from '../tools/lib/stepped.mjs';
import { createAgent, drive, release, OBSERVE } from './agent.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = v => Math.round(v * 10) / 10;

export const SESSION = {
  ROUND_MAX_S: 120,      // a round longer than this is played to here (said in the record)
  ROUND_MIN_S: 30,       // and never shorter: the idle measure needs a stretch to see
  ROUNDS: 2,             // rounds per player count
  TICK_MS: 250,          // the scripted player decides four times a second (game time)
  FRAME_S: 1,            // one frame of the player's screen a second
  DUO_S: 45,             // the friends round's length
};

/** The player counts a game is played at: two and four where it allows (never fewer than its own minimum). */
export function countsOf(game = {}, spec = {}) {
  const min = Math.max(1, Number(spec.players?.min ?? game.players?.min ?? 1) || 1), max = Math.max(min, Number(spec.players?.max ?? game.players?.max ?? 4) || 4);
  const bots = (spec.players?.bots ?? game.players?.bots) !== false;
  if (!bots) return [1];     // alone (no bots fill the seats); two players come in the friends round
  const out = [...new Set([2, 4].map(n => Math.max(min, Math.min(n, max))))];
  return out.filter(n => n >= 1);
}

/** The round length the judge plays: the game's own, within SESSION's bounds. */
export function roundOf(game = {}) {
  const own = Number(game.round?.seconds) || 0;
  const seconds = Math.max(SESSION.ROUND_MIN_S, Math.min(SESSION.ROUND_MAX_S, own || 60));
  return { seconds, own: own || null, cut: own > SESSION.ROUND_MAX_S ? `the game's ${own} s round was played to ${SESSION.ROUND_MAX_S} s` : !own ? 'the game sets no round length: 60 s' : own < SESSION.ROUND_MIN_S ? `the game's ${own} s round was played as ${SESSION.ROUND_MIN_S} s` : null };
}

const phaseOf = page => page.evaluate(() => window.__game?.phase ?? null).catch(() => null);

/** One page: `rounds` rounds at `bots` bots with the scripted player. */
async function runPage({ browser, gpu, url, outDir, label, bots, seed, rounds, round, controls, log, frames: keepFrames = true }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [], frames = [], feeds = [];
  page.on('pageerror', e => errors.push(e.message.slice(0, 300)));
  page.on('console', m => { if (m.type() === 'error' && !GPU_TROUBLE.test(m.text())) errors.push(m.text().slice(0, 300)); });
  await lockFor(page, gpu, {});
  await page.addInitScript(o => { globalThis.__GF_ASSET_OVERRIDES = o; }, { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: round.seconds }] });
  await page.addInitScript(STEP_PRE);
  await page.addInitScript(STEP_POST);
  const agent = createAgent({ controls, rng: rngOf(seed * 31 + bots) });
  const held = new Set(), firing = { on: false }, mouse = { x: 640, y: 400 };
  let clock = null, noFeed = false;
  try {
    await page.goto(stepUrl(`${url}?seed=${seed}&bots=${bots}`), { waitUntil: 'load', timeout: 120000 });
    const t0 = Date.now();
    while ((await phaseOf(page)) !== 'lobby') { if (Date.now() - t0 > 90000) throw new Error('no lobby in 90 s'); await sleep(250); }
    noFeed = !(await page.evaluate(() => typeof window.__game?.play === 'function').catch(() => false));
    const play = await page.locator('#gf-play').boundingBox().catch(() => null);
    if (play) await page.mouse.click(play.x + play.width / 2, play.y + play.height / 2); else await page.keyboard.press('Enter');
    clock = await clockFor(page);
    for (let r = 0; r < rounds; r++) {
      await clock.until(async () => (await phaseOf(page)) === 'playing', 30000, 'the round to start', 150);
      await page.mouse.click(640, 400).catch(() => {});
      if (clock.stepped) await mouseTaken(page);
      const start = clock.now();
      let lastFrame = -Infinity, n = 0;
      for (;;) {
        const obs = await page.evaluate(OBSERVE).catch(() => null);
        if (!obs || obs.phase !== 'playing') break;
        if ((clock.now() - start) / 1000 > round.seconds + 20) break;
        const act = agent.decide(obs);
        await drive(page, act, held, { mouse, firing });
        if (keepFrames && obs.t - lastFrame >= SESSION.FRAME_S) {
          lastFrame = obs.t;
          const file = join(outDir, `${label}-r${r + 1}-${String(n++).padStart(3, '0')}.jpg`);
          await page.screenshot({ path: file, type: 'jpeg', quality: 60 }).catch(() => {});
          frames.push({ file, t: r1(obs.t), round: obs.round });
        }
        await clock.wait(SESSION.TICK_MS);
      }
      await release(page, held, firing);
      await clock.until(async () => ['results', 'lobby'].includes(await phaseOf(page)), 30000, 'the round to end', 250).catch(() => null);
      feeds.push(await page.evaluate(() => window.__game?.play?.() ?? null).catch(() => null));
      if (r + 1 < rounds) {
        const again = await page.locator('#gf-again').boundingBox().catch(() => null);
        if (!again) { log(`  ${label}: no Play again after round ${r + 1}`); break; }
        await page.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
      }
    }
  } catch (e) {
    errors.push(`the scripted player stopped: ${e.message.split('\n')[0]}`);
  } finally {
    await release(page, held, firing).catch(() => {});
    feeds.push(await page.evaluate(() => window.__game?.play?.() ?? null).catch(() => null));
    await ctx.close().catch(() => {});
  }
  const feed = feeds.filter(Boolean).at(-1) ?? null;
  return { label, players: bots + 1, bots, clock: clock?.stepped ? 'stepped' : 'wall', feed, agent: agent.report(), frames, errors: errors.slice(0, 8), ...(noFeed ? { noFeed: true } : {}) };
}

/** The friends round: two scripted players, host and friend, over real WebRTC; both screens kept. */
async function runDuo({ browser, srv, outDir, seconds, controls, log }) {
  const pages = [], errors = [];
  const open = async who => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(o => { globalThis.__GF_ASSET_OVERRIDES = o; }, { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: seconds }] });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${who}: ${e.message.slice(0, 200)}`));
    const G = () => page.frames().find(f => f.parentFrame() === page.mainFrame()) ?? page;
    const P = { who, ctx, page, G, agent: createAgent({ controls, rng: rngOf(who === 'host' ? 5 : 9) }), held: new Set(), firing: { on: false }, mouse: { x: 640, y: 400 }, frames: [] };
    pages.push(P); return P;
  };
  const wait = async (fn, s, what) => { const end = Date.now() + s * 1000; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`the friends page did not get to ${what} in ${s} s`); await sleep(200); } };
  try {
    const host = await open('host'), friend = await open('friend');
    await host.page.goto(`${srv.partyUrl}?max=300`, { waitUntil: 'load', timeout: 90000 });
    await wait(() => host.page.locator('#gfp-host').isVisible(), 30, 'its home');
    await host.page.fill('#gfp-name', 'Host'); await host.page.click('#gfp-host');
    const invite = await wait(async () => (await host.page.locator('#mp-invite').isVisible()) && (await host.page.inputValue('#mp-invite')), 30, 'a room with an invite');
    await friend.page.goto(invite, { waitUntil: 'load', timeout: 90000 });
    await wait(() => friend.page.locator('#gfp-join').isVisible(), 30, 'the friend\'s join');
    await friend.page.fill('#gfp-name', 'Friend'); await friend.page.click('#gfp-join');
    await wait(() => host.page.locator('#mp-start').isEnabled(), 40, 'both players in the room');
    await host.page.click('#mp-start');
    await wait(async () => (await host.G().evaluate(() => window.__game?.phase === 'playing').catch(() => false)) && (await friend.G().evaluate(() => window.__game?.phase === 'playing').catch(() => false)), 120, 'both rounds playing');
    for (const P of pages) { await P.G().focus('#gf-canvas').catch(() => {}); await P.page.mouse.click(640, 400).catch(() => {}); }
    const t0 = Date.now(), last = { host: -Infinity, friend: -Infinity }, n = { host: 0, friend: 0 };
    while (Date.now() - t0 < (seconds + 15) * 1000) {
      const done = await Promise.all(pages.map(async P => {
        const obs = await P.G().evaluate(OBSERVE).catch(() => null);
        if (!obs || obs.phase !== 'playing') return true;
        await drive(P.page, P.agent.decide(obs), P.held, { mouse: P.mouse, firing: P.firing, frame: P.G() });
        if ((Date.now() - t0) / 1000 - last[P.who] >= SESSION.FRAME_S) {
          last[P.who] = (Date.now() - t0) / 1000;
          const file = join(outDir, `duo-${P.who}-${String(n[P.who]++).padStart(3, '0')}.jpg`);
          await P.page.screenshot({ path: file, type: 'jpeg', quality: 60 }).catch(() => {});
          P.frames.push({ file, t: r1(obs.t), round: obs.round, wall: r1(last[P.who]) });
        }
        return false;
      }));
      if (done.every(Boolean)) break;
      await sleep(SESSION.TICK_MS);
    }
    for (const P of pages) await release(P.page, P.held, P.firing);
    await sleep(1500);
    const feeds = await Promise.all(pages.map(P => P.G().evaluate(() => window.__game?.play?.() ?? null).catch(() => null)));
    return { feeds, frames: Object.fromEntries(pages.map(P => [P.who, P.frames])), agents: Object.fromEntries(pages.map(P => [P.who, P.agent.report()])), errors: errors.slice(0, 6) };
  } catch (e) {
    log(`  duo: ${e.message.split('\n')[0]}`);
    return { skipped: `the friends round could not be played: ${e.message.split('\n')[0]}`, frames: Object.fromEntries(pages.map(P => [P.who, P.frames])), errors: errors.slice(0, 6) };
  } finally { for (const P of pages) await P.ctx.close().catch(() => {}); }
}

/** A small seeded stream (the scripted player's choices are the same run to run for a seed). */
export function rngOf(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/**
 * Play the game. counts: player counts (default countsOf); rounds per count; duo: the friends round when the game is
 * live (default on). → see the top of this file
 */
export async function playGame(gameDir, { outDir, log = () => {}, counts = null, rounds = SESSION.ROUNDS, seed = 7, duo = true, frames = true } = {}) {
  const dir = resolve(gameDir);
  await mkdir(outDir, { recursive: true });
  const game = JSON.parse(await readFile(join(dir, 'config/game.json'), 'utf8'));
  const spec = JSON.parse(await readFile(join(dir, 'spec.json'), 'utf8').catch(() => '{}'));
  const round = roundOf(game);
  const list = counts ?? countsOf(game, spec);
  const mp = await readManifest(dir).catch(() => null);
  const live = mp?.manifest?.mode === 'live';
  const srv = await startParty({ dir, port: 0, overlay: await kitEditsOverlay(dir) });
  const place = await placeOfGame(dir);
  const launched = await launchForGame(launchChrome, dir, { place });
  const browser = launched.browser;
  try {
    const t0 = Date.now();
    const pagesP = Promise.all(list.map((n, i) => runPage({ browser, gpu: launched.gpu, url: srv.url, outDir, label: `p${n}`, bots: n - 1, seed: seed + i, rounds, round, controls: game.controls ?? {}, log, frames })));
    const maxPlayers = Number(spec.players?.max ?? game.players?.max ?? 4) || 4;
    const duoP = duo && live && maxPlayers >= 2 && place.runtime !== 'godot' ? runDuo({ browser, srv, outDir, seconds: Math.min(round.seconds, SESSION.DUO_S), controls: game.controls ?? {}, log }) : Promise.resolve({ skipped: live ? 'off' : 'not a live game: no friends round' });
    const [runs, duoR] = await Promise.all([pagesP, duoP]);
    return { runs, duo: duoR, round, counts: list, seconds: Math.round((Date.now() - t0) / 1000), renderer: launched.gpu, note: launched.note ?? null };
  } finally {
    await browser.close().catch(() => {});
    await srv.close().catch(() => {});
  }
}

/** Contact strips (one picture per clip: its frames in a grid, labelled), drawn by the browser. */
export async function strips(clips, { browser = null } = {}) {
  const own = !browser;
  browser ??= await launchChrome();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    for (const c of clips) {
      const imgs = await Promise.all(c.frames.map(async f => `data:image/jpeg;base64,${(await readFile(f.file)).toString('base64')}`));
      const b64 = await page.evaluate(async ({ imgs, labels, cols, title }) => {
        const bm = await Promise.all(imgs.map(async s => createImageBitmap(await (await fetch(s)).blob())));
        const w = 480, h = Math.round(w * (bm[0]?.height ?? 9) / (bm[0]?.width ?? 16)), rows = Math.ceil(bm.length / cols), top = 28;
        const cv = new OffscreenCanvas(cols * w + (cols - 1) * 4, top + rows * (h + 4)), g = cv.getContext('2d');
        g.fillStyle = '#111'; g.fillRect(0, 0, cv.width, cv.height);
        g.fillStyle = '#fff'; g.font = 'bold 18px sans-serif'; g.fillText(title, 8, 20);
        bm.forEach((b, i) => { const x = (i % cols) * (w + 4), y = top + Math.floor(i / cols) * (h + 4); g.drawImage(b, x, y, w, h); g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x, y, 150, 22); g.fillStyle = '#fff'; g.font = '15px sans-serif'; g.fillText(labels[i], x + 6, y + 16); });
        const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
        const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]); return btoa(s);
      }, { imgs, labels: c.frames.map(f => f.label ?? `${f.t}s`), cols: c.cols ?? 3, title: c.title });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(c.file, Buffer.from(b64, 'base64'));
    }
  } finally { await page.close().catch(() => {}); if (own) await browser.close().catch(() => {}); }
  return clips.map(c => c.file);
}
