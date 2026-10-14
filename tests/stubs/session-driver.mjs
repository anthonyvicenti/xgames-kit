// Drives the REAL bridge routes (builder/server/routes/session.mjs) as a person's agent session would, with no model:
// the plugin's hook posts (POST /api/session/hook/<Event>, bodies in Claude Code's hook-input shape), the session's
// tool routes (GET requests, POST request/<id>/done) and the wait. This replaced the contract stub for the studio
// page's tests and screenshots (the stub could not be driven into any state the real bridge cannot reach).
export async function sessionDriver(base, { id = 's-test-1', cwd = '/tmp/game', mode = 'default' } = {}) {
  const get = async () => (await fetch(`${base}/api/session/token`, { headers: { 'sec-fetch-site': 'same-origin' } })).json();
  let { token } = await get();
  const d = { id, cwd, mode, token, base, waits: [] };
  const headers = () => ({ 'content-type': 'application/json', 'x-gamesfun-token': d.token });
  d.refreshToken = async () => { d.token = (await get()).token; return d.token; };
  d.call = async (method, p, body) => {
    const r = await fetch(`${base}/api/session/${p}`, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: r.status, text, body: json };
  };
  /** The plugin's hook post. Resolves with the HTTP answer (a PermissionRequest resolves only after the click). */
  d.hook = (event, extra = {}) => d.call('POST', `hook/${event}`, { session_id: d.id, cwd: d.cwd, hook_event_name: event, permission_mode: d.mode, ...extra });
  d.start = (source = 'startup') => d.hook('SessionStart', { source });
  d.prompt = prompt => d.hook('UserPromptSubmit', { prompt });
  d.tool = async (tool_name, tool_input, ok = true) => { await d.hook('PreToolUse', { tool_name, tool_input }); return d.hook(ok ? 'PostToolUse' : 'PostToolUseFailure', { tool_name, tool_input }); };
  d.ask = (tool_name, tool_input) => d.hook('PermissionRequest', { tool_name, tool_input });
  d.stop = (last = 'Done') => d.hook('Stop', { last_assistant_message: last });
  d.end = (reason = 'other') => d.hook('SessionEnd', { reason });
  d.collect = () => d.call('GET', `requests?session=${encodeURIComponent(d.id)}`);
  d.done = (rid, note = 'done', status) => d.call('POST', `request/${rid}/done`, { note, ...(status ? { status } : {}) });
  d.queue = async () => (await d.call('GET', 'queue')).body;
  /** Open the session's wait (as plugin/scripts/wait.mjs does); → { lines, close() }. */
  d.wait = async (form = 'rewake') => {
    const ac = new AbortController();
    const w = { lines: [], closed: false, close: () => ac.abort() };
    const res = await fetch(`${base}/api/session/wait?session=${encodeURIComponent(d.id)}&form=${form}&cwd=${encodeURIComponent(d.cwd)}`, { headers: headers(), signal: ac.signal });
    (async () => {
      try {
        let buf = '';
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString();
          let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) w.lines.push(JSON.parse(l)); }
        }
      } catch { /* aborted */ }
      w.closed = true;
    })();
    d.waits.push(w);
    return w;
  };
  d.closeAll = () => { for (const w of d.waits) w.close(); };
  return d;
}
