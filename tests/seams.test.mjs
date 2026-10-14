// The seams other tracks plug into (docs/ARCHITECTURE.md): commands, MCP tools, studio tabs. Routes: server.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BIN, KIT_ROOT, STUDIO } from '../builder/lib/paths.mjs';
import { createServer, inputProblems, loadTools, toResult, TOOLS_DIR } from '../builder/mcp/server.mjs';
import { tempDir } from './helpers.mjs';

const CORE_COMMANDS = ['catalog', 'create', 'dev', 'examples', 'meshy', 'play', 'promises', 'rig-check', 'slots', 'verify'];

test('commands: every commands/*.mjs exports default { name, summary, usage, run }', async () => {
  const dir = path.join(KIT_ROOT, 'builder', 'commands');
  const names = new Set();
  for (const f of (await readdir(dir)).filter(f => f.endsWith('.mjs'))) {
    const c = (await import(pathToFileURL(path.join(dir, f)).href)).default;
    assert.equal(typeof c?.name, 'string', `${f}: name`);
    assert.equal(typeof c.summary, 'string', `${f}: summary`);
    assert.equal(typeof c.usage, 'string', `${f}: usage`);
    assert.equal(typeof c.run, 'function', `${f}: run`);
    assert.ok(!names.has(c.name), `${f}: duplicate name ${c.name}`);
    names.add(c.name);
  }
  for (const n of CORE_COMMANDS) assert.ok(names.has(n), `core command ${n}`);
});

