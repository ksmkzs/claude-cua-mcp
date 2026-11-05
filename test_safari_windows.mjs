import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafariWindows } from './safari-windows.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cua-window-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], bindings = new Map();
  let count = 0, foreground = 0, wrong = false;
  const config = { registry: join(root, 'registry.json') };
  const dependencies = {
    start: async () => { calls.push('start'); },
    sleep: async () => { calls.push('wait'); },
    connect: () => {
      let binding;
      return {
        close() { calls.push('close'); },
        async request(request) {
          calls.push(request.op);
          if (request.op === 'acquire') {
            if (foreground-- > 0) throw new Error('SAFARI_FOREGROUND: wait');
            if (request.create) {
              if (!bindings.has(request.owner)) bindings.set(request.owner, {
                binding: `private-${++count}`, windowUUID: `uuid-${count}`, windowID: count,
              });
            }
            binding = bindings.get(request.owner);
            if (!binding || (!request.create && request.binding !== binding.binding)) throw new Error('BINDING_INVALID');
            return binding;
          }
          if (request.op === 'check') return { ...binding, selected: !wrong, closed: false };
          if (request.op === 'settle') return { parked: true };
          throw new Error('Unexpected request');
        },
      };
    },
  };
  return { config, dependencies, calls, bindings, instance: () => new SafariWindows(config, dependencies),
    foreground: n => { foreground = n; }, wrong: () => { wrong = true; } };
}

test('non-Safari context never starts a window manager', async t => {
  const f = await fixture(t);
  assert.equal(await f.instance().acquire({ key: 'other' }, 'let app = await cua.getApp("TextEdit");'), null);
  assert.deepEqual(f.calls, []);
});
test('saved app reference reselects same UUID after bridge restart; agents remain separate', async t => {
  const f = await fixture(t), context = { key: 'session\0agent-a' };
  const first = await f.instance().acquire(context, 'let app = await cua.getApp("Safari");');
  await first.check(); await first.settle();
  const second = await f.instance().acquire(context, 'await app.getAXState();');
  assert.equal(second.windowUUID, first.windowUUID);
  await second.settle();
  const other = await f.instance().acquire({ key: 'session\0agent-b' }, 'await cua.getApp("Safari")');
  assert.notEqual(other.windowUUID, first.windowUUID);
  await other.settle();
  assert.equal(f.bindings.size, 2);
  assert.equal(JSON.parse(await readFile(f.config.registry)).version, 1);
});
test('foreground Safari waits before acquisition, not by retrying a native action', async t => {
  const f = await fixture(t); f.foreground(2);
  const lease = await f.instance().acquire({ key: 'task' }, 'await cua.getApp("Safari")');
  assert.equal(f.calls.filter(x => x === 'wait').length, 2);
  assert.equal(f.bindings.size, 1);
  await lease.settle();
});
test('changed main window is rejected; lease is retained until executor settles', async t => {
  const f = await fixture(t);
  const lease = await f.instance().acquire({ key: 'task' }, 'await cua.getApp("Safari")');
  f.wrong();
  await assert.rejects(lease.check(), /main window changed/);
  assert.ok(!f.calls.includes('settle'));
  await lease.settle();
  assert.equal(f.calls.filter(x => x === 'settle').length, 1);
});
test('lost host registry never adopts window or creates a replacement', async t => {
  const f = await fixture(t), c = { key: 'task' };
  const lease = await f.instance().acquire(c, 'await cua.getApp("Safari")'); await lease.settle();
  f.bindings.clear();
  await assert.rejects(f.instance().acquire(c, 'await app.getAXState()'), /BINDING_INVALID/);
  assert.equal(f.bindings.size, 0);
});
test('uncertain close preserves its error, quarantines record and never settles again', async t => {
  const f = await fixture(t), c = { key: 'task' };
  const lease = await f.instance().acquire(c, 'await cua.getApp("Safari")');
  await assert.rejects(lease.closeOwnedWindow(), /Unexpected request/);
  await lease.settle();
  assert.equal(f.calls.filter(x => x === 'settle').length, 0);
  await assert.rejects(f.instance().acquire(c, 'await app.getAXState()'), /requires inspection/);
});

test('lifecycle cleanup after bridge restart targets only the requested agent and leaves manual receipts', async t => {
  const f = await fixture(t);
  const keys = ['claude\0s\0a', 'claude\0s\0b', 'codex\0s\0a'];
  for (const key of keys) { const l = await f.instance().acquire({key}, 'Safari'); await l.settle(); }
  const result = await f.instance().cleanupScope({sessionId:'s',agentId:'a'});
  assert.equal(result.length,1); assert.equal(result[0].manual,true);
  const registry = await f.instance().readRegistry();
  assert.equal(Object.values(registry.contexts).filter(r=>r.cleanup?.status==='manual').length,1);
  const before = f.calls.length;
  await f.instance().cleanupScope({sessionId:'s',agentId:'a'});
  assert.equal(f.calls.length,before, 'a failed close must not be sent again');
  const end = await f.instance().cleanupScope({sessionId:'s'});
  assert.equal(end.length,2, 'SessionEnd includes parent/children of Claude only');
});

test('successful terminal cleanup deletes only matching owned records', async t => {
  const f = await fixture(t), connect = f.dependencies.connect;
  f.dependencies.connect = () => {
    const c = connect(), request = c.request.bind(c);
    c.request = async value => value.op === 'close' ? {closed:true} : request(value);
    return c;
  };
  for (const key of ['claude\0s\0', 'claude\0s\0child', 'claude\0other\0']) {
    const l = await f.instance().acquire({key}, 'Safari'); await l.settle();
  }
  const child = await f.instance().cleanupScope({sessionId:'s',agentId:'child'});
  assert.equal(child.length,1); assert.equal(child[0].closed,true);
  assert.equal(Object.keys((await f.instance().readRegistry()).contexts).length,2);
  const parent = await f.instance().cleanupScope({sessionId:'s'});
  assert.equal(parent.length,1); assert.equal(parent[0].closed,true);
  assert.equal(Object.keys((await f.instance().readRegistry()).contexts).length,1);
});

test('Codex turn-scoped cleanup survives bridge restart and ignores a delayed Stop',async t=>{
 const f=await fixture(t), connect=f.dependencies.connect;
 f.dependencies.connect=()=>{const c=connect(),request=c.request.bind(c);c.request=async v=>v.op==='close'?{closed:true}:request(v);return c;};
 const context={key:'codex\0s\0',turnId:'old'};
 let l=await f.instance().acquire(context,'Safari');await l.settle();
 context.turnId='new';l=await f.instance().acquire(context,'app.getAXState()');await l.settle();
 let r=await f.instance().cleanupScope({client:'codex',sessionId:'s',agentId:'',turnId:'old'});
 assert.deepEqual(r,[]);assert.equal(Object.keys((await f.instance().readRegistry()).contexts).length,1);
 r=await f.instance().cleanupScope({client:'codex',sessionId:'s',agentId:'',turnId:'new'});
 assert.equal(r[0].closed,true);
 const before=f.calls.length;
 await assert.rejects(f.instance().acquire(context,'app.typeText("must not run")'),e=>e.code==='OWNED_WINDOW_CLOSED');
 assert.equal(f.calls.length,before,'no manager or new window for a stale saved app');
 const fresh=await f.instance().acquire({key:context.key,turnId:'next'},'Safari');
 assert.notEqual(fresh.windowUUID,context.safariWindowUUID);await fresh.settle();
});
