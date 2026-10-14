#!/usr/bin/env node
// gf-forge's contact sheets and perf on the real GPU (track R; verify check 9 on a forge game runs the game mode).
//
//   node runtimes/forge/lookdev/capture.mjs lookdev [--out <dir>] [--presets a,b,c] [--shots hero,fight,…] [--wasm <dir>] [--quick]
//        the lookdev arena per preset (lookdev/scene.js): hero, fight (a shot's flash frozen on screen), close, wide,
//        moon, bodies, and the hero with the retro pass off; the PLAN §5 bench (20 skinned bodies, 30 bursts, 8 lights)
//        at 1920×1080 on the high tier, and on the low tier at 1280×720 under a 4× CPU throttle
//   node runtimes/forge/lookdev/capture.mjs <game> --out <dir> [--query "seed=7&gf-autoplay=1&gf-ui=0"] [--quick]
//        a forge game: the player's first look (hero), ?gf-show=world (wide) and ?gf-show=look at 1920×1080 and 390×844,
//        then perf as tools/measure.mjs plays it (1920×1080 high; 1280×720 low under a 4× CPU throttle)
//   --set exposure=0.9,tone/auto=0   (wave 2) look values over the game's config/look.json (as Studio's overrides
//        patch them: JSON pointers into the file) or over the lookdev's preset; --no-perf leaves the perf runs out
//
// Every shot gets its luma (mean, median, 99th percentile, the share over 200) and its eight dominant colours, against
// research/rust-engine/feel-targets.md "Look targets" (mean 34–48, median 28–44, p99 142–213, about 1% over 200).
// Writes <out>/capture.json, <out>/sheet-*.jpg, <out>/index.html and full-size frames in <out>/raw/
// (<target>--<shot>--<W>x<H>.png). Exit 0 on pass: no page errors, coverage 100% where the page reports it, 58+ fps on
// the high tier (rAF is capped at 60), 30+ fps on the low tier under the throttle. Never judged on a software GPU.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startLookdev } from './serve.mjs';
import { LOOK_TARGET, lumaOf as measureShot, detailOf, sheetOf as sheet, verdictOf as lookVerdict } from './measure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const { launchChrome } = await import(join(REPO, 'builder/qa/browser.mjs'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stats = a => { const s = [...a].sort((x, y) => x - y); const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? null; const r = v => Math.round(v * 100) / 100; return { n: s.length, median: r(q(0.5)), p95: r(q(0.95)), max: r(s.at(-1) ?? 0) }; };
// luma, the pixel-to-pixel detail measure and contact sheets: lookdev/measure.mjs
export { LOOK_TARGET };

/** rAF frame rate and the frame callback's CPU time over `ms`, from timestamps the page records. */
async function perfOf(page, ms, getter) {
  await page.evaluate(getter => { const f = eval(getter); f.cost.length = 0; f.at.length = 0; }, getter);
  await sleep(ms);
  const f = await page.evaluate(getter => { const x = eval(getter); return { cost: x.cost.slice(), at: x.at.slice() }; }, getter);
  const gaps = f.at.slice(1).map((t, i) => t - f.at[i]);
  const seconds = (f.at.at(-1) - f.at[0]) / 1000;
  return { fps: Math.round(((f.at.length - 1) / Math.max(seconds, 1e-3)) * 10) / 10, frameGapMs: stats(gaps), loopCpuMs: stats(f.cost) };
}

// every rAF callback timed (a game's loop runs inside one), as tools/measure.mjs
const TIMER = () => {
  const raf = window.requestAnimationFrame.bind(window), cost = [], at = [];
  window.__frames = { cost, at };
  window.requestAnimationFrame = cb => raf(t => { const s = performance.now(); try { cb(t); } finally { cost.push(performance.now() - s); at.push(s); if (at.length > 4000) { at.splice(0, 2000); cost.splice(0, 2000); } } });
};

