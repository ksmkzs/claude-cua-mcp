import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signContext, cleanArguments } from './context.mjs';

const root = process.env.CUA_BRIDGE_HOME || dirname(fileURLToPath(import.meta.url));
let input = '';
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2 * 1024 * 1024) throw new Error('Hook input exceeds limit');
  }
  const hook = JSON.parse(input);
  if (hook.hook_event_name !== 'PreToolUse') process.exit(0);
  if (/^mcp__cua_repl(?:__|\.)(?:js|js_reset|js_add_node_module_dir)$/.test(hook.tool_name || '')) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Use task_cua for CUA operations so the bridge owns the operation lock and Safari task window.',
    } }) + '\n');
  } else if (/^mcp__task_cua__(js|js_reset)$/.test(hook.tool_name || '')) {
    const key = await readFile(join(root, 'routing.key'));
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { ...cleanArguments(hook.tool_input), _bridge_context: signContext(hook, key) },
    } }) + '\n');
  }
} catch (error) {
  process.stderr.write(`CUA routing hook: ${error.message}\n`);
  process.exitCode = 2;
}
