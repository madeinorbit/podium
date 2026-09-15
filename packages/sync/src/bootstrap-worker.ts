/** Runtime-only bootstrap imports. The root barrel also exports Vitest conformance suites. */
export { GrantEdgeVisibilityPolicy, NoDelegationsGranted, DEVICE_GRADE_PRINCIPAL } from './feed/visibility'
export { SyncRepository } from './adapters/sqlite/sync-repository'
export { scopeChangesRange, DEFAULT_RESCOPE_THRESHOLD } from './authority/scoping'
export { ChangeRangeBootstrapRequired } from './change-log'
