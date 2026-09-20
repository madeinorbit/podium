# ADR 10: Harness adapter and driver boundary

| Field | Value |
|---|---|
| **Status** | Proposed (phase reviewer grades lanes 1.3–6.2 against this text) |
| **Date** | 2026-09-20 |
| **Issue** | POD-4468 (lane 1.2 of POD-4414; recreates POD-4123 from POD-4104) |
| **File** | `docs/adr/0010-harness-adapter-and-driver-boundary.md` (this leaf owns **only** this file) |
| **Related** | ADR 8 (amends D4.3); spec REV 2 `docs/plans/pod-4414-harness-adapter-spec.html`; review `docs/plans/pod-4414-review-outcome.md`; POD-3190 artifact #30 DESIGN-FROM-SCRATCH.md; POD-4104 spec rev 2; `docs/plans/pod-4414-terminal-layers-in-code.html` |
| **Format note** | This record lives with ADRs 1–9 in `docs/adr/` under the pack's zero-padded naming (moved from `docs/architecture/` per POD-4485) and follows the ADR 8 frontmatter/decision style. |

## Context

The 2026-09-16 inventory found harness names in **257 non-test files across 20 directories**, outside the driver implementations themselves. The same credential file layout retyped in six places; model catalogs duplicated between web and mobile; a Codex terminal heuristic living in the browser terminal client; the server parsing harness transcript files with its own copy of the grammar.

Two competing paths existed for talking to a harness: the agent-runtime driver contract (a `RuntimeDriver` in the daemon owns the process, delivers text, judges readiness, returns honest receipts) versus the old server path that typed bytes into a PTY over the daemon link and polled for echoes (`apps/server/src/modules/sessions/inbox.ts`). This epic deletes the old path.

Three overlapping packages (`packages/transcript`, `packages/composer`, `packages/agent-runtime`) plus `harness/discovery`, `harness/inventory`, and eight daemon files that each knew one harness all answered "how does Podium talk to a harness". POD-4104 spec rev 2 set the invariant (one adapter per harness; the driver contract is the only runtime path; nobody else names a harness). POD-3190 artifact #30 set the runtime object stack (host, durable process, terminal, session, driver). This ADR records the reconciled decisions from Harness Adapter Spec REV 2 after independent review. Detail lives in the spec (§3–§5, §10); this record states the decisions and the rules later work is graded against.

## Decision A — Adapter: one per harness, required typed sections, declined(reason)

**DECISION:** There is exactly one `Adapter` type per harness: the composition of sixteen section types with **no optional fields**. One directory per harness under `adapters/<harness>/`, one file per section group. The type is today's `AgentManifest`, renamed; it grows sections and gets no rival.

- Every section is `supported(value)` or `declined(reason)`. Absence is a value: a missing section **MUST** be `declined(reason)`, and an **empty reason fails the registry check**.
- The sixteen sections are: `launch`, `environment`, `instrumentation`, `runtime`, `exec`, `state`, `composer`, `handoff` (Driver-owned); `transcript`, `discovery` (Store-owned); `inventory`, `credentials`, `usage`, `install` (Inventory-owned); `descriptor`, `catalog` (Descriptor projection). Capabilities are **not** a section; item identity is **not** a section (see Capability and the §5 identity invariant).
- Sections split into **host-only** (anything naming a path, process, or file) and **browser-safe** (`descriptor`, `catalog`, composer rules). The browser entry **MUST NOT** import the host-only group.
- A mechanism **MUST NEVER** receive the whole Adapter. Each mechanism receives a **typed SUBSET** — only the sections it owns — so the read restriction is a type, not a rule. Narrow additional readers (registry family selection reading `runtime`; a bundled client reading pure composer rules) are legitimate projections, not defects.

**Rationale:** one copy cannot drift from itself; completeness becomes a typecheck plus a generated support matrix instead of a hunt across twenty directories.

## Decision B — Mechanisms and projection: three plus a Descriptor

**DECISION:** Exactly three mechanisms plus one projection. Each mechanism holds one kind of thing, consumes its owned sections, and is harness-free — it could serve a harness that did not exist when it was written. The Descriptor holds nothing and is not a mechanism.

| Mechanism | Holds | Owns sections | Side | Today |
|---|---|---|---|---|
| **Driver** | a live process | `launch`, `environment`, `instrumentation`, `runtime`, `state`, `composer`; one-shot exec via the existing `oneShot` procedure override (`exec.ts`), not a separate family | daemon | `packages/agent-runtime` (contract + five families: terminal, codex, opencode, grok-acp, claude-sdk) plus daemon hook files and the composer package |
| **Store** | files at rest | `transcript`, `discovery`, `handoff` (at-rest format and placement only; quiesce-transfer-resume workflow is application composition) | both | `packages/transcript` reader; grammars move into adapters |
| **Inventory** | a machine, no session | `inventory`, `credentials`, `usage`, `install` | daemon | `harness/inventory` plus eight daemon files and the CLI installer |
| **Descriptor (projection)** | nothing | `descriptor`, `catalog`, plus capability flags resolved per Capability below | server to clients | `harness/browser.ts` and `metadata.ts`, served over the wire |

