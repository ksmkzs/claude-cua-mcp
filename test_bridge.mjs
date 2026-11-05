import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuaBridge } from './bridge.mjs';
import { signContext, verifyContext } from './context.mjs';
import { withLease } from './lease.mjs';
import { stopProcessGroup } from './process-group.mjs';
import { withRoutingContext, validateJsArguments } from './tool-schema.mjs';
const key = Buffer.alloc(32, 7);
function codexArgs(session='s', turn='t', agent='') {
 const a={code:'1'};
 a._bridge_context=signContext({session_id:session,turn_id:turn,agent_id:agent,cwd:tmpdir(),
 tool_use_id:crypto.randomUUID(),tool_name:'mcp__task_cua__js',tool_input:a},key);return a;
}
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

test('window selection encloses every native call and settles after executor stops on mismatch', async t => {
 const {b,calls}=await fixture(t);const order=[];
 const request=b.rpc.request;b.rpc.request=async(m,p)=>{if(p.tool==='js')order.push('native');return request(m,p);};
 b.stopHost=async()=>{order.push('stop');};
 let checks=0;
 b.windows={acquire:async()=>{order.push('select');return {
   check:async()=>{if(++checks===1){order.push('precheck');return;}order.push('postcheck');throw new Error('changed');},
   settle:async()=>{order.push('settle');return {parked:true};},
 };}};
 await assert.rejects(b.call('js',args()),/changed/);
 assert.deepEqual(order,['select','precheck','native','postcheck','stop','settle']);
 assert.equal(calls.filter(c=>c.p.tool==='js').length,1);
});
test('failed Safari preflight never forwards native input', async t => {
 const {b,calls}=await fixture(t);
 b.windows={acquire:async()=>{throw new Error('SAFARI_FOREGROUND');}};
 await assert.rejects(b.call('js',args()),/SAFARI_FOREGROUND/);
 assert.ok(!calls.some(c=>c.p.tool==='js'));
 assert.ok(!b.stopped);
});
test('parking failure preserves native result and warns against replay', async t => {
 const {b,calls}=await fixture(t);
 b.windows={acquire:async()=>({check:async()=>({selected:true}),
   settle:async()=>{throw new Error('parking unconfirmed');}})};
 const result=await b.call('js',args());
 assert.equal(result.isError,true);
 assert.equal(result.content[0].text,'ok');
 assert.match(result.content.at(-1).text,/Native CUA returned.*Do not replay/);
 assert.equal(calls.filter(c=>c.p.tool==='js').length,1);
});
test('cancellation retains OS lock until action cleanup completes', async t => {
 const dir=await mkdtemp(join(tmpdir(),'cua-lock-abort-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'lock'),controller=new AbortController(),order=[];
 let entered,finish;const ready=new Promise(r=>entered=r),cleanup=new Promise(r=>finish=r);
 const first=withLease(path,async signal=>{
   entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));
   order.push('cancel');await cleanup;order.push('stopped');
 },{signal:controller.signal});
 await ready;controller.abort(new Error('test'));
 const second=withLease(path,async()=>{order.push('next');});
 await new Promise(r=>setTimeout(r,100));
 assert.deepEqual(order,['cancel']);finish();await first;await second;
 assert.deepEqual(order,['cancel','stopped','next']);
});
test('Codex hook routing binds turn and client identity and cannot reuse Claude tool token',()=>{
 const a={code:'1'};
 a._bridge_context=signContext({session_id:'codex-task',turn_id:'turn',tool_use_id:'call',
   tool_name:'mcp__task_cua__js',cwd:tmpdir(),tool_input:a},key);
 const c=verifyContext(a._bridge_context,a,'js',key);
 assert.equal(c.client_kind,'codex');assert.equal(c.prompt_id,'turn');
 assert.throws(()=>verifyContext(a._bridge_context,a,'js_reset',key),/another tool/);
});
test('process-group shutdown escalates and confirms descendants gone, not only leader exit', async () => {
 const signals=[];let alive=true;
 await stopProcessGroup(12345,{sleep:async()=>{},kill:(pid,signal)=>{
   assert.equal(pid,-12345);signals.push(signal);
   if(!alive){const error=new Error('gone');error.code='ESRCH';throw error;}
   if(signal==='SIGKILL')alive=false;
 }});
 assert.equal(signals[0],'SIGTERM');
 assert.ok(signals.includes('SIGKILL'));
 assert.equal(signals.at(-1),0);
});
test('unconfirmed executor shutdown quarantines rather than parking a live action', async t => {
 const {b}=await fixture(t);const order=[];
 const request=b.rpc.request;
 b.rpc.request=(m,p)=>p.tool==='js'?Promise.reject(new Error('native timeout')):request(m,p);
 b.stopHost=async()=>{throw new Error('termination unconfirmed');};
 b.windows={acquire:async()=>({check:async()=>{},settle:async()=>order.push('park'),
   quarantine:async()=>order.push('quarantine')})};
 await assert.rejects(b.call('js',args()),/termination unconfirmed/);
 assert.deepEqual(order,['quarantine']);
 assert.equal(JSON.parse(await readFile(b.quarantinePath)).reason,'executor_termination_unconfirmed');
 await assert.rejects(b.call('js',args()),/previous CUA executor/);
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

test('terminal lifecycle cleans windows under operation lock after unsubscribe and ignores stale prompt identity', async t => {
 const {b,calls}=await fixture(t);
 await b.call('js',args('s','p','child'));
 const order=[];
 b.lease=async(path,fn)=>{order.push('lock');await fn();order.push('unlock');};
 b.windows={cleanupScope:async scope=>{
  assert.ok(calls.some(c=>c.method==='thread/unsubscribe'));
  assert.equal(scope.agentId,'child');assert.deepEqual(scope.unsafeKeys,[]);
  order.push('cleanup');return [{closed:true}];
 }};
 await b.lifecycle({event:'SubagentStop',session_id:'s',agent_id:'child',prompt_id:'older'});
 assert.deepEqual(order,['lock','cleanup','unlock']);
 assert.equal(b.contexts.size,0);
});

test('Codex Stop closes only its turn after discarding REPL and permits a fresh next turn',async t=>{
 const {b,calls}=await fixture(t);
 await b.call('js',codexArgs());await b.call('js',args('s','t'));await b.call('js',codexArgs('other'));
 const scopes=[];
 b.windows={cleanupScope:async s=>{scopes.push(s);assert.ok(calls.some(c=>c.method==='thread/unsubscribe'));return [{closed:true}];},acquire:async()=>null};
 await b.codexLifecycle({event:'Stop',session_id:'s',turn_id:'t'});
 assert.equal(b.contexts.size,2);assert.equal(scopes[0].client,'codex');assert.equal(scopes[0].agentId,'');assert.equal(scopes[0].turnId,'t');
 await b.call('js',codexArgs('s','next'));assert.equal(b.contexts.size,3);
 assert.equal(calls.filter(c=>c.method==='thread/start').length,4);
 const before=calls.filter(c=>c.method==='thread/unsubscribe').length;
 await b.codexLifecycle({event:'Stop',session_id:'s',turn_id:'t'});
 assert.equal(calls.filter(c=>c.method==='thread/unsubscribe').length,before);
 assert.deepEqual(scopes.at(-1).knownKeys,[]);
});

test('Codex SubagentStop maps parent event to child session without closing parent or sibling',async t=>{
 const {b}=await fixture(t);
 await b.call('js',codexArgs('parent'));await b.call('js',codexArgs('child'));await b.call('js',codexArgs('sibling'));
 const scopes=[];b.windows={cleanupScope:async s=>{scopes.push(s);return [];}};
 await b.codexLifecycle({event:'SubagentStop',session_id:'parent',agent_id:'child',turn_id:'parent-turn'});
 assert.equal(b.contexts.size,2);
 assert.ok([...b.contexts.values()].every(c=>['parent','sibling'].includes(c.sessionId)));
 assert.deepEqual(scopes.map(s=>[s.sessionId,s.agentId]),[['child',''],['parent','child']]);
 assert.ok(!b.ending.size);
});

test('Codex malformed lifecycle and Claude lifecycle cannot close Codex contexts',async t=>{
 const {b}=await fixture(t);await b.call('js',codexArgs());
 const scopes=[];b.windows={cleanupScope:async s=>{scopes.push(s);return [];},acquire:async()=>null};
 await b.codexLifecycle({event:'SubagentStop',session_id:'s',agent_id:'${agent_id}'});
 await b.codexLifecycle({event:'Stop',session_id:'s'});
 assert.equal(scopes.length,0);
 await b.lifecycle({event:'SessionEnd',session_id:'s'});
 assert.equal(b.contexts.size,1);assert.equal(scopes[0].client,'claude');
 await b.call('js',codexArgs('s','next'));
});

test('Codex failed executor cleanup retains manual scope and does not discard context',async t=>{
 const {b}=await fixture(t);await b.call('js',codexArgs());
 b.rpc.request=async()=>{throw new Error('shutdown unconfirmed');};
 let scope;b.windows={cleanupScope:async s=>{scope=s;return [{manual:true}];}};
 await b.codexLifecycle({event:'Stop',session_id:'s',turn_id:'t'});
 assert.equal(b.contexts.size,1);assert.deepEqual(scope.unsafeKeys,['codex\0s\0']);
});

test('cross-process close invalidates saved app before any native action',async t=>{
 const {b,calls}=await fixture(t);await b.call('js',codexArgs());
 const before=calls.filter(c=>c.p.tool==='js').length;
 b.windows={acquire:async()=>{throw Object.assign(new Error('closed'),{code:'OWNED_WINDOW_CLOSED'});}};
 await assert.rejects(b.call('js',codexArgs('s','next')),/closed/);
 assert.equal(calls.filter(c=>c.p.tool==='js').length,before);assert.equal(b.contexts.size,0);
});

test('completion summary forwards unchanged without selecting a task window or ending context',async t=>{
 const {b,calls}=await fixture(t);await b.call('js',codexArgs());
 let selections=0;b.windows={acquire:async()=>{selections++;throw new Error('must not select');}};
 const a={completion_summary:'Verified owned window'};
 a._bridge_context=signContext({session_id:'s',turn_id:'t',tool_use_id:crypto.randomUUID(),tool_name:'mcp__task_cua__js',cwd:tmpdir(),tool_input:a},key);
 await b.call('js',a);
 assert.equal(selections,0);assert.equal(b.contexts.size,1);
 assert.deepEqual(calls.at(-1).p.arguments,{completion_summary:'Verified owned window'});
});

test('strict js union accepts routing metadata in each branch without changing upstream schema',()=>{
 const s={type:'object',additionalProperties:false,properties:{code:{type:'string'},completion_summary:{type:'string'}},oneOf:[
  {type:'object',additionalProperties:false,properties:{code:{type:'string'}},required:['code']},
  {type:'object',additionalProperties:false,properties:{completion_summary:{type:'string'}},required:['completion_summary']},
 ]};
 const before=JSON.stringify(s),exposed=withRoutingContext(s);
 assert.equal(JSON.stringify(s),before);
 for(const branch of [exposed,...exposed.oneOf])assert.equal(branch.properties._bridge_context.type,'string');
 for(const bad of [{},{code:'1',completion_summary:'Done'},{completion_summary:'Done',title:'x'},
  {completion_summary:'Done',timeout_ms:1},{completion_summary:''},{completion_summary:'x'.repeat(81)}])assert.throws(()=>validateJsArguments(bad));
 assert.equal(validateJsArguments({completion_summary:'Verified owned window'}),'completion');
 assert.equal(validateJsArguments({code:'1',title:'Checking state'}),'code');
});
