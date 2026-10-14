// Online play as the dev server's default (docs/ONLINE.md): friends on other machines join a game served from this one.
//
// The multiplayer kit (gf-multiplayer 1.6.4 and newer) opens rooms through a play host's signaling when a page sets
// `signal: 'online'`; the host's address is the kit's own (`gf/mp/p2p.json` → "online"). The dev server sets it for the
// game's pages, by inserting one line before the page's first <script> (the page is the game's; no kit copy is edited):
//
//   <script>window.GF_P2P_CONFIG = Object.assign({ signal: 'online' }, window.GF_P2P_CONFIG || {});</script>
//
// The person's switch is GAMESFUN_ONLINE:
//   unset           the kit's own play host
//   off             nothing is inserted: friends join on this machine only (two tabs)
//   <address>       a signaling server of the person's own (https://…/signal/v1, or http on this machine), in place of
//                   the kit's host; `node builder/multiplayer/p2p/serve-signal.mjs` is one (docs/ONLINE.md)
// A game whose multiplayer kit is older than 1.6.4 does not know the setting, so nothing is inserted for it.
//
// A second script (ONLINE_CLIENT, served at /__gamesfun/online.js) makes a refusal readable and keeps the person
// playing. The kit asks the host for its ICE servers before it opens a room; when the host answers that request with a
// refusal ("Online play for games run from other sites is off for now"), the kit would show the refusal and open no
// room at all. Here that answer is turned into "not reachable", which the kit already handles by falling back to this
// machine's own signaling, and the reason is shown in a small notice. A room the host refuses later (a limit) keeps the
// kit's own words, and the notice offers this machine instead. It makes no request of its own.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const ONLINE_MIN_KIT = '1.6.4';
export const ONLINE_LINE = '<script>window.GF_P2P_CONFIG = Object.assign({ signal: \'online\' }, window.GF_P2P_CONFIG || {});</script>';
export const ONLINE_CLIENT_PATH = '/__gamesfun/online.js';
const CLIENT_TAG = `<script src="${ONLINE_CLIENT_PATH}"></script>`;

/** The kit's own rule for an online address: https ending in /signal/v1, or http on this machine. → the address, or null */
export function onlineAddress(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const u = new URL(v.trim()), local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname);
    return (u.protocol === 'https:' || (u.protocol === 'http:' && local)) && /\/signal\/v1\/?$/.test(u.pathname) && !u.search && !u.hash && !u.username ? u.href.replace(/\/$/, '') : null;
  } catch { return null; }
}

/** GAMESFUN_ONLINE as the person set it. → { mode: 'default' | 'off' | 'own' | 'bad', address?, value? } */
export function onlineSetting(env = process.env) {
  const raw = String(env.GAMESFUN_ONLINE ?? '').trim();
  if (!raw || /^(on|1|true|yes)$/i.test(raw)) return { mode: 'default' };
  if (/^(off|0|false|no)$/i.test(raw)) return { mode: 'off' };
  const address = onlineAddress(raw);
  return address ? { mode: 'own', address } : { mode: 'bad', value: raw };
}

const newerOrSame = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return true;
};
const json = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };

/**
 * What this game's pages will use for friends, and why.
 * → { use: 'online' | 'this-machine', host: the address or null, own: bool, kit: the game's multiplayer kit version or null, why }
 */
export async function onlineFor(gameDir, env = process.env) {
  const set = onlineSetting(env);
  const kit = (await json(path.join(gameDir, 'gf', 'mp', 'kit.json')))?.version ?? null;
  const local = why => ({ use: 'this-machine', host: null, own: false, kit, why });
  if (set.mode === 'off') return local('GAMESFUN_ONLINE is off');
  if (set.mode === 'bad') return local(`GAMESFUN_ONLINE is "${set.value}", which is not off or a signaling address (https://…/signal/v1, or http on this machine)`);
  if (!kit) return local('this game has no multiplayer kit (gf/mp/)');
  if (!/^\d+\.\d+\.\d+$/.test(kit) || !newerOrSame(kit, ONLINE_MIN_KIT)) return local(`this game's multiplayer kit is ${kit}; online play needs ${ONLINE_MIN_KIT} or newer`);
  if (set.mode === 'own') return { use: 'online', host: set.address, own: true, kit, why: 'GAMESFUN_ONLINE names your own signaling server' };
  const host = onlineAddress((await json(path.join(gameDir, 'gf', 'mp', 'p2p.json')))?.online);
  if (!host) return local('this game\'s multiplayer kit names no online host (gf/mp/p2p.json)');
  return { use: 'online', host, own: false, kit, why: 'the multiplayer kit\'s own play host' };
}

/** One line for a person: where friends join from. */
export function onlineWords(o) {
  if (o.use === 'online') return `online through ${new URL(o.host).host}${o.own ? ' (your own signaling server)' : ''}: friends on other machines can join; when it refuses or cannot be reached, this machine only. GAMESFUN_ONLINE=off turns it off`;
  return `this machine only (${o.why}): two tabs or windows here`;
}

