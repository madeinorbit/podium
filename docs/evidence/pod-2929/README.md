# POD-2929 scorer refresh

This evidence refresh covers only the tightened A1c delayed terminal-outcome
clause and the tightened A9 stamped-PID rebound clause. The issue branch was
rebased onto epic tip `b3343f39a68e97f5f2c22072db8c2858fa916722` before the
readings; the scorer contracts and deterministic negative controls were already
present at that tip, so this issue adds readings and ledger rows without
touching product runtime.

## Rig and admission

The product was run from a detached, clean checkout at
`/tmp/pod-2929-product`, exactly at the required tip. The named instance was
`p2929y`, with server `3558500`, daemon `3558556`, loopback port `19857`, and
served bundle source `b3343f3`. `drive-verify.sh` passed immediately before
each probe. The instance marker was
`6cc1555d-e373-4c9c-a279-fe5fdbe9fcff` from
`/home/mgw/.local/state/podium/p2929y/instance.json`.

The first fresh root (`p2929x`) was archived after the product state-root
preflight created only an empty `runtime/tmux` directory and the claim guard
refused it. The `p2929y` retry used the runtime-documented adoption flag only
for that product-created preflight directory; no path override was set and no
pre-existing process or state was adopted. The rig-owning shell stayed alive so
the host runner could not reap the detached server and daemon.

## Readings

| Cell | Harness/arm | Verdict | Evidence |
|---|---|---|---|
| A1c | OpenCode / headless | FAIL | Exact stamped child `3567561` was killed; the dead-session send returned `queued`, but no typed refusal, resume offer, or assistant nonce arrived through the 120-second delayed window. |
| A9 | OpenCode / headless | PASS | Exact original identity `3573310:21418524` was gone at 15s and 300s; stamped rebounds were zero at both checkpoints and infrastructure stayed 2/2. |
| A1c | Codex / requested headless | BLOCKED | The requested arm bound `generic-pty` / terminal because Codex `0.150.1` was unsupported by the pinned daemon; the alive positive control did not fire, so no dead child was guessed or killed. |

The Codex refusal is retained as an admission result, not a product verdict.
No Grok probe was started while POD-2980 remains unresolved. Existing OpenCode
A9 fix evidence at `fb67ef2…` was superseded for this current-tip reading;
the older typed-refusal A1c row is not reused because this run exercised the
accepted-then-lost branch.

The append-only rows are at the end of
`docs/plans/pod-1761-results.tsv`. All three reading files record the exact
server, daemon, web, instance, session, process, and scorer-control facts.
The final focused gate for this issue is the deterministic scorer-control
script:

```text
PODIUM_TEST_WORKERS=1 /home/mgw/.bun/bin/bun --conditions=@podium/source docs/evidence/pod-2777/scorer-controls.ts
```

## Current-tip refresh (2026-08-28)

The branch was rebased onto exact epic tip
`2e1648ca89e7f28fe42d6d62aeb2b0ad224cfd42` before this refresh. The earlier
`b3343f39a…` rows remain historical; this section records new current-tip
admission and scorer outcomes.

### A1c — OpenCode headless

The exact stamped child `3997579` was killed and confirmed gone. The dead-session
send returned `ok=true, disposition=delivered`, but no typed refusal, resume
offer, or assistant nonce arrived through the full 120-second delayed window:
the tightened scorer returns **FAIL**. See
`readings/a1c-opencode-2e1648.json`.
### A9 — OpenCode headless

The exact current-daemon UUID and session stamp identified one original
process, `4000972:23195700`. It was gone at both 15 and 300 seconds, with zero
stamped PID rebounds and infrastructure alive `2/2`: the tightened scorer
returns **PASS**. See `readings/a9-opencode-2e1648.json`.

The terminal arm was held at the admission gate when root free space reached
`5228788 KiB`, below the `5242880 KiB` (5 GiB) floor; no terminal process or
unverified result was started.
### A1c — OpenCode terminal arm

