// The page's calls to /api/session/*: the run token (contract section 1), and the one EventSource. No DOM beyond fetch and EventSource.
import { EVENT_KINDS, normalizeEvent } from './session.js';

let tokenPromise = null;
const token = () => (tokenPromise ??= fetch('/api/session/token', { cache: 'no-store' }).then(async r => {
  if (!r.ok) throw new Error(`no session bridge on this server (${r.status})`);
  return (await r.json()).token;
}).catch(e => { tokenPromise = null; throw e; }));
/** The token is new at every start of the server (contract section 1): forget ours so the next call asks again. */
export const forgetToken = () => { tokenPromise = null; };

/** A call with the token; resolves to the parsed JSON, rejects with the server's plain sentence. A 401 means the server
 *  restarted and the token changed: ask for the new one and try once more. */
export async function sessionApi(path, body, method, retried = false) {
  const t = await token();
  const init = { cache: 'no-store', headers: { 'x-gamesfun-token': t }, method: method ?? (body === undefined ? 'GET' : 'POST') };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  const res = await fetch(`/api/session/${path.replace(/^\/+/, '')}`, init);
  if (res.status === 401 && !retried) { forgetToken(); return sessionApi(path, body, method, true); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data;
}

/**
 * The event stream; onEvent(event) for each. When the connection drops (the server restarted: a new token, new
 * ids, sequence numbers from 1) it asks for the new token and opens again; the replay is held back by the tab's own
 * seq check, and `onRun(run)` fires when the hello names another run than before, so the tab can forget the old one.
 * → close()
 */
export function openEvents(onEvent, onState = () => {}, onRun = () => {}) {
  let es = null, closed = false, run = null, retry = null;
  const open = () => {
    token().then(t => {
      if (closed) return;
      es = new EventSource(`/api/session/events?token=${encodeURIComponent(t)}`);
      es.onopen = () => onState(true);
      es.onerror = () => {
        onState(false);
        // EventSource retries by itself with the OLD token (a 401 or a dead server ends it): start over with a new one
        es?.close(); es = null; forgetToken();
        if (!closed) retry = setTimeout(open, 1500);
      };
      for (const k of EVENT_KINDS) es.addEventListener(k, m => {
        const e = normalizeEvent(m.data);
        if (!e) return;
        if (e.kind === 'hello') { if (run != null && e.run !== run) onRun(e.run); run = e.run; }
        onEvent(e);
      });
    }).catch(() => { onState(false); if (!closed) retry = setTimeout(open, 1500); });
  };
  open();
  return () => { closed = true; clearTimeout(retry); es?.close(); };
}
