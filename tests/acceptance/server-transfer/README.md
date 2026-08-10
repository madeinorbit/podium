# Disposable server-transfer acceptance

This opt-in lane proves a server handoff between two fresh Linux containers. Source and target have separate named state and agent-home volumes, share only a private Docker network and a fixture coordination volume, and never mount the operator's Podium state. The short-lived pairing code never leaves that disposable volume.

Run it from a dependency-complete checkout:

```bash
PODIUM_DOCKER_TRANSFER=1 bun run test:acceptance:server-transfer
```

The lane runs three fresh Compose projects:

1. a committed transfer with concurrent public/database and active-shell writes completed before the portable copy, both imported on the target, target health, source daemon reconnection, and a pre-existing `SocketHub` client that reattaches to the still-active shell and executes input after cutover;
2. a pre-commit abort caused by the acceptance proxy replacing the target validation digest, proving source writability resumes and target staging is removed;
3. a promoted target whose commit reply is dropped by the acceptance-only daemon WebSocket proxy, proving the source records `commit-uncertain` and remains write-fenced.

The source and target supervisors publish process/config/journal summaries into the coordination volume so assertions do not cross-mount either machine's state. No real agent CLI or LLM is installed or invoked. The command exits successfully with an explicit `SKIP` when opt-in is absent or Docker is unavailable.

The approved design requires the transfer command to receive an exact string confirmation token. The current public contract accepts only literal `true`, so this lane uses that public shape until the coordinator and UI replace the boolean with their shared phrase; the mismatch is tracked with those owners rather than patched in acceptance code.
