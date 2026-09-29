#!/usr/bin/env python3
# killer.py RUN SESS PID DELAY_MS LABEL: press Enter in the pane, SIGKILL the CLI DELAY_MS later; marks both.
import os, sys, time, subprocess, signal
run, sess, pid, delay, label = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
marks = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'runs', run, 'marks.txt')
t0 = int(time.time() * 1000); subprocess.run(['tmux', 'send-keys', '-t', sess, 'Enter'])
time.sleep(max(0, delay / 1000 - (time.time() * 1000 - t0) / 1000)); os.kill(pid, signal.SIGKILL); t1 = int(time.time() * 1000)
open(marks, 'a').write(f'{label}_ENTER {t0}\n{label}_KILL9 {t1}\n')
