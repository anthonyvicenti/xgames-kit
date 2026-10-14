// Does our MCP server start, and what tools does it list? Asked of the server itself over stdio, with the MCP SDK's
// client, so the answer does not depend on which agent will use it. The child gets the SDK's small default environment
// (no secrets from this shell travel to it) and is stopped as a tree when done.
import { stopTree } from './proc.mjs';

export async function listServerTools({ command, args, cwd, timeoutMs = 30000 }) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command, args, cwd, env: getDefaultEnvironment(), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', d => { stderr += d; });
  const client = new Client({ name: 'gamesfun-connect', version: '1' });
  let timer;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`the server did not answer within ${timeoutMs / 1000} s`)), timeoutMs); }),
    ]);
    const { tools } = await client.listTools();
    return { ok: true, tools: tools.map(t => t.name), server: client.getServerVersion() ?? null };
  } catch (e) {
    return { ok: false, tools: [], error: e.message, stderr: stderr.trim().split('\n').slice(-5).join('\n') };
  } finally {
    clearTimeout(timer);
    const pid = transport.pid;
    await client.close().catch(() => {});
    if (pid) stopTree({ pid });
  }
}
