# POD-1761 agent runtime specification gap audit

Audit date: 2026-08-19  
Audited tip: `fdc6d8d1dfe5fa6426c2618ffbc874391cc44d46`  
Audit-time normative specification: `docs/2026-08-07-agent-runtime-architecture.html` at the audited tip<br>
Implementation-plan scope: `docs/plans/pod-1761-agent-runtime-plan.md`

The classifications below preserve the audit-time comparison. The four specification corrections
identified by the audit were resolved in the normative document on 2026-08-19; a fifth policy
amendment (Claude subscription OAuth on the Agent SDK) was added on 2026-08-28. The rulings are
recorded in “Specification amendments and rulings” below.

**Current policy overlay, 2026-08-28 11:44 CEST (does not rewrite the rows):** operator ruling
authorizes the persistent Claude Agent SDK path to use the managed subscription credential under
an explicit rollout acknowledgement, and treats Claude headless as first-class / high-priority.
PTY remains the fallback. Audit-time SA4/LD8 policy language (“subscription → terminal only”,
“embedded rework is a plan non-goal”) is historical. Canonical current text:
[claude-subscription-oauth-policy.md](claude-subscription-oauth-policy.md).

## Method and status counts

This is a source audit of every normative commitment in specification §§1–10 and every feature
family in Appendix A. Code, production composition, protocol schemas, and tests were inspected;
plans, landing mail, and declarations without a production caller were not treated as
implementation. Appendix A is a duplicate coverage proof over the same commitments and is recorded
separately rather than counted twice.

- **IMPLEMENTED** — verified on a production path, or (for an explicit deferral) the implementation
  correctly does not cross the stated boundary.
- **PARTIAL** — one or more layers exist, but the specified end-to-end guarantee does not.
- **MISSING** — no production implementation at this tip.
- **DIVERGED** — implementation contradicts an explicit spec decision; the finding says which side
  should change.

The 66 independently counted commitments below classify as **17 IMPLEMENTED, 25 PARTIAL, 18
MISSING, and 6 DIVERGED**. Of the 49 non-implemented commitments, 11 are explicitly known/decided
scope rather than new work. No runtime test lane was run: this was a read-only code/spec audit, and
the deliverable changes documentation only.

## Executive result

The branch is a substantial driver pilot, not yet the complete runtime architecture. It has a
careful typed contract, terminal/opencode/Codex/Grok drivers, selection and version admission,
causal event schemas, receipt semantics, durable interactions, restart journals, exact-identity
adoption, and a strong conformance corpus. The inversion is real inside server-driver processes.

It is not yet the product's single runtime. `AgentRuntime` explicitly says it is a typed surface
only (`packages/agent-runtime/src/runtime.ts:33-42`), and no production class implements it. Most
primitives do not cross the daemon protocol; runtime events terminate in a bounded in-memory
diagnostic tail; existing product features still consume legacy PTY, transcript, headless, account,
quota, and lifecycle paths. Native-TUI attach has useful opencode machinery, but no usable stream or
product caller. Supervision has transient scopes, not the specified budget hierarchy or OOM loop.

## Ranked gap inventory

Rows are ranked within each theme. Sizes describe the likely implementation effort after design is
settled: **S** (localized), **M** (multi-module), **L** (cross-cutting/product vertical slice).
“Known/decided” means do not file it again from this audit.

### Attach and surfaces

