// What the fake `claude -p` (tests/loop/fake-claude.mjs) answers in each round of the tag game: a model that does
// every round right the first time (the verify stand-in decides whether the game passes).
import { CARD_WORDS, pitchV2 } from './registry.mjs';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TAG_LEDGER, tagSpec } from './tag.mjs';

const card = (id, title) => ({ ...CARD_WORDS, id, title, v1: { has: ['a tag round'], build: ['a backyard with cover to run around'], notYet: [] }, spec: tagSpec(title) });
export async function answer({ kind, prompt, cwd }) {
  if (kind === 'ledger') return { ledger: TAG_LEDGER };
  if (kind === 'pitch') return { pitch: pitchV2({ reply: 'Card 1 is a tag round in a backyard. A backyard with cover to run around is built new for this game, which makes the build take a little longer.', cards: [card('a', 'Yard Tag'), card('b', 'Fence Tag')], questions: [] }) };
  if (kind === 'spec') return { spec: tagSpec() };
  if (kind === 'playtest') {
    const ids = [...prompt.matchAll(/^- `([^`]+)`/gm)].map(m => m[1]);
    // a two-player run, recorded where gamesfun_play records it (the tester works in its own folder)
    const { TWO_SEATS } = await import('../dryrun/fakes.mjs');
    await mkdir(path.join(cwd, 'runs', 'one'), { recursive: true });
    await writeFile(path.join(cwd, 'runs', 'one', 'play.json'), JSON.stringify(TWO_SEATS));
    return { promises: ids.map(id => ({ id, status: 'seen', evidence: [`runs/one/${id}.jpg`], screens: { host: 'the friend runs at me', friend: 'I run at the host' } })), feel: ['tagging reads well'], summary: 'played a round to the results' };
  }
  if (kind === 'read') {
    const ids = [...prompt.split('## The ledger')[1].split('## What the game promises')[0].matchAll(/^- `([^`]+)`/gm)].map(m => m[1]);
    return { schema: 'gf-reading/1', rows: ids.map(id => ({ id, mark: 'kept', why: 'the round shows it', evidence: [`runs/one/${id}.jpg`] })), findings: [], summary: 'A tag game in a yard; it kept what was asked.' };
  }
  if (kind === 'ask') return { questions: { message: 'The fake session is stuck.', questions: [] } };
  // a round of work writes only in a game folder (a talk round's folder is the kit's: never written)
  if (!existsSync(path.join(cwd, 'rules.js'))) return { summary: 'Nothing to change here.', controls: 'WASD to run, click to tag' };
  await appendFile(path.join(cwd, 'rules.js'), `\n// ${kind} round: ${prompt.split('\n')[0]}\n`);
  return { summary: 'Tag your friends around the yard.', controls: 'WASD to run, click to tag' };
}
