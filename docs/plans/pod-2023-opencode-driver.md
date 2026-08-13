# POD-2023 — Opencode server driver (W5, the epic goal)

> FIRST ACTION in your worktree: `git merge --ff-only issue/1761-agent-runtime` (your branch
> was created off main and lacks the epic docs). Epic plan:
> `docs/plans/pod-1761-agent-runtime-plan.md`. Spec: `docs/2026-08-07-agent-runtime-architecture.html`
> (§2 families, §3 surface, §6 security bullet, §9 phase 3). Prereqs on the integration
> branch before you start: POD-2019 (contract), POD-2020 (interactions), POD-2021 (terminal
> driver + daemon `runtime.*` frames + driver registry).

## Objective

An opencode session that runs as a **server-family** session: `opencode serve` per session
under a systemd scope, driven over its HTTP API + SSE, producing protocol-grade receipts,
PendingInteractions, and causally-enveloped events through the same contract the terminal
driver speaks — switchable per spawn, default unchanged. This is the proof the whole epic
exists for: switching drivers changes a driver id, not a feature.

## Ground truth to establish first (hour one, before writing code)

Run `opencode --version`, `opencode serve --help`, and fetch the OpenAPI doc from a live
server (`GET /doc` per the docs). The repo has an opencode reference at
`docs/agent-harness-reference/opencode.md` and existing integration surface at
`packages/harness/src/manifests/opencode.ts`, `packages/harness/src/opencode/*`,
`packages/transcript/src/opencode.ts` (sqlite mappers), and the `resume-exec` headless path —
read them. Pin the exact endpoint names/shapes you will use from the live `/doc`, and record
them as fixtures immediately (they are your recorded-fixture contract tests). Web-verified
shapes to confirm against `/doc` (names may have drifted): `POST /session`,
`POST /session/:id/message` (+ `prompt_async`), `POST /session/:id/abort`,
`GET /session/:id/message`, `GET /event` (SSE, first event `server.connected`),
`POST /session/:id/permissions/:permissionID` (`once`/`always`/`reject`), server basic-auth
via `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`.

## Implementation order

### 1. Process management (daemon-side)
`apps/daemon/src/runtime/opencode-server.ts`:
- Spawn `opencode serve` with `--port 0`-style ephemeral binding if supported (else pick a
  free port and pass it), loopback only, cwd = session workdir, env: managed credentials +
  `OPENCODE_SERVER_PASSWORD=<32-byte random per session>` — **secret in env, never argv**
  (spec §6). Parse the bound port from stdout/health-probe.
