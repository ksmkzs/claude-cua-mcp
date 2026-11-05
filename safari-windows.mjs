// External window coordination only. No CUA imports, code rewriting or vendor changes.
import { createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);
export const referencesSafari = code => typeof code === 'string'
  && /(?:\bSafari\b|com\.apple\.Safari)/i.test(code);
const digest = value => createHash('sha256').update(value).digest('hex');

export class BrokerConnection {
  constructor(socket) {
    this.socket = socket; this.pending = null; this.buffer = ''; this.closed = false;
    socket.setEncoding('utf8');
    socket.on('data', data => {
      this.buffer += data;
      if (this.buffer.length > 65536) return this.fail(new Error('Window broker response exceeds limit'));
      const end = this.buffer.indexOf('\n');
      if (end < 0) return;
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      const pending = this.pending; this.pending = null;
      if (!pending || this.buffer) return this.fail(new Error('Unexpected window broker response'));
      clearTimeout(pending.timer);
      try {
        const value = JSON.parse(line);
        if (value.ok !== true) pending.reject(new Error(value.error || 'Window broker rejected operation'));
        else pending.resolve(value.result);
      } catch (error) { pending.reject(error); }
    });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('Window broker disconnected; do not replay input')));
  }
  fail(error) {
    this.closed = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
    this.socket.destroy();
  }
  request(value) {
    if (this.closed || this.pending) return Promise.reject(new Error('Window broker connection unavailable'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Window broker timed out; inspect before retrying')), 75000);
      this.pending = { resolve, reject, timer };
      this.socket.write(JSON.stringify(value) + '\n');
    });
  }
  close() { this.socket.end(); }
}

