# POD-3045 — OpenCode CLI switch echo

**TRANSCRIBED BY THE COORDINATOR FROM POD-3045's MAIL, 2026-08-28 16:42 CEST.** The session
closed and its worktree was freed without landing an evidence directory, so this
is a second-hand record of a first-hand measurement. Every number below is the
session's; none was re-derived by me. Treat it as testimony, not as a reading
you can re-run from this file.

## The fix

`b5a3aa870` — *Park the OpenCode CLI instead of killing it on a view switch.*
Reviewed and fast-forwarded onto `issue/1761-agent-runtime` under the merge
lock. `packages/harness/src/manifests/opencode.ts` declares
`parkOnRelease: true`; codex declares `parkOnRelease: false` beside it.

## The defect is per-harness, NOT a shared server-family path

I asserted a shared path because the diff touches `codex.ts` and `grok.ts`.
It touches them because the declaration is **required** on `ClientTerminalSpec`,
so every harness must answer it — codex and grok answer `false`, which is
today's behaviour, byte-for-byte unchanged. **Only opencode's lifecycle changes.**

The control that settles it is our own: `docs/evidence/pod-3038/README.md`
scores A6b/codex **`CLI still echoes after switching | true, +11109 bytes | PASS`**.
Codex cold-starts its TUI on the same shared path and echoes fine.

## What the defect actually is

**`opencode` 1.18.16 discards stdin part-way through its own startup.** Cold
start under this branch's abduco spawn, one nonce, 12s observation:

| t | echo |
| --- | --- |
| 0ms | yes |
| 300ms | yes |
| 800ms | yes |
| 1200ms | **no** |
| 1500ms | **no** |
| 2000ms | **no** |
| 6000ms | yes |

The shared close/recreate is the **amplifier** — it re-enters that window on
every view switch — not the cause. Hence a per-harness declaration rather than a
change to the shared mechanism.

**Ruled out:** the daemon's attach-readiness discard branch (the cause POD-3046
proposed). An abduco client PTY is up in 40–71ms and echoes bytes written the
instant the spawn returns, so at the probe's 1500ms it is never reached.

**Not measured, not claimed:** whether codex's or grok's TUIs eat early stdin.

## Evidence status — READ THIS BEFORE TRUSTING THE CELL

| arm | status |
| --- | --- |
| failing WITHOUT, at the real boundary | yes — the table above, real `opencode` binary under the product's own abduco spawn |
| passing WITH, at the real boundary | yes — parked and reconnected, same nonce at the same 1500ms echoed, `adopted=true`, 19429 bytes |
| **failing-without / passing-with THROUGH A REAL PODIUM INSTANCE running A6b** | **NO — never done** |

The session was explicit that epic-FAIL vs main-PASS is **not** a substitute:
main has no `opencode-server` driver at all, so that pairing shows the feature
is new-and-broken, not that this commit fixes it. Two different claims; only the
second reviews the patch. It offered the instance drive, I authorised it, and
the issue closed before it ran.

**Therefore the matrix still records A6b/opencode as FAIL at pin `5fe951f2f`,
a PRE-FIX reading.** No PASS has been recorded on the strength of a landed diff.
POD-3050 owns the outstanding verification.

**Scrollback:** unmeasured on both arms, same instrument reason. The session's
structural claim — a parked client is re-adopted and an adopted generation
withholds the `ESC[3J` reset, so the returning viewer keeps its history — is
pinned by a unit test, not by a terminal screen model.

## Residual

POD-3049 (*Cold-start keystrokes vanish*) tracks the first-open case: keystrokes
typed while the terminal is still starting are silently lost on the very first
open. That is the same opencode startup window, unamplified, and it is NOT fixed
by `b5a3aa870`.
