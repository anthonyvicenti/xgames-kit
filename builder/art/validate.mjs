// The validator for each kind of asset, recorded in the manifest's `validated` list as { by, version, date, ok,
// problems, warnings, facts }. A validator that is not on this machine is recorded as skipped (ok: null) with why.
//   body (3D, gf-humanoid-1)   rig-check: bones, scale, skin, clips, budget, the model judge
//   prop, viewmodel, sky       the model budget (a GLB, triangles for its role, bytes)
//   clip                       a GLB with animations
//   tile, sprite, sprite-sheet the flat judge (gf-flat-1: pixel or drawn) when the style is known; else a picture check
//   texture, card, effect      the picture decodes, its size, see-through or not
//   sound                      the sound gate on one file: heard, its loudest 100 ms at or over the floor, no clipping
import { sharp } from './deps.mjs';
import { modelCheck, pictureCheck, sheetCheck, tileCheck } from './checks.mjs';
import { loadTool } from './toolpaths.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const rec = (by, version, r) => ({ by, version, date: today(), ok: r.ok, problems: r.problems ?? [], warnings: r.warnings ?? [], ...(r.facts ? { facts: r.facts } : {}) });

/** RGBA pixels of a picture file (PNG, JPEG, WebP). */
export async function pixels(bytes) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

const small = f => Object.fromEntries(Object.entries(f ?? {}).filter(([, v]) => typeof v !== 'object' || v === null));

export async function validateBody(file, { role = null } = {}) {
  const t = await loadTool('rigCheck');
  if (!t) return { by: 'rig-check', version: 'gf-humanoid-1', date: today(), ok: null, problems: [], warnings: ['skipped: rig-check is not on this machine (XGAMES_RIG_CHECK)'] };
  const r = await t.mod.rigCheck(file, { role });
  return rec('rig-check', 'gf-humanoid-1', { ok: r.ok, problems: r.errors, warnings: r.warnings, facts: { height: r.metrics?.height, triangles: r.stats?.triangles, joints: r.stats?.joints, materials: r.stats?.materials } });
}

export function validateModel(bytes, { category = 'prop', size = null, measures = null } = {}) {
  if (category === 'clip') {
    const n = measures?.clips?.length ?? 0;
    return rec('clips', '1', { ok: n > 0, problems: n ? [] : ['a clip file with no animations'], facts: { clips: n } });
  }
  // a big set piece (a house, a rock cliff) is scenery, with scenery's budget
  const big = size && Math.max(...size) >= 6;
  const role = category === 'viewmodel' ? 'small' : big ? 'scenery' : 'prop';
  const r = modelCheck(bytes, { role });
  return rec('model-budget', 'triangle-budget-1', { ...r, facts: small(r.facts) });
}

/**
 * A picture's validator. `piece`: a tile that does not repeat (the manifest's use.tile false: an edge, a corner, an end, a
 * part of a bigger picture): gf-flat-1 judges it as a tile without the seam rule.
 */
