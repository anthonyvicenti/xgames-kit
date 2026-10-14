#!/usr/bin/env node
// A shared mechanic's two-player fixture on forge: make the fixture's game (components/<id>/impl/forge/fixture:
// spec.json, rules.js, scenario.mjs) with the kit's create, serve it, play it with two real browsers (a host and a
// joiner joined through the game's own friends page over WebRTC), then run the scenario against both copies. Run it
// under the GPU slot script (forge draws on WebGPU, else its WebGL2 build):
//
//   node runtimes/forge/tools/fixture.mjs <id|all> [--out <dir>] [--keep]
//   (a record kept in the repository goes beside the mechanic: --out components/<id>/impl/forge/evidence/<date>, run per id
//   with --flat, which writes the record into <dir> itself instead of <dir>/<id>)
//
// The scenario (default export async ({H, J, ev, game, check, until, sleep, shot}) => void) reads each copy's
// window.__fx (the fixture's rules.js) and window.__game, and checks what BOTH screens show. Writes <out>/<id>/
// checks.json and a picture of each screen (JPEG); the game itself goes to a scratch folder and is gone after (--keep keeps it).
// Exit 0 when every check of every fixture passed. A mechanic's manifest marks forge tested only with such a record.
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMPONENTS, PARTY, BUILDER, launchForGame } from '../../../builder/tools/lib/paths.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, label) {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`); await sleep(200); }
}

/** The mechanics that have a forge fixture. */
export async function fixtures() {
  const out = [];
  for (const id of (await readdir(COMPONENTS)).sort()) if (existsSync(join(COMPONENTS, id, 'impl/forge/fixture/scenario.mjs'))) out.push(id);
  return out;
}

