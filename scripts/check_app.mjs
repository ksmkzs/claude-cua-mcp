// Check, on this Mac, that the installed Codex desktop app still works through the launcher:
// a new runtime starts, shows the tools the app enables for itself, lists apps without an error,
// and (when cua-context-profile is installed) answers with the shortened documentation.
// Run it through check.sh, which uses the Node inside the desktop app: the runtime only reaches
// apps when the program that started it carries the vendor's signature.
//
//   sh check.sh            print the result
//   sh check.sh --record   also write upstream/verified.json (commit it with the release review)
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const installed = join(homedir(), '.local', 'share', 'claude-cua', 'launch');
const launcher = process.env.CLAUDE_CUA_LAUNCH ?? (existsSync(installed) ? installed : join(root, 'launch'));
const EXPECTED_TOOLS = ['js', 'js_reset', 'turn_ended'];

/** One MCP session with a new runtime; `code` runs once in it. Returns the tool names and the text it wrote. */
export function session(code, {env = {}, command = launcher, timeoutMs = 120000} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, ...env}});
    const waiting = new Map();
    let buffer = '', stderr = '', id = 0;
    const end = (settle, value) => { clearTimeout(timer); child.kill(); settle(value); };
    const timer = setTimeout(() => end(reject, new Error('the runtime did not answer in time')), timeoutMs);
    const rpc = (method, params) => new Promise(done => { const n = ++id; waiting.set(n, done); child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: n, method, params}) + '\n'); });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => end(reject, error));
    child.once('exit', status => end(reject, new Error(`the runtime ended (${status}): ${stderr.trim().slice(-300)}`)));
    child.stdout.on('data', data => {
      buffer += data;
      for (let at; (at = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.method === undefined && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
        // A question from the runtime (an approval) is not answered here: the check asks for nothing that needs one.
        else if (message.method !== undefined && message.id !== undefined) child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: message.id, error: {code: -32601, message: 'not available in the check'}}) + '\n');
      }
    });
    (async () => {
      await rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'claude-cua-check', version: '1'}});
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
      const tools = ((await rpc('tools/list', {})).result?.tools ?? []).map(tool => tool.name).sort();
      const answer = await rpc('tools/call', {name: 'js', arguments: {code, title: 'Checking'}});
      const text = (answer.result?.content ?? []).map(part => part.text ?? '').join('\n');
      end(resolve, {tools, text, error: answer.error?.message ?? null, stderr});
    })().catch(error => end(reject, error));
  });
}

/** Version and build of the desktop app the launcher uses. */
export function appVersion(app) {
  const read = key => spawnSync('/usr/bin/defaults', ['read', join(app, 'Contents', 'Info'), key], {encoding: 'utf8'}).stdout.trim();
  return {app, version: read('CFBundleShortVersionString'), build: read('CFBundleVersion')};
}

/** Turn what the sessions returned into named checks: [{name, ok, detail}]. */
export function judge({inventory, profiled, stock, profileInstalled}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({name, ok: Boolean(ok), detail});
  add('a new runtime starts and answers', !inventory.error, inventory.error ?? 'ok');
  add('tools are the ones the app enables for itself', JSON.stringify(inventory.tools) === JSON.stringify(EXPECTED_TOOLS), inventory.tools.join(','));
  const found = /CHECK (\{.*\})/.exec(inventory.text);
  const state = found ? JSON.parse(found[1]) : null;
  add('apps are listed without an error', state && state.errors.length === 0 && state.apps > 0,
    state ? `${state.apps} apps${state.errors.length ? '; ' + state.errors.join('; ') : ''}` : inventory.text.slice(-200));
  if (profileInstalled) {
    add('the documentation filter loads', !/was not loaded/.test(profiled.stderr), (/.*was not loaded.*/.exec(profiled.stderr) ?? ['ok'])[0]);
    add('the shortened documentation is given', /Context profile/.test(profiled.text) && profiled.text.length < stock.text.length,
      `${profiled.text.length} characters with the profile, ${stock.text.length} without`);
    add('the entry points are still in the shortened documentation', ['getState', 'getAXState', 'cua_repl'].every(word => profiled.text.includes(word)), 'getState, getAXState, cua_repl');
  }
  return checks;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = process.env.CODEX_APP ?? dirname(dirname(dirname(dirname(dirname(process.execPath)))));
  const profileInstalled = existsSync(join(homedir(), '.local', 'share', 'cua-proxy', 'node-repl'));
  const result = {checked: new Date().toISOString(), ...appVersion(app), launcher: launcher === installed ? 'installed' : 'repository', profile: profileInstalled};
  try {
    const inventory = await session('const s = await cua.getState({emit: false}); nodeRepl.write("CHECK " + JSON.stringify({apps: s.apps.length, errors: s.errors ?? []}));');
    const profiled = profileInstalled ? await session('await cua.rewriteDocumentation();') : null;
    const stock = profileInstalled ? await session('await cua.rewriteDocumentation();', {env: {CUA_PROXY: 'off'}}) : null;
    result.checks = judge({inventory, profiled, stock, profileInstalled});
  } catch (error) {
    result.checks = [{name: 'a new runtime starts and answers', ok: false, detail: error.message}];
  }
  result.compatible = result.checks.every(check => check.ok);
  for (const check of result.checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
  console.log(`${result.compatible ? 'Compatible' : 'NOT compatible'}: ${result.app} ${result.version} (${result.build})`);
  if (process.argv.includes('--record')) {
    const file = join(root, 'upstream', 'verified.json');
    const {app: _path, ...kept} = result;                      // the path is this Mac's; the version says which app
    const history = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).history ?? [] : [];
    writeFileSync(file, JSON.stringify({meaning: 'Results of check.sh on a Mac with the named desktop app version. Newest first.',
      history: [kept, ...history.filter(old => old.version !== kept.version)].slice(0, 20)}, null, 2) + '\n');
    console.log(`recorded in ${file}`);
  }
  process.exit(result.compatible ? 0 : 1);
}
