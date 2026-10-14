// Tripo's API (v3), with the person's own key from TRIPO_API_KEY (our name for it: Tripo's docs name no variable).
// Read at the call and nowhere else; never written, logged or returned. Built against the documented API on 2026-10-11:
//   POST https://openapi.tripo3d.com/v3/generation/text-to-model  { prompt, model, face_limit, … } → { code: 0, data: { task_id } }
//   GET  https://openapi.tripo3d.com/v3/tasks/{task_id} → { code: 0, data: { status, progress, output: { model_url }, credits_consumed } }
//   status: queued, running, success, failed, banned, expired, cancelled
// (https://developers.tripo3d.com/en/docs/generation-text-to-model/standard.md, /task-lifecycle.md). NOT RUN against
// the service: tests use a recorded shape (tests/art/tripo.fixture.json). The quick start writes the model as
// "tripo-v3.1" and the reference as "v3.1-20260211": the first real run must settle which is accepted.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TRIANGLE_BUDGET } from '../checks.mjs';

export const BASE = 'https://openapi.tripo3d.com/v3';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function plan(t, row) {
  const budget = TRIANGLE_BUDGET[t.role ?? 'prop'] ?? TRIANGLE_BUDGET.prop;
  // the triangle budget is asked for up front, so the intake check is not the first time the maker hears of it
  return { url: `${BASE}/generation/text-to-model`, method: 'POST', body: { prompt: [t.subject, t.direction].filter(Boolean).join('. ').slice(0, 1024), model: row.defaults.model, face_limit: Math.round(budget * 0.8), texture: true, pbr: true } };
}

export async function make(t, row, { env, fetch, dir, log = () => {}, pollMs = 2000, timeoutMs = 10 * 60 * 1000 }) {
  const key = env.TRIPO_API_KEY;
  if (!key) throw new Error('TRIPO_API_KEY is not set in the environment');
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const p = plan(t, row);
  const made = await (await fetch(p.url, { method: 'POST', headers, body: JSON.stringify(p.body) })).json().catch(() => null);
  if (!made || made.code !== 0 || !made.data?.task_id) throw new Error(`Tripo refused the task${made?.code === 2010 ? ' (not enough credits)' : ''}: ${made?.message ?? 'no message'}`);
  const id = made.data.task_id, until = Date.now() + timeoutMs;
  for (;;) {
    const s = await (await fetch(`${BASE}/tasks/${encodeURIComponent(id)}`, { headers })).json().catch(() => null);
    const d = s?.data ?? {};
    log(`tripo ${id}: ${d.status ?? '?'} ${d.progress ?? 0}%`);
    if (d.status === 'success') {
      const url = d.output?.model_url;
      if (!url) throw new Error('Tripo finished the task without a model (output.model_url)');
      const got = await fetch(url);
      if (!got.ok) throw new Error(`could not download the model from Tripo (${got.status})`);
      const file = path.join(dir, 'from-maker.glb');
      await writeFile(file, Buffer.from(await got.arrayBuffer()));
      return { file, cost: { credits: d.credits_consumed ?? null, task: id } };
    }
    if (['failed', 'banned', 'expired', 'cancelled'].includes(d.status)) throw new Error(`Tripo's task ended as "${d.status}"${d.status === 'banned' ? ': change the words of the request' : ''} (failed and cancelled tasks are not charged)`);
    if (Date.now() > until) throw new Error(`Tripo's task ${id} did not finish in ${timeoutMs / 60000} minutes; it may still finish: check the Tripo console`);
    await sleep(pollMs);
  }
}