- `handoff.ts` belongs to the **Store** (at-rest format/placement); any transfer workflow is application composition. It **MUST NOT** force the Driver into a second storage implementation.
- Nothing inside `adapters/` **MUST** import a mechanism. Nothing in a mechanism **MUST** import a specific adapter, only the Adapter type.
- Mechanisms **MUST NOT** own or instantiate each other. Dependencies between them are explicit, narrow, acyclic ports. A live Driver reads history through an **injected Store port**. Login composition: Inventory owns the probe and the login command; `DaemonSession` opens a Terminal running it; Inventory re-probes on exit.

**Rationale:** knowledge (data + pure functions, varies per harness) and mechanism (behaviour, varies per way-of-using) are different kinds of code and never mix; every object varies along exactly one axis.

## Decision C — Boundary and lint: no vendor behaviour outside adapters and driver families

**DECISION:** No vendor-specific **operational behaviour** lives outside `adapters/` and `driver/families/`. The mechanical gate is the identifier lint from lane 1.1 (kept because a stated invariant without a check has already failed in this codebase), with a categorized allow-list:

- `leak` — genuine residual reference; **MUST only shrink**.
- `policy` — product preference, not harness fact (e.g. the superagent's harness order in `harness-defaults.ts`, which reflects what Podium has exercised and **MUST NOT** move into an adapter). Each `policy` entry **MUST** point at its owning policy module with a one-line reason.
- Comments, fixtures, and historical migrations are **excluded** from the scan. Closed sets of harness names live **only** in the registry.
- Expression style is free behind the boundary: data and pure strategies are preferred where they simplify; a small harness-local strategy implementation is permitted where forcing declarations would build an interpreter. The invariant is *vendor behaviour stays behind the boundary*, not *one programming style*.

**Rationale:** the external review's "no vendor identifier anywhere" reading is rejected — it would move legitimate application policy into adapters or reward name-scan gaming while the coupling survives. `leak`/`policy` keeps the gate mechanical without that perverse incentive.

## Decision D — One package, six entries, contract-entry import check

**DECISION:** Everything about harnesses is in **`@podium/harness`**. `adapters/` is what is true about each harness; the other directories are how Podium uses any harness. `packages/transcript`, `packages/composer`, and `packages/agent-runtime` dissolve into it (directory moves + import rewrites, no behaviour change). `@podium/process` (durable host, pty, screen) stays separate because it is not about harnesses.

| Entry | Contents | Who may import |
|---|---|---|
| root | `adapter.ts` (`Declared<T>`), `registry.ts` (one enumeration, totality check, closed set) | everyone |
| `/driver` | `contract.ts` — intent-level contract, no host code | server **may** import |
| `/driver/host` | construction, adopt, attach | daemon only |
| `/store` | reader, tailer, slice, cursor, identity, scanner, file-chain/mirror/stream sources (both sides); `sources/sqlite.ts` **host-only** | both sides per source |
| `/inventory` | probe, login, credentials, usage, install | daemon only |
| `/browser` | Descriptor projection (bundled fallback) | clients |

- The contract entries (`/driver`, `/store`, root) **MUST** import no host code: no `child_process`, `net`, `http`, no `@podium/process`. An **import check enforces** it; the server may import them, clients may import `/browser` only.
- A harness on existing mechanisms is one directory plus one registry line; the compiler lists every missing section. A genuinely new protocol or store kind adds an implementation **inside the harness package** and still changes no application consumer.

**Rationale:** the lint enforces direction, so one package gives a one-word answer to "where is the harness code" without splitting knowledge from its mechanisms.

## Capability at three scopes

**DECISION:** Implemented support, machine availability, and session capability are three different facts with three sources of truth. Capability is **NEVER** derived from the support matrix alone.

| Question | Example | Source of truth | Answered |
|---|---|---|---|
| Is it **implemented**? | a transcript grammar exists for this store kind | adapter declarations (support matrix) | registry, at build time |
| Is it **available on this machine**? | installed version supports this driver family; user logged in | Inventory report + admission (`SelectionContext`) | daemon, at inventory and at spawn |
| Is it **effective for this session**? | `configure` takes effect next turn; an interrupt cannot be fenced | selected driver's `DriverCapabilities` + current conditions | live handle, per operation |

Callers receive capability at the scope of their operation. The served descriptor carries the first two as renderable flags; the third travels with the session. The generated support matrix is the **first** of the three inputs, never the session's capability.

## Construction and failure ownership

**DECISION:** The Driver receives a Terminal or an engine address and owns nothing below itself. Launch, environment, and instrumentation are its sections. That coexists with ownership only through this explicit sequence, owned by `DaemonSession`:

| Step | Who acts | Reads | On failure, who cleans up |
|---|---|---|---|
| 1 prepare | Driver family (pure) | `launch`, `environment`, `instrumentation` | nothing to clean; spawn refused with reason |
| 2 create or adopt process | `DaemonSession` via `DurableProcess` | prepared spec | `DaemonSession`: instrumentation installed but spawn failed → remove it; report `spawnError` |
| 3 attach surface | `DaemonSession` builds Terminal over process (headed) or records engine address (headless) | — | process stays owned; failed attach reports, may retry; nothing killed |
| 4 bind driver | `DaemonSession` hands Driver its typed sections + Terminal/address | `runtime`, `state` | unbuildable driver is `spawnError` (fresh) or `reattachFailed` (adopt); process kept for operator decision, never silently orphaned |
| 5 observe | Driver | `state`, instrumentation decode | Driver reports degraded observation; session stays live |
| 6 detach or terminate | `DaemonSession` per `ServerSession` policy | — | park = drop Terminal, keep process; kill = dispose process, then Terminal |

Process survival is **not** session recovery. After an adopt, the Driver **MUST** restore or explicitly invalidate pending deliveries, protocol subscriptions, open interactions, and acceptance evidence. A surviving process with unrecoverable protocol state is reported as such, never presented as live.

## Consequences

**What gets simpler:** "how does Podium talk to a harness" has one answer readable from imports (the Driver); "how does Podium read a transcript" has one answer (the Store) — the lake and a live session run the same code, and the same logical native record and sub-item receive the same identity whether read live, mirrored, relocated, or replayed (conversation namespace + logical file incarnation + record identity/position + sub-item mapping; the Store owns that agreement, the search indexer consumes normalised items and never a harness's records). The server never holds a process or socket to a harness. Old clients render a new harness's descriptor inside a schema they already know (wire descriptor is versioned serialisable **data**; bundled browser rules are **code** and a fallback only — no remote rule interpreter). The support matrix is generated.

**What it costs:** the package merge is a large diff (moves + import rewrites, no behaviour) landed in one issue with the lint on. Sixteen sections per harness invites `declined('n/a')` boilerplate — the registry refuses empty reasons and the matrix makes declines visible, by design. OpenCode's SQLite store is host-only: the lake serves OpenCode only while its machine is reachable until its database is mirrored (stated limitation, decided before the Store lane).

## Rejected alternatives

| Rejected | Why, in one line |
|---|---|
| Shared `EngineLink` over the three headless protocols | They share a process mechanism and nothing else; the abstraction would be empty. |
| Two packages (knowledge vs mechanism) | The lint enforces direction, and a reader needs a one-word answer to "where is the harness code". |
| `Reader` as the transcript mechanism name | It implied the whole read side; the mechanism is the Store and covers discovery too. |
| Terminal owning its process | Parking would destroy the owner and keep the owned; the session owns processes, the Terminal is a surface. |
| A fifth exec mechanism | One-shot exec is an operation through the existing `oneShot` procedure override, not a session-pretending family. |
| A behaviour-only lint (no identifier gate) | No check can verify that definition; the identifier lint with `leak`/`policy` categories is the mechanical gate that stays. |

## Amends ADR 8 D4.3

ADR 8 D4.3 decided:

> "**Rejected:** rename to `transcript-core`; move slice core into `model` (not a vocabulary entity); move pure mappers into `harness` (would force harness deps on browser-safe consumers of pure parse)."

The third rejection — "move pure mappers into `harness`" — is **amended**: per-harness transcript grammars (the pure record→item mappers) **do** move into `adapters/<harness>/transcript.ts`, consumed through the Store mechanism. The reason lapsed with **POD-4095**: browser consumers no longer import harness host code — they read the served/bundled Descriptor projection through the `/browser` entry whose host-only imports are check-enforced — so the feared dependency is answered by construction rather than by keeping the mappers out. The remainder of D4.3 stands: no `transcript-core` rename, and the slice/page core is not moved into `model`.

## References

- **Binding:** Harness Adapter Spec REV 2, `docs/plans/pod-4414-harness-adapter-spec.html` (2026-09-20, `integrate/4414-single-harness-transport`; also published as an artifact on POD-4414) — §3 principles, §4 design (§4.7 capability, §4.8 construction), §5 rules, §10 decision history.
- **Review:** `docs/plans/pod-4414-review-outcome.md` — independent static review of rev 1 (verdict: approve direction ~8/10, request targeted revisions); rev 2 folds in its three load-bearing amendments (support vs capability split; bundled code vs wire data; narrow composition over one-reader/no-call absolutes) and takes the lint recommendation with modification (`policy` category instead of a behaviour-only definition).
- **Runtime stack:** POD-3190 artifact #30 DESIGN-FROM-SCRATCH.md (via `docs/plans/pod-4414-terminal-layers-in-code.html`) — host, durable process, terminal, session, driver; ownership flows one way.
- **Prior invariant:** POD-4104 spec rev 2 — one adapter per harness, driver contract as the only runtime path, nobody else names a harness; this spec reconciles it with the layers design and fixes the package layout.
