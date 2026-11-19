// Run the Computer Use runtime of the installed Codex desktop app exactly the way the app itself
// runs it. The launch settings are read, at every start, from the configuration the app writes
// for its own Computer Use plugin, so an app update needs nothing done here.
import {spawn} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

/** The newest launch description the desktop app has written for its Computer Use server. */
export function launchSpec(codexHome) {
  const base = join(codexHome, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use');
  let newest = null;
  for (const name of existsSync(base) ? readdirSync(base) : []) {
    const file = join(base, name, '.mcp.json');
    if (existsSync(file) && (!newest || statSync(file).mtimeMs > newest.at)) newest = {file, at: statSync(file).mtimeMs};
  }
  if (!newest) throw new Error(`no Computer Use launch settings under ${base}. Open the Codex desktop app once with Computer Use enabled.`);
  const spec = JSON.parse(readFileSync(newest.file, 'utf8')).mcpServers?.cua_repl;
  if (!spec?.env?.NODE_REPL_NODE_PATH) throw new Error(`${newest.file} does not describe the Computer Use server in the expected form`);
  return spec;
}

/** What to run, and with which environment. */
export function plan({env = process.env, home = homedir(), exists = existsSync} = {}) {
  const spec = launchSpec(env.CODEX_HOME ?? join(home, '.codex'));
  const stock = join(dirname(spec.env.NODE_REPL_NODE_PATH), 'node_repl');
  // The optional proxy (cua-context-profile) is a drop-in for the stock runtime.
  const proxy = join(home, '.local', 'share', 'cua-proxy', 'node-repl');
  const command = env.CLAUDE_CUA_RUNTIME ?? (exists(proxy) ? proxy : stock);
  return {command, env: {
    ...env, ...spec.env,
    // The browser surfaces (the in-app browser, the Chrome plug-in) belong to the Codex app's own
    // window and conversation. From another client only desktop apps are offered, unless asked.
    CUA_REPL_ENABLED_SURFACES: env.CLAUDE_CUA_SURFACES ?? 'computer',
    // The proxy shows the client the same tools the Codex app enables for itself.
    ...(Array.isArray(spec.enabled_tools) ? {CUA_PROXY_TOOLS: spec.enabled_tools.join(',')} : {}),
  }};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let job;
  try { job = plan(); }
  catch (error) { process.stderr.write(`claude-cua: ${error.message}\n`); process.exit(78); }
  const child = spawn(job.command, process.argv.slice(2), {env: job.env, stdio: 'inherit'});
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', error => { process.stderr.write(`claude-cua: cannot start ${job.command}: ${error.message}\n`); process.exit(127); });
  child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
