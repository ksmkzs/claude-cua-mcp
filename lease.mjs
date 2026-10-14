import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function withLease(path, action, { signal, timeoutSeconds = 120 } = {}) {
  const child = spawn('/usr/bin/python3', [join(dirname(fileURLToPath(import.meta.url)), 'lease.py'), path, String(timeoutSeconds)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const controller = new AbortController();
  child.stdin.on('error', () => {});
  let released = false, errors = '';
  child.stderr.on('data', data => { errors = (errors + data).slice(-1000); });
  const abort = () => { controller.abort(signal.reason); child.kill('SIGTERM'); };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const lines = createInterface({ input: child.stdout });
  try {
    await new Promise((resolve, reject) => {
      let acquired = false;
      child.once('error', reject);
      child.once('exit', () => {
        if (!released) controller.abort(new Error('CUA operation lock was lost'));
        if (!acquired) reject(new Error(errors.trim() || 'Could not acquire CUA operation lock'));
      });
      lines.once('line', line => {
        if (line !== 'locked') return reject(new Error('Unexpected lock response'));
        acquired = true; resolve();
      });
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    return await action(controller.signal);
  } finally {
    released = true;
    signal?.removeEventListener('abort', abort);
    lines.close(); child.stdin.end();
    // Lock helper owns no operations; terminating it only releases flock.
    child.kill('SIGTERM');
  }
}
