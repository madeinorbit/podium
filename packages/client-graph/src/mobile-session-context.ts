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
import { createFieldInputs } from './shared/field-inputs'
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
  const inputs = createFieldInputs<MobileSessionRows['mobileSessionWindow']>(
    ['cursor', 'pendingSpawnPrompts'],
    {},
    'mobileSessionWindow',
  )
  const window = observable.box<MobileSessionRows['mobileSessionWindow'] | undefined>(undefined, {
    deep: false,
  })
  let demanded = false,
    scheduled = false,
    disposed = false
  const pending = new Set<keyof MobileSessionRows['mobileSessionWindow']>()
  function schedule(key: keyof MobileSessionRows['mobileSessionWindow']) {
    if (!demanded || disposed) return
    pending.add(key)
    if (!demanded || scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (disposed) return
      const keys = [...pending]
      pending.clear()
      runInAction(() => {
        for (const key of keys) {
          if (key === 'cursor') inputs.set(key, owner.replica.getCursor())
          else inputs.set(key, owner.readLocal(key))
        }
        if (window.get() === undefined) window.set(inputs.row)
      })
    })
  }
  // Keyed (POD-5433): the spawn prompts local and the cursor signal.
  if (!owner.replica.subscribeCursor)
    throw new Error('Phone session context requires the replica cursor signal')
  const stops = [
    owner.onLocals(['pendingSpawnPrompts'], () => schedule('pendingSpawnPrompts')),
    owner.replica.subscribeCursor(() => schedule('cursor')),
  ]
  return {
    read(entity: keyof MobileSessionRows): Loaded<MobileSessionRows[keyof MobileSessionRows]> {
      if (disposed) return LOADING
      if (entity === 'mobileSessionReader') return reader
      if (!demanded) {
        demanded = true
        schedule('cursor')
        schedule('pendingSpawnPrompts')
      }
      return window.get() ?? LOADING
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const stop of stops) stop()
      pending.clear()
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
