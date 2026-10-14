// Two real Chrome pages on a dev server's friends lobby: one hosts, the other joins by the invite link, the host starts,
// and each page must draw the other player where that player really is. Used by tests/smoke.test.mjs and by anyone
// checking a game by hand (node tests/two-players.mjs <dev server url> [--shots <dir>]). With `joinerBase` the friend's
// page is the same game served from another origin (tests/online-e2e.mjs).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from '../builder/lib/main.mjs';
import { ensureBrowser } from '../builder/lib/chrome.mjs';
import { QA_BROWSER } from '../builder/lib/paths.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(150); }
}
const party = page => page.evaluate(() => window.__party?.snapshot() ?? null).catch(() => null);
const gameFrame = page => page.frames().find(f => f.parentFrame() === page.mainFrame());
const net = page => gameFrame(page)?.evaluate(() => window.__game?.snapshot()?.net ?? null).catch(() => null) ?? null;
const dist = (a, b) => Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.z ?? 0) - (b.z ?? 0));

/**
 * `gpu: 'webgpu'`: a game that draws only with WebGPU (engine vista), or a forge game as verify runs it, is opened in
 * the kit's own WebGPU launch (Vulkan in chrome-headless-shell on Linux; builder/qa/browser.mjs),
 * which refuses a machine without a hardware adapter instead of waiting on the game's "no WebGPU" screen. → { ok, host, joiner, samples, details }
 */
export async function twoPlayers(baseUrl, { shots = null, seconds = 10, log = () => {}, joinerBase = null, onPages = null, gpu = null } = {}) {
  const { chromium } = await import('playwright-core');
  const b = gpu === 'webgpu' ? null : await ensureBrowser({ log });
  const browser = gpu === 'webgpu'
    ? await (await import(pathToFileURL(QA_BROWSER).href)).launchChrome({ gpu: 'webgpu', chromium, args: ['--autoplay-policy=no-user-gesture-required'] })
    : await chromium.launch({ executablePath: b.path, headless: process.env.HEADED !== '1', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...(process.env.CHROME_ARGS ?? '').split(/\s+/).filter(Boolean)] });
  const errors = [];
  try {
    const open = async label => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
      return page;
    };
    const H = await open('host'), J = await open('joiner');
    const lobby = new URL('game/gf/mp/', baseUrl).href;
    await H.goto(lobby, { waitUntil: 'load' });
    await until(async () => (await party(H))?.phase === 'home', 20000, 'the host lobby');
    await H.fill('#gfp-name', 'Hosta');
    await H.click('#gfp-host');
    await until(async () => { const s = await party(H); return s?.phase === 'room' && s.code ? s : null; }, 20000, 'the host to open a room');
    const invite = await H.inputValue('#mp-invite');
    log(`invite ${invite}`);
    // joinerBase: the friend opens the same game served from another origin (their own machine's copy), with the invite's room
    const friendUrl = joinerBase ? (() => { const u = new URL(invite), v = new URL('game/gf/mp/', joinerBase); v.search = u.search; return v.href; })() : invite;
    await onPages?.({ host: H, joiner: J, invite, friendUrl });
    await J.goto(friendUrl, { waitUntil: 'load' });
    await until(async () => (await party(J))?.phase === 'home', 20000, 'the joiner lobby');
    await J.fill('#gfp-name', 'Joan');
    await J.click('#gfp-join');
    await until(async () => (await party(H))?.racers?.length === 2 && (await party(J))?.racers?.length === 2, 30000, 'both players in the room');
    await H.click('#mp-start');
    await until(async () => (await party(H))?.gameReady && (await party(J))?.gameReady, 90000, 'both games to load');
    await until(async () => (await net(H))?.started && (await net(J))?.started, 60000, 'the round to start on both');
    const samples = [], shot = { host: null, joiner: null };
    const sample = async () => {
      const [h, j] = [await net(H), await net(J)];
      if (!h || !j) return;
      const hSeesJ = h.peers?.find(p => p.id === j.you), jSeesH = j.peers?.find(p => p.id === h.you);
      samples.push({
        hostDrawsJoiner: hSeesJ ? { at: [hSeesJ.x, hSeesJ.z], gap: +dist(hSeesJ, j.me).toFixed(2), onScreen: !!hSeesJ.onScreen } : null,
        joinerDrawsHost: jSeesH ? { at: [jSeesH.x, jSeesH.z], gap: +dist(jSeesH, h.me).toFixed(2), onScreen: !!jSeesH.onScreen } : null,
      });
      // a screenshot of each screen the first time it shows the other player
      if (shots && hSeesJ?.onScreen && !shot.host) { shot.host = path.join(shots, 'host-sees-joiner.png'); await H.screenshot({ path: shot.host }); }
      if (shots && jSeesH?.onScreen && !shot.joiner) { shot.joiner = path.join(shots, 'joiner-sees-host.png'); await J.screenshot({ path: shot.joiner }); }
    };
    const sampleFor = async secs => { const t0 = Date.now(); while (Date.now() - t0 < secs * 1000) { await sample(); await sleep(400); } };
    // where they spawned (facing the middle), then with the host walking, so a moving player is checked too
    await sampleFor(seconds / 2);
    const frameH = gameFrame(H);
    await frameH.locator('canvas').first().click({ position: { x: 640, y: 360 } }).catch(() => {});
    await H.keyboard.down('KeyW'); await sleep(1200); await H.keyboard.up('KeyW');
    await sampleFor(seconds / 2);
    if (shots) { await H.screenshot({ path: path.join(shots, 'host-end.png') }); await J.screenshot({ path: path.join(shots, 'joiner-end.png') }); }
    const [h, j] = [await net(H), await net(J)];
    const good = samples.filter(s => s.hostDrawsJoiner && s.joinerDrawsHost && s.hostDrawsJoiner.gap < 3 && s.joinerDrawsHost.gap < 3);
    const onScreen = { host: samples.filter(s => s.hostDrawsJoiner?.onScreen).length, joiner: samples.filter(s => s.joinerDrawsHost?.onScreen).length };
    const ok = samples.length > 0 && good.length >= Math.ceil(samples.length * 0.8) && errors.length === 0;
    return {
      ok, invite, friendUrl, browser: b ?? browser.webgpu ?? null, samples: samples.length, inPlace: good.length, onScreen, screenshots: shot, errors,
      host: { you: h?.you, host: h?.host, peers: h?.peers?.map(p => p.name) }, joiner: { you: j?.you, host: j?.host, peers: j?.peers?.map(p => p.name) },
      last: samples.at(-1) ?? null,
    };
  } finally { await browser.close().catch(() => {}); }
}

if (isMain(import.meta)) {
  const [url] = process.argv.slice(2);
  const i = process.argv.indexOf('--shots');
  if (!url) { console.error('usage: node tests/two-players.mjs <dev server url> [--shots <dir>]'); process.exit(2); }
  const r = await twoPlayers(url, { shots: i > 0 ? process.argv[i + 1] : null, log: m => console.error(m) });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
}
