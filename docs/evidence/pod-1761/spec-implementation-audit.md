# Agent Runtime specification implementation audit

Audit date: 2026-08-18  
Worktree tip: `fc2b18085` (`issue/1761-agent-runtime`)  
Specification: [`docs/2026-08-07-agent-runtime-architecture.html`](../../2026-08-07-agent-runtime-architecture.html)  
Implementation plan: [`docs/plans/pod-1761-agent-runtime-plan.md`](../../plans/pod-1761-agent-runtime-plan.md)

## Scope and legend

This is a source audit of the specification against the current worktree. It distinguishes the
target architecture in the specification from the narrower definition of done in the implementation
plan. A point can therefore be missing from this worktree without having been part of the plan's
promised epic cut; it is still missing from the specification.

- **Implemented** — present on the production path, not only as a type, fixture, test fake, or legacy
  feature outside the runtime contract.
- **Partial** — typed, implemented in a driver, or available through a legacy path, but not complete
  end to end as specified.
- **Missing** — no production implementation in this worktree.
- **Deviation** — implemented differently from an explicit specification decision.
- **Deferred by spec** — intentionally excluded by the specification and not counted as a gap.

No runtime tests were run for this audit. The task was read-only code/spec comparison; existing test
files and recorded test evidence were inspected as implementation evidence.

## Executive verdict

The worktree is a substantial pilot, not the complete architecture described by the specification.
It contains a typed contract, protocol schemas, a strong conformance corpus, a flag-gated terminal
adapter, durable PendingInteraction storage and CLI answering, and working opencode, Codex, and Grok
server-family drivers with version gates, protocol fixtures, receipts, journals, and restart adoption.

The central target is not yet true of the product:

1. There is no concrete, unified machine-level `AgentRuntime`; `AgentRuntime` is only an interface.
   The daemon composes separate terminal/opencode/Codex/Grok registries instead.
2. The runtime contract remains a parallel, flag-gated path. Legacy PTY writes, composer scraping,
   separate headless superagent plumbing, and legacy observation frames remain production paths.
3. Runtime events are accepted by the server into a 64-event diagnostic tail, but there is no
   product subscriber. They do not drive the durable client feed, chat streaming, board state,
   workspace state, or open-URL behavior.
4. Most runtime primitives do not cross the daemon wire. Only send, interrupt, answer, lifecycle,
   and snapshot have runtime RPC frames.
5. The embedded family is declared but has no runtime driver. Claude's SDK still lives on the old
   headless subsystem.
6. Attach v2 is not product-reachable. No production code calls a handle's `attach()` method;
   `podium attach` does not exist; Codex declares client attach while its production host cannot
   provide one.
7. The specified cgroup hierarchy, memory budgets, OOM observation, platform-degradation
   capabilities, embedded worker isolation, and cloud supervisor/fleet acceptance test are absent.

The implementation plan explicitly narrows “done” to W1–W5 (plus stretch drivers), so several of
these are outside that plan. They are nevertheless unimplemented specification points.

## Highest-risk deviations

### 1. A core write throws instead of returning a typed refusal

`stageAttachment()` is classified as core, but every concrete production driver throws:

- terminal: `apps/daemon/src/runtime/terminal-driver.ts`
- opencode: `packages/agent-runtime/src/drivers/opencode/runtime.ts`
- Codex: `packages/agent-runtime/src/drivers/codex/runtime.ts`
- Grok ACP: `packages/agent-runtime/src/drivers/grok-acp/runtime.ts`

The conformance corpus does not exercise `stageAttachment()`. This violates both “every write
returns a receipt or typed refusal” and the statement that every core primitive is implemented or
honestly declined.

### 2. The advertised runtime state shape is not the implemented state shape

The spec puts observed model, effort, context percentage, accent color, open todos,
native-subagent facts, and event-time `lastActivityAt` in `handle.state()`. The actual
`AgentRuntimeState` contains phase/need/error/subagent/provenance fields, but not model, effort,
context percentage, accent color, open todos, or `lastActivityAt`. Model/effort/context/accent are
separate `SessionMeta` fields, so G1 was not folded into the runtime primitive as specified.

### 3. Receipt semantics still permit silent loss

Known, code-backed remaining issues are:

