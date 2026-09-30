# opencode-v2 — 1.18.33

Measured 2026-09-30T16:27:07.173Z–2026-09-30T16:27:34.673Z. [Run/config](run.json), [native records](native-records.jsonl), [full model inputs](model-requests.jsonl), [protocol](protocol.jsonl), [machine comparisons](summary.jsonl).

Bytes are UTF-8 after JSON decoding, not JSON escape length. `SP`, `LF`, `CR`, `TAB` mean bytes 20, 0a, 0d, 09. Frame id checks use the native prompt text and the strict closing-line rule. “Text rule” applies the current terminal matching source to native text (Codex/Grok readers trim it). It is not a test of the full delivery pipeline.

| Method / case | Sent B | Prompt records / stored B | Storage change | Body exact | Frame matches | Text rule | Model body exact |
|---|---:|---|---|---|---|---|---|
| protocol/lines-2-plain | 73 | 1 / 73 | exact | yes | — | yes | yes |
| protocol/lines-2-frame | 217 | 1 / 217 | exact | yes | yes | yes | yes |
| protocol/lines-10-plain | 380 | 1 / 380 | exact | yes | — | yes | yes |
| protocol/lines-10-frame | 524 | 1 / 524 | exact | yes | yes | yes | yes |
| protocol/lines-200-plain | 8091 | 1 / 8091 | exact | yes | — | yes | yes |
| protocol/lines-200-frame | 8235 | 1 / 8235 | exact | yes | yes | yes | yes |
| protocol/single-1024-plain | 1024 | 1 / 1024 | exact | yes | — | yes | yes |
| protocol/single-1024-frame | 1168 | 1 / 1168 | exact | yes | yes | yes | yes |
| protocol/single-16384-plain | 16384 | 1 / 16384 | exact | yes | — | yes | yes |
| protocol/single-16384-frame | 16528 | 1 / 16528 | exact | yes | yes | yes | yes |
| protocol/single-102400-plain | 102400 | 1 / 102400 | exact | yes | — | yes | yes |
| protocol/single-102400-frame | 102544 | 1 / 102544 | exact | yes | yes | yes | yes |
| protocol/tabs-plain | 35 | 1 / 35 | exact | yes | — | yes | yes |
| protocol/tabs-frame | 179 | 1 / 179 | exact | yes | yes | yes | yes |
| protocol/crlf-plain | 52 | 1 / 52 | exact | yes | — | yes | yes |
| protocol/crlf-frame | 196 | 1 / 196 | exact | yes | yes | yes | yes |
| protocol/trailing-lf-plain | 46 | 1 / 46 | exact | yes | — | yes | yes |
| protocol/trailing-lf-frame | 190 | 1 / 190 | exact | yes | yes | yes | yes |
