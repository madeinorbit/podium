/**
 * @podium/identity: the shared identity package.
 *
 * One sign-in implementation for the self-hosted server (SQLite) and the cloud
 * (Postgres). Reference: docs/design/people-and-sign-in.md.
 */
export { createIdentityCore } from './core'
export { applyMembership } from './membership/apply'
export { generatedIdentifier, isGeneratedIdentifier } from './secrets'
export * from './types'
