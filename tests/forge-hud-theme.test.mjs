// A forge game's HUD theme is its kind's when the kind names a theme the HUD has, else the runtime's own; a kind whose
// HUD is colours and a font (not a whole theme) is said in create's notes, never refused (rules audit, 2026-10-14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { themeFor, THEME } from '../runtimes/forge/hud/create.mjs';
import { readKind } from '../kinds/apply.mjs';

test('the kind\'s theme, else the runtime\'s; a kind with colours only is flagged, not forced', () => {
  assert.deepEqual(themeFor(readKind('dark')), { name: 'grim', unmet: false });
  assert.deepEqual(themeFor(null), { name: THEME, unmet: false });
  assert.deepEqual(themeFor(readKind('lofi')), { name: THEME, unmet: true });
  assert.deepEqual(themeFor({ id: 'x', hud: { theme: 'no-such-theme' } }), { name: THEME, unmet: true });
});
