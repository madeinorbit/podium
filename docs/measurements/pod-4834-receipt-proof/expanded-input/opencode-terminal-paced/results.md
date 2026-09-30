# opencode-terminal-paced — 1.18.33

Measured 2026-09-30T17:25:53.960Z–2026-09-30T17:55:47.997Z. [Run/config](run.json), [native records](native-records.jsonl), [full model inputs](model-requests.jsonl), [protocol](protocol.jsonl), [machine comparisons](summary.jsonl).

Bytes are UTF-8 after JSON decoding, not JSON escape length. `SP`, `LF`, `CR`, `TAB` mean bytes 20, 0a, 0d, 09. Frame id checks use the native prompt text and the strict closing-line rule. “Text rule” applies the current terminal matching source to native text (Codex/Grok readers trim it). It is not a test of the full delivery pipeline.

“Model body exact” checks all captured user messages, including auxiliary title requests; it does not establish that the main conversation request carried the body. Missing prompt records have no stored-byte, frame, or matching verdict. Bounded drain/submit timings and errors are in [observations](observations.jsonl) and the machine comparisons. [Method and limits](../README.md).

| Method / case | Sent B | Prompt records / stored B | Storage change | Body exact | Frame matches | Text rule | Model body exact |
|---|---:|---|---|---|---|---|---|
| typed-paced/lines-2-plain | 73 | 1 / 73 | exact | yes | — | yes | yes |
| typed-paced/lines-2-frame | 217 | 1 / 217 | exact | yes | yes | yes | yes |
| typed-paced/lines-10-plain | 380 | 1 / 380 | exact | yes | — | yes | yes |
| typed-paced/lines-10-frame | 524 | 1 / 524 | exact | yes | yes | yes | yes |
| typed-paced/lines-200-plain | 8091 | 0 / — | no prompt | — | — | — | — |
| typed-paced/lines-200-frame | 8235 | 0 / — | no prompt | — | — | — | — |
| typed-paced/single-1024-plain | 1024 | 1 / 1024 | exact | yes | — | yes | yes |
| typed-paced/single-1024-frame | 1168 | 1 / 1168 | exact | yes | yes | yes | yes |
| typed-paced/single-16384-plain | 16384 | 0 / — | no prompt | — | — | — | — |
| typed-paced/single-16384-frame | 16528 | 0 / — | no prompt | — | — | — | — |
| typed-paced/single-102400-plain | 102400 | 0 / — | no prompt | — | — | — | — |
| typed-paced/single-102400-frame | 102544 | 0 / — | no prompt | — | — | — | — |
| typed-paced/tabs-plain | 35 | 1 / 32 | TAB removed | **no** | — | **no** | **no** |
| typed-paced/tabs-frame | 179 | 1 / 176 | TAB removed | **no** | yes | **no** | **no** |
| typed-paced/crlf-plain | 52 | 1 / 50 | CRLF/CR → LF | **no** | — | **no** | **no** |
| typed-paced/crlf-frame | 196 | 1 / 194 | CRLF/CR → LF | **no** | yes | **no** | **no** |
| typed-paced/trailing-lf-plain | 46 | 1 / 46 | exact | yes | — | yes | yes |
| typed-paced/trailing-lf-frame | 190 | 1 / 190 | exact | yes | yes | yes | yes |
