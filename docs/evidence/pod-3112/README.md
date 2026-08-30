# POD-3112 paired OpenCode proof

Preflight instrument only. Do not run `drive-up.sh`, `restart-daemon.sh`, `run-cell.sh`, `run-batch.sh`, or `drive-down.sh` until the POD-1761 coordinator explicitly releases launch.

The two arms share one exact release pin and differ only at `sessions.create`: `default-headed` omits `runtimeContract` and must bind `generic-pty`; `opencode-server` explicitly requests that driver. Each cell writes a timestamped JSON reading, appends one eight-field TSV row, and is committed immediately by `run-cell.sh`.
