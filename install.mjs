// Register (or remove) the Computer Use server in Claude Code.
//   install [--name NAME] [--replace]   copy the launcher, add the MCP server, the turn-end hook and one deny rule
//   uninstall [--name NAME]             remove exactly those again
// Only entries this script adds are ever changed, and the settings file is backed up first.
import {spawnSync} from 'node:child_process';
import {copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const turnEnd = name => ({hooks: [{type: 'mcp_tool', server: name, tool: 'turn_ended', timeout: 15,
  input: {hook_event_name: 'Stop', session_id: '${session_id}', turn_id: '${prompt_id}'}}]});
const isOurs = (entry, name) => entry?.hooks?.length === 1 && entry.hooks[0].type === 'mcp_tool'
  && entry.hooks[0].server === name && entry.hooks[0].tool === 'turn_ended';
const denied = name => `mcp__${name}__js_add_node_module_dir`;
const EVENTS = ['Stop', 'StopFailure'];

/** Tell the runtime when a turn ends (it then releases its on-screen cursor), and keep the one
 *  tool the Codex app itself never shows to a model out of reach. */
export function addTo(settings, name) {
  const next = structuredClone(settings);
  next.hooks ??= {};
  for (const event of EVENTS) {
    next.hooks[event] ??= [];
    if (!next.hooks[event].some(entry => isOurs(entry, name))) next.hooks[event].push(turnEnd(name));
  }
  next.permissions ??= {};
  next.permissions.deny ??= [];
  if (!next.permissions.deny.includes(denied(name))) next.permissions.deny.push(denied(name));
  return next;
}
export function removeFrom(settings, name) {
  const next = structuredClone(settings);
  for (const event of EVENTS) {
    if (!Array.isArray(next.hooks?.[event])) continue;
    next.hooks[event] = next.hooks[event].filter(entry => !isOurs(entry, name));
    if (!next.hooks[event].length) delete next.hooks[event];
  }
  if (next.hooks && !Object.keys(next.hooks).length) delete next.hooks;
  if (Array.isArray(next.permissions?.deny)) {
    next.permissions.deny = next.permissions.deny.filter(rule => rule !== denied(name));
    if (!next.permissions.deny.length) delete next.permissions.deny;
  }
  return next;
}

function rewrite(file, change, backupDir) {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '{}\n';
  const after = JSON.stringify(change(JSON.parse(before)), null, 2) + '\n';
  if (after === before) return false;
  mkdirSync(backupDir, {recursive: true});
  writeFileSync(join(backupDir, `settings.${new Date().toISOString().replace(/[:.]/g, '-')}.json`), before, {mode: 0o600});
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file + '.tmp', after, {mode: 0o600});
  renameSync(file + '.tmp', file);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), action = args[0] ?? 'install';
  const option = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const name = option('--name') ?? 'codex-computer-use';
  const dest = process.env.CLAUDE_CUA_HOME ?? join(homedir(), '.local', 'share', 'claude-cua');
  const settings = option('--settings') ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
  const here = dirname(fileURLToPath(import.meta.url));
  const claude = (...words) => spawnSync('claude', ['mcp', ...words], {encoding: 'utf8'});
  const fail = message => { process.stderr.write(`claude-cua: ${message}\n`); process.exit(1); };
  if (claude('--help').error) fail('the `claude` command was not found on PATH');
  const current = claude('get', name);
  const present = current.status === 0, mine = present && current.stdout.includes(join(dest, 'launch'));

  if (action === 'install') {
    if (present && !mine && !args.includes('--replace')) fail(`an MCP server named "${name}" already exists and is not this one. Re-run with --replace to replace it, or choose another --name.`);
    mkdirSync(dest, {recursive: true});
    for (const file of ['launch', 'launch.mjs']) copyFileSync(join(here, file), join(dest, file));
    chmodSync(join(dest, 'launch'), 0o755);
    if (present && !mine) { const r = claude('remove', '--scope', 'user', name); if (r.status !== 0) fail(`could not remove the existing "${name}" entry: ${r.stderr || r.stdout}`); }
    if (!mine) { const r = claude('add', '--scope', 'user', name, '--', join(dest, 'launch')); if (r.status !== 0) fail(`could not add the MCP server: ${r.stderr || r.stdout}`); }
    const changed = rewrite(settings, value => addTo(value, name), join(dest, 'backup'));
    console.log(`installed: ${dest}\nMCP server "${name}" registered; ${changed ? 'hook and deny rule added to' : 'nothing to change in'} ${settings}\nStart a new Claude Code session to use it.`);
  } else if (action === 'uninstall') {
    if (mine) claude('remove', '--scope', 'user', name);
    rewrite(settings, value => removeFrom(value, name), join(dest, 'backup'));
    for (const file of ['launch', 'launch.mjs']) rmSync(join(dest, file), {force: true});
    console.log(`removed "${name}"${mine ? '' : ' (the MCP entry was not this one and was left alone)'}; backups remain in ${join(dest, 'backup')}`);
  } else fail('usage: install.sh [install [--replace] | uninstall] [--name NAME]');
}
