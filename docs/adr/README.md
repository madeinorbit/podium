# ADR pack — architecture rewrite v3 (POD-279)

Status: **Proposed** — the POD-359 human sign-off gate is **suspended** for the autonomous
POD-279 fan-out (`docs/agents/rewrite-fanout-protocol.md` §1); the coordinator records sign-off in
its place, with the tracker-reconciliation evidence below. ADRs 1–8 authored 2026-07-17
against integration tip `ca361327`; ADR 9 and the five amendments authored 2026-07-29 against
tip `2ddfec21`. Source proposal committed at
`docs/proposals/2026-07-10-architecture-redesign.html`; living execution record in
`docs/rearchitecture-v3.md` (the migration ledger).

| ADR | File | Decides |
|---|---|---|
| 1 | [0001-authority-ownership.md](0001-authority-ownership.md) | Ownership matrix: home authority, writers, conflict rule, tombstones, offline + secret class per field/aggregate; InstanceId brand (sole decider) |
| 2 | [0002-sync-protocol.md](0002-sync-protocol.md) | Delta feed, epochs, cursor-vs-revision, bootstrap/chunking, gap heal, wire-version negotiation; outbox-age inequality (value owned by ADR 3) |
| 3 | [0003-command-security.md](0003-command-security.md) | Command contracts L1/L3, principal from transport, apply-time re-auth, three delivery classes, full outbox state machine (`sending`, dead-letter), redaction; outbox max age 14d |
| 4 | [0004-representation-policy.md](0004-representation-policy.md) | One semantic vocabulary; composed projections (storage/live/wire/ports); HandoffManifest as portable-export projection |
| 5 | [0005-peer-topology.md](0005-peer-topology.md) | H1 local peer mesh (authority/console/machine), common framing + role-specific auth, reserved node-peer capabilities, federation seam S1–S5 (hub deferred, SP-0371) |
| 6 | [0006-replica-storage.md](0006-replica-storage.md) | Transactional IndexedDB (web) / SQLite (mobile); outbox survives schema discard; localStorage/AsyncStorage = prefs/fallback only |
| 7 | [0007-plane-inventory.md](0007-plane-inventory.md) | Three planes (control/stream/bulk), command as message class; full message/field inventory incl. handoff (8 types), browser-open, resumeRefAck; relay-separation principle |
| 8 | [0008-package-topology.md](0008-package-topology.md) | Target package/app layout (L0–L4), node/host renames, transcript-core placement; ratifies SP-3b58 resolve-from-source; turbo membership for new packages |
| 9 | [0009-identity-ownership-sharing.md](0009-identity-ownership-sharing.md) | **Identity, ownership and sharing (sole decider).** Principal taxonomy (human / agent-delegated / machine / system); owner, visibility and grants as first-class annotations; the five visibility classes; default-closed with a totality test; agent delegation (live intersection, human ceiling, attribution pair); machines as owned compute (`see`/`use`/`manage`); cross-boundary writes; superagent per-user vs undelegated system principals. **§3 is the pack's canonical open-items list (O1–O6)** |

## Amendments (2026-07-29 — multi-user)

All five encode the human decisions of 2026-07-28/29 recorded in
`docs/multi-user-readiness.md`, and all consume ADR 9's vocabulary rather than redefining it.
Each base ADR carries an **"Amended by"** pointer in its frontmatter; base decision numbers are
never reused or renumbered, and each amendment continues its base document's sequence.