export const ROLES = ['enemy.skeleton.chaser', 'enemy.skeleton.ranged', 'enemy.skeleton.shield', 'enemy.skeleton.brute', 'enemy.skeleton.boss', 'player.coop', 'enemy.skeleton.chaser.kaykit', 'player.coop.knight'];
export async function captureLookdev({ out, presets = ['moonlit-ruins', 'ember-crypt', 'ash-storm'], shots = ['hero', 'fight', 'close', 'wide', 'moon', 'bodies', 'hero-retro-off'], roles = ROLES, wasm = null, quick = false, log = console.log, perf = true, set = [] } = {}) {
  const setQuery = set.length ? `&set=${set.map(p => encodeURIComponent(p.replace('=', ':').replace(/\//g, '.'))).join(',')}` : '';
  mkdirSync(join(out, 'raw'), { recursive: true });
  const srv = await startLookdev({ port: 0, wasm });
  const browser = await launchChrome({ gpu: 'webgpu' });
  const record = { tool: 'runtimes/forge/lookdev/capture.mjs', target: 'lookdev', started: new Date().toISOString(), chrome: browser.version(), shots: [], perf: [], problems: [], lookTarget: LOOK_TARGET };
  try { record.commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).toString().trim(); } catch {}
  const open = async (query, [w, h], { timer = false, throttle = 1 } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    if (timer) await page.addInitScript(TIMER);
    if (throttle > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await page.goto(`${srv.url}?${query}&hud=0`, { waitUntil: 'load' });
    const t0 = Date.now();
    for (;;) { const s = await page.evaluate(() => ({ ready: window.__lookdev?.ready, error: window.__lookdev?.error })).catch(() => ({})); if (s.ready || s.error) { if (s.error) errors.push(s.error); break; } if (Date.now() - t0 > 90000) { errors.push('not ready in 90 s'); break; } await sleep(200); }
    return { ctx, page, errors };
  };
  try {
    const size = [1280, 720];
    for (const preset of presets) {
      const rows = [];
      for (const shot of shots) {
        const retroOff = shot.endsWith('-retro-off');
        const s = retroOff ? shot.replace('-retro-off', '') : shot;
        const query = `preset=${preset}&shot=${s}${retroOff ? '&retro=0' : ''}${s === 'fight' ? '' : '&fx=0'}${setQuery}`;
        const P = await open(query, size);
        await sleep(quick ? 1200 : 2200);
        if (s === 'fight') {
          // a shot fired, then the frame two frames later held still (the muzzle flash, smoke, sparks and the hit's flash)
          await P.page.evaluate(() => { window.__lookdev.fire(); });
          await sleep(34);
        }
        const png = await P.page.screenshot({ type: 'png' });
        const file = join(out, 'raw', `lookdev-${preset}--${shot}--${size[0]}x${size[1]}.png`);
        writeFileSync(file, png);
        const st = await P.page.evaluate(() => window.__lookdev.stats()).catch(() => null);
        const m = await measureShot(P.page, png);
        // the pixel-to-pixel detail of the ground in the lower right of the frame (lookdev/measure.mjs)
        const detail = await detailOf(P.page, png, [Math.round(size[0] * 0.5), Math.round(size[1] * 0.667), Math.round(size[0] * 0.86), Math.round(size[1] * 0.972)]);
        const row = { preset, shot, query, file: relative(out, file), stats: st, luma: m, inTarget: lookVerdict(m), detail, errors: P.errors.slice(0, 3) };
        record.shots.push(row); rows.push({ file, caption: `${shot} · luma ${m.mean}/${m.median}/${m.p99} · detail ${detail.across} · ${st?.draws ?? '?'} draws · ${st?.particles ?? '?'} particles` });
        if (P.errors.length) record.problems.push(`${preset} ${shot}: ${P.errors.slice(0, 2).join(' | ')}`);
        log(`shot ${preset} ${shot}: luma mean ${m.mean} median ${m.median} p99 ${m.p99} >200 ${(m.over200 * 100).toFixed(1)}% · ${m.palette.slice(0, 4).map(p => p.hex).join(' ')}`);
        await P.ctx.close();
      }
      await sheet(browser, rows, `gf-forge lookdev · ${preset} · ${record.chrome} · WebGPU · ${record.started.slice(0, 10)}`, join(out, `sheet-${preset}.jpg`));
    }
    // every body role in its catalog poses (as the library's three.js bodies sheets show them), drawn by forge
    if (roles.length) {
      const rows = [];
      for (const role of roles) {
        const P = await open(`preset=moonlit-ruins&shot=poses&role=${role}&fx=0`, [1280, 720]);
        await sleep(900);
        const png = await P.page.screenshot({ type: 'png' });
        const file = join(out, 'raw', `lookdev-poses--${role}--1280x720.png`); writeFileSync(file, png);
        const posed = await P.page.evaluate(() => window.__lookdev.posed()).catch(() => null);
        record.shots.push({ preset: 'moonlit-ruins', shot: `poses ${role}`, file: relative(out, file), posed, luma: await measureShot(P.page, png), inTarget: {}, errors: P.errors.slice(0, 3) });
        if (P.errors.length) record.problems.push(`poses ${role}: ${P.errors.slice(0, 2).join(' | ')}`);
        rows.push({ file, caption: `${role}: ${(posed ?? []).join(' · ')}` });
        log(`poses ${role}: ${(posed ?? []).join(', ')}`);
        await P.ctx.close();
      }
      await sheet(browser, rows, `gf-forge bodies in their catalog poses (forge-anim + GPU skinning) · ${record.chrome}`, join(out, 'sheet-bodies.jpg'), 2);
    }
    if (perf) {
      // (wave 2: each again with 400 loose pieces at rest in view, what kills leave behind)
      const benches = [{ id: 'bench-high-1080p', query: 'preset=moonlit-ruins&shot=bench&tier=high', size: [1920, 1080], throttle: 1 }, { id: 'bench-low-4x-cpu', query: 'preset=moonlit-ruins&shot=bench&tier=low', size: [1280, 720], throttle: 4 },
        { id: 'bench-high-1080p-400-pieces', query: 'preset=moonlit-ruins&shot=bench&tier=high&pieces=400', size: [1920, 1080], throttle: 1 }, { id: 'bench-low-4x-cpu-400-pieces', query: 'preset=moonlit-ruins&shot=bench&tier=low&pieces=400', size: [1280, 720], throttle: 4 }];
      for (const run of benches.slice(0, quick ? 1 : 4)) {
        const P = await open(run.query, run.size, { timer: true, throttle: run.throttle });
        await sleep(1500);
        const p = await perfOf(P.page, quick ? 3000 : 6000, 'window.__frames');
        const st = await P.page.evaluate(() => window.__lookdev.stats());
        const png = await P.page.screenshot({ type: 'png' });
        const file = join(out, 'raw', `lookdev-bench--${run.id}--${run.size[0]}x${run.size[1]}.png`); writeFileSync(file, png);
        const row = { id: run.id, viewport: run.size, cpuThrottle: run.throttle, ...p, stats: st, file: relative(out, file), errors: P.errors.slice(0, 3) };
        record.perf.push(row);
        log(`perf ${run.id}: ${p.fps} fps, gap p95 ${p.frameGapMs.p95} ms, loop cpu median ${p.loopCpuMs.median} ms p95 ${p.loopCpuMs.p95} ms · ${st.actors} bodies, ${st.particles} particles, ${st.lights} lights, ${st.draws} draws, ${st.pieces ?? 0} pieces, ${st.casters ?? '?'} casters, ${st.fireFaces ?? 0} fire faces`);
        if (P.errors.length) record.problems.push(`${run.id}: ${P.errors.slice(0, 2).join(' | ')}`);
        await P.ctx.close();
      }
    }
  } finally { await browser.close(); await srv.close(); }
  return finish(record, out, log);
}

