import type {
  MetadataChange,
  MetadataDeltaMessage,
  ServerMessage,
  SessionMeta,
} from '@podium/protocol'
import type { SessionProjectionEvent } from './service.js'

/** Stable identity for publications whose authorization and wire shape are equal. */
export type ViewKey = string & { readonly __viewKey: unique symbol }

export interface ViewKeyParts {
  principal: string
  scope: string
  serverRole: string
  protocolVersion: number
  capabilities: readonly string[]
}

/** Authorization stays in the main authority. The worker receives only its result. */
export interface PublicationView {
  key: ViewKey
  /** Bumped by the authority whenever this view's authorization result changes. */
  revision: number
  allowedSessionIds: readonly string[]
}

export interface PreparePublicationInput {
  view: PublicationView
  /** Null means bootstrap; an uncovered cursor heals through a scoped snapshot. */
  sinceCursor: number | null
}

export interface PreparedPublication {
  viewKey: ViewKey
  viewRevision: number
  generation: number
  ledgerCursor: number
  sourceRange: { fromExclusive: number | null; toInclusive: number }
  kind: 'snapshot' | 'delta'
  /** Encoded once per ViewKey/build so same-view clients can share the bytes. */
  bytes: string
}

export interface SessionProjectionState {
  generation: number
  ledgerCursor: number
  sessions: readonly SessionMeta[]
}

interface JournalPatch {
  fromCursor: number
  event: SessionProjectionEvent
}

interface BuiltView {
  revision: number
  allowedSignature: string
}

export function createViewKey(parts: ViewKeyParts): ViewKey {
  // Cap order is negotiation noise, not view identity. A stable tuple avoids
  // delimiter ambiguity while remaining cheap to compare/map in the main loop.
  return JSON.stringify([
    parts.principal,
    parts.scope,
    parts.serverRole,
    parts.protocolVersion,
    [...new Set(parts.capabilities)].sort(),
  ]) as ViewKey
}

function allowedSignature(ids: readonly string[]): string {
  return JSON.stringify([...new Set(ids)].sort())
}

/**
 * Pure stateful session projection/encoding actor [spec:SP-c29e]. It owns no
 * ledger, funnel, socket, or authorization decision: ordered immutable patches
 * and already-authorized views enter; cursor-tagged prepared bytes leave.
 */
export class SessionPublicationActor {
  private readonly sessions = new Map<string, SessionMeta>()
  private readonly journal: JournalPatch[] = []
  private readonly builtViews = new Map<ViewKey, BuiltView>()
  private readonly journalLimit: number
  private generation = 0
  private ledgerCursor = 0

  constructor(options: { journalLimit?: number } = {}) {
    this.journalLimit = Math.max(1, options.journalLimit ?? 512)
  }

  /** Replace lost worker state from a main-owned authoritative snapshot. */
  reset(state: SessionProjectionState): void {
    if (
      !Number.isInteger(state.generation) ||
      state.generation < 0 ||
      !Number.isInteger(state.ledgerCursor) ||
      state.ledgerCursor < 0
    ) {
      throw new Error('invalid session projection reset state')
    }
    this.sessions.clear()
    for (const value of state.sessions) {
      this.sessions.set(value.sessionId, structuredClone(value))
    }
    this.journal.length = 0
    this.builtViews.clear()
    this.generation = state.generation
    this.ledgerCursor = state.ledgerCursor
  }

