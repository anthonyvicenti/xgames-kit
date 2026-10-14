// The approval engine behind the studio's wallet prompts. A flow (launch a token, put the shop on sale) is a list of
// steps the creator approves in their own wallet, in their own browser:
//   start → for each step: prepare (built now: a fresh blockhash, an upload's hash) → the wallet signs → complete
// The server never holds the creator's key. It only sends what it prepared itself: a signed answer must carry the
// exact message prepared for it and a valid signature from the wallet the flow was started for. Each prepared payload
// can be answered once and expires (replay protection); flows expire too, and are capped in number.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isAddress } from '../gf-web3/chain/base58.js';
import { equalBytes, fromBase64, toBase64, utf8 } from '../gf-web3/chain/bytes.js';
import { MAX_TRANSACTION_BYTES, readTransaction, wireTransaction } from '../gf-web3/chain/tx.js';
import { verifySignature } from './ed25519.mjs';

export const PREPARE_TTL_MS = 90_000;
export const FLOW_TTL_MS = 15 * 60_000;
export const MAX_FLOWS = 8;
export const MAX_TRANSACTIONS_PER_STEP = 12;

/** A refusal with the HTTP status the page gets. */
export class FlowError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'FlowError';
    this.status = status;
  }
}

const newId = () => randomBytes(18).toString('base64url');
const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Check a wallet's answer to prepared transactions: same count, each the exact prepared message, each carrying the
 * wallet's valid signature. Returns the prepared wires with the wallet's signature added (fresh keys' signatures are
 * kept from the prepared copy, whatever the wallet returned in their slots).
 */
export function checkSignedTransactions(prepared, signed, wallet) {
  if (!Array.isArray(signed) || signed.length !== prepared.length) throw new FlowError(400, 'The wallet’s answer does not match the request.');
  return prepared.map((wire, i) => {
    const raw = signed[i];
    if (typeof raw !== 'string' || raw.length > MAX_TRANSACTION_BYTES * 2) throw new FlowError(400, 'The wallet’s answer does not match the request.');
    let mine;
    let theirs;
    try {
      mine = readTransaction(wire);
      theirs = readTransaction(fromBase64(raw));
    } catch {
      throw new FlowError(400, 'The wallet returned something that is not a transaction.');
    }
    if (!equalBytes(mine.message, theirs.message)) throw new FlowError(400, 'The wallet changed the transaction before signing it, so nothing was sent.');
    const slot = mine.signers.indexOf(wallet);
    if (slot < 0) throw new FlowError(400, 'This transaction was not prepared for that wallet.');
    const signature = theirs.signatures[slot];
    if (!verifySignature(wallet, mine.message, signature)) throw new FlowError(400, 'The wallet’s signature is missing or does not match your wallet.');
    const signatures = [...mine.signatures];
    signatures[slot] = signature;
    return wireTransaction(mine.message, signatures);
  });
}

/**
 * The engine. `now` is injectable for tests.
 * A flow spec: { kind, title, lines, wallet, steps: [step], context? }
 * A step: { title, prepare(flow) → payload, complete(flow, answer) → string | { result, again } }
 *   payload: { kind: 'message', text, details } | { kind: 'transactions', transactions: [wire Uint8Array], details }
 *   answer:  { kind: 'message', text, signature } | { kind: 'transactions', transactions: [checked wire] }
 */
