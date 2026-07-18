# Rearchitecture v3 — Migration Ledger

**The single living record of the architecture rewrite (POD-279).** This document carries
the execution machinery: the adopted decisions, per-phase status, the conventions every
executing agent is bound by, and the registries (hot files, human gates, scar tissue).
It is updated continuously — each phase updates its section as work lands, and closes it
at phase exit. Prose here never closes a gate; the tracker does (see EXIT GATES).

Epic: POD-279 (Architecture rewrite v3: land the first-principles redesign COMPLETELY).
Plan source: the 2026-07-10 first-principles proposal, revised by the two 2026-07-13
adversarial review rounds (disposition reports live as comments on POD-279).

---

## 1. The five moves and adopted decisions

The rewrite lands five moves, end to end, with no intermediate state left behind:

1. **ONE SEMANTIC VOCABULARY** — every field/concept authoritatively defined once in
   `packages/model` (L0); canonical durable aggregate + live state + storage
   representation + wire/read projections COMPOSED from shared field schemas.
   NOT one universal record; legitimate narrow ports remain as named derived projections.
2. **ONE SYNC KERNEL** — Authority (arbitrates truth per the ownership-matrix ADR) /
   Replica (applies ordered revisions + optimistic overlay; **never** arbitrates) /
   Outbox (durable command delivery with the full lifecycle incl. dead-letter recovery).
   One implementation, pluggable ports, one cross-hop conformance suite.
3. **COMMAND CONTRACTS EVERYWHERE** — L1 contracts (versioned schemas, policy,
   default-closed transport exposure, offline class, redaction, optimistic reducers)
   joined to L3 feature handlers at composition roots; principal from authenticated
   transport only; apply-time re-auth for offline commands; secrets never replicated
   or queued.
4. **PLANES AS PROTOCOL CONTRACTS** — control/stream/bulk classify messages and set
   port semantics (inventory decided in ADR 7); application code stays VERTICAL by feature.
5. **VARIANCE AT THE EDGE** — behavioral branching on harness identity confined to
   harness adapters; one SessionBinding lifecycle owning session-identity aliases
   with history.

### Adopted decisions (binding)

- **Route A** — the full first-principles redesign, not incremental patching; phases
  ordered so guardrails and contracts land before extraction.
- **ADR gate POD-359 runs BEFORE Phase 1.** The 8-ADR pack (ownership matrix, sync
  protocol, command security/lifecycle, representation policy, peer topology, replica
  storage, plane/message inventory, package topology) is committed to `docs/adr/` and
  human-signed-off before the model phase consumes its decisions.
- **Version negotiation is a PERMANENT mechanism; the concrete legacy adapter EXPIRES.**
  The wire ships a permanent negotiation mechanism; the N/N-1 legacy adapter (POD-308)
  is a deletion-audit item with a deadline — expired and deleted by Phase 7 at the
  latest (POD-294/POD-337 track the expiry). The internal snapshot pipeline dies in
  Phase 2 regardless.
- **Two processes, one peer protocol** — server and daemon speak the same peer framing;
  role-specific auth strategy modules, not a conditional god machine (ADR 5, POD-317,
  POD-327 mirrors the gateway contract from the daemon side).
- **Transactional replica storage** — IndexedDB on web (OPFS only if the pre-ADR spike
  proves a threshold need), SQLite on mobile; localStorage/AsyncStorage only for small
  preferences/degraded fallback; crash/power-loss/quota semantics tested at every
  entity/cursor/outbox boundary (ADR 6, POD-307).
- **Best-available state channel per provider** — hooks where supported,
  provider-specific polling otherwise, classifier as lowest-confidence fallback inside
  the claude manifest; every signal carries source + confidence, reducer prefers higher
  confidence (POD-326).
- **HarnessId / BuiltinHarnessKind dual form** — closed enum in-repo (compile-time
  totality), open branded string + serialized capability descriptor on the wire, with
  incremental-completeness manifests, so unknown kinds degrade gracefully without
  lockstep redeploys (POD-303, POD-325).
