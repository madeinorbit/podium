/**
 * Switch-latency instrumentation wire contract [POD-701].
 *
 * Shared by web (emits client switch traces, reads snapshots) and server
 * (aggregates request/broadcast timings, ingests client traces). All timing
 * numbers are milliseconds. Client mark offsets are relative to the trace's
 * t0 (the user gesture that initiated the switch).
 *
 * STABILITY: metric/phase names and this wire shape are load-bearing beyond
 * this feature — the architecture-rewrite quantitative gates (POD-736, for
 * POD-310/POD-337) A/B-compare switch latency across the wire cutover using
 * these exact names. Rename or reshape only with a migration story for the
 * recorded baselines.
 *
 * ---------------------------------------------------------------------------
 * THE CUTOVER (POD-736): STABLE IS NOT FROZEN, AND THE RENAME CARRIES A MAP
 * ---------------------------------------------------------------------------
 *
 * POD-308/POD-1203 deleted the internal snapshot pipeline the `sessionsBroadcast.*`
 * phases were NAMED after. A phase name whose pipeline no longer exists has two
 * dishonest options — keep the name over different work (a baseline that silently
 * compares two different things) or drop it (a baseline with no successor). This
 * contract takes the third: the successor phases are named for the path that
 * actually runs, and {@link PHASE_MIGRATION} is the machine-readable map from
 * each retired name to it, so a recorded POD-701 baseline can still be read
 * against a post-cutover sample by a reader that has never seen either pipeline.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY SAMPLE CARRIES A PRINCIPAL AND A SLICE SIZE (POD-1077)
 * ---------------------------------------------------------------------------
 *
 * After the cutover the feed is PER-PRINCIPAL: a client receives its own scoped
 * slice, not the world. A p50 measured over the whole feed and a p50 measured
 * over one person's slice are not the same measurement, and comparing them
 * reports a speedup that is really a smaller working set. That failure is not
 * prevented by remembering to write the slice size down — it is prevented by
 * {@link PerfPrincipalSlice}, which cannot hold a summary without also holding
 * the principal it was measured for and the size of that principal's slice.
 *
 * The pre-existing top-level `rpc`/`phases` maps are DELIBERATELY unchanged and
 * un-rescoped: they are the shape the recorded POD-701 samples are in, and a
 * historical baseline must stay readable. The dimensions are ADDED beside them.
 */

import { IssueIdField, SessionIdField } from '@podium/model'
import { z } from 'zod'

/** One named point in a client switch trace, offset from gesture t0. */
export const switchMarkSchema = z.object({
  name: z.string().max(64),
  atMs: z.number(),
})
export type SwitchMark = z.infer<typeof switchMarkSchema>

/**
 * A completed client-side switch trace: one user gesture that changed the
 * focused session/issue, with everything observed until the view quiesced
 * (chat first paint + terminal ready, or timeout).
 */
export const clientSwitchTraceSchema = z.object({
  switchId: z.string().max(64),
  /** Epoch ms of the initiating gesture. */
  startedAt: z.number(),
  sessionId: z.string().max(128).pipe(SessionIdField),
  issueId: z.string().max(128).pipe(IssueIdField).nullish(),
  /** Which view the panel landed in when the trace completed. */
  mode: z.enum(['chat', 'native', 'unknown']),
  /** True when the panel had to mount cold (not in the warm set). */
  cold: z.boolean(),
  /** Gesture → quiesce. Equal to the largest mark offset unless timed out. */
  totalMs: z.number(),
  /** True when the trace ended by timeout rather than quiescence. */
  timedOut: z.boolean(),
  marks: z.array(switchMarkSchema).max(200),
  /** Free-form counters: transcript items/bytes, replay bytes, rows built… */
  meta: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
})
export type ClientSwitchTrace = z.infer<typeof clientSwitchTraceSchema>

/** Rolling latency summary for one instrumented server operation. */
export interface PerfOpSummary {
  count: number
  p50Ms: number
  p90Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  lastMs: number
  /** Sum of op-specific payload bytes, when the op tracks bytes (else 0). */
  totalBytes: number
}

