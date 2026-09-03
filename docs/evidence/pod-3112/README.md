# POD-3112 paired OpenCode proof

Preflight instrument only. Do not run `drive-up.sh`, `restart-daemon.sh`, `run-cell.sh`, `run-batch.sh`, or `drive-down.sh` until the POD-1761 coordinator explicitly releases launch.

The two arms share one exact release pin and differ only at `sessions.create`: `default-headed` omits `runtimeContract` and must bind `generic-pty`; `opencode-server` explicitly requests that driver. Each cell writes a timestamped JSON reading, appends one eight-field TSV row, and is committed immediately by `run-cell.sh`.

For r18 continuity, use `r18-orchestrate.sh start` and commit the admitted A7a evidence only after it returns the checkpoint. The runner is detached with `nohup setsid`, so the checkpoint shell can exit without killing it; after the A7a commit, `r18-orchestrate.sh continue-a7b` releases and waits for A7b.

Never launch `r18-continuity.ts` as a plain background child of a shell that exits at `a7a-ready`: that lifecycle killed the runner before it could consume `a7a-continue`, producing an unscored rig refusal rather than an A7b result.
