// Row-level security, checked before anything reaches the person's database. A browser game carries the project's
// public key, so anyone can call the database with it: a table in the exposed schema without row-level security is
// open to the world. This checker refuses one, in plain words, in two places:
//   - static: the game's SQL (<game>/supabase/migrations/*.sql, the Supabase CLI's own layout), before `apply`;
//   - live: the project's tables as Postgres reports them (LIVE_SQL through the Management API's read-only query).
// Its home is the backend part (skill gamesfun-backend): a game with no backend never meets it.
//
// Refused: a table (or partitioned table) in `public` without `enable row level security`; `disable row level
// security`; a view in `public` without `security_invoker` (a view runs as its owner and skips the table's policies);
// a materialized view in `public` (it has no row-level security at all); a table the game's code reads with
// `.from('name')` that no migration creates. Warned: a table with RLS and no policy (nobody but the server can use it),
// a write policy whose rule is `true` for everyone, a `security definer` function in `public`.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const MIGRATIONS = ['supabase', 'migrations'];

/** SQL with comments, string literals and dollar-quoted bodies blanked, split into statements. */
export function statements(sql) {
  let out = '', i = 0;
  const s = String(sql);
  while (i < s.length) {
    const c = s[i], two = s.slice(i, i + 2);
    if (two === '--') { const j = s.indexOf('\n', i); i = j < 0 ? s.length : j; continue; }
    if (two === '/*') { const j = s.indexOf('*/', i + 2); i = j < 0 ? s.length : j + 2; out += ' '; continue; }
    if (c === "'") { let j = i + 1; while (j < s.length) { if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; } if (s[j] === "'") break; j++; } out += "''"; i = j + 1; continue; }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
    if (dollar) { const tag = dollar[0]; const j = s.indexOf(tag, i + tag.length); out += ' $body$ '; i = j < 0 ? s.length : j + tag.length; continue; }
    out += c; i++;
  }
  return out.split(';').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;
/** "Public"."Scores" → { schema: 'public', name: 'Scores' }; unquoted names fold to lower case. */
export function qname(raw) {
  const parts = raw.split(/\s*\.\s*/).map(p => (p.startsWith('"') ? p.slice(1, -1) : p.toLowerCase()));
  return parts.length === 2 ? { schema: parts[0], name: parts[1] } : { schema: 'public', name: parts[0] };
}
const key = q => `${q.schema}.${q.name}`;

