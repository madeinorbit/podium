/**
 * # Event-loop accounting, on the wire
 *
 * The wire form of the records `@podium/runtime/loop-accounting` produces: one
 * decoded second ({@link LoopWindowWire}) and one decoded minute
 * ({@link LoopMinuteWire}). Two readers need them — the daemon's host metrics
 * push carries its latest minute to the server ({@link HostMetricsWire.loop},
 * design §7.1) and `perf.snapshot` carries the server's own rings plus every
 * daemon's latest minute (design §7.2).
 *
 * Spec: `docs/internal/superpowers/specs/2026-09-10-loop-profile-levels-design.md`.
 *
 * ## Why the schemas live HERE and not in `@podium/protocol`
 *
 * `HostMetricsWire` is in this package and `@podium/protocol` depends on
 * `@podium/model`, not the other way round. A schema the host metrics frame
 * embeds therefore cannot live in protocol without inverting that edge.
 * `@podium/protocol`'s `perf.ts` re-exports these so a reader of the perf
 * contract still finds them where the rest of that contract is.
 *
 * ## Why nothing here imports `@podium/runtime`
 *
 * The runtime is the layer ABOVE this one: it holds the rings, the /proc reads
 * and the timer. This package is a leaf of Zod schemas that a browser bundle
 * parses, and pulling the accounting module in to reach four string literals
 * would drag `node:fs` into it. The duplication is deliberate and is the same
 * call `FleetUpdateChannel` in `@podium/runtime/config` already makes in the
 * other direction — with one addition it does not have: a test in
 * `@podium/runtime` (which depends on this package) asserts the two level lists
 * are identical, so a level added on one side and not the other is a red test
 * rather than a minute the server silently refuses to parse.
 *
 * ## Every field is optional that the producer may not have
 *
 * A record is written by a process that may be off Linux (no `/proc`, so no
 * utilization and no runqueue wait) or below `attribution` (no buckets). An
 * absent field means NOT MEASURED HERE; a zero would read as a perfectly idle
 * loop, which is a different and wrong claim.
 */

import { z } from 'zod'

/**
 * The four profiling levels, weakest first — restated from
 * `LOOP_PROFILE_LEVELS` in `@podium/runtime/config` for the reason in this
 * file's header. Order is the semantics on the runtime side (`atLeast` compares
 * indices); here it is only the set of names a record may carry, but the two
 * lists must stay identical and a runtime test asserts it.
 */
export const LoopProfileLevelWire = z.enum(['off', 'accounting', 'attribution', 'full'])
export type LoopProfileLevelWire = z.infer<typeof LoopProfileLevelWire>

/** Which process a record is about. */
export const LoopComponentWire = z.enum(['server', 'daemon'])
export type LoopComponentWire = z.infer<typeof LoopComponentWire>

/** Wall time and call count attributed to one cost bucket. */
export const LoopBucketCostWire = z.object({
  wallMs: z.number().nonnegative(),
  count: z.number().int().nonnegative(),
})
export type LoopBucketCostWire = z.infer<typeof LoopBucketCostWire>

/**
 * Buckets keyed by NAME rather than by an enum restated here.
 *
 * `LOOP_BUCKETS` is the runtime's fixed set and the runtime is the only thing
 * that can fill one. Re-enumerating the names in this package would create a
 * second list that decides whether a record PARSES: a bucket added upstream
 * would make every minute from a newer peer fail here, which is precisely the
 * drop this whole change is written to avoid. A reader that wants to interpret
 * a bucket name looks it up in the runtime; a reader that just carries the
 * record does not need to know the set at all.
 */
const bucketMap = z.record(LoopBucketCostWire)

/** One decoded second. Percentages are 0–100. */
export const LoopWindowWire = z.object({
  /** Epoch ms at the END of the window. */
  at: z.number(),
  utilizationPct: z.number().optional(),
  runqueueWaitPct: z.number().optional(),
  blockedMs: z.number(),
  stalls: z.number(),
  stallMaxMs: z.number(),
  heapUsedBytes: z.number(),
  rssBytes: z.number(),
  selfCostMs: z.number(),
  buckets: bucketMap.optional(),
})
export type LoopWindowWire = z.infer<typeof LoopWindowWire>

/** One decoded minute — the record written to the minute file and sent on the wire. */
export const LoopMinuteWire = z.object({
  /** ISO 8601 timestamp of the minute boundary this record closes. The server
   *  picks the newest per machine by THIS field, never by arrival order. */
  at: z.string(),
  component: LoopComponentWire,
  level: LoopProfileLevelWire,
  utilizationPct: z.number().optional(),
  utilizationMaxPct: z.number().optional(),
  runqueueWaitPct: z.number().optional(),
  blockedPct: z.number(),
  stalls: z.number(),
  stallP50Ms: z.number(),
  stallP99Ms: z.number(),
  stallMaxMs: z.number(),
  heapUsedBytes: z.number(),
  rssBytes: z.number(),
  /** What the accounting module itself cost, as a percentage of the minute. */
  selfCostPct: z.number(),
  /**
   * Profile captures refused this minute because one was already running or the
   * five-minute rate limit had not elapsed. A stall burst that produced one
   * profile and nine refusals is a different situation from one that produced a
   * single profile, and only this says which.
   */
  profileSuppressed: z.number().optional(),
  /**
   * Main-thread ms spent draining the sampling profiler's buffer this minute.
   * Kept apart from `selfCostPct`: that is the accounting timer's cost and is
   * paid at every level above `off`, while this is paid only at `attribution`
   * and only after the process's first capture.
   */
  profilerCostMs: z.number().optional(),
  buckets: bucketMap.optional(),
  /** Bucket sum over busy time. Above 1 is normal — see `nestedBuckets`. */
  coverage: z.number().optional(),
  /**
   * Buckets whose cost is CONTAINED IN another bucket's, so a reader subtracts
   * them before comparing the sum to busy time. `readonly` because the runtime
   * type is `readonly LoopBucket[]` and a mutable array here would refuse the
   * very value the daemon sends.
   */
  nestedBuckets: z.array(z.string()).readonly().optional(),
})
export type LoopMinuteWire = z.infer<typeof LoopMinuteWire>