export async function validatePicture(bytes, { category, style = null, plane = 'side', solid = false, piece = false, tileSet = null } = {}) {
  let pic;
  try { pic = await pixels(bytes); } catch (e) { return rec('picture', '1', { ok: false, problems: [`the picture does not decode: ${e.message}`] }); }
  const flat = style === 'pixel' || style === 'drawn';
  // a backdrop larger than any gf-flat-1 prop (drawn 1024, pixel 128 a side: a house is a prop) is not a prop: it gets the picture check
  const propMax = style === 'pixel' ? 128 : 1024;
  const backdrop = flat && category === 'sprite' && Math.max(pic.width, pic.height) > propMax;
  if (flat && !backdrop && ['tile', 'sprite', 'sprite-sheet'].includes(category)) {
    // the runtime's own judge (gf-flat-1) is the authority; the intake checks beside this file stand in when it is absent
    const j = await loadTool('flatJudge');
    if (j) {
      // a tile set (gf-flat-1 §4b): a kind's 16 edges (blend or connect) or its dressing strip
      const set = category === 'tile' && ['blend', 'connect', 'dress'].includes(tileSet) ? tileSet : null;
      const r = set ? j.mod.judge(set === 'dress' ? 'dress' : 'edges', pic, { style, mode: set }) : j.mod.judge({ tile: 'tile', sprite: 'prop', 'sprite-sheet': 'body' }[category], pic, { style, plane, solid, piece: category === 'tile' && piece === true });
      return rec('flat-judge', 'gf-flat-1', { ok: r.ok, problems: r.errors.map(e => e.message), warnings: r.warnings.map(w => w.message), facts: { cell: r.cell, rows: r.rows, frames: Array.isArray(r.frames) ? r.frames.length : r.frames } });
    }
    if (category === 'tile') { const r = tileCheck(pic, { style, solid: solid === true }); return rec('flat-judge', 'gf-flat-1 (intake checks)', piece === true ? { ...r, ok: !r.problems.filter(p => !/do not continue each other/.test(p)).length, problems: r.problems.filter(p => !/do not continue each other/.test(p)) } : r); }
    if (category === 'sprite') return rec('flat-judge', 'gf-flat-1 (intake checks)', pictureCheck(pic, { style }));
    return rec('flat-judge', 'gf-flat-1 (intake checks)', sheetCheck(pic, { style, plane }));
  }
  const problems = [], warnings = [];
  if (pic.width < 2 || pic.height < 2) problems.push(`the picture is ${pic.width}x${pic.height}`);
  if (Math.max(pic.width, pic.height) > 4096) problems.push(`the picture is ${pic.width}x${pic.height}: keep pictures at 4096 or smaller`);
  const pot = n => (n & (n - 1)) === 0;
  if (backdrop) warnings.push(`${pic.width}x${pic.height}: larger than a ${style} prop (${propMax} px a side), judged as a backdrop picture`);
  if ((category === 'texture' || category === 'tile') && !(pot(pic.width) && pot(pic.height))) warnings.push(`${pic.width}x${pic.height} is not a power of two (mipmaps and KTX2 want one)`);
  let see = 0; for (let i = 3; i < pic.data.length; i += 4) if (pic.data[i] < 250) see++;
  return rec('picture', '1', { ok: !problems.length, problems, warnings, facts: { width: pic.width, height: pic.height, seeThrough: +(see / (pic.width * pic.height)).toFixed(3) } });
}

/** The sound gate on one file's decoded PCM. */
export async function validateSound({ channels, sampleRate, seconds }, { ambient = false } = {}) {
  const gate = await loadTool('soundGate'), meter = await loadTool('meter');
  if (!gate || !meter) return { by: 'sound-gate', version: 'v5', date: today(), ok: null, problems: [], warnings: ['skipped: the sound gate is not on this machine (XGAMES_SOUND_GATE, XGAMES_METER)'], levels: null, peakDbfs: null };
  // a click shorter than the gate's 100 ms block is measured inside one block of silence around it
  const need = Math.ceil(sampleRate * 0.12);
  const padded = channels[0].length >= need ? channels : channels.map(c => { const p = new Float32Array(need); p.set(c); return p; });
  const levels = gate.mod.soundLevels(padded, sampleRate);
  const m = meter.mod.measure(padded, sampleRate, { truePeak: seconds < 60 });
  const problems = [], warnings = [];
  if (m.samplePeakDb === null || m.samplePeakDb < -60) problems.push('nothing is heard: the file peaks under -60 dBFS');
  else if (levels.soundMaxLufs === null || levels.soundMaxLufs < gate.mod.SOUND_FLOOR_LUFS) problems.push(`its loudest 100 ms is ${levels.soundMaxLufs} LUFS, under the gate's floor of ${gate.mod.SOUND_FLOOR_LUFS}: too quiet to hear clearly at the kit's levels`);
  if (m.clippedSamples > 0) problems.push(`${m.clippedSamples} samples clip at full scale`);
  else if (m.truePeakDb !== null && m.truePeakDb > 0) warnings.push(`true peak ${m.truePeakDb} dBTP is over 0`);
  if (!ambient && seconds > 30) warnings.push(`${seconds.toFixed(1)} s long for a sound effect`);
  if (m.hfRatio > 0.25) warnings.push(`harsh: ${Math.round(m.hfRatio * 100)}% of its energy is over 4 kHz`);
  const r = rec('sound-gate', 'v5', { ok: !problems.length, problems, warnings, facts: { soundMaxLufs: levels.soundMaxLufs, samplePeakDb: m.samplePeakDb, truePeakDb: m.truePeakDb, hfRatio: m.hfRatio } });
  return { ...r, levels, peakDbfs: m.samplePeakDb };
}
