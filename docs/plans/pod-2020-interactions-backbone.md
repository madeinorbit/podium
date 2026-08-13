# POD-2020 — PendingInteraction server backbone (W2)

> FIRST ACTION in your worktree: `git merge --ff-only issue/1761-agent-runtime` (your branch
> was created off main and lacks the epic docs). Epic plan:
> `docs/plans/pod-1761-agent-runtime-plan.md`. Spec: `docs/2026-08-07-agent-runtime-architecture.html`
> (§4 is your section; §3 Interactions for the types). Prereq: POD-2019 landed (types).

## Objective

Every blocking ask an agent makes becomes a durable, addressable, answerable record on the
server — fed from the sources that exist today (Claude hook channel + screen classifier),
answerable through the mechanisms that exist today (native menu digits / composer). This is
the aggregate the opencode driver (W5) will emit into with protocol-grade fidelity. It also
carries this epic's hardest design deliverable: the per-kind payload/answer schemas.

## Implementation order

### 1. Payload/answer schema design (do this first, on paper, in the PR description)
For each kind, one versioned payload + one answer shape, normalizing what all sources can
produce (the schemas land in `packages/protocol`'s runtime family, tightening the loose
`…PayloadV1` types POD-2019 left):
- `permission`: tool name, one-line detail (see `permissionDetail` in
  `packages/harness/src/agent-state/claude-code.ts:176`, feeding `AgentPermissionAsk` in
  `packages/model`), always-allow offered (boolean — raw `permission_suggestions` never
  reach the server today; RESERVE a suggestions field, nothing fills it in this item).
  Answer schema: `allow-once | allow-always | deny` + optional message — **but answering a
  terminal permission by keystroke is deliberately UNSHIPPED and stays that way here**:
  `docs/agents/evidence/pod-707-permission-menu.md` documents that menu ordinals vary per
  ask (deny-by-digit is unsafe) and always-allow must never be pressed programmatically. So
  `answer()` for keystroke-emulated `permission` returns the same typed not-yet-supported
  refusal as `structured` — the schema exists for W5's protocol drivers, where answering is
  safe.
- `question` (AskUserQuestion): questions[] with options, multiSelect, other-index,
  preview-layout flag — reuse the parsing that exists in
  `packages/client-core/src/viewmodels/ask-question.ts` (`parseAskQuestions`,
  `isPreviewLayout`) as the shape reference; do not invent a second schema. Answer: per-question
  choice indices or free text (other).
- `plan-approval`: plan text ref + approve/reject(+feedback).
- `elicitation`: free-form prompt + text answer (rare today; shape for opencode/codex later).
- `login`: url, intent, callback affordance ref. Answer: completed/dismissed.
- `recovery`: prompt text + option set. Answer: chosen option; default table answers
  `full-resume` where offered (spec §4 default).
Every payload carries `v: 1`, `source`, `answerable`, and a **dedupe fingerprint** (kind +
session + stable content hash) — classifier-sourced asks are at-least-once by contract, and
the fingerprint is what keeps the list sane. Two source realities to design around (reviewed):
today's bus signal (`AgentNeed.kind`) only carries `question | permission`, so
plan-approval/elicitation/login/recovery are schema-only until W3/W5 emit them — the
`recovery → full-resume` default stays one function + one unit test with no e2e acceptance;
and POD-2019's `…PayloadV1` placeholder types may not exist yet when you start — depend on
the landed shape, don't assume this plan's sketch.

### 2. The module (house shape)
`apps/server/src/modules/interactions/` mirroring `modules/approvals` (the right template:
`registry / service / queries / trpc` — notify is a single service.ts, not a slice):
- **Store**: the store is drizzle schema-as-code, not hand-numbered migrations — edit
  `apps/server/src/migrations/schema.ts`, run `drizzle-kit generate` (timestamped folder
  under `migrations/drizzle/`, bundled into `drizzle-manifest.generated.ts`; see
  `migrations/index.ts` header). Row = interaction with lifecycle
  `asked → answered | expired | superseded`, fingerprint-unique per session while open.
- **Service**: `ask()` (idempotent on fingerprint — a duplicate classifier ask refreshes,
  never duplicates), `answer()` (idempotent; typed `already-answered`/`expired` errors),
  `expireSweep()` (escalation deadline passes ⇒ marked expired + a notification; NO
  auto-deny — note `NotifyService`'s methods are private/bus-driven, so add one small public
  notify method or a dedicated bus subscription rather than ad-hoc coupling; the sweep timer
  hangs off the existing maintenance/janitor convention, not its own interval),
  `listOpen(session|all)`.
