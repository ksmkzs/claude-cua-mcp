#!/usr/bin/env python3
"""Stage a versioned task-window bridge, then register it without trusting hooks."""
import argparse
import copy
import hashlib
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import tomllib

HERE = Path(__file__).resolve().parent
MODULES = ['bridge.mjs', 'server.mjs', 'context.mjs', 'hook.mjs', 'codex-hook.mjs',
           'config.mjs', 'rpc.mjs', 'lease.mjs', 'lease.py', 'safari-windows.mjs',
           'window-maintenance.mjs', 'process-group.mjs', 'tool-schema.mjs', 'package.json']
MATCHER = r'^mcp__(task_cua__(js|js_reset)|cua_repl(__|\.)(js|js_reset|js_add_node_module_dir))$'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def observed(path):
    return path.read_bytes() if path.exists() else None


def cas(path, before, after):
    if observed(path) != before:
        raise RuntimeError(f'Concurrent change: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.task-cua-', dir=path.parent)
    try:
        os.fchmod(fd, path.stat().st_mode & 0o777 if path.exists() else 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(after)
            stream.flush()
            os.fsync(stream.fileno())
        if observed(path) != before:
            raise RuntimeError(f'Concurrent change: {path}')
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def prepare(dest, previous, safari_source, socket_path, profile_wrapper=None, refresh_tools=False):
    if dest.exists():
        raise RuntimeError('Versioned destination already exists; do not overwrite a live runtime')
    config = json.loads((previous / 'config.json').read_text())
    if profile_wrapper:
        profile_wrapper = profile_wrapper.expanduser().resolve()
        manifest = json.loads((profile_wrapper.parent/'manifest.json').read_text())
        upstream = Path(manifest['upstream_root'])
        if not profile_wrapper.is_file() or any(not (upstream/name).is_file() or sha((upstream/name).read_bytes()) != expected
                for name, expected in manifest['sha256'].items()):
            raise RuntimeError('Documentation profile guards do not match the installed runtime')
        config['cua'].setdefault('env', {})['CUA_REPL_NODE_REPL_PATH'] = str(profile_wrapper)
    node = config['cua']['command']
    if Path(node).name != 'node' or not Path(node).is_file():
        raise RuntimeError('Expected the existing bundled Node executable')
    if not (previous / 'routing.key').is_file():
        raise RuntimeError('Existing routing key missing')
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.task-cua-build-', dir=dest.parent) as temporary:
        stage = Path(temporary) / 'runtime'
        stage.mkdir(mode=0o700)
        for name in MODULES:
            shutil.copyfile(HERE / name, stage / name)
            (stage / name).chmod(0o600)
        manager = stage / 'window-manager'
        manager.mkdir(mode=0o700)
        for name in ['task_window_broker.py', 'broker_control.py']:
            shutil.copyfile(safari_source / name, manager / name)
        shutil.copyfile(safari_source / 'src/TaskWindowHost.swift', manager / 'TaskWindowHost.swift')
        subprocess.run(['swiftc', str(manager / 'TaskWindowHost.swift'), '-o', str(manager / 'task-window-host')], check=True)
        final_manager = dest / 'window-manager'
        manager_config = {'python': shutil.which('python3'),
                          'broker': str(final_manager / 'task_window_broker.py'),
                          'host': str(final_manager / 'task-window-host'), 'socket': str(socket_path)}
        (manager / 'task-window-config.json').write_text(json.dumps(manager_config, indent=2) + '\n')
        config['operationLock'] = config.get('operationLock', str(previous / 'operation.lock'))
        config['safariWindows'] = {
            'python': manager_config['python'], 'control': str(final_manager / 'broker_control.py'),
            'runtime': str(final_manager), 'socket': str(socket_path),
            'registry': str(dest / 'owned-windows.json'), 'foregroundWaitMs': 30000,
        }
        (stage / 'config.json').write_text(json.dumps(config, indent=2) + '\n')
        (stage / 'config.json').chmod(0o600)
        # Reuse the existing integrity key without exposing or duplicating it.
        (stage / 'routing.key').symlink_to(previous / 'routing.key')
        if refresh_tools:
            subprocess.run([node, str(HERE/'snapshot.mjs'), str(stage/'config.json'), str(stage/'upstream-tools.json')], check=True, timeout=40)
        else:
            shutil.copyfile(previous / 'upstream-tools.json', stage / 'upstream-tools.json')
        files = [p for p in stage.rglob('*') if p.is_file() and not p.is_symlink()]
        manifest = {'version': '0.2.3', 'previousRoot': str(previous),
                    'files': {str(p.relative_to(stage)): sha(p.read_bytes()) for p in files}}
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        os.rename(stage, dest)
    return node


def toml_literal(value):
    if isinstance(value, dict):
        return '{' + ', '.join(json.dumps(k) + ' = ' + toml_literal(v) for k, v in value.items()) + '}'
    if isinstance(value, list):
        return '[' + ', '.join(toml_literal(v) for v in value) + ']'
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def add_codex_cleanup_hooks(before):
    source = before.decode()
    original = tomllib.loads(source)
    expected = copy.deepcopy(original)
    for event in ('Stop', 'SubagentStop'):
        inputs = {'event': event, 'session_id': '${session_id}', 'turn_id': '${turn_id}'}
        if event == 'SubagentStop':
            inputs['agent_id'] = '${agent_id}'
        handler = {'type': 'mcp_tool', 'server': 'task_cua', 'tool': 'codex_lifecycle',
                   'input': inputs, 'timeout': 120, 'statusMessage': 'Closing owned Safari task window'}
        group = {'hooks': [handler]}
        groups = expected.setdefault('hooks', {}).setdefault(event, [])
        existing = [h for g in groups for h in g.get('hooks', [])
                    if h.get('server') == 'task_cua' and h.get('tool') == 'codex_lifecycle']
        if existing:
            if existing != [handler] or group not in groups:
                raise RuntimeError(f'Existing {event} CUA cleanup hook differs; preserved for review')
            continue
        groups.append(group)
        # Existing inline arrays cannot be extended with array-of-table syntax.
        lines, section, replaced = source.splitlines(keepends=True), '', False
        for index, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith('['):
                section = stripped
            if section != '[hooks]' or not re.match(r'^\s*' + event + r'\s*=', line):
                continue
            for end in range(index + 1, len(lines) + 1):
                try:
                    parsed = tomllib.loads(''.join(lines[index:end]))
                except tomllib.TOMLDecodeError:
                    continue
                if parsed.get(event) != original.get('hooks', {}).get(event):
                    raise RuntimeError(f'Could not isolate {event} hooks')
                lines[index:end] = [event + ' = ' + toml_literal(groups) + '\n']
                replaced = True
                break
            if not replaced:
                raise RuntimeError(f'Could not parse {event} hooks')
            break
        source = ''.join(lines)
        if not replaced:
            source += '\n[[hooks.' + event + ']]\nhooks = ' + toml_literal([handler]) + '\n'
    if tomllib.loads(source) != expected:
        raise RuntimeError('Cleanup hook configuration failed preservation check')
    return source.encode()


def proposal_codex(path, root, node, previous=None):
    before = observed(path)
    original = tomllib.loads((before or b'').decode())
    if 'task_cua' in original.get('mcp_servers', {}):
        current = original['mcp_servers']['task_cua']
        if previous is None or current.get('args') != [str(previous / 'server.mjs')]:
            raise RuntimeError('Existing task_cua differs; registration preserved')
        expected = copy.deepcopy(original)
        changed = expected['mcp_servers']['task_cua']
        changed.update(command=node, args=[str(root / 'server.mjs')])
        changed.setdefault('env', {})['CUA_BRIDGE_HOME'] = str(root)
        lines = (before or b'').decode().splitlines(keepends=True)
        section = ''
        for i, line in enumerate(lines):
            if line.strip().startswith('['): section = line.strip()
            if section == '[mcp_servers.task_cua]':
                if re.match(r'^command\s*=', line): lines[i] = 'command = ' + json.dumps(node) + '\n'
                if re.match(r'^args\s*=', line): lines[i] = 'args = ' + json.dumps(changed['args']) + '\n'
            if section == '[mcp_servers.task_cua.env]' and re.match(r'^CUA_BRIDGE_HOME\s*=', line):
                lines[i] = 'CUA_BRIDGE_HOME = ' + json.dumps(str(root)) + '\n'
        after = ''.join(lines).encode()
        if tomllib.loads(after.decode()) != expected:
            raise RuntimeError('Existing registration formatting unsupported; no config changed')
        # Preserve the signer and trust; new lifecycle hooks require normal review.
        return before, add_codex_cleanup_hooks(after)
    entry = {'command': node, 'args': [str(root / 'server.mjs')], 'env': {'CUA_BRIDGE_HOME': str(root)}}
    hook = {'matcher': MATCHER, 'hooks': [{
        'type': 'command', 'command': shlex.join([node, str(root / 'codex-hook.mjs')]),
        'timeout': 10, 'statusMessage': 'Routing task CUA',
    }]}
    addition = (
        '\n[mcp_servers.task_cua]\ncommand = ' + json.dumps(node) +
        '\nargs = ' + json.dumps(entry['args']) +
        '\n[mcp_servers.task_cua.env]\nCUA_BRIDGE_HOME = ' + json.dumps(str(root)) +
        '\n\n[[hooks.PreToolUse]]\nmatcher = ' + json.dumps(MATCHER) +
        '\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ' + json.dumps(hook['hooks'][0]['command']) +
        '\ntimeout = 10\nstatusMessage = "Routing task CUA"\n')
    source = (before or b'').decode()
    # TOML inline arrays cannot later be extended with [[array-of-table]].
    # Extend only the existing hook assignment, retaining all other text and
    # checking the full parsed document below before any filesystem mutation.
    lines = source.splitlines(keepends=True)
    in_hooks = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('['):
            in_hooks = bool(re.fullmatch(r'\[hooks\]\s*(?:#.*)?', stripped))
        if not in_hooks or not re.match(r'^\s*PreToolUse\s*=', line):
            continue
        for end in range(index + 1, len(lines) + 1):
            try:
                parsed = tomllib.loads(''.join(lines[index:end]))
            except tomllib.TOMLDecodeError:
                continue
            if parsed.get('PreToolUse') != original['hooks']['PreToolUse']:
                raise RuntimeError('Could not isolate existing PreToolUse assignment')
            def literal(value):
                if isinstance(value, dict):
                    return '{' + ', '.join(json.dumps(k) + ' = ' + literal(v) for k, v in value.items()) + '}'
                if isinstance(value, list):
                    return '[' + ', '.join(literal(v) for v in value) + ']'
                return json.dumps(value, ensure_ascii=False, allow_nan=False)
            lines[index:end] = ['PreToolUse = ' + literal(parsed['PreToolUse'] + [hook]) + '\n']
            source = ''.join(lines)
            addition = addition.split('\n\n[[hooks.PreToolUse]]', 1)[0] + '\n'
            break
        else:
            raise RuntimeError('Could not parse existing PreToolUse assignment')
        break
    after = source.encode() + addition.encode()
    check = tomllib.loads(after.decode())
    assert check['mcp_servers'].pop('task_cua') == entry
    assert check['hooks']['PreToolUse'].pop() == hook
    if not check['hooks']['PreToolUse'] and 'PreToolUse' not in original.get('hooks', {}):
        check['hooks'].pop('PreToolUse')
    if not check['hooks'] and 'hooks' not in original:
        check.pop('hooks')
    if not check['mcp_servers'] and 'mcp_servers' not in original:
        check.pop('mcp_servers')
    assert check == original
    return before, add_codex_cleanup_hooks(after)


def proposal_claude(path, root, previous, node):
    before = observed(path)
    config = json.loads(before or b'{}')
    current = config.get('mcpServers', {}).get('codex-computer-use')
    if not current or current.get('args') != [str(previous / 'server.mjs')]:
        raise RuntimeError('Claude bridge registration differs; existing configuration preserved')
    changed = dict(current)
    changed.update(command=node, args=[str(root / 'server.mjs')],
                   env={**current.get('env', {}), 'CUA_BRIDGE_HOME': str(root)})
    config['mcpServers']['codex-computer-use'] = changed
    return before, (json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode()


def activate(root, previous, codex, claude):
    manifest = json.loads((root / 'manifest.json').read_text())
    if any(sha((root / name).read_bytes()) != expected for name, expected in manifest['files'].items()):
        raise RuntimeError('Prepared runtime changed; inspect before activation')
    node = json.loads((root / 'config.json').read_text())['cua']['command']
    changes = [(codex, *proposal_codex(codex, root, node, previous)),
               (claude, *proposal_claude(claude, root, previous, node))]
    backup = root / 'registration-backup'
    backup.mkdir(mode=0o700)
    receipt = []
    for index, (path, before, after) in enumerate(changes):
        if before is not None:
            (backup / f'{index}.before').write_bytes(before)
            (backup / f'{index}.before').chmod(0o600)
        receipt.append({'path': str(path), 'before': sha(before) if before is not None else None,
                        'after': sha(after), 'backup': f'{index}.before' if before is not None else None})
    (backup / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    done = []
    try:
        for path, before, after in changes:
            cas(path, before, after)
            done.append((path, before, after))
    except BaseException:
        for path, before, after in reversed(done):
            if observed(path) == after:
                if before is not None:
                    cas(path, after, before)
                else:
                    path.unlink()
        raise
    return {'registered': ['Claude codex-computer-use', 'Codex task_cua'],
            'codexHookTrustRequired': tomllib.loads((changes[0][1] or b'').decode()).get('hooks', {}) != tomllib.loads(changes[0][2].decode()).get('hooks', {}), 'existingConnectionsUnchanged': True}


def restore(root):
    backup = root / 'registration-backup'
    receipt = json.loads((backup / 'receipt.json').read_text())
    # Validate all targets before restoring any of them.
    for item in receipt:
        current = observed(Path(item['path']))
        if current is None or sha(current) != item['after']:
            raise RuntimeError(f"Registration changed since upgrade: {item['path']}")
    for item in receipt:
        path = Path(item['path'])
        if item['backup']:
            before = (backup / item['backup']).read_bytes()
            if sha(before) != item['before']:
                raise RuntimeError('Backup integrity check failed')
            cas(path, observed(path), before)
        else:
            path.unlink()


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--prepare', action='store_true')
    mode.add_argument('--activate', action='store_true')
    mode.add_argument('--restore', action='store_true')
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--previous', type=Path, default=Path.home() / '.codex/cua-claude-mcp')
    p.add_argument('--safari-source', type=Path, default=HERE.parent / 'safari-window-mcp')
    p.add_argument('--socket', type=Path, required=False)
    p.add_argument('--codex-config', type=Path, default=Path.home() / '.codex/config.toml')
    p.add_argument('--claude-config', type=Path, default=Path.home() / '.claude.json')
    p.add_argument('--profile-wrapper', type=Path, help='Validated installed documentation profile wrapper')
    p.add_argument('--refresh-tools', action='store_true', help='Inspect current upstream schemas during preparation; no UI calls')
    a = p.parse_args()
    root, previous = a.root.expanduser().resolve(), a.previous.expanduser().resolve()
    if a.prepare:
        if not a.socket:
            p.error('--prepare requires --socket')
        prepare(root, previous, a.safari_source.resolve(), a.socket.expanduser().resolve(), a.profile_wrapper, a.refresh_tools)
        print(json.dumps({'prepared': str(root), 'registered': False}))
    elif a.activate:
        print(json.dumps(activate(root, previous, a.codex_config.expanduser(), a.claude_config.expanduser())))
    else:
        restore(root)
        print(json.dumps({'registrationsRestored': True, 'runtimeRetained': str(root)}))
