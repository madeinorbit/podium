# POD-2019 — Agent-runtime contract package (W1)

> FIRST ACTION in your worktree: `git merge --ff-only issue/1761-agent-runtime` (your branch
> was created off main and lacks the epic docs). Epic plan:
> `docs/plans/pod-1761-agent-runtime-plan.md`. Spec: `docs/2026-08-07-agent-runtime-architecture.html`.

## Objective

`packages/agent-runtime` exists: the complete typed primitive surface (spec §3) as types +
zod wire schemas + a FakeDriver + a driver-parameterized conformance suite — with the
`AgentManifest` runtime axis and a deliberate boundary-manifest amendment. Zero behavior
change anywhere; this is pure foundation that W2–W6 build on.

## Implementation order

### 1. Package scaffold
Mirror an existing small package (`packages/composer` is a good template): `package.json`
(`@podium/agent-runtime`, workspace conventions, test task wired the way other packages do it
so `bun scripts/test.ts --filter @podium/agent-runtime` works), `tsconfig.json`, `README.md`
(one page: what the contract is, pointer to spec §3, core-vs-extended tiers).

### 2. Contract types (`src/`)
Split by primitive group, one file each, `index.ts` barrel:
- `families.ts` — `DriverFamily = 'server' | 'embedded' | 'terminal'`, `DriverId`.
- `session-spec.ts` — `SessionSpec`: harness kind, selection ctx (principal, platform, role),
  workdir, model policy (model, effort, `Declared` subagent-model override), role profile
  (interaction default-answer table ref, permission preset), instruction channel
  (`AgentInstruction[]` — reuse the existing type from `packages/harness/src/instructions.ts`),
  `mcpServers` (Declared transport), env, initial prompt.
- `turns.ts` — `TurnInput` (text, attachments, Declared per-turn overrides), `SendOptions`
  (`origin`, `delivery: 'when-ready' | 'queue' | 'interrupt' | 'steer'`), `TurnReceipt` as a
  discriminated union: `accepted` (turnEpoch, `deliveredAs`), `queued` (position),
  `refused` (typed reason), `unverified` (window, evidence). `AttachmentRef`.
- `events.ts` — `RuntimeEvent` union (`turn | item | state | interaction | process |
  workspace | open-url`) + the causal envelope (`at`, `provenance: 'bootstrap'|'live'|'replay'`,
  `cursor`, `observerGeneration`, `turnEpoch`). Reuse `AgentStateEvent` from
  `packages/harness/src/agent-state/types.ts` for the `state` variant — do NOT invent a
  parallel vocabulary. Cursor type: reuse/alias the `ProviderCursor` shape from the
  reattachment work (see `packages/protocol/src/messages/runtime-state.ts` and
  `docs/reattachment-design.md`) rather than defining a competitor.
- `interactions.ts` — `PendingInteraction` (kinds `permission | question | plan-approval |
  elicitation | login | recovery`; `source: 'protocol'|'sdk-callback'|'hook'|'screen-classifier'`;
  `answerable: 'structured'|'keystroke-emulated'`; `policyVerdict`; `expiresAt`),
  `InteractionAnswer` (per-kind union — W2 owns the payload details; leave payloads as
  named-but-loose types (`PermissionAskPayloadV1` etc. with a `v: 1` field) that W2 tightens).
- `attach.ts` — `AttachRequest`, `AttachEndpoint` (`engine`/`client` + the reserved deferred
  variants as commented-out types), `SessionLease`.
- `binding.ts` — `SessionBinding`, `SessionSnapshot`, `SessionArchive` (opaque-but-versioned:
  `{ harness, formatVersion, resumeRef, files: … }`).
- `capabilities.ts` — `DriverCapabilities` using `Declared<T>` imported from
  `@podium/harness`; a `CORE_PRIMITIVES` / `EXTENDED_PRIMITIVES` const map (the tier table,
  spec §3) that the conformance suite reads.
- `errors.ts` — refusal reasons, `TurnFailedReason = 'rate-limit' | 'auth-expired' |
  'context-overflow' | 'provider-error' | 'timeout' | 'interrupted'`, process event types,
  the `retryable | needs-human | fatal` classification.
- `driver.ts` — `RuntimeDriver` (create/resume/adopt + capabilities) and
  `AgentSessionHandle` exactly as spec §3 sketches (send, stageAttachment, interrupt, answer,
  events, watch, state, transcript.history, draft, attach, lease, configure, usage,
  snapshot, export, hibernate/stop/kill, health).

