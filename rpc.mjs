import { createInterface } from 'node:readline';

export class RpcError extends Error {
  constructor(message, code = -32603, data) {
    super(message); this.code = code; this.data = data;
  }
}

/** Bidirectional newline JSON-RPC. Stdout is protocol-only. */
export class JsonRpc {
  constructor(input, output, { onRequest, onNotification, onClose, sendCancellation = true } = {}) {
    this.output = output; this.onRequest = onRequest;
    this.onNotification = onNotification; this.onClose = onClose;
    this.sendCancellation = sendCancellation;
    this.pending = new Map(); this.nextId = 1; this.closed = false;
    this.reader = createInterface({ input, crlfDelay: Infinity });
    this.reader.on('line', line => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); }
      catch { this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
      void this.receive(message);
    });
    this.reader.once('close', () => this.close(new Error('RPC transport closed')));
    output.on('error', error => this.close(error));
  }

  send(message) {
    if (this.closed) return false;
    this.output.write(JSON.stringify(message) + '\n');
    return true;
  }

  notify(method, params = {}) { this.send({ jsonrpc: '2.0', method, params }); }

  request(method, params = {}, { timeoutMs = 120000, signal } = {}) {
    if (this.closed) return Promise.reject(new Error('RPC is closed'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Cancelled'));
    const id = `bridge-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => {
        if (this.sendCancellation) this.notify('notifications/cancelled', { requestId: id, reason: 'Caller cancelled' });
        finish(signal.reason ?? new Error('Cancelled'));
      };
      const timer = setTimeout(() => {
        const error = new RpcError(`Timed out waiting for ${method}; execution outcome may be unknown`, -32001);
        if (this.sendCancellation) this.notify('notifications/cancelled', { requestId: id, reason: 'Deadline exceeded' });
        finish(error);
      }, timeoutMs);
      this.pending.set(id, { finish });
      signal?.addEventListener('abort', abort, { once: true });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async receive(message) {
    if (typeof message.method !== 'string') {
      const entry = this.pending.get(message.id);
      if (entry) entry.finish(message.error
        ? new RpcError(message.error.message, message.error.code, message.error.data)
        : null, message.result);
      return;
    }
    if (!Object.hasOwn(message, 'id')) {
      try { await this.onNotification?.(message.method, message.params ?? {}); }
      catch { /* Notifications have no response. */ }
      return;
    }
    try {
      if (!this.onRequest) throw new RpcError(`Unsupported method: ${message.method}`, -32601);
      const result = await this.onRequest(message.method, message.params ?? {}, message.id);
      this.send({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
    } catch (error) {
      this.send({ jsonrpc: '2.0', id: message.id, error: {
        code: error.code ?? -32603, message: error.message,
        ...(error.data === undefined ? {} : { data: error.data }),
      } });
    }
  }

  close(error = new Error('RPC closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) pending.finish(error);
    this.onClose?.(error);
  }
}
