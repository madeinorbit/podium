# Disposable server-transfer acceptance

This opt-in lane proves server moves between three fresh Linux containers: source, target, and an unrelated observer daemon. Each machine launches one real top-level Podium parent, which owns and reconciles its server and daemon children throughout promotion and source retirement. Every machine has separate named state and agent-home volumes, shares only a private Docker network and a fixture coordination volume, and never mounts the operator's Podium state. There is deliberately no edge proxy: the browser client begins at `source:18787`, the candidate is probed at `target:18787`, and both the client and observer must move directly to that target address.

Run it from a dependency-complete checkout:

```bash
PODIUM_DOCKER_TRANSFER=1 bun run test:acceptance:server-transfer
```

The lane runs the G1-G10 matrix as eleven fresh Compose projects (G4 has two transport variants):

1. **G1 — success:** holds the initial upload while concurrent database and shell writes land, then proves exact configured port, authenticated candidate reachability, imported state, target health, direct observer URL persistence/reconnection, browser-client relocation, source daemon reconnection, and live shell continuity.
2. **G2 — digest drift:** mutates portable state while staging is held and proves the fenced restage retains the original probe before succeeding.
3. **G3 — delayed promotion:** holds the promote request and proves generic operation projection shows `fence` done and `cutover` running without a recovery ask, while the source rejects writes.
4. **G4a — dropped promote reply:** lets promotion happen but drops its reply, then proves `commit-uncertain`, generic recovery, target proof reconciliation, and safe retirement.
5. **G4b — dropped promote request:** drops the first request and proves recovery sends a byte-identical promote object before converging.
6. **G5 — crash after promotion:** kills the source after promote and proves recovery-only boot, target control reconnection, durable commit-before-ack ordering, and generic recovery convergence.
7. **G6 — cancellation:** cancels during staging and proves the operation history, journal, target cleanup, source writability, active agent, and shell all converge safely.
8. **G7 — validation retry:** corrupts only the first validation result, proves a failed move, then succeeds through a new operation linked by `retryOf`.
9. **G8 — source restart mid-stage:** kills the source after accepted bytes, proves writable boot adopts the exact operation and resumes from the target's aggregate `receivedBytes` instead of restarting at zero.
10. **G9 — desktop continuity:** repeats a live move with a pre-existing `SocketHub` client connected directly to the source and proves the relocation frame makes it connect directly to the target, reattach to the same session, and execute input after the backend changes.
11. **G10 — pre-promote reclaim:** injects a one-shot failure after sealing but before promotion, proves the source is writable and cleanup complete, then succeeds through a linked retry.

The source, target, and observer supervisors publish process/config/journal summaries into the coordination volume so assertions do not cross-mount either machine's state. A test-only `codex` executable runs the repository's keyecho fake-agent jig; no real agent CLI, credentials, network model call, or LLM quota is used. The command exits successfully with an explicit `SKIP` when opt-in is absent or Docker is unavailable.
