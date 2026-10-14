// One file → what the library records about it: format, preview, measured use and budgets, the validator's verdict
// and the style signature. Ingest and the importer of the old kit libraries both go through here.
//   analyze(bytes, { path, category, renderer, hints }) → { format, dimension, preview, use, budgets, validated, signature, facts }
import { sharp } from './deps.mjs';
import { detect } from './detect.mjs';
import { modelSignature, pictureSignature, soundSignature } from './signature.mjs';
import { pixels, validateBody, validateModel, validatePicture, validateSound } from './validate.mjs';

export const TOOL = 'art ingest 1';
const today = () => new Date().toISOString().slice(0, 10);

/** A picture fitted into a square preview: hard pixels stay hard (nearest) when the picture is small. */
export async function picturePreview(bytes, { size = 256, hard = false } = {}) {
  const meta = await sharp(bytes).metadata();
  const small = Math.max(meta.width ?? 0, meta.height ?? 0) <= size / 2;
  return sharp(bytes).ensureAlpha()
    .resize({ width: size, height: size, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: hard || small ? 'nearest' : 'lanczos3' })
    .png({ compressionLevel: 9 }).toBuffer();
}

const round = (v, n = 3) => (typeof v === 'number' ? +v.toFixed(n) : v);

const num = v => typeof v === 'number' && Number.isFinite(v);

/** The contract's signature (pack.schema $defs/signature) from the measured one. */
export function contractSignature(sig) {
  const out = { measured: today(), tool: TOOL };
  if (!sig) return out;
  const p = sig.palette;
  if (p && p.size >= 1) {
    out.palette = { size: Math.min(4096, p.size), hues: (p.top ?? []).map(t => t.colour).slice(0, 16) };
    if (num(p.saturation)) out.palette.saturation = round(Math.min(1, p.saturation));
    if (num(p.lightness)) out.palette.value = round(p.lightness);
    if (p.families?.length) out.palette.families = p.families.slice(0, 12);
    if (num(p.exact)) out.palette.exact = p.exact;
    if (num(p.grey)) out.palette.grey = p.grey;
  }
  if (num(sig.trianglesPerMetre)) out.trianglesPerMetre = sig.trianglesPerMetre;
  if (num(sig.texelsPerMetre)) out.texelsPerMetre = sig.texelsPerMetre;
  if (num(sig.texturedShare)) { out.texturedShare = Math.min(1, sig.texturedShare); out.textured = sig.texturedShare >= 0.5; }
  if (sig.outline) out.outline = { present: !!sig.outline.present, ...(sig.outline.how ? { how: sig.outline.how } : {}), ...(num(sig.outline.share) ? { share: sig.outline.share } : {}) };
  const b = sig.body;
  if (b?.headsTall) {
    out.proportions = `${b.headsTall} heads tall; hips at ${Math.round(b.hipShare * 100)}% of the height${b.shoulderShare ? `; shoulders ${Math.round(b.shoulderShare * 100)}% of it` : ''}`;
    out.body = Object.fromEntries(['headsTall', 'hipShare', 'shoulderShare', 'widthShare'].filter(k => num(b[k])).map(k => [k, b[k]]));
  }
  if (sig.sound) out.sound = { seconds: sig.sound.seconds, ...(num(sig.sound.peakDbfs) ? { peakDbfs: Math.min(0, sig.sound.peakDbfs) } : {}), ...(num(sig.sound.soundMaxLufs) ? { soundMaxLufs: sig.sound.soundMaxLufs } : {}) };
  return out;
}

/** A pack's contract signature from its assets' measured ones (signature.mjs packSignature). */
export function contractPackSignature(ps, assets) {
  const out = { measured: today(), tool: TOOL };
  const w = new Map();
  for (const a of assets) for (const t of a.signature?.palette?.top ?? []) w.set(t.colour, (w.get(t.colour) ?? 0) + t.share);
  if (num(ps.paletteSize)) {
    out.palette = { size: Math.max(1, Math.round(ps.paletteSize)), hues: [...w.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([c]) => c) };
    if (num(ps.saturation)) out.palette.saturation = round(Math.min(1, ps.saturation));
    if (num(ps.lightness)) out.palette.value = round(ps.lightness);
    if (ps.families?.length) out.palette.families = ps.families.slice(0, 12);
    if (num(ps.grey)) out.palette.grey = ps.grey;
  }
  if (num(ps.trianglesPerMetre)) out.trianglesPerMetre = ps.trianglesPerMetre;
  if (num(ps.texelsPerMetre)) out.texelsPerMetre = ps.texelsPerMetre;
  if (num(ps.texturedShare)) { out.texturedShare = ps.texturedShare; out.textured = ps.texturedShare >= 0.5; }
  if (num(ps.outlineShare)) out.outline = { present: ps.outlineShare >= 0.5, share: ps.outlineShare };
  if (num(ps.headsTall)) { out.proportions = `bodies: median ${ps.headsTall} heads tall`; out.body = { headsTall: ps.headsTall, ...(num(ps.hipShare) ? { hipShare: ps.hipShare } : {}) }; }
  return out;
}

/**
 * analyze(bytes, opts)
 *   path        the file on disk (rig-check and the renderer read files)
 *   category    what it is (body, prop, texture, sound, …); the caller decides, ingest guesses when not told
 *   renderer    an open renderer (render.mjs) for 3D, KTX2 and sounds
 *   hints       { style: 'pixel'|'drawn', plane, texelsPerMetre, role, poseBody (a body GLB path for a clip preview), ambient }
 */