export async function runFixture(id, { out = null, flat = false, keep = false, log = () => {} } = {}) {
  const fx = join(COMPONENTS, id, 'impl/forge/fixture');
  if (!existsSync(join(fx, 'spec.json'))) throw new Error(`no forge fixture for ${id} (components/${id}/impl/forge/fixture/spec.json)`);
  const checks = [], errors = [], shots = [], t0 = Date.now();
  const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail) }); log(`${ok ? 'pass' : 'FAIL'}  ${id}: ${name}${detail ? `  ${detail}` : ''}`); return !!ok; };
  const dir = await mkdtemp(join(tmpdir(), `forge-fixture-${id}-`));
  const { create } = await import(pathToFileURL(join(BUILDER, 'tools/create.mjs')).href);
  const made = await create(join(fx, 'spec.json'), dir, { force: true, log: () => {} });
  if (!made.ok) throw new Error(`create failed: ${(made.problems ?? []).join('; ')}`);
  if (!made.modules?.mechanics?.includes(id)) throw new Error(`create did not pick ${id}'s forge implementation: ${(made.why ?? []).join('; ')}`);
  await cp(join(fx, 'rules.js'), join(dir, 'rules.js'));
  const { startParty } = await import(pathToFileURL(join(PARTY, 'lib.mjs')).href);
  const { launchChrome } = await import(pathToFileURL(join(BUILDER, 'qa/browser.mjs')).href);
  const srv = await startParty({ dir, port: 0 });
  const launched = await launchForGame(launchChrome, dir, { place: { runtime: 'forge' } });
  const browser = launched.browser;
  const chrome = `headless Chrome ${browser.version()}`;
  const frameOf = P => P.page.frames().find(f => f.parentFrame() === P.page.mainFrame());
  const player = async label => {
    const c = await browser.newContext({ viewport: { width: 960, height: 540 } });
    const page = await c.newPage();
    page.on('pageerror', e => errors.push({ who: label, text: e.message.slice(0, 300) }));
    page.on('console', m => { if (m.type() === 'error') errors.push({ who: label, text: m.text().slice(0, 300) }); });
    return { ctx: c, page, label };
  };
  const evDir = out ? (flat ? out : join(out, id)) : null;
  if (evDir) await mkdir(evDir, { recursive: true });
  let H = null, J = null;
  try {
    H = await player('host'); J = await player('joiner');
    const party = P => P.page.evaluate(() => window.__party?.snapshot() ?? null).catch(() => null);
    await H.page.goto(`${srv.partyUrl}?max=300`, { waitUntil: 'load' });
    await until(async () => (await party(H))?.phase === 'home', 30000, 'the host lobby');
    await H.page.fill('#gfp-name', 'Hosta'); await H.page.click('#gfp-host');
    await until(async () => { const s = await party(H); return s?.phase === 'room' && s.code; }, 30000, 'the room');
    await J.page.goto(await H.page.inputValue('#mp-invite'), { waitUntil: 'load' });
    await until(async () => (await party(J))?.phase === 'home', 30000, 'the joiner lobby');
    await J.page.fill('#gfp-name', 'Joan'); await J.page.click('#gfp-join');
    await until(async () => (await party(H))?.racers?.length === 2 && (await party(J))?.racers?.length === 2, 40000, 'both players in the room');
    await H.page.click('#mp-start');
    const ev = async (P, fn, arg) => frameOf(P).evaluate(fn, arg);
    const game = P => ev(P, () => window.__game?.snapshot?.() ?? null).catch(() => null);
    await until(async () => { const [a, b] = [await game(H), await game(J)]; return a?.net?.started && b?.net?.started && a.phase === 'playing' && b.phase === 'playing'; }, 120000, 'both games playing');
    await until(async () => (await ev(H, () => !!window.__fx)) && (await ev(J, () => !!window.__fx)), 15000, 'the fixture rules on both copies');
    check('two-players-in-one-game', true, `${launched.gpu}; the mechanic runs: host ${JSON.stringify((await game(H)).modules?.mechanics)}`);
    const shot = async (P, name) => { if (!evDir) return null; const f = `${name}.jpg`; await P.page.screenshot({ path: join(evDir, f), type: 'jpeg', quality: 82 }); shots.push(f); return f; };
    const scenario = (await import(pathToFileURL(join(fx, 'scenario.mjs')).href)).default;
    await scenario({ H, J, ev, game, check, until, sleep, shot });
    await shot(H, 'host-end'); await shot(J, 'joiner-end');
    const bad = errors.filter(e => !/favicon|net::ERR|GPU stall|WebGPU/i.test(e.text));
    check('no-page-errors', bad.length === 0, bad.slice(0, 3).map(e => `${e.who}: ${e.text}`).join(' | '));
  } catch (e) {
    check('fixture-ran', false, e.message);
    log(`  errors: ${JSON.stringify(errors.slice(0, 5))}`);
  } finally {
    for (const P of [H, J]) await P?.ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    await new Promise(r => srv.server?.close(() => r()) ?? r());
    if (!keep) await rm(dir, { recursive: true, force: true }).catch(() => {}); else log(`kept ${dir}`);
  }
  const rec = { schema: 'xgames-forge-fixture/1', mechanic: id, runtime: 'forge', at: new Date().toISOString(), renderer: launched.gpu, browser: chrome, seconds: Math.round((Date.now() - t0) / 1000), pass: checks.length > 1 && checks.every(c => c.ok), checks, shots, errors: errors.slice(0, 20) };
  if (evDir) await writeFile(join(evDir, 'checks.json'), JSON.stringify(rec, null, 1));
  return rec;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const which = a.find((x, i) => !x.startsWith('--') && !['--out'].includes(a[i - 1]));
  if (!which) { console.error('usage: fixture.mjs <id|all> [--out <evidence-dir>] [--keep]'); process.exit(2); }
  const ids = which === 'all' ? await fixtures() : [which];
  let ok = true;
  for (const id of ids) { const r = await runFixture(id, { out: opt('--out') ? resolve(opt('--out')) : null, flat: a.includes('--flat'), keep: a.includes('--keep'), log: m => console.log(m) }); ok &&= r.pass; console.log(`${r.pass ? 'PASS' : 'FAIL'} ${id}: ${r.checks.filter(c => c.ok).length}/${r.checks.length} checks, ${r.seconds} s`); }
  process.exit(ok ? 0 : 1);
}