| ID | Status | Rank | Commitment and evidence | Gap / judgment | Size / dependencies |
|---|---|---:|---|---|---|
| AS1 | **PARTIAL** | P0 | §5 requires server-family native TUI attach in the same Terminal surface (`spec:458-497`). Opencode has a client-process host, warm TTL, and viewer bookkeeping (`apps/daemon/src/runtime/opencode-attach.ts:115-193,390-493`). | **Known/decided: the operator is deciding this surface now.** The host comments establish that no terminal output is forwarded and input/resize use incompatible identifiers (`opencode-attach.ts:66-98`); no product code calls `handle.attach()`, no attach negotiation crosses the wire, Codex/Grok production hosts cannot create client terminals, and the runtime lease is not unified with the existing controller. POD-2108 covers the opencode stream/geometry defect, not the full surface. | **L**; depends on AS2, AS3, AS4, CLI2, SEC4. |
| AS2 | **MISSING** | P0 | §5 makes attach negotiation a live-only runtime command and `packages/protocol` is assigned that family (`spec:479,555`). | Protocol explicitly says attach has no runtime frame (`packages/protocol/src/messages/runtime.ts:940-977`). Add endpoint negotiation, viewer registration, detach, geometry/input routing, and attach lifecycle events. | **M**; before AS1/CLI2. |
| AS3 | **PARTIAL** | P0 | §5 requires one control lease shared by runtime writers and human attach (`spec:497`). Lease types and takeover/peek exist (`packages/agent-runtime/src/attach.ts:31-70`), as do driver implementations (`packages/agent-runtime/src/drivers/opencode/runtime.ts:1338-1369`; `codex/runtime.ts:1362-1395`). | The lease is handle-local and no production attach caller proves it arbitrates the existing websocket terminal controller, chat/mail/steward writers, and attached humans through one funnel. POD-2050 covers a holder-principal convention/coverage edge, not unification. | **M**; depends on AS2 and IS10. |
| AS4 | **PARTIAL** | P0 | §5 requires coarse causal events to be always-on and durable-synced for board, recency, notifications, and steward (`spec:441-450`). Drivers emit the causal union (`packages/agent-runtime/src/events.ts:44-109`). | The server keeps only a bounded in-memory diagnostic tail (`apps/server/src/modules/sessions/runtime-gateway.ts:249-276`); downstream durable state is still fed through legacy projections. Build the one side-effect gate and oplog projection promised in §8. | **L**; foundation for AS5, AS9, LD16, XT2. |
| AS5 | **PARTIAL** | P0 | §5 requires fine live-only item deltas while a viewer watches (`spec:446-456`). Driver watch levels/refcounts exist and server drivers emit fine deltas (`packages/agent-runtime/src/capabilities.ts:77-82`). | No viewer→server→daemon watch command or client delta feed exists. **Known/decided:** POD-2293 contains the pending chat-streaming spec and is awaiting approval; do not re-file. Its scope is chat streaming, not the general watch-control plane. | **L**; depends on AS4; POD-2293. |
| AS6 | **DIVERGED** | P1 | §3/G1 specifies observed model, effort, context %, accent, open todos, native-subagent facts, and event-time `lastActivityAt` in `state()` (`spec:273-291,700-704`). | `AgentRuntimeState` has phase/need/error/subagents/provenance only (`packages/model/src/entities/session.ts:169-194`). Model/effort/context/accent instead live on `SessionMetaEntity` (`session.ts:250-336`), while open todos and event-time last activity are absent. **Post-audit ruling:** the durable session projection owns the product-facing facts, open todos, and event-time recency; `handle.state()` remains the runtime verdict and native-subagent state. | **M**; after AS4. |
| AS7 | **PARTIAL** | P1 | §3 requires bootstrap snapshot plus cursor-fenced live deltas and family-blind normalized history (`spec:273-299`). Driver snapshots, cursors, event envelopes, and transcript history are implemented (`packages/agent-runtime/src/driver.ts:39-100`; `events.ts:44-109`). | Product chat/history/board still use legacy transcript/state paths, and the runtime feed is not restart-durable. Complete AS4/AS5, then remove family-specific downstream reads. | **L**; depends on AS4/AS5. |
| AS8 | **PARTIAL** | P1 | §3/G2 requires workspace/cwd/git/ref updates and §3/G3 requires attributed instructions/MCP/re-prime (`spec:281-287,700-707`). `SessionSpec` carries workdir, instruction channels, and MCP (`packages/agent-runtime/src/session-spec.ts:16-31,60-83`); workspace events are typed. | Several drivers honestly decline instruction/MCP support, compaction re-prime has no consumer, and product workspace features remain on legacy frames. | **M**; after AS4. |
| AS9 | **PARTIAL** | P2 | §3 exposes draft, configure, usage, title, open-url, and accent as capability-declared seams (`spec:300-317`). Every driver declares the axes (`packages/agent-runtime/src/capabilities.ts:121-127`); server drafts and some usage/title paths work. | Terminal draft write refuses, sticky configure is declined, and runtime title/open-url/accent events do not drive product consumers. Existing legacy paths are not evidence that the runtime seam is complete. | **M**; after AS4 and the concrete runtime. |
| AS10 | **IMPLEMENTED** | — | §3 requires a causal RuntimeEvent vocabulary with provenance/cursor/fences (`spec:273-291`). | State, item, interaction, turn, process, workspace, and open-url events are typed and emitted with coarse/fine watch levels (`packages/agent-runtime/src/events.ts:44-109`). | — |
| AS11 | **PARTIAL** | P2 | §5 requires warm client attachments, ~30-minute TTL, pressure-first reclaim, and subordination to session lifecycle (`spec:483-485`). | Opencode implements warm parking, TTL, adoption, and viewer release (`apps/daemon/src/runtime/opencode-attach.ts:115-128,390-493`), but the path is unreachable and there is no pressure-first general reaper or multi-driver attach host. | **M**; depends on AS1/LD10. |
| AS12 | **IMPLEMENTED** | — | §5 defers user-local direct attach and serialized embedded-TUI handover (`spec:479-481,487-493`). | **Known/decided:** both remain deferred, matching the spec and plan non-goals. No build issue should be filed unless the operator changes that decision. | — |

### Interaction semantics

