// One secret store for the kit (builder/lib/secret-store.mjs). The games.fun sign-in (builder/lib/credentials.mjs, `gamesfun login`)
// and the backend's sign-ins (`gamesfun backend connect`) share its folder and its keychain service, so their names
// must never meet: a login must not overwrite a backend token, nor the other way round.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { credentialsFile, loadSecret, saveSecret, secretName } from '../builder/lib/credentials.mjs';
import { getSecret, setSecret } from '../builder/lib/secret-store.mjs';

const BACKEND_NAMES = ['backend-supabase', 'backend-supabase-app', 'supabase-db-abcdefghijklmnopqrst', 'railway-token', 'railway-client'];

test('a games.fun sign-in and the backend sign-ins keep apart in the one store', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gf-secrets-'));
  try {
    const env = { GAMESFUN_CONFIG_DIR: dir, GAMESFUN_SECRET_STORE: 'file' };
    const key = 'games.fun https://games-fun-liard.vercel.app';
    assert.match(secretName(key), /^publish-[0-9a-f]{16}$/);
    assert.ok(!BACKEND_NAMES.includes(secretName(key)) && !BACKEND_NAMES.some(n => n.startsWith('publish-')), 'no backend name is a publish name');
    for (const n of BACKEND_NAMES) setSecret(n, `backend:${n}`, { env });
    await saveSecret(key, 'gfk_publish_token', { email: 'a@b.c' }, { env });
    await saveSecret('games.fun http://127.0.0.1:5191', 'gfk_local_token', {}, { env });
    for (const n of BACKEND_NAMES) assert.equal(getSecret(n, { env }), `backend:${n}`, `${n} kept after the logins`);
    setSecret('backend-supabase', 'backend:again', { env });
    assert.equal((await loadSecret(key, { env })).secret, 'gfk_publish_token', 'the login kept after a backend connect');
    assert.equal((await loadSecret('games.fun http://127.0.0.1:5191', { env })).secret, 'gfk_local_token');
    // every secret is a file of the one store; the publish index holds none
    const files = (await readdir(path.join(dir, 'secrets'))).sort();
    assert.equal(files.length, BACKEND_NAMES.length + 2);
    assert.ok(!(await readFile(credentialsFile({ env }), 'utf8')).includes('gfk_'), 'credentials.json holds no secret');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('GAMESFUN_CREDENTIALS=file (the publish switch) still forces the file store', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gf-secrets-'));
  try {
    const env = { GAMESFUN_CONFIG_DIR: dir, GAMESFUN_CREDENTIALS: 'file' };
    const r = await saveSecret('games.fun https://x.test', 'gfk_x', {}, { env });
    assert.equal(r.store, 'file');
    assert.equal(await readFile(path.join(dir, 'secrets', `${secretName('games.fun https://x.test')}.secret`), 'utf8'), 'gfk_x');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
