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
them as fixtures immediately (they are your recorded-fixture contract tests). Repo-verified
(reference doc, v1.17.8): `opencode serve --port <N> --hostname <H>`, basic-auth via
`OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`, `GET /doc`, `GET /event` +
`GET /global/event` (SSE), `POST /session/:id/message` (documented as "send and WAIT for
response"), `POST /session/:id/abort`, `GET /session/:id/message`, `GET /global/health`.
**Repo-UNCONFIRMED, web-sourced — these three MUST be pinned from `/doc` before `client.ts`
exists:** `POST /session` (create), `prompt_async`, and the permission reply route
(`POST /session/:id/permissions/:permissionID`, `once/always/reject`).

**Hour-one decision gate (reviewed — do this before any code):** opencode's own model is
one long-lived server, many sessions; our per-session servers would share
`~/.local/share/opencode/opencode.db` across processes, which nothing in the repo verifies
as safe. Probe it: run two `serve` processes against the default data dir, exercise
concurrent sessions, check journal mode/locking behavior. If safe → shared DB (transcript
source unchanged). If not → per-session `XDG_DATA_HOME` isolation AND parameterize the db
path in the opencode transcript source (small rewire; these sessions' history then rides
the driver, not the global discovery scan). Record the verdict + evidence as an issue
comment; the rest of the plan is written for the shared-DB branch and needs only the stated
rewire on the other branch.

## Implementation order

### 1. Process management (daemon-side)
`apps/daemon/src/runtime/opencode-server.ts`:
- Spawn `opencode serve --port <daemon-picked-free-port> --hostname 127.0.0.1` — the
  daemon picks the port (no `--port 0` support documented); readiness = probe
  `GET /global/health` (stdout parsing is opportunistic logging only). Env: managed
  credentials + `OPENCODE_SERVER_PASSWORD=<32-byte random per session>` — **secret in env,
  never argv** (spec §6) — and **strip inherited provider keys** (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, …) from the child env: the reference warns they override stored OAuth.
- Wrap in a systemd user scope: `systemdScopeArgv`/`scopeUnitName` from `packages/pty` are
  pure argv/name builders — reuse directly. But **reclaim is NOT reusable as-is**:
  `reclaimStaleScope`'s liveness guard is abduco-socket-based. Deterministic unit names hit
  the documented "unit already exists → silent fallback into the service cgroup → dies on
  redeploy" failure, so implement an opencode liveness guard (health-probe the journal's
  port/pid) + reuse the pure `scopeReclaimArgvs` on the respawn path. Non-systemd
  platforms: plain detached process (declare the degradation).
- Persist a binding journal entry (port, secret ref, pid, scope unit, opencode session id)
  in the instance state dir so `adopt()` can rebind after a daemon restart; health-probe on
  adopt; `create` vs `adopt` vs `resume` (server restart + `--session`/session-id addressing)
  all land in the driver.
- **Version gate**: read `opencode --version` at driver init; refuse outside the tested
  range with a machine diagnostic. Mirror the codex-hooks PATTERN
  (parse/gate/`CodexHookDiagnostic`-style reporting) but adapt the predicate — opencode is
  at 1.x (the codex gate pins `major === 0` + a minor range; copying it literally rejects
  everything).

### 2. Protocol client (package-side, node-safe)
`packages/agent-runtime/src/drivers/opencode/`:
- `client.ts` — a small typed client for exactly the endpoints you pinned (hand-written
  against the fixtures; do not codegen the whole OpenAPI surface).
- `sse.ts` — the `/event` consumer with reconnect + cursor: opencode events carry enough to
  build a monotonic per-session cursor (session id + event ordinal — pin what `/doc`
  offers; if the stream has no ordinal, maintain one and persist the high-water mark in the
  binding journal so `events(after)` and provenance work across reconnects).
