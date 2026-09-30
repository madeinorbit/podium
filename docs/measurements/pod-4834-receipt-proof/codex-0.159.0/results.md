# Codex 0.159.0 — expanded input storage (2026-09-30, POD-4984)

This is a new versioned run alongside the 0.155.0 timing measurements. It uses the
[expanded corpus and method](../expanded-input/README.md): 2/10/200 lines, 1/16/100 KiB single
lines, tabs, CRLF, and a final LF, each plain and framed. All model traffic uses a scratch HOME,
a dummy key, and the local fake.

| Path | Native storage | Text / ids | Evidence |
|---|---|---|---|
| App-server | One rollout `event_msg item_completed`, `item.type: UserMessage`, one text content block per case | All 18 inputs byte-exact, including 102,400/102,544-byte plain/framed inputs, tabs, CRLF and final LF. `client_id` equals our `clientUserMessageId`; all 9 frames survive | [App-server table](../expanded-input/codex-app-server/results.md) |
| Terminal bracketed paste | Same `UserMessage` record; TUI-generated `client_id` | 2/10/200 lines and 1/16/100 KiB stay complete, one record each. CRLF → LF (52→50 B plain, 196→194 B framed). Plain final LF is trimmed (46→45 B); an internal final LF inside a frame stays. Tabs stay in these pasted records. All 9 frame ids remain valid | [Paste table](../expanded-input/codex-terminal/results.md) |
| Terminal unbracketed input | Same record when submission occurs | Short cases are recorded; CRLF becomes two LFs in the buffer run (52/196 B), or one LF in the framed key-chunk run (194 B). Key chunks also recorded a framed tab case without its tabs (179→176 B). Larger cases have no native prompt record within the stated observation window | [Buffer/drain](../expanded-input/codex-terminal-raw/results.md), [key chunks](../expanded-input/codex-terminal-paced/results.md) |
| Terminal literal startup argument | Same rollout `UserMessage`, TUI-generated id | All 18 inputs produce one complete record. 100 KiB stays full. CRLF → LF, tabs stay, and final LF stays in the native record. Frames all survive. This bypasses keyboard ingestion and is reported separately | [Startup table](../expanded-input/codex-terminal-initial/results.md) |

No `<pasted_content>` wrapper or other text wrapper appears in a native `UserMessage`.
Where a record is written, there is no truncation, split into several prompt records, or lost
frame id. `history.jsonl` is an auxiliary edit history; its exact objects are included as
`input-history` records. Earlier 0.155.0 runs already showed entries for unsent text.

**POD-5003 — Codex terminal text matching** owns the reader/matching follow-up. The current
`codexPromptTextMatches` only trims and misses the measured CRLF/tab alternatives. The strict
frame rule works on every stored framed prompt. No reader or driver is changed here.

The final unbracketed drain observations include no record for 200 lines or the 16/100 KiB
cases; 100 KiB was observed for over 512 seconds before submit attempts and shutdown.
The editor tail was not visible. This is a pending-input observation, not a claim that Codex
truncates a persisted prompt. Storage of complete accepted inputs is established by paste,
the app-server, and the separately labelled startup-argument run.
**POD-5011 — Long terminal input drain** records the separate input-boundary discovery in Proposed.