### 3. Wire schemas (`packages/protocol`)
New `runtime` message family following the existing organization in
`packages/protocol/src/` (look at how `messages/runtime-state.ts` is structured and exported,
and mirror it): `messages/runtime.ts` with zod schemas for the wire-crossing shapes
(receipts, RuntimeEvent envelope, PendingInteraction, ask/answer commands, attach
negotiation). Export through the package index the same way sibling families are. Message
classes per spec: events + interactions durable-synced, attach negotiation command/live-only.
Keep protocol browser-safe: no imports from `@podium/agent-runtime` (protocol defines wire
shapes independently; agent-runtime MAY import protocol, never the reverse — check how
`@podium/harness` vs protocol handle the same tension today and follow it).

### 4. Manifest runtime axis (`packages/harness`)
`AgentManifest` gains `runtime: { server?: Declared<ServerRuntimeSpec>; embedded?:
Declared<EmbeddedRuntimeSpec>; terminal: TerminalRuntimeSpec; select(ctx: SelectionContext):
DriverId }` in `packages/harness/src/manifest.ts`. The exhaustive registry
(`packages/harness/src/registry.ts`) will force every manifest to declare it — that type
error IS the migration checklist:
- all five manifests: `terminal` = a thin reference to existing behavior (no logic move),
  `select` = always the terminal driver id for now (behavior-neutral).
- `manifests/opencode.ts`: `server` = `{ kind: 'http-sse', spawn: ['opencode','serve'],
  auth: 'server-password-env', versionRange: <current tested> }` — declaration only.
- `manifests/codex.ts`: `server` = `{ kind: 'jsonrpc', spawn: ['codex','app-server'],
  transport: 'unix-socket', versionRange: … }` — declaration only.
- claude-code: `embedded` declared with `auth: ['api-key','bedrock','vertex']`;
  grok/cursor: server+embedded `unsupported(reason)`.

### 5. FakeDriver (`test/fake-driver.ts`)
A full in-memory core-contract implementation with scripted behavior (queue a turn, emit
items, raise an interaction, settle) — deterministic, no timers where avoidable. It is the
reference semantics: if a question about contract meaning comes up, answer it here and in a
doc comment.

### 6. Conformance suite (`test/conformance/`)
`runConformance(makeDriver, opts: { exemptions: PermittedFailure[] })` — parameterized, so
W3/W5 reuse it. Properties (spec §3 callout): send accepted/queued/refused/unverified
semantics; interaction asked→answered lifecycle + idempotent answer; interrupt =
fence-request (fence only via provider-confirmed event); snapshot→adopt round-trip; event
causality (cursor monotonic, provenance correct across a simulated restart); a
connect-without-secret refusal stub (skippable, real for server drivers). Plus
`permitted-failures.ts`: the per-family exemption table from the spec (terminal: unverified
sends allowed, classifier interactions at-least-once). Suite green on FakeDriver with zero
exemptions.

### 7. Boundary manifest amendment
`scripts/check-boundaries.ts` / `scripts/architecture-manifest.ts`: add `agent-runtime`
with allowed imports `@podium/harness`, `@podium/pty`, `@podium/transcript`,
`@podium/protocol`; importable by `apps/daemon`. Add a types-only open entrypoint
(`@podium/agent-runtime/metadata`, following the existing `@podium/harness/metadata`
pattern — see `packages/harness/src/metadata.ts` and the `manifest-open-entrypoint` rule)
so `apps/server` can use contract types without the host capability. Record the amendment
in the manifest properly — no allowlist hacks.

## Out of scope
No real driver, no daemon/server wiring, no UI, no behavior change. W2 tightens interaction
payloads; W3 implements the terminal driver; do not start either.

## Acceptance checklist
- [ ] `bun scripts/typecheck.ts` green.
- [ ] `bun scripts/test.ts --filter @podium/agent-runtime` green (conformance on FakeDriver).
- [ ] Boundary lint green with the amendment in the manifest.
- [ ] All five harness manifests compile with the runtime axis; `select()` returns terminal
      everywhere (behavior-neutral).
- [ ] No existing test suite changes required (if one does, you changed behavior — back out).

## Pitfalls
- Browser safety: protocol must not import agent-runtime or node-only harness internals.
- Don't duplicate vocabularies that exist (`AgentStateEvent`, `Declared`, `AgentInstruction`,
  cursor material) — alias/reuse. Divergence here is the epic's biggest long-term cost.
- Keep `TurnReceipt.unverified` — reviewers of the spec fought for it; don't "simplify" it away.
- The registry's exhaustiveness is the tool: make the type error list your checklist rather
  than editing manifests speculatively.
