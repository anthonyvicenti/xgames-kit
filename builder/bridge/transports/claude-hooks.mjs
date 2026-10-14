// The claude-hooks transport: Claude Code's hooks, turned into the bridge's calls (transport.mjs has the seam).
//
//   page → session   the wait: an `asyncRewake` command hook on SessionStart and Stop (default), or the plugin's
//                    monitor (fallback); plus the Stop hook's answer for requests that arrived during the turn
//   session → page   one hook per event posts its input to /api/session/hook/<Event>
//   approvals        the PermissionRequest hook, held until the person clicks
//   stop guard       the Stop hook: {"decision":"block","reason":…}
//
// hook(event, input) answers with exactly what Claude Code reads from a hook: null (an empty 200) or the JSON output
// object for that event. Documentation: https://code.claude.com/docs/en/hooks.md (fetched 2026-10-11).
import { protocolWords } from '../../../plugin/scripts/lib.mjs';
import { requestMessage } from '../core.mjs';

export const claudeHooks = {
  id: 'claude-hooks', agent: 'claude-code', built: true,
  capabilities: { wakesIdleSession: true, deliversMidTurn: true, approvals: 'page-and-terminal', holdsStop: true, needsShell: false },
  // every mechanism, with its three cases
  mechanisms: {
    hooks: { what: 'exec-form command hooks: node <plugin>/scripts/hook.mjs <Event>', needsShell: false, win32: 'node.exe on PATH; no Git Bash', darwin: 'node on PATH', linux: 'node on PATH' },
    'wait-rewake': { what: 'asyncRewake command hook on SessionStart and Stop: node <plugin>/scripts/wait.mjs', needsShell: false, win32: 'node.exe on PATH; no Git Bash', darwin: 'node on PATH', linux: 'node on PATH' },
    'wait-monitor': { what: 'the plugin monitor: node <plugin>/scripts/wait.mjs --monitor', needsShell: true, win32: 'only with Git Bash installed', darwin: 'works', linux: 'works' },
  },
  events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'],

  attach(bridge, options = {}) {
    const base = input => ({ session: input?.session_id, cwd: input?.cwd, mode: input?.permission_mode });

    /** → { body, onClose? }: body is the hook's answer (null = empty 200); onClose is called if the hook goes away first. */
    async function hook(name, input = {}) {
      const b = base(input);
      switch (name) {
        case 'SessionStart': bridge.event('session-start', { ...b, source: input.source }); return { body: null };
        case 'SessionEnd': bridge.event('session-end', { ...b, reason: input.reason }); return { body: null };
        case 'UserPromptSubmit': {
          bridge.event('prompt', { ...b, text: input.prompt });
          // A session the plugin was loaded into after it started (/reload-plugins), or one older than this studio,
          // never ran SessionStart here: it learns the protocol and its id with its first prompt instead.
          const said = [];
          if (options.url && bridge.introduce(b.session)) said.push(protocolWords(options.url, b.session, { kit: options.kit }));
          // Requests the stop guard went quiet about (it reminds once, then stalls them): the person's own prompt in the
          // terminal is what brings them back, once.
          const stalled = bridge.stalledFor(b.session);
          if (stalled.length) said.push(requestMessage(stalled, { session: b.session, kit: options.kit, heading: 'Still open from the studio page, not reported yet' }));
          return { body: said.length ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: said.join('\n\n') } } : null };
        }
        case 'PreToolUse': bridge.event('tool-start', { ...b, tool: input.tool_name, input: input.tool_input }); return { body: null };
        case 'PostToolUse': bridge.event('tool-end', { ...b, tool: input.tool_name, input: input.tool_input, ok: true }); return { body: null };
        case 'PostToolUseFailure': bridge.event('tool-end', { ...b, tool: input.tool_name, input: input.tool_input, ok: false }); return { body: null };
        case 'PermissionDenied': bridge.event('tool-end', { ...b, tool: input.tool_name, input: input.tool_input, ok: false, denied: true }); return { body: null };
        case 'Notification': bridge.event('notification', { ...b, type: input.notification_type, message: input.message }); return { body: null };
        case 'StopFailure': bridge.event('notification', { ...b, type: 'stop-failure', message: input.error ?? input.message ?? 'the turn ended on an error' }); return { body: null };
        case 'PermissionRequest': {
          const asked = bridge.askPermission({ ...b, tool: input.tool_name, input: input.tool_input });
          return {
            onClose: asked.gone,
            body: asked.answer.then(a => (a ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: a.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: a.message } } } : null)),
          };
        }
        case 'Stop': {
          const r = await bridge.stop({ ...b, lastMessage: input.last_assistant_message });
          if (r.refuse) return { body: { decision: 'block', reason: r.refuse } };
          const out = {};
          if (r.context) out.hookSpecificOutput = { hookEventName: 'Stop', additionalContext: r.context };
          if (r.notice) out.systemMessage = r.notice;
          return { body: Object.keys(out).length ? out : null };
        }
        default: return { body: null };
      }
    }
    return { hook };
  },
};