test('commands: the CLI lists every command and answers --help and bad input plainly', () => {
  const help = spawnSync(process.execPath, [BIN, 'help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  for (const n of CORE_COMMANDS) assert.match(help.stdout, new RegExp(`\\n  ${n} `));
  const h = spawnSync(process.execPath, [BIN, 'create', '--help'], { encoding: 'utf8' });
  assert.match(h.stdout, /--from <example>/);
  const bad = spawnSync(process.execPath, [BIN, 'create', 'x', '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.doesNotMatch(bad.stderr, /at .*\.mjs:\d+/, 'no stack trace for a usage error');
  assert.equal(spawnSync(process.execPath, [BIN, 'no-such-command'], { encoding: 'utf8' }).status, 1);
});

test('MCP tools: core tools load, with valid unique names and object schemas', async () => {
  const { tools, problems } = await loadTools(TOOLS_DIR);
  assert.deepEqual(problems, []);
  for (const n of ['gamesfun_catalog', 'gamesfun_create', 'gamesfun_verify', 'gamesfun_slots_list', 'gamesfun_slots_set', 'gamesfun_dev_status', 'gamesfun_dev_start']) assert.ok(tools.has(n), n);
  for (const t of tools.values()) {
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema`);
    assert.ok(t.description.length > 20, `${t.name} description`);
  }
});

test('MCP tools: a plug-in tools file is picked up; a broken one or a duplicate name is reported, not fatal', async () => {
  const t = await tempDir();
  try {
    await writeFile(path.join(t.dir, 'extra.mjs'), `export const tools = [{ name: 'extra_hello', description: 'Says hello to whoever asks.', inputSchema: { type: 'object', required: ['who'], properties: { who: { type: 'string' } } }, handler: ({ who }, ctx) => ({ hello: who, kitRoot: ctx.kitRoot }) }];`);
    await writeFile(path.join(t.dir, 'zz-dupe.mjs'), `export const tools = [{ name: 'extra_hello', description: 'A second tool with the same name.', handler: () => 1 }];`);
    await writeFile(path.join(t.dir, 'broken.mjs'), 'throw new Error("boom");');
    const { tools, problems } = await loadTools(t.dir);
    assert.ok(tools.has('extra_hello'));
    assert.equal(problems.length, 2);
    // over the protocol, with an in-memory client
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { server } = await createServer({ toolsDir: t.dir, log: () => {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    assert.deepEqual((await client.listTools()).tools.map(x => x.name), ['extra_hello']);
    const r = await client.callTool({ name: 'extra_hello', arguments: { who: 'ada' } });
    assert.deepEqual(JSON.parse(r.content[0].text), { hello: 'ada', kitRoot: KIT_ROOT });
    const missing = await client.callTool({ name: 'extra_hello', arguments: {} });
    assert.equal(missing.isError, true);
    await client.close();
  } finally { await t.cleanup(); }
});

test('MCP helpers: input checks and result shapes', () => {
  const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string' }, n: { type: 'integer' }, k: { type: 'string', enum: ['a', 'b'] } } };
  assert.deepEqual(inputProblems(schema, { id: 'x' }), []);
  assert.equal(inputProblems(schema, {}).length, 1);
  assert.equal(inputProblems(schema, { id: 'x', n: 1.5 }).length, 1);
  assert.equal(inputProblems(schema, { id: 'x', k: 'c' }).length, 1);
  assert.deepEqual(toResult('hi'), { content: [{ type: 'text', text: 'hi' }] });
  assert.deepEqual(toResult({ content: [{ type: 'text', text: 'x' }] }), { content: [{ type: 'text', text: 'x' }] });
  // a real JSON Schema check (Ajv), nested too, in words that name the place
  const nested = { type: 'object', required: ['report'], properties: { report: { type: 'object', required: ['verdict'], additionalProperties: false, properties: { verdict: { enum: ['pass', 'fail'] }, promises: { type: 'array', items: { type: 'object', required: ['id'], properties: { pass: { type: ['boolean', 'null'] } } } } } } } };
  assert.deepEqual(inputProblems(nested, { report: { verdict: 'pass', promises: [{ id: 'a', pass: null }] } }), []);
  const bad = inputProblems(nested, { report: { verdict: 'maybe', promises: [{ pass: 'yes' }], extra: 1 } });
  assert.ok(bad.includes('report.promises[0].id is required'), bad.join(' | '));
  assert.ok(bad.includes('report.promises[0].pass must be boolean or null'), bad.join(' | '));
  assert.ok(bad.some(l => /report: "extra" is not an argument/.test(l)), bad.join(' | '));
  assert.ok(bad.some(l => /report\.verdict must be one of "pass", "fail"/.test(l)), bad.join(' | '));
  assert.deepEqual(inputProblems({ type: 'object' }, []), ['arguments must be an object']);
  // an answer with an output schema also goes out as structuredContent; its text is the same JSON as before
  const tool = { outputSchema: { type: 'object' } };
  assert.deepEqual(toResult({ a: 1 }, tool), { content: [{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }], structuredContent: { a: 1 } });
  assert.deepEqual(toResult('lines', tool).structuredContent, { text: 'lines' });
  assert.equal(toResult({ isError: true, content: [{ type: 'text', text: '{"refused":"x"}' }] }, tool).structuredContent, undefined, 'a refusal is an error, not structured');
});

test('MCP tools: every shipped tool says honestly what it does (all four hints) and every schema compiles', async () => {
  const { tools } = await loadTools(TOOLS_DIR);
  const { HINTS, outputProblems } = await import('../builder/mcp/server.mjs');
  for (const t of tools.values()) {
    for (const h of HINTS) assert.equal(typeof t.annotations?.[h], 'boolean', `${t.name}: annotations.${h}`);
    if (t.annotations.readOnlyHint) assert.equal(t.annotations.destructiveHint, false, `${t.name}: a read-only tool destroys nothing`);
    assert.doesNotThrow(() => inputProblems(t.inputSchema, {}), `${t.name}: inputSchema compiles`);
    if (t.outputSchema) { assert.equal(t.outputSchema.type, 'object', `${t.name}: outputSchema is an object`); assert.doesNotThrow(() => outputProblems(t.outputSchema, {}), `${t.name}: outputSchema compiles`); }
  }
  // the ones a caller leans on carry an output schema
  for (const n of ['gamesfun_next', 'gamesfun_step_pitch', 'gamesfun_step_spec', 'gamesfun_step_create', 'gamesfun_step_fix', 'gamesfun_step_verify', 'gamesfun_step_playtest', 'gamesfun_step_deliver', 'gamesfun_verify', 'gamesfun_catalog', 'gamesfun_slots_list', 'gamesfun_slots_set', 'gamesfun_playtest_report'])
    assert.ok(tools.get(n)?.outputSchema, `${n}: outputSchema`);
  // the play-test report's shape is a schema, not a sentence
  const report = tools.get('gamesfun_playtest_report').inputSchema.properties.report;
  assert.deepEqual(report.required, ['promises', 'summary']);
  assert.deepEqual(report.properties.promises.items.properties.status.enum, ['seen', 'not-seen', 'unreachable']);
  assert.equal(report.properties.feel.items.type, 'string');
  assert.ok(tools.get('gamesfun_playtest_report').inputSchema.required.includes('token'));
});

test('MCP over the protocol and the terminal path give the same answer, and the client sees the hints and the output schema', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { runToolByName } = await import('../builder/commands/tool.mjs');
  const { server } = await createServer({ log: () => {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const listed = (await client.listTools()).tools.find(x => x.name === 'gamesfun_catalog');
    assert.equal(listed.annotations.readOnlyHint, true); assert.equal(listed.outputSchema.type, 'object');
    const args = { sections: ['loops'], json: true };
    const viaMcp = await client.callTool({ name: 'gamesfun_catalog', arguments: args });   // the SDK client checks structuredContent against the schema
    assert.ok(viaMcp.structuredContent?.loops, 'structuredContent');
    const viaCli = await runToolByName('gamesfun_catalog', args, { log: () => {} });
    assert.equal(viaCli.ok, true);
    assert.equal(viaCli.text, viaMcp.content[0].text, 'the same text on both paths');
    // a bad argument: the same words on both paths
    const badMcp = await client.callTool({ name: 'gamesfun_catalog', arguments: { sections: ['nope'] } });
    const badCli = await runToolByName('gamesfun_catalog', { sections: ['nope'] }, { log: () => {} });
    assert.equal(badMcp.isError, true); assert.equal(badCli.ok, false);
    assert.equal(badCli.text, badMcp.content[0].text);
    assert.match(badCli.text, /sections\[0\] must be one of/);
  } finally { await client.close(); }
});

test('studio tabs: every studio/tabs/*.js exports default { id, label, order, mount } with unique ids', async () => {
  const ids = new Set();
  for (const f of (await readdir(path.join(STUDIO, 'tabs'))).filter(f => f.endsWith('.js'))) {
    const d = (await import(pathToFileURL(path.join(STUDIO, 'tabs', f)).href)).default;
    assert.equal(typeof d?.id, 'string', `${f}: id`);
    assert.equal(typeof d.label, 'string', `${f}: label`);
    assert.equal(typeof d.mount, 'function', `${f}: mount`);
    assert.ok(Number.isFinite(d.order), `${f}: order`);
    assert.ok(!ids.has(d.id), `${f}: duplicate id ${d.id}`);
    ids.add(d.id);
  }
  for (const id of ['assets', 'verify', 'friends']) assert.ok(ids.has(id));
});
