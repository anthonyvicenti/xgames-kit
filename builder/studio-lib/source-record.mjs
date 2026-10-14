// Portable source containers contain data only. Studio never extracts or executes them.
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 256 * 1024;
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
export const bytes = value => new TextEncoder().encode(value);
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? bytes(value) : value)), n => n.toString(16).padStart(2, '0')).join('');
}
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export function sourcePath(path) {
  if (typeof path !== 'string' || path.length > 200 || !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path)) invalid('Invalid source path.');
  for (const part of path.split('/')) if (!part || part === '.' || part === '..' || part.endsWith('.') || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) || ['.git', '.env', 'node_modules'].includes(part.toLowerCase())) invalid('Unsafe source path.');
  return path;
}
export async function validateSource(archive) {
  if (archive?.schemaVersion !== 1 || archive.format !== 'foundation-source-v1' || !Array.isArray(archive.files) || !archive.files.length || archive.files.length > 256) invalid('Invalid source archive.');
  const serialized = canonical(archive);
  if (bytes(serialized).length > MAX_SOURCE_BYTES) invalid('Source archive exceeds 8 MiB.');
  const paths = new Set(); let total = 0;
  for (const file of archive.files) {
    const path = sourcePath(file.path).toLowerCase();
    if (paths.has(path) || [...paths].some(other => other.startsWith(path + '/') || path.startsWith(other + '/'))) invalid('Duplicate or conflicting source path.');
    paths.add(path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_SOURCE_BYTES || typeof file.content !== 'string' || file.content.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) invalid('Invalid source file encoding.');
    const raw = Uint8Array.from(atob(file.content), c => c.charCodeAt(0)); total += raw.length;
    if (raw.length !== file.bytes || total > MAX_SOURCE_BYTES || await hash(raw) !== file.sha256) invalid('Source file integrity check failed.');
  }
  for (const required of ['foundation.lock.json', 'adaptation-plan.json']) if (!paths.has(required)) invalid(`Missing ${required}.`);
  return serialized;
}
function sourceJSON(archive, name) {
  if ((archive.files.find(f => f.path === name)?.bytes ?? Infinity) > 64 * 1024) invalid(`${name} exceeds 64 KiB.`);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(archive.files.find(f => f.path === name).content), c => c.charCodeAt(0)))); }
  catch { invalid(`Invalid ${name}.`); }
}
// The foundation lock and adaptation plan every retained source carries (a source archive, or a file tree:
// lib/studio.mjs completeTree reads the same two files from the tree's blobs).
export function checkLockAndPlan(lock, plan, manifestLock) {
  if (!lock || lock.schemaVersion !== 1 || typeof lock.id !== 'string' || !lock.id || typeof lock.version !== 'string' || !lock.version || !lock.adapter || canonical(lock) !== canonical(manifestLock)) invalid('Build manifest and source foundation locks differ.');
  if (!plan || typeof plan.brief !== 'string' || !plan.brief || !Array.isArray(plan.requirements) || !plan.requirements.length || typeof plan.selectionRationale !== 'string' || !plan.selectionRationale || !Array.isArray(plan.missingFeatures)) invalid('Source needs an adaptation plan with brief, requirements, selection rationale and missing-feature work.');
}
export async function prepareSource(input, htmlHash) {
  if (input.sourceArchive == null && input.buildManifest == null) return null;
  if (!input.sourceArchive || !input.buildManifest) invalid('Source and build manifest must be delivered together.');
  const source = await validateSource(input.sourceArchive), manifest = canonical(input.buildManifest);
  const m = input.buildManifest;
  if (bytes(manifest).length > MAX_MANIFEST_BYTES || m.schemaVersion !== 1 || m.artifactKind !== 'inline-html' || m.artifact?.sha256 !== htmlHash) invalid('Build manifest must match the delivered HTML.');
  const lock = sourceJSON(input.sourceArchive, 'foundation.lock.json');
  const plan = sourceJSON(input.sourceArchive, 'adaptation-plan.json');
  checkLockAndPlan(lock, plan, m.foundationLock);
  return { source, manifest, sourceHash: await hash(source), manifestHash: await hash(manifest), lock, plan };
}