The terminal-arm admission gate measured root free space at `5228788 KiB`,
below the `5242880 KiB` 5 GiB floor. It refused before any server, daemon,
named session, positive control, or PID attribution; see
`readings/a1c-terminal-floor-blocked-2e1648.json`.

### A9 — OpenCode terminal arm

The terminal-arm admission gate measured root free space at `5228788 KiB`,
below the `5242880 KiB` 5 GiB floor. It refused before any server, daemon,
named session, positive control, or stamped PID attribution; see
`readings/a9-terminal-floor-blocked-2e1648.json`.

Codex was not re-driven below the same current-tip disk floor, Claude was not
started without credentials in the standard isolated rig, and Grok remains
excluded while POD-2980-D owns its active work. These are remaining admission
gaps, not product-runtime edits.

### A1c — Codex headless arm

The current-tip Codex arm was refused before bring-up at the same disk gate:
root free space was `5228788 KiB`, below the `5242880 KiB` 5 GiB floor. See
`readings/a1c-codex-floor-blocked-2e1648.json`.

### A9 — Codex headless arm

The current-tip Codex A9 arm was refused before bring-up at the same disk
gate: root free space was `5228788 KiB`, below the `5242880 KiB` 5 GiB floor.
See `readings/a9-codex-floor-blocked-2e1648.json`.
## Codex re-drive at current tip c860611 (2026-08-28 14:20-14:29 CEST)

The two stale Codex cells were re-driven after POD-2917 entered review. The
issue branch was clean and pinned to c860611a5d516c7ade492c2df2687cb5efff09d3,
rebased onto exact root 5fe951f2fe5ff3300330d64a3a5b0a4df3a76fe2 before the
runs. The server, scored daemon, and served web bundle each passed
drive-verify.sh at that exact commit. Root had 84,342,624 KiB free at A1c
preflight and 83,806,964 KiB free at A9 preflight, both above the 5,242,880
KiB floor.

The standard bring-up first exposed the machine's default Codex 0.150.1,
which the daemon correctly rejects as outside its exercised 0.147.x-0.149.x
app-server range. The scored daemon for each named instance was restarted
with the already-installed 0.149.1-x86_64-unknown-linux-musl/bin/codex; no
product runtime or path override was changed. The product-derived named roots
were p2929f1 and p2929f9, and no test:heavy lease was acquired or queued.

### A1c - Codex app-server

Reading: readings/a1c-codex-c860611.json. The live positive control fired, the
session bound codex-app-server/server, and exact stamped target PID 693767
under daemon UUID cc8148b2-bce8-4b0c-9277-840987cfbbe4 was killed and confirmed
gone. The dead-session send returned ok=true, disposition=delivered, but
typedRefusal=false, resumeOffer=false, and no assistant nonce arrived in the
full 120-second delayed window. Verdict: FAIL.

Measured clauses were the live control, expected driver/family binding, exact
UUID+session attribution, confirmed target death, accepted-send
classification, and delayed assistant-nonce observation. The failed clause
was the required terminal outcome for an accepted send; the acknowledgment
was not treated as delivery.

### A9 - Codex app-server

Reading: readings/a9-codex-c860611.json. The live control answered ALIVE-QOVAXF;
the session bound codex-app-server/server; and PID 715580 with start time
1218561 carried the exact UUID/session stamp before sessions.kill. Direct
original-PID liveness was zero at both 15s and 300s. The independent
stamped-PID rebound census was also zero at both checkpoints, stamped target
count was zero at both, and infrastructure stayed 2/2. Verdict: PASS.

Measured clauses were the live control, expected driver/family binding, exact
stamp proof, direct original PID+start-time liveness at 15s and 300s,
stamped-PID rebound census at 15s and 300s, and infrastructure preservation.
The aggregate A9 PASS line was used only after every clause was measured; none
was upgraded from did-not-fail to measured.
