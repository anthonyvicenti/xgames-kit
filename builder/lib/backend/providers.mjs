// The backend providers the kit knows: one file each in builder/lib/backend/providers/<id>.mjs, found by listing the folder
// (a new provider is a new file plus its studio panel, builder/studio/tabs/backend/<id>.js; nothing else changes). A file that
// fails to load is reported and skipped, as commands and tabs are.
//
// A provider file exports `default`:
//   id, label            'supabase', 'Supabase' ([a-z0-9-]+)
//   kind                 'database' (tables, sign-in: Supabase) or 'server' (the person's own server: Railway); the spec's backend.kind uses the same two words
//   about                one line for the studio's provider list
//   ways                 how a person connects, best first: [{ id, label, needs }] ('mcp', 'oauth', 'pat', 'deploy-paste', …)
//   publicKey(key)       → true when `key` is designed to be public (a browser may carry it); a provider with no key
//                          in the game returns false for any value, so backend.json must not carry one
//   settings(input)      → the provider's part of backend.json from what the person or agent gives
//                          ({ url, key?, project? }); builder/lib/backend/config.mjs validates the whole file after
//   status({ env })      → { signedIn: null | { kind, expires_at } } the kit's own sign-in for this provider, if any
//   disconnect({ env, forgetApp }) → { removed, revoked, note } forget (and revoke) the kit's own sign-in
//   agentSteps()         → { steps: [words], tools: [words], request(gameName) → the words the studio sends the
//                          person's session } the way through the person's own agent
//   cli                  optional: { options (util.parseArgs), usage (lines), connect(values, gameArg, io) → exit code }
//                          the provider's own `gamesfun backend connect <id>` flags beyond the agent way
//   routes(router, ctx)  optional: its own studio routes, mounted at /api/backend/<id>/…
//   panel                optional: the studio panel's URL (/studio/tabs/backend/<id>.js), mounted when the person
//                          picks this provider or the game already uses it
// What every provider writes into a game is the same: backend.json (config.mjs) and the client at gf/backend/.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'providers');

async function load() {
  const out = new Map(), broken = new Map();
  let files = [];
  try { files = (await readdir(DIR)).filter(f => /^[a-z0-9][a-z0-9-]*\.mjs$/.test(f)).sort(); } catch {}
  for (const f of files) {
    try {
      const p = (await import(pathToFileURL(path.join(DIR, f)).href)).default;
      const problems = ['id', 'label', 'kind', 'about'].filter(k => typeof p?.[k] !== 'string')
        .concat(['publicKey', 'settings', 'status', 'disconnect', 'agentSteps'].filter(k => typeof p?.[k] !== 'function'));
      if (problems.length) { broken.set(f, `missing ${problems.join(', ')}`); continue; }
      if (!['database', 'server'].includes(p.kind)) { broken.set(f, `kind is "${p.kind}": database or server`); continue; }
      if (`${p.id}.mjs` !== f) { broken.set(f, `its id is "${p.id}", not the file's name`); continue; }
      out.set(p.id, p);
    } catch (e) { broken.set(f, e.message.split('\n')[0]); }
  }
  for (const [f, why] of broken) process.stderr.write(`gamesfun backend: provider ${f} did not load: ${why}\n`);
  return out;
}

export const PROVIDERS = await load();
export const ids = () => [...PROVIDERS.keys()];
export function provider(id) {
  const p = PROVIDERS.get(id);
  if (!p) throw new Error(`no backend provider "${id}" (the kit knows: ${ids().join(', ') || 'none'})`);
  return p;
}
/** What the studio lists. */
export const listed = () => [...PROVIDERS.values()].map(p => ({ id: p.id, label: p.label, kind: p.kind, about: p.about, ways: p.ways ?? [], panel: p.panel ?? null }));
