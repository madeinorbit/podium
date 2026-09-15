/** Runtime-only bootstrap imports. The root barrel also exports Vitest conformance suites. */
export { GrantEdgeVisibilityPolicy, NoDelegationsGranted, DEVICE_GRADE_PRINCIPAL } from './feed/visibility'
export { scopeChangesRange, DEFAULT_RESCOPE_THRESHOLD } from './authority/scoping'
export { ChangeRangeBootstrapRequired } from './change-log'
