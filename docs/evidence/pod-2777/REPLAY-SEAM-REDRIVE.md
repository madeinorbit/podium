# The replay seam, re-driven at the product tip (2026-08-28 21:34 CEST, session E)

Decision 42 left the matrix reading **70/70 driven, 0 confirmed at the current
tip**, and named the re-drive order: *substance-stale first — the cells that read
the replay/streaming code that actually changed in the `dev/mw` integration*.
This is that first block: **`stream` and `interrupt`, on codex and opencode, on
BOTH arms.** Four columns, four fresh cells each side, every control fired.

## The pin, and why it is the tip under test

Every run below verified server, daemon AND web bundle at
`15e5afe79767cf1ae94b67d08d8dcfacf65a9f6f`, before and after.

That is not the product tip the coordinator named (`9c1cc3621`), and it does not
need to be, because **the product bytes are identical**:

```
git diff --stat 9c1cc3621 15e5afe79 -- apps packages scripts   -> empty
git diff --name-only 9c1cc3621 15e5afe79 | xargs -n1 dirname | sort -u
  docs/evidence/pod-2777
  docs/plans
```

Three docs commits and my two rig fixes separate them; nothing under `apps/`,
`packages/` or `scripts/` moved. So these readings are at `9c1cc3621`'s product,
and saying so is cheaper than pretending HEAD never moves on a shared worktree —
which it did, twice, mid-run.

| leg | value |
|---|---|
| server | pid 2477614, spawned at `15e5afe` |
| daemon | pid 2477703, spawned at `15e5afe` |
| web bundle | read back out of `:19847` — built at `15e5afe` |
| host | 18.3 GB available, swap-in 0, load quiet in the later `vmstat` samples |
| codex | **0.149.1, pinned by the rig** — see the blocker below |
| opencode | 1.18.25 |

## THE BLOCKER: on a stock box today, codex headless does not bind at all

This is the finding of the turn and it is not a cell.

At **17:29 today** `~/.local/bin/codex` was repointed to the standalone
**0.150.1**. The app-server driver is exercised against **0.147.x–0.149.x**, so
the version gate refused and every codex session fell back to the terminal
driver:

```
daemon:codex-app-server  codex 0.150.1 is outside the range this driver was
                         exercised against (0.147.x - 0.149.x; fixtures
                         recorded from 0.147.0)
daemon:session           preferred=codex-app-server resolved=generic-pty
```

The gate is **right** to refuse — its own diagnostic explains why, and it is a
good one: codex has renamed app-server approval methods before, and a driver
with a wrong approval method does not error, it hangs on the first tool call.

What matters for the epic is the consequence. **The operator's answer to "is
headless better" is, on their box as it stands, "headless is not running."** A
version gate that silently degrades to the old path is the most expensive kind of
correct behaviour, because the session still works and nothing in the UI says
which driver it got.

`drive.ts` caught it at the binding check and **REFUSED all nine cells** rather
than print a terminal measurement in the headless column — which is exactly the
guard this rig exists for, working on its first real encounter with the failure
it was written against. Those nine `REFUSED` rows are still in
`results/codex.headless.json` under the merge, and they are honest.

I drove the cells by pinning **0.149.1**, which is still on disk at
`~/.codex/packages/standalone/releases/`. I did **not** move the shared
`current` symlink: every live session on this host resolves codex through it.

**A pin that covers the commit and not the harness cannot see this.** Server,
daemon and web bundle were each provably at `fe7c0b4` while the thing actually
under test had been swapped underneath them. `P2777_CODEX_BIN` now pins the
harness binary too, and its default is deliberately **unset** so a stock run keeps
showing the real gate.

## The four cells

| behaviour | codex H | codex T | opencode H | opencode T |
|---|---|---|---|---|
| **streaming deltas arrive** | **PASS** 212 frames | **BLOCKED** 0 frames | **PASS** 62 frames | **BLOCKED** 0 frames |
| **interrupt a running turn** | **PASS** 525 ms | **PASS** 512 ms | **PASS** **9 ms** | **PASS** **28,902 ms** |

Controls fired on all eight. `FINE WATCH ACQUIRED` on both headless arms — the
daemon really moved the driver's fine refcount, so a zero would have meant the
feature and not a viewer that never subscribed.

### `interrupt` is measurable again, and that is itself the finding