| Amendment | File | Adds | Overturns / amends in the base |
|---|---|---|---|
| ADR 1 Amd 1 (POD-1071) | [0001-authority-ownership-amendment-1.md](0001-authority-ownership-amendment-1.md) | D8–D15 + the matrix filled in for every row (§3, incl. §11 for the classes the amendments introduce) | D4 gains owner / visibility / grants columns; D3's field-LWW inventory shrinks to one member; D2's single-operator *rationale* is void (decision re-ratified); D1's CRDT rejection carved out and `op-stream` reserved; machines become owned compute. **D5 and D6 explicitly unchanged** |
| ADR 2 Amd 1 (POD-1072) | [0002-sync-protocol-amendment-1.md](0002-sync-protocol-amendment-1.md) | D12–D17 (per-principal feed, covered-range watermarks, `evict` op + `rescope` frame, scoped bootstrap, retention re-proof, load-bearing-from-day-one + must-land-before-POD-308) | D2's "the feed stays **unscoped**" clause overturned (its one-feed/one-seq/one-cursor half survives verbatim); the "Per-client feed scoping" Deferred bullet struck. D1, D3, D4, D7–D11 unchanged |
| ADR 3 Amd 1 (POD-1073) | [0003-command-security-amendment-1.md](0003-command-security-amendment-1.md) | D14–D22 + security properties 9–17 | D7's principal table replaced; D8 now resolves a delegation chain; D2's `machine` scope gains see/use/manage; the `IssueScope` closed set gains owner/grant scopes and **reads stop being scope-free**. D1, D3, D5, D6, D9–D13 unchanged; **D10/D11 keep sole ownership of their numbers** |
| ADR 4 Amd 1 (POD-359, integrator) | [0004-representation-policy-amendment-1.md](0004-representation-policy-amendment-1.md) | D8–D10 (`UserId` brand + ownership field group + attribution pair; per-user state as a keyed shape) | D7.3's *rationale* narrows to the slice; the decision itself is unchanged. D2's R1–R6 role set stays closed |
| ADR 7 Amd 1 (POD-1074) | [0007-plane-inventory-amendment-1.md](0007-plane-inventory-amendment-1.md) | D9–D16 (identity-carrying presence, rooms inside the stream port, cursor-rate fan-out, no durable presence, one subscription primitive, visibility-gated joins, inventory extension) | Two cells of D1's port-semantics table restated as per-principal routing. Three planes, D2–D5, D6's totality obligation, D7's eight handoff types and D8 unchanged |

Reconciliation record (pack reviewer + integrator, 2026-07-17): outbox max-age
owned solely by ADR 3 (ADR 2 keeps the inequality); schema-discard vs migrate
composed via ADR 2 D7 outbox-survival + ADR 6 D5.1; ADR 4 handoff count corrected
to eight; wording aligned — ADR 3 message-class table defers to ADR 7 plane
vocabulary, ADR 6 uses ADR 3's `sending`, ADR 1 offline values documented as
projections onto ADR 3's delivery classes, ADR 8 `apps/node` disambiguated from
ADR 5's reserved peer role `node`.

