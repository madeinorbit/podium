# Deferred places reconciliation — Implementation Plan

**Epic:** POD-2087 · **Spec:** `2026-08-14-update-operations-design.md` §3.6
**Protocol:** `2026-08-14-updater-worker-protocol.md`
**Blocked by:** Update operation choreography.

**Goal:** An update finishes even when part of the fleet is asleep: offline machines
become `deferred` at plan time, the operation completes honestly, and a standing
reconciliation converges any daemon that reconnects behind the current target — no
operation, no click.

**Owns:** `apps/server/src/modules/updates/operation.ts` (plan partition + done copy
inputs), a new `apps/server/src/modules/updates/reconciler.ts`, connection-event wiring
in `relay.ts` / machine directory, tests. Not the panel (it already renders `deferred`
from the contract).

## Context

- Plan computation currently includes only connected, channel-matching, non-supervised
  machines; this issue adds the partition: connected → `machines` step places, offline →
  `deferred: [{ id, name, reason: 'offline' }]`.
- Convergence primitives to reuse: `authorizeMachine` (`service.ts:298-336`) returns an
  explicit outcome; grants flow through the existing wave/grant path; supervised machines
  are excluded (daemon-hardening issue).
- Reconnect signal: the machine directory records handshakes with the build report
  (version, digest) — hook where the server learns a daemon's post-handshake version.
- Decision §9.1 (adopted): stragglers converge to the **current** target without a new
  human decision.

## Tasks

- [ ] **Plan partition** — `planUpdateOperation` splits behind-target machines into
  connected (step places) and offline (`deferred`). The operation reaches `done` when
  core places finish; the done state carries `deferred` so the panel can say "2 machines
  will follow when they reconnect". Table tests: all online, some offline, all offline
  (operation is just server+web), offline machine reconnecting mid-operation (it joins
  the wave if the machines step is still running; otherwise stays deferred).
- [ ] **Standing reconciler** — `reconciler.ts`: on daemon handshake, if the machine's
  reported version differs from its channel's current target, and no exclusive operation
  is active that includes this machine, and the machine is not supervised → grant it,
  **one machine at a time** globally (a queue with concurrency 1 and a small delay
  between grants — this is background convergence, not a wave). Uses `authorizeMachine`;
  respects its refusal outcomes (already-updating, unsupported, not-connected) by
  logging and, where meaningful, recording a machine-visible status.
- [ ] **Loop safety** — a machine that fails convergence N times (reuse the daemon's
  bounded attempts + the server's terminal states) is left alone until the target
  changes or a human applies it manually; the reconciler must never hot-loop a
  rejected/stuck machine (test: rejected machine reconnects → no new grant for the same
  target).
- [ ] **Interplay with operations** — while an update operation is active, the
  reconciler is paused (the operation owns granting); it resumes on terminal states and
  sweeps anyone still behind (this also cleans up after a `failed` operation without
  requiring an immediate retry).
- [ ] **Visibility** — reconciler activity surfaces on the machine row state (the
  existing per-machine update states) — no new UI, but the fleet payload marks
  `convergedBy: 'reconciler'` (additive) so Settings/history can label it later.

## Testing

Pure decision tests (should-reconcile matrix: behind/at-target, supervised, terminal
history, operation active); queue serialization with fake clock; plan partition tables.
Gates: typecheck, focused, `bun run test`, `bun run test:e2e` (grant behavior extended).

## Acceptance

- Drill under test: operation completes with one machine offline (`done` + deferred);
  fake reconnect behind target → exactly one grant → machine converges; second reconnect
  at target → no grant.
- A rejected machine is never re-granted the same target by the reconciler.
