// The model judge's vision tier: Claude looks at a body's contact sheet (body-sheet.mjs) and says, for the face, body,
// arms, hands, legs and feet, whether any pose shows that part broken. The measuring tier (body-judge.mjs) can only see
// what bones and skin weights say; this sees the model itself: a generated hand with fused or extra fingers, a smeared
// face, a limb sinking into the body. Creator, 2026-10-07: "We need to look at face, body, arms, legs, hands, and feet."
//
//   const r = await lookAtSheet('<look-sheet.jpg>', { describe });
//   // { ok, parts: {face: {ok, severity: none|minor|major, issue}, …}, summary, model, seconds }; a major fault fails a part
// The sheet (body-sheet.mjs pairSheet) puts the clips' own mannequin in the same pose beside the whole body and each hand:
// without it, a two-handed grip with no gun drawn read as "fingers fused" on a body that was fine; with the mannequin on
// a separate sheet, Sonnet passed the creator's crooked hand as "claws are the design".
//
// One `claude -p` session (the Claude Code CLI and its login, as the Studio worker's agents use) with only the Read tool,
// no MCP servers and a JSON schema for its answer, run from a temp folder (no project CLAUDE.md). The verdict is a
// judgement, not a measure: record it beside the measuring tier's, which is the one verify enforces.
import { spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Opus: on the same sheets Sonnet passed the creator's crooked hand in 2 of 3 runs ("claws match the design"); about $0.11 a look
export const LOOK_MODEL = process.env.GF_LOOK_MODEL || 'claude-opus-5-5';
export const LOOK_PARTS = ['face', 'body', 'arms', 'hands', 'legs', 'feet'];
const part = { type: 'object', additionalProperties: false, required: ['severity', 'issue'], properties: { severity: { type: 'string', enum: ['none', 'minor', 'major'] }, issue: { type: 'string', description: 'empty when none; else what is wrong and in which row and column' } } };
export const LOOK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['parts', 'summary'],
  properties: { parts: { type: 'object', additionalProperties: false, required: LOOK_PARTS, properties: Object.fromEntries(LOOK_PARTS.map(p => [p, part])) }, summary: { type: 'string' } },
};

export function lookPrompt(sheetName, describe = '') {
  return [
    `Read the image ${sheetName}. It is a contact sheet of one 3D game character${describe ? ` (${describe})` : ''}, posed by the game's animations.`,
    'Each row is one pose, named on the left. The first row, "rest", is the character as it was made: its design. The columns marked "character" show the character: the whole body from the front, the face, the left hand, the right hand and the feet. Beside the whole body and each hand, a column marked "MANNEQUIN" (red) shows the plain mannequin the animations were made on, in the same pose and from the same camera: what the pose is meant to do (fists, both hands together in a two-handed gun grip with no gun drawn, a wave).',
    'Judge six parts: face, body, arms, hands, legs and feet: does any pose deform the part in a way a real body could not move? Look hardest at the hands, comparing each character hand with the mannequin hand beside it:',
    '- hands: where the mannequin\'s fingers curl into a fist or a grip, a character whose rest-row hand has separate fingers should curl the same way (thick low-poly fingers in a fist can look lumpy; that is fine). FAIL when the character\'s fingers do something the mannequin\'s do not: hook into a claw while the mannequin\'s are straight or curled differently, bend sideways or backward, the palm folds or hollows, fingers twist around each other, or the hand flattens into a paddle. A hand whose rest row is open, clawed or without separate fingers (a zombie, a monster, a mitten) keeps that shape in every pose: fine.',
    '- face: stretched, smeared, torn or caved in when the head turns;',
    '- arms and legs: twisted like a candy wrapper, kinked, bent the wrong way at the elbow or knee, collapsed thin at a joint, or sinking deep into the body;',
    '- feet: turned sideways or backward, folded, or through the floor;',
    '- body: torn, spiked, caved in or folded through itself.',
    'Never fail a part for what its rest row already shows (proportions, face, mittens, a tail), and never for doing what the mannequin beside it does. Skin passing a little into skin at a deep bend (crouching, lying down) is minor. A close-up that shows only a sleeve or the floor because the part is hidden is not a failure.',
    'Grade each part: "none" when nothing is wrong; "minor" when the fault shows only in a close-up of one or two poses, or the part does what the mannequin does but looser or tighter (a grip less closed, fingers a little apart); "major" when a player would notice it in play: it shows in idle, walk or run, or in most poses, or it is grotesque (a claw where every pose should be a fist, a folded palm, a stretched face, a limb bent the wrong way).',
    'Answer with JSON matching the schema: for each part its severity and, unless none, the issue naming the rows and the column. summary: one sentence.',
  ].join('\n');
}

function run(cmd, args, { cwd, timeoutMs }) {
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGTERM'); bad(new Error(`claude -p timed out after ${timeoutMs / 1000} s`)); }, timeoutMs);
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(t); bad(e); });
    p.on('close', code => { clearTimeout(t); code === 0 ? ok(out) : bad(new Error(`claude -p exited ${code}: ${(err || out).slice(0, 400)}`)); });
  });
}

export async function lookAtSheet(sheet, { describe = '', model = LOOK_MODEL, timeoutMs = 300000, claude = process.env.GF_CLAUDE_BIN || 'claude' } = {}) {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'gf-look-'));
  try {
    const name = 'character.jpg';
    copyFileSync(sheet, join(dir, name));
    const raw = await run(claude, ['-p', lookPrompt(name, describe), '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(LOOK_SCHEMA),
      '--tools', 'Read', '--allowedTools', 'Read', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', ''], { cwd: dir, timeoutMs });
    const env = JSON.parse(raw);
    let ans = env.structured_output ?? null;
    if (!ans && typeof env.result === 'string') { const m = env.result.match(/\{[\s\S]*\}/); if (m) ans = JSON.parse(m[0]); }
    if (!ans?.parts) throw new Error(`no verdict in the answer: ${String(env.result ?? raw).slice(0, 300)}`);
    // a major fault fails the part; a minor one is a note (a grip a little looser than the mannequin's)
    const parts = Object.fromEntries(LOOK_PARTS.map(p => { const sev = ans.parts[p]?.severity ?? 'none'; return [p, { ok: sev !== 'major', severity: sev, issue: ans.parts[p]?.issue ?? '' }]; }));
    return { ok: LOOK_PARTS.every(p => parts[p].ok), parts, summary: ans.summary ?? '', model, seconds: Math.round((Date.now() - t0) / 100) / 10,
      usage: env.usage ? { input: env.usage.input_tokens, output: env.usage.output_tokens, cacheRead: env.usage.cache_read_input_tokens } : null, cost: env.total_cost_usd ?? null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