- Wrap in a systemd user scope exactly like abduco masters are wrapped (reuse the
  scope helpers in `packages/pty` — `systemdScopeArgv`/`scopeUnitName` — they are not
  PTY-specific; if they are entangled, extract the scope utility, don't duplicate it).
  Non-systemd platforms: plain detached process (declare the degradation).
- Persist a binding journal entry (port, secret ref, pid, scope unit, opencode session id)
  in the instance state dir so `adopt()` can rebind after a daemon restart; health-probe on
  adopt; `create` vs `adopt` vs `resume` (server restart + `--session`/session-id addressing)
  all land in the driver.
- **Version gate**: read `opencode --version` at driver init; refuse outside the tested
  range with a machine diagnostic (mirror `apps/daemon/src/codex-hooks.ts`'s
  `SUPPORTED_*_MINOR` pattern).

### 2. Protocol client (package-side, node-safe)
`packages/agent-runtime/src/drivers/opencode/`:
- `client.ts` — a small typed client for exactly the endpoints you pinned (hand-written
  against the fixtures; do not codegen the whole OpenAPI surface).
- `sse.ts` — the `/event` consumer with reconnect + cursor: opencode events carry enough to
  build a monotonic per-session cursor (session id + event ordinal — pin what `/doc`
  offers; if the stream has no ordinal, maintain one and persist the high-water mark in the
  binding journal so `events(after)` and provenance work across reconnects).
- `map.ts` — protocol events → `RuntimeEvent`s: message/part updates → `item` (reuse
  `packages/transcript/src/opencode.ts` part mapping where shapes align — same item schema,
  one source of truth); session idle/busy → normalized `AgentStateEvent`s through the shared
  reducer; permission/question asks → PendingInteraction `ask()` (structured source,
  answered via the REST reply); turn lifecycle → `turn` events; server process exit →
  `process` events.
- Receipts: `send()` = `POST message` → protocol ack ⇒ `accepted` (with turnEpoch from your
  turn bookkeeping); server refuses/busy ⇒ typed `refused`; there is NO `unverified` here —
  if you find yourself wanting it, your mapping is wrong. `interrupt()` = `abort` ⇒ fence on
  the resulting terminal event. `steer` unsupported ⇒ `deliveredAs: 'queue'`.

### 3. Driver assembly + selection
- `apps/daemon/src/runtime/opencode-driver.ts` implementing `RuntimeDriver`, registered in
  the driver registry beside the terminal driver.
- Manifest: flesh out `manifests/opencode.ts` `runtime.server` (from POD-2019's declaration)
  with the real spec; `select(ctx)` returns the server driver **only when the spawn carries
  the explicit opt-in** (per-spawn override field from the spawn frame / a settings flag) —
  default remains terminal.
- Server-side: the minimal spawn plumbing so `podium`-side spawns can carry the driver
  override (one field through session-start → spawn frame; do not build UI — a settings
  flag + CLI flag is enough for the operator to test).

### 4. Contract completeness for the session surface
`state()` (reducer projection incl. observed model), `transcript.history` (the sqlite source
via the existing transcript slice contract), `snapshot()`, `export()` (the session's sqlite
rows + any part files — document exactly what full fidelity requires; bounded scope),
`hibernate` (kill scope, keep session id + journal → resume restarts server), `draft`
(Podium-owned state — trivially supported), `attach()` = Declared client-terminal *declared
but unimplemented* (attach v2 is out of scope; declare with reason), `health()` (pid/scope
memory via the existing attribution).

### 5. Conformance + e2e
- `runConformance(opencodeDriver, { exemptions: [] })` — **zero exemptions**; server family
  must not need them. Include the connect-without-secret refusal test (spec §6) — a client
  without the password must be rejected by the server; prove it.
- Recorded-fixture protocol tests: every endpoint/event shape you rely on, replayable
  without a live opencode.
- E2E on the integration branch: spawn an opencode session with the override → from the web
  UI: send/receive renders in chat, state badge tracks working/idle, trigger a permission →
  it appears as a PendingInteraction and answering it (CLI or existing UI path) resumes the
  turn, interrupt works, hibernate → resume works. Script it in the e2e harness
  (`tests/e2e/`) as far as CI allows; document the manual remainder in the issue.

## Out of scope
Attach v2 (client-terminal spawning). Codex (W6). Superagent/headless-thread migration.
Pooling. UI beyond what testing needs. Anthropic-subscription anything (opencode + Anthropic
subscription is ToS-barred; provider keys only — this is recorded in the spec).

## Acceptance checklist
- [ ] Conformance green, zero exemptions, incl. secret-refusal test.
- [ ] E2E flow above demonstrated on the integration branch.
- [ ] Daemon restart mid-session: `adopt()` rebinds via journal, one bootstrap snapshot,
      session continues.
- [ ] Version gate refuses an out-of-range opencode with a diagnostic (unit-tested).
- [ ] Default-path sessions (no override) are byte-identical to before.

## Pitfalls
- Pin shapes from the live `/doc`, not from memory or web docs — community docs of this API
  have drifted (the epic's research flagged exact-name uncertainty on the permission reply
  route).
- Loopback ≠ private: the password check is load-bearing, not decoration (spec §6).
- Don't bypass the W2 aggregate with a driver-local interaction list — protocol asks flow
  through `ask()` so every surface sees them.
- One cursor discipline: SSE reconnect must not replay events as new (provenance `replay`
  exists for a reason).
- If an endpoint you need is missing/broken in the pinned version, file a subissue of
  POD-1761 with the evidence and work around only if the workaround is honest.
