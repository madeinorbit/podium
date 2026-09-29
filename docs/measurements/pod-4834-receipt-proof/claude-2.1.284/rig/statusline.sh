#!/bin/sh
ts=$(date +%s%3N)
payload=$(cat)
printf '{"at":%s,"payload":%s}\n' "$ts" "$payload" >> ${STATUS_LOG:?}
echo "sl"
