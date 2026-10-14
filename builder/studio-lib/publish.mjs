// Public game links (docs/play-origin.md "Public links"; migration 0011_published_games).
// The owner publishes one file-tree version of a game. Anyone can then play it, with no token and no sign-in, at
//   <PLAY_ORIGIN>/p/<slug>/                    the game itself (lib/play-serve.mjs servePublishedGame)
//   <PLAY_ORIGIN>/p/<slug>/gf/mp/index.html    "Play with friends", when the version carries the multiplayer kit
//   <STUDIO_ORIGIN>/play/<slug>                the public Studio page (app/play/[slug]/page.tsx)
// Only file-tree versions can be published: a single-HTML version has no files for the play origin to serve.
// The slug comes from the game's title the first time it is published, then stays with the game: through renames,
// version updates and unpublish/republish. A link that was shared keeps working, and no other game can take it over.
// Pure (no Node or Next imports), so the play route, the Studio API, the import script and the tests all share it.
import {playOrigin, studioOriginFor} from './play-policy.mjs';
import {readTree, resolveTreePath} from './tree-store.mjs';
import {blobBytes} from './play-cache.mjs';

export const SLUG_MIN = 3, SLUG_MAX = 48;
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Names the Studio or the play host route by, or might: never a game's link. ("api-2" and the like are fine.)
export const RESERVED_SLUGS = new Set(['api', 'play', 'p', 'v', 'd', 'signal', 'world', 'admin', 'studio', 'operator', 'signin', 'signout', 'auth',
  'demos', 'tokens', 'meta', 'launchpad', 'dashboard', 'dev', 'gf', 'www', 'static', 'assets', 'new', 'index', 'null', 'undefined']);
/** The multiplayer kit's party page (multiplayer/STANDARD.md): its presence gives a version a "Play with friends" link. */
export const FRIENDS_PAGE = 'gf/mp/index.html';
/** The game's multiplayer manifest, beside assets.json (builder/multiplayer/party/manifest.mjs MANIFEST). */
export const MULTIPLAYER_MANIFEST = 'multiplayer.json';
export const TAKEN_DOWN = 'This game was taken down by XGames.fun and cannot be published again. Write to XGames.fun if you think that is a mistake.';
export const BLOCKED = 'Publishing is turned off for this account. Write to XGames.fun if you think that is a mistake.';
const NOT_A_TREE = 'Only games that play from their files can be published. This version is a single HTML page; ask for a new version to publish it.';

/** Errors carry an HTTP status, like StudioError (lib/studio-server.ts respond() shows their message). */
export class PublishError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

/** Returns `slug` when it is a valid public link name; throws a PublishError otherwise. */
export function checkSlug(slug) {
  if (typeof slug !== 'string' || slug.length < SLUG_MIN || slug.length > SLUG_MAX || !SLUG_SHAPE.test(slug)) throw new PublishError(`A link name has ${SLUG_MIN}–${SLUG_MAX} lowercase letters or digits, with single dashes between words.`);
  if (RESERVED_SLUGS.has(slug)) throw new PublishError('That link name is reserved.');
  return slug;
}
export const isSlug = value => { try { checkSlug(value); return true; } catch { return false; } };