- **HUB DEFERRED** per spec [spec:SP-0371] (user decision, confirmed 2026-07-13).
  In scope: local topology (clients + one server + N paired machine daemons) plus the
  preserved federation SEAM (feed identity, origin/causation, reserved peer-capability
  fields, kernel ports free of same-machine assumptions, parameterized conformance
  suite). Out of scope: any federated product behavior — parked in POD-353.
  UpstreamSync/UpstreamForwarder are retired during the rewrite (POD-309).

---

## Runtime work placement [spec:SP-c29e]

The loop split is classified by the facts a job needs and the authority it exercises. A timer
is only a trigger; it does not decide placement. This matrix is the durable rule for current
code and for the v3 migration:

| Placement | Owns | Must not own |
|---|---|---|
| Interactive server loop | Sockets and WebSocket fan-out, tRPC, ordered command application, authorization, live runtime state, protocol/liveness timers, bounded actor state machines | Durable calendar polling or CPU-heavy pure transforms |
| Bun workers | CPU-heavy pure transforms such as projection preparation, encoding, and parsing; inputs and outputs are versioned values | SQLite, the ledger, the write funnel, authorization decisions, or live runtime ownership |
| Janitor systemd sibling | Durable calendar/event polling and housekeeping decisions: message expiry, steward work, automation cron, retention, auto-archive, and automatic connect-scan orchestration | Live presence/in-flight truth, direct durable mutation, or deep interactive connect scans |
| Server command/write seam | Apply-time revalidation, authorization, transaction/write-funnel execution, ledger ordering, and fan-out | Trusting a janitor observation as current truth |

The janitor may read WAL SQLite only for durable candidate facts. Every mutation returns over
the narrow authenticated maintenance transport with a deterministic run key, observed durable
preconditions, and a lease fencing token. The server re-reads the facts at apply time and
returns `applied`, `already-applied`, or `stale`. Compatibility negotiation prevents an old
janitor from acquiring or renewing a lease after an incompatible protocol/schema change.

POD-845's first review cut moves message expiry and establishes the shared fenced surface and
real sibling lifecycle. POD-925 Batch 1 moves event-log retention, ledger change-log cadence
prune, issue auto-archive, and maintenance_commands retention onto that surface (server timers
and ledger append-cadence prune retired after parity tests). Batch 2 covers steward poll,
automations cron, and automatic connect-scan orchestration. Until each cut lands, its existing
owner remains authoritative rather than running two writers.

---

## 2. The migration oracle

The oracle is the behavioral contract every phase must preserve. It is defined over the
**test-lane doctrine** — `docs/agents/testing.md` (authoritative lane map) and specs
[spec:SP-0be7] + [spec:SP-3f93] — NOT a single full-suite command. `bun run test` is
deliberately the fast retry-0 unit lane only; "oracle green" means the relevant lanes
green: **unit / integration / e2e / multi-instance** (agent-smoke is explicit-only).
Per-phase "oracle status" lines below reference lane results. Locking the baseline is
POD-295; the CI wiring is verified at gate POD-422.

Build orchestration is part of the oracle environment: typecheck runs under tsgo
(POD-706, [spec:SP-3b58]), with turbo task orchestration once POD-715 lands — gate
evidence must cite the orchestrator actually in CI at the time.

---

## 3. Standing conventions

### 3.1 Phase-entry drift refresh (standing convention)

At every phase-entry gate, **the phase agent re-audits its phase issues against current
main before starting** — a "drift refresh". This plan froze 2026-07-13 and was
materially stale in ~30 issues within 3 days (drizzle-kit adoption, instance identity
[spec:SP-15aa], session handoff, new messages/workflows verticals, web redesign);
later phases execute months from now and WILL drift further. The 2026-07-16 refresh
comments on affected issues are the template: a dated `DRIFT REFRESH` comment per
affected issue stating what changed on main and how the issue's scope/ACs move.