- POD-2297: server-driver local queue drains swallow delivery failures.
- POD-2298: a refused receipt does not correct an optimistically delivered chat ledger row.
- POD-2299: dead-lettered chat messages disappear from the chat view.
- POD-2327: an unknown future server driver falls back to PTY injection and discards input.
- POD-2116: the legacy PTY path reports delivery before the native composer is ready.

These contradict the spec's central “receipt, not hope” guarantee.

### 4. “Machine-transparent” is not implemented

The runtime wire family carries send, interrupt, answer, lifecycle, snapshot, interaction-asked,
and event frames. It has no wire commands for create/resume/adopt/list, export/import, health,
transcript history, watch levels, attach/lease, draft, configure, usage/quota, accounts/login,
discovery, inventory, credential export/seeding, or attachment staging. Existing features provide
some of these through older, separate RPCs, which is exactly the split the specification proposed
to remove.

### 5. The rollout order bypassed the specification's gate

Specification phase 4 requires process supervision and memory telemetry before phases 5–7. This
worktree implemented Codex (phase 5) and part of attach v2 (phase 6) without the slice hierarchy,
`MemoryHigh`/`MemoryMax`, OOM events, embedded worker migration, or the telemetry decision gate.

## Section-by-section comparison

## §1 — Problems the architecture must remove or contain

| Specification point | Status | Evidence / deviation |
|---|---|---|
| Send is no longer a heuristic | **Partial** | Contract drivers return receipts, but the flag-off `SessionInbox.typeText()` path remains, and POD-2116 proves its `delivered` result can precede acceptance. |
| Composer read/injection is contained in the driver | **Partial** | Terminal `draft.get()` wraps composer sync; `draft.set()` explicitly refuses. `composer-sync.ts` remains daemon infrastructure rather than private package-driver machinery. |
| PTY-as-API injection surface is contained | **Partial** | Agent-mail rendering strips C0/C1 controls before bracketed paste, but sanitization still lives in the server messages renderer and raw PTY injection remains a public legacy mechanism. |
| Blocking interactions are visible/addressable | **Partial** | Durable aggregate and CLI exist. Web/mobile do not render the aggregate; terminal synthesis observes only the winning normalized state; policy/escalation is incomplete. |
| Headless is the default and attachable | **Partial** | Logged-in Codex/opencode select server drivers by default. Claude remains terminal; embedded is absent; server attach is not product-reachable. |
| Session object replaces process as product identity | **Partial** | True inside server-driver handles; false for the legacy terminal path, legacy headless threads, and product features still coupled to legacy frames. |

## §2 — One contract and three driver families

### Six primitive groups

| Group | Status | Notes |
|---|---|---|
| Lifecycle | **Partial** | Driver create/resume/adopt/stop/hibernate/kill exist. There is no concrete unified runtime, full runtime wire surface, or runtime import/list service. |
| Turns | **Partial** | Send modes, acting principal, receipts, interrupt, and downgrades exist. Attachment staging throws; known receipt/queue loss remains. |
| Interactions | **Partial** | Typed aggregate, protocol-driver asks, durable feed, CLI list/answer, and recovery default exist. Not every blocking ask/failure is materialized; policy, escalation, web/mobile/attached-CLI convergence are absent. |
| Observation | **Partial** | Drivers emit causal events and have watch refcounts. The server stores only a diagnostic tail; no fine-watch control crosses the wire; chat replies complete rather than stream. |
| Attach | **Partial** | Endpoint/lease types and driver methods exist; terminal engine attach describes the old frame path; opencode client-terminal machinery exists. No production caller invokes the primitive. |
| Placement | **Partial** | Existing machine placement remains, but export/import and server-family handoff are not generalized through the runtime. `harnessSupportsHandoff` still admits only Claude and Codex. |

### Driver families and selection matrix

| Harness/family decision | Status | Notes |
|---|---|---|
| Terminal family is permanent fallback | **Implemented** | Every manifest has a terminal runtime; version-gate failure degrades toward terminal. |
| Harness-server family | **Implemented for drivers; partial product integration** | opencode, Codex, and—beyond the spec's initial plan—Grok ACP drivers exist. |
| Embedded family | **Missing** | Claude declares `claude-sdk`, but selection always returns `claude-pty`; no embedded runtime driver/worker host exists. |
| Codex defaults to app-server with ChatGPT auth | **Implemented with correction** | Default selection is server when admitted and logged in. |
| opencode defaults to server | **Implemented with login guard** | Defaults to server when version-admitted and not known logged out. |
| Claude subscription → terminal; API key/Bedrock/Vertex → embedded | **Partial** | Subscription remains terminal, but all other auth modes also remain terminal because embedded is absent. |
| Grok remains terminal pending a later driver | **Deviation / over-implementation** | Grok ACP was implemented and is selected by default when admitted, rather than remaining a deferred feasibility result. |
| Cursor terminal-only | **Implemented** | Manifest has generic terminal only. |
| Re-verify Claude headless subscription behavior | **Partial** | Repository docs establish `claude -p` works with OAuth/setup-token. No evidence establishes the Agent SDK selection promised by the embedded row; the runtime selection was not updated. |