| ID | Status | Rank | Commitment and evidence | Gap / judgment | Size / dependencies |
|---|---|---:|---|---|---|
| IS1 | **PARTIAL** | P0 | §§3/5 promise receipt-not-hope: accepted, queued, refused, or terminal-only unverified, with honest delivery downgrade (`spec:251-264,452-456`). Types and driver paths implement the four outcomes (`packages/agent-runtime/src/turns.ts:11-167`). | POD-2297 can lose server-driver queued turns, POD-2298 leaves refused turns optimistically delivered, POD-2299 hides dead letters, and POD-2327 can discard input for an unknown future driver. Together they violate custody, reconciliation, visibility, and conservative admission. | **L** across existing bugs; fix order POD-2327 → POD-2297 → POD-2298 → POD-2299. |
| IS2 | **DIVERGED** | P0 | §3 places `stageAttachment()` in the core write path; every family must implement or return typed refusal (`spec:198-206,251-264`). | Every production driver throws (`apps/daemon/src/runtime/terminal-driver.ts:1334-1341`; `packages/agent-runtime/src/drivers/opencode/runtime.ts:1115-1122`; `codex/runtime.ts:1132-1139`; `grok-acp/runtime.ts:931-936`), and the core capability registry has no staging declaration (`capabilities.ts:104-127`). Change implementations to typed refusal first, then add family-specific staging and conformance. | **S** for honesty, **M** for usable staging; independent first fix. |
| IS3 | **PARTIAL** | P0 | §3 says `send()` is the one write path and replaces `typeText`/`queueText`/`sendTextWhenReady`/`interruptText` for chat, mail, steward, superagent, and auto-continue (`spec:251-264`). | Runtime routing is flag-gated; legacy PTY injection and the parallel headless subsystem remain. POD-2050 covers flag-on production coverage and stale `runtimeContract`, not the final cutover/deletion. | **L**; after IS1 and conformance expansion. |
| IS4 | **MISSING** | P1 | §3 requires every `needs-human` failure to materialize as a PendingInteraction (`spec:319-329`). | Failure/disposition types exist (`packages/agent-runtime/src/errors.ts:21-69`), but there is no universal mapper from driver failure/process paths into durable interactions. Add a server-side materialization gate for login/recovery and future typed reasons. | **M**; depends on IS6/AS4. |
| IS5 | **MISSING** | P1 | §4 requires policy → optional superagent triage → durable human escalation, including `expiresAt` escalation (`spec:410-435`). | `answers.ts` explicitly implements only a recovery default, not a general policy (`apps/server/src/modules/interactions/answers.ts:22-37,51-73`); no deadline worker or superagent triage exists. **Known/decided:** interaction-suppression policy is a plan non-goal, so record but do not re-file from this audit. | **L**; depends on IS6 and superagent migration. |
| IS6 | **PARTIAL** | P1 | §4 says every blocking ask is visible and answerable from web, Tray, mobile, policy, superagent, and attached CLI (`spec:410-435`). | The aggregate is durable and CLI-answerable, but no web/Tray/mobile shell renders `pendingInteractions`, attached CLI is absent, and uncovered prompts can still block invisibly. **Known/decided:** UI redesign is a plan non-goal; the missing minimal aggregate surface remains factual. | **L**; depends on IS4 and product decision. |
| IS7 | **PARTIAL** | P1 | §4 requires protocol/SDK/hook/classifier sources with at-least-once treatment for classifier asks (`spec:410-435`). | Protocol, hook, and classifier paths exist; SDK-sourced interactions do not because the embedded driver is absent. Dedupe/source-aware identity is implemented (`apps/server/src/store/interactions.ts:109-150`; `modules/interactions/service.ts:129-226`). | **M**; blocked by LD9. |
| IS8 | **PARTIAL** | P1 | §4 requires STARTING-phase recovery questions to resolve without deadlock (`spec:424-430`). | The type/corpus and recovery default permit it, but synthesis/startup routing does not cover every family or every failure path (`apps/server/src/modules/interactions/answers.ts:51-73`). | **M**; depends on IS4. |
| IS9 | **IMPLEMENTED** | — | §4 requires a durable addressable aggregate with idempotent answer semantics (`spec:410-435`). | Durable insert/dedupe/list/answer/close exist (`apps/server/src/store/interactions.ts:109-289`), with durable feed projection (`apps/server/src/modules/interactions/feed.ts:60-97`). | — |
| IS10 | **IMPLEMENTED** | — | §3 requires typed interaction kinds, sources, answerability, and idempotent answer outcomes (`spec:266-271`). | Six kinds and source/answer schemas are implemented (`packages/agent-runtime/src/interactions.ts:10-94`); answer delivery is structured when supported and explicitly refused otherwise (`apps/server/src/modules/interactions/service.ts:351-497`). | — |
| IS11 | **IMPLEMENTED** | — | §3 requires provider-confirmed interrupt fences and acting-principal preservation through queues (`spec:251-264`). | The driver contract and shared conformance corpus exercise fences and queued acting-principal preservation (`packages/agent-runtime/src/driver.ts:39-100`; `turns.ts:44-78`). | — |
| IS12 | **MISSING** | P2 | §3 defines generic `interruptAndSend`, `askAndAwait`, and `oneShot` procedures with optional native overrides (`spec:331-342`). | Only override types exist (`packages/agent-runtime/src/driver.ts:113-149`); there is no generic procedures implementation or production override. Existing one-shot/headless helpers bypass the runtime. | **M**; after IS3 and concrete runtime. |
| IS13 | **PARTIAL** | P2 | §§1/3 require PTY injection/scraping containment and mail/steward/auto-continue collapse into `send()` (`spec:127-151,344-363`). | Control sanitization and terminal adapters exist, but composer sync, hook ingest, raw PTY injection, mail, and headless paths remain visible outside the private driver boundary. POD-2041 addresses duplicate interaction synthesis only; it does not provide policy, deadlines, UI, or universal failure materialization. | **L**; after IS1–IS3 and AS4. |

### Lifecycle and durability

