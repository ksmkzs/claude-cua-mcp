"""Activation regression tests: all writes are confined to temporary paths."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
s=importlib.util.spec_from_file_location('installer',Path(__file__).resolve().parents[1]/'install.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        base=Path(self.tmp.name)
        m.ROOT=base/'state';m.ROOT.mkdir()
        (m.ROOT/'config.json').write_text('{}')
        (m.ROOT/'routing.key').write_bytes(b'test-only')
        (m.ROOT/'upstream-tools.json').write_text('{}')
        m.CLAUDE=base/'claude.json';m.SETTINGS=base/'settings.json';m.NODE='/example/node'
    def test_first_install_restore_preserves_other_settings(self):
        original={'other':1,'mcpServers':{'other':{'command':'other'}}}
        m.CLAUDE.write_text(json.dumps(original))
        m.SETTINGS.write_text(json.dumps({'other':'retained'}))
        m.activate();m.activate()
        self.assertEqual(len(json.loads(m.SETTINGS.read_text())['hooks']['PreToolUse']),1)
        m.restore()
        self.assertEqual(json.loads(m.CLAUDE.read_text()),original)
        self.assertEqual(json.loads(m.SETTINGS.read_text())['other'],'retained')
    def test_existing_entry_restored(self):
        original={'mcpServers':{m.NAME:{'command':'old','args':[]}}}
        m.CLAUDE.write_text(json.dumps(original));m.activate();m.restore()
        self.assertEqual(json.loads(m.CLAUDE.read_text()),original)
    def test_changed_entry_blocks_restore(self):
        m.activate();c=json.loads(m.CLAUDE.read_text());c['mcpServers'][m.NAME]={'command':'changed'}
        m.CLAUDE.write_text(json.dumps(c));before=m.SETTINGS.read_bytes()
        with self.assertRaises(SystemExit):m.restore()
        self.assertEqual(m.SETTINGS.read_bytes(),before)
    def test_missing_config_is_supported(self):
        m.activate();m.restore()
        self.assertEqual(json.loads(m.CLAUDE.read_text())['mcpServers'],{})
if __name__=='__main__':unittest.main()