## §3 — Primitive surface

### Governing rules

| Rule | Status | Finding |
|---|---|---|
| Feature-consumed; every family implements or declines | **Not met** | Many primitives are type-only/unwired; `stageAttachment` throws; embedded has no driver; features still bypass the contract. |
| Family-invariant guarantees; fidelity declared | **Partial** | Capabilities and delivered-as reporting are strong. Production attach capability for Codex says supported while the host always refuses. |
| Every write returns receipt or typed refusal | **Not met** | `stageAttachment` throws; several lifecycle methods return `void`; known receipt reconciliation gaps remain. |
| Every read is causally enveloped | **Partial** | Events and snapshots are enveloped. `state()`, `health()`, `interactions()`, usage, draft, and transcript-history results are not individually enveloped. |
| Machine-transparent | **Not met** | Only a subset of primitives has runtime wire commands. |

### Tier boundary and conformance

- **Implemented:** a `RUNTIME_PRIMITIVE_TIER` registry, core/extended derivation, permitted-failure
  tables, fake driver, and shared conformance corpus.
- **Deviation:** the registry admits in its own comment that interface additions are not guaranteed
  to update the hand-maintained primitive union.
- **Missing coverage:** runtime-level `import` and `list`, attachment staging, the complete accounts
  cluster, and product reachability are not conformance-tested. Production Codex attach differs from
  the test fixture because the production host supplies no client terminal.

### Runtime-level primitives

| Primitive | Status |
|---|---|
| spawn/create | **Partial** — separate driver registries, not a unified `AgentRuntime.create()` service |
| resume | **Partial** — concrete drivers implement it; not exposed as the complete runtime service/wire |
| import | **Missing** — interface only |
| adopt | **Partial** — concrete server/terminal paths and journals exist; no unified process-table scan service |
| list actual processes | **Missing** — interface only |
| discover | **Missing from `AgentRuntime`** — legacy manifest discovery remains elsewhere |
| inventory | **Missing from `AgentRuntime`** — legacy inventory remains elsewhere |
| quota / machine usage | **Missing from runtime implementation** — typed declarations; separate existing services remain |
| capabilities | **Partial** — per-driver values exist; no unified runtime endpoint |

### Accounts and login

| Point | Status |
|---|---|
| accounts(harness) | **Type-only** |
| login utility session | **Type-only**; existing accounts/login product is separate |
| logout | **Missing from contract** |
| exportCredential / seedCredential | **Missing from contract**; legacy managed-account propagation is separate |
| principal recorded on binding | **Implemented in types and launch plumbing** |
| auth expiry → login interaction + typed turn failure | **Partial** — failure vocabulary/mappers exist, but runtime-event failures are not consumed to materialize server-driver interactions |

### Identity and lifecycle

| Point | Status |
|---|---|
| Binding/snapshot/archive kept distinct | **Implemented in types and driver APIs** |
| Early resume ref with declared timing | **Implemented** |
| Snapshot state/cursor/interactions/draft | **Implemented per driver, with capability-dependent draft** |
| Portable export → import on another machine | **Not implemented end to end** — exports exist; import service does not |
| Byte-faithful native archive | **Deviation for opencode** — capability explicitly says `byteFaithful: false`; it serializes message trees rather than sqlite bytes |
| Health including OOM facts | **Partial** — alive/memory/scope fields exist; no OOM watcher produces real `oomKilled` events |

### Turns and control

| Point | Status |
|---|---|
| Four delivery modes and honest `deliveredAs` | **Implemented**, subject to known reconciliation/drop bugs |
| Acting principal survives queue/drain | **Implemented** |
| Four receipt outcomes | **Implemented** |
| Hook-anchored Claude terminal acceptance | **Implemented on contract path** |
| Single write path replacing legacy verbs | **Not implemented** — legacy verbs remain and flag-off sessions use them |
| `stageAttachment` | **Missing/violating contract** — throws in every concrete driver |
| Provider-confirmed interrupt fence | **Implemented in drivers/corpus** |
| Idempotent typed answer | **Implemented** |

