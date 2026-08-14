# POD-2114 verification — is the server-driven session's transcript actually back?

Verifier's report on POD-2023's `435f834f8`, run at the POD-1761 epic tip
(`4b48d147f`) on `flatblock`, 2026-08-14. Replacement verifier: the original
session on this issue wedged on a permission-classifier block and could not drain
its mail.

**Verdict: CONFIRMED FIXED, both halves.** One real gap in the fix's own test
coverage, closed here. Two cosmetics remain open.

---

## What was claimed, and what I checked it against

POD-2023 stated the bug was fixed entirely: the missing `sessionResumeRef` relay
(empty transcript) and the single-probe ghost `exited` verdict. The reproduction
to beat is journey C of the POD-2086 test drive (F14): a turn that opencode
answers correctly, a Podium transcript that stays empty for 15+ minutes, and then
an `exited` verdict at 342s against a server still answering `/global/health`
with 200 twenty minutes later.

The box no longer needs the F3 `--version` shim: `opencode --version` answers in
**3.8s** against what is now a **60s** probe budget (`version.ts:155`), at load
24. So the live lanes select themselves in rather than silently skipping.

---

## (a) The transcript — FIXED

### The gap in the existing coverage

`tests/e2e/opencode-server.e2e.test.ts` asserts the reply renders via
`sessions.transcriptFor(sessionId)`. That is **not the path the bug was reported
on**. It is the in-process ring buffer on the session's terminal object
(`session-meta-ops.ts:246` → `terminal.ts:95`), fed by live `transcriptDelta`
frames. It fills whether or not the row ever learned its opencode session id —
which is exactly why that lane stayed green while journey C saw an empty chat.

The reported surface was `sessions.read` (and the web chat's
`sessions.transcriptRead`). Both go through `rpc.readTranscript`, which serves
from the lake mirror or a daemon-resolved harness transcript source, and **both
are keyed on the row's `resume.value`**:

    lake.ts:169     const nativeId = session.resume?.value; if (!nativeId) return undefined
    opencode.ts:257 if (!input.resumeValue) return { readSlice: async () => ({items: [], hasMore: false}) }

With `resume` null the reader falls through to an empty page — the reported
`{items: [], cursor: null, hasMore: false}` for a completed turn.

So I added `tests/e2e/pod-2114-server-transcript-read.e2e.test.ts`, which drives
a real opencode session and asserts the **resume-keyed** read.

### Result

    [pod-2114] resume ref      : {"kind":"opencode-session","value":"ses_ffeacc30effeXjJVwZduF2sdPR"}
    [pod-2114] status/phase    : live idle
    [pod-2114] sessions.read   : {"items":[
                                    {"role":"user","text":"Reply with exactly the word: pong",...},
                                    {"role":"assistant","text":"pong",...}],
                                  "cursor":"WyJvcGVuY29kZTpzZXNfZmZlYWNjMzBlZmZlWGpKVndaZHVGMnNkUFIiLDE3ODY3Mjg2MzM1NDQs...",
                                  "hasMore":false,"truncated":false}
    [pod-2114] transcriptFor   : [user "Reply with exactly the word: pong", assistant "pong"]

`sessions.read` returns the exchange with a real opaque cursor. The row carries
an exact `ses_…` ref, sent by `reportResumeRef` on both launch and adopt
(`opencode-driver.ts:112-133`, called at :231 and :302). Journey C's symptom is
gone on the surface it was reported on.

### A false alarm I ruled out, and it matters

My first run of this lane **failed** — `sessions.read` came back `{items: []}`,
looking exactly like the original bug had survived. It had not. I had copied the
acceptance lane's daemon options, which point `discovery.homeDir` at a fresh
`mkdtemp`. That value becomes `ctx.homeDir`, which `sourceForRead`
(`control/transcripts.ts:47`) hands to `opencodeDbSource`, which derives
`<home>/.local/share/opencode/opencode.db` — while the `opencode serve` the
daemon launches inherits the REAL home and writes its rows there. The reader was
opening a database that did not exist and answering empty for reasons that have
nothing to do with this bug.

I localised it rather than reporting it, by driving the harness source directly
against the real store with the session ids from the failed run:

    ses_ffeb550acffeLgMjJOOjB7EpPk  db opened: true  raw part rows: 4  readSlice items: 2
    ses_ffeb2dde7ffe5Ksl0zorFjCoBp  db opened: true  raw part rows: 4  readSlice items: 2

The source was fine; my lane's home was wrong. Pointing both halves at one home
turns it green. Worth recording because `opencodeDbSource` swallows the miss
(`opencode.ts:41` `catch { return {items: [], hasMore: false} }`) — an empty page
here is indistinguishable from a genuinely empty session, which is precisely how
this class of bug hides.

---

## (b) The ghost `exited` — FIXED, and the pin has teeth

`runtime.ts:757-780`: a suspected death is now corroborated by `DEATH_PROBES = 3`
spaced `DEATH_PROBE_GAP_MS = 2000` apart, and `serverIsGone` returns false the
moment **any** probe succeeds — one success means the socket failed, not the
process.

Passing is not proof the test can fail, so I checked:

| `DEATH_PROBES` | `lease.test.ts` "a slow health probe is not a dead server (POD-2114)" |
|---|---|
| 3 (as landed) | ✓ passes (2665ms) |
| 1 (reverted by hand) | ✗ **fails** — `AssertionError: expected 1 to be greater than 1` |

Reverted immediately; the working tree carries no product change.

---

## Lanes run (live, under `podium lock acquire test:heavy`)

`PODIUM_OPENCODE_LIVE=1`, real `opencode serve`, real model calls.

| lane | result |
|---|---|
| `tests/e2e/opencode-server.e2e.test.ts` | ✓ 1 passed (27.2s test time) |
| `tests/e2e/pod-2114-server-transcript-read.e2e.test.ts` (new) | ✓ 1 passed |
| `tests/e2e/daemon-restart-adoption.e2e.test.ts` | ✓ 2 passed — incl. "rebinds from the journal after a daemon crash and keeps taking turns" (124.9s) |
| `packages/agent-runtime/src/drivers/opencode/lease.test.ts` | ✓ 8 passed |

On "nothing queues forever": the adoption lane keeps taking turns across a daemon
crash, and the acceptance lane shows a parked session **refusing** a send with
`not_running` rather than accepting it into a queue that never drains. The field
symptom was downstream of the false `exited`, and that verdict no longer fires.

---

## Not fixed, and not mine to fix silently

- **`account: "native:claude-code"` on an opencode session** and **`model: null`**
  — the two cosmetics POD-2023 left. Assessed separately; see the issue comment.
- **Unrelated teardown race, discovered here.** Every integration lane that boots
  a server exits non-zero even when all tests pass, on repeated
  `RangeError: Cannot use a closed database` from
  `reapStaleTurns` (`modules/superagent/service.ts:879` →
  `store/superagent.ts:287`) firing after the DB closed. 4 occurrences in the
  adoption run. Nothing to do with this issue; filed separately so a green suite
  stops reporting failure.

---

## Caveat, stated plainly

I verified through the server's own modules in-process (`readToolkit.read`, which
is exactly what the `sessions.read` procedure calls at `queries.ts:85-96`), not
by clicking the web UI of a full detached instance. The journey-C product drive
would have needed the POD-2086 drive worktree, which is another session's
checkout, dirty, and pinned below the fix — re-pointing it was not mine to do.
The read path asserted is the same one the web chat uses; the layer I did not
exercise is the browser rendering it.
