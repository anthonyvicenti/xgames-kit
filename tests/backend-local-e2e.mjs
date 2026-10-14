#!/usr/bin/env node
// A game saves a high score to a real Supabase, end to end, on this machine: the Supabase CLI's local stack (Docker),
// never a hosted project. Not part of `npm test` (it needs Docker, the stack and psql); run by hand:
//
//   npx supabase@2.118.0 start          (in a folder with a supabase/config.toml; anonymous sign-ins on)
//   node tests/backend-local-e2e.mjs --api http://127.0.0.1:54321 --key <its publishable key> \
//        --db postgresql://postgres:postgres@127.0.0.1:54322/postgres [--port 0] [--out <dir>]
//
// What it does, all through the kit's own code:
//   1. makes a game from soak-squad in a temp folder, with an 8-second round;
//   2. `backend use` writes backend.json (the local URL and the publishable key) and gf/backend/;
//   3. adds the skill's high-score migration and the skill's rules.js lines, and `backend check` passes them;
//   4. applies the migration with psql (what apply_migration does on a hosted project), then the live check reads
//      Postgres' own view and passes; a table without row-level security makes it refuse, and is dropped again;
//   5. serves the game with `gamesfun dev`'s server, plays one round in Chrome (the client on, as in a person's own
//      browser), and the score row appears in the database under the player's anonymous id, with no gf-backend warning;
//   6. plays again with the client in its default automated-browser mode: no request reaches the database.
// Then, from outside the game: the key alone cannot write, another player cannot write in this player's name or change
// a score, and a player can add their own.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ensureBrowser } from '../builder/lib/chrome.mjs';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import * as B from '../builder/lib/backend/index.mjs';
import { startDevServer } from '../builder/server/index.mjs';
import { tempGame } from './helpers.mjs';