Reconciliation record (integrator, 2026-07-29 — ADR 9 + the five multi-user amendments, written
in parallel by authors who could not see each other's work). Settled between documents:
**(1) The `see`-set boundary.** ADR 9 D6 M5 required unauthorized to be distinguishable from
unreachable; ADR 9 D7 and readiness §3.1.5 require invisible to fail identically to nonexistent.
Read literally they conflict. ADR 3 Amd 1 D18.5's refinement is adopted as the pack's answer —
the distinction holds **inside the principal's `see` set only**, where existence is already
disclosed — and M5 now carries that boundary explicitly, pointing at D18.5 as its owner.
**(2) One owner for the cross-boundary write policy.** ADR 9 D7 owns it; ADR 3 Amd 1 D20 (command
vocabulary, generalisation to every caller-supplied target id, composition with D5 redaction) and
ADR 7 Amd 1 D14.3 (room-join site) are named in D7 as its enforcement sites, so the policy is
stated once and cited twice.
**(3) One canonical open list.** The six documents had recorded four to five open items each, with
two different questions numbered "O5". **ADR 9 §3 is now canonical (O1–O6)**: O1–O4 from readiness
§3.1.2/§3.1.5, **O5** = host-local credentials under a `use` grant (readiness §3.1.4 "Unresolved",
surfaced by ADR 3), **O6** = phase ordering of the one subscription primitive (surfaced by ADR 7
Amd 1 D13; ADR 7's draft numbered it O5 and it is renumbered). Every amendment now records the
subset that raises a question for it, using these numbers, with an explicit note that an omitted
row is silence, not closure. Nothing was answered.
**(4) The instance role set** is ADR 9 D1.4's; ADR 3 Amd 1 D15.1 cites it rather than re-deciding
it, and remains sole owner of the role/ownership composition rule.
**(5) The watermark is not a new frame.** ADR 7 Amd 1 D16.3 classified a watermark family before
ADR 2 Amd 1 D13 decided it is the existing delta frame with an empty change list; D16.3 now
records that call, so ADR 7's inventory gains a row for `rescope` only — `evict` is an enum value
and the watermark is a field.
**(6) Forward references closed.** ADR 2 Amd 1 §4's outstanding items are marked carried: ADR 4's
D7.3 narrowing (its Amd 1 D8) and ADR 7's classification of `rescope` (its Amd 1 D16.3). The
"Per-client feed scoping" Deferred bullet in ADR 2 is physically struck in place, since the
amendment records its trigger as fired.
**(7) Totality applied to the amendments' own classes.** D9's test would have failed on the
aggregates this round creates (User/account, grant edge, delegation record, Telegram binding,
per-user `client_session`), which had no matrix row anywhere. ADR 1 Amd 1 §3 §11 classifies them,
deriving every cell from an existing ADR 9 / ADR 3 decision and routing the one genuine policy
cell — whether the member directory is tenant-visible so grantees can be named — to O1 rather
than guessing.
**(8) Citations verified.** Every `ADR N Dx` reference in the six documents resolves to a decision
that exists; ADR 4's IVM clause is at line 306 (ADR 2's amendment cited 305, corrected in both
places); ADR 1's entity-inventory count is re-verified as 49 and dated in ADR 1 itself, with the
amendment's drift row marked resolved.
**Not multi-tenancy** is stated in all six documents and in every compliance checklist: ADR 1 D5
is **unaffected**, its reserved-columns clause is **not** triggered, and no `instance_id` or
equivalent tenant discriminator may be added anywhere as a consequence of multi-user.

## Tracker reconciliation (2026-07-30, POD-359)

The pack's second acceptance obligation is that contradictions are reconciled **in the tracker**,
not only between ADRs. Swept: POD-279 and every descendant carried in its tree — the six phase
epics (POD-288…POD-293), their children (POD-299…POD-316, POD-352, POD-355, POD-360…POD-421,
POD-423…POD-425, POD-640…POD-645, POD-727…POD-736), and the seven multi-user phase issues
(POD-1075…POD-1081). 103 issues inspected in full.

- **No surviving single-operator contradiction was found.** Every occurrence of *single-operator*,
  *unscoped*, *capability snapshot* and *instance_id* in the subtree is the **corrected** form —
  a rationale being declared void, a firehose declared overturned, a snapshot declared forbidden,
  or the "do NOT add `instance_id`" guard rail. No issue proposes a tenant discriminator.
- **Governing-ADR references added** where a brief cited only `docs/multi-user-readiness.md`:
  POD-360, POD-362, POD-363 (ADR 4 + Amd 1 D8–D10, ADR 7, ADR 9) and POD-730 (ADR 3 + Amd 1,
  ADR 9). POD-861 was inspected and left alone — it is an audit-ratchet issue on the main lineage,
  untouched by the pack.
- **Ordering made schedulable, not advisory.** The must-land-before-POD-308 constraint is stated in
  ADR 2 Amd 1 D17.2, in POD-1077, in POD-308 and in the Phase 2 epic; the `POD-308 → POD-1077`
  dependency edge exists. POD-1077 gained edges on **POD-305** (the Authority defines the injected
  visibility port) and **POD-373** (the parameterised conformance suite that hosts its cases), so
  the scoped feed cannot be scheduled outside the kernel it must land inside. D17.1's three
  conformance cases — grant/revoke mid-session, scoped gap heal, revoked-while-offline-with-queued-
  writes — are carried as Phase-2 **gate conditions** in POD-289, POD-306, POD-373, POD-1077,
  POD-308 and POD-310.
- **Phase wiring verified:** POD-1075/1076 under POD-288, POD-1077 under POD-289, POD-1080 under
  POD-290, POD-1078/1079 under POD-291, POD-1081 under POD-292; each references ADR 9 and its own
  governing ADR.
