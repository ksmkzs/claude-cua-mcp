#!/usr/bin/env node
// Explicit local maintenance. Only opaque owned-record IDs are accepted.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafariWindows } from './safari-windows.mjs';
import { withLease } from './lease.mjs';

const root = process.env.CUA_BRIDGE_HOME || dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
if (!config.safariWindows || !config.operationLock) throw new Error('Window routing is not configured');
const windows = new SafariWindows(config.safariWindows);
const [operation, id] = process.argv.slice(2);
if (operation === '--list' && !id) {
  const registry = await windows.readRegistry();
  console.log(JSON.stringify(Object.entries(registry.contexts).map(([context, record]) => ({
    context, state: record.state, cleanup: record.cleanup, windowUUID: record.windowUUID, windowID: record.windowID,
  }))));
} else if (operation === '--close' && /^[a-f0-9]{64}$/.test(id || '')) {
  await withLease(config.operationLock, async () => {
    const lease = await windows.acquire({ registryId: id }, '');
    try { console.log(JSON.stringify(await lease.closeOwnedWindow())); }
    finally { await lease.settle(); }
  });
} else {
  throw new Error('Use --list (no UI) or --close <owned context hash>. Never pass a title, URL or window ID.');
}
