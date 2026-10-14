// The studio layout test's world (tests/studio-layout.test.mjs, tests/studio-layout-shots.mjs): two games under a
// temporary games folder with the loop library's own states (tests/stubs/loop-states.mjs), a dev server on them, and
// what a view measures.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createGame } from '../../builder/lib/create.mjs';
import { startDevServer } from '../../builder/server/index.mjs';
import { tempDir } from '../helpers.mjs';
import { loopStates, writeLoopState } from './loop-states.mjs';

export const SIZES = [['laptop', 1280, 800], ['4k', 3840, 2160]];

/** The two games, the dev server and a way to open one. → {base, open(name), close()} */
export async function layoutWorld() {
  const t = await tempDir('gf-studio-layout-');
  const games = path.join(t.dir, 'games');
  const { making, delivered } = await loopStates();
  await mkdir(path.join(games, 'gate-making'), { recursive: true });
  await writeLoopState(path.join(games, 'gate-making'), making);
  await createGame(path.join(games, 'gate-delivered'), { from: 'soak-squad' });
  await writeLoopState(path.join(games, 'gate-delivered'), delivered);
  const srv = await startDevServer({ gamesRoot: games, port: 0, log: () => {}, watch: false });
  const base = `http://127.0.0.1:${srv.port}`;
  const open = name => fetch(`${base}/api/studio/project`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ name }) }).then(r => { if (!r.ok) throw new Error(`open ${name}: ${r.status}`); });
  return { base, open, states: { making, delivered }, close: async () => { await srv.close(); await t.cleanup(); } };
}

/** What a view measures: sideways scroll, the panel's place and size, every section that overflows its box. */
export const measure = page => page.evaluate(() => {
  const panel = document.querySelector('[data-part=loop-panel]');
  const r = panel?.getBoundingClientRect();
  return {
    sideways: document.documentElement.scrollWidth > innerWidth + 1,
    width: innerWidth,
    stages: document.querySelectorAll('[data-part=stages] li').length,
    current: document.querySelector('[data-part=stages] li[aria-current=step]')?.textContent ?? null,
    panelIn: panel ? (panel.closest('#product-empty') ? 'product' : panel.closest('#chat') ? 'chat' : 'elsewhere') : null,
    panelBox: r ? { left: r.left, right: r.right, width: r.width } : null,
    sections: [...document.querySelectorAll('details.loop-sec')].map(d => ({ id: d.dataset.sec, open: d.open, overflow: d.scrollWidth > d.clientWidth + 1 })),
    lines: document.querySelectorAll('ul.ledger-lines li').length,
    text: panel?.innerText ?? '',
  };
});

