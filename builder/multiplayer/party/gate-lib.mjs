// Shared by gate.mjs (race rounds) and gate-live.mjs (live rounds): waiting, the party page's observation, and the
// proxy that sends DOM work to the game's frame and real input to the page.
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function until(fn, ms, label) {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`); await sleep(120); }
}
export const snap = page => page.evaluate(() => window.__party?.snapshot() ?? null).catch(() => null);
export const p2p = page => page.evaluate(() => window.__p2p?.snapshot() ?? null).catch(() => null);
/**
 * What this Chrome draws WebGL with: {renderer, card}. `card` is false when the browser would draw on the processor
 * (a context asked with failIfMajorPerformanceCaveat is refused, or the renderer names a software rasterizer), null when the page gave no answer. For the record:
 * a gate that passed on a graphics card says nothing about a machine without one.
 */
export async function graphicsOf(browser) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      const o = { failIfMajorPerformanceCaveat: true }, c = document.createElement('canvas');
      const renderer = gl ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)).slice(0, 160) : null;
      // (the two questions of gf-three's kit/core/quality.js drawsOnCard: headless Chrome on Linux does not refuse the context)
      return { renderer, card: !!(c.getContext('webgl2', o) ?? c.getContext('webgl', o)) && !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer ?? ''), processors: navigator.hardwareConcurrency ?? null };
    });
  } catch { return { renderer: null, card: null, processors: null }; }
  finally { await page.close().catch(() => {}); }
}
/**
 * Can two connections in one page of this Chrome reach each other over WebRTC on this machine? The gate's two players
 * are two pages of one browser, so their only route is a host candidate. → {connected, seconds, candidates: {kind: n},
 * state}. Addresses are never recorded, only their kind: an mDNS name (Chrome hides a machine's addresses behind
 * <uuid>.local names, which the other side must look up by multicast), an IPv4 or IPv6 address, loopback.
 */
export async function webrtcProbe(browser, ms = 8000) {
  const page = await browser.newPage();
  try {
    await page.route('http://127.0.0.1/__gf-webrtc-probe', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>WebRTC probe</title>' }));
    await page.goto('http://127.0.0.1/__gf-webrtc-probe');
    return await page.evaluate(async ms => {
      const a = new RTCPeerConnection(), b = new RTCPeerConnection(), candidates = {};
      const kind = c => { const p = c.candidate.split(' '), addr = p[4] ?? ''; return `${p[7] ?? '?'}, ${/\.local$/i.test(addr) ? 'mDNS name' : /^127\.|^::1$/.test(addr) ? 'loopback' : addr.includes(':') ? 'IPv6 address' : 'IPv4 address'}`; };
      a.onicecandidate = e => { if (e.candidate?.candidate) { const k = kind(e.candidate); candidates[k] = (candidates[k] ?? 0) + 1; b.addIceCandidate(e.candidate).catch(() => {}); } };
      b.onicecandidate = e => { if (e.candidate?.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
      const ch = a.createDataChannel('probe'), t0 = performance.now();
      const open = new Promise(ok => { ch.onopen = () => ok(true); setTimeout(() => ok(false), ms); });
      await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
      const connected = await open, seconds = Math.round((performance.now() - t0) / 100) / 10;
      const out = { connected, seconds, candidates, state: a.connectionState };
      a.close(); b.close();
      return out;
    }, ms);
  } catch (e) { return { connected: false, error: String(e?.message ?? e).split('\n')[0].slice(0, 200) }; }
  finally { await page.close().catch(() => {}); }
}
/**
 * The WebRTC connection states of a join, as the kit's own observation gives them (window.__p2p: the host's peers, the
 * joiner's connection and channel). `watch()` is called on each turn of a wait and keeps the changes, so a join that
 * failed says how far it got: no state at all (the offer never arrived: signaling, or a page that stopped answering),
 * "connecting" and then "failed" (no route between the two: ICE), or connected and then lost.
 */
export function connectionTrace(H, J) {
  const t0 = Date.now(), seen = { host: [], joiner: [] };
  const add = (who, v) => { if (v && seen[who].at(-1)?.[1] !== v) seen[who].push([Math.round((Date.now() - t0) / 100) / 10, v]); };
  return {
    async watch() {
      const peers = await H.page.evaluate(() => window.__p2p?.peers?.() ?? null).catch(() => null);
      const jt = await J.page.evaluate(() => window.__p2p?.transport?.() ?? null).catch(() => null);
      add('host', peers ? (peers.map(x => `${x.state}${x.open ? '+channel' : ''}`).join(',') || 'no peer') : null);
      add('joiner', jt ? `${jt.pc ?? 'no connection'}${jt.dc ? `+channel ${jt.dc}` : ''}` : null);
    },
    text: () => `host's peer: ${seen.host.map(([t, v]) => `${v} at ${t} s`).join(' → ') || 'never seen'}; joiner's connection: ${seen.joiner.map(([t, v]) => `${v} at ${t} s`).join(' → ') || 'never seen'}`,
  };
}

/**
 * What both pages show while a joiner is joining, as one line: for a wait that ran out, so the record says where the
 * join stood and not only that the gate waited (the party page's phase and players, the kit's own connection state).
 */
export async function joinState(H, J) {
  const [h, j, hp, jp] = [await snap(H.page), await snap(J.page), await p2p(H.page), await p2p(J.page)];
  const jt = await J.page.evaluate(() => window.__p2p?.transport?.() ?? null).catch(() => null);
  const peers = await H.page.evaluate(() => window.__p2p?.peers?.() ?? null).catch(() => null);
  const party = s => (s ? `${s.phase}, ${s.racers?.length ?? 0} player${s.racers?.length === 1 ? '' : 's'}` : 'no answer from the page');
  const kit = s => (s ? `${s.phase}${s.connected ? ', connected' : ''}${s.reason ? ` ("${String(s.reason).slice(0, 60)}${s.detail ? ` ${String(s.detail).slice(0, 90)}` : ''}")` : ''}` : 'no answer');
  return `host page: ${party(h)}; host kit: ${kit(hp)}, peers ${peers ? JSON.stringify(peers.map(x => `${x.state}${x.open ? ' open' : ''}`)) : '?'}; joiner page: ${party(j)}; joiner kit: ${kit(jp)}${jt ? `, channel ${jt.dc ?? 'none'}, connection ${jt.pc ?? 'none'}` : ''}`;
}

/** Which signaling transport each player's kit used (gf.js 1.3.0+ reports it); with --signal, both must have used it. */
export async function checkTransport({ H, J, srv, signal, check, rec }) {
  const [h, j] = [await p2p(H.page), await p2p(J.page)];
  const st = srv.sig.stats();
  rec.transport = { host: h?.signal ?? 'ws (a kit before 1.3.0)', joiner: j?.signal ?? 'ws (a kit before 1.3.0)', why: h?.signalWhy ?? null,
    server: { webSockets: st.sockets, wsRooms: st.rooms, httpRequests: st.httpRequests, httpRooms: st.httpRooms, httpJoins: st.httpJoins, httpRelayed: st.httpRelayed } };
  if (!signal) return;
  const used = signal === 'http' ? st.httpRooms >= 1 && st.httpJoins >= 1 && st.rooms === 0 : st.rooms >= 1 && !st.httpRooms;
  check('signal-transport', h?.signal === signal && j?.signal === signal && used,
    `host ${h?.signal}, joiner ${j?.signal} (asked for ${signal}); the server saw ${st.httpRooms} HTTP room(s), ${st.httpJoins} HTTP join(s), ${st.httpRelayed} HTTP relay(s), ${st.rooms} WebSocket room(s)`);
}

// DOM work goes to the game's frame, input and screenshots to the page. The frame starts at the page's top-left
// corner (the rail is to its right), so the game's coordinates are the page's.
export const FRAME_METHODS = new Set(['evaluate', 'evaluateHandle', '$', '$$', '$eval', '$$eval', 'selectOption', 'click', 'dblclick', 'tap', 'fill', 'focus', 'hover', 'type', 'press', 'check', 'uncheck', 'waitForFunction', 'waitForSelector', 'locator', 'getByText', 'getByRole', 'getByTestId', 'textContent', 'innerText', 'innerHTML', 'getAttribute', 'isVisible', 'content', 'title', 'url']);
// The scripted player plays the GAME. A card of the shell (results, countdown) can appear over the game at any moment,
// under a click that was meant for the game: with random input that pressed "Play again" and played a whole extra
// round behind the gate's back (rhythm, 2026-10-05). So no scripted press lands while a shell card is showing.
export const inFrame = (page, frame, size) => {
  const covered = () => page.evaluate(() => { const c = document.getElementById('card'); return !!c && !c.hidden; }).catch(() => false);
  const mouse = new Proxy(page.mouse, { get(m, k) {
    const v = m[k];
    if (k === 'click' || k === 'dblclick' || k === 'down') return async (...a) => (await covered() ? undefined : v.apply(m, a));
    return typeof v === 'function' ? v.bind(m) : v;
  } });
  return new Proxy(page, { get(p, k) {
    if (k === 'viewportSize') return () => size;
    if (k === 'mouse') return mouse;
    const from = FRAME_METHODS.has(k) ? frame : p, v = from[k];
    return typeof v === 'function' ? v.bind(from) : v;
  } });
};

/**
 * The host ends the round, as a player would. A game whose rail is out (kit 1.4.0, live.hud "game") carries End round
 * in its own menu: the HUD's menu button, then #gf-end-round (the host's copy ends its round, so every player's real
 * score reaches the results). Otherwise the rail's End round (#stop). → true when a button was clicked.
 */
export async function endRound(page) {
  try { await page.evaluate(() => { try { document.getElementById('game').contentDocument.exitPointerLock(); } catch {} try { document.exitPointerLock(); } catch {} }); } catch {}
  if (await page.isVisible('#stop').catch(() => false)) { await page.click('#stop', { timeout: 4000 }).catch(() => {}); return true; }
  const frame = page.frames().find(f => f.parentFrame() === page.mainFrame());
  if (!frame) return false;
  for (let i = 0; i < 3; i++) {
    if (await frame.isVisible('#gf-end-round').catch(() => false)) { await frame.click('#gf-end-round', { timeout: 4000 }).catch(() => {}); return true; }
    if (await frame.isVisible('#gf-menu-button').catch(() => false)) await frame.click('#gf-menu-button', { timeout: 3000 }).catch(() => {});
    else { await frame.focus('canvas').catch(() => {}); await page.keyboard.press('Escape').catch(() => {}); }
    await sleep(500);
  }
  return false;
}
