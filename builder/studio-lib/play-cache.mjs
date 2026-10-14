// Per-instance memory caches for the play host (lib/play-serve.mjs). Everything kept here is immutable: a version row is
// never updated once written, a tree is addressed by the sha256 of its text and a blob by the sha256 of its bytes. So
// nothing needs invalidating, and the limits only bound memory. Without them every game file cost a database query
// and three bucket reads (the version row; its tree, ~80 KB, re-hashed and validated; assets.json for the isolation
// flag) before the file itself was read. On 2026-10-08 that was ~1,000 requests a minute, ~1 CPU core all day.
import {readBlobBytes, readTree, resolveTreePath} from './tree-store.mjs';
import {MANIFEST_PATH} from './manifest.mjs';
import {backendOrigins, BACKEND_FILE} from './publish-scan.mjs';

/** A least-recently-used map, bounded by entry count and by the sum of `size(value)`. */
export function lru({maxEntries = Infinity, maxBytes = Infinity, size = () => 0} = {}) {
  const map = new Map();
  let bytes = 0;
  const drop = key => { bytes -= size(map.get(key)); map.delete(key); };
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key); map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) drop(key);
      if (size(value) > maxBytes) return value;
      map.set(key, value); bytes += size(value);
      while (map.size > maxEntries || bytes > maxBytes) drop(map.keys().next().value);
      return value;
    },
    delete: key => { if (map.has(key)) drop(key); },
    clear() { map.clear(); bytes = 0; },
    get size() { return map.size; },
    get bytes() { return bytes; },
  };
}

// A game load asks for ~125 files at once, so the version and tree caches hold the pending promise: one lookup serves
// every concurrent request for the same game. A miss (null) or a failure is not kept, so the next request tries again.
function remembered(cache, key, load) {
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = Promise.resolve().then(load).then(value => { if (value == null) cache.delete(key); return value; }, error => { cache.delete(key); throw error; });
  cache.set(key, pending);
  return pending;
}

const versions = lru({maxEntries: 2048}), trees = lru({maxEntries: 128});
export const BLOB_CACHE_BYTES = 64 * 1024 * 1024, BLOB_CACHE_FILE_BYTES = 4 * 1024 * 1024;
const blobs = lru({maxBytes: BLOB_CACHE_BYTES, size: bytes => bytes.byteLength});

/** {artifact_kind, tree_hash} of a version, or null. Only file-tree versions are kept (only they are served). */
export function versionTree(db, versionId) {
  return remembered(versions, versionId, async () => {
    const v = await db.prepare('SELECT artifact_kind,tree_hash FROM versions WHERE id=?').bind(versionId).first();
    return v && v.artifact_kind === 'file-tree' && v.tree_hash ? {artifact_kind: v.artifact_kind, tree_hash: v.tree_hash} : null;
  });
}

/**
 * {tree, isolated, backend} for a tree hash, or null when the tree is missing or invalid. `isolated` is the tree's
 * assets.json → runtime.crossOriginIsolated (docs/play-origin.md §2); `backend` the valid origins of its backend.json
 * → origins (lib/publish-scan.mjs; an invalid one is left out here, and refused when the kit publishes).
 * Callers must not change the tree: it is shared.
 */
export function servedTree(bucket, treeHash) {
  return remembered(trees, treeHash, async () => {
    const tree = await readTree(bucket, treeHash);
    return tree ? {tree, isolated: await isolatedFlag(bucket, tree), backend: await backendFor(bucket, tree)} : null;
  });
}

async function backendFor(bucket, tree) {
  const entry = resolveTreePath(tree, BACKEND_FILE);
  if (!entry || entry.bytes > 64 * 1024) return [];
  const bytes = await blobBytes(bucket, entry.sha256);
  if (!bytes) return [];
  try { return backendOrigins(JSON.parse(new TextDecoder().decode(bytes))).origins; } catch { return []; }
}

async function isolatedFlag(bucket, tree) {
  const entry = resolveTreePath(tree, MANIFEST_PATH);
  if (!entry) return false;
  const bytes = await blobBytes(bucket, entry.sha256);
  if (!bytes) return false;
  try { return JSON.parse(new TextDecoder().decode(bytes))?.runtime?.crossOriginIsolated === true; } catch { return false; }
}

/**
 * A blob's bytes (lib/tree-store.mjs readBlobBytes), from memory when this instance read it lately. Files up to
 * BLOB_CACHE_FILE_BYTES are kept. Every call returns its own copy, since a response stream may take over the buffer.
 */
export async function blobBytes(bucket, sha256) {
  const hit = blobs.get(sha256);
  if (hit) return hit.slice();
  const bytes = await readBlobBytes(bucket, sha256);
  if (bytes && bytes.byteLength <= BLOB_CACHE_FILE_BYTES) blobs.set(sha256, bytes.slice());
  return bytes;
}

/** Empties every cache (tests). */
export function clearPlayCaches() { versions.clear(); trees.clear(); blobs.clear(); }
