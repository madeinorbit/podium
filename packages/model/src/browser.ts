/**
 * Browser runtime model surface.
 *
 * Audit registries, ownership-matrix data, arbitration policy, and retained-
 * representation checks intentionally remain on the package root only.
 */

export * from './entities/agent'
export * from './entities/automation'
export * from './entities/issue'
export * from './entities/issue-color'
export * from './entities/issue-status'
export * from './entities/machine'
export * from './entities/session'
export * from './entities/transcript'
export * from './entities/wire-input'
export * from './fields/attribution'
export * from './identity/git-identity'
export * from './identity/user'
export * from './ids'
export * from './predicates/agent-computing'
export * from './predicates/idle-verdict'
export * from './predicates/issue-stage'
export * from './predicates/machine-selection'
export * from './predicates/mobile-entry'
export * from './predicates/snooze'
export * from './settings/path-tiers'
export * from './settings/secrets'
export * from './user-state/layout-state'