// a URL's own text (URL.href is ASCII), made safe inside a <script>
const inScript = v => JSON.stringify(v).replace(/</g, '\\u003c');

/** The line(s) for a page of this game, or '' when nothing is inserted. */
export function onlineTags(o) {
  if (o.use !== 'online') return '';
  // the kit's own host: the line, exactly. A server of the person's own: the same line with its address.
  const line = o.own ? `<script>window.GF_P2P_CONFIG = Object.assign({ signal: 'online', online: ${inScript(o.host)} }, window.GF_P2P_CONFIG || {});</script>` : ONLINE_LINE;
  return `${line}\n<script>window.GAMESFUN_ONLINE_HOST = ${inScript(o.host)};</script>\n${CLIENT_TAG}\n`;
}

/** Insert the tags before the page's first <script>. A page with no script is left as it is. */
export function injectOnline(buf, o) {
  const tags = onlineTags(o);
  if (!tags) return buf;
  const html = buf.toString('utf8');
  if (html.includes(CLIENT_TAG)) return buf;
  const at = html.search(/<script\b/i);
  return at < 0 ? buf : Buffer.from(html.slice(0, at) + tags + html.slice(at));
}

/**
 * The page side (not part of the game; only the dev server adds it). It watches the kit's own requests to the online
 * host and makes none itself.
 *   - the host's answer to the kit's first request (GET …/ice) is a refusal, or the host cannot be reached: the kit is
 *     told "not reachable", so it uses this machine's signaling, and the notice says why in the host's own words
 *   - the host refuses a room later (a limit): the kit shows the host's words; the notice offers this machine instead
 */
export const ONLINE_CLIENT = `// gamesfun dev: online play, the readable side (not part of the game; only the dev server adds it)
(() => {
  const host = window.GAMESFUN_ONLINE_HOST;
  if (typeof host !== 'string' || !host || typeof window.fetch !== 'function') return;
  const real = window.fetch.bind(window);
  const state = window.GAMESFUN_ONLINE = { host, use: 'online', refused: null };
  const LOCAL = 'Friends can still join on this machine: open the invite link in another tab or window here.';
  function notice(text, offerLocal) {
    state.notice = text;
    console.info('gamesfun dev: ' + text);
    const show = () => {
      let box = document.getElementById('gamesfun-online-notice');
      if (!box) {
        box = document.createElement('div');
        box.id = 'gamesfun-online-notice';
        box.setAttribute('role', 'status');
        box.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:2147483000;max-width:min(92vw,640px);padding:10px 14px;border-radius:8px;background:#1d2330;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35)';
        document.body.appendChild(box);
      }
      box.replaceChildren();
      const words = document.createElement('span');
      words.textContent = text + ' ';
      box.appendChild(words);
      if (offerLocal) {
        const a = document.createElement('a');
        const u = new URL(location.href); u.searchParams.set('signal', 'ws'); u.searchParams.delete('join');
        a.href = u.href; a.textContent = 'Play on this machine instead'; a.style.cssText = 'color:#9cd0ff;margin-right:10px';
        box.appendChild(a);
      }
      const x = document.createElement('button');
      x.type = 'button'; x.textContent = 'Close'; x.style.cssText = 'margin-left:6px;font:inherit;background:none;border:1px solid #6b7384;color:#fff;border-radius:6px;padding:1px 8px;cursor:pointer';
      x.addEventListener('click', () => box.remove());
      box.appendChild(x);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
  }
  const sentence = s => { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.') : ''; };
  const read = r => r.clone().json().catch(() => null);
  window.fetch = async (input, init) => {
    let url = '';
    try { url = String(typeof input === 'string' ? input : input && input.url ? input.url : input); } catch (e) {}
    if (url !== host && url.indexOf(host + '/') !== 0) return real(input, init);
    const ice = url === host + '/ice';
    let r;
    try { r = await real(input, init); } catch (e) {
      if (ice) { state.use = 'this-machine'; state.refused = 'unreachable'; notice('Online play could not be reached (' + new URL(host).host + ' did not answer this page). ' + LOCAL, false); }
      throw e;
    }
    const j = await read(r);
    if (ice && j && j.t === 'error') {
      // a refusal before any room: the kit falls back to this machine when the host is "not reachable"
      state.use = 'this-machine'; state.refused = String(j.reason || j.code || 'refused');
      notice('Online play is not available from this page: ' + sentence(j.reason || 'the host refused') + ' ' + LOCAL, false);
      throw new TypeError('gamesfun dev: the online host refused this page');
    }
    if (!ice && j && j.t === 'error' && (j.code === 'off' || j.code === 'limited' || j.code === 'busy' || r.status === 403 || r.status === 429)) {
      let op = ''; try { op = JSON.parse(init && typeof init.body === 'string' ? init.body : '{}').op || ''; } catch (e) {}
      if (op === 'host' || op === 'join' || op === 'find') { state.refused = String(j.reason || j.code); notice('The online host refused: ' + sentence(j.reason || j.code), true); }
    }
    return r;
  };
})();
`;
