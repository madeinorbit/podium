import {
  type MetadataDeltaMessageLenient,
  parseChangesSinceResult,
  type SyncChangesSinceResultLenient,
} from '@podium/protocol'
import type {
  LegacyFeedSinkPort,
  LegacyMetadataProjection,
  LegacyMetadataProjectionPort,
} from '../socket-transport/legacy-feed-port'

export interface LegacyMetadataAppliedState extends LegacyMetadataProjection {
  cursor: number
  feedId?: string
  epoch?: string
  minAvailableSeq?: number
}

/**
 * Compatibility consumer for the retired wire-v1 metadata feed.
 *
 * This lives beside the Replica, not in socket transport: it owns the legacy
 * position, gap detection, catch-up and feed-identity stamp. SocketHub hands it
 * envelopes through an opaque port and receives only projection operations.
 */
export interface LegacyWireV1FeedHooks {
  fetchChangesSince(cursor: number | null): Promise<SyncChangesSinceResultLenient>
  initialCursor?: number | null
  applied(state: LegacyMetadataAppliedState): void
}

const HEAL_RETRY_MS = 3_000

export class LegacyWireV1Feed implements LegacyFeedSinkPort {
  private cursor: number | null = null
  private readonly stamp: { feedId?: string; epoch?: string; minAvailableSeq?: number } = {}
  private initialCursorSpent = false
  private pending: MetadataDeltaMessageLenient[] = []
  private healing = false
  private connectedFlag = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private projection: LegacyMetadataProjectionPort | undefined

  constructor(private readonly hooks: LegacyWireV1FeedHooks) {}

  bind(projection: LegacyMetadataProjectionPort): void {
    this.projection = projection
  }

  seed(projection: LegacyMetadataProjection): void {
    if (this.cursor === null) this.target().replace(projection)
  }

  connected(): void {
    this.connectedFlag = true
    this.heal()
  }

  disconnected(): void {
    this.connectedFlag = false
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.pending = []
  }

  dispose(): void {
    this.disconnected()
  }

  frame(frame: MetadataDeltaMessageLenient, dropped = 0): void {
    this.noteStamp(frame)
    if (dropped > 0) {
      this.heal()
      return
    }
    if (this.healing || this.cursor === null) {
      this.pending.push(frame)
      if (!this.healing && this.retryTimer === undefined) this.heal()
      return
    }
    if (this.applyDelta(frame)) this.publishApplied()
    else this.heal()
  }

  private noteStamp(stamp: { feedId?: string; epoch?: string; minAvailableSeq?: number }): void {
    if (stamp.feedId !== undefined) this.stamp.feedId = stamp.feedId
    if (stamp.epoch !== undefined) this.stamp.epoch = stamp.epoch
    if (stamp.minAvailableSeq !== undefined) this.stamp.minAvailableSeq = stamp.minAvailableSeq
  }

  private applyDelta(frame: MetadataDeltaMessageLenient): boolean {
    const cursor = this.cursor as number
    if (frame.seq <= cursor) return true

    if (frame.fromExclusive !== undefined) {
      if (frame.fromExclusive > cursor) return false
      const fresh = frame.changes.filter((change) => change.seq > cursor)
      let previous = cursor
      for (const change of fresh) {
        if (change.seq <= previous || change.seq > frame.seq) return false
        previous = change.seq
      }
      if (fresh.length > 0) this.target().apply(fresh)
      this.cursor = frame.seq
      return true
    }

    const fresh = frame.changes.filter((change) => change.seq > cursor)
    if (fresh.length === 0) return true
    if (fresh[0]?.seq !== cursor + 1) return false
    this.target().apply(fresh)
    this.cursor = frame.seq
    return true
  }

  private heal(): void {
    if (this.healing) return
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }

    this.healing = true
    const since =
      this.cursor ?? (this.initialCursorSpent ? null : (this.hooks.initialCursor ?? null))
    this.initialCursorSpent = true

    const fetchValidated = async (): Promise<SyncChangesSinceResultLenient> => {
      const first = parseChangesSinceResult(await this.hooks.fetchChangesSince(since), {
        fromCursor: since,
      })
      if (first !== null) return first
      if (since !== null) {
        const snapshot = parseChangesSinceResult(await this.hooks.fetchChangesSince(null))
        if (snapshot !== null && snapshot.kind === 'snapshot') return snapshot
      }
      throw new Error('malformed changesSince result')
    }

    fetchValidated().then(
      (result) => {
        this.healing = false
        this.noteStamp(result)
        if (result.kind === 'snapshot') {
          this.target().replace(projectionOf(result))
        } else if (result.changes.length > 0) {
          this.target().apply(result.changes.filter((change) => change.seq > (this.cursor ?? 0)))
        }
        this.cursor = result.cursor

        const queued = this.pending.splice(0)
        for (let index = 0; index < queued.length; index++) {
          const frame = queued[index] as MetadataDeltaMessageLenient
          if (!this.applyDelta(frame)) {
            this.pending = queued.slice(index)
            this.heal()
            return
          }
        }
        this.publishApplied()
      },
      () => {
        this.healing = false
        this.pending = []
        if (this.connectedFlag && this.retryTimer === undefined) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined
            this.heal()
          }, HEAL_RETRY_MS)
        }
      },
    )
  }

  private publishApplied(): void {
    if (this.cursor !== null) {
      this.hooks.applied({ cursor: this.cursor, ...this.target().snapshot(), ...this.stamp })
    }
  }

  private target(): LegacyMetadataProjectionPort {
    if (this.projection === undefined) {
      throw new Error('LegacyWireV1Feed must be bound to a projection port before use')
    }
    return this.projection
  }
}

const projectionOf = (
  snapshot: Extract<SyncChangesSinceResultLenient, { kind: 'snapshot' }>,
): LegacyMetadataProjection => ({
  sessions: snapshot.sessions,
  issues: snapshot.issues,
  issueProjections: snapshot.issueProjections ?? [],
  issueDeps: snapshot.issueDeps ?? [],
  repos: snapshot.repos ?? [],
  conversations: snapshot.conversations,
  automations: snapshot.automations ?? [],
  automationRuns: snapshot.automationRuns ?? [],
})
