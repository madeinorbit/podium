#!/bin/bash
# stoprun.sh RUN PORT [SESS] — kill own tmux session, fake by port, watcher by pid
R=$(realpath $(dirname "$0")/../runs/$1)
[ -n "$3" ] && tmux kill-session -t $3 2>/dev/null
fuser -k $2/tcp 2>/dev/null
kill $(cat $R/watch.pid) 2>/dev/null
true
