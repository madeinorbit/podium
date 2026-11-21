/** Adapter-owned context strategies. No family implementation or native names.
 * Family transports carry opaque payloads; only adapters decode and calculate.
 */
import type {
  ContextAvailability,
  ContextCapability,
  ContextDetailResult,
  ContextInvalidationCause,
  ContextRevision,
  ContextSampleIdentity,
} from '@podium/model'
import type { CausalEnvelope, ContextObservation } from '@podium/protocol/daemon'
import type { AcceptedDriverId } from './manifest.js'
import type { Declared } from './transcript-types.js'

/** Explicit/coalesced summary refreshes must be cheap and never generate a
 * model turn. Full detail may count tokens; run only on user demand. Aborting
 * cancels work or ignores its result; a late result never updates a new sample.
 */
export interface ContextReadOptions {
  signal?: AbortSignal
  /** Hard bound, including native IO. Implementations must settle on expiry. */
  timeoutMs: number
}
export interface ContextDetailRequest extends ContextReadOptions {
  sample: ContextSampleIdentity
  /** At most CONTEXT_MAX_ROWS, across the entire attribution tree. */
  maxRows: number
}
export type ContextSummaryReadResult =
  | { status: 'observation'; observation: ContextObservation }
  | { status: 'cancelled' | 'refused'; reason: import('@podium/model').ContextReason }

/** Summary observations are coarse, whole replacements, including explicit
 * clears. They must reach coarse-only readers and snapshot/bootstrap replay;
 * neither subscribing nor reading detail acquires a fine/token watch. A driver
 * retains/reconstructs its last observation through its existing replay owner,
 * while server/client readings remain demand-bound and unsaved. Detail cannot
 * be merged into a different summary. An idle sample does not expire by age.
 */
export interface ContextReader {
  summary(options: ContextReadOptions): Promise<ContextSummaryReadResult>
  detail(request: ContextDetailRequest): Promise<ContextDetailResult>
}

/** Same envelope as all runtime observations, not a second cursor protocol.
 * The envelope describes this observation; a stale payload retains its sample's
 * original time/generation. New summary samples must match the envelope.
 */
export type { ContextObservation } from '@podium/protocol/daemon'

/** An already-owned native transport. `operation` and its response stay opaque
 * to generic code; adapters own request names, paths, parameters and validators.
 * No native child may be launched just to satisfy a detail hover.
 */
export interface ContextProbePort {
  request(operation: unknown, options: ContextReadOptions): Promise<unknown>
}
export interface ContextStrategyInput {
  harness: string
  driver: AcceptedDriverId
  /** Exact primary native session, never a prefix or requested model. */
  nativeSessionId?: string
  revision: ContextRevision
  probe?: ContextProbePort
  /** Bound session lifetime. Abort on disposal/rebind; each adapter also
   * cancels/coalesces pending native reads on its own context boundaries. */
  signal: AbortSignal
  /** Adapter-owned asynchronous publication path for native reads triggered
   * by observe(). Publish after validation/coalescing, without a hover, timer
   * or family selecting native events. Capture native identity/revision before
   * awaiting; discard obsolete reads after invalidation or abort. The sink
   * applies the existing causal/binding/revision admission, then coarse emits
   * and replaces the snapshot as it does for a synchronous observation. */
  publish(observation: ContextObservation): void
}
export interface ContextSessionStrategy extends ContextReader {
  /** Called with every raw native payload before lossy family translation.
   * Adapter selects meaningful native boundaries. A self-contained reading
   * returns synchronously; a boundary requiring async IO schedules/coalesces
   * a probe and publishes via the bound publish callback. Undefined means no
   * synchronous reading, including unrelated input or a scheduled read.
   * Malformed measurements return/publish a reasoned unavailable.
   */
  observe(payload: unknown, causal: CausalEnvelope): ContextObservation | undefined
  /** Bump contextRevision and cancel in-flight detail before returning a clear
   * observation. A timestamp alone cannot clear a compaction/resume fence.
   */
  invalidate(cause: ContextInvalidationCause, causal: CausalEnvelope): ContextObservation
}
export interface HarnessContextStrategy {
  capability: ContextCapability
  /** Adapter extends a family's existing initialization payload. Pass through
   * the returned opaque payload; never import the family into the adapter.
   */
  initialize?(payload: unknown): unknown
  /** Version/field admission on this machine, distinct from session availability.
   * No result here is a session occupancy reading.
   */
  probe(options: ContextReadOptions, port?: ContextProbePort): Promise<ContextAvailability>
  bind(input: ContextStrategyInput): ContextSessionStrategy
}

/** Total for every driver, including unimplemented combinations. The registry
 * keys the section by harness; forDriver keys support by mechanism too.
 */
export interface HarnessContextSection {
  forDriver(driver: AcceptedDriverId): Declared<HarnessContextStrategy>
}

export function declinedContext(reason: string): HarnessContextSection {
  if (reason.trim().length === 0) throw new Error('Context decline needs a reason')
  return { forDriver: () => ({ supported: false, reason }) }
}
