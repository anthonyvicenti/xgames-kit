// runtime godot: the page's side of the bridge, window.gfGodot. The game's GF autoload (addons/gf/gf.gd) calls it
// through Godot's JavaScriptBridge:
//
//   hello(json)        once, from GF._ready: the addon is up ({addon, godot})
//   pull() → json      once a Godot frame: what the kit says since the last pull ('' when nothing): the latest phase,
//                      input, host, me, peers and shared state, and the queued messages (place, send, value, file)
//   push(json)         once a Godot frame: what the game did ({me: pose, friends, view, events, game})
//   file(req, id)      read a file slot (or a game path) through gf-assets; answered by a 'file' message, then
//   take(req) → bytes  the bytes, a Uint8Array (JavaScriptBridge.js_buffer_to_packed_byte_array on the Godot side)
//   sound(id, json)    play a listed sound through gf-audio
//   panel(req, kind, json)   open one of the kit's panels (choice, shop, inventory, dialogue, input); answered by a
//                      'panel' message with its result when it closes, and 'panel-event' messages on the way (a buy,
//                      a selection); panelClose(req) closes it
//
// Nothing here waits on Godot: a Godot frame that does not come (a tab in the background) leaves the latest state in
// place and the messages queued; the round, the net and the host's shared world keep going in the page.

/** fnv-1a over bytes, as 8 hex digits: which file the game was handed (the observation's file list). */
export function fnv(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function createBridge({ read, onSound = () => {}, onPanel = () => null, onError = () => {}, win = globalThis } = {}) {
  let next = {};                      // fields of the next pull (the latest of each)
  const queue = [];                   // messages of the next pull, in order
  const files = new Map();            // req → Uint8Array waiting for take()
  const handed = [];                  // [{id, path, bytes, hash}] every file the game was given
  const panels = new Map();           // req → an open panel's handle
  const events = [];                  // the game's events, until the boot takes them
  let latest = {}, frames = 0, pulls = 0, hello = null, helloFn = null;
  const helloP = new Promise(r => { helloFn = r; });
  const MAX_QUEUE = 2000;

  const api = {
    hello(json) { try { hello = JSON.parse(json); } catch { hello = {}; } helloFn(hello); },
    pull() {
      pulls++;
      if (!queue.length && !Object.keys(next).length) return '';
      const m = { ...next, msgs: queue.splice(0) };
      next = {};
      return JSON.stringify(m);
    },
    push(json) {
      let s; try { s = JSON.parse(json); } catch (e) { onError('push', e); return; }
      frames++;
      if (Array.isArray(s.events)) { events.push(...s.events); if (events.length > 500) events.splice(0, events.length - 500); }
      delete s.events;
      latest = s;
    },
    file(req, id) {
      Promise.resolve().then(() => read(String(id))).then(({ path, buf }) => {
        const bytes = new Uint8Array(buf);
        files.set(req, bytes);
        handed.push({ id: String(id), path, bytes: bytes.length, hash: fnv(bytes) });
        send({ k: 'file', req, ok: true });
      }).catch(e => { onError(`file ${id}`, e); send({ k: 'file', req, ok: false }); });
    },
    take(req) { const b = files.get(req) ?? new Uint8Array(0); files.delete(req); return b; },
    sound(id, json) { let o = {}; try { o = JSON.parse(json || '{}'); } catch {} onSound(String(id), o); },
    panel(req, kind, json) {
      let o = {}; try { o = JSON.parse(json || '{}'); } catch {}
      const r = Number(req), h = onPanel(String(kind), o, (name, data) => send({ k: 'panel-event', req: r, name, data: data ?? null }));
      if (!h) { send({ k: 'panel', req: r, result: null, refused: true }); return; }
      panels.set(r, h);
      Promise.resolve(h.done).then(result => { panels.delete(r); send({ k: 'panel', req: r, result: result ?? null, refused: !!h.refused }); });
    },
    panelClose(req) { panels.get(Number(req))?.close?.(null); },
  };
  function send(msg) { queue.push(msg); if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE); }
  win.gfGodot = api;
  return {
    api,
    /** Resolves with the addon's hello ({addon, godot}). */
    hello: helloP,
    /** Set a field of the next pull (the latest value wins: phase, input, host, me, peers, shared, boot). */
    set(key, value) { next[key] = value; },
    /** Queue a message ({k: 'place' | 'send' | 'value', ...}). */
    send,
    /** The game's latest frame: {me, friends, view, game}. */
    get latest() { return latest; },
    get frames() { return frames; },
    get pulls() { return pulls; },
    get addon() { return hello; },
    /** The game's events since the last call. */
    takeEvents: () => events.splice(0),
    /** Every file handed to the game. */
    handed: () => handed.slice(),
  };
}