/**
 * Retired phase name → the delta-feed phase that carries its meaning (POD-736).
 *
 * THE MIGRATION STORY THE STABILITY NOTE REQUIRES, as data rather than prose, so
 * a baseline reader resolves it instead of a human remembering it. Read it as:
 * *a `sessionsBroadcast.X` sample recorded before the cutover is comparable to a
 * `PHASE_MIGRATION.sessionsBroadcast.X` sample recorded after it.*
 *
 * `sessionsBroadcast.publishIssues` and `.publishIssuesSkipped` are absent ON
 * PURPOSE and that absence is a claim: those two name work that still runs under
 * its own name (the issue-projection rebuild), so they are CARRIED OVER rather
 * than migrated and a map entry would assert a rename that did not happen.
 */
export const PHASE_MIGRATION: Readonly<Record<string, string>> = {
  /** Building the payload a client gets → evaluating the principal's slice. */
  'sessionsBroadcast.list': 'feedPublish.scope',
  /** Serializing it → framing it per connection (fromSeq, watermark, queue). */
  'sessionsBroadcast.stringify': 'feedPublish.frame',
  /** Walking the connections → draining each connection's certified frames. */
  'sessionsBroadcast.fanout': 'feedPublish.fanout',
  /** Reconcile-before-publish → the Authority's own append ordering. */
  'sessionsBroadcast.reconcile': 'feedPublish.scope',
  /** One whole publish, gesture-adjacent → one whole coalesced feed publish. */
  'sessionsBroadcast.total': 'feedPublish.total',
}

/**
 * WHICH PRINCIPAL a set of samples was measured for, and how big its slice was.
 *
 * `principal` is a DIGEST, never the principal id itself: an agent principal is
 * keyed by its session id (`principalIdOf`), and a session id in a
 * deployment-wide diagnostic read by another principal is exactly the
 * cross-principal leak this harness must not become. `kind` is kept in the clear
 * because it is a property of the transport, not of a person.
 */
export interface PerfPrincipalRef {
  /** Stable, non-identifying digest of `principalIdOf(principal)`. */
  digest: string
  kind: 'user' | 'agent'
}

/** How large the principal's visible world was while these samples were taken. */
export interface PerfSliceSize {
  /** Rows the Authority evaluated as visible at this principal's last bootstrap. */
  last: number
  min: number
  max: number
  /** Bootstraps observed. 0 means NO slice was ever measured — read `last` as
   *  unknown rather than as an empty world, which is a different claim. */
  samples: number
}

/**
 * One principal's partition of the registry.
 *
 * THE PARTITION IS THE MECHANISM, not a reporting convenience. Traces carry
 * session and issue ids, so a single shared ring is a structure in which one
 * principal's identifiers are already mixed into another's read; partitioning at
 * record time means a scoped read is expressible by SELECTION rather than by a
 * filter someone has to remember to apply.
 */
export interface PerfPrincipalSlice {
  principal: PerfPrincipalRef
  sliceSize: PerfSliceSize
  rpc: Record<string, PerfOpSummary>
  phases: Record<string, PerfOpSummary>
  clientSwitches: ClientSwitchTrace[]
}

/** Snapshot returned by perf.snapshot: everything needed to read a switch. */
export interface PerfSnapshot {
  /** Per tRPC procedure path, e.g. "sessions.transcriptRead". */
  rpc: Record<string, PerfOpSummary>
  /** Named internal server phases, e.g. "broadcastSessions.stringify". */
  phases: Record<string, PerfOpSummary>
  /** Most recent client switch traces, newest last (bounded ring). */
  clientSwitches: ClientSwitchTrace[]
  /** Epoch ms the server-side registry was last reset. */
  sinceAt: number
  /**
   * The SAME samples, partitioned by the principal they were measured for, with
   * that principal's slice size (POD-736 / POD-1077). Keyed by
   * {@link PerfPrincipalRef.digest}.
   *
   * A comparison drawn from the top-level maps across the cutover does not
   * control for slice size and is INVALID rather than noisy; this is where a
   * valid, same-principal comparison comes from.
   */
  byPrincipal: Record<string, PerfPrincipalSlice>
}
