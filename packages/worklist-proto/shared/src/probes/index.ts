/**
 * POD-4564 (L6b) — the planted-mistake probe catalogue. How N1b/N2b use it:
 * `docs/plans/pod-pod-4545-round-three-probes.md`.
 */

import { evictIndexCleanup } from './evict-index-cleanup'
import { missingInverse } from './missing-inverse'
import { omittedInput } from './omitted-input'
import type { Probe } from './probe'
import { rowScan } from './row-scan'
import { untrackedState } from './untracked-state'

export * from './probe'
export * from './relations-check'
export * from './run'
export { evictIndexCleanup, missingInverse, omittedInput, rowScan, untrackedState }

/** The five probes, in catalogue order. */
export const PROBES: readonly Probe[] = [
  omittedInput,
  evictIndexCleanup,
  rowScan,
  untrackedState,
  missingInverse,
]