Post-freeze facts to re-check at minimum: test-lane structure (docs/agents/testing.md),
build orchestration (tsgo/turbo — the SP-3b58 cold-timing baseline was measured on tsc
and is already stale), instance identity (SP-15aa), the deletion-audit inventory, the
hot-file table below, and any new verticals (routers, packages, wire messages) landed
since the phase was decomposed.

### 3.2 Phase-close rule

A phase closes ONLY when: (a) all its children including its exit-gate leaf are closed,
(b) its deletion-audit items are at zero, (c) the oracle lanes are green, (d) its ledger
section below is filled in (scope as executed, cut lines, oracle status, audit counts
before/after), and (e) its as-built docs are updated (§9). No phase closes while a
dual/legacy path it was meant to remove still exists.

### 3.3 Exit gates are scheduler-enforced leaves

Parents are closable with open children, so **downstream work blocks on the gate LEAF,
not on the milestone**. The gates: POD-422 (Phase 0) · POD-423 (Phase 1) · POD-310
(Phase 2, human) · POD-424 (Phase 3) · POD-425 (Phase 4) · POD-426 (Phase 5) ·
POD-427 (Phase 6) · POD-337 (release gate, human). A gate closes only after its
verification checklist is executed and evidenced — never because its phase "looks done".

### 3.4 Tracker navigation rule

`podium issue tree 279` **TRUNCATES beyond the CLI cap (~100 nodes)** — the rewrite
tree is far larger. Never verify readiness or completeness from the root tree alone;
inspect per-phase trees (`podium issue tree <phase-id>`) or query children recursively.
This rule is repeated in every phase section's verification steps below.

### 3.5 Lint caveat

