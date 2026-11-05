import { setTimeout as delay } from 'node:timers/promises';

// Only call for a process group created by this bridge with detached:true.
export async function stopProcessGroup(pid, { kill = process.kill, sleep = delay } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid owned process group');
  const send = signal => {
    try { kill(-pid, signal); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  if (!send('SIGTERM')) return;
  for (let i = 0; i < 60; i++) {
    if (!send(0)) return;
    await sleep(50);
  }
  if (!send('SIGKILL')) return;
  for (let i = 0; i < 60; i++) {
    if (!send(0)) return;
    await sleep(50);
  }
  throw new Error('Owned CUA process group termination is unconfirmed');
}
