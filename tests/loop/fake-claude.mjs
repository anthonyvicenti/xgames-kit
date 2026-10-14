#!/usr/bin/env node
// A stand-in for `claude -p` (tests only): reads the round's message on stdin and its --json-schema, and answers as a
// headless session would, in stream-json. FAKE_CLAUDE_SCRIPT names a module whose `answer({kind, prompt, args, cwd})`
// gives the structured output; the call is logged to FAKE_CLAUDE_LOG.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
let prompt = '';
for await (const c of process.stdin) prompt += c;
const schema = JSON.parse(opt('--json-schema') ?? '{}');
const req = schema.required ?? [];
const kind = req.includes('rows') ? 'read' : req.includes('ledger') ? 'ledger' : req.includes('pitch') ? 'pitch' : req.includes('spec') ? 'spec' : req.includes('probes') ? 'probe' : req.includes('questions') ? 'ask' : req.includes('promises') ? 'playtest' : 'build';
const { answer } = await import(pathToFileURL(process.env.FAKE_CLAUDE_SCRIPT).href);
const out = await answer({ kind, prompt, args, cwd: process.cwd(), model: opt('--model'), effort: opt('--effort') });
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ kind, model: opt('--model'), effort: opt('--effort'), cwd: process.cwd(), args }) + '\n');
const line = v => process.stdout.write(JSON.stringify(v) + '\n');
line({ type: 'system', subtype: 'init', model: opt('--model') });
line({ type: 'assistant', message: { model: `fake-${opt('--model') ?? 'model'}`, content: [{ type: 'text', text: 'done' }] } });
line({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, session_id: 'fake', result: JSON.stringify(out), structured_output: out, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 }, modelUsage: { [`fake-${opt('--model') ?? 'model'}`]: {} } });
