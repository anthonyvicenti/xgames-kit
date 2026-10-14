// The Economy tab's decisions (builder/studio/tabs/economy.js mounts them): the card for one decision (from a link,
// #economy?decide=…, or from the Decide section) with what is being decided, its numbers, the economy's checks and
// "Sign in my wallet" (flow kind "decide"); and the Decide section: who decides (your wallet or your keeper, with "Let
// my keeper decide" / "Take it back", flow kind "authority"), the economy's decisions, what waits on chain (contests
// awaiting a result, collectibles on hold) and the latest decisions from the ledger. The page never signs: the flow
// engine prepares, the creator's wallet signs.
import { explorer, short } from './client.js';
import { h, note } from './ui.js';

const DEBOUNCE_MS = 400;
/** The fields a decision asks for, by what it does. */
const FIELDS = {
  payout: ['to', 'amount', 'percent', 'attempt', 'id'],
  burn: ['amount', 'percent'],
  issue: ['to', 'amount', 'attempt', 'id'],
  make: ['to', 'attempt', 'id'],
  award: ['asset', 'to'],
  decide: ['side'],
  open_contest: [],
};
const LABELS = { to: 'To (a wallet’s public address)', amount: 'Amount', percent: '…or a share of the pool (%)', attempt: 'The attempt’s payment (its transaction signature)', id: 'The game’s id for this result', asset: 'The held collectible', side: 'The side that won' };

/** "decide" for a contest key's result, "open_contest" with open=1. */
const doesOf = (key, values, decisions) => decisions.find((d) => d.key === key)?.does ?? (key.startsWith('contest:') ? (values.open ? 'open_contest' : 'decide') : key.startsWith('hold:') ? 'award' : 'payout');

/**
 * ctx: { t (tabContext), render(), start(body) (starts a flow), state() (the /state answer), spec(), live() }.
 * Returns { load(), askedCard(asked, forget), sectionCard(), ask(key, values) , doneText(kind) }.
 */