/** Read every statement of the migrations. → { tables, views, policies, functions, disabled } */
export function analyse(sqlFiles) {
  const tables = new Map(), views = [], policies = new Map(), functions = [], disabled = [];
  for (const { file, sql } of sqlFiles) {
    for (const st of statements(sql)) {
      let m;
      if ((m = new RegExp(String.raw`^create (?:(?:global |local )?(?:temp|temporary|unlogged) )?table (?:if not exists )?${QNAME}`, 'i').exec(st))) {
        const q = qname(m[1]); if (!tables.has(key(q))) tables.set(key(q), { ...q, file, rls: false }); continue;
      }
      if ((m = new RegExp(String.raw`^alter table (?:if exists )?(?:only )?${QNAME} (enable|disable|force|no force) row level security`, 'i').exec(st))) {
        const q = qname(m[1]), how = m[2].toLowerCase();
        const t = tables.get(key(q)) ?? { ...q, file, rls: false, external: true };
        if (how === 'enable' || how === 'force') t.rls = true;
        if (how === 'disable') { t.rls = false; disabled.push({ ...q, file }); }
        tables.set(key(q), t); continue;
      }
      if ((m = new RegExp(String.raw`^create policy ${IDENT} on ${QNAME}(.*)$`, 'i').exec(st))) {
        const q = qname(m[1]), rest = m[2];
        const cmd = (/\bfor (all|select|insert|update|delete)\b/i.exec(rest)?.[1] ?? 'all').toLowerCase();
        const roles = (/\bto ([a-z_,\s"]+?)(?= using| with check|$)/i.exec(rest)?.[1] ?? 'public').split(',').map(r => r.trim().replace(/"/g, '').toLowerCase());
        const using = /\busing \((.*?)\)(?= with check|$)/i.exec(rest)?.[1]?.trim() ?? null;
        const check = /\bwith check \((.*)\)$/i.exec(rest)?.[1]?.trim() ?? null;
        if (!policies.has(key(q))) policies.set(key(q), []);
        policies.get(key(q)).push({ file, cmd, roles, using, check });
        continue;
      }
      if ((m = new RegExp(String.raw`^create (?:or replace )?(materialized )?view (?:if not exists )?${QNAME}(.*)$`, 'i').exec(st))) {
        const q = qname(m[2]);
        views.push({ ...q, file, materialized: !!m[1], invoker: /security_invoker\s*=\s*(true|on|1|yes)\b/i.test(m[3]) });
        continue;
      }
      if ((m = new RegExp(String.raw`^alter view (?:if exists )?${QNAME} set \(([^)]*)\)`, 'i').exec(st))) {
        const q = qname(m[1]); const v = views.find(x => x.schema === q.schema && x.name === q.name);
        if (v && /security_invoker\s*=\s*(true|on|1|yes)\b/i.test(m[2])) v.invoker = true;
        continue;
      }
      if ((m = new RegExp(String.raw`^create (?:or replace )?function ${QNAME}`, 'i').exec(st))) {
        const q = qname(m[1]);
        functions.push({ ...q, file, definer: /\bsecurity definer\b/i.test(st), searchPath: /\bset search_path\b/i.test(st) });
      }
    }
  }
  return { tables, views, policies, functions, disabled };
}

const isTrue = e => e != null && /^\(*\s*true\s*\)*$/i.test(e);
const everyone = roles => roles.some(r => ['public', 'anon', 'authenticated'].includes(r));

/**
 * The verdict. `used`: table names the game's code reads (usedTables). → { ok, refused: [..], warned: [..], tables: [..] }
 */
export function judge(a, { used = [] } = {}) {
  const refused = [], warned = [];
  const pub = [...a.tables.values()].filter(t => t.schema === 'public');
  for (const t of pub) {
    if (!t.rls) refused.push(`table public.${t.name} (${t.file}) has no row-level security: anyone with the game's public key could read and change every row. Add: alter table public.${t.name} enable row level security; and a policy for what players may do.`);
    else if (!(a.policies.get(`public.${t.name}`) ?? []).length) warned.push(`table public.${t.name} has row-level security and no policy, so no player can read or write it (only the server). Add a policy if the game uses it.`);
  }
  for (const d of a.disabled) if (d.schema === 'public') refused.push(`${d.file} turns row-level security off on public.${d.name}. Never in a game's database.`);
  for (const v of a.views) {
    if (v.schema !== 'public') continue;
    if (v.materialized) refused.push(`materialized view public.${v.name} (${v.file}) has no row-level security and is open through the API. Put it in another schema, or use a table with policies.`);
    else if (!v.invoker) refused.push(`view public.${v.name} (${v.file}) runs as its owner and skips the tables' policies. Create it with: with (security_invoker = true).`);
  }
  for (const [k, list] of a.policies) for (const p of list) {
    if (['insert', 'update', 'delete', 'all'].includes(p.cmd) && everyone(p.roles) && (isTrue(p.check) || (p.cmd !== 'insert' && isTrue(p.using)))) {
      warned.push(`a ${p.cmd} policy on ${k} (${p.file}) lets every player change every row (its rule is true). Tie it to the player: auth.uid() = player_id.`);
    }
  }
  for (const f of a.functions) if (f.schema === 'public' && f.definer) {
    (f.searchPath ? warned : refused).push(`function public.${f.name} (${f.file}) is security definer: it runs past every policy, and players can call it. ${f.searchPath ? 'Check auth.uid() inside it.' : 'Add set search_path = \'\' and check auth.uid() inside it, or make it security invoker.'}`);
  }
  const known = new Set(pub.map(t => t.name).concat(a.views.filter(v => v.schema === 'public').map(v => v.name)));
  for (const u of used) if (!known.has(u)) refused.push(`the game reads table "${u}" (.from('${u}')), but no migration in supabase/migrations creates it with row-level security.`);
  return { ok: refused.length === 0, refused, warned, tables: pub.map(t => ({ name: t.name, rls: t.rls, policies: (a.policies.get(`public.${t.name}`) ?? []).length })) };
}

/** The migrations of a game, in order. → [{ file, sql }] */
export async function readMigrations(gameDir) {
  const dir = path.join(gameDir, ...MIGRATIONS);
  let names = [];
  try { names = (await readdir(dir)).filter(n => n.endsWith('.sql')).sort(); } catch { return []; }
  return Promise.all(names.map(async n => ({ file: `supabase/migrations/${n}`, sql: await readFile(path.join(dir, n), 'utf8') })));
}

/** Table names the game's own code reads with .from('name') (not the kit copies under gf/). */
export async function usedTables(gameDir) {
  const found = new Set();
  async function walk(d, rel = '') {
    let entries = [];
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!['gf', 'vendor', 'audio', 'node_modules', 'evidence', 'supabase', '.gf-loop', '.git', 'assets'].includes(e.name)) await walk(path.join(d, e.name), r); continue; }
      if (!/\.(m?js)$/.test(e.name)) continue;
      const text = await readFile(path.join(d, e.name), 'utf8').catch(() => '');
      for (const m of text.matchAll(/\.from\(\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\)/g)) found.add(m[1]);
    }
  }
  await walk(gameDir);
  return [...found].sort();
}

/** The static check of a game. → judge()'s verdict plus { migrations, used } */
export async function checkGame(gameDir) {
  const files = await readMigrations(gameDir);
  const used = await usedTables(gameDir);
  return { ...judge(analyse(files), { used }), migrations: files.map(f => f.file), used };
}

/** Postgres' own view of the exposed schema: run read-only on the project. */
export const LIVE_SQL = `select c.relname as name, c.relkind::text as kind, c.relrowsecurity as rls,
  (select count(*) from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname)::int as policies,
  coalesce((select bool_or(o in ('security_invoker=true','security_invoker=on','security_invoker=1')) from unnest(c.reloptions) o), false) as invoker
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
order by 1`;

/** Rows of LIVE_SQL → { ok, refused, warned, tables } */
export function judgeLive(rows, { used = [] } = {}) {
  const refused = [], warned = [], tables = [];
  for (const r of rows ?? []) {
    if (['r', 'p', 'f'].includes(r.kind)) {
      tables.push({ name: r.name, rls: !!r.rls, policies: Number(r.policies) || 0 });
      if (!r.rls) refused.push(`table public.${r.name} has no row-level security on the project: anyone with the game's public key can read and change it. Run: alter table public.${r.name} enable row level security; (and add policies), or move it out of public.`);
      else if (!Number(r.policies)) warned.push(`table public.${r.name} has row-level security and no policy (only the server can use it).`);
    } else if (r.kind === 'v' && !r.invoker) refused.push(`view public.${r.name} skips the tables' policies: alter view public.${r.name} set (security_invoker = true);`);
    else if (r.kind === 'm') refused.push(`materialized view public.${r.name} is open through the API (no row-level security).`);
  }
  const known = new Set((rows ?? []).map(r => r.name));
  for (const u of used) if (!known.has(u)) refused.push(`the game reads table "${u}", which the project does not have.`);
  return { ok: refused.length === 0, refused, warned, tables };
}
