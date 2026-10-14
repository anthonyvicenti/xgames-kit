// Headless Chrome on Linux gets no hardware GL unless it is told to use ANGLE on EGL (and, on NVIDIA, which EGL vendor
// to load). A plain probe then says "software" on a machine with a good card. `probeWithRetry` asks once plainly and,
// on Linux only, once more with those flags; when the second finds the card, doctor saves the flags (`saveGpuEnv`) and
// `runTool` hands them to verify, play and every other browser tool (`savedGpuEnv`), so a run sees what doctor saw.
// Windows and macOS: Chrome's own defaults already pick the hardware there (ANGLE on Direct3D 11 / Metal), and no
// issue like this one has been seen on them, so nothing changes there. (Not measured on either; see doctor's fix lines.)
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STATE } from './paths.mjs';

export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;
export const EGL_FLAGS = '--use-gl=angle --use-angle=gl-egl';
export const NVIDIA_EGL = '/usr/share/glvnd/egl_vendor.d/10_nvidia.json';
const FILE = path.join(STATE, 'gpu-env.json');

/** The env additions that give headless Chrome hardware GL on this system, or null (not Linux, or the person already chose a GL backend). */
export function hardwareGlEnv({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'linux') return null;
  const theirs = String(env.CHROME_ARGS ?? '').trim();
  if (/--use-(gl|angle)=/.test(theirs)) return null;
  const add = { CHROME_ARGS: [theirs, EGL_FLAGS].filter(Boolean).join(' ') };
  if (!env.__EGL_VENDOR_LIBRARY_FILENAMES && exists(NVIDIA_EGL)) add.__EGL_VENDOR_LIBRARY_FILENAMES = NVIDIA_EGL;
  return add;
}

const isSoftware = g => g.ok && (!g.webgl || SOFTWARE_RENDERER.test(g.renderer ?? ''));

/**
 * `probe(env)` → { ok, webgl, renderer, ... }. Plain first; when that reports software (or no WebGL) on Linux, again with
 * the hardware flags. → the answer that stands, plus `viaFlags` (the env additions that found the card, else null) and
 * `retried` (true when a second probe ran).
 */
export async function probeWithRetry(probe, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const first = await probe(env);
  if (!isSoftware(first)) return { ...first, viaFlags: null, retried: false };
  const add = hardwareGlEnv({ platform, env, exists });
  if (!add) return { ...first, viaFlags: null, retried: false };
  const second = await probe({ ...env, ...add });
  if (second.ok && second.webgl && !isSoftware(second)) return { ...second, viaFlags: add, retried: true };
  return { ...first, viaFlags: null, retried: true };
}

/** Remember (or forget, with null) the flags doctor found. Best effort: a read-only folder only loses the convenience. */
export async function saveGpuEnv(add) {
  try {
    if (!add) return await rm(FILE, { force: true });
    await mkdir(STATE, { recursive: true });
    await writeFile(FILE, JSON.stringify(add) + '\n');
  } catch {}
}

/** The saved flags as env additions for a child process, with the person's own settings winning. */
export function savedGpuEnv({ env = process.env, platform = process.platform, file = FILE } = {}) {
  if (platform !== 'linux') return {};
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (/--use-(gl|angle)=/.test(env.CHROME_ARGS ?? '')) return {};
    const out = {};
    if (saved.CHROME_ARGS) out.CHROME_ARGS = [env.CHROME_ARGS, saved.CHROME_ARGS.replace(/^.*?(--use-gl=)/, '$1')].filter(Boolean).join(' ');
    if (saved.__EGL_VENDOR_LIBRARY_FILENAMES && !env.__EGL_VENDOR_LIBRARY_FILENAMES) out.__EGL_VENDOR_LIBRARY_FILENAMES = saved.__EGL_VENDOR_LIBRARY_FILENAMES;
    return out;
  } catch { return {}; }
}
