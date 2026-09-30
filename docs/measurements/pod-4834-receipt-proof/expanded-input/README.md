# Expanded input byte measurements

POD-4984 extends the 2026-09-29 short-prompt measurements. This is measurement evidence;
no reader, matching rule, or production driver is changed here. Claude's terminal row belongs
to POD-4982 and is not remeasured or edited by this lane.

## Corpus and isolation

[input-cases.jsonl](input-cases.jsonl) contains the exact strings and SHA-256 digests.
Every shape is sent both as a person's plain text and in a strict Podium delivery frame.
The frame adds 144 UTF-8 bytes and two lines; the body's bytes are unchanged. Sizes called
1, 16, and 100 KB in this experiment mean 1,024, 16,384, and 102,400 bytes (KiB).

| Shape | Body UTF-8 bytes | Framed UTF-8 bytes |
|---|---:|---:|
| 2 LF-separated lines | 73 | 217 |
| 10 LF-separated lines | 380 | 524 |
| 200 LF-separated lines | 8,091 | 8,235 |
| 1 KiB single line | 1,024 | 1,168 |
| 16 KiB single line | 16,384 | 16,528 |
| 100 KiB single line | 102,400 | 102,544 |
| Three internal tabs | 35 | 179 |
| Three lines, two CRLF separators | 52 | 196 |
| Two lines, final LF | 46 | 190 |

Each lane uses a new scratch HOME and work directory, a credential-free environment allowlist,
a dummy provider key, and a localhost fake. Every terminal case starts a fresh CLI process in a
180×45 pane on a dedicated tmux server. Cleanup fences every process to that run's unique HOME
and kills the fake **by its port**, checking its pid. [run.json](codex-app-server/run.json) in each
directory pins its actual binary version, command path, config, environment, ports, and times.

Terminal paste uses `tmux paste-buffer -r -p`; `-r` keeps LF and CR bytes rather than converting
LF to CR. Unbracketed input uses literal `send-keys -l --` chunks (256 characters, 40 ms apart),
or an unbracketed `paste-buffer -r` byte stream where indicated. Neither is human typing at a
fixed words-per-minute rate: a CLI may detect a burst as a paste. The input bytes and method
are recorded explicitly. Newline bytes are literal LF/CRLF, not an invented Shift+Enter mapping.

For unbracketed input the rig waits for the final marker in the fresh editor, up to
`max(60 seconds, 5 ms per sent byte)`, then attempts Enter even if the marker has not appeared.
A second Enter, if needed, and the input-drain result are recorded in `observations.jsonl`.
The window includes the time to send key chunks. Early probes using
one large `send-keys` argument hit tmux's command limit, and early 20-second observations could
end before the editor consumed all the input. Those are harness/pending-input observations,
not proof of program-side truncation. Final bounded drain captures are `codex-terminal-raw`,
`opencode-terminal-paced`, `opencode2-terminal-paced`, and `grok-terminal-paced`.
The earlier `typed` rows and `codex-terminal-paced` preserve diagnostic observations with
shorter windows; do not use their missing records as a storage or truncation result.

`*-terminal-initial` supplies the same literal text as the startup prompt argument. This
bypasses keyboard ingestion and is a separate storage probe. Codex and stable OpenCode normally
submit automatically; the beta OpenCode `--prompt` prefills and needs Enter. The rig records
that explicit submit in `initialSubmitAt`. These probes do not replace the keyboard cases.

## Results across programs

All five protocol lanes store all **18/18** cases byte-exact as one native prompt record,
including tabs, CRLF, final LF, 200 lines, and 100 KiB. All protocol ids and all nine frames
survive. Terminal bracketed paste records **18/18** cases on each of four builds, with one
complete native prompt and all nine strict frame ids; the control-byte changes below are
preserved in the evidence. No native prompt text has a paste wrapper or size truncation.