| ID | Status | Rank | Commitment and evidence | Gap / judgment | Size / dependencies |
|---|---|---:|---|---|---|
| LD1 | **MISSING** | P0 | §3 requires one concrete per-machine `AgentRuntime` exposing create/resume/import/adopt/list/capabilities/accounting/accounts/login (`spec:208-237`). | `AgentRuntime` states that it is the typed surface only (`packages/agent-runtime/src/runtime.ts:33-42`); production composes separate registries and handles. Implement the machine runtime and make it the only composition root. | **L**; foundation for LD2, CLI3, XT2. |
| LD2 | **MISSING** | P0 | §3 guarantees byte-faithful export → `runtime.import()` → resume on another machine, plus actual-process `runtime.list()` (`spec:208-249`). | Drivers can export and adopt, but `import()` and the process-table `list()` have no concrete implementation (`packages/agent-runtime/src/runtime.ts:44-69`). Build versioned archive landing, collision/refusal rules, and real inventory reconciliation. | **L**; depends on LD1/SEC4; enables XT3. |
| LD3 | **DIVERGED** | P0 | §3 says archive export/import is byte-faithful to native stores, including opencode sqlite (`spec:247`). | Opencode explicitly declares `byteFaithful: false` and exports a reconstructed message tree (`packages/agent-runtime/src/drivers/opencode/capabilities.ts:100-117`). **Post-audit ruling:** semantic import/resume is the universal archive guarantee; exact native-store preservation is capability-declared and required only by backup/restore consumers. OpenCode must not over-export its machine-shared SQLite database. | **M**; before LD2 for opencode. |
| LD4 | **LANDED** (POD-2413) | P0 | §§6/9 require `podium.slice` → instance slice → session scopes with `MemoryHigh`, `MemoryMax`, `TasksMax`, and `OOMPolicy`, and attach scopes reclaimed first (`spec:503-533,566`). | Every scope is now placed in `podium[-<instance>]-sessions.slice` and carries MemoryHigh/MemoryMax/MemorySwapMax/TasksMax with `OOMPolicy=continue`, from the one argv builder all four spawn paths share (`packages/runtime/src/scope.ts`, `packages/pty/src/abduco.ts`); attach scopes are named siblings reclaimed first. `MemorySwapMax` is part of the budget because a live probe showed `MemoryMax` alone is unbounded on a host with swap. Evidence and the two policy traps: [pod-2413-resource-isolation.md](pod-2413-resource-isolation.md). | Done. |
| LD5 | **LANDED** (POD-2413) | P0 | §6 requires real memory/RSS/OOM observation and first-class `oomKilled` events (`spec:503-533`). | One cgroup observer per machine (`apps/daemon/src/runtime/scope-monitor.ts`) feeds every driver host, so `health()` reports the cgroup's own memory, peak, tasks, budget and `oom_kill` counter instead of `oomEvents: 0`; a new kill is stated by the owning driver as `process.oomKilled` and the server correlates it into `stopReason: 'oom'` on the row. Baselining is decided by the cgroup's creation time, so adopted history is not re-announced and a kill seconds after spawn is not swallowed. | Done. |
| LD6 | **PARTIAL** | P1 | §6 requires daemon/server restart survival, exact-identity adoption, and later reconciliation from process/native state (`spec:503-533`). | Opencode uses 0600 journals and exact secret-backed health (`apps/daemon/src/runtime/opencode-server.ts:122-175,553-595`); reaping/adoption corroborates process identity (`apps/daemon/src/runtime/server-reap.ts:166-255,336-437`). Codex's protocol rides Unix but its child remains daemon-lifetime-tethered through stdin; Codex/Grok therefore resume into fresh children, and there is no unified process-table scan/list. | **M**; depends on LD1/LD2. |
| LD7 | **PARTIAL** | P1 | §6 requires one supervisor and a dedicated process tree per session, with transient scopes surviving daemon restarts (`spec:503-533`). | The daemon is the supervisor and terminal/server drivers launch dedicated processes/scopes; the hierarchy, budgets, and full adoption scan are incomplete. | **M**; depends on LD4. |
| LD8 | **MISSING** | P1 | §§2/6/8 require the Claude SDK embedded family in a worker child, selected for API-key/Bedrock/Vertex auth (`spec:170-184,503-533,551`). | The manifest declares `claude-sdk` but always selects `claude-pty` (`packages/harness/src/manifests/claude-code.ts:167-195`); no embedded runtime driver or isolated worker host exists. **Audit-time known/decided:** embedded/Claude-SDK rework is a plan non-goal; do not re-file. **Current policy, 2026-08-28:** that non-goal is superseded — Claude headless is first-class and subscription OAuth on the SDK is allowed; do not treat the old non-goal as a bar. Implementation remains a code lane. | **L**. |
| LD9 | **PARTIAL** | P1 | §3 requires create/resume/adopt/stop/hibernate/kill with early, declared resume-ref timing (`spec:239-249`). | Production drivers implement lifecycle and timing declarations, but they are reached through separate composition and cannot honor unified import/list. | **M** to unify; depends on LD1. |
| LD10 | **PARTIAL** | P1 | §6 requires hibernation based on settled turns/open interactions and more aggressive server-family policy (`spec:503-533`). | Lifecycle calls work and state evidence exists, but the broad policy and memory-pressure path are absent. | **M**; depends on AS4, IS6, LD4/LD5. |
| LD11 | **MISSING** | P2 | §6 requires capability-declared macOS soft watermarks and Windows durability degradation (`spec:532`). | No corresponding runtime capability axes or supervisor policies exist. | **M** per platform; after Linux contract is settled. |
| LD12 | **MISSING** | P1 | §§2/8/9 require old `headless`/`exec` axes, `headless-drivers.ts`, and `durable-headless.ts` to retire as runtime sessions absorb them (`spec:394-408,551-568`). | The legacy axes and superagent subsystem remain active; no deletion boundary has been reached. **Known/decided:** the plan excludes embedded/Claude-SDK rework, so final retirement cannot occur in current scope. | **L**; after LD1, LD8, IS3. |
| LD13 | **DIVERGED** | P1 | §9 gates phases 5–7 on phase 3–4 telemetry and supervision evidence (`spec:560-569`). | Codex and attach infrastructure landed without the specified slice budgets, OOM observation, or telemetry gate. Implementation is useful, but the rollout proof was skipped; amend the phase narrative or satisfy the gate before fleet/cloud claims. | **M** evidence plus LD4/LD5. |
| LD14 | **IMPLEMENTED** | — | §3 keeps binding, observation snapshot, and portable archive distinct and captures resume refs as early as declared (`spec:239-249`). | Separate types and APIs encode the identity triangle and archive format (`packages/agent-runtime/src/binding.ts:19-101`; `packages/agent-runtime/src/capabilities.ts:90-119`). | — |
| LD15 | **IMPLEMENTED** | — | §6 chooses dedicated-only v1 while making pooled placement explicit (`spec:503-533`). | Every current driver declares dedicated placement; the type can expose pooled honestly later (`packages/agent-runtime/src/capabilities.ts:116-119`). | — |

