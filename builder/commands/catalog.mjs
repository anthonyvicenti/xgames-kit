import { catalog, catalogLines, DEFAULT_SECTIONS, SECTIONS } from '../lib/catalog.mjs';
import { guard, parse, printJson, UsageError } from '../lib/cli.mjs';

const usage = `Usage: gamesfun catalog [section…] [--all] [--json]

What the kit can build, from the registry (registry/catalog.json) and the kit's parts. Sections: ${SECTIONS.join(', ')}.
Without a section: runtimes, loops, kinds and mechanics. --all prints every section; --json gives the whole catalog.
The catalog assists: what an idea needs and no part has is built in the game (the spec's build list), never left out.`;

export default {
  name: 'catalog',
  summary: 'what the kit can build: runtimes, loops, kinds, mechanics, worlds, looks, bodies, props',
  usage,
  run: args => guard(async () => {
    const { values, positionals } = parse(args, { all: { type: 'boolean' } }, usage);
    const bad = positionals.filter(s => !SECTIONS.includes(s));
    if (bad.length) throw new UsageError(`unknown section ${bad.join(', ')}\n\n${usage}`);
    const c = await catalog();
    if (values.json) return printJson(c);
    const sections = values.all ? SECTIONS : positionals.length ? positionals : DEFAULT_SECTIONS;
    console.log(`xgames-kit: what the kit can build (registry ${String(c.registry?.inputs?.sha256 ?? '').slice(0, 12)})\n`);
    for (const line of catalogLines(c, sections)) console.log(line);
  }),
};
