// `gamesfun publish`: a game from this kit to games.fun, at a link anyone can play (games.fun hosts it; the person
// needs no host of their own). Used by the command, the MCP tool and the studio's Publish tab alike.
//
//   1. signed in?           builder/lib/publish/client.mjs (gamesfun login)
//   2. the files            builder/lib/publish/tree.mjs: refuses .env files and links; leaves out evidence/ and hidden files
//   3. no secrets           builder/lib/publish/scan.mjs (games.fun runs the same scan again on its side)
//   4. its backend          backend.json → origins (`gamesfun backend connect`): the only other sites the game may
//                           talk to once published; games.fun's play host opens that game's CSP to exactly those
//   5. the checks           builder/lib/publish/gate.mjs: verify --quick on these files; a fail publishes a private draft only
//   6. upload               only the files games.fun does not have yet
//   7. the version + link   unlisted; an update is the next version at the same link
// The link is remembered in <game>/.gamesfun/publish.json (public facts only: which games.fun, the game's id, its link),
// so the next publish of this folder updates the same game.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildTree, sourceBytes, sha256 } from './tree.mjs';
import { scanFile, secretsMessage, backendOrigins, isBinaryPath, BACKEND_FILE } from './scan.mjs';
import { gate } from './gate.mjs';
import { addKitIgnores } from '../manifest-ignores.mjs';
import { call, savedLogin, studioOrigin } from './client.mjs';

export const linkFile = dir => path.join(dir, '.gamesfun', 'publish.json');
export async function readLinks(dir) { try { return JSON.parse(await readFile(linkFile(dir), 'utf8')); } catch { return {}; } }
async function writeLink(dir, origin, record) {
  const all = await readLinks(dir);
  all[origin] = record;
  await mkdir(path.dirname(linkFile(dir)), { recursive: true });
  await writeFile(linkFile(dir), JSON.stringify(all, null, 2) + '\n');
}

const mb = n => `${(n / 1048576).toFixed(1)} MB`;
export class PublishRefusal extends Error { constructor(message, details = {}) { super(message); Object.assign(this, details); } }

