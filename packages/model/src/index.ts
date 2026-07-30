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
// Identity: of repos, worktrees and sessions — and, from POD-1075, of users.
export * from './identity/git-identity'
export * from './identity/session-identity'
export * from './identity/worktree'
// Branded entity ids and the composite-key helpers (POD-361) — re-homed from
// @podium/protocol's ids.ts and planes/principal.ts, both of which named this
// package as their destination. THE single definition site for a brand.
export * from './ids'

// Pure derivations over entity shapes.
export * from './predicates/issue-stage'
export * from './predicates/machine-selection'
export * from './predicates/mobile-entry'
export * from './predicates/session-priority'
export * from './predicates/snooze'
export * from './predicates/sort-key'