const { values: a } = parseArgs({ options: { api: { type: 'string' }, key: { type: 'string' }, db: { type: 'string' }, port: { type: 'string', default: '0' }, out: { type: 'string' }, keep: { type: 'boolean' } } });
if (!a.api || !a.key || !a.db) { console.error('usage: node tests/backend-local-e2e.mjs --api <url> --key <publishable key> --db <postgres url> [--port 0] [--out <dir>]'); process.exit(2); }
const out = a.out ? path.resolve(a.out) : null;
if (out) await mkdir(out, { recursive: true });
const rec = { started: new Date().toISOString(), api: a.api, steps: [], ok: false };
const step = (name, ok, detail = '') => { rec.steps.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) throw new Error(`${name}: ${detail}`); };
const psql = (sql, { json = false } = {}) => {
  const r = spawnSync('psql', [a.db, '-v', 'ON_ERROR_STOP=1', '-At', '-c', json ? `select coalesce(json_agg(t), '[]') from (${sql}) t` : sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr || r.error?.message}`);
  return json ? JSON.parse(r.stdout.trim() || '[]') : r.stdout.trim();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await sleep(250); } }

const game = await tempGame('soak-squad');
let server = null, browser = null;
try {
  // 1. an 8-second round
  const gj = path.join(game.dir, 'config', 'game.json');
  const cfg = JSON.parse(await readFile(gj, 'utf8'));
  cfg.round = { ...(cfg.round ?? {}), seconds: 8 };
  await writeFile(gj, JSON.stringify(cfg, null, 2) + '\n');

  // 2. the public settings
  const u = await B.use(game.dir, { provider: 'supabase', url: a.api, key: a.key, players: 'anonymous' });
  step('backend use wrote backend.json and gf/backend/', u.settings.url === new URL(a.api).origin && u.settings.keyKind === 'publishable', JSON.stringify(u.settings.origins));

  // 3. the skill's migration and rules.js lines
  const mig = path.join(game.dir, 'supabase', 'migrations');
  await mkdir(mig, { recursive: true });
  await copyFile(path.join(KIT_ROOT, 'skills', 'gamesfun-backend', 'references', 'high-scores.sql'), path.join(mig, '20261012000000_high_scores.sql'));
  const rulesFile = path.join(game.dir, 'rules.js');
  let rules = await readFile(rulesFile, 'utf8');
  rules = `import { connectBackend } from './gf/backend/index.js';\n${rules}`
    .replace('setup(ctx) {', 'setup(ctx) {\n    ctx.db = connectBackend();')
    .replace('results(ctx) {', `results(ctx) {
    ctx.db.then(async db => {
      if (!db || !(await db.signIn())) return;
      const saved = await db.from('high_scores').insert({ player_id: db.user.id, name: ctx.me.name || 'Player', score: Math.max(0, Math.round(ctx.me.score || 0)) });
      const { data } = await db.from('high_scores').select('name,score', { order: 'score.desc', limit: 5 });
      globalThis.__backendE2E = { user: db.user.id, saved: saved.error ? saved.error : 'ok', board: data };
    });`);
  await writeFile(rulesFile, rules);
  const c = await B.check(game.dir);
  step('backend check passes the game (no secrets, RLS on every table it reads)', c.ok, `${c.rls.tables.map(t => `${t.name} rls ${t.rls} policies ${t.policies}`).join('; ')}; reads ${c.rls.used.join(',')}`);

  // 4. apply, then the live check
  psql('drop table if exists public.high_scores cascade');
  const r = spawnSync('psql', [a.db, '-v', 'ON_ERROR_STOP=1', '-q', '-f', path.join(mig, '20261012000000_high_scores.sql')], { encoding: 'utf8' });
  step('the migration applied (psql, as apply_migration would)', r.status === 0, r.stderr.trim());
  psql("notify pgrst, 'reload schema'");   // PostgREST picks up the new table (Supabase does this on its own on a hosted project)
  await sleep(1500);
  let live = await B.judgeRows(game.dir, psql(B.LIVE_SQL, { json: true }));
  step('the live check passes the project', live.ok, JSON.stringify(live.tables));
  psql('create table public.e2e_leaky (id int)');
  live = await B.judgeRows(game.dir, psql(B.LIVE_SQL, { json: true }));
  psql('drop table public.e2e_leaky');
  step('the live check refuses a table without row-level security', !live.ok && /e2e_leaky/.test(live.refused.join()), live.refused[0]);

  // 5. play a round in Chrome with the client on
  server = await startDevServer({ gameDir: game.dir, port: Number(a.port), log: () => {}, watch: false });
  const b = await ensureBrowser({ log: () => {} });
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath: b.path, headless: true, args: ['--autoplay-policy=no-user-gesture-required', ...(process.env.CHROME_ARGS ?? '--use-angle=swiftshader --enable-unsafe-swiftshader').split(/\s+/).filter(Boolean)] });
  const play = async ({ on, label }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const warnings = [], toDb = [], errors = [];
    page.on('console', m => { if (/gf-backend/.test(m.text())) warnings.push(m.text()); if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', q => { if (q.url().startsWith(new URL(a.api).origin)) toDb.push(`${q.method()} ${new URL(q.url()).pathname}`); });
    if (on) await page.addInitScript(() => { globalThis.__GF_BACKEND = 'on'; });
    await page.goto(`${server.url}game/?gf-autoplay=1`, { waitUntil: 'load' });
    await until(() => page.evaluate(() => window.__game?.phase === 'results'), 90000, `${label}: the round's results`);
    const result = on ? await until(() => page.evaluate(() => globalThis.__backendE2E ?? null), 20000, `${label}: the score saved`) : (await sleep(3000), null);
    if (out) await page.screenshot({ path: path.join(out, `${label}.jpg`), type: 'jpeg', quality: 70 }).catch(() => {});
    await ctx.close();
    return { warnings, toDb, errors, result };
  };
  const before = Number(psql('select count(*) from public.high_scores'));
  const p1 = await play({ on: true, label: 'played-with-backend' });
  const rows = psql('select player_id::text as player_id, name, score from public.high_scores order by id', { json: true });
  rec.rows = rows;
  step('a round in Chrome saved its score under the player\'s anonymous id', p1.result?.saved === 'ok' && rows.length === before + 1 && rows.at(-1).player_id === p1.result.user, `row ${JSON.stringify(rows.at(-1))}; board ${JSON.stringify(p1.result?.board)}; requests ${[...new Set(p1.toDb)].join(', ')}`);
  step('no gf-backend warning and no page error', !p1.warnings.length && !p1.errors.length, [...p1.warnings, ...p1.errors].join(' | '));
  const users = psql(`select count(*) from auth.users where id = '${p1.result.user}' and is_anonymous`);
  step('the player is an anonymous Supabase user', users === '1', `auth.users rows: ${users}`);

  // row-level security from outside the game: the key alone cannot write, and a signed-in player cannot write as another
  const origin = new URL(a.api).origin;
  const anonWrite = await fetch(`${origin}/rest/v1/high_scores`, { method: 'POST', headers: { apikey: a.key, 'content-type': 'application/json' }, body: JSON.stringify({ player_id: p1.result.user, name: 'x', score: 1 }) });
  step('the key alone cannot add a score (RLS)', [401, 403].includes(anonWrite.status), `HTTP ${anonWrite.status} ${(await anonWrite.text()).slice(0, 120)}`);
  const other = await (await fetch(`${origin}/auth/v1/signup`, { method: 'POST', headers: { apikey: a.key, 'content-type': 'application/json' }, body: '{}' })).json();
  const asOther = await fetch(`${origin}/rest/v1/high_scores`, { method: 'POST', headers: { apikey: a.key, authorization: `Bearer ${other.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ player_id: p1.result.user, name: 'cheat', score: 999 }) });
  step('another player cannot add a score in this player\'s name (RLS)', [401, 403].includes(asOther.status), `HTTP ${asOther.status} ${(await asOther.text()).slice(0, 120)}`);
  const own = await fetch(`${origin}/rest/v1/high_scores`, { method: 'POST', headers: { apikey: a.key, authorization: `Bearer ${other.access_token}`, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ player_id: other.user.id, name: 'Other', score: 3 }) });
  step('a player can add their own score (RLS allows it)', own.status === 201, `HTTP ${own.status}`);
  const upd = await fetch(`${origin}/rest/v1/high_scores?player_id=eq.${p1.result.user}`, { method: 'PATCH', headers: { apikey: a.key, authorization: `Bearer ${other.access_token}`, 'content-type': 'application/json', prefer: 'return=representation' }, body: JSON.stringify({ score: 999999 }) });
  const changed = await upd.json().catch(() => null);
  step('no player can change a score (no update policy)', Array.isArray(changed) && changed.length === 0 && psql(`select max(score) from public.high_scores where player_id = '${p1.result.user}'`) !== '999999', `HTTP ${upd.status}, rows changed ${Array.isArray(changed) ? changed.length : '?'}`);

  // 6. an automated browser with the default: the client stays off
  const p2 = await play({ on: false, label: 'automated-default' });
  const after = Number(psql('select count(*) from public.high_scores'));
  step('an automated browser (verify, play) touches nothing by default', !p2.toDb.length && after === before + 2, `requests to the database: ${p2.toDb.length}`);
  rec.ok = true;
} catch (e) {
  rec.error = e.message;
  console.error(e.message);
} finally {
  await browser?.close().catch(() => {});
  await server?.close?.().catch?.(() => {});
  rec.finished = new Date().toISOString();
  if (out) await writeFile(path.join(out, 'record.json'), JSON.stringify(rec, null, 2) + '\n');
  if (!a.keep) await game.cleanup(); else console.log(`game kept at ${game.dir}`);
}
process.exit(rec.ok ? 0 : 1);
