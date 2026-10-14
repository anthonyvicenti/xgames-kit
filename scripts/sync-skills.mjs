#!/usr/bin/env node
// Mirror skills/ (the source of truth) byte for byte into each agent's skills folder:
//   .claude/skills/   Claude Code
//   .agents/skills/   Codex and other agents that read the shared .agents/ folder
//
//   node scripts/sync-skills.mjs           write the mirrors (and remove anything in them that skills/ no longer has)
//   node scripts/sync-skills.mjs --check   change nothing; exit 1 when a mirror has drifted (tests/skills.test.mjs)
//
// Edit skills/<name>/SKILL.md, never a mirror: the next sync overwrites it.
//
// Two files are generated first, from the build loop's tool list and its play-test prompt (scripts/gen-loop.mjs):
// skills/build-loop/SKILL.md, plugin/agents/playtester.md and plugin/agents/reader.md. --check fails when one differs from what the tools
// and the prompt give now, so a tool cannot change without its skill.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../builder/lib/main.mjs';
import { generatedDrift } from './gen-loop.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const SOURCE = path.join(ROOT, 'skills');
export const MIRRORS = [path.join(ROOT, '.claude', 'skills'), path.join(ROOT, '.agents', 'skills')];

async function walk(dir, base = dir, out = []) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

/** Compare one mirror with skills/. → { missing, changed, extra } (paths relative to the skills folder) */
export async function diffMirror(mirror, source = SOURCE) {
  const want = await walk(source), have = new Set(await walk(mirror));
  const missing = [], changed = [];
  for (const rel of want) {
    if (!have.has(rel)) { missing.push(rel); continue; }
    have.delete(rel);
    const [a, b] = await Promise.all([readFile(path.join(source, rel)), readFile(path.join(mirror, rel))]);
    if (!a.equals(b)) changed.push(rel);
  }
  return { missing, changed, extra: [...have].sort() };
}

/** Every skill folder must hold a SKILL.md whose front matter names it. → problems[] */
export async function skillProblems(source = SOURCE) {
  const problems = [];
  let dirs = [];
  try { dirs = (await readdir(source, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); } catch { return ['skills/ is missing']; }
  for (const d of dirs) {
    let text;
    try { text = await readFile(path.join(source, d, 'SKILL.md'), 'utf8'); } catch { problems.push(`skills/${d}: no SKILL.md`); continue; }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    if (name !== d) problems.push(`skills/${d}/SKILL.md: front matter name is "${name ?? ''}", must be "${d}"`);
    if (!description) problems.push(`skills/${d}/SKILL.md: front matter needs a description`);
    else if (description.length > 1024) problems.push(`skills/${d}/SKILL.md: description over 1024 characters`);
  }
  return problems;
}

async function main() {
  const check = process.argv.includes('--check');
  let drift = 0;
  for (const g of await generatedDrift()) {
    if (g.same) continue;
    if (check) { drift++; console.error(`${g.file}: differs from what the build loop's tools and prompts give (run node scripts/sync-skills.mjs)`); continue; }
    const to = path.join(ROOT, ...g.file.split('/'));
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, g.text);
    console.log(`${g.file}: generated`);
  }
  const problems = await skillProblems();
  for (const p of problems) console.error(`problem: ${p}`);
  for (const mirror of MIRRORS) {
    const d = await diffMirror(mirror);
    const n = d.missing.length + d.changed.length + d.extra.length;
    drift += n;
    const label = path.relative(ROOT, mirror).split(path.sep).join('/');
    if (check) { if (n) console.error(`${label}: ${d.missing.length} missing, ${d.changed.length} changed, ${d.extra.length} extra (run node scripts/sync-skills.mjs)`); continue; }
    for (const rel of d.extra) await rm(path.join(mirror, ...rel.split('/')));
    for (const rel of [...d.missing, ...d.changed]) {
      const to = path.join(mirror, ...rel.split('/'));
      await mkdir(path.dirname(to), { recursive: true });
      await writeFile(to, await readFile(path.join(SOURCE, ...rel.split('/'))));
    }
    // folders left empty by removed skills
    for (const e of await readdir(mirror, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && !(await walk(path.join(mirror, e.name))).length) await rm(path.join(mirror, e.name), { recursive: true });
    }
    console.log(`${label}: ${n ? `${d.missing.length + d.changed.length} written, ${d.extra.length} removed` : 'in sync'}`);
  }
  if (check) { if (!drift && !problems.length) console.log('skills: mirrors in sync'); return drift || problems.length ? 1 : 0; }
  return problems.length ? 1 : 0;
}

if (isMain(import.meta)) process.exitCode = await main();