### Selection and admission

| ID | Status | Rank | Commitment and evidence | Gap / judgment | Size / dependencies |
|---|---|---:|---|---|---|
| SA1 | **PARTIAL** | P0 | §§2/3 require one feature-consumed contract in which every family implements or honestly declines every core primitive (`spec:153-177,192-206`). | The interface/capabilities are strong, but there is no concrete runtime, embedded driver, product-wide consumption, or typed attachment-staging refusal. | **L**; umbrella outcome of LD1, IS2, IS3, AS4. |
| SA2 | **PARTIAL** | P0 | §3 requires a shared conformance corpus to pin every core primitive and permitted failure (`spec:206,382-391`). | The corpus covers send, interactions, interrupt, snapshots/adoption, causality, secrets, and leases, but omits `stageAttachment`, runtime `import/list`, production reachability, and the production Codex attach-host mismatch. | **M**; add cases alongside each P0 fix. |
| SA3 | **PARTIAL** | P1 | §3 runtime primitives include discover, inventory, capabilities, quota/usage, accounts/login/logout, and credential export/seed (`spec:208-237`). | `AgentRuntime` includes capabilities/quota/usage/accounts/login but omits discover, inventory, logout, exportCredential, and seedCredential (`packages/agent-runtime/src/runtime.ts:44-98`); none has a unified production implementation. Existing separate services are migration inputs, not completion. | **L**; after LD1. |
| SA4 | **PARTIAL** | P1 | §2 selects Claude terminal for subscription and embedded for API-key/Bedrock/Vertex (`spec:179-190`). | Claude always selects terminal (`packages/harness/src/manifests/claude-code.ts:167-195`). Audit-time: the subscription half is “correct” only under the old terminal-only policy; the embedded half is absent. **Current policy, 2026-08-28:** subscription may also select embedded; PTY is the fallback. The selection/auth gap is now a product defect relative to current spec, not a decided exclusion. | **L**; LD8. |
| SA5 | **DIVERGED** | P2 | §2 initial matrix leaves Grok terminal pending feasibility (`spec:179-190`). | Grok ACP is implemented and default-selected when admitted (`packages/harness/src/manifests/grok.ts:202-223`). Implementation is the better current state. **Corrected post-audit in the normative matrix.** | **S** docs. |
| SA6 | **IMPLEMENTED** | — | §2 defines permanent terminal, harness-server, and embedded families with runtime selection context (`spec:153-190`). | The runtime axis, family/id schemas, and pure selection context exist (`packages/harness/src/manifest.ts:506-600,710-731`). Embedded is separately classified missing under LD8. | — |
| SA7 | **IMPLEMENTED** | — | §2 requires Codex app-server by default when admitted/authenticated (`spec:179-190`). | Codex manifest selects app-server by default and records its protocol gate (`packages/harness/src/manifests/codex.ts:319-363`). | — |
| SA8 | **IMPLEMENTED** | — | §2 requires opencode server by default when admitted (`spec:179-190`). | Opencode selects its server when version-admitted and not known logged out (`packages/harness/src/manifests/opencode.ts:162-196`). | — |
| SA9 | **IMPLEMENTED** | — | §2 requires Cursor terminal-only and terminal as permanent fallback (`spec:170-190`). | Cursor declares terminal only (`packages/harness/src/manifests/cursor.ts:122-129`); registry selection explicitly refuses unsupported explicit drivers and degrades machine defaults (`apps/daemon/src/runtime/registry.ts:252-335`). | — |
| SA10 | **IMPLEMENTED** | — | §3 requires pinned version ranges, fixture tests, handshake/capability checks, loud refusal, and fallback (`spec:382-391`). | Manifests declare version admission; opencode/Codex/Grok drivers use recorded protocol fixtures and explicit health/handshake checks. Opencode's declared range is `>=1.18 <1.25` (`packages/harness/src/manifests/opencode.ts:162-196`). | — |
| SA11 | **IMPLEMENTED** | — | §3 requires per-axis capability declarations and a core/extended tier (`spec:198-206,311-317`). | `DriverCapabilities` makes core/extended axes total (`packages/agent-runtime/src/capabilities.ts:98-127`). IS2 records the staging omission rather than hiding it here. | — |

