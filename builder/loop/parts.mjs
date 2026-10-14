// The optional parts a game may carry beyond its play: an economy (real money on devnet, kept in the game's
// gamesfun.json) and a backend (something kept beyond one browser, on the person's own account). Neither is ever forced
// (the creator: web3 is on by default, GAMESFUN_WEB3=0 turns it off; an economy or a backend is offered at the pitch and
// asked about). In the loop each part runs in the order its tools have:
//
//   economy   decide   the pitch offers it (pitch.v2 `offers.economy`) and asks (`about: "economy"`), or the person's
//                      own words ask for it (`from`); their choice keeps or drops it from the spec (applyPartAnswers)
//             check    after the build round: the economy in gamesfun.json passes the kit's checker (economy_check);
//                      a refusal is a failing set, repaired under the stop rule like a gate
//             publish  at delivery: the approval link (economy_publish); nothing is signed and delivery never waits
//   backend   use      the person connects their own account when they like (backend_use, `gamesfun backend connect`)
//             check    after the build round: no secret in the game, row-level security on every table (backend_check)
//                      at delivery: connected, or playable in the browser and what to connect
//
// A host turns a part on by passing its adapter (openLoop host.parts: {economy?, backend?}); a part it does not pass is
// off, and a pitch, a spec or a question that names it is refused with the reason. The ledger and the pitch may ask
// about a part that is on (ledger.mjs extraAsks). Pure: the adapters do the reading and the writing.

export const PART_IDS = ['economy', 'backend'];
/** The steps the parts add to the loop, in their order (order.mjs STEPS has them after fix). */
export const PART_STEPS = ['economy', 'backend'];
export const ECONOMY_FILE = 'gamesfun.json';
export const ECONOMY_REF = Object.freeze({ in: ECONOMY_FILE });

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const list = v => (Array.isArray(v) ? v : []);
const flat = s => String(s ?? '').toLowerCase().replace(/[‘’]/g, '\'').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const quoted = (q, words) => { const f = flat(q); return f.length >= 2 && flat(words).includes(f); };
const joinWords = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const sentence = s => { const t = String(s ?? '').trim().replace(/\s+/g, ' '); return t && !/[.!?]$/.test(t) ? `${t}.` : t; };