export class SafariWindows {
  constructor(config, { connect, start, sleep = delay } = {}) {
    this.config = config;
    this.connect = connect || (() => new BrokerConnection(createConnection(config.socket)));
    this.start = start || (async () => {
      const { stdout } = await run(config.python, [config.control, '--dest', config.runtime, '--start'],
        { timeout: 15000, maxBuffer: 8192 });
      const status = JSON.parse(stdout);
      if (!status.ok || status.result?.bridgeProtocol !== 1 || status.result?.poisoned || status.result?.stopping) {
        throw new Error('Window manager is incompatible or stopped for inspection; no CUA operation sent');
      }
    });
    this.sleep = sleep;
  }
  async readRegistry() {
    try {
      const value = JSON.parse(await readFile(this.config.registry, 'utf8'));
      if (value.version !== 1 || !value.contexts || Array.isArray(value.contexts)) throw new Error('Invalid Safari registry');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, contexts: {} };
      throw error;
    }
  }
  async save(registry) {
    await mkdir(dirname(this.config.registry), { recursive: true, mode: 0o700 });
    const temp = this.config.registry + '.' + randomUUID();
    await writeFile(temp, JSON.stringify(registry) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, this.config.registry);
  }
  async cleanupScope({ client = 'claude', sessionId, agentId, turnId, knownKeys = [], unsafeKeys = [] }) {
    const registry = await this.readRegistry();
    const known = new Set(knownKeys.map(digest)), unsafe = new Set(unsafeKeys.map(digest));
    const results = [];
    for (const [id, record] of Object.entries(registry.contexts)) {
      const scope = record.scope;
      if (!known.has(id) && !(scope?.client === client && scope.session === digest(sessionId)
        && (agentId === undefined || scope.agent === digest(agentId)))) continue;
      // A delayed/repeated Stop must not close a window used by a newer turn.
      // Older records without a turn are eligible only with a live matching context.
      if (turnId && (record.turn ? record.turn !== digest(turnId) : !known.has(id))) continue;
      let lease;
      try {
        if (unsafe.has(id)) throw new Error('Executor cleanup was not confirmed');
        if (record.cleanup?.status === 'manual') throw new Error('Previous cleanup requires manual inspection');
        if (record.state !== 'bound') throw new Error('Window ownership is not fully bound');
        lease = await this.acquire({ registryId: id }, '');
        await lease.closeOwnedWindow();
        results.push({ context: id, closed: true });
      } catch (error) {
        // Never retry a failed close. Retain ownership and a bounded reason only.
        const latest = await this.readRegistry();
        if (latest.contexts[id]) {
          latest.contexts[id].cleanup = { status: 'manual', at: new Date().toISOString(),
            reason: /MULTIPLE_TABS/.test(error.message) ? 'multiple_tabs' :
              /SAFARI_FOREGROUND/.test(error.message) ? 'safari_foreground' :
              unsafe.has(id) ? 'executor_cleanup_unconfirmed' : 'cleanup_failed' };
          await this.save(latest);
        }
        results.push({ context: id, closed: false, manual: true });
      } finally {
        // closeOwnedWindow is terminal; this is a no-op after any close attempt.
        if (lease) await lease.settle();
      }
    }
    return results;
  }
  async acquire(context, code, { signal } = {}) {
    // The shared bridge operation lock encloses registry read/write and the
    // entire native call. Both clients must use the same lock and registry.
    const registry = await this.readRegistry();
    const id = context.registryId ?? digest(context.key);
    let record = registry.contexts[id];
    if (context.safariWindowUUID && record?.windowUUID !== context.safariWindowUUID) {
      const error = new Error('The owned Safari window was closed by lifecycle cleanup. Saved app references are invalid; start with a fresh cua.getApp("Safari") call.');
      error.code = 'OWNED_WINDOW_CLOSED';
      throw error;
    }
    if (context.registryId && !record) throw new Error('Unknown owned-window record');
    if (!record && !referencesSafari(code)) return null;
    if (!record) {
      const [client, session = '', agent = ''] = context.key.split('\0');
      record = registry.contexts[id] = { owner: 'bridge:' + randomUUID(), state: 'creating',
        scope: { client, session: digest(session), agent: digest(agent || '') } };
      // Persist before creation. A lost reply never creates under a new owner.
      await this.save(registry);
    }
    if (record.state === 'quarantined') throw new Error('Safari context requires inspection; no CUA call was forwarded');
    if (typeof record.owner !== 'string' || !['creating', 'bound'].includes(record.state)
      || (record.state === 'bound' && (!record.binding || !record.windowUUID))) {
      throw new Error('Invalid Safari ownership record; no window adopted');
    }
    await this.start();
    const deadline = Date.now() + (this.config.foregroundWaitMs ?? 30000);
    let connection, selected;
    while (true) {
      if (signal?.aborted) throw signal.reason;
      connection = this.connect();
      try {
        selected = await connection.request({ op: 'acquire', owner: record.owner,
          binding: record.binding, create: record.state === 'creating' });
        break;
      } catch (error) {
        connection.close();
        // Window-host rejects foreground Safari before changing any window.
        // This is waiting for a precondition, never retrying a native CUA call.
        if (/SAFARI_FOREGROUND:/.test(error.message) && Date.now() < deadline) {
          await this.sleep(250, undefined, { signal }); continue;
        }
        if (/Window host timed out|Native window registry|CREATION_UNCERTAIN/.test(error.message)) {
          record.state = 'quarantined'; record.cleanup = { status: 'manual', reason: 'creation_outcome_uncertain', at: new Date().toISOString() };
          await this.save(registry);
        }
        throw error;
      }
    }
    try {
      if (!selected.binding && record.state === 'creating') throw new Error('Missing window capability');
      if (!selected.windowUUID || (record.windowUUID && selected.windowUUID !== record.windowUUID)) {
        throw new Error('Safari UUID changed; no window adopted');
      }
      record.binding = selected.binding || record.binding;
      record.windowUUID = selected.windowUUID; record.windowID = selected.windowID;
      record.state = 'bound';
      if (context.turnId) record.turn = digest(context.turnId);
      await this.save(registry);
      context.safariWindowUUID = record.windowUUID;
      const check = async () => {
        const state = await connection.request({ op: 'check' });
        if (!state.selected || state.closed || state.windowUUID !== record.windowUUID) {
          throw new Error('Safari main window changed; do not replay the operation');
        }
        return state;
      };
      // Last external AX check before forwarding; a human focus race remains.
      await check();
      let settled = false;
      return {
        windowUUID: record.windowUUID,
        check,
        quarantine: async () => {
          if (settled) return;
          settled = true;
          record.state = 'quarantined';
          try { await this.save(registry); }
          finally { connection.close(); } // EOF poisons the manager; no window mutation.
        },
        settle: async () => {
          if (settled) return;
          settled = true;
          try { return await connection.request({ op: 'settle' }); }
          finally { connection.close(); }
        },
        closeOwnedWindow: async () => {
          if (settled) throw new Error('Window lease already settled');
          // Close is terminal for the broker connection, including failure.
          // Never send settle afterward or mask the actual close outcome.
          settled = true;
          try {
            const result = await connection.request({ op: 'close' });
            if (result.closed !== true) throw new Error(result.reason === 'multiple_tabs' ? 'MULTIPLE_TABS: retained for manual cleanup' : 'Window closure was not confirmed');
            delete registry.contexts[id]; await this.save(registry);
            return result;
          } catch (error) {
            record.state = 'quarantined';
            await this.save(registry);
            throw error;
          } finally { connection.close(); }
        },
      };
    } catch (error) {
      // No native CUA request was forwarded. It is safe to settle now.
      try { await connection.request({ op: 'settle' }); }
      catch { record.state = 'quarantined'; await this.save(registry); }
      finally { connection.close(); }
      throw error;
    }
  }
}
