/** Historical corpus types; fixture time is separate from runtime selection locals. */
import type { SliceLocals as RuntimeLocals } from '@podium/client-graph/shared/slice-types'
export type * from '@podium/client-graph/shared/slice-types'
export type SliceLocals = RuntimeLocals & { coarseNow: number }
