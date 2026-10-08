# Runs a command in a pseudo-terminal of 120 columns and 40 rows, the way a
# developer's terminal runs it, answers its prompts and prints everything it
# wrote. Node has no terminal of its own to give a child process; Python's
# pty module does, on macOS and Linux alike.
#
#   python3 pty-run.py '<steps>' <command> [args...]
#
# <steps> is a JSON list of [text, keys]: once `text` shows in the output
# (colours taken out) after the previous step's match, `keys` is typed.
# Exits with the command's exit code; 124 when it ran past 60 seconds.
import fcntl
import json
import os
import pty
import re
import select
import struct
import sys
import termios
import time

steps = json.loads(sys.argv[1])
command = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    os.execvp(command[0], command)

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")
raw = b""
seen = 0
deadline = time.time() + 60
while True:
    if time.time() > deadline:
        os.kill(pid, 9)
        os.waitpid(pid, 0)
        sys.stdout.write(ANSI.sub("", raw.decode("utf8", "replace")))
        sys.exit(124)
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            chunk = b""
        if not chunk:
            break
        raw += chunk
    text = ANSI.sub("", raw.decode("utf8", "replace"))
    if steps:
        at = text.find(steps[0][0], seen)
        if at != -1:
            seen = at + len(steps[0][0])
            time.sleep(0.2)
            os.write(fd, steps[0][1].encode("utf8"))
            steps.pop(0)

_, status = os.waitpid(pid, 0)
sys.stdout.write(ANSI.sub("", raw.decode("utf8", "replace")))
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status >> 8)
