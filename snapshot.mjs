// Obtain tool schemas locally; this never calls a UI tool or starts a model turn.
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {JsonRpc} from './rpc.mjs';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const child = spawn(config.cua.command, config.cua.args || [], {
  env: {...process.env, ...config.cua.env}, stdio: ['pipe','pipe','pipe'],
});
child.stderr.on('data', () => {});
const rpc = new JsonRpc(child.stdout, child.stdin);
child.on('error', e => rpc.close(e));
child.on('exit', () => rpc.close(new Error('CUA schema process exited')));
const deadline = setTimeout(() => { child.kill('SIGKILL'); process.exit(1); }, 30000);
try {
  await rpc.request('initialize', {protocolVersion:'2025-11-25', capabilities:{}, clientInfo:{name:'cua-schema-inspector',version:'0.1.0'}});
  rpc.notify('notifications/initialized');
  const result = await rpc.request('tools/list', {});
  for (const name of ['js','js_reset','turn_ended']) {
    if (!result.tools?.some(t => t.name === name && t.inputSchema)) throw new Error(`Missing required tool: ${name}`);
  }
  await writeFile(process.argv[3], JSON.stringify({tools:result.tools},null,2)+'\n', {mode:0o600});
} finally { clearTimeout(deadline); child.kill(); rpc.close(); }