### Security

| ID | Status | Rank | Commitment and evidence | Gap / judgment | Size / dependencies |
|---|---|---:|---|---|---|
| SEC1 | **IMPLEMENTED** | — | §§3/6 require opencode loopback plus a cryptographically random per-session secret, never argv, with refusal of unauthenticated access (`spec:382-391,503-533`). | Launch creates a CSPRNG secret, passes it only through environment, scopes the process, and validates authenticated health (`apps/daemon/src/runtime/opencode-server.ts:440-595`); journal mode is 0600 (`opencode-server.ts:122-175`). | — |
| SEC2 | **IMPLEMENTED** | — | §6 specifies Codex on a per-session 0600 Unix socket (`spec:503-533`). | Podium's engine client and stock TUI now share one per-session listener using the pinned server's WebSocket-over-Unix protocol; the socket lives below the instance state root with a 0700 directory and mode 0600. The fixed daemon-control socket remains separate and unused. | — |
| SEC3 | **PARTIAL** | P1 | §5 says on-machine attach adds no new transport/auth surface, and §10 requires a written multi-user threat model before attach v2 (`spec:479,572-581`). | Engine processes and secrets are locally isolated, but the attach negotiation/relay does not exist and no dedicated attach-v2 threat model covers endpoint discovery, viewer authorization, takeover, input attribution, secret lifetime, or sibling scope. | **S** ADR before AS1. |
| SEC4 | **PARTIAL** | P1 | §1 requires PTY input containment because it is an attack surface (`spec:127-151`). | Agent-mail rendering strips control bytes, and the terminal driver wraps injection, but raw PTY paths and composer machinery remain callable outside the driver. Complete IS3/IS13 and document the one input boundary. | **M**; depends on IS3. |
| SEC5 | **IMPLEMENTED** | — | §6 requires one dedicated process tree and exact endpoint/session identity (`spec:503-533`). | Server drivers launch per-session processes/scopes; journals and reaping corroborate pid/start-time/secret/native identity before adoption (`apps/daemon/src/runtime/server-reap.ts:288-437`). | — |

### CLI surface

| ID | Status | Rank | Commitment and evidence | Gap / judgment | Size / dependencies |
|---|---|---:|---|---|---|
| CLI1 | **IMPLEMENTED** | — | §§4/8 require `podium interactions` list/answer (`spec:410-435,557`). | CLI parsing and list/answer commands exist (`apps/cli/src/interactions-cli.ts:1-62,123-218`). Relay authorization currently makes it operator-only, which is an honest constraint rather than silent fallback. | — |
| CLI2 | **MISSING** | P1 | §§5/8 require `podium attach <ref> [--peek|--takeover]` (`spec:464,479,557`). | No command exists. Build only after endpoint negotiation and lease unification; it must reuse the same on-machine streamed path as web/Tauri/mobile. **Known/decided:** the underlying native-TUI surface is under operator decision now. | **M**; depends on AS1–AS3/SEC3. |
| CLI3 | **MISSING** | P1 | §8 requires `podium runtime ps` with family, scope, memory, and open interactions (`spec:557`). | No command or concrete `runtime.list()` exists. | **S** UI after LD1/LD2/LD5. |

### Cross-machine and topology

| ID | Status | Rank | Commitment and evidence | Gap / judgment | Size / dependencies |
|---|---|---:|---|---|---|
| XT1 | **MISSING** | P0 | §§3/7 require every runtime primitive to relay identically over daemon WS for local, remote, and cloud machines (`spec:203,536-544`). | Runtime wire covers send, interrupt, answer, lifecycle, snapshot, asks, and events only (`packages/protocol/src/messages/runtime.ts:901-1075`). It lacks create/resume/adopt/list, export/import, health/history/watch, attach/lease, draft/configure, accounting/accounts, discovery/inventory/credentials, and staging. | **L**; after LD1; vertical slices, not one flag day. |
| XT2 | **MISSING** | P0 | §§3/7 require server-family handoff via byte-faithful export/import and placement (`spec:247,541`). | `runtime.import()` is type-only, opencode archive is not byte-faithful, and `harnessSupportsHandoff` still admits only Claude/Codex (`packages/harness/src/registry.ts:98`). | **L**; depends on LD2/LD3/XT1. |
| XT3 | **PARTIAL** | P1 | §7 says an enrolled daemon becomes a runtime supervisor with zero topology change and attach rides existing frames (`spec:541`). | Daemons host drivers on enrolled machines, but only the current subset of control frames is transparent; attach negotiation and runtime inventory are absent. | **L**; depends on XT1/AS2. |
| XT4 | **MISSING** | P2 | §§7/9 require a cloud supervisor image, placement tag, provisioning seam, and aggressive fleet hibernation (`spec:542,567-569`). | **Known/decided:** cloud is a plan non-goal. No runtime cloud supervisor/placement implementation exists; do not re-file. | **L**; after XT1/XT2/LD4/LD5. |
| XT5 | **MISSING** | P2 | §7 requires cloud credential seeding through the account/login propagation model (`spec:543`). | **Known/decided:** cloud and credential seeding are plan non-goals. Runtime credential export/seed is absent even from the interface; existing managed-account propagation remains separate. | **L**; after SA3/XT4. |
| XT6 | **MISSING** | P2 | §9's fleet acceptance is 50 Codex executors for one week with zero stuck sessions and collateral OOM kills (`spec:569`). | **Known/decided:** telemetry/acceptance is a plan non-goal. No evidence at this tip satisfies the acceptance claim; it cannot be attempted meaningfully before IS1, LD4, and LD5. | **M** test/soak infrastructure after dependencies. |
| XT7 | **IMPLEMENTED** | — | §7 explicitly defers a harness-native external/cloud driver family (`spec:544`). | **Known/decided:** no fourth external driver was added, matching the spec. | — |

