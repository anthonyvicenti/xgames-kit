// Voice chat between players and the host's Remove (gf-multiplayer 1.7.2; the creator, 2026-10-12: "if we made it so
// you could connect your mic when joining any game, it just had to be on the website. And then you could hear everyone
// voice in the stream", "Admin can kick, any player can mute them for themselves"). Part of check 34 (watch then play):
// tools/lib/friends-watch-check.mjs runs it for a live game, verify-world.mjs for a world.
//
// Voice runs on Studio's play page (builder/studio-lib/voice-chat.mjs), never on the play origin. Here each player's
// browser opens a stand-in for that page on an origin of its own: it frames the game's friends page (served by a server
// whose /watch/v1 names the stand-in as Studio) and does what components/play/play-room.tsx does with the frame, using
// Studio's own voice-chat.mjs and voice-capture.mjs and Chrome's fake microphone (a 440 Hz tone, voiceArgs()).
// Studio's real page (its panel and buttons) is checked on a running Studio after a deploy (watch/evidence/
// mic-after-go-live-2026-10-12/ and the voice-chat record beside it).
//
// A live game: the invite opens the stand-in Studio page; the page hears who is in the room; two players in voice hear
// each other; Mute is for the listener alone; the host goes live and a viewer hears the other player through the host's
// stream (the room's mix); the host's Remove (the waiting room's, ask then confirm) tells the player, drops them from the
// room and from voice; and that browser can't join again. A world: the page hears the room, two players hear each other,
// the world's host removes the other (Studio's Remove, gf:kick), and Enter again is refused.
// A checkout without Studio (the open builder's kit repo) skips it and says so.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, until } from '../../multiplayer/party/gate-lib.mjs';
import { launchChrome, GPU_TROUBLE } from '../../qa/browser.mjs';
import { launchForGame } from './paths.mjs';
import { voiceArgs } from './friends-watch-check.mjs';
import { compareVersions } from '../../multiplayer/party/manifest.mjs';
import { fitScreen } from './phone-fit.mjs';

const STUDIO_LIB = join(dirname(fileURLToPath(import.meta.url)), '../../studio-lib');
const SLUG = 'the-game';

/** The stand-in Studio play page: one iframe (the friends page), and play-room.tsx's handling of it. */
function standInHtml(friendsUrl, join) {
  const src = new URL(friendsUrl); if (join) src.searchParams.set('join', join);
  return `<!doctype html><meta charset="utf-8"><title>Studio (stand-in)</title><body style="margin:0;background:#111">
<iframe id="f" src="${src.href}" sandbox="allow-scripts allow-same-origin allow-pointer-lock" allow="autoplay" style="display:block;width:100vw;height:100vh;border:0"></iframe>
<script type="module">
import { createVoiceChat } from '/lib/voice-chat.mjs';
import { startVoice } from '/lib/voice-capture.mjs';
const f = document.getElementById('f'), playOrigin = ${JSON.stringify(src.origin)};
let room = null, live = null, enc = null, frameHeard = false, starting = false;
const toFrame = m => { try { f.contentWindow.postMessage(m, playOrigin); } catch (e) {} };
const here = () => { toFrame({ type: 'gf:mic-here', v: 1, invite: location.origin + '/play/${SLUG}' }); toFrame({ type: 'gf:live-ask', v: 1 }); };
f.addEventListener('load', () => { frameHeard = false; here(); });
const vc = createVoiceChat({ send: (to, d) => toFrame({ type: 'gf:vc-send', v: 1, to: to || undefined, d }), log: e => console.log('vc ' + e) });
async function mixSync() {
  const want = live === 'on' && vc.joined;
  if (want && !enc && !starting) { starting = true; try { enc = await startVoice({ stream: vc.mix(), send: toFrame }); toFrame({ type: 'gf:voice-state', v: 1, on: true }); } finally { starting = false; } }
  else if (!want && enc) { enc.stop(); enc = null; toFrame({ type: 'gf:voice-state', v: 1, on: false }); }
}
addEventListener('message', e => {
  if (e.source !== f.contentWindow || e.origin !== playOrigin || !e.data || typeof e.data !== 'object') return;
  const t = e.data.type;
  if ((t === 'gf:live-state' || t === 'gf:room') && !frameHeard) { if (t === 'gf:room') frameHeard = true; else here(); }
  if (t === 'gf:room') { room = e.data; vc.setRoom({ you: e.data.inRoom ? e.data.you : null, players: e.data.players || [], ice: e.data.ice }); mixSync(); }
  if (t === 'gf:live-state') { live = e.data.state; mixSync(); }
  if (t === 'gf:vc-in') vc.handle(e.data.from, e.data.d);
  if (t === 'gf:vc-open' || t === 'gf:vc-close' || t === 'gf:vc-join') asked.push(t);   // kit 1.7.4: the voice panel's asks
});
const asked = [];
Object.assign(window, { __vc: vc, __room: () => room, __mixSync: mixSync, __kick: id => toFrame({ type: 'gf:kick', v: 1, id }),
  __asked: () => asked.slice(), __vcState: o => toFrame({ type: 'gf:vc-state', v: 1, ...o }), __vcClosed: () => toFrame({ type: 'gf:vc-closed', v: 1 }) });
</script>`;
}