Issue acceptance criteria currently live in **description prose** because the CLI does
not expose the dedicated acceptance field. Therefore `podium issue lint` AC checks are
**NOT a quality gate** for the rewrite issues until the CLI gap is fixed (tracked with
POD-413's agent). Gate agents verify ACs by reading descriptions, not by lint output.

---

## 4. Decomposition discipline

**User decision: EAGER — executed in-plan 2026-07-13.** Every flagged mini-epic was
pre-split into bounded children following the protocol
*characterization → scaffold → one aggregate/hop → shadow/conformance → cutover → named deletion*:

| Mini-epic | Pre-split children |
|---|---|
| POD-301 branded IDs | POD-360…363 |
| POD-302 semantic vocabulary | POD-364…368 |
| POD-306 Replica + Outbox | POD-369…373 |
| POD-307 client storage | POD-374…378 |
| POD-312 session mutations | POD-379…382 |
| POD-313 superagent/fleet/spec mutations | POD-383…386 |
| POD-317 gateway | POD-387…391 |
| POD-319 SessionService split | POD-392…395 |
| POD-325 harness/pty split | POD-396…399 |
| POD-328 sync/async twins | POD-400…404 |
| POD-331 client engine split | POD-405…409 |

**Any FUTURE oversized issue follows the same protocol**: it is split before
implementation, and the split is **reviewed against the governing ADR** (an oversized
issue implemented whole is a gate-blocking defect). "Oversized" = touches more than one
hot file, more than one hop, or cannot state a single named deletion.

**Grep audits are necessary, never sufficient.** Semantic gates (conformance suites,
manifest lint, runtime verification, human gates) decide; a grep count of zero is
evidence, not proof.

---

## 5. Hot-file integration ownership

Contested files each have ONE owning phase/issue at any time. Anyone else touching a
hot file coordinates with the owner (issue mail + `podium lock acquire hotfile:<name>`)
and merges BEHIND the owner. Merge-order rule per file:

| Hot file | Owner (phase/issue) | Merge-order rule |
|---|---|---|
| Protocol message unions + codec (`packages/protocol`) | Phase 1 POD-300 (schemas move out), then Phase 2 POD-308 (wire cutover), then Phase 4 POD-317/POD-387 (plane inventory) | Owner lands first each phase; additive message variants by others rebase onto the owner's union; no one but the owner changes codec/negotiation. |
| `router.ts` (tRPC surface) | Phase 3 POD-314 (derivation shrinks it to genuine queries); mutation-migration children (POD-312/313/640/641) delete their procs | Deletions land per-child; POD-314's derived-router refactor merges LAST in Phase 3, after all migrations. |
| Server composition root | Phase 4 POD-321 (declarative acyclic composition) | Until POD-321, edits are append-only wiring; extraction children (POD-317/319/320/322) each rebase onto the previous extraction — serialize via merge lock. |
| Workspace manifests (`package.json` graph, new packages) | The phase scaffolding issue creating the package (POD-299 model, POD-305/306 kernel, POD-311 commands, POD-325 harness/pty, POD-331 engine) | New package = one scaffolding commit owned by that issue; others take it as a base. Every new package registers its typecheck task + correct workspace deps (see turbo.json row). |
| `scripts/check-boundaries.ts` (architecture manifest lint) | Phase 0 POD-296 (warn mode), then Phase 7 POD-335 (error level) | Between those, phases may ONLY shrink their own allowlist entries; rule changes go through the owner. |
| Store migrations (global migration order) | Phase 2 POD-305 (app migration orchestrator owns global ordering) | One migration number at a time — `podium lock acquire migration-number` before allocating; feature-owned tables stay in their feature but register with the orchestrator. |
| `turbo.json` (build orchestration; contested once POD-715 lands) | POD-715's agent, then each package-scaffolding issue for its own task entry | Every new package registers a typecheck task + correct workspace deps as part of scaffolding — otherwise turbo invalidation silently misses it. Cross-cutting pipeline changes only via the owner. |

---

## 6. Human gates registry

**THE RULE: when a gate is reached, the executing agent MUST run
`podium issue needs-human` on the gate issue. Prose labels cannot close a gate.**
Evidence is attached via issue artifacts (`podium issue artifact <id> --add …`);
runbooks live in this document (section per gate below or in the phase section).

| Gate | What the human does | Runbook location | Evidence location |
|---|---|---|---|
| POD-359 ADR pack sign-off | Reads and signs off the 8 ADRs before Phase 1 entry | `docs/adr/` (the pack itself; sign-off procedure in POD-359) | POD-359 issue artifacts + signed ADR frontmatter |
| POD-351 walking-skeleton sign-off | Verifies session.rename on the target path (online/offline, two clients, crash/reconnect); USER sign-off | POD-351 description + §Phase 1 ledger section | POD-351 issue artifacts (shadow-comparison record, runtime evidence) |
| POD-310 live upgrade rehearsal | Runs the local-topology upgrade on the real fleet (VPS + remote daemon + phone PWA); rollback drill | This document, Phase 2 section (runbook committed by POD-310) | POD-310 issue artifacts + quantitative checks recorded here |
| POD-377 mobile cutover device smoke | Real-device smoke of the SQLite replica migration | POD-377 description | POD-377 issue artifacts |
| POD-332 mobile slices device smoke | Real-device smoke: cold-start offline paint, reconnect drain, terminal parity | POD-332 description | POD-332 issue artifacts |
| POD-327 remote-daemon soak | 48h live remote-daemon soak (paired VPS) without manual intervention; may run on an isolated named instance per [spec:SP-15aa] | POD-327 description + Phase 5 section | POD-327 issue artifacts |
| POD-337 fleet soak + release | 72h+ local-topology fleet soak, two redeploys + one daemon self-update; quantitative criteria within thresholds; "clean" as defined in POD-337 | This document, Phase 7 section (runbook committed by POD-337) | POD-337 issue artifacts |

---

## 7. Scar-tissue registry

Incident-hardened code is **relocated verbatim, never rewritten**. When a phase moves a
file containing scar tissue, the scar moves with its comment and its test; "cleaning it
up" is a regression until the incident class is provably impossible. Each relocation is
recorded here (phase agents append rows).

| Scar | Where it lives today | Incident it encodes |
|---|---|---|
| Malformed-frame-per-reattach tolerated as benign | daemon connection handling (POD-327 relocates; must document in code) | One ZodError per (re)attach is NORMAL; treating it as fatal broke reattach |
| `decideOnProtocolMismatch` / `decidePostUpdate` self-update policy | `daemon/self-update` module | Self-update decisions were once inline and cross-wired; keep/extend the module (POD-327) |
| Delete-tracking on replica sync (assign `undefined`, never `delete`) | replica delta application | Replica dropped nulled fields — stuck fields incident (POD-170-era); POD-378 carries the regression test |
| `reclaimStaleScope` | session scope allocation | Scope-name collision killed a live agent |
| Master-probe + exited-row heal on restart | server boot | Restart orphaned live sessions |
| `seedBootState` on reattach | agent state pipeline | Reattach previously showed stale agent state |
| Feature-detect `spawn({terminal})` | PTY spawn path | PTY black screens on stale-Bun daemon |
| Masters in their own `systemd-run --scope` | session spawn | Redeploy's cgroup kill took live sessions down |
| Codex trust-hash/TOML version guard (to be added) | codex adapter (POD-327) | Silent mis-hashing on unknown codex versions; must degrade loudly |

(Phase 5, which touches the host layer, updates this registry for everything it
relocates — an explicit AC on POD-327.)

---

## 8. Phase ledger

Every phase issue links back to its section here. Each section is maintained by that
phase's agents and finalized at the exit gate. **Verification steps in every phase
include: use `podium issue tree <phase-id>` (never the root tree — §3.4), run the
drift refresh (§3.1) at phase entry, and verify ACs by reading descriptions (§3.5).**

### Phase 0 — Guardrails (POD-287) · exit gate POD-422

**Scope:** build the mechanism that makes "half-landed" visible and painful, BEFORE any
code moves. Four children:

- POD-295 — lock the migration oracle: green lane baseline (unit + integration + e2e +
  multi-instance) in CI, per the lane doctrine (§2). *In progress; waits on POD-619
  stable baseline — precondition now MET (landed 1b10357f).*
- POD-296 — architecture manifest lint: layer/platform/role/feature constraints in
  `scripts/check-boundaries.ts`, WARN mode, phase-mapped allowlist. *In progress.*
- POD-297 — deletion audit script (`scripts/rearch-audit.ts`): the Section-6 "what
  disappears" inventory encoded as grep/AST checks with per-item and total counts,
  counted in CI, must reach zero by POD-337. *In progress.*
- POD-298 — this ledger. *This document.*

**Cut lines:** Phase 0 ships guardrails only — no production code moves, no schema
moves, no deletions. The audit script REPORTS counts; it does not fail CI on nonzero
(that ratchet is per-phase). Manifest lint stays in warn mode until Phase 7 (POD-335).

**Oracle status:** baseline being locked by POD-295 (lane-based; see its issue for the
current lane-by-lane state). Typecheck lane green under tsgo; turbo pending POD-715.

**Audit counts:** baseline committed by POD-297 on its close — *pending; the
before-count for every later phase is read from that committed baseline.* After Phase 0:
unchanged by definition (nothing deleted yet).

**Verification steps (gate POD-422):** oracle CI job live (lane-based, incl. the
typecheck lane under the current orchestrator); deletion audit baseline committed;
manifest lint in warn mode with phase-mapped allowlist; ledger conventions complete
(this document); all four children closed with evidence. Use `podium issue tree 287`,
not the root tree. Only then does POD-422 close and unblock the ADR pack + Phase 1.

### ADR gate (POD-359) + Walking skeleton (POD-351) — between Phase 0 and Phases 2–3

Not a numbered phase but a scheduling stage: POD-359 (8 ADRs, HUMAN GATE) runs after
POD-422 and before Phase 1 consumption; POD-351 (session.rename end-to-end on the
target path, shadow-compared, HUMAN sign-off) gates Phases 2–3 entry and ships the
first real command contract + optimistic reducer port that POD-372/POD-311 consume.

**Ledger obligations:** shadow-comparison record for POD-351 lands in this section;
zero divergence required.

### Phase 1 — packages/model (POD-288) · exit gate POD-423

**Scope:** one semantic vocabulary at L0: `packages/model` scaffold (POD-299), entity
schemas out of protocol (POD-300), branded IDs everywhere (POD-301 → 360–363),
canonical aggregates + composed projections (POD-302 → 364–368, incl. handoff
vocabulary POD-643), agent identity dual form (POD-303), provenance envelope +
ownership annotations (POD-304).

**Cut lines:** no behavior change — representations re-derived, wire fixtures byte-stable
(golden fixtures from POD-360). Narrow ports remain as named derivations.

**Oracle status / audit counts:** filled at phase close. Audit items: hand-restated
field definitions, raw-string ids (now incl. `messages/handoff.ts`), agent-kind/
capability tables (five adapters since grok landed dc6537d6), stateDir.

**Verification steps (gate POD-423):** regenerate the gate evidence checklist against
current main, not the 07-13 snapshot; audit items zero; oracle green; wire fixtures
unchanged (incl. the handoff family); ledger + as-built updated. `podium issue tree 288`.

### Phase 2 — One sync kernel (POD-289) · exit gate POD-310 (HUMAN)

**Scope:** Authority (POD-305), Replica + Outbox + conformance (POD-306 → 369–373),
clients on the kernel with transactional storage (POD-307 → 374–378, human device gate
POD-377), wire cutover + version negotiation (POD-308), upstream retirement + federation
seam (POD-309), switch-latency harness survival (POD-736).

**Cut lines:** kernel = infrastructure-neutral state machines + ports (L2); persistence
adapters own generic sync tables; app orchestrator owns global migration order (hot
file §5); feature-owned tables stay put. Internal snapshot fan-out dies here; the N/N-1
wire adapter is born here WITH its expiry registered in the deletion audit.

**Ledger obligations:** quantitative release-criteria THRESHOLDS are fixed in this
section during Phase 2 (measured at POD-337): cold startup, DB growth rate, sync lag,
outbox age + dead-letter count, gap-heal time, bootstrap snapshot time, reconnect-storm
behavior, render counts, memory per pane, zero-data-loss crash tests. The POD-310
upgrade-rehearsal runbook is committed into this section.

**Verification steps (gate POD-310, HUMAN):** rehearsal on the real local topology
(VPS + remote daemon + phone PWA), in-place DB upgrade, zero lost sessions, rollback
drill tested once; `podium issue needs-human` set at the gate. `podium issue tree 289`.

### Phase 3 — Command registry as the universal write surface (POD-290) · exit gate POD-424

**Scope:** L1/L3 split + framework (POD-311), session mutations (POD-312 → 379–382 +
handoff POD-642), superagent/fleet/specs (POD-313 → 383–386), derived router (POD-314),
command security (POD-315), offline classes + outbox UX (POD-316), secrets/preferences
split (POD-352 → 418–421), agent-mail (POD-640) and workflows (POD-641) routers
(post-freeze additions, gate via the POD-314→POD-315 chain).

**Cut lines:** contracts at L1, handlers at L3, joined at composition roots.
messaging (Telegram bridge) has no tRPC mutations — no migration child; its reactions
are POD-321's business.

**Verification steps (gate POD-424):** no hand-written mutation procedures (audit);
authz matrix green across four transports; offline classes + dead-letter UX
runtime-verified; secrets split complete; ledger + as-built updated.
`podium issue tree 290`.

### Phase 4 — Node decomposition (POD-291) · exit gate POD-425

**Scope:** gateway + plane inventory implementation (POD-317 → 387–391), fleet service
+ one machine identity (POD-318), SessionService split (POD-319 → 392–395), IssueService
recomposition (POD-320), declarative acyclic composition + reactions registry (POD-321),
memory service (POD-322), orchestrator/attention/telemetry boundary review (POD-355),
instance-vs-machine identity (POD-645, [spec:SP-15aa], post-freeze addition).

**Verification steps (gate POD-425):** composition root acyclic (topological test);
god-object audit items zero; module graph doc committed; session/issue/memory e2e green;
live redeploy keeps sessions; multi-instance isolation suite green through the
decomposition. `podium issue tree 291`.

### Phase 5 — Machine host tightening (POD-292) · exit gate POD-426

**Scope:** SessionBinding designed lifecycle (POD-323, design doc gates code), async-only
durable hosts (POD-324), harness/pty split with one manifest per CLI (POD-325 → 396–399),
best-available state channel (POD-326), daemon connection state machine + host control
decomposition + codex version guard (POD-327, HUMAN soak gate), sync/async twins
(POD-328 → 400–404), binding adoption across handoff (POD-644), receipts crash
durability (POD-737).

**Cut lines:** behavioral branching on harness identity confined to harness adapters;
identifiers + capability descriptors flow freely (declared data-driven exceptions:
icon maps/pickers). Scar-tissue registry (§7) updated for everything relocated.

**Verification steps (gate POD-426):** binding lifecycle tests green; zero sync/async
twins; harness axiom at error; all-five-agents needs-attention e2e; Codex identity
evidence (`tests/e2e/browser/codex-identity-real.browser.e2e.ts`); receipts SIGKILL→
rebind check; instance-isolation assertion (SP-15aa); 48h remote-daemon soak evidenced
with needs-human set at the gate. `podium issue tree 292`.

### Phase 6 — Client engine split (POD-293) · exit gate POD-427

**Scope:** engine split into transport / replica-binding / actions / router+ui-state /
viewmodel slices (POD-331 → 405–409 and siblings), one ui-state owner, mobile on the
same slices — delete MobileClientValue (POD-332, HUMAN device gate; note: mobile still
wires AsyncStorage replica today, so the SQLite verify is build-and-switch with POD-375),
plus post-freeze leaves POD-646/POD-647.

**Verification steps (gate POD-427):** engine/connection/derive god files gone (audit);
one ui-state owner (lint); render-count probe recorded; offline-first behavior preserved;
mobile device smoke evidenced; bundle within PWA precache limits. `podium issue tree 293`.

### Phase 7 — Final deletions, docs, release (POD-294) · exit/release gate POD-337 (HUMAN)

**Scope:** delete named compatibility shims (POD-333), single-source systemd units +
packaged-install e2e (POD-334), manifest at ERROR level with every legacy lint rule
retired against an equivalent (POD-335), docs rewrite from the per-phase as-built
sections (POD-336), topology closure — shipped layout vs proposal, every deviation
explicit (POD-356), release gate (POD-337): deletion audit at ZERO across the entire
inventory (incl. the expired N/N-1 adapter; the negotiation MECHANISM is permanent and
exempt), quantitative criteria measured against the Phase-2 thresholds, chaos matrix,
all-target packaging with real-binary smoke, file-size report as a review signal with
a named god-object reviewer pass, and the 72h+ fleet soak (HUMAN GATE).

**Verification steps (gate POD-337, HUMAN):** everything above evidenced via issue
artifacts; `podium issue needs-human` set; the deletion audit stays in CI permanently
as a regression tripwire. `podium issue tree 294`.

---

## 9. As-built rule

**Each phase updates the as-built architecture docs at phase close** — current-state
documentation is continuous, not a Phase-7 event. Concretely: the phase's gate
checklist includes "as-built docs updated" (ARCHITECTURE.md and the relevant
`docs/` pages describe the system as it now IS, including any deviation from the ADRs,
which must be documented against ADR 8 topology). POD-336 then rewrites the full doc
set FROM these per-phase sections rather than reconstructing history.
