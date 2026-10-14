#!/usr/bin/env python3
"""Create/update one review PR after the updater and offline tests succeed."""
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BRANCH = 'automation/codex-app-update'
def run(*args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, text=True, capture_output=True, **kwargs).stdout.strip()

def main():
    changed = run('git', 'status', '--porcelain', '--', 'upstream/observed.json')
    if not changed:
        print('No release change; no PR')
        return
    record = json.loads((ROOT/'upstream/observed.json').read_text())
    # Version data stays in a body file, never in shell source or a branch name.
    candidate = (ROOT/'upstream/observed.json').read_text()
    run('git', 'restore', '--', 'upstream/observed.json')
    remote = run('git', 'ls-remote', '--heads', 'origin', BRANCH).split()
    if remote:
        run('git', 'fetch', 'origin', BRANCH)
        run('git', 'checkout', '-B', BRANCH, 'FETCH_HEAD')
    else:
        run('git', 'checkout', '-B', BRANCH)
    (ROOT/'upstream/observed.json').write_text(candidate)
    run('git', 'config', 'user.name', 'github-actions[bot]')
    run('git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    run('git', 'add', '--', 'upstream/observed.json')
    if run('git','diff','--cached','--name-only'):
        run('git', 'commit', '-m', 'chore: record Codex desktop release for compatibility review')
        run('git', 'push', 'origin', f'HEAD:refs/heads/{BRANCH}')
    body = ('A new public Codex desktop release was detected. This PR updates the release observation only.\n\n'
            'Offline project tests passed in the updater job. Native CUA/UI compatibility has NOT been tested. '
            'Hash/schema acceptance guards are unchanged.\n\n'
            'Before declaring support, inspect the new runtime, run the local compatibility checks, '
            'and verify documentation loading or Claude lifecycle behavior as appropriate.\n\n'
            'Observed releases:\n'+ ''.join(f"- {r['architecture']}: {r['version']} (build {r['build']})\n" for r in record['releases'])+
            '\nSource: '+record['feed']+'\n')
    prs = json.loads(run('gh', 'pr', 'list', '--head', BRANCH, '--state', 'open', '--json', 'number'))
    with tempfile.NamedTemporaryFile(mode='w', suffix='.md') as f:
        f.write(body);f.flush()
        if prs:
            run('gh','pr','edit',str(prs[0]['number']),'--body-file',f.name)
        else:
            run('gh','pr','create','--draft','--base','main','--head',BRANCH,
                '--title','Review Codex desktop update compatibility','--body-file',f.name)
    print('Update PR created or refreshed')

if __name__ == '__main__':
    main()
