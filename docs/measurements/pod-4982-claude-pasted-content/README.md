# Claude Code pasted-content recording

Measured 2026-09-30 on the installed native Claude Code **2.1.283** and **2.1.285**
binaries. These are the background-host and CLI versions observed in the affected
live sessions. Both reproduce the same recorded-text grammar.

## Method

[`measure.py`](measure.py) starts each CLI in its own tmux server, at 180×45, with
a scratch work directory, `HOME`, and `CLAUDE_CONFIG_DIR`. The child environment
is a whitelist: no inherited credentials, Podium session, hooks, or real Claude
configuration. Onboarding and directory trust are seeded in the scratch config;
the only API key is `fake-key-for-the-local-fake-server-not-a-credential`.
`ANTHROPIC_BASE_URL` is localhost and the server is the existing
[`fake-model-server.ts`](../pod-4834-receipt-proof/fake-model-server.ts). It returns
fixed answers. Nonessential traffic, auto-update, and retries are disabled. Each
run first refuses an occupied port, and kills its fake **by that port** on exit.

An empty scratch configuration initially produced no wrappers, even for 2,000
characters or ten lines. The installed CLI's paste-tag function is gated by
`tengu_virtual_pancake`, whose fallback is false. To reproduce the enabled form,
the scratch `.claude.json` sets
`cachedGrowthBookFeatures: { "tengu_virtual_pancake": true }`, and the child sets
`CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1`. No live config or credential is
copied. This gate dependency explains why a fresh credential-free measurement
can miss the form present in a live session; it does not measure the gate's
deployment or prevalence.

The JSONL evidence contains the exact input and the actual `user` record written
by Claude, including its UUID and prompt ID. Records are read from the scratch
`projects` directory after Enter. Input methods:

- **Paste:** `tmux paste-buffer -p`, the bracketed-paste boundary Podium uses.
- **Burst:** one `tmux send-keys -l` call without bracketed-paste markers.
- **Paced:** one key at a time, separated by 12 ms; backslash+Enter inserts a
  newline, and a final Enter submits.
- **Mixed:** paced prefix/suffix surrounding one or two bracketed pastes.

Reproduce the main matrix and exact length boundary for either installed version:

```sh
python3 docs/measurements/pod-4982-claude-pasted-content/measure.py 2.1.283 --paste-tags
python3 docs/measurements/pod-4982-claude-pasted-content/measure.py 2.1.283 --paste-tags --boundaries
python3 docs/measurements/pod-4982-claude-pasted-content/measure.py 2.1.285 --paste-tags
python3 docs/measurements/pod-4982-claude-pasted-content/measure.py 2.1.285 --paste-tags --boundaries
```

Omit `--paste-tags` for the disabled control. Each command uses a fresh session;
its paste ID and native item IDs will differ from these captures. The earlier
2.1.285 main run used a two-line 323-character prompt and shorter mixed/frame
cases; the later boundary run contains the wrapped cases used by the receipt
and chat regressions. The `lower-bound` capture tested 499–513 characters before
the 799/800/801 boundary was located.

## Results

| Enabled-gate input | 2.1.283 | 2.1.285 |
| --- | --- | --- |
| Bracketed paste, 799 or 800 ASCII characters | Plain | Plain |
| Bracketed paste, 801 ASCII characters | Wrapped | Wrapped |
| Unbracketed burst, 799 or 800 ASCII characters | Plain | Plain |
| Unbracketed burst, 801 ASCII characters | Wrapped | Wrapped |
| Bracketed paste, 1 or 2 newlines | Plain | Plain |
| Bracketed paste, 3–9 newlines | Wrapped | Wrapped |
| Four-line paste, 323 characters | Wrapped | Wrapped |
| Short unbracketed multiline burst, through 9 newlines | Plain | Plain |
| Paced typing, 1 or 5 newlines | Plain | Plain |
| Paced typing, 1,001 characters | Plain | Plain |
| Typed prefix/suffix around a four-line paste | Only the paste is wrapped | Only the paste is wrapped |
| Two four-line pastes separated by typed words | Two wrappers, same ID | Two wrappers, same ID |

Every captured submit, including bracketed paste, has `promptSource: "typed"`.
That field does not distinguish actual paced keystrokes from a paste.

For a paste that does not end in LF, the exact whole-prompt recorded string is:

```text
\n\n<pasted_content id="247b">\n<original text>\n</pasted_content id="247b">\n
```

Here `\n` denotes one LF byte; `<original text>` is a placeholder, not a literal
tag added by Claude. When the paste already ends in LF, that LF serves as the
separator before the closing tag. No extra separator LF is appended to the body.
An original double trailing LF leaves two LFs before the closing tag. Outer
whitespace inside the paste is retained; the reader already trims outer prompt
whitespace.

