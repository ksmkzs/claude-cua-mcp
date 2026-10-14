import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signContext, cleanArguments } from './context.mjs';

const root = process.env.CUA_BRIDGE_HOME || dirname(fileURLToPath(import.meta.url));
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const hook = JSON.parse(input);
  if (hook.hook_event_name !== 'PreToolUse' || !/^mcp__codex-computer-use__(js|js_reset)$/.test(hook.tool_name || '')) process.exit(0);
  const key = await readFile(join(root, 'routing.key'));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    updatedInput: { ...cleanArguments(hook.tool_input), _bridge_context: signContext(hook, key) },
  } }) + '\n');
} catch (error) {
  process.stderr.write(`CUA routing hook: ${error.message}\n`);
  process.exitCode = 2;
}
