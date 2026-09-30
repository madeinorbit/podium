# Grok ACP 1.0.44 — expanded input storage (2026-09-30, POD-4984)

Original acceptance/receipt timing is in [README.md §Grok](../README.md). This run adds the
[expanded corpus](../expanded-input/README.md), using scratch HOME/GROK_HOME, a dummy key,
and the localhost fake. The installed binary is `grok 1.0.44 (5b807183dd79)`.

All **18** protocol inputs (9 shapes, plain and framed) are stored byte-exact as **one**
`updates.jsonl` `user_message_chunk` with one text content block. There is no chunk splitting,
text wrapper, truncation, tab expansion, newline normalization, or lost final LF in that record.
All nine frame ids survive. Our `_meta.promptId` survives on `turn_completed.prompt_id`; the
user chunk itself still has only `promptIndex` and the event id.

[Per-case sizes/hashes and model comparisons](../expanded-input/grok-acp/results.md),
[native chunks, model-history records, turn ids and spill files](../expanded-input/grok-acp/native-records.jsonl),
[full fake-model input](../expanded-input/grok-acp/model-requests.jsonl).

## Model history and 100 KiB offload

Ordinary `chat_history.jsonl` user text and model input are `<user_query>\n` + our text +
`\n</user_query>`: 27 additional UTF-8 bytes. The primary `updates.jsonl` chunk has **no** wrapper.

For 100 KiB, `updates.jsonl` still stores the entire 102,400/102,544-byte text. The complete
wrapped requests are saved as `prompts/prompt_0.txt` in each session: **102,427** bytes plain,
**102,571** framed. `chat_history.jsonl` and the main model request instead carry a
**99,095-byte** excerpt and an offload note. The excerpt includes the marker
`…[middle omitted — see the offload note for how to read it]…`; the note names the saved file
and instructs `read_file` with offset/limit for the omitted query line. Both frame ends survive
in the excerpt, and the note follows them. The fake does not call `read_file`, so it does not
receive the omitted middle through a tool call. Title generation also sends an 8,027-byte
wrapped prefix; that auxiliary request is separate from the main conversation input.

The complete bytes, note, filename and wrapper are preserved in the native capture. No ACP
reader/matching change is needed from this corpus: proof already reads the complete
`updates.jsonl` chunk, with our id bound by the turn record. Grok's terminal text changes are
tracked in POD-5005.