export function createFlowEngine({ now = Date.now, prepareTtlMs = PREPARE_TTL_MS, flowTtlMs = FLOW_TTL_MS, maxFlows = MAX_FLOWS } = {}) {
  const flows = new Map();

  function sweep() {
    for (const [id, flow] of flows) if (flow.expires < now() && !flow.busy) flows.delete(id);
  }

  function view(flow) {
    return {
      id: flow.id,
      kind: flow.kind,
      title: flow.title,
      lines: flow.lines,
      wallet: flow.wallet,
      steps: flow.steps.map((s) => s.title),
      next: flow.next,
      results: flow.results,
      done: flow.done,
      error: flow.error,
      outcome: flow.outcome ?? null,
    };
  }

  function get(id) {
    sweep();
    const flow = typeof id === 'string' ? flows.get(id) : null;
    if (!flow) throw new FlowError(404, 'That request is gone (it finished, was cancelled or expired). Start it again.');
    return flow;
  }

  function start(spec) {
    sweep();
    if (!isAddress(spec.wallet)) throw new FlowError(400, 'Connect a wallet first.');
    if (!spec.steps?.length) throw new FlowError(409, 'Nothing to approve: everything is already done.');
    const active = [...flows.values()].filter((f) => !f.done);
    if (active.length >= maxFlows) throw new FlowError(429, 'Too many requests are waiting. Finish or cancel one first.');
    const flow = {
      id: newId(),
      kind: spec.kind,
      title: spec.title,
      lines: spec.lines ?? [],
      wallet: spec.wallet,
      steps: spec.steps,
      context: spec.context ?? {},
      onFinish: spec.onFinish ?? null,
      next: 0,
      results: [],
      prepared: null,
      busy: false,
      done: false,
      error: null,
      expires: now() + flowTtlMs,
    };
    flows.set(flow.id, flow);
    return view(flow);
  }

  async function prepare(id, wallet) {
    const flow = get(id);
    if (flow.done) throw new FlowError(409, 'This request is already finished.');
    if (wallet !== flow.wallet) throw new FlowError(409, `Switch your wallet back to ${flow.wallet}: this request was prepared for it.`);
    if (flow.busy) throw new FlowError(409, 'Already working on this request.');
    const step = flow.steps[flow.next];
    flow.busy = true;
    try {
      const value = await step.prepare(flow);
      if (value.kind === 'transactions') {
        if (!value.transactions.length || value.transactions.length > MAX_TRANSACTIONS_PER_STEP) throw new Error('Too many transactions for one approval.');
        for (const wire of value.transactions) if (wire.length > MAX_TRANSACTION_BYTES) throw new Error(`A transaction is ${wire.length} bytes; the limit is ${MAX_TRANSACTION_BYTES}.`);
      }
      const prepareId = newId();
      flow.prepared = { id: prepareId, step: flow.next, expires: now() + prepareTtlMs, value };
      return {
        flowId: flow.id,
        prepareId,
        step: flow.next,
        title: step.title,
        kind: value.kind,
        details: value.details ?? [],
        ...(value.kind === 'message' ? { text: value.text } : { transactions: value.transactions.map(toBase64) }),
      };
    } catch (error) {
      if (error instanceof FlowError) throw error;
      throw new FlowError(400, error.message);
    } finally {
      flow.busy = false;
    }
  }

  async function complete(id, body) {
    const flow = get(id);
    const prepared = flow.prepared;
    // Single use, whatever happens next: a replayed answer finds nothing to complete.
    if (!prepared || typeof body?.prepareId !== 'string' || !sameText(prepared.id, body.prepareId))
      throw new FlowError(409, 'That approval was already used, or was never prepared.');
    flow.prepared = null;
    if (prepared.expires < now()) throw new FlowError(410, 'That approval expired. Press Approve again.');
    if (flow.busy) throw new FlowError(409, 'Already working on this request.');
    const step = flow.steps[prepared.step];
    let answer;
    if (prepared.value.kind === 'message') {
      let signature;
      try {
        signature = fromBase64(String(body.signature ?? ''));
      } catch {
        throw new FlowError(400, 'The wallet’s signature is not valid.');
      }
      if (!verifySignature(flow.wallet, utf8(prepared.value.text), signature)) throw new FlowError(400, 'The wallet’s signature does not match the message, so nothing was uploaded.');
      answer = { kind: 'message', text: prepared.value.text, signature };
    } else {
      answer = { kind: 'transactions', transactions: checkSignedTransactions(prepared.value.transactions, body.signed, flow.wallet) };
    }
    flow.busy = true;
    try {
      const outcome = await step.complete(flow, answer);
      const result = typeof outcome === 'string' ? outcome : outcome?.result;
      if (result) flow.results.push(result);
      if (!(outcome && typeof outcome === 'object' && outcome.again)) flow.next = prepared.step + 1;
    } catch (error) {
      flow.error = error.message;
      throw new FlowError(error instanceof FlowError ? error.status : 400, error.message);
    } finally {
      flow.busy = false;
    }
    flow.error = null;
    if (flow.next >= flow.steps.length) {
      flow.done = true;
      if (flow.onFinish) flow.outcome = await flow.onFinish(flow);
    }
    return view(flow);
  }

  function cancel(id) {
    const flow = get(id);
    flows.delete(flow.id);
    return { cancelled: true };
  }

  return {
    start,
    prepare,
    complete,
    cancel,
    get: (id) => view(get(id)),
    list: () => (sweep(), [...flows.values()].map(view)),
  };
}
