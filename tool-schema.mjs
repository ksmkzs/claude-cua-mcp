const routingProperty = {type:'string',description:'Internal routing value populated by the client PreToolUse hook. Omit from model-generated arguments.'};

export function withRoutingContext(schema) {
  // Strict union branches must accept the hook-injected field too. The original
  // snapshot stays untouched and only clean arguments reach the upstream tool.
  return {...schema, properties:{...schema.properties,_bridge_context:routingProperty},
    ...(schema.oneOf ? {oneOf:schema.oneOf.map(withRoutingContext)} : {})};
}

export function validateJsArguments(args) {
  const hasCode=Object.hasOwn(args,'code'), hasSummary=Object.hasOwn(args,'completion_summary');
  if (hasCode === hasSummary) throw new Error('Provide exactly one of code or completion_summary');
  if (hasSummary) {
    if (Object.keys(args).length !== 1 || typeof args.completion_summary !== 'string'
      || !args.completion_summary.trim() || [...args.completion_summary].length > 80) {
      throw new Error('completion_summary must be a nonempty string of at most 80 characters, without code, title or timeout_ms');
    }
    return 'completion';
  }
  if (Object.keys(args).some(k=>!['code','title','timeout_ms'].includes(k))) throw new Error('Unknown js argument');
  if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('code must be a nonempty string');
  if (args.title !== undefined && (typeof args.title !== 'string' || !args.title.length || [...args.title].length>80)) throw new Error('title must contain 1 to 80 characters');
  if (args.timeout_ms !== undefined && (!Number.isInteger(args.timeout_ms) || args.timeout_ms<1 || args.timeout_ms>300000)) throw new Error('timeout_ms must be between 1 and 300000');
  return 'code';
}
