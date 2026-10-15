// The studio page shows the creation loop, in real Chrome on a real dev server, at a laptop's 1280x800 and the
// creator's 3840x2160: while the game is being made (the cards with the person, an economy offered) the stages, the
// ledger and the foundation fill the product side; once delivered the conversation carries the stages and the loop
// panel (the ledger with each line's home, status and the second reader's mark, the foundation, the promises, the
// ladder, the second reader's findings, the economy). Nothing scrolls sideways and no section overflows its box.
// The states are the loop library's own (tests/stubs/loop-states.mjs). Pictures for a person: tests/studio-layout-shots.mjs.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChrome } from '../builder/lib/chrome.mjs';
import { layoutWorld, measure, SIZES } from './stubs/studio-layout.mjs';

let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch {}
describe('the studio page shows the creation loop', { skip: !chromium && 'playwright-core is not installed' }, () => {
  let world, browser;
  const errors = [];
  before(async () => {
    const found = findChrome();
    for (const o of [found ? { executablePath: found.path } : null, {}].filter(Boolean)) { try { browser = await chromium.launch({ headless: true, ...o }); break; } catch {} }
    world = await layoutWorld();
  });
  after(async () => { await browser?.close(); await world?.close(); });
  const page = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    return p;
  };

  for (const [size, w, h] of SIZES) {
    test(`${size} (${w}x${h}): a game being made: the stages, the ledger and the foundation on the product side`, async t => {
      if (!browser) return t.skip('no Chrome');
      await world.open('gate-making');
      const p = await page(w, h);
      await p.goto(`${world.base}/studio/`);
      await p.waitForSelector('#product-empty [data-part=loop-panel]', { timeout: 20000 });
      const m = await measure(p);
      assert.equal(m.sideways, false, `the page scrolls sideways at ${w}`);
      assert.equal(m.stages, 11);
      assert.equal(m.current, 'Pitch');
      assert.equal(m.panelIn, 'product');
      assert.deepEqual(m.sections.filter(s => s.open).map(s => s.id), ['ledger', 'foundation']);
      assert.ok(m.sections.every(s => !s.overflow), JSON.stringify(m.sections));
      assert.equal(m.lines, 10);
      assert.match(m.text, /“a grappling hook to get onto the walls”/);
      assert.match(m.text, /this game builds it/);
      assert.match(m.text, /Runs on\s+forge/);
      assert.ok(m.panelBox.width >= 400 && m.panelBox.right <= w, JSON.stringify(m.panelBox));
      // the cards wait in the conversation, with the economy offered and its question
      const cards = await p.locator('[data-part=pitch]').innerText();
      assert.match(cards, /Gate of Ash/);
      assert.match(cards, /An economy is offered: Each player puts 0\.01 SOL/);
      assert.match(cards, /No economy, just the game/);
      await p.context().close();
    });

    test(`${size} (${w}x${h}): a delivered game: the conversation carries the ledger with the reader's marks, the foundation, the promises, the ladder, the second reader and the economy`, async t => {
      if (!browser) return t.skip('no Chrome');
      await world.open('gate-delivered');
      const p = await page(w, h);
      await p.goto(`${world.base}/studio/`);
      await p.waitForSelector('#chat [data-part=loop-panel]', { timeout: 30000 });
      assert.ok((await measure(p)).sections.every(s => !s.open), 'a delivered game starts folded: the outcome and the reader\'s note first');
      for (const id of ['ledger', 'foundation', 'promises', 'ladder', 'reader', 'economy']) await p.click(`details.loop-sec[data-sec=${id}] > summary`);
      await p.waitForFunction(() => [...document.querySelectorAll('details.loop-sec')].every(d => d.open));
      const m = await measure(p);
      assert.equal(m.sideways, false);
      assert.equal(m.stages, 11);
      assert.equal(m.current, 'Deliver');
      assert.equal(m.panelIn, 'chat');
      assert.deepEqual(m.sections.map(s => s.id), ['ledger', 'foundation', 'promises', 'ladder', 'reader', 'economy']);
      assert.ok(m.sections.every(s => !s.overflow), JSON.stringify(m.sections));
      assert.match(m.text, /10 proven · 0 failed · 0 untested/);
      assert.match(m.text, /reader: partly/);
      assert.doesNotMatch(m.text, /reader: kept/, 'a kept line carries no reader chip; the reader section counts them');
      assert.match(await p.locator('[data-part=reader-says]').innerText(), /did not find everything kept.*little weight on screen.*doorway/);
      assert.match(m.text, /9 kept · 1 partly · 0 lost · 0 can't tell/);
      assert.match(m.text, /reads as a doorway more than a gate/);
      assert.match(m.text, /climbed: model/);
      assert.match(m.text, /Its economy waits for your approval/);
      assert.equal(await p.locator('ol.rungs li[data-rung=model].climbed').count(), 1);
      assert.equal(await p.locator('details[data-sec=economy] a[href*="#economy"]').count(), 1);
      // the toggles hold across the conversation's repaints (it polls every two seconds)
      await p.waitForTimeout(2600);
      assert.ok((await measure(p)).sections.every(s => s.open));
      await p.context().close();
    });
  }

  test('no page error on any view', () => { assert.deepEqual(errors, []); });
});
