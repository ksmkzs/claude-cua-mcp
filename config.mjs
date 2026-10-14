import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function toml(value) {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(toml).join(', ') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ' = ' + toml(v)).join(', ') + '}';
  throw new Error('Unsupported TOML configuration value');
}

export async function loadConfig(root) {
  const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  await access(config.codexPath);
  if (!config.cua || !Array.isArray(config.cua.args) || typeof config.cua.env !== 'object') {
    throw new Error('Invalid local CUA launch configuration');
  }
  await access(config.cua.command);
  return config;
}

export function appServerArgs(config) {
  const cua = { ...config.cua, enabled: true, startup_timeout_sec: 120, tool_timeout_sec: 300,
    enabled_tools: ['js', 'js_reset', 'turn_ended'] };
  // Invocation-local configuration only. Do not change approval or sandbox settings.
  return ['app-server', '--listen', 'stdio://', '-c', `mcp_servers.claude_cua=${toml(cua)}`];
}
