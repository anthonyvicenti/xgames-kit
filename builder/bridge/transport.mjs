// The transport seam. Everything above it (the page's routes, the queue, the stop guard, approvals: core.mjs) is
// written once. A transport fills it for one agent and one mechanism.
//
// A transport is { id, built, capabilities, mechanisms, attach(bridge, options) → handlers }.
//
//   capabilities
//     wakesIdleSession   a request reaches a session nobody is typing in
//     deliversMidTurn    a request reaches the model before its turn ends
//     approvals          'page-and-terminal' | 'terminal-only'
//     holdsStop          the transport can refuse a stop with a reason
//     needsShell         true means Git Bash on Windows
//
//   What a transport calls on the bridge (core.mjs):
//     bridge.event(kind, {session, cwd, mode, …})          session → page, one normalized stream
//     bridge.askPermission({session, tool, input})          → { id, answer: Promise<{behavior, message?}|null>, gone() }
//                                                             null leaves the decision to the terminal; the bridge
//                                                             retires a stale one by itself on the next event
//     bridge.stop({session, cwd, lastMessage})              → { refuse, context, notice }: the bridge decides and
//                                                             bounds its own refusals; the transport only words it
//     bridge.openWait(session, {form, send, end}, {cwd})    page → session: at-least-once, "handed" is not "seen"
//
//   The report that a request is done is a tool call in every transport (builder/bridge/client.mjs), never part of one.
import { claudeHooks } from './transports/claude-hooks.mjs';

/** Read from the agent's documentation, not built: https://learn.chatgpt.com/docs/hooks.md (fetched 2026-10-10). */
export const codexHooks = {
  id: 'codex-hooks', agent: 'codex', built: false,
  capabilities: { wakesIdleSession: false, deliversMidTurn: true, approvals: 'page-and-terminal', holdsStop: true, needsShell: false },
  mechanisms: {
    deliver: 'a Stop command hook returns the request as its reason; nothing wakes an idle session ("If no turn is active, Codex waits until the next user turn. Finishing a background hook doesn\'t start a new turn.")',
    events: 'command hooks post to the local server (only `command` and `mcp_tool` handlers run; there are no HTTP hooks)',
    approvals: 'a PermissionRequest command hook: allow, deny or decline; `updatedInput`, `updatedPermissions` and `interrupt` fail closed',
    stop: 'a Stop command hook; `decision: "block"` continues with the reason as a new prompt',
    report: 'the same tool call',
  },
  attach() { throw new Error('the codex-hooks transport is not built: Codex has no wake of an idle session through hooks'); },
};

/** The interface only. Offered only with GAMESFUN_BRIDGE_CHANNEL=1 (a channel needs the development flag or a listing). */
export const claudeChannel = {
  id: 'claude-channel', agent: 'claude-code', built: false, flag: 'GAMESFUN_BRIDGE_CHANNEL',
  capabilities: { wakesIdleSession: true, deliversMidTurn: true, approvals: 'page-and-terminal', holdsStop: true, needsShell: false },
  mechanisms: {
    deliver: 'a channel notification with the request id in `meta`; not acknowledged, so the report stays a tool call',
    events: 'the same hooks as claude-hooks (a channel carries no tool events)',
    approvals: 'the channel\'s permission relay (`request_id`, `behavior`)',
    stop: 'the same Stop hook as claude-hooks (a channel has none)',
    report: 'the same tool call',
  },
  attach() { throw new Error('the claude-channel transport is not built'); },
};

export const TRANSPORTS = { [claudeHooks.id]: claudeHooks, [codexHooks.id]: codexHooks, [claudeChannel.id]: claudeChannel };

/** The transports a person can be offered here. */
export function listTransports(env = process.env) {
  return Object.values(TRANSPORTS).filter(t => !t.flag || env[t.flag] === '1').map(({ attach, ...rest }) => rest);
}

/** Attach a transport to a bridge. → its handlers. Throws for one that is not built or not switched on. */
export function openTransport(id, bridge, options = {}) {
  const t = TRANSPORTS[id];
  if (!t) throw new Error(`no transport "${id}" (have: ${Object.keys(TRANSPORTS).join(', ')})`);
  if (t.flag && (options.env ?? process.env)[t.flag] !== '1') throw new Error(`the ${id} transport is behind ${t.flag}=1`);
  const handlers = t.attach(bridge, options);
  bridge.setTransport({ id: t.id, wait: options.wait ?? null, capabilities: t.capabilities });
  return handlers;
}
