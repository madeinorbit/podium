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
