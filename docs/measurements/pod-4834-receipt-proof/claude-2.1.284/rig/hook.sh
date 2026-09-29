#!/bin/sh
# Logs every hook call with its arrival time. Test actions: a UserPromptSubmit whose prompt
# contains BLOCKME is blocked; a Stop is blocked once when $CTL/stopblock exists.
ts=$(date +%s%3N)
payload=$(cat)
printf '{"at":%s,"ev":"%s","payload":%s}\n' "$ts" "$1" "$payload" >> ${HOOK_LOG:?}
case "$1" in
  UserPromptSubmit)
    case "$payload" in *BLOCKME*) printf '{"decision":"block","reason":"blocked-by-test"}\n'; exit 0;; esac ;;
  Stop)
    if [ -f "${CTL:?}/stopblock" ]; then rm -f "$CTL/stopblock"; printf '{"decision":"block","reason":"STOPFEEDBACK please say done"}\n'; exit 0; fi ;;
esac
exit 0
