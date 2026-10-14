// Test harness: small steps against a running studio (and the child terminals of child.mjs), for the live proof.
//   node tests/bridge-live/drive.mjs <studio url> <command> [args]
//     request "<text>" [session]     POST a request as the page does; prints its id
//     watch <request id> [ms]        follow one request until done or dropped; prints each state with its time
//     queue                          sessions, requests and permissions now
//     permission allow|deny [ms]     wait for a waiting approval, answer it as the person's click would
//     loop building|delivered|stuck|unstuck|none <game dir>   write the scratch game's loop state (fixture)
//     record <file> <title>          save the server's whole record of the run (events and queue)
// The token is read from the run file, as the plugin reads it.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alive } from '../../builder/bridge/runfile.mjs';

const [url, cmd, ...rest] = process.argv.slice(2);
const file = fileURLToPath(new URL('../../.gamesfun/bridge.json', import.meta.url));
const runs = JSON.parse(await readFile(file, 'utf8').catch(() => '{"runs":[]}')).runs.filter(r => alive(r.pid));
const mine = runs.find(r => r.url === url || r.url === `${url}/`);
if (!mine) { console.error(`no running studio at ${url} in ${file} (running: ${runs.map(r => r.url).join(', ') || 'none'})`); process.exit(1); }
const api = async (method, route, body) => {
  const res = await fetch(new URL(route, url), { method, headers: { 'x-gamesfun-token': mine.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();

if (cmd === 'request') {
  const r = await api('POST', '/api/session/request', { text: rest[0], ...(rest[1] ? { session: rest[1] } : {}) });
  console.log(JSON.stringify(r.json));
} else if (cmd === 'watch') {
  const end = Date.now() + Number(rest[1] || 90_000);
  let last = '';
  while (Date.now() < end) {
    const q = (await api('GET', '/api/session/queue')).json;
    const r = q.requests.find(x => x.id === rest[0]);
    const s = q.sessions.find(x => x.id === r?.session);
    const line = `${r?.state} via=${r?.via} refusals=${r?.refusals} session=${s?.state}/${s?.connected ? 'wait-open' : 'no-wait'}`;
    if (line !== last) { console.log(`+${Date.now() - t0}ms ${line}${r?.note ? ` note=${JSON.stringify(r.note)}` : ''}`); last = line; }
    if (r?.state === 'done' || r?.state === 'dropped') { console.log(JSON.stringify({ id: r.id, state: r.state, createdToHandedMs: r.handed - r.created, createdToSeenMs: r.seen ? r.seen - r.created : null, createdToDoneMs: r.done - r.created })); break; }
    await sleep(100);
  }
} else if (cmd === 'queue') {
  const q = (await api('GET', '/api/session/queue')).json;
  console.log(JSON.stringify({ loop: q.loop, sessions: q.sessions.map(s => ({ id: s.id, cwd: s.cwd, state: s.state, connected: s.connected, primary: s.primary, mode: s.permissionMode, guard: s.guard })), requests: q.requests.map(r => ({ id: r.id, text: r.text.slice(0, 50), session: r.session?.slice(0, 8), state: r.state, via: r.via, refusals: r.refusals, note: r.note })), permissions: q.permissions.map(p => ({ id: p.id, tool: p.tool, input: p.input, state: p.state })) }, null, 1));
} else if (cmd === 'permission') {
  const end = Date.now() + Number(rest[1] || 60_000);
  for (;;) {
    const p = (await api('GET', '/api/session/queue')).json.permissions.find(x => x.state === 'waiting');
    if (p) { const a = await api('POST', `/api/session/permission/${p.id}`, { decision: rest[0] }); console.log(JSON.stringify({ waitedMs: Date.now() - t0, asked: { tool: p.tool, input: p.input, mode: p.mode }, answer: a.json.state })); break; }
    if (Date.now() > end) { console.log('no approval was asked'); process.exit(1); }
    await sleep(100);
  }
} else if (cmd === 'loop') {
  const dir = path.join(path.resolve(rest[1]), '.gf-loop');
  await mkdir(dir, { recursive: true });
  if (rest[0] === 'stuck') await writeFile(path.join(dir, 'stuck'), '');
  else if (rest[0] === 'unstuck') await rm(path.join(dir, 'stuck'), { force: true });
  else if (rest[0] === 'none') await rm(path.join(dir, 'state.json'), { force: true });
  else await writeFile(path.join(dir, 'state.json'), JSON.stringify({ schema: 'gf-loop/1', kind: 'build', status: rest[0], step: rest[0] === 'building' ? 'verify' : 'done', why: rest[0] === 'building' ? 'the full verify has not passed' : 'delivered', round: 0, updated: new Date().toISOString() }));
  console.log(`loop: ${rest[0]}`);
} else if (cmd === 'record') {
  const res = await fetch(new URL(`/api/session/events?after=0&token=${mine.token}`, url));
  let text = '';
  const reader = res.body.getReader();
  const stop = setTimeout(() => reader.cancel(), 1500);
  for (;;) { const { done, value } = await reader.read().catch(() => ({ done: true })); if (done) break; text += Buffer.from(value).toString('utf8'); }
  clearTimeout(stop);
  const events = [...text.matchAll(/\ndata: (.*)\n/g)].map(m => JSON.parse(m[1]));
  const q = (await api('GET', '/api/session/queue')).json;
  await mkdir(path.dirname(path.resolve(rest[0])), { recursive: true });
  await writeFile(rest[0], JSON.stringify({ title: rest[1], recorded: new Date().toISOString(), system: `${process.platform} node ${process.version}`, queue: q, events }, null, 1) + '\n');
  console.log(`recorded ${events.length} events to ${rest[0]}`);
} else { console.error('unknown command'); process.exit(1); }
