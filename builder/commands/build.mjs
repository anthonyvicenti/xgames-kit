import path from 'node:path';
import { guard, parse, printJson, UsageError } from '../lib/cli.mjs';
import { GAMES } from '../lib/paths.mjs';

const usage = `Usage: gamesfun build --prompt "<the idea>" [--game games/<name>] [--model opus] [--strong <model>]
                      [--playtest-model sonnet] [--reader-model <model>] [--images a.png,b.png] [--answers <file.json | hook.mjs>] [--quick]
                      [--permissions ask-none | bypass] [--json]

The whole creation loop with no session: the ledger, the foundation, the pitch, the spec, create, the build round, the
six gates, the play-test of every promise, repairs under the stop rule and the ladder, the second reader, and the delivery. Every round is
one headless Claude Code session with your own login (or ANTHROPIC_API_KEY); the kit holds no credential. Cost never
stops a build; Ctrl+C does.

  --prompt          the person's idea, in their words (required)
  --game            the game folder (default games/<a name from the idea>)
  --model           the model every round starts on (default opus)
  --strong          the model the ladder climbs to (default: the same model at its highest effort)
  --playtest-model  the black-box play-tester's model (default sonnet)
  --reader-model    the second reader's model: it sees only the idea, the promises and the screenshots, and marks
                    every line of what was asked kept, partly, lost or cannot-tell (default: --model)
  --images          pictures the person gave, as references (comma-separated paths)
  --answers         the person's moves when the loop asks: a JSON file {cards, words, maxAsks, migration} or a module
                    exporting answer({about, pitch, questions, migration, asked}); default: card 1 with every
                    question's default, a yes to a migration, and the game as it is after two asks
  --quick           the loop's verify runs --quick (no contact sheet); a delivery is normally verified in full
  --permissions     ask-none (default: each round may use only the tools its kind names, anything else is denied) or
                    bypass (every tool, no checks: only in a sandbox)

Prints the run's result (delivered, the questions and answers, the ladder, models, tokens, minutes, money) and writes
<game>/.gf-loop/headless/record.json with every round's transcript beside it.`;

export const slugOf = idea => String(idea).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').split(/\s+/).filter(w => w.length > 2 && !['the', 'and', 'with', 'where', 'game', 'for', 'that', 'make', 'want'].includes(w)).slice(0, 4).join('-') || 'new-game';

export default {
  name: 'build',
  summary: 'make a game from an idea with no session: the whole creation loop, headless',
  usage,
  run: args => guard(async () => {
    const { values } = parse(args, { prompt: { type: 'string' }, game: { type: 'string' }, model: { type: 'string' }, strong: { type: 'string' }, 'playtest-model': { type: 'string' }, 'reader-model': { type: 'string' }, images: { type: 'string' }, answers: { type: 'string' }, quick: { type: 'boolean' }, permissions: { type: 'string' } }, usage);
    if (!values.prompt?.trim()) throw new UsageError(`build needs --prompt\n\n${usage}`);
    if (values.permissions && !['ask-none', 'bypass'].includes(values.permissions)) throw new UsageError(`--permissions is ask-none or bypass\n\n${usage}`);
    const { buildHeadless } = await import('../loop/headless.mjs');
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort('stopped by the person'));
    const r = await buildHeadless({
      prompt: values.prompt, game: path.resolve(values.game ?? path.join(GAMES, slugOf(values.prompt))),
      model: values.model ?? 'opus', strong: values.strong ?? null, playtestModel: values['playtest-model'] ?? 'sonnet', readerModel: values['reader-model'] ?? null,
      images: (values.images ?? '').split(',').map(s => s.trim()).filter(Boolean), answers: values.answers ?? null, quick: !!values.quick,
      permission: values.permissions === 'bypass' ? 'bypassPermissions' : 'dontAsk', signal: ac.signal,
    });
    if (values.json) printJson(r);
    else {
      console.log(`${r.delivered ? r.outcome.outcome : `not delivered (${r.stopped})`}: ${r.game?.dir ?? ''}`);
      if (r.outcome?.ledger) for (const l of r.outcome.ledger.rows) console.log(`  ${l.status.padEnd(9)} ${l.what}${l.reader ? ` (second reader: ${l.reader.mark})` : ''}`);
      if (r.outcome?.reader?.words) console.log(r.outcome.reader.words);
      if (r.outcome?.summary) console.log(r.outcome.summary);
      if (r.lastWords && r.lastWords !== r.outcome?.summary) console.log(r.lastWords);
      console.log(`${r.minutes} min, $${r.usd}, models ${r.models.join(', ')}; record: ${r.record}`);
    }
    return r.delivered ? 0 : 1;
  }),
};
