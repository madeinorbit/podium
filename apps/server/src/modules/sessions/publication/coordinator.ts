import type { SessionId, SessionMeta } from '@podium/model'
import {
  CAP_METADATA_DELTA,
  FEED_MESSAGE_TYPES,
  type ServerMessage,
  type SyncChangesSinceResult,
} from '@podium/protocol'
import type { ClientConn, ClientRegistry } from '../../../gateway/client-registry'
import type { WriteFunnel } from '../../funnel'
import { DEPLOYMENT, perf } from '../../perf/registry'
import {
  createViewKey,
  type PreparedPublication,
  type SessionProjectionEvent,
  type SessionProjectionState,
  type PublicationView,
  type ViewKey,
} from '../publish-worker-actor'
import {
  PublicationSupersededError,
  type PublishWorkerClient,
  type PublishWorkerMetrics,
} from '../publish-worker-client'
import type { PublicationAuthority, Session } from '../session'

export interface SessionPublicationMetrics extends PublishWorkerMetrics {
  shadowComparisons: number
  shadowMismatches: number
}

type SnapshotTail = Omit<
  Extract<SyncChangesSinceResult, { kind: 'snapshot' }>,
  'kind' | 'sessions' | 'cursor' | 'feedId' | 'epoch' | 'minAvailableSeq'
>

export interface SessionPublicationPorts {
  clients: ClientRegistry
  worker: PublishWorkerClient
  funnel: WriteFunnel
  shadowCompare: boolean
  generation(): number
  sessions(): ReadonlyMap<SessionId, Session>
  listSessions(): SessionMeta[]
  snapshotTail(): SnapshotTail
}

/** Owns authority-filtered preparation, connection view state, and feed catch-up. */
export class SessionPublicationCoordinator {
  private globalIdsCache?: { generation: number; ids: readonly string[] }
  private shadowComparisons = 0
  private shadowMismatches = 0
  private readonly preparedEncodeCache = new WeakMap<ServerMessage & object, string>()

  constructor(private readonly ports: SessionPublicationPorts) {}

  applyProjection(event: SessionProjectionEvent): void {
    this.ports.worker.applyProjection(event)
  }

  replaceProjection(state: SessionProjectionState): void {
    this.ports.worker.replaceProjection(state)
  }

  stop(): void {
    this.ports.worker.stop()
  }

  refreshClient(id: string): void {
    if (!this.ports.clients.get(id)?.publication) return
    this.schedule()
  }

  metrics(): SessionPublicationMetrics {
    return {
      ...this.ports.worker.metrics(),
      shadowComparisons: this.shadowComparisons,
      shadowMismatches: this.shadowMismatches,
    }
  }