const trimTo = (s, n) => s.slice(0, n).replace(/-+$/, '');
/** The link name a title asks for, before collisions: lowercase kebab, accents folded, 3–48 characters, never reserved. */
export function slugify(title) {
  let s = String(title ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  s = trimTo(s, SLUG_MAX);
  if (!s) return 'game';
  if (s.length < SLUG_MIN || RESERVED_SLUGS.has(s)) s = trimTo(s, SLUG_MAX - 5) + '-game';
  return s;
}
/** Collision candidate n (1-based): base, base-2, base-3, … always within SLUG_MAX. */
export function slugCandidate(base, n) {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return trimTo(base, SLUG_MAX - suffix.length) + suffix;
}

/**
 * The public links for a published slug serving the tree `treeHash`. All null when PLAY_HOST is not configured.
 * `world: true` (only then present) marks a world game: its multiplayer.json mode is "world" (worlds/PLAN.md),
 * so its page always opens the friends page, which is how a player enters the world (components/play/play-room.tsx).
 */
export async function publicLinks(bucket, slug, treeHash, env = process.env) {
  const play = playOrigin(env), studio = studioOriginFor(env);
  if (!play) return {url: null, gameUrl: null, friendsUrl: null};
  const gameUrl = `${play}/p/${slug}/`;
  const tree = treeHash ? await readTree(bucket, treeHash) : null;
  const friends = !!(tree && resolveTreePath(tree, FRIENDS_PAGE));
  const world = friends && await multiplayerMode(bucket, tree) === 'world';
  return {url: studio ? `${studio}/play/${slug}` : gameUrl, gameUrl, friendsUrl: friends ? gameUrl + FRIENDS_PAGE : null, ...(world ? {world: true} : {})};
}

/** The tree's multiplayer.json → mode (a ~300-byte file, read through the play host's blob cache), or null. */
async function multiplayerMode(bucket, tree) {
  const entry = resolveTreePath(tree, MULTIPLAYER_MANIFEST);
  if (!entry) return null;
  try {
    const bytes = await blobBytes(bucket, entry.sha256);
    const mode = bytes ? JSON.parse(new TextDecoder().decode(bytes))?.mode : null;
    return typeof mode === 'string' ? mode : null;
  } catch { return null; }
}

/** The game's own link-preview picture (gf-three: assets/card.jpg, the ui.card slot; tools/card.mjs renders it) for a
 *  published slug: {bytes, type} or null (none, too big, or not a picture). Read through the play host's blob cache. */
export const CARD_PICTURES = [['assets/card.jpg', 'image/jpeg'], ['assets/card.png', 'image/png']];
export const CARD_MAX_BYTES = 1_500_000;
export async function cardPicture(db, bucket, slug) {
  const game = await publishedGame(db, slug);
  if (!game) return null;
  const tree = await readTree(bucket, game.treeHash).catch(() => null);
  if (!tree) return null;
  for (const [path, type] of CARD_PICTURES) {
    const entry = resolveTreePath(tree, path);
    if (!entry || (entry.size ?? 0) > CARD_MAX_BYTES) continue;
    const bytes = await blobBytes(bucket, entry.sha256).catch(() => null);
    if (bytes && bytes.length <= CARD_MAX_BYTES) return {bytes, type};
  }
  return null;
}

/**
 * The live published version behind a slug, for the play route: {slug, title, versionId, treeHash}, or null when the
 * slug is unknown, malformed, unpublished, or (defensively) not a file tree. Carries nothing about the owner.
 */
export async function publishedGame(db, slug) {
  if (!isSlug(slug)) return null;
  const row = await db.prepare(`SELECT g.slug,p.title,v.id AS version_id,v.tree_hash,v.artifact_kind FROM published_games g
    JOIN projects p ON p.id=g.project_id JOIN versions v ON v.id=g.version_id AND v.project_id=g.project_id
    WHERE g.slug=? AND g.unpublished_at IS NULL AND g.taken_down_at IS NULL`).bind(slug).first();
  if (!row || row.artifact_kind !== 'file-tree' || !row.tree_hash) return null;
  return {slug: row.slug, title: row.title, versionId: row.version_id, treeHash: row.tree_hash};
}

/**
 * Everything the public /play/<slug> page shows: {title, slug, gameUrl, friendsUrl, world?}, or null. No owner, ids or
 * internals. `world: true` only for a world game (publicLinks).
 */
export async function publicGame(db, bucket, slug, env = process.env) {
  const game = await publishedGame(db, slug);
  if (!game) return null;
  const links = await publicLinks(bucket, game.slug, game.treeHash, env);
  if (!links.gameUrl) return null;
  return {title: game.title, slug: game.slug, gameUrl: links.gameUrl, friendsUrl: links.friendsUrl, ...(links.world ? {world: true} : {})};
}

const validId = id => { if (typeof id !== 'string' || !/^[-a-z0-9]{12,64}$/.test(id)) throw new PublishError('Invalid request identifier.'); return id; };

/** Owner-side publishing (GET/POST/DELETE /api/projects/:id/publish). Every call is scoped to the owner's own game. */
export function createPublishing(db, bucket) {
  const first = (sql, ...args) => db.prepare(sql).bind(...args).first();
  // A database from before migration 0018 has no publish_blocks table, and so no blocked account: an operator's
  // import-game.mjs --publish against it must still publish (the multiplayer session hit this on production, 2026-10-12).
  // Only that one missing table is forgiven; any other error still stops the publish.
  const blocked = owner => first('SELECT owner FROM publish_blocks WHERE owner=?', owner)
    .catch(e => { if (/publish_blocks/.test(String(e?.message)) && /does not exist|no such table/.test(String(e?.message))) return null; throw e; });
  const all = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
  async function owned(owner, id) {
    const p = await first('SELECT id,title FROM projects WHERE id=? AND owner=?', validId(id), owner);
    if (!p) throw new PublishError('Game not found.', 404);
    return p;
  }
  // The API's answer: {published, slug, version:{id,number}, url (the /play page), gameUrl, friendsUrl, publishedAt, updatedAt}.
  // After an unpublish the slug is still reported (it is kept for this game) but nothing else is.
  async function view(row, env) {
    const none = {published: false, slug: row?.slug ?? null, version: null, url: null, gameUrl: null, friendsUrl: null, publishedAt: null, updatedAt: row?.updated_at ?? null,
      ...(row?.taken_down_at != null ? {takenDown: true} : {})};
    if (!row || row.unpublished_at != null || row.taken_down_at != null) return none;
    const v = await first('SELECT id,number,tree_hash FROM versions WHERE id=?', row.version_id);
    if (!v) return none;
    return {published: true, slug: row.slug, version: {id: v.id, number: v.number}, ...await publicLinks(bucket, row.slug, v.tree_hash, env), publishedAt: row.published_at, updatedAt: row.updated_at};
  }
  const rowFor = id => first('SELECT * FROM published_games WHERE project_id=?', id);

  async function status(owner, id, env = process.env) {
    await owned(owner, id);
    return view(await rowFor(id), env);
  }

  // Default: the game's newest file-tree version. A specific version must be this game's, and a file tree.
  async function chooseVersion(id, versionId) {
    if (versionId != null) {
      if (typeof versionId !== 'string' || !/^[-a-z0-9]{12,64}$/.test(versionId)) throw new PublishError('Version not found.', 404);
      const v = await first('SELECT id,artifact_kind,tree_hash FROM versions WHERE id=? AND project_id=?', versionId, id);
      if (!v) throw new PublishError('Version not found.', 404);
      if (v.artifact_kind !== 'file-tree' || !v.tree_hash) throw new PublishError(NOT_A_TREE, 409);
      return v;
    }
    const v = await first("SELECT id,artifact_kind,tree_hash FROM versions WHERE project_id=? AND artifact_kind='file-tree' AND tree_hash IS NOT NULL ORDER BY number DESC LIMIT 1", id);
    if (v) return v;
    throw new PublishError(await first('SELECT id FROM versions WHERE project_id=? LIMIT 1', id) ? NOT_A_TREE : 'There is no playable version to publish yet.', 409);
  }

  const relink = (owner, id, versionId, time) => db.prepare(`UPDATE published_games SET version_id=?,published_by=?,updated_at=?,unpublished_at=NULL,
    published_at=CASE WHEN unpublished_at IS NULL THEN published_at ELSE ? END WHERE project_id=?`).bind(versionId, owner, time, time, id).run();

  /** Publishes `input.versionId` (default: the newest file-tree version), or moves the live link to it. */
  async function publish(owner, id, input = {}, env = process.env) {
    const p = await owned(owner, id);
    if (!playOrigin(env)) throw new PublishError('The play host is not configured.', 503);
    // An operator's takedown sticks (migration 0018): the game's link stays down, and so does the account's publishing.
    if ((await rowFor(id))?.taken_down_at != null) throw new PublishError(TAKEN_DOWN, 403);
    if (await blocked(owner)) throw new PublishError(BLOCKED, 403);
    const v = await chooseVersion(id, input?.versionId ?? null), time = Date.now();
    if (await rowFor(id)) { await relink(owner, id, v.id, time); return view(await rowFor(id), env); }
    // A new link: the title's slug, or the first free numbered form. The insert is the arbiter (slug is the primary
    // key, project_id is unique), so a lost race just tries again with what is now taken.
    const base = slugify(p.title);
    for (let attempt = 0; attempt < 5; attempt++) {
      // Every candidate starts with the base's first 40 characters (suffixes are short), so one LIKE finds them all.
      const taken = new Set((await all('SELECT slug FROM published_games WHERE slug LIKE ?', trimTo(base, 40) + '%')).map(r => r.slug));
      let n = 1;
      while (taken.has(slugCandidate(base, n))) n++;
      const inserted = await first(`INSERT INTO published_games(slug,project_id,version_id,published_by,published_at,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT DO NOTHING RETURNING slug`, slugCandidate(base, n), id, v.id, owner, time, time);
      if (inserted) return view(await rowFor(id), env);
      if (await rowFor(id)) { await relink(owner, id, v.id, time); return view(await rowFor(id), env); } // published concurrently
    }
    throw new PublishError('No free link name was found for this game. Try again.', 503);
  }

  /** Takes the link down. The slug stays reserved for this game, so publishing again brings the same link back. */
  async function unpublish(owner, id, env = process.env) {
    await owned(owner, id);
    const time = Date.now();
    await db.prepare('UPDATE published_games SET unpublished_at=?,updated_at=? WHERE project_id=? AND unpublished_at IS NULL').bind(time, time, id).run();
    return view(await rowFor(id), env);
  }

  return {status, publish, unpublish};
}
