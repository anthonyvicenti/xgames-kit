// The pose check's page (lookdev/forge-checks.mjs, verify check 19 on forge): a body posed by the forge core's own
// animation (forge-anim) through clips at given times, drawn GPU-skinned by the forge renderer; for each pose, the
// bones (model space, by joint name) and the skinned vertices as the GPU made them against the CPU's sum with the same
// matrices. The kit comes from ?kit= (a game's own gf/forge, or the dev kit); the files from ?files=.
const Q = new URLSearchParams(location.search);
const KIT = Q.get('kit') ?? '/kit';
const FILES = Q.get('files') ?? '/library';
const { createHost } = await import(`${KIT}/host.js`);
const { createRender } = await import(`${KIT}/render.js`);
const bytes = async f => { const r = await fetch(f.startsWith("/") ? f : `${FILES}/${f}`); if (!r.ok) throw new Error(`${f}: ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
const host = await createHost(document.getElementById('c'));
const r = createRender(host);
host.eyes(false);
host.pose(0, 1.2, 4.2, 0, -0.08);
const frame = () => new Promise(res => requestAnimationFrame(() => { host.render(performance.now() / 1000); res(); }));
const clipSets = new Map();
/** Where a set of vertices is: count, centroid, box (x y z triples). */
const shape = v => { const n = v.length / 3, c = [0, 0, 0], min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const x = v[i * 3 + a]; c[a] += x; if (x < min[a]) min[a] = x; if (x > max[a]) max[a] = x; } return { count: n, centroid: c.map(x => x / Math.max(n, 1)), min, max }; };

/** Pose `body` (a file) through `samples` ([[clip, t], …]) with `clips` (a file). → {names, poses: [{clip, t, bones (16 floats a joint), gpuError}]} */
window.__pose = async ({ body, clips, samples }) => {
  if (!clipSets.has(clips)) clipSets.set(clips, await host.animClips(await bytes(clips)));
  const set = clipSets.get(clips);
  const b = await r.body(await bytes(body), 0);
  const names = host.animBones(b.body);
  const id = r.puppet(b.body, set, { at: [0, 0, 0] });
  const poses = [];
  for (const [clip, t] of samples) {
    if (!r.pose(id, clip, { t, rate: 0 })) { poses.push({ clip, t, missing: true }); continue; }
    await frame(); await frame();
    const bones = Array.from(r.bones(id));
    const cap = await r.capture(id);
    poses.push({ clip, t, bones, gpuError: cap.maxError, vertices: cap.count, gpuVertices: cap.gpu.length / 3, cpuVertices: cap.cpu.length / 3, spread: (s => s.max[1] - s.min[1])(shape(cap.gpu)), shape: shape(cap.gpu) });
  }
  r.remove(id);
  return { names, poses, info: host.info() };
};
window.__ready = true;
