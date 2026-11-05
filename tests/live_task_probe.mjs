// Explicit local fixture harness. Uses the real hooks/MCP/bridge; never accepts approvals.
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, writeFile, chmod, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { JsonRpc } from '../rpc.mjs';

const [rootArg, outputArg, control] = process.argv.slice(2);
if (!rootArg || !outputArg || !control) throw new Error('runtime output control-socket required');
const root = resolve(rootArg), output = resolve(outputArg), runId = randomUUID();
await mkdir(output, { recursive: true, mode: 0o700 });
let child, rpc, calls = 0, closing = false;
const fixturePath = '/bridge-fixture-' + runId;
const http = createHttpServer((request, response) => {
  if (request.url !== fixturePath) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'");
  response.end('<!doctype html><title>Bridge task fixture ' + runId +
    '</title><h1>Owned bridge fixture</h1><label for="probe">Probe value</label><input id="probe" type="text" autocomplete="off">');
});
http.listen(0, '127.0.0.1'); await once(http, 'listening');
const fixtureURL = `http://127.0.0.1:${http.address().port}${fixturePath}`;

async function start() {
  child = spawn(process.execPath, [join(root, 'server.mjs')], {
    env: { ...process.env, CUA_BRIDGE_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  rpc = new JsonRpc(child.stdout, child.stdin, {
    onRequest: async method => {
      await writeFile(join(output, 'approval-declined.json'), JSON.stringify({ method, declined: true }));
      return { action: 'decline', content: null };
    },
  });
  await rpc.request('initialize', { protocolVersion: '2025-11-25',
    clientInfo: { name: 'owned-task-window-test', version: '1' }, capabilities: {} });
  rpc.notify('notifications/initialized');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = once(child, 'exit');
  child.stdin.end();
  await done;
}
async function hook(client, tool, args, context, agentId = '') {
  const c = spawn(process.execPath, [join(root, client === 'codex' ? 'codex-hook.mjs' : 'hook.mjs')], {
    env: { ...process.env, CUA_BRIDGE_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let text = '', error = '';
  c.stdout.on('data', b => { text += b; }); c.stderr.on('data', b => { error += b; });
  c.stdin.end(JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: `owned-test-${runId}-${context}`,
    prompt_id: 'fixture-turn', turn_id: 'fixture-turn', agent_id: agentId,
    tool_use_id: randomUUID(), cwd: output,
    tool_name: `mcp__${client === 'codex' ? 'task_cua' : 'codex-computer-use'}__${tool}`,
    tool_input: args,
  }));
  const [code] = await once(c, 'exit');
  if (code !== 0) throw new Error(error || 'Routing hook failed');
  const value = JSON.parse(text).hookSpecificOutput;
  if (!value.updatedInput || value.permissionDecision === 'deny') throw new Error('Routing hook refused test');
  return value.updatedInput;
}
await start();
let queue = Promise.resolve();
const server = createNetServer(socket => {
  let text = '';
  socket.on('data', bytes => {
    text += bytes;
    if (text.length > 2 * 1024 * 1024) { socket.destroy(); return; }
    if (!text.endsWith('\n')) return;
    socket.pause();
    queue = queue.then(async () => {
      try {
        const request = JSON.parse(text);
        let result;
        if (request.op === 'call') {
          if (!['claude', 'codex'].includes(request.client) || !/^[A-Z]$/.test(request.context)) throw new Error('Invalid test identity');
          const tool = request.tool ?? 'js';
          const args = tool === 'js' ? (request.completion_summary !== undefined
            ? {completion_summary:request.completion_summary}
            : {code:request.code,...(request.timeout_ms ? {timeout_ms:request.timeout_ms} : {})}) : {};
          const signed = await hook(request.client, tool, args, request.context, request.agentId || '');
          result = await rpc.request('tools/call', { name: tool, arguments: signed }, { timeoutMs: 300000 });
          const path = join(output, `call-${String(++calls).padStart(3, '0')}.json`);
          await writeFile(path, JSON.stringify({ client: request.client, context: request.context, tool, result }, null, 2), { mode: 0o600 });
          result = { path, result };
        } else if (request.op === 'lifecycle') {
          if (!/^[A-Z]$/.test(request.context) || !['SubagentStop', 'SessionEnd'].includes(request.event)) throw new Error('Invalid lifecycle fixture');
          result = await rpc.request('tools/call', {name:'bridge_lifecycle',arguments:{event:request.event,
            session_id:`owned-test-${runId}-${request.context}`,agent_id:request.agentId || ''}});
          await writeFile(join(output, `lifecycle-${request.context}-${request.event}.json`), JSON.stringify(result,null,2));
        } else if (request.op === 'codex_lifecycle') {
          if (!/^[A-Z]$/.test(request.context) || !['Stop','SubagentStop'].includes(request.event)
            || (request.event === 'SubagentStop' && !/^[A-Z]$/.test(request.childContext))) throw new Error('Invalid Codex lifecycle fixture');
          result = await rpc.request('tools/call', {name:'codex_lifecycle',arguments:{event:request.event,
            session_id:`owned-test-${runId}-${request.context}`,turn_id:'fixture-turn',
            ...(request.event === 'SubagentStop' ? {agent_id:`owned-test-${runId}-${request.childContext}`} : {})}});
          await writeFile(join(output, `codex-lifecycle-${request.context}-${request.event}.json`), JSON.stringify(result,null,2));
        } else if (request.op === 'status') {
          result = await rpc.request('tools/call', { name: 'bridge_status', arguments: {} });
        } else if (request.op === 'restart') {
          await stop(); await start(); result = { restarted: true };
        } else if (request.op === 'stop') {
          await stop(); result = { stopped: true };
          closing = true;
        } else throw new Error('Unsupported probe operation');
        socket.end(JSON.stringify({ ok: true, result }) + '\n');
      } catch (error) { socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n'); }
      if (closing) {
        server.close(); http.close(); await unlink(control).catch(() => {});
      }
    });
  });
});
server.listen(control); await once(server, 'listening'); await chmod(control, 0o600);
await writeFile(join(output, 'harness.json'), JSON.stringify({
  root, control, fixtureURL, runId, pid: process.pid, node: process.execPath,
}, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ control, fixtureURL, output, pid: process.pid }));