### Interactions

- **Implemented:** six-kind vocabulary, source/answerability, starting-phase-compatible types,
  durable server table, protocol ingress, typed answers, at-least-once classifier treatment.
- **Partial:** terminal driver capabilities omit elicitation; server drivers expose only protocol
  kinds they observed, which is honest, but the product cannot claim every blocking ask is reified.
- **Missing:** a complete policy engine, superagent triage, deadline escalation, web/Tray/mobile
  aggregate rendering, attached-CLI convergence, and automatic materialization of all server-driver
  needs-human failures.

### Observation and transcript

| Point | Status |
|---|---|
| Causal event envelope | **Implemented in types/drivers** |
| Bootstrap + cursor-fenced live deltas | **Implemented within drivers; partial across server restart/product consumption** |
| Coarse durable-synced stream | **Not implemented as product feed** — server retains only 64 diagnostic events |
| Fine live-only watch driven by viewers | **Missing end to end** — no runtime-watch wire; POD-2293 records chat streaming as unimplemented |
| Poll-free state projection with all specified facts | **Partial** — phase works; G1 fields and `lastActivityAt` are elsewhere/absent |
| Normalized transcript history | **Implemented in drivers** |
| Family-blind downstream transcript | **Partial** — drivers map items, but downstream still uses legacy transcript paths and full-item refreshes |

### Draft, attach, lease, configuration, accounting, title

| Point | Status |
|---|---|
| Terminal draft read/write | **Partial** — read when composer sync is active; write refuses despite existing legacy `draftTarget` machinery |
| Server/embedded Podium-owned draft | **Implemented for server drivers; embedded absent** |
| Attach engine/client endpoint | **Driver-level only**; no production caller or runtime wire command |
| One control lease | **Implemented inside drivers/corpus**; not unified with the existing product terminal-controller path |
| Sticky configure vs one-turn override | **Mostly declined** — all production drivers refuse sticky configure |
| Per-session usage | **Partial** — Codex/opencode support; terminal is context-only; no unified consumer path |
| Title/open-url/accent events | **Partial** — capabilities exist; runtime events are not product-consumed; legacy frames still carry these features |

### Failure semantics and procedures

| Point | Status |
|---|---|
| Refusal / turn failure / process failure vocabularies | **Implemented in types and server-driver mapping** |
| retryable / needs-human / fatal | **Implemented in types/mappers** |
| needs-human always materializes as PendingInteraction | **Not implemented end to end** |
| transport failure stays outside session semantics | **Mostly implemented in driver comments/mapping** |
| generic `interruptAndSend`, `askAndAwait`, `oneShot` procedures | **Missing** — only optional override types exist; no generic procedures module/implementation |
| native procedure overrides | **Missing in production drivers** |

### Coverage proof and containment

The specification's “features consume only the contract” table is not yet true. Chat, board/fleet,
steward, mail, superagent, hibernation, handoff, login/accounts, terminal UI, usage/quota, and history
still consume a mix of old ports, daemon frames, database projections, or headless RPCs. Raw PTY
writes, hook ingest, transcript paths, abduco labels, screen state, and harness config remain visible
outside a private driver boundary.

### Driver interface, protocol churn, and manifests

- **Implemented:** three-family taxonomy, runtime axis, pure selection, version ranges, loud version
  refusal, recorded vendor fixtures, capability negotiation where available, and terminal fallback.
- **Justified deviation:** Codex uses inherited stdio, not the specified 0600 Unix socket. Live probing
  found the Unix socket was a daemon control socket, not the app-server client channel. Stdio is a
  stronger local isolation boundary and the code records the reason.
- **Partial migration:** old `headless`/`exec` axes remain active; they have not folded into runtime.

## §4 — PendingInteraction

