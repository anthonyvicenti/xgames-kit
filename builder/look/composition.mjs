#!/usr/bin/env node
// What the play happens on (looks wave 4, 2026-10-14). A target read before the composition was in the rubric has none;
// this reads it for each of the target's looks (or the whole set) from that look's own gameplay frames, on the same
// fixed rubric the reader uses (look-target.schema.json $defs/composition), and writes it into world.composition (and
// each look's world.composition). The reader (target.mjs) asks the same thing in its one round for new targets.
//
//   compositionMessage(frames, {name})   → the rubric for one look's frames
//   COMPOSITION_SCHEMA                   → the structured answer's schema
//   async compose(target, frames, judge) → the target with world.composition (and each look's)
//
//   node builder/look/composition.mjs <target.json> --refs <reference folder> [--out target.json] [--judged answers.json] [--model opus]
//
// The answer is the reader's (a vision model's judgement of the frames); the composer reads it, never a game's name.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_ROOT } from '../lib/paths.mjs';
import { readManifest } from './refs.mjs';

const LT = JSON.parse(await readFile(path.join(KIT_ROOT, 'builder/spec/look-target.schema.json'), 'utf8'));
const inline = node => (Array.isArray(node) ? node.map(inline) : node && typeof node === 'object'
  ? (node.$ref?.startsWith('#/$defs/') ? inline(LT.$defs[node.$ref.slice(8)]) : Object.fromEntries(Object.entries(node).map(([k, v]) => [k, inline(v)]))) : node);

/** The structured answer: the composition of one look. */
export const COMPOSITION_SCHEMA = inline(LT.$defs.composition);

/** The rubric for one look's frames. frames: [{file, frame, note}] (numbered as listed). */
export function compositionMessage(frames, { name = null } = {}) {
  return [
    `These ${frames.length} frames are from one look${name ? ` ("${name}")` : ''} of a game whose style a builder will match (style only: never its characters, names or art). Read each with the Read tool:`,
    ...frames.map((f, i) => `${i + 1}. ${f.file}${f.frame ? ` (${f.frame})` : ''}${f.note ? `: ${f.note}` : ''}`),
    '',
    'Answer what the PLAY HAPPENS ON, judged mostly from the gameplay frames (the ones where players fight or move):',
    '- landmarks: the playfield\'s main landmarks, biggest in play first (up to 4): what (plain words: "a castle keep with cone-roofed towers", "an arched stone bridge", "a sandstone mesa"), kind (building, fortress, tower, ruin, bridge, rock, tree, ship, statue, other), play (on: players stand on its walls and roofs; around: on the ground round its base; across: a bridge they cross; behind: it stands behind the action; far: only in the distance).',
    '- playOn: how play meets the MAIN landmark (on, around, across, behind), or open when the frames show open ground with no landmark in play.',
    '- bridges: how many bridges join landmasses in a level (0 none).',
    '- verticality: 0 flat play … 1 towers, ledges and drops players move between.',
    '- share: the share of a gameplay frame the landmarks\' silhouettes take at play distance (0.1 a small piece, 0.3 a big one, 0.5 half the frame), the typical gameplay frame, not the widest shot.',
    'Never name the game or its places.',
  ].join('\n');
}

/** A judge on the loop's runner (claudeRunner): one read-only session per look. → judge({message, schema, dirs}) */
export function runnerJudge(run, { model = 'opus' } = {}) {
  return async ({ message, schema, dirs }) => {
    const r = await run({
      prompt: message, schema: { type: 'object', required: ['composition'], additionalProperties: false, properties: { composition: schema } },
      system: 'You read reference images for a game builder\'s style target. Read the frames with the Read tool; answer with the structured output only.',
      model, name: `look-compose-${Date.now().toString(36)}`, cwd: dirs[0] ?? process.cwd(), addDirs: dirs.slice(1),
      allowed: ['Read'], disallowed: ['Edit', 'Write', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task'], timeoutMinutes: 15,
    });
    if (!r.ok || !r.structured?.composition) throw new Error(`the reader gave no composition: ${r.error ?? 'no structured answer'}`);
    return { composition: r.structured.composition, model: r.models?.[0] ?? model };
  };
}

/**
 * The target with the composition of each look (from its own frames) and of the whole (the biggest look's, or the
 * whole set's when it has no looks). frames: the references [{sha256, file, frame, note}]; judge(look) → composition;
 * answers: {<look id | '*'>: composition} given instead of a judge.
 */
export async function compose(target, frames, { judge = null, answers = null, log = () => {} } = {}) {
  const t = structuredClone(target);
  const groups = t.looks?.length ? t.looks.map(L => ({ id: L.id, name: L.name, frames: frames.filter(f => L.frames.includes(f.sha256)) })) : [{ id: '*', name: null, frames }];
  const got = {};
  for (const g of groups) {
    if (answers?.[g.id]) { got[g.id] = answers[g.id]; continue; }
    if (!judge) throw new Error(`no composition for ${g.id} and no judge`);
    const message = compositionMessage(g.frames, { name: g.name }), dirs = [...new Set(g.frames.map(f => path.dirname(f.file)))];
    const r = await judge({ message, schema: COMPOSITION_SCHEMA, dirs });
    got[g.id] = r.composition;
    log(`${g.id}: ${JSON.stringify(r.composition)}`);
  }
  if (t.looks?.length) {
    for (const L of t.looks) { L.world ??= {}; L.world.composition = got[L.id]; }
    t.world ??= {}; t.world.composition = got[t.looks[0].id];
  } else { t.world ??= {}; t.world.composition = got['*']; }
  t.sources ??= {}; t.sources.judged = [...new Set([...(t.sources.judged ?? []), 'composition'])];
  return t;
}

// ---- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const file = argv.find((a, i) => !a.startsWith('--') && !['--refs', '--out', '--judged', '--model'].includes(argv[i - 1]));
  const target = JSON.parse(await readFile(file, 'utf8'));
  const frames = (await readManifest(opt('--refs'))).frames;
  let judge = null, answers = null;
  if (opt('--judged')) answers = JSON.parse(await readFile(opt('--judged'), 'utf8'));
  else {
    const { claudeRunner, patient } = await import('../loop/claude.mjs');
    const logDir = path.join(KIT_ROOT, '.cache', 'look-target', 'rounds');
    judge = runnerJudge(patient(claudeRunner({ logDir, log: m => console.error(m) }), { log: m => console.error(m) }), { model: opt('--model') ?? 'opus' });
  }
  const t = await compose(target, frames, { judge, answers, log: m => console.error(m) });
  const { loadSchemas, SCHEMA } = await import('../../registry/schemas.mjs');
  const problems = (await loadSchemas()).validate(SCHEMA.lookTarget, t);
  if (problems.length) console.error(`not valid gf-look-target/1:\n  ${problems.join('\n  ')}`);
  const out = opt('--out');
  const text = JSON.stringify(t, null, 2) + '\n';
  if (out) { await mkdir(path.dirname(path.resolve(out)), { recursive: true }); await writeFile(out, text); console.error(`wrote ${out}`); } else process.stdout.write(text);
  process.exit(problems.length ? 1 : 0);
}