Inside a mixed prompt, Claude inserts two LFs before the opening tag and two
after the closing tag. For example, `mixed-inline` on 2.1.283 records:

```text
Please read: \n\n<pasted_content id="247b">\npasted first line\npasted second line\npasted third line\npasted fourth line\n</pasted_content id="247b">\n\n then reply.
```

Literal opening/closing `pasted_content` tags in the submitted text are escaped
as `<\pasted_content …>` and `<\/pasted_content …>`, both inside a wrapper and
in a short unwrapped paste. Restore these **after** recognizing wrappers so a
literal tag example is never recursively interpreted as another wrapper.

The four lowercase hex characters are stable across different texts and repeat
submits **within a CLI session**. Both pastes in a mixed prompt use that same
ID. Fresh sessions produce different IDs: the 2.1.283 captures use `247b` and
`b07d`; the 2.1.285 captures use `79b2`, `81b0`, and `853f`. Native `uuid` and
`promptId` still differ for each submit. The paste ID is not receipt identity.

The reader should decode this complete byte form for prompt text, preserving
the native item ID. Frame confirmation can then inspect the actual closing
frame line; order credit can compare the person's words; the chat can retire
the pending bubble against that native item. Malformed or mismatched tags,
assistant text, and tool-result output are not prompt wrappers.

## Regression evidence

Receipt and chat tests consume `framed-mail`, `multiline-323`, `mixed-inline`,
and `mixed-two-pastes` directly from these measured JSONL records. The adapter
regression checks every enabled-gate captured prompt, including plain controls,
escaped literal tags, whitespace, and repeated IDs. Array and queued-attachment
tests apply these same measured bytes to the record shapes documented in the
earlier POD-4862 lane.

The failing baseline is committed before the fix:

- `4afe37863`: `test:file` with the three regression files and `-t "pasted
  content"` ran 187 adapter cases and ten driver cases on flatblock. The reader
  had 86 failures; the driver had eight failures returning `unverified` instead
  of a receipt naming the native history item. The two foreign-write negative
  controls passed. The submit callbacks' typing-marker, payload, and Enter
  checks passed before the receipt assertions failed: the tests were armed.
- `79f1c1b75`: the chat fixture loader was corrected to use Vite's raw imports,
  with the reader still unchanged. The two chat cases ran and both failed at
  the duplicate-bubble check: one pending bubble remained where zero should.

All test commands run in the foreground over SSH on flatblock, in the single
`~/podium-test-4982` checkout, with its own `.toolchain` and dependency links.
Each candidate is WIP-committed and pushed only to
`ssh://flatblock/home/mgw/podium-timing refs/heads/test-4982` before execution.
No authenticated agent smoke, model instruction-following, or UI browser drive
is needed to establish this reader and reconciliation behavior.

**Green candidate: `2e0d31cf8`.** One unfiltered focused command ran the finished
change and its existing neighboring tests:

```sh
bun run test:file -- \
  packages/harness/src/adapters/claude-code/transcript-pasted-content.test.ts \
  packages/harness/src/adapters/claude-code/transcript.test.ts \
  packages/harness/src/adapters/claude-code/transcript-prompt-entries.test.ts \
  packages/harness/src/adapters/claude-code/transcript-receipts.test.ts \
  packages/harness/src/adapters/claude-code/queued-prompt-turns.test.ts \
  packages/harness/src/driver/families/terminal/runtime.test.ts \
  apps/web/src/features/chat/ChatView.test.tsx
```

| File | Executed tests | Result |
| --- | ---: | --- |
| `transcript-pasted-content.test.ts` | 187 | Green |
| `transcript.test.ts` | 71 | Green |
| `transcript-prompt-entries.test.ts` | 5 | Green |
| `transcript-receipts.test.ts` | 14 | Green |
| `queued-prompt-turns.test.ts` | 12 | Green |
| terminal `runtime.test.ts` | 251 | Green |
| `ChatView.test.tsx` | 35 | Green |

The runner reported two sequential groups, zero failures, seven named files:
**575 focused tests, no skips**. This is a focused result, not the repository
suite or lean gate. The web lane emitted its existing React `act` environment
warnings; the actual assertions all executed and passed. No known baseline red
from POD-4819 occurred in these files.

The fix changes only the shared Claude prompt-text reader. It removes complete
matching envelopes and their inserted separators, then restores escaped literal
tags. String, array, and queued-command prompt entries retain their original
item IDs. Assistant text, tool output, and synthetic-prompt exclusion retain
their existing behavior. The native receipt frame/order rules and chat pairing
need no alternate wrapper-specific implementation.

Landing is through the POD-4720 coordinator, fast-forward only onto `dev/mw`
after operator approval. The issue branch has not been landed; `dev/mw`, `main`,
and `origin` have not been pushed.
