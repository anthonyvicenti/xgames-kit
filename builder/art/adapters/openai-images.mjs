// OpenAI's Images API, with the person's own OPENAI_API_KEY from the environment (read here, at the call, and nowhere
// else; never written, logged or returned). Built against the documented API on 2026-10-11:
//   POST https://api.openai.com/v1/images/generations  { model, prompt, size, quality, background, output_format, n }
//   → { data: [{ b64_json }], usage: { input_tokens, output_tokens, total_tokens } }
// (https://developers.openai.com/api/docs/guides/image-generation). NOT RUN against the service: tests use a recorded
// shape (tests/art/openai-images.fixture.json).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ENDPOINT = 'https://api.openai.com/v1/images/generations';

/** The request this ticket becomes. No call is made. */
export function plan(t, row) {
  const tile = t.kind === 'tile';
  const prompt = [
    tile ? `A seamless, tileable square ground texture seen from straight above: ${t.subject}.` : `${t.subject}. One object, centred, all of it in frame, nothing else in the picture.`,
    'Style: clean drawn game art, flat or softly shaded colour, clear outlines.',
    t.direction ? `Art direction: ${t.direction}.` : '',
    t.palette?.length ? `Colours: ${t.palette.join(', ')}.` : '',
    tile ? 'It fills the whole square edge to edge and repeats without a visible seam. No border, no text.' : 'Transparent background. No text, no ground, no shadow on the floor.',
  ].filter(Boolean).join(' ');
  return { url: ENDPOINT, method: 'POST', body: { model: row.defaults.model, prompt, size: '1024x1024', quality: row.defaults.quality, background: tile ? 'opaque' : 'transparent', output_format: 'png', n: 1 } };
}

export async function make(t, row, { env, fetch, dir }) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set in the environment');
  const p = plan(t, row);
  const res = await fetch(p.url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(p.body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`OpenAI Images refused the request (${res.status}): ${json?.error?.message ?? 'no message'}`);
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI Images answered without a picture (data[0].b64_json)');
  const file = path.join(dir, 'from-maker.png');
  await writeFile(file, Buffer.from(b64, 'base64'));
  return { file, cost: { tokens: json.usage ?? null, note: 'billed to the key\'s account by tokens' } };
}