export function createDecide(ctx) {
  const { t, render, start } = ctx;
  let info = null; // GET /economy/decisions
  let infoError = '';
  let checked = null; // POST /economy/decide/check for the asked decision
  let checking = 0;
  let timer = null;
  let keeperAddress = '';
  let keeperAnswer = null;
  let asked = null;

  async function load() {
    if (!ctx.live()) {
      info = null;
      return;
    }
    try {
      info = await t.api('/economy/decisions');
      infoError = '';
      if (!keeperAddress && info.keeper?.address) keeperAddress = info.keeper.address;
    } catch (error) {
      infoError = error.message;
    }
  }

  const requestOf = (a) => ({ decision: a.key, ...Object.fromEntries(Object.entries(a.values ?? {}).filter(([, v]) => v !== '' && v !== undefined)) });

  async function check(a) {
    const mine = ++checking;
    try {
      const r = await t.api('/economy/decide/check', { request: requestOf(a), wallet: t.wallet.address() ?? '' });
      if (mine === checking) checked = r;
    } catch (error) {
      if (mine === checking) checked = { ok: false, refusals: [{ code: 'D-REQUEST', message: error.message, fix: 'Change what is asked.' }], numbers: [], notes: [] };
    }
    render();
  }

  /** The link (or a button) asks for this decision: show its card and check it. */
  function sync(a) {
    const key = a ? JSON.stringify(requestOf(a)) : null;
    if (key === asked) return;
    asked = key;
    checked = null;
    keeperAnswer = null;
    if (a) check(a);
  }

  function edit(a, field, value) {
    a.values = { ...(a.values ?? {}), [field]: value };
    asked = JSON.stringify(requestOf(a));
    clearTimeout(timer);
    timer = setTimeout(() => check(a), DEBOUNCE_MS);
  }

  async function sendToKeeper(a) {
    try {
      keeperAnswer = await t.api('/economy/decide-request', { request: requestOf(a) });
    } catch (error) {
      keeperAnswer = { ok: false, text: error.message };
    }
    await load();
    render();
  }

  /** The card for one decision: what, the numbers, the checks, then the wallet. */
  function askedCard(a, forget) {
    sync(a);
    const decisions = info?.decisions ?? [];
    const rule = decisions.find((d) => d.key === a.key);
    const does = doesOf(a.key, a.values ?? {}, decisions);
    const values = a.values ?? {};
    const sides = rule?.sides ?? info?.waiting?.contests?.find((c) => `contest:${c.key}` === a.key)?.sides?.length ?? 0;
    const sideNames = rule?.sideNames ?? [];
    const fields = (FIELDS[does] ?? ['to', 'amount']).filter((f) => !(f === 'percent' && rule?.amount !== null && rule?.amount !== undefined && rule?.percent === null));
    const input = (f) =>
      f === 'side' && sides
        ? h('label', { class: 'field' }, LABELS.side, h('select', { 'data-path': `decide|${f}`, onchange: (e) => (edit(a, f, e.target.value), render()) },
            h('option', { value: '', selected: values.side === undefined }, '—'),
            Array.from({ length: sides }, (_, i) => h('option', { value: String(i), selected: String(values.side) === String(i) }, `${i}${sideNames[i] ? ` · ${sideNames[i]}` : ''}`))))
        : h('label', { class: `field${['to', 'attempt', 'asset'].includes(f) ? ' wide' : ''}` }, LABELS[f],
            h('input', { value: values[f] ?? '', 'data-path': `decide|${f}`, 'data-testid': `econ-decide-${f}`, spellcheck: false, placeholder: f === 'amount' && rule?.amount ? String(rule.amount) : '', oninput: (e) => edit(a, f, e.target.value.trim()) }));
    const c = checked;
    const refusals = c?.refusals ?? [];
    const signerIsKeeper = info?.authority && info.owner && info.authority !== info.owner;
    const keeperRuns = info?.keeper?.running && info.keeper.address === info?.authority;
    return h('div', { class: 'card econ-live', 'data-testid': 'econ-decision' },
      h('strong', {}, `Decide: ${rule?.when ?? a.key}`),
      h('p', { class: 'dim' }, rule ? `${rule.does === 'payout' ? `Pays from the pool “${rule.pool}”` : rule.does}${rule.to ? `, to ${rule.to}` : ''}.${rule.signedBy === 'keeper' ? ' The economy gives this one to your keeper; you can also sign it here while your wallet is the authority.' : ''}` : 'Nothing is signed until you press the button and approve in your wallet.'),
      fields.length ? h('div', { style: 'display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin:8px 0' }, fields.map(input)) : null,
      !c ? h('p', { class: 'dim' }, 'Checking…')
        : h('div', { 'data-testid': 'econ-decide-check' },
            h('p', {}, h('b', {}, c.ok ? `${c.says}.` : `Not possible as asked${c.says ? `: ${c.says}` : ''}.`)),
            (c.numbers ?? []).length ? h('ul', { class: 'econ-receipts' }, c.numbers.map(([k, v]) => h('li', {}, `${k}: ${v}`))) : null,
            refusals.map((r) => h('p', { class: 'note error', 'data-code': r.code }, r.message, r.fix ? h('span', { class: 'dim' }, ` Fix: ${r.fix}`) : null)),
            (c.notes ?? []).map((n) => h('p', { class: 'dim' }, n))),
      keeperAnswer ? note(keeperAnswer.ok ? 'ok' : 'error', keeperAnswer.text ?? keeperAnswer.error ?? '') : null,
      h('div', { class: 'w3-row' },
        h('button', { class: 'primary', 'data-testid': 'econ-decide-sign', disabled: !c?.ok, title: c?.ok ? 'One approval in your wallet' : 'Fix what the checks say first', onclick: () => start({ kind: 'decide', input: requestOf(a) }) }, 'Sign in my wallet'),
        signerIsKeeper && keeperRuns ? h('button', { 'data-testid': 'econ-decide-keeper', onclick: () => sendToKeeper(a) }, 'Send it to my keeper') : null,
        h('button', { onclick: () => (sync(null), forget()) }, 'Close')));
  }

  /** The Decide section: who decides, what can be decided, what waits, what was decided. */
  function sectionCard(open) {
    if (!ctx.live()) return null;
    if (!info) return h('div', { class: 'card dim', 'data-testid': 'econ-decide' }, infoError ? `Could not read the decisions: ${infoError}` : 'Reading what waits for a decision…');
    const wallet = t.wallet.address();
    const yours = info.authority && info.authority === info.owner;
    const keeper = info.keeper ?? {};
    const contests = (info.waiting?.contests ?? []).filter((c) => c.open);
    const toOpen = (info.waiting?.contests ?? []).filter((c) => c.canOpen);
    const holds = info.waiting?.holds ?? [];
    const own = (info.decisions ?? []).filter((d) => !d.key.includes(':'));
    return h('div', { class: 'card econ-live', 'data-testid': 'econ-decide' },
      h('h3', {}, 'Decide'),
      h('p', { class: 'dim' }, 'What only the game knows (who cleared the level, which side won) is signed by the game’s authority. The program trusts that signature; the checks here (amounts, proof, caps) are this page’s and your keeper’s own rules.'),
      h('div', { 'data-testid': 'econ-decide-who' },
        h('p', {}, 'Who decides: ', h('b', {}, yours ? 'your wallet' : info.authority ? `the key ${short(info.authority)}${keeper.address === info.authority ? ' (your keeper)' : ''}` : '–'),
          keeper.running ? h('span', { class: 'dim' }, ` · keeper running (${short(keeper.address)})`) : h('span', { class: 'dim' }, ' · no keeper running')),
        yours
          ? h('div', { class: 'w3-row' },
              h('label', { class: 'field grow' }, 'Your keeper’s public address (npx gamesfun economy keeper --new-key <file> prints it)',
                h('input', { value: keeperAddress, 'data-path': 'decide|keeper', 'data-testid': 'econ-keeper-address', spellcheck: false, oninput: (e) => (keeperAddress = e.target.value.trim()) })),
              h('button', { 'data-testid': 'econ-keeper-give', disabled: !wallet || wallet !== info.owner, title: wallet === info.owner ? 'One approval in your wallet' : 'Connect the owner’s wallet', onclick: () => start({ kind: 'authority', input: { authority: keeperAddress } }) }, 'Let my keeper decide'))
          : h('div', { class: 'w3-row' },
              h('button', { 'data-testid': 'econ-keeper-take', disabled: !wallet || wallet !== info.owner, title: wallet === info.owner ? 'One approval in your wallet' : 'Connect the owner’s wallet', onclick: () => start({ kind: 'authority', input: { authority: 'owner' } }) }, 'Take it back'),
              h('span', { class: 'dim' }, 'Then your wallet signs the game’s decisions again, and the keeper can no longer pay out.'))),
      own.length ? h('div', {}, h('strong', {}, 'The economy’s decisions'),
        h('ul', { class: 'econ-receipts' }, own.map((d) => h('li', {},
          `${d.when}: ${d.does}${d.pool ? ` from “${d.pool}”` : ''}${d.amount !== null ? ` ${d.amount} ${d.symbol}` : d.percent !== null ? ` ${d.percent}%` : ''}${d.signedBy === 'keeper' ? ' · your keeper signs' : ''}`,
          d.proof ? h('span', { class: 'dim' }, ` · needs a paid “${d.proof.payment}”${d.proof.after ? `, at least ${d.proof.after} before` : ''}`) : null,
          d.caps ? h('span', { class: 'dim' }, ` · caps ${[d.caps.each !== undefined ? `${d.caps.each} each` : null, d.caps.perPlayerPerDay !== undefined ? `${d.caps.perPlayerPerDay} a player a day` : null, d.caps.perDay !== undefined ? `${d.caps.perDay} a day` : null].filter(Boolean).join(', ')}`) : null,
          ' ', h('button', { class: 'linkish', 'data-testid': `econ-decide-open-${d.key}`, onclick: () => open(d.key, {}) }, 'Decide…'))))) : null,
      contests.length || toOpen.length ? h('div', {}, h('strong', {}, 'Contests'),
        h('ul', { class: 'econ-receipts' },
          contests.map((c) => h('li', {}, `“${c.name}”: ${c.awaiting ? 'entries closed, awaiting the result' : 'open for entries'} (${c.entries} entr${c.entries === 1 ? 'y' : 'ies'}), result due ${new Date(c.resultBy * 1000).toLocaleString()} `, h('button', { class: 'linkish', onclick: () => open(`contest:${c.key}`, {}) }, 'Name the winner…'))),
          toOpen.map((c) => h('li', {}, `“${c.name}”: no round open `, h('button', { class: 'linkish', onclick: () => open(`contest:${c.key}`, { open: '1' }) }, 'Open a round…'))))) : null,
      holds.length ? h('div', {}, h('strong', {}, 'On hold, awaiting your word'),
        h('ul', { class: 'econ-receipts' }, holds.map((x) => h('li', {}, `${short(x.asset)} from ${short(x.player)}, until ${new Date(x.freeAt * 1000).toLocaleString()} `, h('button', { class: 'linkish', onclick: () => open(`hold:${x.key ?? (info.decisions ?? []).find((d) => d.key.startsWith('hold:'))?.key.slice(5) ?? ''}`, { asset: x.asset }) }, 'Award…'))))) : null,
      (info.recent ?? []).length ? h('div', {}, h('strong', {}, 'Latest decisions'),
        h('ul', { class: 'econ-receipts', 'data-testid': 'econ-decide-recent' }, info.recent.map((x) => h('li', { class: x.verdict === 'done' ? '' : 'dim' },
          `${x.verdict === 'done' ? '✓' : '✗'} ${x.says ?? x.decision ?? ''}${x.verdict === 'done' ? '' : `: ${x.text ?? x.reasons?.join(', ') ?? ''}`} · ${x.by ?? ''}`,
          x.signature ? [' · ', h('a', { href: explorer(ctx.state(), 'tx', x.signature), target: '_blank', rel: 'noreferrer' }, short(x.signature))] : null)))) : h('p', { class: 'dim' }, 'No decisions yet.'));
  }

  const doneText = (kind) => (kind === 'decide' ? 'Decided: it is on chain.' : kind === 'authority' ? 'Done: who decides for this game has changed.' : null);

  return { load, askedCard, sectionCard, doneText, sync };
}
