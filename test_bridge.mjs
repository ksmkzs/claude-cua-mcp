import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuaBridge } from './bridge.mjs';
import { signContext, verifyContext } from './context.mjs';
import { withLease } from './lease.mjs';
const key = Buffer.alloc(32, 7);
const tools = ['js','js_reset','turn_ended'].map(name => ({name, description:'Synthetic test tool', inputSchema:{type:'object',properties:{}}}));
function args(session='s', prompt='p', agent='', code='1') {
 const a={code}; a._bridge_context=signContext({session_id:session,prompt_id:prompt,agent_id:agent,cwd:tmpdir(),tool_use_id:crypto.randomUUID(),tool_name:'mcp__codex-computer-use__js',tool_input:a},key); return a;
}
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'cua-test-')); t.after(()=>rm(root,{recursive:true,force:true}));
 const calls=[]; let n=0;
 const b=new CuaBridge({root,config:{cua:{env:{}}},key,tools,clientNotify:()=>{},clientRequest:async()=>({action:'accept',content:{ok:true}}),lease:async(p,f,{signal}={})=>f(signal??new AbortController().signal)});
 b.rpc={closed:false,request:async(method,p)=>{calls.push({method,p}); if(method==='thread/start')return {thread:{id:`real-${++n}`},approvalPolicy:'on-request',sandbox:{}}; if(method==='mcpServerStatus/list')return {data:[{name:'claude_cua',tools:Object.fromEntries(tools.map(x=>[x.name,x]))}]};return {content:[{type:'text',text:'ok'}],structuredContent:{ok:true}};}};
 b.stopHost=async()=>{b.stopped=true;for(const c of b.contexts.values())c.lost=true;}; return {b,calls};
}
test('signed context binds caller, tool and arguments',()=>{
 const a=args(); assert.equal(verifyContext(a._bridge_context,a,'js',key).session_id,'s');
 assert.throws(()=>verifyContext(undefined,a,'js',key),/missing/);
 assert.throws(()=>verifyContext(a._bridge_context,{...a,code:'2'},'js',key),/changed/);
 assert.throws(()=>verifyContext(a._bridge_context,a,'js_reset',key),/another tool/);
 assert.throws(()=>verifyContext(a._bridge_context,a,'js',Buffer.alloc(32)),/signature/);
});
test('reuse, agent isolation, host IDs and exactly-once lifecycle',async t=>{
 const {b,calls}=await fixture(t);const a=args(); await b.call('js',a);await b.call('js',args()); await b.call('js',args('s','p','child'));
 assert.equal(calls.filter(c=>c.method==='thread/start').length,2);
 const op=calls.find(c=>c.p.tool==='js');assert.equal(op.p._meta['x-codex-turn-metadata'].session_id,'real-1');assert.equal(op.p.arguments._bridge_context,undefined);
 await assert.rejects(b.call('js',a),/Duplicate/);
 await b.lifecycle({event:'Stop',session_id:'s',prompt_id:'p'});await b.lifecycle({event:'Stop',session_id:'s',prompt_id:'p'});
 assert.equal(calls.filter(c=>c.p.tool==='turn_ended').length,1);
 await b.call('js',args('s','p2'));await b.call('js',args('s','p3'));assert.equal(calls.filter(c=>c.p.tool==='turn_ended').length,2);
 await b.lifecycle({event:'SessionEnd',session_id:'s'});assert.equal(b.contexts.size,0);assert.equal(b.stopped,true);
 await assert.rejects(b.call('js',args()),/ending/);assert.ok(!calls.some(c=>c.method==='turn/start'));
});
test('approvals relay only for matching context and supported modes',async t=>{
 const {b}=await fixture(t);b.active={context:{threadId:'r'},signal:new AbortController().signal,warnings:[]};const p={threadId:'r',serverName:'claude_cua',mode:'form',message:'test',requestedSchema:{}};
 assert.equal((await b.hostRequest('mcpServer/elicitation/request',p)).action,'decline');b.capabilities={elicitation:{form:{}}};
 assert.equal((await b.hostRequest('mcpServer/elicitation/request',p)).action,'accept');
 assert.equal((await b.hostRequest('mcpServer/elicitation/request',{...p,threadId:'other'})).action,'decline');
 assert.equal((await b.hostRequest('mcpServer/elicitation/request',{...p,mode:'openai/form'})).action,'decline');
 b.clientRequest=async()=>({action:'decline',content:{ok:true}});assert.equal((await b.hostRequest('mcpServer/elicitation/request',p)).content,null);
});
test('schema drift blocks operations',async t=>{
 const {b,calls}=await fixture(t);const request=b.rpc.request;b.rpc.request=(m,p)=>m==='mcpServerStatus/list'?Promise.resolve({data:[]}):request(m,p);
 await assert.rejects(b.call('js',args()),/schema/);assert.ok(!calls.some(c=>c.p.tool==='js'));
});
test('uncertain failure ends turn, kills host, never replays action',async t=>{
 const {b,calls}=await fixture(t);const request=b.rpc.request;b.rpc.request=(m,p)=>p.tool==='js'?Promise.reject(new Error('disconnected')):request(m,p);
 await assert.rejects(b.call('js',args()),/state was discarded/);assert.equal(b.stopped,true);
 assert.equal(calls.filter(c=>c.p.tool==='turn_ended').length,1);await assert.rejects(b.call('js',args()),/runtime was lost/);
});
test('OS lease serializes processes and releases after error',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cua-lock-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'lock');const order=[];let release;let acquired;
 const ready=new Promise(r=>acquired=r);const gate=new Promise(r=>release=r);
 const first=withLease(path,async()=>{order.push(1);acquired();await gate;throw new Error('expected');});await ready;
 const second=withLease(path,async()=>order.push(2));release();await assert.rejects(first,/expected/);await second;assert.deepEqual(order,[1,2]);
});

