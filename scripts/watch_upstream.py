#!/usr/bin/env python3
"""Record public desktop releases; never mark a release runtime-compatible."""
import argparse
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

FEED = 'https://persistent.oaistatic.com/codex-app-prod/appcast.xml'
SPARKLE = '{http://www.andymatuschak.org/xml-namespaces/sparkle}'
ROOT = Path(__file__).resolve().parents[1]

def parse_feed(data):
    root = ET.fromstring(data)
    releases = {}
    for item in root.findall('.//item'):
        version = item.findtext(SPARKLE+'shortVersionString')
        build = item.findtext(SPARKLE+'version')
        arch = item.findtext(SPARKLE+'hardwareRequirements') or 'unspecified'
        enclosure = item.find('enclosure')  # Full release, never a delta.
        if enclosure is None or not version or not build or not build.isdigit():
            continue
        url = enclosure.get('url', '')
        parts = urlsplit(url)
        if parts.scheme != 'https' or parts.hostname != 'persistent.oaistatic.com' or not parts.path.startswith('/codex-app-prod/'):
            raise ValueError('Unexpected upstream download origin')
        candidate = dict(version=version, build=build, architecture=arch, url=url,
                         published=item.findtext('pubDate'), length=enclosure.get('length'))
        if arch not in releases or int(build) > int(releases[arch]['build']):
            releases[arch] = candidate
    if not releases:
        raise ValueError('No recognized desktop releases; refusing an empty update')
    return {'feed': FEED, 'releases': [releases[k] for k in sorted(releases)],
            'runtime_compatibility': 'not_verified',
            'meaning': 'Release observation only. Does not update local guards or certify CUA compatibility.'}

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--feed-file', type=Path)
    p.add_argument('--output', type=Path, default=ROOT/'upstream/observed.json')
    a = p.parse_args()
    data = a.feed_file.read_bytes() if a.feed_file else subprocess.check_output(
        ['curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=https',
         '--max-time', '60', '--max-filesize', '2097152', FEED], timeout=65)
    record = parse_feed(data)
    if a.output.exists():
        old = json.loads(a.output.read_text())
        old_builds = {r['architecture']:int(r['build']) for r in old.get('releases', [])}
        new_builds = {r['architecture']:int(r['build']) for r in record['releases']}
        if any(k not in new_builds or new_builds[k] < b for k,b in old_builds.items()):
            raise ValueError('Feed regressed or omitted an architecture; manual review required')
    result = json.dumps(record, indent=2, sort_keys=True)+'\n'
    if a.output.exists() and a.output.read_text() == result:
        print('Upstream unchanged')
        return
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(result)
    print('Updated release observation; runtime compatibility remains unverified')

if __name__ == '__main__':
    main()
