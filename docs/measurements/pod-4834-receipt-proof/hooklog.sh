#!/bin/sh
ts=$(date +%s%3N)
payload=$(cat)
printf '{"at":%s,"ev":"%s","payload":%s}\n' "$ts" "$1" "$payload" >> ${HOOK_LOG:?}
exit 0
