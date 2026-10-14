import { guard, parse, printJson } from '../lib/cli.mjs';
import { createGame } from '../lib/create.mjs';

const usage = `Usage: gamesfun create <dir> (--from <example> | --spec <spec.json>) [--force] [--json]

Make a game: a runnable, multiplayer three.js project on the gf-three kit, with every visible thing a slot.
  --from <example>   start from a complete example game (npx gamesfun examples lists them)
  --spec <file>      start from your own locked game spec (AGENTS.md: pitch, then lock a spec); rules.js is a stub
  --force            create into a folder that is not empty, or reset a game to the example (replaces rules.js)

Run it again on an existing game to refresh the kit copies; your rules.js and config are kept.`;

export default {
  name: 'create',
  summary: 'make a game from an example or a game spec',
  usage,
  run: args => guard(async () => {
    const { values, positionals } = parse(args, { from: { type: 'string' }, spec: { type: 'string' }, force: { type: 'boolean' } }, usage);
    const r = await createGame(positionals[0], { from: values.from, spec: values.spec, force: values.force });
    if (values.json) return printJson(r);
    for (const n of r.notes) console.log(`note     ${n}`);
    for (const w of r.warnings) console.log(`warning  ${w}`);
    for (const k of r.kept) console.log(`kept     ${k} (yours)`);
    for (const a of r.applied) console.log(`example  ${a}`);
    for (const g of r.guide) console.log(`guide    ${g}${g === 'AGENTS.md' ? ' (what your agent reads first in this game)' : ''}`);
    if (r.web3) console.log(`web3     gf/web3/ (gf-web3 ${r.web3.version}: items, shop, loot boxes, token; skill gamesfun-web3)${r.web3.stub ? ' and gamesfun.json' : ''}`);
    console.log(`create: OK ${r.shown}: "${r.title}"${r.example ? ` from example ${r.example}` : ''} · ${r.slots} slots (${r.main} main) · ${r.wrote} files written`);
    console.log(`\nNext:\n  npx gamesfun dev ${r.shown}              play it in the studio (slots, verify, friends)\n  npx gamesfun verify ${r.shown} --quick   the checks a game must pass\nThen open this folder in your agent (Claude Code, Codex, Cursor, …) and say what you want.`);
  }),
};
