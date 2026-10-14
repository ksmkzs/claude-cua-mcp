#!/usr/bin/python3
"""An OS-owned operation lock. EOF from the parent releases it even on a crash."""
import fcntl
import os
import sys
import time

path, timeout = sys.argv[1], float(sys.argv[2])
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
deadline = time.monotonic() + timeout
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= deadline:
            sys.stderr.write('Another Claude CUA operation is still active; no action was sent.\n')
            sys.exit(1)
        time.sleep(0.1)
sys.stdout.write('locked\n')
sys.stdout.flush()
sys.stdin.read()
os.close(fd)