export async function captureGame(dir, { out, query = 'seed=7&gf-autoplay=1&gf-ui=0', quick = false, log = console.log, set = [], perf = true } = {}) {
  // look values over the game's own, as Studio's overrides give them (gf/gf-assets.js: pointer patches before boot)
  const patches = set.map(p => { const at = p.indexOf('='), raw = p.slice(at + 1); return { file: 'config/look.json', pointer: '/' + p.slice(0, at).replace(/\./g, '/'), value: raw === 'true' ? true : raw === 'false' ? false : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw }; });
  dir = resolve(dir);
  mkdirSync(join(out, 'raw'), { recursive: true });
  const { startParty } = await import(join(REPO, 'builder/multiplayer/party/lib.mjs'));
  const srv = await startParty({ dir, port: 0 });
  const browser = await launchChrome({ gpu: 'webgpu' });
  const name = basename(dir);
  const record = { tool: 'runtimes/forge/lookdev/capture.mjs', target: relative(REPO, dir), engine: 'forge', started: new Date().toISOString(), chrome: browser.version(), shots: [], perf: [], coverage: [], problems: [], lookTarget: LOOK_TARGET, ...(patches.length ? { lookOverrides: patches } : {}) };
  const open = async (q, [w, h], { timer = false, throttle = 1 } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    if (timer) await page.addInitScript(TIMER);
    if (patches.length) await page.addInitScript(p => { globalThis.__GF_ASSET_OVERRIDES = { ...(globalThis.__GF_ASSET_OVERRIDES ?? {}), patches: p }; }, patches);
    if (throttle > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await page.goto(`${srv.url}${q}`, { waitUntil: 'load' });
    return { ctx, page, errors };
  };
  const until = async (page, fn, ms) => { const t0 = Date.now(); for (;;) { const v = await page.evaluate(fn).catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); } };
  try {
    const sizes = quick ? [[1920, 1080]] : [[1920, 1080], [390, 844]];
    const rows = [];
    for (const size of sizes) {
      for (const [shot, q] of [['hero', `?${query}`], ['wide', '?gf-show=world'], ['look', '?gf-show=look']]) {
        const P = await open(q, size);
        const ok = shot === 'hero' ? await until(P.page, () => window.__game?.phase === 'playing', 60000) : await until(P.page, () => window.__game?.ready === true, 60000);
        if (!ok) P.errors.push(`${shot}: the game did not reach ${shot === 'hero' ? 'play' : 'its preview'} in 60 s`);
        await sleep(1500);
        const png = await P.page.screenshot({ type: 'png' });
        const file = join(out, 'raw', `${name}--${shot}--${size[0]}x${size[1]}.png`); writeFileSync(file, png);
        // which build of the core drew it (wave 3, track W: 'webgpu' | 'webgl2'), for the record and the sheet's title
        record.backend ??= await P.page.evaluate(() => window.__game?.forge?.state?.().backend ?? null).catch(() => null) ?? undefined;
        const cov = await P.page.evaluate(() => { const c = window.__game?.coverage?.(); return c ? { meshes: c.meshes, tagged: c.tagged, untagged: c.untagged.length, unknown: c.unknownSlots?.length ?? 0 } : null; }).catch(() => null);
        const m = await measureShot(P.page, png);
        record.shots.push({ shot, size, file: relative(out, file), luma: m, inTarget: lookVerdict(m), coverage: cov, errors: P.errors.slice(0, 3) });
        record.coverage.push({ shot, size, ...(cov ?? { meshes: 0 }) });
        if (cov && (cov.untagged || cov.unknown)) record.problems.push(`${shot} ${size.join('x')}: ${cov.untagged} untagged, ${cov.unknown} unknown slots`);
        if (P.errors.length) record.problems.push(`${shot} ${size.join('x')}: ${P.errors.slice(0, 2).join(' | ')}`);
        rows.push({ file, caption: `${shot} ${size.join('×')} · luma ${m.mean}/${m.median}/${m.p99} · ${cov ? `${cov.tagged}/${cov.meshes} tagged` : 'no coverage'}` });
        log(`shot ${shot} ${size.join('x')}: luma mean ${m.mean} median ${m.median} p99 ${m.p99} · coverage ${cov ? `${cov.tagged}/${cov.meshes}` : '?'}`);
        await P.ctx.close();
      }
    }
    await sheet(browser, rows.filter(r => r.file.includes('1920x1080')), `${record.target} · forge · ${record.chrome} · ${record.backend === 'webgl2' ? 'WebGL2' : 'WebGPU'}`, join(out, 'sheet-1920x1080.jpg'));
    if (!quick) await sheet(browser, rows.filter(r => r.file.includes('390x844')), `${record.target} · forge · 390×844`, join(out, 'sheet-390x844.jpg'), 3);
    // perf: playing and walking, as tools/measure.mjs
    for (const run of [{ id: 'high-1080p', q: '?seed=7&quality=high', size: [1920, 1080], throttle: 1 }, { id: 'low-4x-cpu', q: '?seed=7&quality=low', size: [1280, 720], throttle: 4 }].slice(0, !perf ? 0 : quick ? 1 : 2)) {
      const P = await open(run.q, run.size, { timer: true, throttle: run.throttle });
      const home = await until(P.page, () => window.__game?.menu?.()?.view === 'home', 60000);
      if (!home) { record.problems.push(`perf ${run.id}: no home menu`); await P.ctx.close(); continue; }
      await P.page.click('#gf-play').catch(() => {});
      await until(P.page, () => window.__game?.phase === 'playing', 15000);
      await sleep(1000);
      // The throttled run is the low tier's, a phone's, and a phone has no pointer lock: the mouse is not taken there.
      // In chrome-headless-shell a locked mouse makes about 60 mouse moves a second that nobody made, and under the CPU
      // throttle those alone starve the page: 10 frames a second with nobody about, 53 with the mouse left alone (wave 3,
      // track M: gf-forge/evidence/wave3-M-2026-10-10/README.md §1). That, not the game, is what this leg read
      // whenever it read 5 to 30 on a loaded machine. The walk is on keys either way.
      if (run.throttle === 1) await P.page.mouse.click(run.size[0] / 2, run.size[1] / 2);
      const walk = (async () => { for (const k of ['KeyW', 'KeyA', 'KeyS']) { await P.page.keyboard.down(k); await sleep(1300); await P.page.keyboard.up(k); } })();
      const p = await perfOf(P.page, 4000, 'window.__frames');
      await walk;
      const fs = await P.page.evaluate(() => window.__game.snapshot().forge).catch(() => null);
      record.perf.push({ id: run.id, viewport: run.size, cpuThrottle: run.throttle, ...p, draws: fs?.draws ?? null, errors: P.errors.slice(0, 3) });
      log(`perf ${run.id}: ${p.fps} fps, gap p95 ${p.frameGapMs.p95} ms, loop cpu median ${p.loopCpuMs.median} ms`);
      if (P.errors.length) record.problems.push(`perf ${run.id}: ${P.errors.slice(0, 2).join(' | ')}`);
      await P.ctx.close();
    }
  } finally { await browser.close(); await srv.close(); }
  return finish(record, out, log);
}

