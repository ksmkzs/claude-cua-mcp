import importlib.util
from pathlib import Path
import unittest
p=Path(__file__).resolve().parents[1]/'scripts/watch_upstream.py'
s=importlib.util.spec_from_file_location('watch',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def feed(items):
    return '<rss xmlns:s="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>'+items+'</channel></rss>'
def item(build='2',arch='arm64',url='https://persistent.oaistatic.com/codex-app-prod/a.zip'):
    return f'<item><s:version>{build}</s:version><s:shortVersionString>v{build}</s:shortVersionString><s:hardwareRequirements>{arch}</s:hardwareRequirements><enclosure url="{url}"/></item>'
class FeedTests(unittest.TestCase):
    def test_selects_latest_per_arch_even_when_unordered(self):
        r=m.parse_feed(feed(item('1')+item('3')+item('2','x86_64')))
        self.assertEqual([x['build'] for x in r['releases']],['3','2'])
        self.assertEqual(r['runtime_compatibility'],'not_verified')
    def test_rejects_empty_and_foreign_origins(self):
        for x in [feed(''),feed(item(url='https://example.org/a.zip'))]:
            with self.assertRaises(ValueError):m.parse_feed(x)
    def test_ignores_delta_only_entry(self):
        with self.assertRaises(ValueError):m.parse_feed(feed('<item><s:version>9</s:version><s:shortVersionString>v9</s:shortVersionString><s:deltas><enclosure url="https://persistent.oaistatic.com/codex-app-prod/a.delta"/></s:deltas></item>'))
if __name__=='__main__':unittest.main()
