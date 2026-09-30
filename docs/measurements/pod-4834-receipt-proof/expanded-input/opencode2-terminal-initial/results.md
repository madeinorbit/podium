# opencode2-terminal-initial — opencode2 v0.0.0-beta-18866

Measured 2026-09-30T17:41:06.243Z–2026-09-30T17:45:09.216Z. [Run/config](run.json), [native records](native-records.jsonl), [full model inputs](model-requests.jsonl), [protocol](protocol.jsonl), [machine comparisons](summary.jsonl).

Bytes are UTF-8 after JSON decoding, not JSON escape length. `SP`, `LF`, `CR`, `TAB` mean bytes 20, 0a, 0d, 09. Frame id checks use the native prompt text and the strict closing-line rule. “Text rule” applies the current terminal matching source to native text (Codex/Grok readers trim it). It is not a test of the full delivery pipeline.

“Model body exact” checks all captured user messages, including auxiliary title requests; it does not establish that the main conversation request carried the body. Missing prompt records have no stored-byte, frame, or matching verdict. Bounded drain/submit timings and errors are in [observations](observations.jsonl) and the machine comparisons. [Method and limits](../README.md).

| Method / case | Sent B | Prompt records / stored B | Storage change | Body exact | Frame matches | Text rule | Model body exact |
|---|---:|---|---|---|---|---|---|
| initial-argument/lines-2-plain | 73 | 1 / 73 | exact | yes | — | yes | yes |
| initial-argument/lines-2-frame | 217 | 1 / 217 | exact | yes | yes | yes | yes |
| initial-argument/lines-10-plain | 380 | 1 / 380 | exact | yes | — | yes | yes |
| initial-argument/lines-10-frame | 524 | 1 / 524 | exact | yes | yes | yes | yes |
| initial-argument/lines-200-plain | 8091 | 1 / 8091 | exact | yes | — | yes | yes |
| initial-argument/lines-200-frame | 8235 | 1 / 8235 | exact | yes | yes | yes | yes |
| initial-argument/single-1024-plain | 1024 | 1 / 1024 | exact | yes | — | yes | yes |
| initial-argument/single-1024-frame | 1168 | 1 / 1168 | exact | yes | yes | yes | yes |
| initial-argument/single-16384-plain | 16384 | 1 / 16384 | exact | yes | — | yes | yes |
| initial-argument/single-16384-frame | 16528 | 1 / 16528 | exact | yes | yes | yes | yes |
| initial-argument/single-102400-plain | 102400 | 1 / 102400 | exact | yes | — | yes | yes |
| initial-argument/single-102400-frame | 102544 | 1 / 102544 | exact | yes | yes | yes | yes |
| initial-argument/tabs-plain | 35 | 1 / 35 | exact | yes | — | yes | yes |
| initial-argument/tabs-frame | 179 | 1 / 179 | exact | yes | yes | yes | yes |
| initial-argument/crlf-plain | 52 | 1 / 50 | CRLF/CR → LF | **no** | — | **no** | **no** |
| initial-argument/crlf-frame | 196 | 1 / 194 | CRLF/CR → LF | **no** | yes | **no** | **no** |
| initial-argument/trailing-lf-plain | 46 | 1 / 46 | exact | yes | — | yes | yes |
| initial-argument/trailing-lf-frame | 190 | 1 / 190 | exact | yes | yes | yes | yes |
