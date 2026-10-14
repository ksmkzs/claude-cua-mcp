import { spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { once } from 'node:events';
import { JsonRpc, RpcError } from './rpc.mjs';
import { appServerArgs } from './config.mjs';
import { cleanArguments, stable, verifyContext } from './context.mjs';
import { withLease } from './lease.mjs';

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });
const contextKey = c => `${c.session_id}\0${c.agent_id || ''}`;
const present = value => typeof value === 'string' && value && !value.startsWith('${') ? value : '';

export class CuaBridge {
  constructor({ root, config, key, tools, clientRequest, clientNotify, capabilities = {}, spawnFn = spawn, lease = withLease }) {
    Object.assign(this, { root, config, key, tools, clientRequest, clientNotify, capabilities, spawnFn, lease });
    this.contexts = new Map(); this.consumed = new Set(); this.queue = Promise.resolve();
    this.generation = 0; this.closed = false; this.active = null; this.ending = new Set(); this.endedSessions = new Set();
    this.instance = randomUUID();
  }

  async audit(event, fields = {}) {
    // No code, UI text, screenshots, credentials or approval contents in this log.
    try { await appendFile(join(this.root, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), instance: this.instance, event, ...fields }) + '\n', { mode: 0o600 }); }
    catch { /* Audit failure cannot grant permission or change operation semantics. */ }
  }

  serial(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async start() {
    if (this.closed) throw new Error('CUA bridge is shutting down');
    if (this.rpc && !this.rpc.closed) return;
    const generation = ++this.generation;
    const child = this.spawnFn(this.config.codexPath, appServerArgs(this.config), {
      stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      env: { ...process.env, ...(this.config.cua.env.CUA_REPL_NODE_REPL_PATH ? { CODEX_NODE_REPL_PATH: this.config.cua.env.CUA_REPL_NODE_REPL_PATH } : {}) },
    });
    this.child = child;
    // Drain vendor diagnostics, but do not persist unrelated config or private data.
    child.stderr.on('data', () => {});
    const rpc = new JsonRpc(child.stdout, child.stdin, {
      // App-server exposes no generic MCP-request cancellation. We terminate our
      // dedicated host after cleanup when an in-flight call is cancelled.
      sendCancellation: false,
      onRequest: (method, params) => this.hostRequest(method, params),
      onNotification: (method, params) => {
        if (method === 'mcpToolCall/progress' && this.active?.progressToken !== undefined) {
          this.clientNotify('notifications/progress', { progressToken: this.active.progressToken,
            progress: ++this.active.progress, message: params.message });
        }
      },
    });
    this.rpc = rpc;
    child.once('error', error => rpc.close(error));
    child.once('exit', () => {
      rpc.close(new Error('Codex app-server exited. Do not replay an uncertain operation; reacquire state.'));
      if (this.generation === generation) {
        for (const context of this.contexts.values()) context.lost = true;
      }
    });
    try {
      await rpc.request('initialize', { clientInfo: { name: 'claude_cua_bridge', title: 'Claude CUA bridge', version: '0.1.0' },
        capabilities: { experimentalApi: true } });
      rpc.notify('initialized');
      await this.audit('host_started', { generation });
    } catch (error) { await this.stopHost(); throw error; }
  }

  async hostRequest(method, params) {
    if (method !== 'mcpServer/elicitation/request') {
      // This integration has no model turns, shell execution or token refresh flow.
      throw new RpcError(`Unsupported host request: ${method}`, -32601);
    }
    const active = this.active;
    if (!active || params.threadId !== active.context.threadId || params.serverName !== 'claude_cua') return { action: 'decline', content: null };
    if (active.signal.aborted) return { action: 'cancel', content: null };
    const mode = params.mode ?? 'form';
    const elicitation = this.capabilities.elicitation;
    const supported = elicitation && ((mode === 'form' && (elicitation.form !== undefined || Object.keys(elicitation).length === 0))
      || (mode === 'url' && elicitation.url !== undefined));
    if (!supported) {
      active.warnings.push(`Claude client cannot display CUA approval mode '${mode}'; the request was declined.`);
      return { action: 'decline', content: null };
    }
    const { serverName, threadId, turnId, ...request } = params;
    await this.audit('approval_requested', { mode });
    try {
      const answer = await this.clientRequest('elicitation/create', request, { timeoutMs: 300000, signal: active.signal });
      if (!['accept', 'decline', 'cancel'].includes(answer?.action)) throw new Error('Invalid approval response');
      await this.audit('approval_resolved', { action: answer.action });
      return { action: answer.action, content: answer.action === 'accept' ? (answer.content ?? null) : null,
        ...(answer._meta ? { _meta: answer._meta } : {}) };
    } catch {
      active.warnings.push('CUA approval was cancelled or could not be delivered; no approval was supplied.');
      return { action: 'cancel', content: null };
    }
  }

  async getContext(c) {
    const key = contextKey(c);
    let context = this.contexts.get(key);
    if (context?.lost) {
      this.contexts.delete(key);
      throw new Error('The previous CUA runtime was lost. Its variables and UI references are invalid. Make a fresh observation in a new tool call; do not repeat an uncertain action.');
    }
    if (!context) {
      await this.start();
      const result = await this.rpc.request('thread/start', { cwd: c.cwd, ephemeral: true });
      context = { key, sessionId: c.session_id, agentId: c.agent_id, threadId: result.thread.id,
        turnId: null, endedTurns: new Set(), lost: false, cwd: c.cwd,
        approvalPolicy: result.approvalPolicy, sandbox: result.sandbox,
        generation: this.generation };
      this.contexts.set(key, context);
      const status = await this.rpc.request('mcpServerStatus/list', { threadId: context.threadId,
        serverName: 'claude_cua', detail: 'toolsAndAuthOnly' });
      const server = status.data?.find(x => x.name === 'claude_cua');
      for (const name of ['js', 'js_reset', 'turn_ended']) {
        const current = server?.tools?.[name];
        const recorded = this.tools.find(x => x.name === name);
        if (!current || stable(current.inputSchema) !== stable(recorded?.inputSchema)) {
          context.lost = true;
          throw new Error('CUA tool schema is unavailable or changed. Re-run installation compatibility checks before using this bridge.');
        }
      }
      await this.audit('context_started', { threadId: context.threadId,
        source: createHash('sha256').update(key).digest('hex').slice(0, 16) });
    }
    if (context.cwd !== c.cwd) {
      // Native bindings are not file-workspace references; keep routing scoped to the original runtime.
      await this.audit('cwd_changed', { threadId: context.threadId });
    }
    if (context.turnId !== c.prompt_id) {
      if (context.turnId) await this.finishTurn(context, 'Stop');
      context.turnId = c.prompt_id;
      // Stop hooks may continue the SAME prompt after a review. Reactivate its lifecycle.
      context.endedTurns.delete(c.prompt_id);
    } else if (context.endedTurns.has(c.prompt_id)) context.endedTurns.delete(c.prompt_id);
    return context;
  }

  async finishTurn(context, event) {
    const fields = { threadId: context.threadId, turnId: context.turnId,
      generation: context.generation, hookEvent: event, cleanupConfirmed: false };
    const reason = !context.turnId ? 'no_turn' : context.lost ? 'runtime_lost'
      : context.endedTurns.has(context.turnId) ? 'already_notified' : null;
    if (reason) {
      await this.audit('turn_end_skipped', { ...fields, reason });
      return;
    }
    const attemptId = randomUUID();
    const started = performance.now();
    await this.audit('turn_end_requested', { ...fields, attemptId });
    let rejected = false;
    try {
      const result = await this.rpc.request('mcpServer/tool/call', { threadId: context.threadId,
      server: 'claude_cua', tool: 'turn_ended', arguments: {
        hook_event_name: event, session_id: context.threadId, turn_id: context.turnId,
      } }, { timeoutMs: 10000 });
      rejected = !!result.isError;
      if (rejected) throw new Error('CUA rejected its turn-ended notification; cleanup is unconfirmed');
      context.endedTurns.add(context.turnId);
      // Preserve the existing event name for consumers. An RPC acknowledgement
      // does not attest native cursor ownership matching or resource release.
      await this.audit('turn_ended', { ...fields, attemptId,
        outcome: 'notification_acknowledged', durationMs: Math.round(performance.now() - started) });
    } catch (error) {
      await this.audit('turn_end_failed', { ...fields, attemptId,
        outcome: rejected ? 'tool_rejected' : 'rpc_failed',
        durationMs: Math.round(performance.now() - started) });
      throw error;
    }
  }

  async call(tool, args, { signal, progressToken } = {}) {
    const c = verifyContext(args?._bridge_context, args, tool, this.key);
    const requestKey = `${contextKey(c)}\0${c.tool_use_id}`;
    if (this.consumed.has(requestKey)) throw new Error('Duplicate CUA request rejected. Make a fresh observation instead of replaying it.');
    this.consumed.add(requestKey);
    const clean = cleanArguments(args);
    if (tool === 'js') {
      if (typeof clean.code !== 'string' || !clean.code.trim()) throw new Error('code must be a nonempty string');
      if (clean.timeout_ms !== undefined && (!Number.isInteger(clean.timeout_ms) || clean.timeout_ms < 1 || clean.timeout_ms > 300000)) throw new Error('timeout_ms must be between 1 and 300000');
    }
    return this.serial(async () => {
      if (signal?.aborted) throw signal.reason;
      if (this.closed || this.endedSessions.has(c.session_id) || this.ending.has(contextKey(c))) throw new Error('This Claude session is ending');
      return this.lease(join(this.root, 'operation.lock'), async leaseSignal => {
        if (leaseSignal.aborted) throw leaseSignal.reason;
        const context = await this.getContext(c);
        if (leaseSignal.aborted) throw leaseSignal.reason;
        const aborter = new AbortController();
        const cancel = () => aborter.abort(leaseSignal.reason ?? new Error('Cancelled'));
        leaseSignal.addEventListener('abort', cancel, { once: true });
        const active = { context, signal: aborter.signal, aborter, progressToken, progress: 0, warnings: [] };
        this.active = active;
        await this.audit('call_started', { threadId: context.threadId, turnId: context.turnId,
          generation: context.generation, callId: c.tool_use_id, tool });
        try {
          const result = await this.rpc.request('mcpServer/tool/call', {
            threadId: context.threadId, server: 'claude_cua', tool, arguments: clean,
            _meta: { 'x-codex-turn-metadata': {
              session_id: context.threadId, thread_id: context.threadId, turn_id: c.prompt_id,
              call_id: c.tool_use_id,
              // These describe the actual external caller, never a borrowed Codex session/model.
              client_name: 'claude_cua_bridge',
            } },
          }, { timeoutMs: Math.max(120000, (clean.timeout_ms ?? 30000) + 60000), signal: aborter.signal });
          await this.audit('call_finished', { threadId: context.threadId, tool, isError: !!result.isError });
          if (active.warnings.length) result.content.push(...active.warnings.map(text => ({ type: 'text', text })));
          return result;
        } catch (error) {
          await this.audit('call_interrupted', { threadId: context.threadId, tool });
          // No retry of a possibly executed UI action. Try normal cleanup, then stop only our host.
          try { await this.finishTurn(context, 'Interrupt'); } catch { /* Outcome remains unconfirmed. */ }
          await this.stopHost();
          throw new Error(`${error.message}. CUA state was discarded; observe the app before attempting another action.`);
        } finally {
          this.active = null; leaseSignal.removeEventListener('abort', cancel);
        }
      }, { signal });
    });
  }

  async lifecycle(args) {
    const sessionId = present(args.session_id), agentId = present(args.agent_id), promptId = present(args.prompt_id);
    const event = args.event;
    if (!sessionId || !['Stop', 'StopFailure', 'SubagentStop', 'SessionEnd'].includes(event)) return textResult('{}');
    if (event === 'SessionEnd') this.endedSessions.add(sessionId);
    if (event === 'SubagentStop') this.ending.add(`${sessionId}\0${agentId}`);
    const contexts = [...this.contexts.values()].filter(c => c.sessionId === sessionId
      && (event === 'SessionEnd' || c.agentId === agentId)
      && (!promptId || event === 'SessionEnd' || c.turnId === promptId));
    if (event === 'SessionEnd') for (const context of contexts) this.ending.add(context.key);
    if (contexts.includes(this.active?.context)) this.active.aborter.abort(new Error(`Claude ${event}`));
    await this.serial(async () => {
      const latest = [...this.contexts.values()].filter(c => c.sessionId === sessionId
        && (event === 'SessionEnd' || c.agentId === agentId)
        && (!promptId || event === 'SessionEnd' || c.turnId === promptId));
      await this.audit('lifecycle_matched', { hookEvent: event, matchedContexts: latest.length,
        source: createHash('sha256').update(`${sessionId}\0${agentId}`).digest('hex').slice(0, 16),
        turnId: promptId || null });
      for (const context of latest) {
        await this.finishTurn(context, event === 'StopFailure' ? 'Interrupt' : event);
        if (event === 'SessionEnd' || event === 'SubagentStop') {
          if (!context.lost) await this.rpc.request('thread/unsubscribe', { threadId: context.threadId }, { timeoutMs: 10000 });
          this.contexts.delete(context.key);
        }
      }
      if (event === 'SessionEnd' && this.contexts.size === 0) await this.stopHost();
    });
    return textResult('{}');
  }

  status() {
    return textResult(JSON.stringify({ bridge: '0.1.0', hostRunning: !!this.rpc && !this.rpc.closed,
      documentationProfile: this.config.cua.env.CUA_REPL_NODE_REPL_PATH,
      enabledSurfaces: this.config.cua.env.CUA_REPL_ENABLED_SURFACES,
      contexts: [...this.contexts.values()].map(c => ({ threadId: c.threadId, lost: c.lost,
        approvalPolicy: c.approvalPolicy, turnEnded: c.endedTurns.has(c.turnId) })),
      active: !!this.active,
      concurrency: 'Claude bridge operations are serialized; desktop Codex/user coexistence depends on the native host.',
    }));
  }

  async stopHost() {
    const child = this.child;
    this.child = null;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode) return;
    const exited = once(child, 'exit').catch(() => {});
    // The detached process group contains only this bridge's app-server and its children.
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 3000);
    await exited; clearTimeout(timer);
    for (const context of this.contexts.values()) context.lost = true;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.active?.aborter.abort(new Error('Claude disconnected'));
    await this.serial(async () => {
      for (const context of this.contexts.values()) {
        try { await this.finishTurn(context, 'Interrupt'); } catch { /* Still stop host below. */ }
      }
      await this.stopHost();
    });
  }
}