  applyPatch(event: SessionProjectionEvent): void {
    const cursorOnlyAdvance =
      event.changes.length === 0 &&
      event.generation === this.generation &&
      event.ledgerCursor > this.ledgerCursor
    if (
      !Number.isInteger(event.generation) ||
      (event.generation <= this.generation && !cursorOnlyAdvance)
    ) {
      throw new Error(
        `session projection generation must increase (${event.generation} <= ${this.generation})`,
      )
    }
    if (!Number.isInteger(event.ledgerCursor) || event.ledgerCursor < this.ledgerCursor) {
      throw new Error(
        `session projection cursor must not regress (${event.ledgerCursor} < ${this.ledgerCursor})`,
      )
    }

    let previousSeq = this.ledgerCursor
    for (const change of event.changes) {
      if (change.entity !== 'session')
        throw new Error('session projection received non-session change')
      if (change.seq <= previousSeq || change.seq > event.ledgerCursor) {
        throw new Error(
          `session projection changes must be ordered through cursor ${event.ledgerCursor}`,
        )
      }
      if (change.op === 'upsert' && change.value === undefined) {
        throw new Error(`session upsert ${change.id} has no value`)
      }
      previousSeq = change.seq
    }

    const fromCursor = this.ledgerCursor
    // Validate the complete event before touching state. Worker failure/restart is
    // recoverable; a half-applied patch would be much harder to reason about.
    for (const change of event.changes) {
      if (change.op === 'remove') this.sessions.delete(change.id)
      else this.sessions.set(change.id, structuredClone(change.value) as SessionMeta)
    }
    this.generation = event.generation
    this.ledgerCursor = event.ledgerCursor
    this.journal.push({
      fromCursor,
      event: {
        generation: event.generation,
        ledgerCursor: event.ledgerCursor,
        changes: structuredClone(event.changes),
      },
    })
    if (this.journal.length > this.journalLimit) {
      this.journal.splice(0, this.journal.length - this.journalLimit)
    }
  }

  prepare(input: PreparePublicationInput): PreparedPublication {
    const allowed = new Set(input.view.allowedSessionIds)
    const signature = allowedSignature(input.view.allowedSessionIds)
    const priorView = this.builtViews.get(input.view.key)
    const oldestCursor = this.journal[0]?.fromCursor ?? this.ledgerCursor
    const viewChanged =
      priorView !== undefined &&
      (priorView.revision !== input.view.revision || priorView.allowedSignature !== signature)
    const cursorCovered =
      input.sinceCursor !== null &&
      input.sinceCursor >= oldestCursor &&
      input.sinceCursor <= this.ledgerCursor
    const canDelta = priorView !== undefined && !viewChanged && cursorCovered
    const sinceCursor = input.sinceCursor

    let kind: PreparedPublication['kind']
    let message: Extract<ServerMessage, { type: 'sessionsChanged' }> | MetadataDeltaMessage
    let fromExclusive: number | null
    if (canDelta && sinceCursor !== null) {
      kind = 'delta'
      fromExclusive = sinceCursor
      const changes: MetadataChange[] = []
      for (const patch of this.journal) {
        if (patch.event.ledgerCursor <= sinceCursor) continue
        for (const change of patch.event.changes) {
          if (change.seq <= sinceCursor || !allowed.has(change.id)) continue
          changes.push(structuredClone(change))
        }
      }
      // The range, not the filtered rows, is the cursor authority. An empty
      // hidden-only frame deliberately advances without revealing an id/count.
      message = {
        type: 'metadataDelta',
        fromExclusive: sinceCursor,
        seq: this.ledgerCursor,
        changes,
      }
    } else {
      kind = 'snapshot'
      fromExclusive = null
      const sessions: SessionMeta[] = []
      for (const [id, value] of this.sessions) {
        if (allowed.has(id)) sessions.push(structuredClone(value))
      }
      message = { type: 'sessionsChanged', sessions }
    }

    this.builtViews.set(input.view.key, {
      revision: input.view.revision,
      allowedSignature: signature,
    })
    return {
      viewKey: input.view.key,
      viewRevision: input.view.revision,
      generation: this.generation,
      ledgerCursor: this.ledgerCursor,
      sourceRange: { fromExclusive, toInclusive: this.ledgerCursor },
      kind,
      bytes: JSON.stringify(message satisfies ServerMessage),
    }
  }
}
