/**
 * @podium/model — the L0 zero-dependency root: every entity defined once.
 *
 * Imports NOTHING but `zod`. That constraint is what makes this the one
 * authoritative definition site rather than another layer that happens to hold
 * some types (Phase 1, POD-288).
 *
 * The directory layout is a decision, not an accident — see README.md. Reserved
 * homes that are intentionally empty today:
 *   - `ids/`         branded ID types (POD-360…363)
 *   - `annotations/` per-field ownership / visibility annotations (POD-304)
 *   - `user-state/`  the per-user state family keyed `(userId, entityId)` (POD-1076)
 * and `identity/` is where POD-1075's `User`/account aggregate and `UserId`
 * brand land, beside the identity predicates already there.
 */

// The one clock representation and its edge adapters (POD-299); the totality guard.
export * from './clock'
export * from './exhaustive'

// Authorization policy — the single enforcement function.
export * from './authz/issue-authz'

// Entity vocabularies.
export * from './entities/issue-color'

// Identity: of repos, worktrees and sessions — and, from POD-1075, of users.
export * from './identity/git-identity'
export * from './identity/session-identity'
export * from './identity/worktree'

// Pure derivations over entity shapes.
export * from './predicates/issue-stage'
export * from './predicates/machine-selection'
export * from './predicates/mobile-entry'
export * from './predicates/session-priority'
export * from './predicates/snooze'
export * from './predicates/sort-key'
