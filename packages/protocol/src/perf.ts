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
 */

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
  sessionId: z.string().max(128),
  issueId: z.string().max(128).nullish(),
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
  p99Ms: number
  maxMs: number
  lastMs: number
  /** Sum of op-specific payload bytes, when the op tracks bytes (else 0). */
  totalBytes: number
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
}
