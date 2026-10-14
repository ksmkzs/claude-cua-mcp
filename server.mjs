#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpc, RpcError } from './rpc.mjs';
import { loadConfig } from './config.mjs';
import { CuaBridge } from './bridge.mjs';

const root = process.env.CUA_BRIDGE_HOME || dirname(fileURLToPath(import.meta.url));
const [config, key, snapshot] = await Promise.all([
  loadConfig(root), readFile(join(root, 'routing.key')),
  readFile(join(root, 'upstream-tools.json'), 'utf8').then(JSON.parse),
]);
const operations = new Map();
let initialized = false, closing = false;
const bridge = new CuaBridge({ root, config, key, tools: snapshot.tools,
  clientRequest: (...args) => rpc.request(...args),
  clientNotify: (...args) => rpc.notify(...args),
});

function tools() {
  const upstream = snapshot.tools.filter(t => ['js', 'js_reset'].includes(t.name)).map(t => ({ ...t,
    description: t.description + '\nRuns through a dedicated Codex app-server thread using your configured CUA runtime. Session routing is supplied automatically by Claude hooks. Do not provide _bridge_context. After cancellation or an uncertain result, observe the current app state before further actions.',
    inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties,
      _bridge_context: { type: 'string', description: 'Internal routing value populated by the Claude PreToolUse hook. Omit from model-generated arguments.' },
    } },
  }));
  return [...upstream, {
    name: 'bridge_status', description: 'Show CUA bridge connection and session status without observing or operating apps.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, {
    name: 'bridge_lifecycle', description: 'Host lifecycle hook only. Claude hooks call this automatically; do not call it from the model.',
    inputSchema: { type: 'object', properties: {
      event: { type: 'string', enum: ['Stop', 'StopFailure', 'SubagentStop', 'SessionEnd'] },
      session_id: { type: 'string' }, prompt_id: { type: 'string' }, agent_id: { type: 'string' },
    }, required: ['event', 'session_id'], additionalProperties: false },
    annotations: { idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: [] } },
  }];
}

const rpc = new JsonRpc(process.stdin, process.stdout, {
  async onRequest(method, params, id) {
    if (method === 'initialize') {
      initialized = true;
      bridge.capabilities = params.capabilities ?? {};
      return { protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(params.protocolVersion)
        ? params.protocolVersion : '2025-11-25', capabilities: { tools: {} },
        serverInfo: { name: 'claude-cua-appserver-bridge', version: '0.1.0' } };
    }
    if (!initialized) throw new RpcError('Initialize the MCP connection first', -32002);
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: tools() };
    if (method !== 'tools/call') throw new RpcError(`Unsupported method: ${method}`, -32601);
    const controller = new AbortController();
    operations.set(id, controller);
    try {
      if (params.name === 'bridge_status') return bridge.status();
      if (params.name === 'bridge_lifecycle') return await bridge.lifecycle(params.arguments ?? {});
      if (!['js', 'js_reset'].includes(params.name)) throw new RpcError(`Unknown CUA tool: ${params.name}`, -32602);
      return await bridge.call(params.name, params.arguments ?? {}, { signal: controller.signal, progressToken: params._meta?.progressToken });
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    } finally { operations.delete(id); }
  },
  onNotification(method, params) {
    if (method === 'notifications/cancelled') operations.get(params.requestId)?.abort(new Error('CUA request cancelled by Claude'));
  },
  onClose: () => void shutdown(),
});

async function shutdown() {
  if (closing) return;
  closing = true;
  for (const operation of operations.values()) operation.abort(new Error('Claude MCP connection closed'));
  const deadline = setTimeout(() => { void bridge.stopHost().finally(() => process.exit(1)); }, 15000);
  try { await bridge.close(); } finally { clearTimeout(deadline); process.exit(0); }
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
