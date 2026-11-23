/** Runtime-only bootstrap imports. The root barrel also exports Vitest conformance suites. */

export {
  DEFAULT_RESCOPE_THRESHOLD,
  FEED_RESCOPE_THRESHOLD,
  scopeChangesRange,
} from './authority/scoping'
export { ChangeRangeBootstrapRequired } from './change-log'
export {
  DEVICE_GRADE_PRINCIPAL,
  GrantEdgeVisibilityPolicy,
  NoDelegationsGranted,
  shapedValue,
} from './feed/visibility'
