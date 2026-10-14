#!/usr/bin/env python3
"""Prepare, activate or restore the Claude CUA bridge without changing app binaries."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import shutil

HERE = Path(__file__).resolve().parent
ROOT = Path.home() / '.codex/cua-claude-mcp'
CLAUDE = Path.home() / '.claude.json'
SETTINGS = Path.home() / '.claude/settings.json'
NODE = None
CODEX = None
NAME = 'codex-computer-use'

def load(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default

def save(path, value, observed=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if observed is not None and path.read_bytes() != observed:
        raise SystemExit(f'Concurrent change to {path}; retry without overwriting it')
    temp = path.with_name(path.name + '.cua-bridge-' + secrets.token_hex(4))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.write('\n')
        if observed is not None and path.read_bytes() != observed:
            raise SystemExit(f'Concurrent change to {path}; retry')
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)

def server():
    return {'command': NODE, 'args': [str(ROOT / 'server.mjs')],
            'env': {'CUA_BRIDGE_HOME': str(ROOT)}}

def hooks():
    result = {'PreToolUse': [{
        'matcher': '^mcp__codex-computer-use__(js|js_reset)$',
        'hooks': [{'type': 'command', 'command': NODE, 'args': [str(ROOT / 'hook.mjs')],
                   'timeout': 10, 'onFailure': 'block'}],
    }]}
    for event in ['Stop', 'StopFailure', 'SubagentStop', 'SessionEnd']:
        result[event] = [{'hooks': [{'type': 'mcp_tool', 'server': NAME,
            'tool': 'bridge_lifecycle', 'timeout': 30,
            'input': {'event': event, 'session_id': '${session_id}',
                      'prompt_id': '${prompt_id}', 'agent_id': '${agent_id}'}}]}]
    return result

def prepare():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    ROOT.chmod(0o700)
    if (ROOT/'config.json').exists():
        raise SystemExit('Existing installation preserved; choose a new --root for preparation')
    if args.cua_config:
        original = load(args.cua_config)
    else:
        original = (load(CLAUDE, {}).get('mcpServers', {}).get(NAME))
    if not isinstance(original, dict) or original == server():
        raise SystemExit('Supply --cua-config with your CUA MCP launch stanza (command, args, env)')
    if not isinstance(original.get('command'), str) or not isinstance(original.get('args', []), list):
        raise SystemExit('Invalid CUA MCP launch stanza')
    for path in [Path(NODE), Path(CODEX), Path(original['command'])]:
        if not path.is_file(): raise SystemExit(f'Required executable missing: {path}')
    for name in ['rpc.mjs', 'config.mjs', 'context.mjs', 'hook.mjs', 'lease.py', 'lease.mjs',
                 'bridge.mjs', 'server.mjs', 'snapshot.mjs', 'package.json']:
        src = HERE / name
        temp = ROOT / (name + '.install')
        shutil.copyfile(src, temp)
        temp.chmod(0o600)
        os.replace(temp, ROOT / name)
    key = ROOT / 'routing.key'
    if not key.exists():
        fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as f: f.write(secrets.token_bytes(32))
    # No credentials are added; preserve the existing runtime launch environment.
    cua = {'command': original['command'], 'args': original.get('args', []), 'env': dict(original.get('env', {}))}
    cua['env']['CUA_REPL_ENABLED_SURFACES'] = 'browser,computer'
    save(ROOT / 'config.json', {'codexPath': CODEX, 'cua': cua})
    subprocess.run([NODE, str(ROOT/'snapshot.mjs'), str(ROOT/'config.json'), str(ROOT/'upstream-tools.json')], check=True, timeout=40)
    save(ROOT / 'claude-test-mcp.json', {'mcpServers': {NAME: server()}})
    save(ROOT / 'claude-test-settings.json', {'hooks': hooks()})
    print(f'Prepared {ROOT}; Claude configuration not changed')

def activate():
    if not all((ROOT/name).is_file() for name in ['config.json','routing.key','upstream-tools.json']):
        raise SystemExit('Preparation is incomplete; run --prepare in a fresh directory first')
    before_c = CLAUDE.read_bytes() if CLAUDE.exists() else b'{}'
    before_s = SETTINGS.read_bytes() if SETTINGS.exists() else None
    c, s = json.loads(before_c), json.loads(before_s) if before_s else {}
    state_path = ROOT / 'activation.json'
    state = load(state_path)
    if state:
        if c.setdefault('mcpServers', {}).get(NAME) not in [state['originalServer'], server()]:
            raise SystemExit('Claude CUA server changed; refusing to overwrite it')
    else:
        state = {'originalServer': c.setdefault('mcpServers', {}).get(NAME), 'installedServer': server(), 'hooks': hooks()}
        save(state_path, state)
    for event, entries in hooks().items():
        target = s.setdefault('hooks', {}).setdefault(event, [])
        for entry in entries:
            if entry not in target: target.append(entry)
    c['mcpServers'][NAME] = server()
    save(SETTINGS, s, before_s)
    try:
        save(CLAUDE, c, before_c if CLAUDE.exists() else None)
    except BaseException:
        # Restore only if our settings write still matches; preserve concurrent edits.
        latest = load(SETTINGS)
        if latest == s:
            save(SETTINGS, json.loads(before_s) if before_s else {})
        raise
    print('Activated for NEW Claude sessions')

def restore():
    state = load(ROOT / 'activation.json')
    if not state: raise SystemExit('No activation record; nothing changed')
    before_c, before_s = CLAUDE.read_bytes(), SETTINGS.read_bytes()
    c, s = json.loads(before_c), json.loads(before_s)
    if c.setdefault('mcpServers', {}).get(NAME) != state['installedServer']:
        raise SystemExit('Claude CUA server changed; refusing to overwrite it')
    for event, entries in state['hooks'].items():
        target = s.get('hooks', {}).get(event, [])
        for entry in entries:
            if entry not in target: raise SystemExit(f'Installed {event} hook changed; review before restoring')
            target.remove(entry)
        if not target: s['hooks'].pop(event, None)
    if state['originalServer'] is None:
        c['mcpServers'].pop(NAME, None)
    else:
        c['mcpServers'][NAME] = state['originalServer']
    save(SETTINGS, s, before_s)
    save(CLAUDE, c, before_c if CLAUDE.exists() else None)
    print('Restored the previous direct CUA MCP. Documentation profile and other settings preserved.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--prepare', action='store_true')
    mode.add_argument('--activate', action='store_true')
    mode.add_argument('--restore', action='store_true')
    parser.add_argument('--app', type=Path, help='Codex/ChatGPT app bundle')
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--claude-config', type=Path, default=CLAUDE)
    parser.add_argument('--claude-settings', type=Path, default=SETTINGS)
    parser.add_argument('--cua-config', type=Path, help='Local JSON MCP stanza; never commit it')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise SystemExit('Native CUA integration currently supports macOS only')
    ROOT = args.root.expanduser().resolve()
    CLAUDE = args.claude_config.expanduser().resolve()
    SETTINGS = args.claude_settings.expanduser().resolve()
    candidates = [args.app] if args.app else [Path('/Applications/Codex.app'), Path('/Applications/ChatGPT.app'), Path.home()/'Applications/Codex.app', Path.home()/'Applications/ChatGPT.app']
    app = next((p.resolve() for p in candidates if p and (p/'Contents/Resources/cua_node/bin/node').is_file()), None)
    if app is None: raise SystemExit('Supply --app with an installed CUA-capable desktop bundle')
    NODE = str(app/'Contents/Resources/cua_node/bin/node')
    CODEX = str(app/'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
    if args.prepare: prepare()
    elif args.activate: activate()
    else: restore()
