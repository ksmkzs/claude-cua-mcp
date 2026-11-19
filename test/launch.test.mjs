import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launchSpec, plan} from '../launch.mjs';
import {addTo, removeFrom} from '../install.mjs';

function codexHome(versions) {
  const home = mkdtempSync(join(tmpdir(), 'claude-cua-'));
  let when = 1_700_000_000;
  for (const [version, spec] of Object.entries(versions)) {
    const dir = join(home, '.codex', 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', version);
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({mcpServers: {cua_repl: spec}}));
    utimesSync(join(dir, '.mcp.json'), when, when); when += 1000;
  }
  return home;
}
const spec = (build, extra = {}) => ({command: '/bin/sh', args: ['-c', 'exec "$@"', 'x', '/stale/wrapper'], enabled_tools: ['js', 'js_reset', 'turn_ended'],
  env: {NODE_REPL_NODE_PATH: `/Apps/${build}/bin/node`, NODE_REPL_JS_BANNER: 'B', CUA_REPL_ENABLED_SURFACES: 'browser,computer', ...extra}});

test('the launch settings come from the newest description the desktop app wrote', () => {
  const home = codexHome({'26.900.1': spec('old'), '26.1103.6': spec('new')});
  assert.equal(launchSpec(join(home, '.codex')).env.NODE_REPL_NODE_PATH, '/Apps/new/bin/node');
  assert.throws(() => launchSpec(join(home, 'nowhere')), /Open the Codex desktop app once/);
});

test('the stock runtime next to the app\'s Node is run, with the app\'s environment and desktop apps only', () => {
  const home = codexHome({'1': spec('a')});
  const job = plan({env: {PATH: '/bin', CUA_REPL_ENABLED_SURFACES: 'ignored'}, home, exists: () => false});
  assert.equal(job.command, '/Apps/a/bin/node_repl');          // never the command recorded in the description
  assert.equal(job.env.NODE_REPL_JS_BANNER, 'B');
  assert.equal(job.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  assert.equal(job.env.CUA_PROXY_TOOLS, 'js,js_reset,turn_ended');
  assert.equal(job.env.PATH, '/bin');
});

test('an installed proxy is used instead, and both choices can be overridden', () => {
  const home = codexHome({'1': spec('a')});
  const proxy = join(home, '.local', 'share', 'cua-proxy', 'node-repl');
  assert.equal(plan({env: {}, home, exists: path => path === proxy}).command, proxy);
  const job = plan({env: {CLAUDE_CUA_RUNTIME: '/custom', CLAUDE_CUA_SURFACES: 'browser,computer'}, home, exists: () => true});
  assert.deepEqual([job.command, job.env.CUA_REPL_ENABLED_SURFACES], ['/custom', 'browser,computer']);
});

test('settings: the hook and deny rule are added once and removed without touching anything else', () => {
  const mine = {hooks: {Stop: [{hooks: [{type: 'command', command: 'say done'}]}], PreToolUse: [{matcher: 'x', hooks: []}]}, permissions: {allow: ['Bash(ls)'], deny: ['Read(./secret)']}, model: 'm'};
  const once = addTo(mine, 'cua'), twice = addTo(once, 'cua');
  assert.deepEqual(twice, once);
  assert.equal(once.hooks.Stop.length, 2);
  assert.deepEqual(once.hooks.StopFailure[0].hooks[0], {type: 'mcp_tool', server: 'cua', tool: 'turn_ended', timeout: 15,
    input: {hook_event_name: 'Stop', session_id: '${session_id}', turn_id: '${prompt_id}'}});
  assert.deepEqual(once.permissions.deny, ['Read(./secret)', 'mcp__cua__js_add_node_module_dir']);
  assert.deepEqual(removeFrom(once, 'cua'), mine);
  assert.deepEqual(removeFrom(addTo({}, 'cua'), 'cua'), {permissions: {}});
  assert.deepEqual(removeFrom(once, 'other'), once);
});