// ---- gf-multiplayer 1.7.4 (the creator, 2026-10-12: "The voice taking up the whole bottom of the screen on game start is
// too much. It should go away and only be accessable by clicking escape and looking at the menue options. We should also
// make it more obvious in the lobby. I almost missed it my first time"): gf:room says the round's phase; the waiting room's
// Join voice chat asks Studio's page (gf:vc-join) and shows the state it is sent (gf:vc-state); the pause menu's Voice chat
// row opens Studio's voice panel (gf:vc-open) and closing the menu closes it (gf:vc-close); the panel's × (gf:vc-closed)
// is heard; supported false hides them; and both fit a phone (tools/lib/phone-fit.mjs) ----
async function waitingRoomBridge({ A, B, room, step }) {
  const ra = await room(A);
  step('gf:room says the round\'s phase (the waiting room: lobby)', ra?.phase === 'lobby', `the host's page reads phase ${ra?.phase}`);
  const cta = await B.frame().locator('#mp-voice').textContent({ timeout: 8000 }).catch(() => null);
  await B.frame().click('#mp-voice').catch(() => {});
  const asked = await until(() => B.ev(() => window.__asked().includes('gf:vc-join') ? window.__asked() : null), 5000, 'gf:vc-join').catch(() => null);
  await B.ev(() => window.__vcState({ joined: true, mic: true, n: 2, supported: true }));
  const shows = await until(() => B.frame().locator('#mp-voice').textContent({ timeout: 500 }).then(t => /In voice · mic on/.test(t) ? t.trim() : null), 5000, 'In voice').catch(() => null);
  step('the waiting room offers Join voice chat: a press asks Studio\'s page (gf:vc-join), and it shows the state sent down', /Join voice chat/.test(cta ?? '') && !!asked && !!shows,
    `the button read "${(cta ?? 'none').trim()}"; asked ${JSON.stringify(asked)}; then "${shows}"`);
  const fit = await fitScreen(B.page, 'the waiting room with Join voice chat (under Studio\'s page)', { main: ['#mp-voice'], frame: B.frame() });
  await B.page.setViewportSize({ width: 1200, height: 720 });
  step('the waiting room with the voice chat button fits a phone', fit.ok, fit.ok ? '390x844, 844x390, 640x360' : fit.summary);
  await B.ev(() => window.__vcState({ joined: false, mic: false, n: 0, supported: false }));
  const gone = await until(() => B.frame().locator('#mp-voice').count().then(n => n === 0 ? true : null), 5000, 'hidden').catch(() => false);
  await B.ev(() => window.__vcState({ joined: false, mic: false, n: 0, supported: true }));
  step('where Studio\'s page says voice chat is not supported, the button is not there', !!gone, gone ? 'hidden' : 'still shown');
}
async function pauseMenuBridge({ A, room, step }) {
  const game = () => A.frame()?.childFrames()?.[0] ?? null;
  await A.frame().click('#mp-lock').catch(() => {});
  await until(() => A.frame().evaluate(() => { const b = document.getElementById('mp-start'); return b && !b.disabled; }), 8000, 'Start alone').catch(() => null);
  await A.frame().click('#mp-start').catch(() => {});
  const started = await until(() => game()?.evaluate(() => window.__game?.snapshot?.()?.phase === 'playing' || null), 120000, 'the round').catch(() => null);
  const phase = await until(async () => { const r = await room(A); return r?.phase && r.phase !== 'lobby' ? r.phase : null; }, 10000, 'the phase').catch(async () => (await room(A))?.phase);
  step('gf:room says the round\'s phase in a round', !!started && ['loading', 'countdown', 'racing'].includes(phase), `${started ? 'the round started' : 'no round'}; the page reads phase ${phase}`);
  if (!started) return;
  await A.ev(() => window.__vcState({ joined: true, mic: false, n: 1, supported: true }));
  await sleep(400);
  const openMenu = () => game().evaluate(() => { document.getElementById('gf-menu-button')?.click(); });
  await openMenu();
  const row = await until(() => game().evaluate(() => document.getElementById('gf-voice')?.textContent?.trim() ?? null), 6000, 'the Voice chat row').catch(() => null);
  await game().evaluate(() => document.getElementById('gf-voice')?.click());
  const opened = await until(() => A.ev(() => window.__asked().slice(-1)[0] === 'gf:vc-open' ? window.__asked() : null), 5000, 'gf:vc-open').catch(() => null);
  await A.ev(() => window.__vcClosed()); await sleep(300);
  const closedHeard = (await A.frame().evaluate(() => window.__party.snapshot()?.voiceChat?.state?.open).catch(() => null)) === false;
  await game().evaluate(() => document.getElementById('gf-voice')?.click());
  await sleep(300);
  const fit = await fitScreen(A.page, 'the pause menu with Voice chat (under Studio\'s page)', { main: ['#gf-resume'], frame: game() });
  await A.page.setViewportSize({ width: 1200, height: 720 });
  await game().evaluate(() => document.getElementById('gf-resume')?.click());
  const closed = await until(() => A.ev(() => window.__asked().slice(-1)[0] === 'gf:vc-close' ? window.__asked() : null), 5000, 'gf:vc-close').catch(() => null);
  step('the pause menu\'s Voice chat row opens Studio\'s voice panel (gf:vc-open), the panel\'s × is heard (gf:vc-closed), Resume closes it (gf:vc-close)',
    /^Voice chat · mic off · 1 in voice/.test(row ?? '') && !!opened && closedHeard && !!closed, `the row "${row}"; asked ${JSON.stringify(closed ?? opened)}; the × ${closedHeard ? 'heard' : 'not heard'}`);
  step('the pause menu with the Voice chat row fits a phone', fit.ok, fit.ok ? '390x844, 844x390, 640x360' : fit.summary);
}