| Specification point | Status | Notes |
|---|---|---|
| Durable addressable aggregate | **Implemented** | Store, migration, service, feed projection, list/history, answer lifecycle. |
| Protocol/SDK/hook/classifier sources | **Partial** | Protocol, hook, classifier exist; SDK source has no embedded driver. |
| Per-session policy, then superagent, then human | **Missing except recovery default** | Only the recovery full-resume default is implemented. |
| STARTING-phase recovery asks auto-resolve | **Partial** | Types/corpus/default answer exist; product synthesis and startup routing do not cover every harness path. |
| Enumerable/alertable/escalatable everywhere | **Partial** | Enumerable via CLI/client replica; no deadline escalation worker and no web/mobile aggregate UI. |
| Answer from web/Tray/mobile/attached CLI resolves everywhere | **Missing** | No shell renders `pendingInteractions`; mobile still reads legacy transcript questions. |
| Classifier at-least-once identity | **Implemented** | Source-aware fingerprints and dedupe. |
| Mail blocking tricks collapse into send | **Not complete** | Legacy Grok/terminal and separate mail delivery paths remain. |

## §5 — Observation, control, attach

### Observation plane

- Drivers maintain standing protocol/observer connections and emit causal events.
- Coarse events are not durably projected through the oplog as the session observation feed; only
  PendingInteraction rows are.
- Fine deltas reach driver internals, but there is no viewer→server→daemon watch-level control and no
  client delta feed. POD-2293 explicitly records replies appearing only when complete.

### Control plane

- Receipt-driven send/interrupt/answer exists for flagged/server sessions.
- The legacy write plane remains for unflagged terminal sessions.
- Lease arbitration is local to runtime handles and is not demonstrably the single funnel shared by
  every existing product writer/controller.
- Known queued/refused/dead-letter loss behavior means control is not yet receipt-safe end to end.

### Attach plane

| Point | Status |
|---|---|
| Terminal-family engine attach | **Legacy path exists; runtime primitive not invoked** |
| Server-family on-machine client terminal | **Partial** — opencode host machinery exists; Codex production host does not; no product caller invokes either |
| Same Terminal tab / attach-mode picker | **Missing** — server-family sessions are routed to chat/native-view arbitration instead |
| Warm parking, ~30-minute TTL, pressure-first reclaim | **Implemented as opencode client-terminal infrastructure**, but unreachable without attach invocation |
| Attachment subordinate to session | **Partial** — opencode infrastructure handles lifecycle; no general attach-scope service |
| One lease, takeover/peek | **Driver-level implementation and tests only** |
| `podium attach <ref> [--peek|--takeover]` | **Missing** |
| User-local direct | **Deferred by spec** |
| Embedded TUI handover | **Deferred by spec** |

## §6 — Process topology and reliability

| Specification point | Status | Notes |
|---|---|---|
| One supervisor per machine×instance; daemon evolves in place | **Implemented structurally** |
| One dedicated process tree per session | **Implemented for terminal and server drivers** |
| Embedded SDK worker child | **Missing** |
| Attach process in sibling scope | **Partial** — opencode infrastructure only; general attach path absent |
| opencode loopback secret in env, unauthenticated refusal | **Implemented** |
| Codex 0600 Unix socket | **Justified deviation to stdio** |
| Dedicated-only v1; pooled is declared capability | **Implemented** |
| Explicit instance/session slice hierarchy | **Missing** — transient scopes exist, but not the specified slice tree |
| `MemoryHigh`, `MemoryMax`, `TasksMax`, `OOMPolicy` | **Missing** |
| OOM-kill observation and first-class event | **Type/test-fake only** |
| Daemon restart survival and adoption | **Substantially implemented** — journals, exact identity checks, reattach tests; Codex/Grok adoption resumes into a fresh child rather than rebinding inherited stdio |
| Server restart survival | **Existing reconnect machinery; partial runtime integration** |
| Uninstall-grade absence and later process-table adoption | **Partial** — journals/native stores exist; no concrete runtime `list()`/general scan service |
| Hibernate using settled-turn/open-interaction evidence | **Partial** — lifecycle works; broad auto-hibernation policy is not implemented |
| macOS soft-watermark / Windows durability degradation in capabilities | **Missing** |
| abduco narrowed to terminal engines and client attachments | **Partial** — server engines avoid it; parallel legacy paths still make it broader than the target boundary |

## §7 — Other machines and cloud