export async function analyze(bytes, { path: file, category, renderer, hints = {} }) {
  const kind = detect(bytes);
  if (!kind) throw new Error('not a file the library knows (GLB, PNG, JPEG, WebP, KTX2, OGG, WAV, MP3)');
  const out = { format: kind.format, dimension: kind.dimension, preview: null, use: {}, budgets: {}, validated: [], signature: null, facts: {} };

  if (kind.dimension === '3d') {
    if (kind.format !== 'glb') throw new Error('a model must be a GLB (binary glTF) with its textures inside');
    if (!renderer) throw new Error('a model needs the preview renderer');
    let { png, measures: m } = await renderer.model(file, { view: category === 'body' ? 'front' : undefined });
    if (category === 'clip' && hints.poseBody) {
      const c = await renderer.clip(file, hints.poseBody);
      png = c.png; m = { ...m, clips: c.measures.clips, clipSeconds: c.measures.seconds };
    }
    out.preview = png;
    out.facts = { measures: { ...m, colours: undefined } };
    const sig = modelSignature(m);
    out.signature = sig;
    if (m.triangles) {
      out.use.size = m.size.map(v => round(v));
      if (category === 'body') out.use.height = round(m.size[1]);
    }
    const texMax = Math.max(0, ...m.textures.map(t => Math.max(...t.split('x').map(Number))));
    out.budgets = { triangles: m.triangles, textures: m.textures.length, ...(texMax ? { textureMax: texMax } : {}), materials: m.materials, ...(m.joints ? { joints: m.joints } : {}) };
    if (category === 'body') out.validated.push(await validateBody(file, { role: hints.role ?? null }));
    else out.validated.push(validateModel(bytes, { category, size: m.size, measures: m }));
    if (category === 'clip') out.use.seconds = round(Math.max(0, ...(m.clipSeconds ?? [0])));
    out.facts.clips = m.clips;
  } else if (kind.dimension === '2d') {
    let picBytes = bytes;
    if (kind.format === 'ktx2') {
      if (!renderer) throw new Error('a KTX2 picture needs the preview renderer');
      const k = await renderer.ktx2(file);
      picBytes = k.png;
      out.facts.size = [k.width, k.height];
    } else if (kind.format === 'svg') {
      picBytes = await sharp(bytes, { density: 192 }).png().toBuffer();
    }
    const pic = await pixels(picBytes);
    out.preview = await picturePreview(picBytes, { hard: hints.style === 'pixel' });
    out.signature = pictureSignature(pic, { texelsPerMetre: hints.texelsPerMetre ?? null });
    if (hints.texelsPerMetre) out.use.texelsPerMetre = hints.texelsPerMetre;
    out.budgets = { textures: 1, textureMax: Math.max(...(out.facts.size ?? [pic.width, pic.height])) };
    if (category === 'sprite-sheet') { const c = Math.round(pic.width / 6); out.use.frames = { cell: [c, c], names: ['idle', 'walk1', 'walk2', 'air', 'act', 'down'] }; }
    const flatCategory = category === 'picture' ? 'sprite' : category;
    out.validated.push(await validatePicture(picBytes, { category: flatCategory, style: hints.style ?? null, plane: hints.plane ?? 'side', solid: hints.solid ?? false, piece: hints.tile === false, tileSet: hints.tileSet ?? null }));
  } else if (kind.dimension === 'audio') {
    if (!renderer) throw new Error('a sound needs the preview renderer (it decodes in the browser)');
    const a = await renderer.audio(file);
    out.preview = a.png;
    const v = await validateSound(a, { ambient: !!hints.ambient });
    out.use.seconds = round(a.seconds);
    if (hints.loop !== undefined) out.use.loop = hints.loop;
    const { levels, peakDbfs, ...record } = v;
    out.validated.push(record);
    out.signature = levels ? soundSignature({ ...a, levels, peakDbfs }) : null;
  } else if (kind.dimension === 'font') {
    if (!renderer) throw new Error('a font needs the preview renderer');
    out.dimension = '2d';
    out.preview = (await renderer.font(file)).png;
    out.signature = null; // a font has no style measure yet; its kind fit is judged on the sheet
  } else {
    throw new Error(`${kind.format} files are not taken by the library yet`);
  }
  if (out.preview) out.preview = await shrinkPreview(out.preview);
  return out;
}

/** A preview kept small for git: a 256-colour palette PNG (hard pixel art keeps its exact colours). */
export async function shrinkPreview(png) {
  const small = await sharp(png).png({ palette: true, quality: 100, effort: 10, compressionLevel: 9 }).toBuffer();
  return small.length < png.length ? small : png;
}

/** The contract's `validated` entry (by, version, ok, date, report) from a validator's record. */
export function contractValidated(v) {
  const BY = { 'rig-check': 'rig-check', 'flat-judge': 'flat-judge', 'sound-gate': 'sound-gate', 'model-budget': 'budget', clips: 'clip-check', picture: 'picture-check' };
  if (v.ok === null) return null; // a validator that did not run is not a verdict
  const report = { ...(v.problems.length ? { problems: v.problems } : {}), ...(v.warnings.length ? { warnings: v.warnings.slice(0, 12) } : {}), ...(v.facts ? { facts: v.facts } : {}) };
  return { by: BY[v.by] ?? 'budget', version: String(v.version), ok: v.ok, date: v.date, report };
}