function finish(record, out, log) {
  const hi = record.perf.filter(r => r.cpuThrottle === 1), lo = record.perf.filter(r => r.cpuThrottle > 1);
  record.gates = {
    highTier60: hi.length ? hi.every(r => r.fps >= 58) : null,
    lowTier30Throttled: lo.length ? lo.every(r => r.fps >= 30) : null,
    coverage100: record.coverage ? record.coverage.every(c => c.meshes > 0 && !c.untagged && !c.unknown) : null,
    lookInTarget: record.shots.length ? `${record.shots.filter(s => s.inTarget.mean && s.inTarget.median).length}/${record.shots.length} shots with mean and median luma in the target (a note, not a gate)` : null,
  };
  record.verdict = record.problems.length === 0 && record.gates.highTier60 !== false && record.gates.lowTier30Throttled !== false && record.gates.coverage100 !== false ? 'pass' : 'fail';
  record.finished = new Date().toISOString();
  writeFileSync(join(out, 'capture.json'), JSON.stringify(record, null, 2) + '\n');
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const imgs = readdirSync(out).filter(f => /^sheet-.*\.jpg$/.test(f) && existsSync(join(out, f))).sort().map(f => `<h3>${esc(f)}</h3><img src="${f}" style="max-width:100%">`).join('');
  const perfRows = record.perf.map(r => `<tr><td>${esc(r.id)}</td><td>${r.viewport.join('×')}</td><td>${r.cpuThrottle}×</td><td><b>${r.fps}</b></td><td>${r.frameGapMs.p95}</td><td>${r.loopCpuMs.median}</td><td>${r.loopCpuMs.p95}</td></tr>`).join('');
  writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>gf-forge capture</title><body style="background:#111;color:#ddd;font:14px system-ui;padding:16px"><h1>${esc(record.target)}: ${record.verdict}</h1><p>${esc(record.chrome)} · ${record.started}</p><table border=1 cellpadding=4><tr><th>run</th><th>size</th><th>CPU</th><th>fps</th><th>gap p95 ms</th><th>loop cpu median</th><th>p95</th></tr>${perfRows}</table><p>${esc(record.problems.join(' · ') || 'no problems')}</p>${imgs}</body>`);
  log(`${record.verdict}: ${record.shots.length} shots, ${record.perf.length} perf runs, ${record.problems.length} problems → ${out}`);
  return record;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const a = process.argv.slice(2), opt = (k, d = null) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const target = a[0];
  if (!target || target.startsWith('--')) { console.error('usage: capture.mjs lookdev|<game> --out <dir> [--presets a,b] [--shots a,b] [--wasm <dir>] [--query "…"] [--set a=1,b/c=2] [--quick] [--no-perf]'); process.exit(2); }
  const set = (opt('--set') ?? '').split(',').filter(Boolean);
  const out = resolve(opt('--out', join(HERE, 'evidence', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
  const quick = a.includes('--quick');
  const rec = target === 'lookdev'
    ? await captureLookdev({ out, presets: opt('--presets', 'moonlit-ruins,ember-crypt,ash-storm').split(','), shots: (opt('--shots') ?? 'hero,fight,close,wide,moon,bodies,hero-retro-off').split(','), roles: a.includes('--no-roles') ? [] : (opt('--roles')?.split(',') ?? undefined), wasm: opt('--wasm'), quick, perf: !a.includes('--no-perf'), set })
    : await captureGame(target, { out, query: opt('--query', 'seed=7&gf-autoplay=1&gf-ui=0').replace(/^\?/, ''), quick, set, perf: !a.includes('--no-perf') });
  process.exitCode = rec.verdict === 'pass' ? 0 : 1;
}
