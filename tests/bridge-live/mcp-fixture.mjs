// Test fixture only: a stand-in for the loop tools of track M2-G, so the bridge can be proven in a real session before
// those tools exist. `gamesfun_requests` calls the functions the real tool will call (builder/bridge/client.mjs).
// `gamesfun_next` stands in for the loop: it marks the build delivered, unless <game>/.gf-loop/stuck exists.
// (The real loop library is the only writer of the state file; this fixture writes it only in a scratch game.)
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { collectRequests, reportRequest } from '../../builder/bridge/index.mjs';

const game = process.env.GF_FIXTURE_GAME;
const tools = [
  { name: 'gamesfun_requests', description: 'Collect the requests the person typed in the studio page for this session, and report the ones you have done. Pass `done` to report; the answer lists what is still open.',
    inputSchema: { type: 'object', properties: { session: { type: 'string', description: 'your session id for the studio page' }, done: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] } } } } },
  { name: 'gamesfun_next', description: 'Run the next step of the build loop and say what comes after it.', inputSchema: { type: 'object', properties: {} } },
];
const server = new Server({ name: 'gamesfun', version: '0.0.0-fixture' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async req => {
  const input = req.params.arguments ?? {};
  let out;
  if (req.params.name === 'gamesfun_requests') {
    const reported = [];
    for (const d of input.done ?? []) reported.push(await reportRequest({ cwd: game, id: d.id, note: d.note }));
    out = { reported: reported.map(r => (r.ok ? { id: r.request.id, state: r.request.state } : r)), open: await collectRequests({ cwd: game, session: input.session }) };
  } else if (req.params.name === 'gamesfun_next') {
    if (existsSync(path.join(game, '.gf-loop', 'stuck'))) out = { ran: 'verify', next: 'verify', why: 'verify failed again and nothing here can fix it' };
    else {
      await mkdir(path.join(game, '.gf-loop'), { recursive: true });
      await writeFile(path.join(game, '.gf-loop', 'state.json'), JSON.stringify({ schema: 'gf-loop/1', kind: 'build', status: 'delivered', step: 'done', why: 'delivered', updated: new Date().toISOString() }));
      out = { ran: 'deliver', next: 'done', why: 'the game is delivered' };
    }
  } else out = { error: 'unknown tool' };
  return { content: [{ type: 'text', text: JSON.stringify(out) }] };
});
await server.connect(new StdioServerTransport());
