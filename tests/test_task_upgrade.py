import importlib.util
import json
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('upgrade', Path(__file__).resolve().parents[1] / 'upgrade_task_windows.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class TaskUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.root, self.old = base / 'new', base / 'old'
        self.root.mkdir()
        self.codex, self.claude = base / 'config.toml', base / 'claude.json'
        self.codex.write_text('[features]\nhooks = true\n[hooks]\ntrusted_hashes = ["unchanged"]\n')
        self.claude.write_text(json.dumps({'other': 42, 'mcpServers': {
            'other': {'command': 'keep'},
            'codex-computer-use': {'command': '/example/node', 'args': [str(self.old / 'server.mjs')],
                                  'env': {'CUA_BRIDGE_HOME': str(self.old), 'PRESERVE': 'yes'}},
        }}))
        (self.root / 'config.json').write_text('{"cua":{"command":"/example/node"}}')
        (self.root / 'manifest.json').write_text('{"files":{}}')

    def test_activation_preserves_trust_unrelated_settings_and_restores_exact_bytes(self):
        original = self.codex.read_bytes(), self.claude.read_bytes()
        result = m.activate(self.root, self.old, self.codex, self.claude)
        self.assertTrue(result['codexHookTrustRequired'])
        c = tomllib.loads(self.codex.read_text())
        self.assertEqual(c['hooks']['trusted_hashes'], ['unchanged'])
        self.assertEqual(c['hooks']['PreToolUse'][0]['matcher'], m.MATCHER)
        k = json.loads(self.claude.read_text())
        self.assertEqual(k['other'], 42)
        self.assertEqual(k['mcpServers']['codex-computer-use']['env']['PRESERVE'], 'yes')
        m.restore(self.root)
        self.assertEqual((self.codex.read_bytes(), self.claude.read_bytes()), original)

    def test_reupgrade_preserves_existing_signer_trust_and_global_operation_lock(self):
        m.activate(self.root, self.old, self.codex, self.claude)
        previous = tomllib.loads(self.codex.read_text())
        next_root = self.root.parent / 'next'
        before, after = m.proposal_codex(self.codex, next_root, '/example/node', self.root)
        current = tomllib.loads(after.decode())
        self.assertEqual(current['hooks'], previous['hooks'])
        self.assertEqual(current['mcp_servers']['task_cua']['args'], [str(next_root / 'server.mjs')])
        self.assertEqual(self.codex.read_bytes(), before)

    def test_conflicting_claude_entry_prevents_codex_mutation(self):
        self.claude.write_text('{"mcpServers":{"codex-computer-use":{"command":"foreign"}}}')
        before = self.codex.read_bytes()
        with self.assertRaises(RuntimeError):
            m.activate(self.root, self.old, self.codex, self.claude)
        self.assertEqual(self.codex.read_bytes(), before)

    def test_inline_existing_hook_arrays_preserve_hooks_trust_and_exact_rollback(self):
        self.codex.write_text(
            '[hooks.state."old-hook"]\ntrusted_hash = "keep"\n'
            '[hooks]\nPreToolUse = [\n'
            '{matcher="*", hooks=[{type="command",command="existing guard",timeout=20}]},\n'
            ']\nPostToolUse = [{matcher="*", hooks=[]}]\n')
        before = self.codex.read_bytes()
        original = tomllib.loads(before.decode())
        m.activate(self.root, self.old, self.codex, self.claude)
        changed = tomllib.loads(self.codex.read_text())
        self.assertEqual(changed['hooks']['PreToolUse'][:-1], original['hooks']['PreToolUse'])
        self.assertEqual(changed['hooks']['PostToolUse'], original['hooks']['PostToolUse'])
        self.assertEqual(changed['hooks']['state'], original['hooks']['state'])
        m.restore(self.root)
        self.assertEqual(self.codex.read_bytes(), before)

    def test_existing_install_gets_two_cleanup_hooks_without_changing_signer_or_trust(self):
        m.activate(self.root, self.old, self.codex, self.claude)
        source = self.codex.read_text()
        source = source[:source.index('\n[[hooks.Stop]]')]
        self.codex.write_text(source)
        original = tomllib.loads(source)
        before, after = m.proposal_codex(self.codex, self.root.parent/'next', '/example/node', self.root)
        updated = tomllib.loads(after.decode())
        self.assertEqual(updated['hooks']['PreToolUse'], original['hooks']['PreToolUse'])
        self.assertEqual(updated['hooks']['trusted_hashes'], ['unchanged'])
        for event in ('Stop', 'SubagentStop'):
            handler = updated['hooks'][event][0]['hooks'][0]
            self.assertEqual(handler['tool'], 'codex_lifecycle')
            self.assertEqual(handler['input']['event'], event)
        self.assertEqual(m.add_codex_cleanup_hooks(after), after)
        self.assertEqual(self.codex.read_bytes(), before)

    def test_existing_inline_stop_hooks_are_preserved(self):
        original = b'[hooks]\nStop = [{hooks=[{type="command",command="keep"}]}]\nSubagentStop = []\n'
        after = m.add_codex_cleanup_hooks(original)
        parsed = tomllib.loads(after.decode())
        self.assertEqual(parsed['hooks']['Stop'][0]['hooks'][0]['command'], 'keep')
        self.assertEqual(len(parsed['hooks']['Stop']), 2)
        self.assertEqual(len(parsed['hooks']['SubagentStop']), 1)
        self.assertEqual(m.add_codex_cleanup_hooks(after), after)

    def test_second_target_concurrent_change_rolls_back_only_our_first_write(self):
        original = self.codex.read_bytes()
        cas = m.cas
        def concurrent(path, before, after):
            if path == self.claude:
                path.write_text('{"externalChange":true}')
            return cas(path, before, after)
        with patch.object(m, 'cas', side_effect=concurrent):
            with self.assertRaises(RuntimeError):
                m.activate(self.root, self.old, self.codex, self.claude)
        self.assertEqual(self.codex.read_bytes(), original)
        self.assertEqual(json.loads(self.claude.read_text()), {'externalChange': True})

    def test_restore_refuses_changed_registration_before_touching_any_target(self):
        m.activate(self.root, self.old, self.codex, self.claude)
        self.claude.write_text('{"externalChange":true}')
        before = self.codex.read_bytes()
        with self.assertRaises(RuntimeError):
            m.restore(self.root)
        self.assertEqual(self.codex.read_bytes(), before)
