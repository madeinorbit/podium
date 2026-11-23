# Native quota reports

`quota-usage.json` and `quota-credits.json` are the actual JSON emitted by the
checksum-verified Google `agy` 1.5.15 binary for `--print /usage` and
`--print /credits`, both with `--output-format json`.

The CLI used an isolated synthetic Google credential and a local HTTPS proxy
serving synthetic Code Assist responses. No real Google account, model
generation, or paid request was used. Both reports have zero model turns.
The local responses exercised independent Gemini and Claude/GPT pools, weekly
and five-hour limits, and Google One AI credits. Amounts and timestamps are
fixtures, not someone's account usage.

The native CLI owns OAuth refresh, endpoint selection and provider formats;
Podium consumes only its structured read-only command reports.
