// Reading and writing file-tree versions in the bucket (docs/play-origin.md §1).
// Blobs are content-addressed (blobs/<sha256>) and written idempotently; a tree is canonical JSON
// at trees/<treeHash>.json, its hash computed the same way as everywhere else in Studio (source-record.mjs).
import {hash, canonical} from './source-record.mjs';
import {validateTree, blobKey, treeKey, mimeFor, TREE_FORMAT} from './play-policy.mjs';
import {toBase64} from './manifest.mjs';

/** Object metadata ({size}) or null, without reading the bytes when the bucket supports head() (lib/bucket.mjs). */
export async function objectInfo(bucket, key) {
  if (typeof bucket.head === 'function') return bucket.head(key);
  const object = await bucket.get(key);
  return object ? {key, size: object.size ?? (await object.arrayBuffer()).byteLength} : null;
}

/** Writes bytes at blobs/<sha256> if not already there (content-addressed, so this is idempotent). Returns the sha256. */
export async function writeBlob(bucket, bytes) {
  const sha256 = await hash(bytes);
  const key = blobKey(sha256);
  if (!(await objectInfo(bucket, key))) await bucket.put(key, bytes, {httpMetadata: {contentType: 'application/octet-stream'}});
  return sha256;
}

/** The distinct shas in `list` that have no blob yet, in first-seen order (docs/play-origin.md §4). */
export async function missingBlobs(bucket, list, {concurrency = 16} = {}) {
  const shas = [...new Set(list)], present = new Array(shas.length);
  let next = 0;
  const worker = async () => { for (let i = next++; i < shas.length; i = next++) present[i] = !!(await objectInfo(bucket, blobKey(shas[i]))); };
  await Promise.all(Array.from({length: Math.min(concurrency, shas.length)}, worker));
  return shas.filter((_, i) => !present[i]);
}

/** The bytes of a blob already known to exist in a tree, or null if the object is missing. */
export async function readBlobBytes(bucket, sha256) {
  const object = await bucket.get(blobKey(sha256));
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

/** Validates, canonicalizes and stores a tree from resolved entries ({path,sha256,bytes,mime?}); their blobs must already exist. */
export async function storeTree(bucket, entries) {
  const tree = validateTree({schemaVersion: 1, format: TREE_FORMAT, files: entries});
  const text = canonical(tree);
  const treeHash = await hash(text);
  await bucket.put(treeKey(treeHash), text, {httpMetadata: {contentType: 'application/json'}});
  return {tree, treeHash};
}

/** Builds a tree from raw files ({path, bytes, mime?}), writing each blob idempotently, then stores the tree. */
export async function buildTree(bucket, files) {
  const entries = [];
  for (const f of files) entries.push({path: f.path, sha256: await writeBlob(bucket, f.bytes), bytes: f.bytes.length, mime: f.mime ?? mimeFor(f.path)});
  return storeTree(bucket, entries);
}

/** Reads and integrity-checks a tree by its hash, or null when it is missing, corrupt or invalid. */
export async function readTree(bucket, treeHash) {
  const object = await bucket.get(treeKey(treeHash));
  if (!object) return null;
  const text = await object.text();
  if (await hash(text) !== treeHash) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  try { return validateTree(parsed); } catch { return null; }
}

/** The tree entry at an exact path (already-resolved, canonical paths only), or null. */
export const resolveTreePath = (tree, path) => tree.files.find(f => f.path === path) ?? null;

// ---- A tree "as an archive", for lib/manifest.mjs's readArchiveManifest/manifestProblems/patchArchive -------
// Those pure functions only decode `.content` (base64) for the files they actually parse as JSON (assets.json,
// slot source files, pathRef targets, variant files, audio/VERSION), so only JSON-shaped tree entries need their
// blob fetched here; images, audio, models and other binary assets stay as {path,sha256,bytes} placeholders,
// carried through patchArchive's output unchanged and reused directly as tree entries (see lib/tree-edit.mjs).
const isJsonish = path => /\.json$/i.test(path) || path === 'audio/VERSION';
export async function archiveShim(bucket, tree) {
  const files = await Promise.all(tree.files.map(async f => {
    if (!isJsonish(f.path)) return {path: f.path, sha256: f.sha256, bytes: f.bytes};
    const bytes = await readBlobBytes(bucket, f.sha256);
    return bytes ? {path: f.path, sha256: f.sha256, bytes: f.bytes, content: toBase64(bytes)} : {path: f.path, sha256: f.sha256, bytes: f.bytes};
  }));
  return {schemaVersion: 1, format: 'foundation-source-v1', files};
}