| Point | Status |
|---|---|
| Existing enrolled machines become runtime supervisors | **Partial** — daemon hosts drivers, but only a subset of primitives is machine-transparent |
| Attach relays over existing frame path | **Type/infrastructure only for server attach** |
| Server-family handoff extends beyond Claude/Codex | **Missing** — handoff gate still names only Claude/Codex |
| Cloud supervisor image and cloud capability tag | **Missing from this runtime implementation** |
| Closed provider behind `PodiumPlugin` | **Pre-existing/adjacent provider API exists**, but not the specified supervisor image/placement implementation |
| Codex auth seed / Claude API-key cloud matrix | **Not implemented through AgentRuntime accounts/credential primitives** |
| Harness-native external cloud family | **Deferred by spec** |
| 50-executor, one-week acceptance | **Not run / not implemented** |

## §8 — Code architecture

| Location | Status against specified landing |
|---|---|
| `packages/agent-runtime` | **Partial** — contract + terminal helpers + opencode/Codex/Grok drivers exist. Missing Claude embedded driver, concrete machine runtime, procedures implementation, and `supervise/`. |
| `packages/harness` | **Implemented runtime axis and selector**; old headless/exec axes remain active rather than deprecated into runtime. |
| `apps/daemon` | **Partial** — composes separate runtime registries; server journals/adoption exist. `headless-drivers.ts`, `durable-headless.ts`, hook ingest, composer sync, and separate injectors remain. |
| `apps/server` | **Partial** — interactions vertical slice and receipt gateway exist. Runtime event side-effect gate is not the product's single state gate; superagent remains on headless RPC. |
| `packages/protocol` | **Partial** — large runtime family exists, but command coverage is incomplete and RuntimeEvents do not become the durable client observation plane. |
| `packages/client-core` + shells | **Partial** — replica stores PendingInteractions and driver family. Shell interaction UI, attach picker, complete receipt reconciliation, OOM affordance, and fine chat streaming are missing. |
| `apps/cli` | **Partial** — `podium interactions list|answer` exists; `podium attach` and `podium runtime ps` do not. |

## §9 — Migration phases

| Phase | Status |
|---|---|
| 1. Reify interactions | **Partial** — aggregate/CLI/server sources exist; policy, escalation, and shell UI do not; invisibly stuck sessions still exist on uncovered paths. |
| 2. Extract contract and terminal driver; migrate callers | **Partial** — package, terminal adapter, flag, receipt seam, and caller migrations exist. Direct coupling and legacy path remain; flag is not removed. |
| 3. opencode pilot | **Substantially implemented** — headless server, secret, interactions, receipts, interrupt, resume/adopt. Attach/product observation gaps remain. |
| 4. Process supervision | **Mostly missing** — transient scopes and journals exist; slice/budgets/OOM/embedded worker/telemetry gate do not. |
| 5. Codex + superagent | **Partial** — Codex driver exists and defaults when admitted. Superagent did not migrate; old headless files/send paths remain. |
| 6. Attach v2 | **Not shipped end to end** — opencode infrastructure only; no caller/CLI/Codex host; `exclusiveInteractiveResume` was not replaced by a product-wide lease. |
| 7. Cloud supervisor/fleet | **Missing** |

The plan's own “done” definition stops after the opencode pilot and does not promise phases 4–7.
That explains scope, but it does not satisfy the broader specification.

## §10 — Open decisions and recommendations

| Recommendation | Current result |
|---|---|
| Extend Podium protocol; stay ACP-translatable | **Implemented directionally**; Grok ACP proves an adapter is possible. Runtime wire coverage remains incomplete. |
| Server-side single interaction policy | **Partial** — recovery default in server service; no complete policy engine, superagent triage, or daemon fast path. |
| Dedicated v1; pool only after telemetry | **Dedicated implemented; telemetry decision missing**. |
| Claude executor sessions headless-terminal by default | **Partial/unclear as product policy** — terminal sessions use detached durable hosts, but no role-based selection implements the explicit recommendation. |
| Memory defaults: 1.5 GB / 3 GB / 70% | **Missing** |
| Move superagent/steward after pilot | **Not done** — superagent remains parallel; steward is only partially receipt-migrated. |

## Appendix A — Feature inventory audit

This table covers every feature row in the specification appendix. “Legacy” means the feature exists
but does not consume only the Agent Runtime surface, so it is not complete against this spec.

### A.1 Chat and conversation