| Program and path | Prompt records | Native text / identity | Results |
|---|---:|---|---|
| Codex 0.159.0 app-server | 18/18 | Rollout `item_completed UserMessage`; our `clientUserMessageId` stored as `client_id` | [Per case](codex-app-server/results.md), [program report](../codex-0.159.0/results.md) |
| OpenCode 1.18.33 HTTP v1 | 18/18 | User text part; our message and part ids | [Per case](opencode-v1/results.md) |
| OpenCode 1.18.33 HTTP v2 | 18/18 | Admission plus delivered `session_message`; our id | [Per case](opencode-v2/results.md) |
| OpenCode beta-18866 HTTP v2 | 18/18 | Delivered user row; our id, inbox consumed | [Per case](opencode2-v2/results.md), [both-build report](../opencode-1.18.33/results.md#expanded-input-storage-2026-09-30-pod-4984) |
| Grok 1.0.44 ACP | 18/18 | Full `updates.jsonl` user chunk; our `_meta.promptId` on `turn_completed` | [Per case](grok-acp/results.md), [program report](../grok-acp-1.0.44/results.md) |
| Codex 0.159.0 terminal paste / unbracketed buffer | 18/18 / 12/18 | TUI ids; six larger unbracketed cases have no record inside the bound | [Paste](codex-terminal/results.md), [final buffer/drain](codex-terminal-raw/results.md) |
| OpenCode 1.18.33 terminal paste / final key chunks | 18/18 / 12/18 | OpenCode ids; six larger key-input cases have no record inside the bound | [Paste](opencode-terminal/results.md), [final key chunks](opencode-terminal-paced/results.md) |
| OpenCode beta-18866 terminal paste / final key chunks | 18/18 / 12/18 | OpenCode ids; same larger-case limit | [Paste](opencode2-terminal/results.md), [final key chunks](opencode2-terminal-paced/results.md) |
| Grok 1.0.44 terminal paste / final key chunks | 18/18 / 18/18 | Full `updates.jsonl` chunk; Grok ids | [Paste](grok-terminal/results.md), [final key chunks](grok-terminal-paced/results.md), [program report](../grok-tui-1.0.44/results.md#expanded-input-storage-2026-09-30-pod-4984) |

`SP` = space, `LF` = newline, `TAB` = tab. Sizes below are plain / framed UTF-8 bytes.
Ordinary LF-separated and long single-line text stays complete in every stored prompt,
apart from OpenCode's paste-ending SP. The repeated hex payload is compared in full by SHA-256,
not by its visible prefix or suffix.

| Terminal method | Tabs (35 / 179 B sent) | CRLF (52 / 196 B sent) | Final LF (46 / 190 B sent) |
|---|---|---|---|
| Codex bracketed paste | Exact: 35 / 179 | CRLF → LF: 50 / 194 | Plain trim: 45; framed exact: 190 |
| Codex unbracketed buffer | Exact: 35 / 179 | CRLF → **two** LFs: 52 / 196 | Plain trim: 45; framed exact: 190 |
| Codex diagnostic key chunks | Plain exact: 35; framed tabs removed: 176 | Plain two LFs: 52; framed one LF: 194 | Plain trim: 45; framed exact: 190 |
| Both OpenCode builds, bracketed paste | Plain exact: 35; framed +SP: 180 | CRLF → LF, +SP: 51 / 195 | Plain exact: 46; framed +SP: 191 |
| Both OpenCode builds, final key chunks | Tabs removed: 32 / 176 | CRLF → LF: 50 / 194 | Exact: 46 / 190 |
| Grok bracketed paste | Each TAB → four SP: 44 / 188 | Exact: 52 / 196 | Exact: 46 / 190 |
| Grok final key chunks | Tabs removed: 32 / 176 | CRLF → LF: 50 / 194 | Exact: 46 / 190 |

The startup-argument probes store all 18 cases in Codex and beta OpenCode: complete text,
CRLF → LF, tabs and final LF retained, all frames valid. Stable OpenCode stores 16 exact
cases; its two CRLF prompts remain visibly prefilled without a record inside the 48-second
observation. [Codex](codex-terminal-initial/results.md), [stable](opencode-terminal-initial/results.md),
[beta](opencode2-terminal-initial/results.md) preserve those separate observations.

## Wrappers and auxiliary history

OpenCode's edit history uses `[Pasted ~N lines] ` plus full text in `parts[]` (stable) or
`pasted[]` (beta). Even a long single line can show `[Pasted ~1 lines] `. The conversation
text part stores the expanded text, not that placeholder. The exact objects, placeholder
source spans, hashes and byte sizes are retained in [stable](opencode-terminal/auxiliary-history.jsonl)
and [beta](opencode2-terminal/auxiliary-history.jsonl) auxiliary captures. This is not a
Claude-style wrapper in the native conversation text.

Grok's full `updates.jsonl` user chunk has no wrapper. Ordinary model-history text uses
`<user_query>\n` + text + `\n</user_query>` (**27 extra bytes**). At 100 KiB the full wrapper
is saved in `prompts/prompt_0.txt`: **102,427 B plain / 102,571 B framed**. `chat_history.jsonl`
and the main fake-model request carry a **99,095 B** excerpt and offload note, including
`…[middle omitted — see the offload note for how to read it]…`. Both frame ends survive, but
the note follows the closing frame. The fake never calls the suggested `read_file`, so the
omitted middle does not reach it via a tool. Title generation sends a separate 8,027 B prefix.
[Grok's detailed report](../grok-acp-1.0.44/results.md#model-history-and-100-kib-offload) and
all three Grok native captures retain the complete spill bytes and the exact note.

Codex `history.jsonl`, OpenCode edit history and Grok `prompt_history.jsonl` are auxiliary
input histories, not receipt proof. For example Grok trims the plain final LF in
`prompt_history.jsonl` (46→45 B) while its native user chunk preserves it (46 B).

## Bounded unbracketed input

The final Codex buffer and both OpenCode key-chunk runs have no native prompt for 200 lines,
16 KiB, or 100 KiB, plain or framed. For 100 KiB the observed send-to-drain windows were
**512.1/512.8 s** (Codex), **539.2/538.0 s** (stable OpenCode), **538.1/538.4 s** (beta);
the tail was not visible, and two later Enter attempts still produced no prompt. These are
bounded input-consumption observations, not persisted truncation or matcher failures.

Grok's final key-chunk run reaches the 100 KiB tail after **196.2/249.6 s**, then records
the complete 102,400/102,544 B chunks, one record each. An earlier short window missed these.
**POD-5011 — Long terminal input drain** is a top-level Proposed discovery for the actual
Podium PTY path and pacing/submission policy; it is unclaimed and linked `discovered-from`
POD-4984. The complete accepted storage forms are established here by bracketed paste and
protocol input, with startup prompts labelled separately.

## Reading the evidence

`native-records.jsonl` retains selected **native record objects and exact decoded text**, their original file
line or SQLite rowid, all decoded text bytes, and the source table/path. Auxiliary input
history, Grok's model history, and offloaded prompt files are distinguished from prompt proof.
`model-requests.jsonl` retains the fake's full non-system input, without truncating long user
messages. `protocol.jsonl` retains protocol inputs and replies. `summary.jsonl` gives exact
UTF-8 sizes, hashes, storage changes, frame-id survival, and the current text-rule comparison.
Raw JSON strings are escaped for JSONL; byte counts always refer to **decoded UTF-8 text**.

`results.md` in each directory is generated by [summarize.ts](summarize.ts). It compares the
native prompt text, not the auxiliary input history or a displayed paste placeholder. The
“text rule” column mirrors the current matcher source; it is not a full delivery-pipeline test.
The model column compares full decoded user bodies across captured requests, including
auxiliary title requests; a positive does not prove the main conversation call carried them.
The older `observations.modelReceivedBody` is a prefix check on JSON-escaped messages; use
`summary.jsonl`'s decoded full-body comparison instead.

Reproduce with the pinned CLI versions installed:

```sh
bun docs/measurements/pod-4834-receipt-proof/expanded-input/measure.ts codex-app-server
MEASURE_FAKE_PORT=50020 MEASURE_APP_PORT=50021 bun docs/measurements/pod-4834-receipt-proof/expanded-input/measure.ts opencode-terminal
bun docs/measurements/pod-4834-receipt-proof/expanded-input/summarize.ts codex-app-server opencode-terminal
```

The other protocol lane names are `opencode-v1`, `opencode-v2`, `opencode2-v2`, `grok-acp`.
The other terminal lane names are `codex-terminal`, `grok-terminal`, `opencode2-terminal`;
`*-terminal-paced` selects only bounded unbracketed typing, and `codex-terminal-raw` selects
the unbracketed buffer stream. Use unused ports; the rig refuses to take over a listener.
`*-terminal-initial` selects the separate startup-prompt probes.
Run [capture-auxiliary.ts](capture-auxiliary.ts) with OpenCode terminal lane names to copy
their persisted edit histories before deleting scratch HOMEs.

## Reader follow-ups

- **POD-5003 — Codex terminal text matching.** CRLF becomes one or two LFs and a key-chunk
  tab case drops tabs. The current trim-only rule misses these forms; stored frames survive.
- **POD-5004 — OpenCode terminal text matching.** Both builds normalize CRLF and key-input
  tabs disappear; ending-space tolerance alone does not cover these changes.
- **POD-5005 — Grok terminal text matching.** Pasted tabs become four spaces each; unbracketed
  tabs can disappear and CRLF becomes LF. The current Grok matcher only trims.

These are unclaimed sub-issues under POD-4819. The API cases preserve text and ids and need
no reader change from this corpus. Grok's long-input offload is recorded separately above;
proof must keep using the full `updates.jsonl` chunk, not its model-history excerpt.

## Validation and landing

The evidence is from the real CLIs and a fake model, not hand-constructed reader fixtures.
No production code or tests change, so the runtime test gate is skipped for this docs-only
deliverable. The failing-test/fix/armed sequence belongs to the separate reader issues.
The branch is based on `dev/mw`; POD-4720 receives the tip for coordinated ff-only landing
after the operator approves. This lane does not land or push `dev/mw`, `main`, or `origin`.
