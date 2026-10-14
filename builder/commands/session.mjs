// `gamesfun session …`: the studio page's link to an agent session, from the session's own terminal. Needs no plugin
// and no MCP tools, so it works in the session that ran the one line, before anything is reloaded.
//
//   session wait      the listener: run it in the background. It ends when the page sends something and prints the
//                     request and what to do; an agent that is woken when a background command ends (Claude Code) is
//                     woken by it. Start it again after each request.
//   session report    a request done (or --dropped, with the reason): what the page shows
//   session requests  what the page has sent this session and it has not reported
//   session status    is a studio running, which sessions it sees, and how each one is reached
import { guard, parse, printJson, UsageError } from '../lib/cli.mjs';

const usage = `Usage: gamesfun session wait [--max <seconds>]
       gamesfun session report <request id> ["<what you did, in a sentence>"] [--dropped "<why not>"]
       gamesfun session requests
       gamesfun session status [--json]

The studio page's link to your agent session, from the session's own terminal (no plugin, no MCP tools needed).
  wait      listen for the page: run it in the background. It ends when the person sends something from the page,
            and prints the request with how to build it and how to report it. Start it again after each one.
  report    tell the page a request is done (the note is what the person reads), or --dropped with the reason
  requests  what the page has sent this session that it has not reported
  status    is a studio running here, and which sessions it sees
The session is the agent's own (CLAUDE_CODE_SESSION_ID in Claude Code), GAMESFUN_SESSION when set, else one per kit
folder.`;

export default {
  name: 'session',
  summary: 'the studio page\'s link to your agent session from its terminal: wait (listen), report, requests, status',
  usage,
  run: args => guard(async () => {
    const { values, positionals } = parse(args, { max: { type: 'string' }, dropped: { type: 'string' } }, usage);
    const [what, ...rest] = positionals;
    const client = await import('../bridge/client.mjs');
    const cli = 'node bin/gamesfun.mjs';

    if (what === 'wait') {
      const max = values.max === undefined ? 0 : Number(values.max);
      if (!Number.isFinite(max) || max < 0) throw new UsageError(`--max takes seconds\n\n${usage}`);
      const who = client.sessionIdentity();
      console.error(`session wait: listening for the studio page (session ${who.id})`);
      const got = await client.listen({ maxMs: max * 1000, onWaiting: m => console.error(`session wait: ${m}`) });
      if (got.type === 'requests') { console.log(got.text); return 0; }
      if (got.type === 'superseded') { console.log('session wait: a newer listener of this session took over; this one has nothing to do.'); return 0; }
      if (got.type === 'ended') { console.log('session wait: the studio says this session ended.'); return 0; }
      console.log(`session wait: nothing from the page in ${max} s. Start it again to keep listening: ${cli} session wait`);
      return 0;
    }

    if (what === 'report') {
      const [id, note] = rest;
      if (!id) throw new UsageError(`which request? session report <id> "<note>"\n\n${usage}`);
      const { runToolByName } = await import('./tool.mjs');
      const dropped = values.dropped !== undefined;
      const r = await runToolByName('gamesfun_requests', { session: client.sessionIdentity().id, done: { id, note: dropped ? (values.dropped || note || null) : (note ?? null), status: dropped ? 'dropped' : 'done' } });
      let v = null;
      try { v = JSON.parse(r.text); } catch { /* plain text */ }
      if (!r.ok || v?.ok === false) { console.error(v?.why ?? v?.error ?? r.text); return 1; }
      console.log(`reported ${id}: ${v?.reported?.state ?? (dropped ? 'dropped' : 'done')}${v?.reported?.note ? ` (${v.reported.note})` : ''}`);
      const st = await client.bridgeStatus({});
      const me = st.running ? st.sessions.find(s => s.id === client.sessionIdentity().id) : null;
      if (st.running && !me?.connected) console.log(`The page is not reaching this session now. To hear its next request, start ${cli} session wait in the background.`);
      return 0;
    }

    if (what === 'requests') {
      const r = await client.collectRequests({ session: client.sessionIdentity().id });
      if (!r.ok) { console.error(r.error); return 1; }
      if (values.json) { printJson(r); return 0; }
      if (!r.requests.length) { console.log('Nothing from the page is open for this session.'); return 0; }
      for (const q of r.requests) console.log(`GF_REQUEST ${JSON.stringify({ id: q.id, text: q.text, ...(q.selection ? { selection: q.selection } : {}) })}`);
      console.log(`Do each, then: ${cli} session report <id> "<note>"`);
      return 0;
    }

    if (what === 'status' || !what) {
      const st = await client.bridgeStatus({});
      if (values.json) { printJson({ ...st, me: client.sessionIdentity() }); return 0; }
      if (!st.running) { console.log(`No studio is running here. Start it: ${cli} dev`); return 0; }
      console.log(`studio ${st.url} (run ${st.run}); ${st.waiting} request(s) waiting for a session`);
      for (const s of st.sessions) console.log(`  ${s.id}${s.id === client.sessionIdentity().id ? ' (this one)' : ''}: ${s.state}, ${s.connected ? `listening (${s.listening})` : 'not listening'}, reported by ${s.channel}${s.tools ? `, builds with ${s.tools === 'mcp' ? 'the tools' : 'the terminal commands'}` : ''}`);
      return 0;
    }
    throw new UsageError(usage);
  }),
};
