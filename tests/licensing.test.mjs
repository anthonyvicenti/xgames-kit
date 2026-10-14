// Licensing guard: LICENSE is MIT, every library file has a licence record, every CC-BY record is credited in CREDITS.md.
// Reads only files in this repository; no network, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const squash = s => s.replace(/\s+/g, ' ').trim();

// The asset library (library/packs): one licence record per pack, an asset may carry its own; the kit's default set
// (library/defaults) holds the bytes that ship, each one an asset of a public pack.
const PACKS = path.join(ROOT, 'library/packs');
const packs = fs.readdirSync(PACKS).filter(d => fs.existsSync(path.join(PACKS, d, 'pack.json'))).map(d => {
  const pack = JSON.parse(fs.readFileSync(path.join(PACKS, d, 'pack.json'), 'utf8'));
  const adir = path.join(PACKS, d, 'assets');
  const assets = fs.existsSync(adir) ? fs.readdirSync(adir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(adir, f), 'utf8'))) : [];
  return { dir: d, pack, assets };
});
const policy = JSON.parse(read('library/policy.json'));
const allowed = spdx => policy.allow.some(c => policy.classes[c].spdx?.includes(spdx) || (policy.classes[c].pattern && new RegExp(policy.classes[c].pattern).test(spdx)));

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

test('LICENSE is the standard MIT text', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'LICENSE')), 'LICENSE is missing');
  const t = squash(read('LICENSE'));
  assert.match(t, /^MIT License Copyright \(c\) \d{4} \S/, 'LICENSE must start "MIT License" and a copyright line');
  for (const phrase of [
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software',
    'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
  ]) assert.ok(t.includes(phrase), `LICENSE lacks: ${phrase}`);
  assert.equal(JSON.parse(read('package.json')).license, 'MIT', 'package.json "license" must be MIT');
});

test('every pack in the library is public, has a licence the policy allows and its LICENSE.txt; no paid maker\'s output ships', () => {
  assert.ok(packs.length >= 50, `the library's packs (${packs.length})`);
  for (const { dir, pack, assets } of packs) {
    assert.equal(pack.id, dir, `${dir}: pack.json id`);
    assert.equal(pack.visibility, 'public', `${dir}: a private pack never sits in the repository`);
    assert.ok(fs.existsSync(path.join(PACKS, dir, 'LICENSE.txt')), `${dir}: LICENSE.txt beside the pack`);
    for (const l of [pack.licence, ...assets.map(a => a.licence).filter(Boolean)]) {
      assert.ok(allowed(l.spdx), `${dir}: ${l.spdx} is outside library/policy.json`);
      assert.doesNotMatch(l.spdx, /-Paid$/, `${dir}: a paid maker's output is private`);
    }
  }
});

test('the kit\'s default set holds only bytes of public assets, each under its own hash', () => {
  const known = new Set(packs.flatMap(p => p.assets.flatMap(a => [a.sha256, ...(a.variants ?? []).map(v => v.sha256)])));
  const dir = path.join(ROOT, 'library/defaults/sha256');
  const files = walk(dir);
  assert.ok(files.length > 500, `the default set (${files.length} files)`);
  for (const f of files) {
    const h = path.basename(f);
    assert.ok(known.has(h), `library/defaults: ${h.slice(0, 12)}… is no public asset's file`);
    assert.equal(path.basename(path.dirname(f)), h.slice(0, 2), `${h.slice(0, 12)}…: filed under its first two hex digits`);
  }
});

test('CREDITS.md carries the credit line of every CC-BY asset, exactly', () => {
  const credits = read('CREDITS.md');
  const third = read('THIRD_PARTY.md');
  let n = 0;
  for (const { dir, pack, assets } of packs) for (const a of assets) {
    const l = a.licence ?? pack.licence;
    if (!/^CC-BY/.test(l.spdx ?? '')) continue;
    n++;
    assert.ok(l.credit, `${dir}/${a.id}: a CC-BY asset needs a credit line`);
    assert.ok(credits.includes(l.credit), `CREDITS.md lacks the credit line of ${dir}/${a.id}: ${l.credit}`);
    assert.ok(third.includes(l.credit), `THIRD_PARTY.md lacks the credit line of ${dir}/${a.id}: ${l.credit}`);
  }
  assert.ok(n >= 10, `expected the 10 CC-BY assets that ship, found ${n}`);
});

test('licensing docs exist and say what they must', () => {
  const doc = read('docs/LICENSING.md');
  assert.match(doc, /DRAFT/, 'the name policy must stay marked DRAFT until a lawyer reads it');
  assert.match(doc, /separate, private/i, 'LICENSING.md must say the hosted Creator Studio is a separate, private service');
  assert.doesNotMatch(read('THIRD_PARTY.md'), /has no licence yet/, 'THIRD_PARTY.md still says there is no licence');
});

test('no use of vendor names beyond plain text in the files this guard covers', () => {
  for (const f of ['CREDITS.md', 'docs/LICENSING.md']) {
    const t = read(f);
    assert.doesNotMatch(t, /!\[[^\]]*\]\([^)]*(claude|anthropic|openai|codex)[^)]*\)/i, `${f}: no vendor logos`);
  }
});