A3 has stood at **REFUSED** since it was written, because POD-2885's long-turn
wedge froze exactly the motion its positive control watches, and a probe that
cannot see a turn in flight must not score the interrupt of one. **At this tip
the control fires on all four arms.** The refusal turning into a score is the
evidence that the wedge no longer reaches this path — a check POD-2885's own
drive does not give them, since theirs shows a long turn *completing* and this
shows the planes staying *alive mid-turn* long enough for another observer to see
motion. A fix could satisfy the first and not the second.

### The comparison the PASS/PASS scoring hides

`report.ts` scores opencode's interrupt as **SAME** — both arms PASS. Both arms
did leave `working`, so that is not wrong. It is also not the answer to the
operator's question, and the raw readings say something much stronger:

| opencode · interrupt | headless | terminal |
|---|---|---|
| phase left `working` after | **9 ms** | **28,902 ms** |
| transcript chars at call → at settle | 6,410 → **6,410** | 7,261 → **27,843** |
| new terminal bytes after the call | 0 | **+365,687** |

**The terminal arm kept working for twenty-nine seconds and produced 20,582 more
characters after the interrupt was requested.** The headless arm produced none.
That is not a latency difference, it is the difference between an interrupt that
stops the work and one that asks it to. Codex is at parity (525 vs 512 ms), so
this is opencode-specific — and it is the clearest "headless is better" reading
in the matrix so far, from a cell the summary table calls a tie.

**A verdict is not a measurement.** Two PASSes can differ by three orders of
magnitude, and the column that decides an epic should be read at the numbers.

### What both arms do equally badly

On all four columns: `TRANSCRIPT MARK — no item carries event:'interrupt'`. The
turn stops and nothing in the durable record says a human stopped it. Same on
both drivers, so it is not a headless regression — it is a product gap that a
side-by-side is well placed to state, because neither arm can be held up as the
one that gets it right.

### Why terminal `stream` is BLOCKED and not FAIL

The terminal driver has no preview plane; the probe joined at the tail and saw
`0 frames`. That is the absence of a surface, not a broken one, and BLOCKED is
the honest verdict. It is still the headless arm's win on this row: the operator
gets live deltas on headless and nothing on terminal.

## A rig defect this drive found in itself

**The concurrency guard was refusing the drive that called it.** `drive.ts`
shells out to `drive-verify.sh`, so the drive being gated is the *parent* of the
gate. The guard matched `bun` by executable and cwd, exempted only the rig's own
server and daemon, and the first real invocation detected itself:

```
VERIFY FAILED: a probe is ALREADY driving this rig (pid(s):2434116)
```

`2434116` was the `bun drive.ts codex` that had just asked. The guard had been
mutation-checked against a *standalone* bun probe — which shares no ancestry with
the verifier — so the one call path that matters was never on the test. This
directory's own recurring shape, one more time: the check ran, produced an
answer, and the answer was about something else.

Fixed by **ancestry**, not an argv exemption: walk `$$` up through
`/proc/<pid>/stat`'s ppid and skip any `bun` on that chain. A genuinely
concurrent `drive.ts` is not an ancestor of this verify, so the guard keeps full
force; a `*drive.ts` argv exemption would have excluded the neighbour too, which
is precisely the case to catch. Mutation-checked both directions against the live
rig — child-of-bun passes, an independent bun probe in the repo cwd is still
detected (pid 2446029).

## Two HEAD moves under a running rig

A sibling session sharing this worktree committed `115e28d87` while my rig was
up. Docs-only, so no product byte moved — and `drive-verify.sh` refused anyway,
correctly, because it cannot cheaply know that. The README's rule is **freeze
HEAD for the whole build**; on a *shared* worktree that is not something one
session can do alone. Each move cost a rig cycle (cheap here only because the
vite build was cached).

The rig fixes above were committed *before* each bring-up for exactly this
reason, and the pin was re-verified after the last run rather than assumed.

## What is NOT claimed

- Only `stream` and `interrupt` are fresh. Every other cell remains
  **unconfirmed** per Decision 42; nothing was promoted.
- The codex headless column's other seven cells read `REFUSED` from the
  degraded-binding run, not from a good one.
- One commit, so this is a within-tip A/B and not a before-and-after in time.
  That is the design (the arms are the control against host contamination), but
  it does not become a regression test by being repeated.
