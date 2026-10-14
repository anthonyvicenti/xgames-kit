import { guard, parse, printJson } from '../lib/cli.mjs';
import { listExamples } from '../lib/examples.mjs';

const usage = `Usage: gamesfun examples [--json]

Complete games to start from: npx gamesfun create games/<name> --from <example>`;

export default {
  name: 'examples',
  summary: 'list the example games create --from can start from',
  usage,
  run: args => guard(async () => {
    const { values } = parse(args, {}, usage);
    const all = await listExamples();
    if (values.json) return printJson(all.map(({ dir, ...e }) => e));
    if (!all.length) { console.log('No examples in examples/.'); return; }
    for (const e of all) {
      console.log(`${e.id.padEnd(16)} ${e.title}: ${e.summary}`);
      console.log(`${' '.repeat(17)}${e.profile ? `${e.runtime}/${e.profile}` : e.runtime} · ${e.loop} · ${e.kind}${e.mechanics.length ? ` · ${e.mechanics.join(', ')}` : ''}${e.world ? ` · ${e.world}` : ''}${e.verified ? ` · verify ${e.verified.result}` : ''}`);
    }
    console.log(`\nnpx gamesfun create games/my-game --from ${all[0].id}`);
  }),
};
