import type { ClientRuntime } from '@podium/client-core/engine'
import type { IssueViewModel } from '@podium/client-core/replica'
import { observable, runInAction } from 'mobx'
import {
  chatInteractions,
  chatMentionIssues,
  chatRecords,
  chatReferenceSessions,
} from './chat-context'
import { CHAT_CONTEXT_ENTITIES } from './chat-context-schema'
import { ChatContextSource } from './chat-context-source'
import { issuePages } from './issue-page'
import {
  MOBILE_SESSION_ENTITIES,
  MOBILE_SESSION_SOURCE_KEY,
  type MobileSessionRows,
} from './mobile-session-schema'
import type { MobxPool } from './pool'
import { SESSION_EXIT_ENTITIES } from './session-exit-schema'
import { createSessionExitSource, SESSION_EXIT_SOURCE_KEY } from './session-exit-source'
import { paneHasSessions, paneSession } from './session-pane'
import { SESSION_PANE_ENTITIES } from './session-pane-schema'
import { SESSION_PANE_SOURCE_KEY, SessionPaneSource } from './session-pane-source'
import { LOADING, type Loaded } from './worklist/rollup'

export function mobileSessionIssue(pool: MobxPool, id: string | undefined): Loaded<IssueViewModel> {
  if (id === undefined) return undefined
  const row = issuePages(pool).issue(id)
  if (!row || row === LOADING || row.deletedAt) return row === LOADING ? LOADING : undefined
  return row
}

export function createMobileSessionReader(pool: MobxPool) {
  return {
    session: (id: string | undefined) => paneSession(pool, id),
    issue: (id: string | undefined) => mobileSessionIssue(pool, id),
    sessions: () => chatReferenceSessions(pool),
    issues: () => chatMentionIssues(pool),
    machines: () => pool.sessionPanes.machines(),
    spawnPending(id: string | undefined): Loaded<boolean> {
      if (id === undefined) return false
      const row = pool.row('sessionPaneWindow', 'window')
      return !row || row === LOADING ? LOADING : !pool.sessionPanes.spawnConfirmed(id)
    },
    spawnPrompt(id: string | undefined): Loaded<string> {
      if (id === undefined) return undefined
      const row = pool.row('mobileSessionWindow', 'window')
      if (!row || row === LOADING) return LOADING
      // POD-5432: the pool's log holds the placeholders while it owns sessions.
      const placeholders = pool.spawnPlaceholders()
      return placeholders !== null
        ? (placeholders.get(id) ?? undefined)
        : row.pendingSpawnPrompts.get(id as never)
    },
    exit(id: string | undefined) {
      if (id === undefined) return undefined
      const row = pool.row('sessionExit', id)
      return !row || row === LOADING ? LOADING : row.kind
    },
    draft(id: string) {
      const row = pool.row('chatDraft', id)
      return !row || row === LOADING ? LOADING : row.text
    },
    question: (id: string) => chatInteractions(pool, id),
    booting(): boolean {
      const window = pool.row('mobileSessionWindow', 'window')
      const sessions = pool.row('chatSessionOrder', 'order'),
        issues = pool.row('chatIssueOrder', 'order')
      if (
        !window ||
        window === LOADING ||
        !sessions ||
        sessions === LOADING ||
        !issues ||
        issues === LOADING
      )
        return true
      return (
        window.cursor === null &&
        sessions.ids.length === 0 &&
        issues.ids.length === 0 &&
        !paneHasSessions(pool) &&
        pool.queries.count('issue') === 0
      )
    },
    conversation(id: string) {
      const held = pool.row('chatHeld', id),
        draft = pool.row('chatDraft', id),
        records = chatRecords(pool, id)
      return {
        records: records.records,
        sends: held && held !== LOADING ? held.sends : [],
        draft: draft && draft !== LOADING ? draft.text : '',
        ready: !!held && held !== LOADING && !!draft && draft !== LOADING && records.pending === 0,
      }
    },
  }
}

/** One borrowed local projection, refreshed in batches. Neither collections
 * nor the legacy derived snapshot arrays are read here. */
export function createMobileSessionSource(owner: ClientRuntime, pool: MobxPool) {
  const reader = createMobileSessionReader(pool)
  const window = observable.box<MobileSessionRows['mobileSessionWindow'] | undefined>(undefined, {
    deep: false,
  })
  let demanded = false,
    scheduled = false,
    disposed = false
  function schedule() {
    if (!demanded || scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (disposed) return
      const pendingSpawnPrompts = owner.getSnapshot().pendingSpawnPrompts
      const cursor = owner.replica.getCursor()
      const previous = window.get()
      runInAction(() => {
        if (
          !previous ||
          previous.cursor !== cursor ||
          previous.pendingSpawnPrompts !== pendingSpawnPrompts
        )
          window.set({ cursor, pendingSpawnPrompts })
      })
    })
  }
  const stops = [owner.subscribe(schedule), owner.replica.subscribeAddressedBatch!(schedule)]
  return {
    read(entity: keyof MobileSessionRows): Loaded<MobileSessionRows[keyof MobileSessionRows]> {
      if (disposed) return LOADING
      if (entity === 'mobileSessionReader') return reader
      demanded = true
      schedule()
      return window.get() ?? LOADING
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const stop of stops) stop()
      runInAction(() => window.set(undefined))
    },
  }
}

export async function attachMobileSessionContext(owner: ClientRuntime, pool: MobxPool) {
  await pool.sources.ensure(
    SESSION_PANE_SOURCE_KEY,
    SESSION_PANE_ENTITIES,
    () => new SessionPaneSource(owner),
  )
  await pool.sources.ensure(SESSION_EXIT_SOURCE_KEY, SESSION_EXIT_ENTITIES, () =>
    createSessionExitSource(owner),
  )
  await pool.sources.ensure(
    'chat-context',
    CHAT_CONTEXT_ENTITIES,
    () => new ChatContextSource(owner, pool),
  )
  return pool.sources.ensure(MOBILE_SESSION_SOURCE_KEY, MOBILE_SESSION_ENTITIES, () =>
    createMobileSessionSource(owner, pool),
  )
}
