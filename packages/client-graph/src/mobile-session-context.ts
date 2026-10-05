import type { ClientRuntime } from '@podium/client-core/engine'
import type { IssueViewModel } from '@podium/client-core/replica'
import { asIssueId, type MachineWire } from '@podium/model/browser'
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
    /** The phone header/menu needs identity and lifecycle fields, not mission seats. */
    chromeIssue(id: string | undefined): Loaded<IssueViewModel> {
      if (id === undefined) return undefined
      const row = pool.row('issue', id, 'summary-fields') as Loaded<IssueViewModel>
      if (!row || row === LOADING || row.deletedAt) return row === LOADING ? LOADING : undefined
      const repoId = pool.graph.one('issue', id, 'repo')
      const repo = repoId ? (pool.row('repo', repoId) as Loaded<{ prefix?: string }>) : undefined
      const prefix = repo && repo !== LOADING ? repo.prefix : undefined
      return {
        ...row,
        id: asIssueId(id),
        prefix,
        displayRef: prefix ? `${prefix}-${row.seq}` : `#${row.seq}`,
      }
    },
    issueAgentCount(id: string | undefined): Loaded<number> {
      if (id === undefined) return 0
      const seats = issuePages(pool).attachedSessions(id)
      return seats === LOADING ? LOADING : (seats?.filter((seat) => !seat.archived).length ?? 0)
    },
    nextSession: (id: string) => runInAction(() => pool.queries.nextTriageSession(id)),
    sessions: () => chatReferenceSessions(pool),
    issues: () => chatMentionIssues(pool),
    machine: (id: string | undefined): MachineWire | undefined =>
      id === undefined ? undefined : pool.row('machine', id) as MachineWire | undefined,
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
      return placeholders?.get(id) ?? undefined
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
      if (!window || window === LOADING) return true
      return (
        window.cursor === null &&
        pool.queries.count('session') === 0 &&
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
    /**
     * Conversation ports WITHOUT the draft row at all (this issue, phone composer
     * isolation). Even checking draft EXISTENCE re-rendered the screen: the
     * stored-draft write replaces the row object, so any read of it — text or
     * not — wakes subscribers on every key. Ready here means held + records;
     * the draft seed is read once imperatively (no subscription) and later
     * copies arrive via the composer's stored-draft hook.
     */
    conversationPorts(id: string) {
      const held = pool.row('chatHeld', id),
        records = chatRecords(pool, id)
      return {
        records: records.records,
        sends: held && held !== LOADING ? held.sends : [],
        ready: !!held && held !== LOADING && records.pending === 0,
      }
    },
  }
}

/** One borrowed local projection, refreshed in batches. Neither collections
 * nor the legacy derived snapshot arrays are read here. */
export function createMobileSessionSource(owner: ClientRuntime, pool: MobxPool) {
  const reader = createMobileSessionReader(pool)
  const inputs = createFieldInputs<MobileSessionRows['mobileSessionWindow']>(
    ['cursor'],
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
        }
        if (window.get() === undefined) window.set(inputs.row)
      })
    })
  }
  // The cursor keeps its addressed field; spawn prompts belong to the pool log.
  if (!owner.replica.subscribeCursor)
    throw new Error('Phone session context requires the replica cursor signal')
  const stops = [owner.replica.subscribeCursor(() => schedule('cursor'))]
  return {
    read(entity: keyof MobileSessionRows): Loaded<MobileSessionRows[keyof MobileSessionRows]> {
      if (disposed) return LOADING
      if (entity === 'mobileSessionReader') return reader
      if (!demanded) {
        demanded = true
        schedule('cursor')
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