test('lifecycle diagnostics correlate calls and acknowledgements without claiming cleanup', async t=>{
 const {b}=await fixture(t);
 await b.call('js',args('s','p','','PRIVATE_CODE_MARKER'));
 await b.lifecycle({event:'Stop',session_id:'s',prompt_id:'wrong'});
 await b.lifecycle({event:'Stop',session_id:'s',prompt_id:'p'});
 await b.lifecycle({event:'Stop',session_id:'s',prompt_id:'p'});
 const raw=await readFile(join(b.root,'events.jsonl'),'utf8');
 const events=raw.trim().split('\n').map(JSON.parse);
 const start=events.find(e=>e.event==='call_started');
 const request=events.find(e=>e.event==='turn_end_requested');
 const ack=events.find(e=>e.event==='turn_ended');
 assert.equal(request.threadId,start.threadId);assert.equal(request.turnId,start.turnId);
 assert.equal(request.attemptId,ack.attemptId);assert.equal(ack.cleanupConfirmed,false);
 assert.equal(ack.outcome,'notification_acknowledged');
 assert.ok(events.some(e=>e.event==='lifecycle_matched'&&e.matchedContexts===0));
 assert.ok(events.some(e=>e.reason==='already_notified'));
 assert.ok(!raw.includes('PRIVATE_CODE_MARKER'));
});

test('failed lifecycle notifications remain retryable and never persist response or error text',async t=>{
 const {b}=await fixture(t);await b.call('js',args());
 const request=b.rpc.request;let mode='reject';
 b.rpc.request=(m,p)=>{
  if(p.tool!=='turn_ended')return request(m,p);
  if(mode==='reject')return Promise.resolve({isError:true,content:[{text:'PRIVATE_RESPONSE'}]});
  if(mode==='throw')throw new Error('PRIVATE_ERROR');
  return request(m,p);
 };
 await assert.rejects(b.lifecycle({event:'Stop',session_id:'s',prompt_id:'p'}),/rejected/);
 mode='throw';await assert.rejects(b.lifecycle({event:'Stop',session_id:'s',prompt_id:'p'}),/PRIVATE_ERROR/);
 mode='ok';await b.lifecycle({event:'Stop',session_id:'s',prompt_id:'p'});
 const raw=await readFile(join(b.root,'events.jsonl'),'utf8');const events=raw.trim().split('\n').map(JSON.parse);
 assert.deepEqual(events.filter(e=>e.event==='turn_end_failed').map(e=>e.outcome),['tool_rejected','rpc_failed']);
 assert.equal(events.filter(e=>e.event==='turn_ended').length,1);
 assert.ok(!raw.includes('PRIVATE_RESPONSE'));assert.ok(!raw.includes('PRIVATE_ERROR'));
});