// ---------------------------------------------------------------- what the person's words say
/** Words that can only mean real money on a chain: the economy is theirs to keep, never asked again. */
export const SAID_ECONOMY = /\b(\d+(\.\d+)?\s*(sol|usdc)|sol|usdc|lamports?|devnet|wallets?|on[\s-]?chain|crypto|nfts?|stak(e|es|ed|ing)|house\s+edge|real\s+money|(an?|the|its|my|our)\s+economy|token[\s-]?2022|(our|my|the\s+game'?s)\s+(game\s+)?(token|coin))\b/i;
/** Words that can only mean something kept beyond one browser. */
export const SAID_BACKEND = /\b(back[\s-]?ends?|databases?|supabase|firebase|railway|server[\s-]side|(my|our|your|its|own|dedicated|real)\s+(own\s+)?(game\s+)?servers?|cloud[\s-]?sav(e|es|ed|ing)|across\s+(all\s+)?(devices|phones|computers|browsers)|(on|from)\s+any\s+(device|phone|computer)|(global|online|world(wide)?|all[\s-]time|public|shared)\s+(leader\s?boards?|high[\s-]?scores?|rankings?|score\s?boards?)|(player|user)\s+accounts?|log[\s-]?ins?|logs?\s+in|sign[\s-]?(in|up)s?|signs?\s+(in|up)|player[\s-]to[\s-]player\s+trad(e|es|ing)|anti[\s-]?cheat|cheat[\s-]?proof)\b/i;
export const SAID = { economy: SAID_ECONOMY, backend: SAID_BACKEND };
/** An option that leaves the part out ("No economy, just the game", "No backend, play in the browser"). */
export const DROP_OPTION = /\b(no|not|without|none|skip|leave|drop|just|only)\b/i;
export const PRICE_SOL = /\d+(\.\d+)?\s*SOL\b/i;

// ---------------------------------------------------------------- the backend's words
export const BACKEND_NEEDS = ['leaderboard', 'saves', 'accounts', 'server-rules', 'trading'];
export const NEED_WORDS = {
  leaderboard: { what: 'a leaderboard across players', off: 'the leaderboard says it needs your {kind}' },
  saves: { what: 'progress that follows a player to any device', off: 'progress is kept in this browser only, and the game says so' },
  accounts: { what: 'player accounts', off: 'everyone plays as a guest, and the game says so' },
  'server-rules': { what: 'a server that decides what counts (scores, wins)', off: 'the browser decides results, and the game says they are not checked' },
  trading: { what: 'trading between players', off: 'trading says it needs your {kind}' },
};
/** What each provider costs the person, as their own pages said on 2026-10-12. Prices go stale. */
export const PROVIDERS = {
  supabase: { label: 'Supabase', kind: 'database', cost: 'Supabase\'s free tier: 2 active projects, and a free project pauses after a week with no visits; Pro is from $25 a month' },
  railway: { label: 'Railway', kind: 'host', cost: 'Railway\'s free plan: $1 of credit a month; Hobby is $5 a month, and a small always-on game server costs a few dollars a month' },
};
export const DEFAULT_PROVIDER = { database: 'supabase', host: 'railway' };
const KIND_WORD = { database: 'database', host: 'server' };
export const providerOf = b => b?.provider ?? DEFAULT_PROVIDER[b?.kind] ?? null;
export const connectCommand = provider => `npx gamesfun backend connect ${provider}`;
const kindWord = b => KIND_WORD[b?.kind] ?? 'backend';
const offWords = b => list(b?.needs).filter(n => NEED_WORDS[n]).map(n => NEED_WORDS[n].off.replace('{kind}', kindWord(b)));
/** What a game whose spec keeps an economy pays for a clear needs said: the kit cannot tell a real win from a faked one. */
export const KEEPER_HOLE = 'Checking that a player really beat the game is up to you, on your own server or backend: the kit cannot tell a real win from a faked one, so without that a player who paid for an attempt can claim a clear they didn\'t make, once per attempt, up to the caps.';

/** What the person reads about an offered part, from its fields: the same words in every host; the agent never words them. */
export function offerWords(part, o, { asked = false } = {}) {
  if (!isObj(o)) return '';
  if (part === 'economy') return [
    `This game comes with an economy on devnet: ${sentence(o.what)}`,
    `Putting it live costs ${String(o.price ?? '').trim()}, approved in your own wallet; nothing is signed for you.`,
    ...(asked ? [] : ['Say "no economy" and the game is built without it.']),
    ...(o.clears ? [KEEPER_HOLE] : []),
  ].join(' ');
  const p = PROVIDERS[providerOf(o)], keeps = joinWords(list(o.needs).filter(n => NEED_WORDS[n]).map(n => NEED_WORDS[n].what)), off = offWords(o);
  return [
    `This game keeps ${keeps || 'something beyond one browser'} in a ${kindWord(o)} on your own ${p ? `${p.label} account` : 'account with a provider you choose'}: you sign in there yourself, and it is your account and your bill${p ? ` (${p.cost})` : ''}.`,
    `Until you connect it, the game plays in the browser${off.length ? `: ${joinWords(off)}` : ''}.`,
    ...(asked ? [] : ['Say "no backend" and it is built to play in the browser only.']),
  ].join(' ');
}

/** The spec value a kept part takes: the economy by reference (never a copy), the backend inline. */
export const specValueOf = (part, offer) => (part === 'economy' ? { ...ECONOMY_REF } : { kind: offer.kind, needs: [...list(offer.needs)], ...(offer.provider ? { provider: offer.provider } : {}) });

// ---------------------------------------------------------------- the pitch: decide
/** The pitch prompt's lines for the parts this host has on (messages.mjs pitchMessage). */
export function pitchPartLines(on) {
  const out = [];
  if (on.includes('economy')) out.push(
    '**An economy** (web3 is on here: the `economy_*` tools and the `gamesfun-economy` skill): real money on devnet, what players pay, what they can win and where it goes, kept in the game\'s `gamesfun.json`. Never forced:',
    '- their words ask for one (SOL, a wallet, staking, real money, an economy, their own token): `offers.economy` with those words copied exactly into `from`, and no question; card 1\'s spec has `"economy": {"in": "gamesfun.json"}`.',
    '- their words leave it open (a shop, a prize pot, tickets, rewards) or you think one would fit: `offers.economy` without `from`, and one question `{"about": "economy"}` with an option that keeps it and one that leaves it out ("No economy, just the game"); card 1\'s spec follows the question\'s default.',
    '- `offers.economy`: `what` (one sentence: what players pay and can win), `price` (what going live costs in SOL, from `economy_cost`), `clears` (true when it pays for a result the game reports after a paid attempt).',
  );
  if (on.includes('backend')) out.push(
    '**A backend** (the person\'s own database or server; most games need none: a best score in the browser\'s storage is not one, and neither is playing with friends online). Never forced:',
    '- their words need one (a global leaderboard, accounts, progress on any device, a server that decides results): `offers.backend` with those words in `from`, no question; card 1\'s spec has the same `backend`.',
    '- their words leave it open (a leaderboard, saving, coming back later): `offers.backend` without `from`, and one question `{"about": "backend"}` with an option that keeps it and one "No backend, play in the browser"; card 1\'s spec follows the default.',
    `- \`offers.backend\`: \`kind\` (database or host), \`needs\` (${BACKEND_NEEDS.join(', ')}), \`provider\` when you choose one (supabase is a database, railway a host).`,
  );
  return out;
}

/**
 * The parts' rules on a pitch. on: the parts this host has; words: every word the person gave (one string).
 * → problems with JSON paths from the pitch root
 */
export function checkPartsPitch(pitch, { on = [], words = '' } = {}) {
  const out = [], cards = list(pitch?.cards), questions = list(pitch?.questions);
  for (const part of PART_IDS) {
    const O = pitch?.offers?.[part] ?? null, q = questions.find(x => x?.about === part) ?? null;
    if (!on.includes(part)) {
      const why = part === 'economy' ? 'web3 is off here (GAMESFUN_WEB3=0)' : 'this host connects no backend';
      if (O) out.push(`$.offers.${part}: ${why}, so no game here offers one: leave it out (what the person asked of it is a build line)`);
      if (q) out.push(`$.questions: ${why}: drop the question "${q.id}"`);
      cards.forEach((c, i) => { if (c?.spec?.[part] != null) out.push(`$.cards[${i}].spec.${part}: ${why}: take "${part}" out of the spec`); });
      continue;
    }
    const said = String(words).match(SAID[part])?.[0] ?? null;
    if (!O) {
      if (q) out.push(`$.questions: the question "${q.id}" asks about ${part === 'economy' ? 'an economy' : 'a backend'} the pitch does not offer: say what it would be in offers.${part}, or drop the question`);
      else if (said) out.push(`$.offers.${part}: the person's words ask for ${part === 'economy' ? 'an economy' : 'a backend'} ("${said}"): offer it in offers.${part} with those words in from, and ask nothing about it (nothing they asked for is left out)`);
      cards.forEach((c, i) => { if (c?.spec?.[part] != null) out.push(`$.cards[${i}].spec.${part}: the pitch offers no ${part}, so no card's spec has one`); });
      continue;
    }
    if (part === 'economy' && !PRICE_SOL.test(String(O.price ?? ''))) out.push(`$.offers.economy.price: "${O.price ?? ''}" is not a price: what going live costs in SOL, from economy_cost (e.g. "about 0.05 SOL")`);
    if (part === 'backend') {
      if (!['database', 'host'].includes(O.kind)) out.push('$.offers.backend.kind: database or host');
      if (!list(O.needs).length || list(O.needs).some(n => !BACKEND_NEEDS.includes(n))) out.push(`$.offers.backend.needs: from ${BACKEND_NEEDS.join(', ')}`);
      if (O.provider && PROVIDERS[O.provider]?.kind !== O.kind) out.push(`$.offers.backend.provider: ${O.provider} is not a ${O.kind}`);
    }
    const fromOk = O.from != null && quoted(O.from, words);
    if (O.from != null && !fromOk) out.push(`$.offers.${part}.from: "${O.from}" is not in the person's words: copy them exactly, or leave from out and ask`);
    if (O.from != null && q) out.push(`$.questions: the person already asked for it ("${O.from}"): drop the question "${q.id}"`);
    if (O.from == null && !q) out.push(`$.questions: the person's words do not ask for ${part === 'economy' ? 'an economy' : 'a backend'}, so it is offered as a question ("about": "${part}") with an option that keeps it and one that leaves it out`);
    let dropDefault = false;
    if (q) {
      const opts = list(q.options), drop = opts.find(o => DROP_OPTION.test(`${o?.label ?? ''} ${o?.id ?? ''}`));
      if (opts.length < 2 || !drop || opts.every(o => DROP_OPTION.test(`${o?.label ?? ''} ${o?.id ?? ''}`))) out.push(`$.questions: the question "${q.id}" has one option that keeps ${part === 'economy' ? 'the economy' : 'the backend'} and one that leaves it out`);
      dropDefault = !!drop && q.default === drop.id;
    }
    const c1 = cards[0]?.spec;
    if (c1) {
      if (c1[part] == null && !dropDefault) out.push(`$.cards[0].spec.${part}: ${fromOk ? 'the person asked for it' : `the question "${q?.id}" keeps it by default`}, so card 1's spec has ${JSON.stringify(specValueOf(part, O))}`);
      if (c1[part] != null && dropDefault) out.push(`$.cards[0].spec.${part}: the question "${q.id}" leaves it out by default, so card 1's spec has no "${part}"`);
    }
    cards.forEach((c, i) => {
      const v = c?.spec?.[part];
      if (v == null) return;
      if (part === 'economy' && (v.in !== ECONOMY_FILE || Object.keys(v).length !== 1)) out.push(`$.cards[${i}].spec.economy: {"in": "gamesfun.json"}: the spec holds a reference, never a copy`);
      if (part === 'backend' && (v.kind !== O.kind || [...list(v.needs)].sort().join() !== [...list(O.needs)].sort().join())) out.push(`$.cards[${i}].spec.backend: the backend offers.backend names (kind "${O.kind}", needs ${list(O.needs).join(', ')})`);
    });
  }
  return out;
}

/** A spec's parts against what the host has on. → problems */
export function checkPartsSpec(spec, { on = [], at = '$' } = {}) {
  const out = [];
  for (const part of PART_IDS) if (spec?.[part] != null && !on.includes(part)) out.push(`${at}.${part}: ${part === 'economy' ? 'web3 is off here (GAMESFUN_WEB3=0)' : 'this host connects no backend'}: take "${part}" out of the spec`);
  if (spec?.economy != null && (spec.economy.in !== ECONOMY_FILE || Object.keys(spec.economy).length !== 1)) out.push(`${at}.economy: {"in": "gamesfun.json"}: the spec holds a reference, never a copy`);
  return out;
}

/**
 * The person's choice applied to a card's spec: a part question answered with its drop option takes the part out; with
 * the keep option, puts the offered part in. answers: by the question's about or id. → {spec, decided: {part: {kept, by}}}
 */
export function applyPartAnswers(spec, pitch, answers = {}) {
  const next = structuredClone(spec), decided = {};
  for (const part of PART_IDS) {
    const O = pitch?.offers?.[part];
    if (!O) continue;
    if (O.from) { decided[part] = { kept: next[part] != null, by: 'their words', words: O.from }; continue; }
    const q = list(pitch?.questions).find(x => x?.about === part);
    if (!q) continue;
    const chosen = answers[q.about] ?? answers[q.id] ?? q.default, opt = list(q.options).find(o => o.id === chosen);
    const drop = !!opt && DROP_OPTION.test(`${opt.label ?? ''} ${opt.id ?? ''}`);
    if (drop) delete next[part]; else next[part] = specValueOf(part, O);
    decided[part] = { kept: !drop, by: answers[q.about] != null || answers[q.id] != null ? 'their answer' : 'the default', option: opt?.label ?? chosen };
  }
  return { spec: next, decided };
}
/** Is an answer about a part (applied by code, so it needs no spec round)? */
export const partAnswerKeys = pitch => new Set(list(pitch?.questions).filter(q => PART_IDS.includes(q?.about)).flatMap(q => [q.about, q.id]));

// ---------------------------------------------------------------- the steps after the build round: check
/** The part steps a locked spec runs, in order, for a host with these parts on. */
export const partStepsOf = (spec, on = []) => PART_STEPS.filter(p => spec?.[p] != null && on.includes(p));

/**
 * One part's check through its adapter → {ok, problems: [{part, code, message, fix}], warnings}. An adapter that throws
 * is a failed check that says so (the build cannot pass a check that did not run).
 */
export async function checkPart(part, adapter, game) {
  let r;
  try { r = await adapter.check(game); } catch (e) { return { ok: false, problems: [{ part, code: 'E-CHECK', message: `the ${part} check did not run: ${String(e?.message ?? e).slice(0, 300)}`, fix: 'Read the error; the game\'s files may be unreadable.' }], warnings: [] }; }
  const problems = list(r?.problems).map(p => ({ part, code: String(p.code ?? 'E'), message: String(p.message ?? ''), fix: String(p.fix ?? '') }));
  return { ok: r?.ok === true && !problems.length, problems, warnings: list(r?.warnings).slice(0, 12) };
}

/** The repair round's lines for failed part checks. */
export const partFailureLines = failed => list(failed).map(p => `- the ${p.part} check, ${p.code}: ${p.message}${p.fix ? `\n  fix: ${p.fix}` : ''}`);

/** The build brief's lines for the parts a spec keeps (brief.mjs composeBrief). */
export function briefPartLines(spec, offers = {}) {
  const out = [];
  if (spec?.economy) out.push('## The economy (the person kept it)', '',
    `${offers.economy?.what ? `${sentence(offers.economy.what)} ` : ''}Write it into the game's gamesfun.json: draft it with \`economy_examples\` and \`economy_check\`, save it with \`economy_save\` (only a spec the checker passes is saved; skill \`gamesfun-economy\`), and make the game use it where a player meets it. After this round the loop runs the economy check; going live is the person's own approval at delivery, never yours.`, '');
  if (spec?.backend) out.push('## The backend (the person kept it)', '',
    `It keeps ${joinWords(list(spec.backend.needs).filter(n => NEED_WORDS[n]).map(n => NEED_WORDS[n].what)) || 'something beyond one browser'} in a ${kindWord(spec.backend)} on their own account. Write the tables in supabase/migrations/ with row-level security and the game's use of them through gf/backend (skill \`gamesfun-backend\`); never a secret key in the game. Until they connect it the game plays in the browser: ${joinWords(offWords(spec.backend)) || 'it says what needs the backend'}. After this round the loop runs the backend check.`, '');
  return out;
}

// ---------------------------------------------------------------- delivery: publish, connect
/**
 * The economy at delivery: going live is the approval link the adapter's publish() prepares (the kit's
 * economy_publish); nothing is signed and delivery never waits. → {state: 'live' | 'waiting-for-approval' | 'refused', words, link?, ...}
 */
export async function economyAtDelivery(adapter, game, { clears = false } = {}) {
  const tail = clears ? ` ${KEEPER_HOLE}` : '';
  let status = null;
  try { status = (await adapter?.status?.(game)) ?? null; } catch { status = null; }
  if (status?.live && !list(status.parts).some(p => p.differs || !p.onChain)) return { state: 'live', words: `Its economy is live on devnet.${tail}`, link: null };
  let pub = null, error = null;
  try { pub = (await adapter?.publish?.(game)) ?? null; } catch (e) { error = String(e?.message ?? e).slice(0, 400); }
  if (pub && pub.ok === false) {
    const r = list(pub.refusals)[0];
    return { state: 'refused', words: `Its economy cannot go live yet: ${r ? `${sentence(r.message)}${r.fix ? ` ${sentence(r.fix)}` : ''}` : 'the economy checker refused it.'}${tail}`, refusals: list(pub.refusals).slice(0, 8), link: null };
  }
  const link = pub?.approve?.link ?? null;
  const step = pub?.approve?.step ?? 'Open the studio\'s Economy tab and press "Put it live". Your wallet shows every step and its cost before anything is signed.';
  return { state: 'waiting-for-approval', words: `Its economy waits for your approval: ${step}${tail}`, link, ...(pub?.cost ? { cost: pub.cost } : {}), ...(error ? { error } : {}) };
}

/** The backend at delivery: connected, or playable in the browser and what to connect. Delivery never waits for it. */
export async function backendAtDelivery(adapter, game, backend) {
  const provider = providerOf(backend), p = PROVIDERS[provider], kw = kindWord(backend);
  let status = null;
  try { status = (await adapter?.status?.(game)) ?? null; } catch { status = null; }
  const base = { kind: backend.kind, provider, needs: [...list(backend.needs)] };
  if (status?.connected) return { ...base, state: 'connected', url: status.url ?? null, words: `Connected to your ${PROVIDERS[status.provider]?.label ?? status.provider ?? p?.label ?? ''} ${kw}${status.url ? ` at ${status.url}` : ''}.`.replace(/ {2,}/g, ' ') };
  const off = offWords(backend), cmd = connectCommand(provider);
  return { ...base, state: 'not-connected', connect: cmd, words: `It plays in the browser with no ${kw} connected${off.length ? `: ${joinWords(off)}` : ''}. To connect your own${p ? ` ${p.label}` : ''} ${kw}: ${cmd}, or the studio's Backend tab. You sign in there yourself, and it is your account and your bill${p ? ` (${p.cost})` : ''}.` };
}
