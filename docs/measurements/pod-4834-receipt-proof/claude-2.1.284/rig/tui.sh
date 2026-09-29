#!/bin/bash
# tui.sh start RUN SESS [claude args...] | send RUN SESS LABEL TEXT | key RUN SESS LABEL KEY... | raw RUN SESS LABEL BYTES | shot RUN SESS NAME
RIG=$(cd "$(dirname "$0")" && pwd); cmd=$1 RUN=$2 SESS=$3; shift 3; R=$(realpath $RIG/../runs/$RUN)
case $cmd in
  start) tmux new-session -d -s $SESS -x 180 -y 45 "bash -c 'source $R/env.sh; cd $R/work; claude $*; echo CLAUDE_EXIT=\$?; sleep 3600'"; $RIG/mark.sh $RUN START_$SESS ;;
  send) LABEL=$1; shift; tmux send-keys -t $SESS -l "$*"; sleep 0.4; $RIG/mark.sh $RUN $LABEL; tmux send-keys -t $SESS Enter ;;
  key) LABEL=$1; shift; $RIG/mark.sh $RUN $LABEL; tmux send-keys -t $SESS "$@" ;;
  raw) LABEL=$1; shift; $RIG/mark.sh $RUN $LABEL; tmux send-keys -t $SESS -l "$(printf "$1")" ;;
  shot) mkdir -p $R/screens; tmux capture-pane -t $SESS -p > $R/screens/$1.txt ;;
esac
