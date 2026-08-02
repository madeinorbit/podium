import type { PlaneTarget } from './control-port'
import type { PlaneClass } from './plane'
import type { VisibilityResolver } from './principal'

/**
 * THE BULK PORT — ADR 7 D1: the paged port. Large, paged, lazy transfers on
 * their own channel; NEVER fanned out and never oplog-replayed as entity rows.
 *
 * Deliberately narrow: it has no `publish`, no subscription registry use and no
 * routing set, because a bulk read is point-to-point and lazy on demand. The
 * standing paged channels today are the transcript reads
 * (`transcriptSubscribe`/`transcriptRead`/`transcriptMirrorRead`) and the large
 * HTTP file/asset/artifact reads.
 *
 * Handoff and workspace chunk frames use bulk MECHANICS (offset/length, multi-MB
 * caps, no oplog fan-out of chunk bytes) but are control · command, not this
 * port (ADR 7 D7): they are directed, correlated RPCs inside an export/import
 * state machine, not a standing subscription. Splitting that state machine
 * across two ports would lose requestId correlation as its primary contract.
 */

/**
 * A bulk-channel resource — NOT an {@link EntityRef}.
 *
 * Transcript pages, file bodies, and artifact bytes are paged streams. They are
 * not rows in the entity set and must not share the model `EntityRef` name
 * (POD-1134: two same-named types for one concept is the drift the single-home
 * rule stops). Visibility still consults `{ kind, id }` structurally; the kind
 * space here is bulk-owned (`transcript`, file/asset ids, …), not
 * `ENTITY_KINDS`.
 */
export interface BulkResourceRef {
  readonly kind: string
  readonly id: string
}

export interface BulkPage {
  readonly offset: number
  readonly limit: number
}

export interface BulkChunk<B = Uint8Array | string> {
  readonly resource: BulkResourceRef
  readonly offset: number
  readonly bytes: B
  readonly eof: boolean
}

export interface BulkPortDeps<B = Uint8Array | string> {
  readonly visibility: VisibilityResolver
  /** Feature-owned reader. The port owns paging policy, not content. */
  readonly read: (resource: BulkResourceRef, page: BulkPage) => Promise<BulkChunk<B>>
  /** Largest single response this channel will serve. */
  readonly maxChunkBytes: number
}

export interface BulkPort<B = Uint8Array | string> {
  readonly planeClasses: readonly PlaneClass[]
  read(target: PlaneTarget, resource: BulkResourceRef, page: BulkPage): Promise<BulkChunk<B> | null>
}

export class BulkPlanePort<B = Uint8Array | string> implements BulkPort<B> {
  readonly planeClasses = ['bulk.bulk'] as const

  constructor(private readonly deps: BulkPortDeps<B>) {}

  /**
   * Point-to-point paged read. Carries the principal on the delivery path and
   * evaluates no policy of its own: an unreadable resource and a nonexistent one
   * answer identically (`null`), the same consistent-error posture the stream
   * port takes on a refused join (readiness §3.1.5).
   */
  async read(
    target: PlaneTarget,
    resource: BulkResourceRef,
    page: BulkPage,
  ): Promise<BulkChunk<B> | null> {
    if (this.deps.visibility.canSee(target.principal, resource) !== true) return null
    if (page.limit <= 0 || page.limit > this.deps.maxChunkBytes) return null
    if (page.offset < 0) return null
    return await this.deps.read(resource, page)
  }
}
