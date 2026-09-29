#!/bin/sh
# Logs one hook event: {"at": ms, "ev": <event>, "payload": <stdin JSON>} to $HOOK_LOG.
# Hook feedback probe (S9): while <log dir>/.feedback-on exists, UserPromptSubmit adds context
# and Stop blocks once (only when stop_hook_active is false), so we can see what Codex records.
ts=$(date +%s%3N)
payload=$(cat)
printf '{"at":%s,"ev":"%s","payload":%s}\n' "$ts" "$1" "$payload" >> ${HOOK_LOG:?}
if [ -e "$(dirname "$HOOK_LOG")/.feedback-on" ]; then
  case "$1" in
    UserPromptSubmit)
      printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"CTX-FROM-UPS-HOOK"}}\n' ;;
    Stop)
      case "$payload" in
        *'"stop_hook_active":false'*) printf '{"decision":"block","reason":"STOP-HOOK-FEEDBACK continue once"}\n' ;;
      esac ;;
  esac
fi
exit 0
