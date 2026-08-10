# Disposable server-transfer acceptance

This opt-in lane proves a server handoff between two fresh Linux containers. Source and target have separate named state and agent-home volumes, share only a private Docker network and a fixture coordination volume, and never mount the operator's Podium state. The short-lived pairing code never leaves that disposable volume.

Run it from a dependency-complete checkout:

```bash
PODIUM_DOCKER_TRANSFER=1 bun run test:acceptance:server-transfer
```

The lane runs three fresh Compose projects:

1. a committed transfer starting with a live deterministic Codex-kind agent and durable shell, with public/database and shell writes injected while the initial snapshot upload is held; it proves both sessions and all writes import on the target, target health, source daemon reconnection, and a pre-existing `SocketHub` client that reattaches to the still-active shell and executes input after cutover;
2. a pre-commit abort caused by the acceptance proxy replacing the target validation digest, proving source writability resumes, target staging is removed, and both the active agent and shell remain usable after fence release;
3. a promoted target whose commit reply is dropped by the acceptance-only daemon WebSocket proxy, proving the source first records `commit-uncertain` and remains write-fenced, then reconciles the target proof on retry, demotes and reconnects the source, retires the promoted target daemon, and preserves both live sessions.

The source and target supervisors publish process/config/journal summaries into the coordination volume so assertions do not cross-mount either machine's state. A test-only `codex` executable runs the repository's keyecho fake-agent jig; no real agent CLI, credentials, network model call, or LLM quota is used. The command exits successfully with an explicit `SKIP` when opt-in is absent or Docker is unavailable.