| Feature | Status against runtime surface |
|---|---|
| Transcript feed | **Partial/legacy** — driver history exists; live client feed still uses legacy completed items |
| Chat send + optimistic bubbles | **Partial** — receipts exist; POD-2298/POD-2299 remain |
| Queued-message ledger | **Partial** — durable queue/receipts exist; server-driver local queue abandonment remains (POD-2297) |
| AskUserQuestion cards | **Legacy UI; aggregate CLI only** |
| Permission prompts | **Aggregate/CLI only; shell UI missing** |
| Activity indicator | **Legacy agent-state projection, not RuntimeEvents** |
| tl;dr / recap | **Legacy transcript reads** |
| Search / minimap / verbosity | **Legacy transcript pipeline** |
| Attribution marks | **Partial** — origin/principal exists; runtime item events are not the client source |
| Machine-context disclosure | **Partial** — attributed instruction type exists; driver support is declined for opencode/Codex and no re-prime consumer exists |
| Image/file paste | **Not through runtime** — existing upload path bypasses core `stageAttachment`, which throws |
| Draft sync | **Partial/legacy** — terminal target write exists outside contract; contract write refuses |
| Todo bridge | **Not represented as specified in `state().openTodos`** |

### A.2 Terminal surface

| Feature | Status against runtime surface |
|---|---|
| Agent panel | **Legacy engine path; server-family client attach not product-wired** |
| Take-control / spectators / presence | **Legacy controller plus separate runtime lease; not unified** |
| Mobile soft keys | **Legacy terminal capabilities** |
| Prompt-mode hint | **Legacy manifest capability** |
| Terminal links | **Legacy frame/cwd path; Runtime workspace events unconsumed** |
| Session titles | **Legacy frame/projection; runtime title signal unconsumed** |
| Echo HUD / startup overlay | **Legacy attach path** |

### A.3 Lifecycle and fleet

| Feature | Status against runtime surface |
|---|---|
| New-panel gating/login warnings | **Existing inventory path, not runtime inventory/capabilities endpoint** |
| Spawn | **Partial** — runtime selection reaches drivers; SessionSpec instructions/MCP are often explicitly unsupported |
| Resume/revival | **Partial** — driver resume works; product retains legacy revival paths |
| Hibernate/reaper | **Partial** — lifecycle reaches drivers; specified health/OOM/event policy absent |
| Cross-machine handoff | **Legacy and limited to Claude/Codex; no runtime import** |
| Cloud runtime move | **Missing** |
| Session cards/board/tray/palette/deck | **Legacy state; POD-2118 records live unbound sessions missing from deck** |
| Model/effort/context readouts | **Deviation** — separate SessionMeta fields, not `state()` runtime facts |
| Concurrency skyline/status | **Legacy state projection** |
| Daemon restart adoption | **Substantially implemented for runtime drivers** |

### A.4 Messaging and steward

| Feature | Status against runtime surface |
|---|---|
| Agent mail | **Partial receipt migration; legacy fallback remains** |
| mail.ask / awaitAgent | **Legacy composition** |
| Ack reminders | **Partial queue seam** |
| Steward triggers/nudges/wake | **Partial receipt seam; legacy methods remain** |
| Auto-continue | **Legacy state/failure path, not uniform RuntimeEvents taxonomy** |
| Push notifications | **Legacy state/interaction projection** |
| Telegram two-way/recap | **Legacy send/transcript paths** |

### A.5 Superagent

| Feature | Status against runtime surface |
|---|---|
| Headless threads | **Not migrated** — separate `headlessTurn*` protocol and durable-headless subsystem remain |
| Tool belt | **Partial legacy ports/receipt seam** |
| Open thread in terminal | **Missing for runtime server threads** |
| MCP callback injection | **Partial** — SessionSpec field exists; opencode declines, Codex only transports config, superagent remains old path |
| Error classification/auth healing | **Partial legacy + typed driver mappings; no universal interaction materialization** |
| Watermark seeding | **Legacy transcript path** |

### A.6 Transcripts, history, search

| Feature | Status against runtime surface |
|---|---|
| Transcript lake/mirror | **Legacy native-file pipeline; not runtime export policy** |
| FTS/omni-search | **Legacy mirror/mappers** |
| Conversation registry/history | **Legacy discovery; `AgentRuntime.discover` is absent** |
| Resume picker | **Legacy discovery/resume** |
| Read toolkit | **Legacy transcript/state paths** |

### A.7 Models, quota, accounts