## Known tracked issues: exact coverage and residual spec scope

These are corroborating issues, not substitutes for the broader commitments above:

- **POD-2297** covers swallowed server-driver queue-drain failure. It does not cover terminal-family
  custody, typed staging refusal, ledger reconciliation, or dead-letter visibility.
- **POD-2298** covers refused receipts leaving an optimistic chat row delivered. It does not cover
  `unverified`, delivery downgrade presentation, or queue ownership.
- **POD-2299** covers dead-letter rows missing from chat. It does not provide interaction UI,
  machine-wide queue visibility, or alerts/escalation.
- **POD-2327** covers an unknown future driver falling through to PTY. It does not provide full
  capability/admission diagnostics or machine-transparent selection.
- **POD-2041** covers double interaction synthesis in flagged terminal sessions. It does not provide
  policy, deadlines, needs-human materialization, or web/Tray/mobile answering.
- **POD-2050** covers flag-on coverage, stale `runtimeContract`, and a lease-holder convention. It
  does not complete the cutover, remove legacy paths, or implement the machine runtime.
- **POD-2293** is a pending specification for chat streaming. Even after approval/implementation it
  will not by itself provide general watch control, coarse durable projection, or native attach.
- **POD-2108** already records the opencode attach stream/input/geometry failure. It is proposed and
  should not be duplicated; AS1 remains broader and is under operator decision.

The plan's other explicit non-goals are also known/decided at audit time: telemetry, attach-v2
client-terminal surface, embedded/Claude-SDK rework, cloud, embedded TUI handover,
interaction-suppression policy, and UI redesign. Their spec commitments remain classified above so
the audit is complete. **Current policy, 2026-08-28:** the embedded/Claude-SDK *policy* non-goal is
superseded (Claude headless is first-class; subscription OAuth on the SDK is allowed). This audit
still does not rewrite its 2026-08-19 counts or invent an implementation that was not there.

## Proposed build order and dependency graph

The safest build order completes one vertical runtime before adding another driver:

1. **Restore truthful writes and custody (S→L):** IS2 typed staging refusal; POD-2327; POD-2297;
   POD-2298; POD-2299. Expand conformance in SA2 with each fix.
2. **Create the composition root (L):** LD1 concrete machine runtime, then LD2 real list/import and
   SA3 runtime inventory/accounts surface. This gives every later command one owner.
3. **Make observation a product plane (L):** AS4 durable coarse gate; then AS5/POD-2293 fine watch;
   reconcile AS6–AS9 and migrate downstream consumers.
4. **Finish interactions (M→L):** IS4 universal needs-human materialization and IS8 startup recovery;
   then, only if scope decisions change, IS5 policy/escalation and IS6 shell surfaces. Retire duplicate
   synthesis through POD-2041.
5. **Decide and, if approved, ship native attach (S threat model + L slice):** SEC3 → AS2 protocol →
   AS3 lease unification → POD-2108/AS1 client host → CLI2 → AS11 warm/reclaim. If the operator
   declines the surface, amend §5 and capabilities instead of retaining a false `supported` claim.
6. **Add durability/resource truth (L):** LD4 slice hierarchy → LD5 OOM observation → LD6 adoption
   reconciliation → LD10 evidence-based hibernation. Then CLI3 becomes small and useful.
7. **Remove parallel paths (L):** IS3/IS13 caller cutover, LD12 headless/exec retirement, and procedure
   layer IS12. POD-2050 is the pre-flip gate, not the deletion itself.
8. **Extend placement (L):** XT1 complete wire relay → LD3 archive decision → XT2 handoff. Cloud,
   credentials, and fleet soak (XT4–XT6) remain explicitly deferred until the operator reopens them.

Critical edges in compact form:

```text
IS2 + POD-2327/2297/2298/2299 -> LD1 -> AS4 -> AS5
LD1 -> LD2 -> XT1 -> XT2
AS4 -> IS4 -> IS8 -> IS6
SEC3 -> AS2 -> AS3 -> AS1/POD-2108 -> CLI2 -> AS11
LD4 -> LD5 -> LD10 -> XT6
IS1 + SA2 + POD-2050 -> IS3/IS13 -> LD12
```

## Appendix A coverage cross-check

This appendix ensures no feature row in spec Appendix A was skipped. Statuses point to the counted
commitments above rather than creating duplicate counts.