- **Default answer table** (not a policy engine): per-session-role map kind→auto-answer,
  today only `recovery → full-resume`. One function, one test.
- **Events**: asked/answered/expired on the in-process bus + durable-synced through the
  write funnel (`modules/funnel.ts`; `modules/issue-events/feed.ts` is the pattern).
  Durable sync is a CROSS-PACKAGE step, not just a module: new entity kind = a
  `MetadataChange` arm + `MetadataEntityKind` enum entry in
  `packages/protocol/src/messages/sync.ts` (~:211) + a Wire type in `packages/model`
  (additive — older clients drop unknown kinds). And the service must be constructed in the
  composition root and threaded into `AgentRelayDispatchDeps`/`RegistryModules`
  (`apps/server/src/relay.ts`) for the relay arm and tRPC to reach it.

### 3. Sources (observe, don't rewire)
Subscribe where the signals already land in the server:
- The sessions module's state-change seam already receives `needs_user{need}` with kind and
  summary (hook-sourced for Claude, classifier verdicts otherwise) — on transition into
  `needs_user`, `ask()` with the richest payload derivable; on transition out, resolve or
  supersede the open ask (the agent may have been answered at the terminal — that is an
  `answered(source: terminal)` outcome, not an error).
- Do NOT add new daemon channels in this item; W3/W5 will emit protocol-grade asks into the
  same service later. Design `ask()`'s input so a driver can call it with better provenance
  than the bus subscription provides.

### 4. Answering (wrap the machinery that exists)
`answer()` delegates by `answerable` and kind:
- `keystroke-emulated` **question** ⇒ the existing native-menu digit path —
  `deliverAnswerToSession` in `apps/server/src/modules/superagent/answer-delivery.ts` (note
  it hard-gates on `need.kind === 'question'`) → `sessions.answerAskUserQuestion`. Fail
  closed exactly as it does.
- `keystroke-emulated` **permission** ⇒ typed not-yet-supported refusal (see §1 — POD-707).
- `structured` (any kind) ⇒ typed not-yet-supported refusal so W5 has a clean seam.

### 5. Surfaces
- tRPC list/answer procs (for future UI; no UI work in this item).
- Agent relay + CLI: extend the relay allowlist (`modules/issues/relay-dispatch.ts` +
  `relay-gate.ts`) with `interactions.list` / `interactions.answer` scoped like the existing
  narrow `sessions` slice, and add `podium interactions list|answer <id> …` in `apps/cli`
  following an existing subcommand's pattern (`quota-cli.ts` is a small template).

### 6. Tests
- Unit: lifecycle, idempotency, fingerprint dedupe, default-answer table, expiry sweep.
- Characterization: drive the existing AskUserQuestion fixtures (the ask-question viewmodel
  tests have realistic payloads) through ask→answer→menu-digit delegation.
- No UI tests; no e2e beyond what the CLI answer path needs.

## Out of scope
Policy engine / suppression (spec §4 prevention is later). UI rendering. Daemon changes.
Emitting from drivers (W3/W5 do that). Steward/notification behavior changes beyond the one
expiry notification.

## Acceptance checklist
- [ ] A Claude session hitting a permission prompt or AskUserQuestion yields a durable
      PendingInteraction visible via `podium interactions list` (source: `session.stateChanged`
      on the bus — `next.need` carries kind/summary/ask; `session.exited` + needs_user-exit
      drive supersede/resolve).
- [ ] Answering a QUESTION via CLI drives the native menu (delegation proven in a
      characterization test); answering twice returns the typed error; an ask resolved at the
      terminal returns `already-answered`; a PERMISSION answer returns the typed
      not-yet-supported refusal.
- [ ] Typecheck + touched suites green; no existing UI behavior changes.

## Pitfalls
- The terminal can answer asks behind your back — supersede/resolve on `needs_user` exit is
  load-bearing, or the list fills with ghosts.
- Fingerprint too tight (timestamps in the hash) ⇒ duplicates; too loose ⇒ distinct asks
  merged. Hash normalized kind+tool+summary content only.
- Do not let `expiresAt` auto-deny anything — escalation only (spec §4).
- Relay additions are security surface: mirror the gate discipline of the existing narrow
  sessions slice exactly (session-bound capability, never payload-trusted ids).