  schedule(options: { includeDeltaCapable?: boolean } = {}): void {
    const includeDeltaCapable = options.includeDeltaCapable ?? true
    type Group = {
      view: PublicationView
      clients: ClientConn[]
      focused: boolean
      allowedSignature: string
      global: boolean
      sinceCursor: number | null
      conflicted: boolean
    }
    const groups = new Map<ViewKey, Group>()
    const sourceCursor = this.ports.worker.sourceCursor()
    for (const client of this.ports.clients.values()) {
      if (!client.publication || client.entityServingRefused) continue
      const descriptor = this.view(client)
      if (!descriptor) continue
      const deltaCapable = client.caps.has(CAP_METADATA_DELTA)
      if (deltaCapable && !includeDeltaCapable) continue
      const matches = this.matches(client, descriptor)
      if (deltaCapable && !matches) this.sendRevocations(client, descriptor)
      if (descriptor.global && deltaCapable && matches) continue
      const sinceCursor =
        deltaCapable && matches ? (client.publicationAccepted?.cursor ?? null) : null
      if (sinceCursor !== null && sinceCursor >= sourceCursor) continue
      const group = groups.get(descriptor.view.key)
      if (group) {
        if (
          group.view.revision !== descriptor.view.revision ||
          group.allowedSignature !== descriptor.allowedSignature ||
          group.global !== descriptor.global
        ) {
          group.conflicted = true
        }
        group.clients.push(client)
        group.focused ||= client.focused !== null
        group.sinceCursor =
          group.sinceCursor === null || sinceCursor === null
            ? null
            : Math.min(group.sinceCursor, sinceCursor)
      } else {
        groups.set(descriptor.view.key, {
          view: descriptor.view,
          clients: [client],
          focused: client.focused !== null,
          allowedSignature: descriptor.allowedSignature,
          global: descriptor.global,
          sinceCursor,
          conflicted: false,
        })
      }
    }

    const ordered = [...groups.values()].sort(
      (left, right) => Number(right.focused) - Number(left.focused),
    )
    for (const group of ordered) {
      if (group.conflicted) {
        console.error('[sessions] conflicting authorization result for equal publication ViewKey')
        continue
      }
      const recipients = group.clients.map((client) => {
        const version = (client.publicationRequestVersion ?? 0) + 1
        client.publicationRequestVersion = version
        client.publicationPending = true
        return { id: client.id, version }
      })
      void this.ports.worker
        .request({ view: group.view, sinceCursor: group.sinceCursor }, { focused: group.focused })
        .then((publication) => {
          this.shadowCompare(publication, group.view)
          perf.record(
            'phase',
            'sessionsBroadcast.workerBytes',
            0,
            DEPLOYMENT,
            publication.bytes.length * recipients.length,
          )
          for (const recipient of recipients) {
            const client = this.ports.clients.get(recipient.id)
            if (!client?.publication || client.publicationRequestVersion !== recipient.version) {
              continue
            }
            if (client.entityServingRefused) continue
            const current = this.view(client)
            if (
              !current ||
              current.view.key !== publication.viewKey ||
              current.view.revision !== publication.viewRevision ||
              current.allowedSignature !== group.allowedSignature
            ) {
              continue
            }
            this.ports.clients.deliverPrepared(client, publication.bytes)
            client.publicationBootstrapped = true
            client.publicationPending = false
            client.publicationAccepted = {
              viewKey: publication.viewKey,
              viewRevision: publication.viewRevision,
              allowedSignature: group.allowedSignature,
              cursor: publication.ledgerCursor,
              allowedSessionIds: current.global ? [] : [...current.view.allowedSessionIds],
            }
            client.publicationReplacementRequired = false
            client.publicationRevokedSessionIds = undefined
            if (current.global && client.caps.has(CAP_METADATA_DELTA)) {
              const buffered = client.publicationBufferedChanges?.splice(0) ?? []
              for (const changes of buffered) {
                const last = changes.at(-1)
                if (!last) continue
                this.ports.clients.deliverPrepared(
                  client,
                  JSON.stringify({
                    type: 'metadataDelta',
                    seq: last.seq,
                    changes,
                  } satisfies ServerMessage),
                )
              }
            }
          }
        })
        .catch((error) => {
          if (error instanceof PublicationSupersededError) return
          for (const recipient of recipients) {
            const client = this.ports.clients.get(recipient.id)
            if (client?.publicationRequestVersion === recipient.version) {
              client.publicationPending = false
            }
          }
          console.warn('[sessions] prepared publication failed', error)
        })
    }
  }

  prioritize(): void {
    const focused = new Set<ViewKey>()
    for (const client of this.ports.clients.values()) {
      if (client.focused === null) continue
      const descriptor = this.view(client)
      if (descriptor) focused.add(descriptor.view.key)
    }
    this.ports.worker.prioritize(focused)
  }

  onFeedPublished(seq: number): void {
    const hasPublicationClient = [...this.ports.clients.values()].some(
      (client) => client.publication && client.caps.has(CAP_METADATA_DELTA),
    )
    if (!hasPublicationClient) return
    this.ports.worker.advanceCursor(seq)
    this.schedule()
  }

  deliver(client: ClientConn, message: ServerMessage): void {
    if (client.entityServingRefused) return
    const publication = client.publication
    if (message.type === 'metadataDelta') {
      if (!publication) {
        this.ports.clients.deliver(client, message)
        return
      }
      if (!publication.global) return
      const current = this.view(client)
      if (!current || client.publicationPending || !this.matches(client, current)) {
        const buffered = client.publicationBufferedChanges ?? []
        if (buffered.length >= 512) buffered.shift()
        buffered.push(structuredClone(message.changes))
        client.publicationBufferedChanges = buffered
        return
      }
      this.ports.clients.deliverPrepared(client, this.encode(message))
      return
    }
    if (publication !== undefined && !publication.global && isFeedFrameMessage(message)) {
      throw new Error(
        `sessions: a wire-v2 '${message.type}' frame reached a SCOPED publication connection, whose ` +
          'filtering lives in the prepared-publication worker and does not cover it. Serving it ' +
          'would hand that connection the global feed (ADR 2 Am1 D12.7).',
      )
    }
    if (publication && (message.type === 'sessionsChanged' || !publication.global)) return
    this.ports.clients.deliver(client, message)
  }

  syncChangesSince(
    cursor: number | null,
    authority?: PublicationAuthority,
  ): SyncChangesSinceResult {
    const sourceCursor = this.ports.funnel.cursor()
    const { feedId, epoch } = this.ports.funnel.feedIdentity()
    const identity = { feedId, epoch, minAvailableSeq: this.ports.funnel.minAvailableSeq() }
    if (authority && !authority.global) {
      const allowed = new Set(authority.snapshot().allowedSessionIds)
      return {
        kind: 'snapshot',
        sessions: this.ports.listSessions().filter((session) => allowed.has(session.sessionId)),
        issues: [],
        issueProjections: [],
        issueDeps: [],
        repos: [],
        conversations: [],
        automations: [],
        automationRuns: [],
        diagnostics: [],
        cursor: sourceCursor,
        ...identity,
      }
    }
    const changes = this.ports.funnel.changesSince(cursor)
    if (changes) return { kind: 'delta', changes, cursor: sourceCursor, ...identity }
    return {
      kind: 'snapshot',
      sessions: this.ports.listSessions(),
      ...this.ports.snapshotTail(),
      cursor: sourceCursor,
      ...identity,
    }
  }