/** Steps 2–4, offline: what would be sent, and every reason it would be refused. */
export async function preflight(dir, { origin = studioOrigin() } = {}) {
  const built = await buildTree(dir);
  const problems = built.refused.map(r => `${r.path}: ${r.why}`);
  const hits = [];
  let config = null;
  for (const f of built.tree.files) {
    if (isBinaryPath(f.path)) continue;
    const src = built.sources.get(f.sha256);
    const bytes = new Uint8Array(await sourceBytes(src));
    hits.push(...scanFile(f.path, bytes));
    if (f.path === BACKEND_FILE) { try { config = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { problems.push(`${BACKEND_FILE} is not valid JSON`); } }
  }
  const secrets = secretsMessage(hits);
  const backend = backendOrigins(config, { own: [origin] });
  problems.push(...backend.problems);
  return { built, hits, secrets, backend: backend.origins, problems };
}

/**
 * Publish `dir`. Options: origin, draft (a private version only), newGame (ignore the remembered link), title,
 * runChecks (default true: run verify --quick when the files changed since the last pass), progress(line).
 * → { url, gameUrl, friendsUrl, slug, version, draft, verify, uploaded, alreadyThere, studioUrl, backend, projectId }
 */
export async function publishGame(dir, { origin = studioOrigin(), draft = false, newGame = false, title = null, runChecks = true, progress = () => {}, env = process.env, fetchImpl = fetch, verify } = {}) {
  const login = await savedLogin(origin, { env });
  if (!login) throw new PublishRefusal(`Not signed in to games.fun (${origin}). Sign in first: npx gamesfun login`, { code: 'login' });
  const me = await call(origin, '/api/kit/me', { token: login.token, fetchImpl }).catch(e => { if (e.status === 401) throw new PublishRefusal(`${e.message}`, { code: 'login' }); throw e; });

  // .gamesfun/ (this game's link and its last check) is the kit's, not a game asset: a game made before the kit knew it
  // gets the ignore entry now (builder/lib/manifest-ignore.json), as web3 does for gamesfun.json, or verify check 1 counts it.
  if (await addKitIgnores(dir)) progress('Added the kit’s own entries to assets.json → ignore (.gamesfun/ is not a game asset).');
  progress('Reading the game’s files…');
  let pre = await preflight(dir, { origin });
  if (pre.problems.length) throw new PublishRefusal(`Nothing was published:\n  - ${pre.problems.join('\n  - ')}`, { code: 'files', problems: pre.problems });
  if (pre.secrets) throw new PublishRefusal(pre.secrets, { code: 'secrets', hits: pre.hits });
  let { built } = pre;
  const L = me.limits ?? {};
  if (L.totalBytes && built.bytes > L.totalBytes) throw new PublishRefusal(`This game is ${mb(built.bytes)}; a published game may be ${mb(L.totalBytes)}.`, { code: 'size' });
  if (L.files && built.tree.files.length > L.files) throw new PublishRefusal(`This game has ${built.tree.files.length} files; a published game may have ${L.files}.`, { code: 'size' });
  const big = L.fileBytes ? built.tree.files.find(f => f.bytes > L.fileBytes) : null;
  if (big) throw new PublishRefusal(`${big.path} is ${mb(big.bytes)}; one file may be ${mb(L.fileBytes)}.`, { code: 'size' });

  progress('Checking the game (verify --quick; about 2 minutes unless nothing changed since it last passed)…');
  const kitVersion = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')).version;
  const checked = await gate(dir, { run: runChecks, kit: `gamesfun-kit ${kitVersion}`, onLine: l => progress(`  ${l}`), ...(verify ? { verify } : {}) });
  const report = { ...checked.report };
  // What goes up is exactly what was checked: read the files again, and a pass for other files is no pass.
  if (checked.fingerprint !== built.fingerprint) {
    pre = await preflight(dir, { origin });
    if (pre.problems.length || pre.secrets) throw new PublishRefusal(pre.secrets ?? `Nothing was published:\n  - ${pre.problems.join('\n  - ')}`, { code: pre.secrets ? 'secrets' : 'files' });
    built = pre.built;
    if (built.fingerprint !== checked.fingerprint) report.pass = false;
  }
  if (checked.reused) progress(`These exact files passed verify --quick (${report.passed}/${report.ran}, ${report.run ?? 'earlier'}), so it is not run again.`);
  if (checked.changedDuring) progress('The game’s files changed while verify ran, so this counts as not passed. Publish again when nothing is editing it.');
  if (!report.pass && !draft) progress(`Its checks did not pass (${report.failed.map(c => `${c.n} ${c.name}`).join('; ') || 'verify did not run'}), so it goes up as a private draft: a version in your games.fun Studio, with no public link.`);

  const links = await readLinks(dir), known = newGame ? null : links[origin] ?? null;
  const name = title ?? built.title;
  progress(`${known ? `Updating ${known.slug ? `/play/${known.slug}` : 'your game'}` : `Publishing “${name}”`} on ${origin}…`);
  const begun = await call(origin, '/api/kit/publish', { method: 'POST', token: login.token, fetchImpl,
    body: { title: name, ...(known?.projectId ? { projectId: known.projectId } : {}), tree: built.tree, verify: report, draft: draft === true } });

  let uploaded = 0;
  const queue = [...begun.missing];
  const worker = async () => {
    for (let sha = queue.shift(); sha; sha = queue.shift()) {
      const data = await sourceBytes(built.sources.get(sha)), bytes = data.length, route = `/api/kit/publish/${begun.id}/blobs/${sha}`;
      if (sha256(data) !== sha) throw new PublishRefusal('A file changed while it was being published. Publish again when nothing is editing the game.', { code: 'changed' });
      const first = await call(origin, route, { method: 'POST', token: login.token, body: { bytes }, fetchImpl });
      if (first?.present) continue;
      if (first?.upload === null) await call(origin, route, { method: 'POST', token: login.token, body: { bytes, content: Buffer.from(data).toString('base64') }, fetchImpl });
      else {
        const u = first.upload;
        const put = await fetchImpl(u.url, { method: u.method ?? 'PUT', headers: u.headers ?? {}, body: data });
        if (!put.ok) throw new Error(`Uploading a file failed (${put.status}). Run publish again; files already sent are kept.`);
        await call(origin, route, { method: 'POST', token: login.token, body: { bytes, upload: u.key }, fetchImpl });
      }
      uploaded++;
      if (uploaded % 10 === 0 || !queue.length) progress(`  uploaded ${uploaded} of ${begun.missing.length} new files`);
    }
  };
  progress(`Uploading ${begun.missing.length} new file${begun.missing.length === 1 ? '' : 's'} (${mb(begun.newBytes)}); ${built.tree.files.length - begun.missing.length} games.fun already has.`);
  await Promise.all(Array.from({ length: Math.min(4, begun.missing.length) }, worker));

  const done = await call(origin, `/api/kit/publish/${begun.id}`, { method: 'POST', token: login.token, body: { action: 'complete' }, fetchImpl });
  const p = done.published;
  const result = { projectId: done.projectId, version: done.version, draft: done.draft, verify: report, uploaded, alreadyThere: built.tree.files.length - begun.missing.length,
    url: p?.published ? p.url : null, gameUrl: p?.published ? p.gameUrl : null, friendsUrl: p?.published ? p.friendsUrl : null, slug: p?.slug ?? known?.slug ?? null,
    publishError: p && !p.published ? p.error ?? 'not published' : null, studioUrl: done.studioUrl, backend: done.backend ?? [], skipped: built.skipped, added: built.added };
  await writeLink(dir, origin, { studio: origin, projectId: done.projectId, slug: result.slug, url: result.url ?? known?.url ?? null, gameUrl: result.gameUrl ?? known?.gameUrl ?? null,
    lastVersion: done.version?.number ?? null, draft: done.draft, at: new Date().toISOString() });
  return result;
}

/** The game's remembered link and what games.fun says about it now (`gamesfun publish --status`). */
export async function publishStatus(dir, { origin = studioOrigin(), env = process.env, fetchImpl = fetch } = {}) {
  const links = await readLinks(dir), known = links[origin] ?? null, login = await savedLogin(origin, { env });
  let live = null;
  if (known?.projectId && login) { try { live = await call(origin, `/api/kit/games/${known.projectId}`, { token: login.token, fetchImpl }); } catch (e) { live = { error: e.message }; } }
  return { studio: origin, signedIn: login ? { email: login.email, expiresAt: login.expiresAt, store: login.store } : null, known, live };
}
