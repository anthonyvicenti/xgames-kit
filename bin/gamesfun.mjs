#!/usr/bin/env node
// The `gamesfun` command. Each subcommand is a module in ../commands/<name>.mjs that exports
// `default { name, summary, usage, run(args) }`; see docs/ARCHITECTURE.md ("Seams"). A command module that fails to
// load is reported and skipped, so one broken command never takes the others down.
import { readdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const COMMANDS_DIR = fileURLToPath(new URL('../builder/commands/', import.meta.url));

async function loadCommands() {
  const files = (await readdir(COMMANDS_DIR)).filter((f) => f.endsWith('.mjs')).sort();
  const commands = new Map(), broken = new Map();
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(path.join(COMMANDS_DIR, file)).href);
      if (mod.default?.name && typeof mod.default.run === 'function') commands.set(mod.default.name, mod.default);
      else broken.set(file.slice(0, -4), 'does not export default { name, summary, usage, run }');
    } catch (e) {
      broken.set(file.slice(0, -4), e.message.split('\n')[0]);
    }
  }
  return { commands, broken };
}

function help({ commands, broken }) {
  const lines = ['Usage: gamesfun <command> [options]', '', 'Commands:'];
  for (const c of commands.values()) lines.push(`  ${c.name.padEnd(10)} ${c.summary}`);
  for (const [name, why] of broken) lines.push(`  ${name.padEnd(10)} (did not load: ${why})`);
  lines.push('', 'Run `gamesfun <command> --help` for a command\'s options. Start here: AGENTS.md, README.md.');
  return lines.join('\n');
}

const loaded = await loadCommands();
const [name, ...args] = process.argv.slice(2);
if (!name || name === '--help' || name === '-h' || name === 'help') {
  console.log(help(loaded));
  process.exit(name ? 0 : 1);
}
if (name === '--version' || name === '-v') {
  const { readFile } = await import('node:fs/promises');
  console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  process.exit(0);
}
const command = loaded.commands.get(name);
if (!command) {
  console.error(loaded.broken.has(name) ? `The ${name} command did not load: ${loaded.broken.get(name)}` : `Unknown command "${name}".\n\n${help(loaded)}`);
  process.exit(1);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(command.usage ?? command.summary);
  process.exit(0);
}
const { startUpdateCheck } = await import('../builder/lib/update.mjs');
// The daily "is there a newer kit" check starts in the background and never delays the command; its note prints after
// commands that talk to a person (not --json output, not the long-running dev server, not update itself).
const notice = name === 'update' ? null : await startUpdateCheck().catch(() => null);
process.exitCode = (await command.run(args)) ?? 0;
if (notice && !args.includes('--json') && !['update', 'dev'].includes(name)) console.error(notice);