| Spec appendix | Result against the runtime-only coverage promise |
|---|---|
| A.1 Chat/conversation | **PARTIAL** — transcript/send/ledger/card/activity features remain mixed legacy/runtime; POD-2297/2298/2299 and POD-2293 are open; attachments hit IS2; draft and todo facts hit AS6/AS9. |
| A.2 Terminal surface | **PARTIAL** — the engine terminal remains functional, but agent panel/control/presence/soft keys/links/titles/HUD consume the legacy attach path; server client attach is AS1–AS3. |
| A.3 Lifecycle/fleet | **PARTIAL** — spawn/resume/adoption work per driver; runtime list/import, generalized handoff, OOM, cloud, and family-blind board state map to LD1–LD6 and XT1–XT6. |
| A.4 Messaging/steward | **PARTIAL** — receipt seams exist, but mail/await/nudge/auto-continue/push/Telegram still mix legacy paths; IS1/IS3/IS13 cover the gap. |
| A.5 Superagent | **MISSING as runtime migration** — headless threads/tool belt/open-in-terminal/MCP/error healing/watermarks remain on the parallel subsystem; LD8/LD12/IS12 cover it. |
| A.6 Transcripts/history/search | **PARTIAL** — normalized driver history exists, while lake/FTS/registry/resume picker/read toolkit remain legacy consumers; AS4/AS5/AS7 and SA3 cover it. |
| A.7 Models/quota/accounts | **PARTIAL** — product features exist separately, but runtime configure/accounting/accounts/login/credential primitives are unimplemented or incomplete; AS9/SA3 cover it. |
| A.8 Issues/workflows/automations | **PARTIAL** — git state, prime/re-prime, profile checks, scheduled sends, path completion, and lock release remain mixed; AS8/IS3/LD12 cover it. |
| A.9 One-shots/observability | **PARTIAL** — existing exec/perf/sound/telemetry paths do not consume runtime procedures/events; IS12/AS4 cover it. Telemetry is known/decided non-goal. |
| A.10 G1–G7 | **PARTIAL overall** — G1 AS6 diverged; G2/G3 AS8 partial; G4 SA3 missing runtime implementation; G5 overrides exist but IS2 staging diverged; G6 AS9 partial; G7 IS12 missing. |

The appendix's deliberately outside items—offers, approval broker, advisory locks as a product
primitive, file relay/artifacts, specs, and the Podium agent relay—correctly remain outside the
harness runtime surface.

## Specification amendments and rulings

Items 1–4 were resolved in the normative architecture document on 2026-08-19. Item 5 is the
2026-08-28 operator policy amendment (normative spec + this overlay); it does not re-audit the
2026-08-19 tree:

1. Grok ACP is an implemented, preferred server-family driver when the harness is logged in and its
   version is admitted; the terminal driver remains the explicit fallback (SA5). Evidence:
   `packages/harness/src/manifests/grok.ts:211-231`, `packages/agent-runtime/src/drivers/grok-acp/capabilities.ts:4-47`.
2. Codex production engine control and `codex resume --remote` now share one private per-session
   Unix listener. Codex 0.147.0 frames that listener as WebSocket text messages; its mode-0600
   socket below a mode-0700 instance directory is the local authentication boundary, distinct
   from the fixed daemon-control socket (SEC2). Evidence: executable declaration in
   `packages/harness/src/manifests/codex.ts` and listener/framing enforcement in
   `apps/daemon/src/runtime/codex-app-server.ts`; isolated live probes on 2026-08-20 initialized
   two concurrent clients and loaded the stock remote session picker through the same endpoint.
3. G1 product facts belong in the durable session projection. `handle.state()` remains the smaller
   harness-runtime verdict and owns native-subagent state; observed model/effort/context, accent,
   open todos, and event-time recency are projected once for family-blind product consumers (AS6).
   Evidence: `packages/model/src/entities/session.ts:214-239,295-381`.
4. The universal archive guarantee is semantic import/resume. Exact native-store preservation is a
   separate `byteFaithful` capability: handoff can accept either fidelity, while backup/restore must
   require it. `opencode`'s per-session message/part archive is valid without copying its shared
   machine-wide SQLite database (LD3). Evidence:
   `packages/agent-runtime/src/drivers/opencode/capabilities.ts:100-117`, `runtime.ts:1006-1034`.

5. Claude subscription OAuth on the persistent Agent SDK path is allowed under an explicit
   rollout acknowledgement; Claude headless is first-class / high-priority; PTY is the
   fallback (SA4, LD8 policy language). Canonical current text:
   [claude-subscription-oauth-policy.md](claude-subscription-oauth-policy.md). The 2026-08-19
   implementation classifications are unchanged: this amendment updates the *policy* those rows
   compared against, not the code that was audited.

The remaining independent recommendation is unchanged: after the native-TUI decision, either
approve the AS1 build chain or remove the false/reachable attach commitments and capability claims
from §5 and production manifests. These corrections do not amend POD-2293's streaming proposal.

## Bottom line

The next architecture milestone should not be another driver. It should make one existing driver
complete across the machine runtime, daemon wire, durable observation plane, product consumers, and
truthful failure/receipt paths. Only then do attach, resource isolation, and cross-machine placement
have a stable substrate rather than adding another parallel path.
