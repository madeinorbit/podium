# Drive the TUI: mark <name> appends a mark to the timeline; say <text> types the text then presses Enter (mark at Enter).
TL=/tmp/claude-1000/-home-mgw-src-other-podium--worktrees-issue-4864-opencode-receipt-facts/f25098c9-63b4-4689-a2fb-09860af8a3fb/scratchpad/logs/tui.jsonl
T=oc4864tui
mark() { printf '{"at":%s,"kind":"mark","name":"%s"}\n' "$(date +%s%3N)" "$1" >> $TL; }
type_() { tmux -L oc4864 send-keys -t $T -l "$1"; }
enter() { mark "$1"; tmux -L oc4864 send-keys -t $T Enter; }
say() { type_ "$2"; sleep 0.4; enter "$1"; }
screen() { tmux -L oc4864 capture-pane -p -t $T | grep -v '^\s*$'; }
