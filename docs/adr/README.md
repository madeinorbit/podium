# ADR pack — architecture rewrite v3 (POD-279)

Status: **Proposed** — pending human sign-off at the POD-359 gate. Authored 2026-07-17
against integration tip `ca361327`; source proposal committed at
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

Reconciliation record (pack reviewer + integrator, 2026-07-17): outbox max-age
owned solely by ADR 3 (ADR 2 keeps the inequality); schema-discard vs migrate
composed via ADR 2 D7 outbox-survival + ADR 6 D5.1; ADR 4 handoff count corrected
to eight; wording aligned — ADR 3 message-class table defers to ADR 7 plane
vocabulary, ADR 6 uses ADR 3's `sending`, ADR 1 offline values documented as
projections onto ADR 3's delivery classes, ADR 8 `apps/node` disambiguated from
ADR 5's reserved peer role `node`.
