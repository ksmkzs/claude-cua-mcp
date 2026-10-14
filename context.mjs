import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

export function cleanArguments(args) {
  const { _bridge_context, ...clean } = args ?? {};
  return clean;
}

export function signContext(hook, key, now = Date.now()) {
  if (!hook.session_id || !hook.prompt_id || !hook.tool_use_id) {
    throw new Error('Claude hook did not supply session_id, prompt_id and tool_use_id. Update Claude Code; CUA call was not routed.');
  }
  const args = cleanArguments(hook.tool_input);
  const payload = {
    session_id: hook.session_id, prompt_id: hook.prompt_id,
    agent_id: hook.agent_id || '', cwd: hook.cwd,
    tool_use_id: hook.tool_use_id, tool_name: hook.tool_name,
    issued_at: now,
    arguments_sha256: createHash('sha256').update(stable(args)).digest('hex'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyContext(token, args, tool, key, now = Date.now()) {
  if (typeof token !== 'string') throw new Error('CUA session context is missing. Enable the installed Claude PreToolUse hook, then retry.');
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) throw new Error('Invalid CUA session context');
  const expected = createHmac('sha256', key).update(body).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid CUA session context signature');
  const context = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (now - context.issued_at > 3600000 || context.issued_at > now + 30000) throw new Error('CUA session context expired. Make a fresh tool call.');
  if (context.arguments_sha256 !== createHash('sha256').update(stable(cleanArguments(args))).digest('hex')) throw new Error('CUA arguments changed after the routing hook');
  if (context.tool_name !== `mcp__codex-computer-use__${tool}`) throw new Error('CUA routing context belongs to another tool');
  for (const field of ['session_id', 'prompt_id', 'tool_use_id', 'cwd']) {
    if (typeof context[field] !== 'string' || !context[field]) throw new Error(`Missing routing field: ${field}`);
  }
  if (typeof context.agent_id !== 'string') throw new Error('Invalid agent context');
  return context;
}