- `map.ts` — protocol events → `RuntimeEvent`s: `message.updated`/`message.part.updated` →
  `item` (reuse `packages/transcript/src/opencode.ts` — `opencodePartToItems`/
  `opencodeRowsToItems` — same item schema, one source of truth); `session.idle`/
  `session.status`/`session.error` → normalized `AgentStateEvent`s through the shared
  reducer; **`permission.updated` on SSE** → PendingInteraction `ask()` (the
  `permission.asked`/`question.asked` names are in-process plugin-hook names, NOT SSE —
  verify hour one whether question asks are visible over SSE at all, and record the
  answer); turn lifecycle → `turn` events; server process exit → `process` events.
  **Child-session filter:** subagent child sessions (`parent_id`) ride the same SSE bus —
  filter/track by session id or child idle events will flip the parent's state (the
  reference prescribes suppress-or-track).
- Receipts: `POST /session/:id/message` is documented as blocking until the turn completes —
  `accepted` must NOT mean "turn finished". Use `prompt_async` if `/doc` confirms it;
  otherwise fire the blocking POST and derive `accepted` from the SSE correlation (first
  `message.updated` carrying your sent message id), with the POST completion feeding the
  `turn` events. Server refuses/busy ⇒ typed `refused`. There is NO `unverified` here — if
  you find yourself wanting it, your mapping is wrong. `interrupt()` = `abort` ⇒ fence on
  the resulting terminal event. `steer` unsupported ⇒ `deliveredAs: 'queue'`.

### 3. Driver assembly + selection
- `apps/daemon/src/runtime/opencode-driver.ts` implementing `RuntimeDriver`, registered in
  the driver registry beside the terminal driver.
- Manifest: flesh out `manifests/opencode.ts` `runtime.server` (from POD-2019's declaration)
  with the real spec; `select(ctx)` returns the server driver **only when the spawn carries
  the explicit opt-in** (per-spawn override field from the spawn frame / a settings flag) —
  default remains terminal.
- Server-side: extend the per-spawn field POD-2021 already added to the spawn frame into a
  driver-id override (don't plumb a second field); a settings flag + CLI flag is enough for
  the operator to test — no UI.

### 4. Contract completeness for the session surface
`state()` (reducer projection incl. observed model), `transcript.history` (the sqlite source
via the existing transcript slice contract), `snapshot()`, `export()` (the session's sqlite
rows + any part files — document exactly what full fidelity requires; bounded scope),
`hibernate` (kill scope, keep session id + journal → resume restarts server), `draft`
(Podium-owned state — trivially supported), `attach()` = Declared client-terminal *declared
but unimplemented* (attach v2 is out of scope; declare with reason), `health()` (pid/scope
memory via the existing attribution).

### 5. Conformance + e2e
- `runConformance(makeOpencodeDriver, { exemptions: [] })` (factory signature per POD-2019)
  — **zero exemptions**; server family
  must not need them. Include the connect-without-secret refusal test (spec §6) — a client
  without the password must be rejected by the server; prove it.
- Recorded-fixture protocol tests: every endpoint/event shape you rely on, replayable
  without a live opencode.
- E2E on the integration branch: spawn an opencode session with the override → from the web
  UI: send/receive renders in chat, state badge tracks working/idle, trigger a permission →
  it appears as a PendingInteraction and answering it (CLI or existing UI path) resumes the
  turn, interrupt works, hibernate → resume works. Script it in the e2e harness
  (`tests/e2e/`) as far as CI allows; document the manual remainder in the issue.

## Precondition recorded from W3's review (durability of runtime events)

`runtimeEvent` is classified stream.live on the argument that a gap is re-readable from
`snapshot()` — but `snapshot()` has no wire representation, so for W5 the argument is
circular. **Before any legacy observation path is retired for server-family sessions, the
runtime event stream needs a durable story**: either an ack + durable queue on the frame
family, or a wire representation for `snapshot()` that the server can request after a gap.
This driver must not rely on the 64-event diagnostic tail as its only recovery. Decide and
implement the minimal variant as part of this item; record the choice as an issue comment.

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