| Feature | Status against runtime surface |
|---|---|
| Model catalog/spawn validation | **Existing inventory path, not runtime inventory** |
| Model/effort pickers | **Existing product; runtime sticky configure mostly unsupported** |
| Quota panel/CLI | **Existing separate quota RPC; runtime.quota is type-only** |
| Usage analytics | **Existing separate accounting; runtime.usage is type-only** |
| Accounts hub/login | **Existing separate account subsystem; runtime accounts/login utility session not implemented** |
| Credential propagation/pre-seed | **Existing managed-account subsystem; runtime seedCredential absent** |
| Browser-open overlay | **Legacy frames; runtime open-url events unconsumed** |
| Direct vendor API reuse | **Outside session surface as intended** |

### A.8 Issues, workflows, automations

| Feature | Status against runtime surface |
|---|---|
| Issue git state | **Legacy sessionGitActivity path; Runtime workspace events unconsumed** |
| Prime/system pointer/re-prime | **Partial** — instruction type/spawn plumbing exists; compaction re-prime behavior is not implemented end to end |
| Execution-profile verification | **Partial** — driver id is projected, but transient and separately wired |
| Scheduled automations | **Partial receipt queue migration; spawn remains mixed** |
| @-path autocomplete | **Legacy session cwd/workspace state** |
| Advisory-lock auto-release | **Legacy process/session exit path, not Runtime process events** |

### A.9 One-shots and observability

| Feature | Status against runtime surface |
|---|---|
| One-shot utility turns | **Existing legacy harnessExec; runtime `procedures.oneShot` missing** |
| Perf registry | **Existing separate instrumentation; runtime event timestamps unconsumed** |
| Sounds/haptics | **Legacy state changes** |
| Telemetry counters | **Existing process/session plumbing; Runtime process events unconsumed** |

### A.10 Gap register

| Gap | Result |
|---|---|
| G1 runtime facts | **Not resolved as specified** — facts remain outside `AgentRuntimeState` |
| G2 workspace observation | **Produced on terminal RuntimeEvents, but product consumers remain on legacy frames** |
| G3 instructions/MCP | **Typed and partly plumbed; several drivers explicitly decline and re-prime is absent** |
| G4 machine accounting | **Typed only on `AgentRuntime`; existing product remains separate** |
| G5 attachments/turn overrides | **Overrides implemented; staging throws and uploads bypass runtime** |
| G6 forwarded browser opens | **Runtime event type/terminal production exists; product remains on legacy open-URL frames** |
| G7 one-shot exec | **Procedure type only; legacy harnessExec remains** |

The appendix's deliberately-outside items—offers, approval broker, advisory locks themselves, file
relay/artifacts, specs, and the Podium agent relay—remain correctly outside the harness surface.

## Correctly deferred points (not implementation gaps)

- User-local/direct client terminal attachment.
- Serialized TUI handover for embedded sessions.
- Harness-native cloud/external driver family.
- Server pooling until evidence justifies it.
- Slash-command primitive.

## Known unresolved issue-backed deviations at this tip

The following open subissues directly corroborate specification gaps:

- POD-2116 — legacy live session can accept and discard/concatenate early input.
- POD-2117 — daemon can inherit Claude session-control environment into children; no scrub for
  `CLAUDE_CODE_CHILD_SESSION` / `CLAUDE_CODE_SESSION_ID` exists in this tip.
- POD-2118 — live unbound sessions can be absent from the deck.
- POD-2131 — real opencode attach ordering branch lacks a reachable regression fixture.
- POD-2251 — dispose/reap coverage for server children remains tracked.
- POD-2293 — fine chat streaming is still a specification task, not an implementation.
- POD-2297 — server-driver queued turns can disappear.
- POD-2298 — refused receipts do not repair optimistic delivery state.
- POD-2299 — dead-lettered chat rows are invisible in chat.
- POD-2327 — unknown future server driver ids can discard input through PTY fallback.

Several review-stage fixes are already present in this worktree (server teardown, driver-family view
selection, Codex first-prompt routing, billing-env cleanup); they are not counted above as wholly
missing, though their surviving follow-ups are.

## Bottom line

Against the implementation plan, the branch has met much of W1–W6 and exceeded it with a Grok ACP
driver. Against the specification, the branch is approximately the contract-and-driver foundation:
the inversion is real inside server-driver processes, but not yet across product consumers,
observation, attach, supervision, embedded execution, accounts/accounting, handoff/import, or cloud.
The next architecture milestone should not be another driver. It should make one existing driver
complete end to end: concrete machine runtime, full wire projection, product consumption of causal
events, typed attachment staging/refusal, client interaction UI, and removal of the corresponding
legacy side path.
