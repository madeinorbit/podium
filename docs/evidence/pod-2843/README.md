# POD-2843 rig — restart one half, then type at the session that came back

Isolated instance `p2843` (state `/tmp/pod-2843`, ports 19877/46877/46878,
loopback only), server and daemon split and detached. Re-cut from
`docs/evidence/pod-2773/`, which is POD-2245's recipe. The split is the point:
"restart the server" and "restart the daemon" are different experiments and a
single in-process pair cannot be half-restarted.

```
bash docs/evidence/pod-2843/drive-up.sh            # bring the pair up
bun  docs/evidence/pod-2843/drive-warm.ts          # REQUIRED before any arm
bun  docs/evidence/pod-2843/drive.ts server        # | daemon | none
bash docs/evidence/pod-2843/drive-forge.sh server  # the reported bug, from the rig
bash docs/evidence/pod-2843/drive-down.sh
```

**Run the warm-up, and do not skip it because the last run was fine.**
`claude-code` puts modal gates in front of a first-run agent home — the
folder-trust dialog before a session's first turn, and `/auto-mode-setup` after
it — and each one swallows typed text while writing no transcript turn and
leaving the session reporting `idle`. That is an exact forgery of the bug this
rig measures. `drive-up.sh` seeds both away; `drive-warm.ts` is the check that
the seeding worked, and it puts three sends through one session because the
second gate only appears after the first turn.

`drive.ts` reads arrival twice — from the CLI's own JSONL on disk and from
`sessions.read` — and reads `attempts` out of the server's sqlite, because
"the CLI never got it", "the server cannot see it" and "the drain gave up"
are three different findings that look identical from one reading.

Findings: `docs/agents/evidence/pod-2843-reattach-send.md`.