  private globalIds(): readonly string[] {
    const generation = this.ports.generation()
    if (this.globalIdsCache?.generation === generation) return this.globalIdsCache.ids
    const ids = [...this.ports.sessions().keys()].sort()
    this.globalIdsCache = { generation, ids }
    return ids
  }

  private view(
    client: ClientConn,
  ): { view: PublicationView; allowedSignature: string; global: boolean } | undefined {
    const authority = client.publication
    if (!authority) return undefined
    let snapshot: ReturnType<PublicationAuthority['snapshot']>
    try {
      snapshot = authority.snapshot()
    } catch (error) {
      console.error('[sessions] publication authority snapshot failed', error)
      return undefined
    }
    return {
      view: {
        key: createViewKey({
          principal: authority.principal,
          scope: authority.scope,
          serverRole: authority.serverRole,
          protocolVersion: authority.protocolVersion,
          capabilities: [...client.caps],
        }),
        revision: snapshot.revision,
        allowedSessionIds: authority.global ? this.globalIds() : snapshot.allowedSessionIds,
      },
      allowedSignature: authority.global ? 'global' : snapshot.allowedSignature,
      global: authority.global,
    }
  }

  private matches(
    client: ClientConn,
    descriptor: { view: PublicationView; allowedSignature: string },
  ): boolean {
    const accepted = client.publicationAccepted
    return (
      !client.publicationReplacementRequired &&
      accepted !== undefined &&
      accepted.viewKey === descriptor.view.key &&
      accepted.viewRevision === descriptor.view.revision &&
      accepted.allowedSignature === descriptor.allowedSignature
    )
  }

  private sendRevocations(
    client: ClientConn,
    descriptor: { view: PublicationView; allowedSignature: string; global: boolean },
  ): void {
    const accepted = client.publicationAccepted
    if (!client.publication || descriptor.global || !accepted) return
    if (
      accepted.viewKey === descriptor.view.key &&
      accepted.viewRevision === descriptor.view.revision &&
      accepted.allowedSignature === descriptor.allowedSignature
    ) {
      return
    }
    const allowed = new Set(descriptor.view.allowedSessionIds)
    const alreadyRemoved = client.publicationRevokedSessionIds ?? new Set<string>()
    const removedSessionIds = accepted.allowedSessionIds.filter(
      (sessionId) => !allowed.has(sessionId) && !alreadyRemoved.has(sessionId),
    )
    if (removedSessionIds.length === 0) return
    this.ports.clients.deliverPrepared(
      client,
      JSON.stringify({ type: 'sessionViewDelta', removedSessionIds } satisfies ServerMessage),
    )
    for (const sessionId of removedSessionIds) alreadyRemoved.add(sessionId)
    client.publicationRevokedSessionIds = alreadyRemoved
    client.publicationReplacementRequired = true
  }

  private shadowCompare(publication: PreparedPublication, view: PublicationView): void {
    if (!this.ports.shadowCompare) return
    this.shadowComparisons += 1
    const allowed = new Set(view.allowedSessionIds)
    let legacy: ServerMessage | undefined
    if (publication.kind === 'snapshot') {
      legacy = {
        type: 'sessionsChanged',
        sessions: this.ports.listSessions().filter((session) => allowed.has(session.sessionId)),
      }
    } else {
      const fromExclusive = publication.sourceRange.fromExclusive
      const source = fromExclusive === null ? null : this.ports.funnel.changesSince(fromExclusive)
      if (fromExclusive !== null && source) {
        legacy = {
          type: 'metadataDelta',
          fromExclusive,
          seq: publication.sourceRange.toInclusive,
          changes: source.filter(
            (change) =>
              change.seq <= publication.sourceRange.toInclusive &&
              change.entity === 'session' &&
              allowed.has(change.id),
          ),
        }
      }
    }
    if (legacy && JSON.stringify(legacy) === publication.bytes) return
    this.shadowMismatches += 1
    console.error('[sessions] publication shadow mismatch', {
      viewKey: publication.viewKey,
      kind: publication.kind,
      generation: publication.generation,
      ledgerCursor: publication.ledgerCursor,
    })
  }

  private encode(message: ServerMessage): string {
    const cached = this.preparedEncodeCache.get(message)
    if (cached !== undefined) return cached
    const encoded = JSON.stringify(message)
    this.preparedEncodeCache.set(message, encoded)
    return encoded
  }
}

function isFeedFrameMessage(message: ServerMessage): boolean {
  return (FEED_MESSAGE_TYPES as readonly string[]).includes(message.type)
}
