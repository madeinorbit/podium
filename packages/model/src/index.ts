/**
 * @podium/model — the L0 zero-dependency root: every entity defined once.
 *
 * Imports NOTHING but `zod`. That constraint is what makes this the one
 * authoritative definition site rather than another layer that happens to hold
 * some types (Phase 1, POD-288).
 *
 * The directory layout is a decision, not an accident — see README.md. Reserved
 * homes that are intentionally empty today:
 *   - `annotations/` per-field ownership / visibility annotations (POD-304)
 *   - `user-state/`  the per-user state family keyed `(userId, entityId)` (POD-1076)
 * and `identity/` is where POD-1075's `User`/account aggregate lands, beside the
 * identity predicates already there — its `UserId` brand is already in `ids/`.
 */

// Authorization policy — the single enforcement function.
export * from './authz/issue-authz'
// The one clock representation and its edge adapters (POD-299); the totality guard.
export * from './clock'
// Entity aggregates, their vocabularies, and their read projections (POD-300 —
// relocated out of @podium/protocol, which now imports them from here and keeps
// only frames). Byte-identical to the pre-move wire; the golden fixtures in
// packages/protocol/src/messages/wire-golden.json are the proof.
export * from './entities/agent'
export * from './entities/automation'
export * from './entities/conversation'
export * from './entities/handoff'
export * from './entities/issue'
export * from './entities/issue-color'
// The per-machine fact group: MachineWire, inventory, host metrics + memory,
// usage + quota, and the repo/worktree/directory wires. One named group because
// everything that is a fact ABOUT a machine inherits that machine's scoping
// (docs/multi-user-readiness.md §3.1.1/§3.1.4) — see the file header.
export * from './entities/machine'
export * from './entities/session'
export * from './entities/transcript'
// The wire-INPUT aliases: the unbranded side of the branded-id boundary, so a
// producer of plain strings has a name for where it stands (POD-361; POD-362 /
// POD-363 retire the uses).
export * from './entities/wire-input'
export * from './exhaustive'

// The SHARED FIELD SCHEMAS (POD-365, 1.4b) — one vocabulary, composed by the
// canonical aggregates and by every representation, never restated. See
// `fields/README.md` for the four rules that keep them useful, in particular
// rule 2: leave room for principal-dependent projection, do not build it.
export * from './fields/attribution'
// The legacy-attribution sweep (POD-1075): every device-level / role-level
// attribution field readiness §3.2 names, with its decided shape and a totality
// check that each names the ONE shared Attribution schema instance.
export * from './fields/attribution-legacy'
// The change-lifecycle vocabulary (POD-305, 2.1). A change exists in three
// distinct phases — staged spec, stored row, sequenced wire delta — and they stay
// distinct TYPES composing one field vocabulary, rather than three restatements
// of one field list. See the file header for why collapsing them is the wrong fix.
export * from './fields/change'
export * from './fields/issue'
export * from './fields/op-stream'
export * from './fields/ownership'
export * from './fields/per-user-key'
export * from './fields/session'

// The per-user state family itself (POD-1076's home). POD-380 seeded the three
// members whose state lives in its own table; `user-state/session-state.ts`
// records which member it deliberately did NOT move, and why.
export * from './user-state/session-state'

// The CANONICAL R1 AGGREGATES (POD-365) — the one definition of what a session
// and an issue ARE, composed from the field groups above plus Ownership and
// Attribution. NOT one universal record: the storage row, the live class, the
// wire projections and the narrow ports stay DISTINCT types that Pick from the
// same vocabulary (ADR 4 D1). `registry.ts` carries the default-closed
// classification obligation, with a fixture aggregate proving it fails.
export * from './aggregates/issue'
export * from './aggregates/registry'
export * from './aggregates/session'

// Identity: of repos, worktrees and sessions — and, from POD-1075, of PEOPLE.
// The User/account aggregate with credential material held in a separate,
// never-replicated shape; the grant edge; the per-user client session; and the
// agent-delegation shape, which defines `(agentIdentity, onBehalfOf, scope)`
// and deliberately carries NO serializable effective capability (ADR 9 D5 A1).
export * from './identity/client-session'
export * from './identity/delegation'
export * from './identity/git-identity'
export * from './identity/grant'
export * from './identity/session-identity'
export * from './identity/user'
export * from './identity/worktree'
// Branded entity ids and the composite-key helpers (POD-361) — re-homed from
// @podium/protocol's ids.ts and planes/principal.ts, both of which named this
// package as their destination. THE single definition site for a brand.
export * from './ids'

// The ownership matrix as DATA (POD-304): the vocabulary, one fully annotated
// row per replicated aggregate / field group, and the Authority-only arbitration
// surface. `annotations/arbitration-direction.test.ts` fails when replica-side
// code imports the arbitration reads — ADR 1 D1's direction, enforced.
export * from './annotations/arbitration'
// POD-643: the no-capability-snapshot audit (ADR 9 D5 A1). Exported because the
// obligation is not handoff's alone — POD-368's audit runs it over every
// retained representation.
export * from './annotations/capability-snapshot'
export * from './annotations/matrix'
export * from './annotations/ownership'

// SETTINGS, SPLIT BY MATRIX ROW (POD-418): the per-user preference aggregate,
// the deployment-substrate one, and the server-owned secrets — which are a keyed
// store whose wire projection is built INDEPENDENTLY and carries presence plus an
// opaque fingerprint, never material. `classification.ts` derives a TOTAL
// path→tier table by walking those shapes, so a leaf that belongs to no tier is
// a missing classification rather than a silent default. `packages/runtime`
// COMPOSES the blob from these bindings and redeclares none of them.
export * from './settings/classification'
export * from './settings/preferences'
export * from './settings/secrets'

// Replica provenance: how a row reached THIS replica (ADR 4 D3.8). Deliberately
// NOT the home for owner / visibility / actor / on-behalf-of — those are durable
// entity truth and must not be droppable at a boundary.
export * from './provenance/envelope'

// Read projections (ADR 4 R4) that more than one workspace must name. Home for
// the shapes the CLI used to hand-copy because `apps/cli` cannot import
// `apps/server` (POD-366). Distinct from the aggregates above by role, not by
// accident — ADR 4 D1 keeps storage / live / wire / read models apart.
export * from './projections/issue-read'
export * from './projections/session-read'

// THE RETAINED-REPRESENTATION REGISTRY (POD-368, closing POD-302) — one entry per
// representation ADR 4 D1 keeps as a distinct type, each carrying its purpose,
// why its semantics differ from the canonical aggregate, what it composes, and a
// declared ADR 9 D3 visibility class checked against ADR 1's matrix. The audit
// items live in `checks.ts` and every one of them FIRES on a planted fixture:
// unclassified, undocumented, per-user singleton, capability snapshot, instance
// partition. `scripts/rearch-audit.ts` closes the loop over the tree.
export * from './representations/checks'
export * from './representations/registry'

// Pure derivations over entity shapes.
export * from './predicates/issue-stage'
export * from './predicates/machine-selection'
export * from './predicates/mobile-entry'
export * from './predicates/session-priority'
export * from './predicates/snooze'
export * from './predicates/sort-key'