export async function checkVoiceChat({ dir, world = false, startServer, log = () => {} }) {
  const steps = [], errors = [];
  let bridge = false;
  try { bridge = !world && compareVersions(JSON.parse(readFileSync(join(dir, 'gf/mp/kit.json'), 'utf8')).version, '1.7.4') >= 0; } catch {}
  const step = (name, ok, detail = '') => { steps.push({ name, ok: !!ok, detail }); log(`${ok ? 'pass' : 'FAIL'} voice chat ${name}: ${detail}`); return !!ok; };
  if (!existsSync(join(STUDIO_LIB, 'voice-chat.mjs'))) return { ok: true, steps, skipped: 'no builder/studio-lib/voice-chat.mjs in this checkout: the voice chat steps did not run' };
  const files = { '/lib/voice-chat.mjs': readFileSync(join(STUDIO_LIB, 'voice-chat.mjs')), '/lib/voice-capture.mjs': readFileSync(join(STUDIO_LIB, 'voice-capture.mjs')) };
  let friendsUrl = null;
  const studio = createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (files[u.pathname]) { r.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return r.end(files[u.pathname]); }
    if (u.pathname === `/play/${SLUG}`) { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return r.end(standInHtml(friendsUrl, u.searchParams.get('join'))); }
    r.writeHead(404); r.end();
  });
  await new Promise(r => studio.listen(0, '127.0.0.1', r));
  const studioOrigin = `http://127.0.0.1:${studio.address().port}`, page = `${studioOrigin}/play/${SLUG}`;
  let server = null, browser = null;
  try {
    server = await startServer(studioOrigin);
    friendsUrl = server.friendsUrl;
    ({ browser } = await launchForGame(launchChrome, dir, { args: voiceArgs() }));
    const open = async (who, url) => {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 720 } });
      const p = await ctx.newPage();
      p.on('pageerror', e => errors.push(`${who}: ${e.message}`));
      p.on('console', m => { const t = m.text(); if ((m.type() === 'error' && !GPU_TROUBLE.test(t) && !/Failed to load resource|Failed to fetch/.test(t)) || /^vc /.test(t)) errors.push(`${who}: ${t.slice(0, 200)}`); });
      await p.goto(url, { waitUntil: 'load' });
      const frame = () => p.frames().find(f => f.parentFrame() === p.mainFrame());
      const party = () => frame()?.evaluate(() => window.__party?.snapshot() ?? null).catch(() => null);
      const ev = (fn, arg) => p.evaluate(fn, arg);
      const hears = id => ev(id => { const x = window.__vc.state().players.find(q => q.id === id); return x ? { level: Math.round(x.level * 1000) / 1000, hearing: x.hearing, muted: x.muted, connection: x.connection } : null; }, id);
      return { who, ctx, page: p, frame, party, ev, hears };
    };
    const room = P => P.ev(() => window.__room());
    const talk = async P => { await P.ev(() => window.__vc.join()); await P.ev(() => window.__vc.micOn()); };
    const bothHear = async (A, B, a, b) => until(async () => { const x = await A.hears(b), y = await B.hears(a); return x?.level > 0.05 && y?.level > 0.05 ? { x, y } : null; }, 20000, 'each hears the other').catch(async () => ({ x: await A.hears(b), y: await B.hears(a), fail: true }));

    if (!world) {
      const A = await open('host', page);
      await until(async () => (await A.party())?.phase === 'home', 40000, 'the host\'s Host / Join screen');
      await A.frame().click('#gfp-name', { clickCount: 3 }); await A.page.keyboard.type('Hosta');
      await A.frame().click('#gfp-host');
      const a = await until(async () => { const s = await A.party(); return s?.phase === 'room' && s.code ? s : null; }, 30000, 'the room');
      const invite = await until(() => A.frame().inputValue('#mp-invite').then(v => v.startsWith(studioOrigin) ? v : null), 10000, 'the invite').catch(() => A.frame().inputValue('#mp-invite').catch(() => null));
      step('under Studio\'s play page, the invite opens that page (where voice chat is)', invite === `${page}?join=${encodeURIComponent(a.code)}`, String(invite));
      const B = await open('guest', invite ?? `${page}?join=${a.code}`);
      await until(async () => (await B.party())?.phase === 'home', 40000, 'the guest\'s Host / Join screen');
      await B.frame().click('#gfp-name', { clickCount: 3 }); await B.page.keyboard.type('Bea');
      await B.frame().click('#gfp-join');
      await until(async () => (await B.party())?.phase === 'room', 30000, 'the guest in');
      const rs = await until(async () => { const ra = await room(A), rb = await room(B); return ra?.players?.length === 2 && rb?.players?.length === 2 ? { ra, rb } : null; }, 15000, 'both rooms').catch(async () => ({ ra: await room(A), rb: await room(B) }));
      step('Studio\'s page hears who is in the room, and who hosts', rs.ra?.host === true && rs.rb?.host === false && rs.ra?.players?.length === 2, `host's page: you ${rs.ra?.you}, host ${rs.ra?.host}, ${rs.ra?.players?.length} players; guest's: you ${rs.rb?.you}, host ${rs.rb?.host}`);
      const ia = rs.ra?.you, ib = rs.rb?.you;
      if (bridge) await waitingRoomBridge({ A, B, room, step });
      await talk(A); await talk(B);
      const h = await bothHear(A, B, ia, ib);
      step('both join voice and turn their mics on: each hears the other', !h.fail, `host hears ${JSON.stringify(h.x)}; guest hears ${JSON.stringify(h.y)}`);
      await A.ev(id => window.__vc.mute(id, true), ib); await sleep(700);
      const m = { x: await A.hears(ib), y: await B.hears(ia) };
      step('Mute is for the listener alone: the host stops hearing the guest, the guest still hears the host', m.x?.muted && m.x.level === 0 && m.y?.level > 0.05, `host→guest ${JSON.stringify(m.x)}; guest→host ${JSON.stringify(m.y)}`);
      await A.ev(id => window.__vc.mute(id, false), ib);
      // the host goes live in the waiting room with their own mic off: a viewer can only hear the guest, through the mix
      await A.frame().click('#mp-golive');
      const live = await until(async () => { const s = (await A.party())?.live; return s?.state === 'on' && s.link ? s : null; }, 15000, 'live').catch(() => null);
      await A.ev(() => window.__vc.micOff()); await A.ev(() => window.__mixSync());
      let heard = null, btn = null;
      if (live) {
        // the stream's public link is Studio's page (here the stand-in, which has no live page): the friends page's own watch
        const wu = new URL(friendsUrl); wu.searchParams.set('watch', live.id);
        const V = await open('viewer', wu.href);
        btn = await until(() => V.page.evaluate(() => document.querySelector('#mp-watch-sound')?.textContent ?? null), 30000, 'Tap for sound').catch(() => null);
        if (btn) await V.page.click('#mp-watch-sound').catch(() => {});
        heard = btn ? await until(async () => { const w = (await V.page.evaluate(() => window.__party.snapshot()))?.watch?.voice; return w && w.played >= 15 && w.peak > 0.05 ? w : null; }, 15000, 'the viewer hears').catch(() => null) : null;
        await V.ctx.close().catch(() => {});
      }
      step('live: a viewer hears the guest through the host\'s stream (everyone the host hears, mixed)', !!heard, heard ? `${heard.played} packets played, peak ${heard.peak}` : live ? `the viewer's button "${btn}"` : 'the host never went live');
      // the host removes the guest: the waiting room's Remove, ask then confirm
      await A.frame().click(`[data-kick="${ib}"]`).catch(() => {}); await A.frame().click(`[data-kick="${ib}"]`).catch(() => {});
      const told = await until(() => B.frame().locator('text=/removed you/i').first().textContent({ timeout: 500 }), 15000, 'the guest told').catch(() => null);
      const alone = await until(async () => { const ra = await room(A); return ra?.players?.filter(p => p.connected).length === 1 ? ra : null; }, 10000, 'the host alone').catch(() => null);
      const bv = await B.ev(() => window.__vc.state());
      step('the host\'s Remove: the guest is told, leaves the room and voice', !!told && !!alone && !bv.joined && bv.stats.peers === 0, `the guest reads "${told}"; the host's page: ${alone ? 'one player' : 'still two'}; the guest's voice ${bv.joined ? 'still joined' : 'left'}, ${bv.stats.peers} connections`);
      await B.page.goto(`${page}?join=${a.code}`, { waitUntil: 'load' });
      await until(async () => (await B.party())?.phase === 'home', 40000, 'the guest back');
      await B.frame().click('#gfp-join').catch(() => {});
      const refused = await until(() => B.frame().locator('text=/removed you/i').first().textContent({ timeout: 500 }), 15000, 'refused').catch(() => null);
      step('a removed browser can\'t join that room again', !!refused, refused ? `"${refused}"` : 'it got back in');
      if (bridge) await pauseMenuBridge({ A, room, step });
    } else {
      const enter = async (P, name) => {
        await until(() => P.frame().locator('#mp-enter').isVisible(), 40000, `${P.who}'s world card`);
        await P.frame().fill('#mp-name', name); await P.frame().click('#mp-enter');
        await until(async () => (await P.party())?.world?.status === 'in', 40000, `${P.who} in the world`);
      };
      const A = await open('first', page); await enter(A, 'Ada');
      const B = await open('second', page); await enter(B, 'Bo');
      const rs = await until(async () => { const ra = await room(A), rb = await room(B); return ra?.players?.length === 2 && rb?.players?.length === 2 ? { ra, rb } : null; }, 15000, 'both rooms').catch(async () => ({ ra: await room(A), rb: await room(B) }));
      step('a world: Studio\'s page hears who is in it, and exactly one hosts', rs.ra?.players?.length === 2 && (rs.ra.host ? 1 : 0) + (rs.rb?.host ? 1 : 0) === 1, `first: you ${rs.ra?.you}, host ${rs.ra?.host}; second: you ${rs.rb?.you}, host ${rs.rb?.host}`);
      const ia = rs.ra?.you, ib = rs.rb?.you;
      await talk(A); await talk(B);
      const h = await bothHear(A, B, ia, ib);
      step('a world: both in voice, each hears the other', !h.fail, `first hears ${JSON.stringify(h.x)}; second hears ${JSON.stringify(h.y)}`);
      const [host, guest, gid] = rs.ra?.host ? [A, B, ib] : [B, A, ia];
      await host.ev(id => window.__kick(id), gid);
      const removed = await until(() => guest.frame().locator('#mp-removed').textContent({ timeout: 500 }), 15000, 'removed').catch(() => null);
      const gv = await guest.ev(() => window.__vc.state());
      step('a world: the host\'s Remove (Studio\'s) tells the other and drops them from the world and voice', !!removed && !gv.joined, `"${removed}"; their voice ${gv.joined ? 'still joined' : 'left'}`);
      await guest.frame().click('#mp-enter').catch(() => {}); await sleep(5000);
      const st = (await guest.party())?.world?.status;
      step('a world: Enter again is refused while that host runs it', st === 'removed', `status ${st}`);
    }
    step('no console errors (voice chat)', errors.length === 0, errors.slice(0, 4).join(' | ') || 'none');
  } catch (e) {
    step('the voice chat flow ran to the end', false, e.message.split('\n')[0]);
  } finally {
    await browser?.close().catch(() => {});
    await server?.close?.().catch?.(() => {});
    await new Promise(r => studio.close(r));
  }
  return { ok: steps.every(s => s.ok), steps };
}
