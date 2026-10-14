// The kind presets (kinds/*.json): each valid against the kind schema, a feel and never a rule change, its packs
// each a pack in the asset library (kinds/PACKS.md), and a contact sheet the look judge knows how to draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KIT } from '../builder/look-judge/lib/roots.mjs';

const DIR = join(KIT, 'kinds');
const kinds = readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(DIR, f), 'utf8')));
// the registry's schemas: the kit's own, or the contracts stream's while both are staged
const SCHEMAS = [join(KIT, 'registry/schemas.mjs')].find(existsSync);   // the registry's (core-spec lands it)

test('the initial eight', () => {
  assert.deepEqual(kinds.map(k => k.id).sort(), ['blocky', 'calm', 'dark', 'drawn', 'lofi', 'pixel', 'scenic', 'silly']);
});

test('every preset is valid against the kind schema', { skip: SCHEMAS ? false : 'registry/schemas.mjs not found' }, async () => {
  const { loadSchemas, SCHEMA } = await import(pathToFileURL(SCHEMAS).href);
  const { validate } = await loadSchemas();
  for (const k of kinds) assert.deepEqual(validate(SCHEMA.kind, k), [], k.id);
});

test('a kind is a feel: no rule changes, references, a runtime that proves or holds it', () => {
  for (const k of kinds) {
    assert.equal(k.changesPlay, false, k.id);
    assert.ok(k.references?.length >= 2, `${k.id}: reference games`);
    assert.ok(Object.values(k.runtimes).some(r => r.state.exists), `${k.id}: a runtime that has its look`);
    for (const [rt, r] of Object.entries(k.runtimes)) if (r.state.tested) assert.ok(r.state.evidence?.length, `${k.id} on ${rt}: tested needs evidence`);
    assert.ok(k.look[k.sheet.runtime], `${k.id}: the sheet draws on a runtime the look names`);
  }
});

test('every pack a kind names is in the asset library', () => {
  for (const k of kinds) for (const p of k.packs ?? []) assert.ok(existsSync(join(KIT, 'library/packs', p, 'pack.json')), `${k.id}: ${p} is not a pack in library/packs`);
});

test('the look judge has a runner for every kind\'s sheet', () => {
  const src = readFileSync(join(KIT, 'builder/look-judge/kind-sheet.mjs'), 'utf8');
  for (const k of kinds) {
    const where = [k.sheet.runtime, k.sheet.profile].filter(Boolean).join('/');
    assert.match(src, new RegExp(`'?${where}'?: \\{ gpu:`), `${k.id}: no runner for ${where}`);
  }
});

test('the HUD tokens make a stylesheet, and a themed kind leaves the theme alone', async () => {
  const { hudCss, hudVars } = await import('../builder/ui/kind-hud.js');
  for (const k of kinds) {
    if (k.hud.theme) { assert.equal(hudCss(k.hud), '', k.id); continue; }
    assert.ok(hudVars(k.hud)['--gf-accent'], k.id);
    assert.match(hudCss(k.hud), new RegExp(`font-family:"${k.hud.font}"`), k.id);
  }
});
