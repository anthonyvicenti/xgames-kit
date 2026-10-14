// The eval runner's pure parts (builder/web3/economy/evals/run.mjs): the session it starts can use the economy tools and edit
// its own folder, nothing else, and what a transcript says is read back right. The runner itself needs Claude Code and
// spends money, so it is run by hand (results in builder/web3/economy/evals/results/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendedPrompt, claudeArgs, readTranscript } from '../builder/web3/economy/evals/run.mjs';

test('the session: the case sentence alone, the kit server only, no shell, nothing that would ask', () => {
  const a = claudeArgs({ prompt: 'A shop that sells three hats.', id: 'e03-hat-shop', mcpConfig: '/tmp/x/mcp.json' });
  const after = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(after('-p'), 'A shop that sells three hats.');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(after('--setting-sources'), 'project,local');
  assert.equal(after('--permission-prompts'), 'none');
  assert.ok(!after('--tools').split(',').includes('Bash'));
  const allowed = after('--allowedTools').split(',');
  assert.ok(allowed.includes('mcp__gamesfun__economy_save'));
  assert.ok(!allowed.some((t) => /web3_(add|update|remove|prepare|link|unlink|set)/.test(t)));
  assert.match(after('--append-system-prompt'), /games\/e03-hat-shop/);
  assert.doesNotMatch(appendedPrompt('x'), /save|economy_/i, 'the harness does not tell the agent what to do');
});

test('a transcript gives the tool calls, whether it saved, the refusals and the cost', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: {} }, { type: 'text', text: 'hi' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__gamesfun__economy_save', input: { game: 'games/x' } }] } },
    { type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.5, duration_ms: 12_400, result: 'Saved.', permission_denials: [{ tool_name: 'mcp__gamesfun__web3_add_item' }] },
  ].map((l) => JSON.stringify(l)).join('\n');
  const t = readTranscript(`${lines}\nnot json\n`);
  assert.deepEqual(t.calls, ['Skill', 'economy_save']);
  assert.equal(t.saved, true);
  assert.deepEqual(t.denied, ['mcp__gamesfun__web3_add_item']);
  assert.equal(t.costUsd, 0.5);
  assert.equal(t.seconds, 12);
  assert.equal(t.stop, 'success');
  assert.equal(readTranscript('').stop, 'no result');
});
