import { ConversationCache, DraftStore, type ConversationCacheOptions } from '@podium/client-core/conversation'
import type { ClientRuntime } from '@podium/client-core/engine'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { createReplicaFixture } from '@podium/client-core/test-support/replica'
import { createWorklistPool } from '@podium/client-graph/create'
import type { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { CHAT_CONTEXT_ENTITIES } from '@podium/client-graph/chat-context-schema'
import { ChatContextSource } from '@podium/client-graph/chat-context-source'
import { headerEntities } from '@podium/client-graph/header-entities'
import { NOTICE_ENTITIES } from '@podium/client-graph/notice-schema'
import { NoticeSource } from '@podium/client-graph/notice-source'
import { SESSION_EXIT_ENTITIES } from '@podium/client-graph/session-exit-schema'
import { createSessionExitSource } from '@podium/client-graph/session-exit-source'
import { SESSION_PANE_ENTITIES } from '@podium/client-graph/session-pane-schema'
import { SessionPaneSource } from '@podium/client-graph/session-pane-source'
import { sessionPaneView } from '@podium/client-graph/session-pane-view'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { createPoolTransactions } from '@podium/client-graph/write/transactions'
import type { MachineWire, SessionMeta } from '@podium/model'
import { asSessionId } from '@podium/model'
import { observable, runInAction } from 'mobx'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { SessionView } from '@podium/client-core/session-values'
import { poolFixtureStore } from '@/test-support/pool-issue-fixture'

type PaneInputs = {
  sessions: readonly SessionMeta[]
  issues?: readonly unknown[]
  machines: readonly MachineWire[]
  panelMode: Record<string, 'chat' | 'native'>
  drafts: Record<string, string>
  pendingSpawnIds: ReadonlySet<string>
  pendingSpawnPrompts: ReadonlyMap<string, string>
  selectedIssueId?: string | null
}

/** Translate hand-held inputs into the same normalized feed and screen sources
 * as the app. Publish before rendering, so real pane/chat hooks see one pool. */
export function createPanePoolFixture(readInputs: () => PaneInputs) {
  let state: object = {}
  let pool: MobxPool | undefined
  let release: (() => void) | undefined
  let replica = createReplicaFixture()
  let drafts: DraftStore | undefined
  let conversations: ConversationCache | undefined
  const listeners = new Set<() => void>()
  const spawnPrompts = observable.map<string, string | null>(undefined, { deep: false })
  const owner = withKeyedInputs({
    principal: { userId: 'fixture-user' },
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    get replica() { return replica },
    get drafts() {
      return drafts ??= new DraftStore({
        storage: { get: () => null, set: () => {} },
        hub: { on: () => () => {}, sendDraftEdit: () => {}, connectionHealth: () => ({ status: 'ok' }) } as never,
        onChange: (id, text) => (readInputs() as PaneInputs & { setSessionDraft(id: string, text: string): void }).setSessionDraft(id, text),
      })
    },
    outbox: { pending: () => [], deadLetters: () => [], subscribe: () => () => {} },
    ownConversations: (options: ConversationCacheOptions) => conversations ??= new ConversationCache(options),
  })
  const runtime = owner as unknown as ClientRuntime

  function sync() {
    runInAction(publish)
  }

  function publish() {
    const input = readInputs()
    const normalized = 'issueProjections' in input
      ? input as PaneInputs & ReturnType<typeof poolFixtureStore>
      : poolFixtureStore(input)
    // Historical display fixtures put companion names/login on the session.
    // Materialize their authoritative machine rows and leave only stored IDs.
    const machines = [...input.machines]
    const sessions = input.sessions.map(value => {
      const { machineName, condition, handoffTarget, displayRef: _displayRef, ...session } = value as SessionView
      const machineId = session.machineId ?? `fixture-machine:${session.sessionId}`
      if (!machines.some(machine => machine.id === machineId)) machines.push({
        id: machineId, name: machineName ?? '', online: true,
        loggedOutHarnesses: condition === 'logged-out' ? [session.agentKind] : [],
        inventory: { agents: [{ kind: session.agentKind, installed: true, login: { state: condition === 'logged-out' ? 'out' : 'in' } }], tools: [] },
      } as unknown as MachineWire)
      const handoffTargetMachineId = handoffTarget ? `fixture-handoff:${handoffTarget}` : session.handoffTargetMachineId
      if (handoffTarget && !machines.some(machine => machine.id === handoffTargetMachineId)) machines.push({
        id: handoffTargetMachineId, name: handoffTarget, online: true,
      } as unknown as MachineWire)
      return { ...session, machineId, handoffTargetMachineId } as SessionMeta
    })
    state = { ...normalized, replica, dockShells: {}, reposLoaded: true }
    runInAction(() => {
      spawnPrompts.replace([...input.pendingSpawnIds].map(id => [id, input.pendingSpawnPrompts.get(id) ?? null]))
      for (const [id, text] of Object.entries(input.drafts)) owner.drafts.values.set(asSessionId(id), text)
    })
    replica.applySnapshot('repos', [...normalized.replica.rows('repos')])
    replica.applySnapshot('issueProjections', normalized.issueProjections)
    replica.applySnapshot('issueUserStates', normalized.issueUserStates)
    replica.applySnapshot('issueGitStates', normalized.issueGitStates)
    replica.applySnapshot('machines', machines.map(machine => ({ id: machine.id, name: machine.name, loggedOutHarnesses: (machine as MachineWire & { loggedOutHarnesses?: string[] }).loggedOutHarnesses ?? [] })) as never)
    replica.applySnapshot('sessions', sessions)
    for (const listener of listeners) listener()
    if (!pool) {
      const transactions = createPoolTransactions({
        userId: 'fixture-user', outbox: { ...owner.outbox, awaiting: () => [] },
        outcomes: () => () => {}, addressed: () => () => {}, enqueue: async () => {},
      })
      const rows = createRowSource(owner, replica, { pending: transactions.pending })
      const handle = createWorklistPool(rows.source, {
        get: () => ({ selectedIssueId: input.selectedIssueId ?? null, coarseNow: Date.parse('2026-06-03T00:00:00Z') }),
        subscribe: () => () => {},
      })
      pool = handle.pool
      // These suites control confirmation independently of a network spawn.
      pool.attachTransactions({ mutate: transactions.mutate, spawnPrompts })
      sessionPaneView(pool)
      pool.sources.register(SESSION_PANE_ENTITIES, new SessionPaneSource(runtime))
      pool.sources.register(NOTICE_ENTITIES, new NoticeSource(runtime))
      pool.sources.register(CHAT_CONTEXT_ENTITIES, new ChatContextSource(runtime, pool))
      pool.sources.register(SESSION_EXIT_ENTITIES, createSessionExitSource(runtime))
      release = () => { handle.dispose(); rows.dispose(); transactions.dispose() }
    }
    pool.ingestLiveMachines(machines.map(machine => ({ id: machine.id, value: machine })))
    headerEntities(pool).order('machine', machines.map(machine => machine.id))
    pool.applyLocals({ selectedIssueId: input.selectedIssueId ?? null, coarseNow: Date.parse('2026-06-03T00:00:00Z') }, new Set(['selectedIssueId']))
    for (const session of input.sessions) pool.row('session', session.sessionId)
    pool.hydrate()
  }

  return {
    owner,
    sync,
    dispose() {
      conversations?.dispose(); conversations = undefined
      release?.(); release = undefined; pool = undefined
      drafts?.dispose(); drafts = undefined
      replica = createReplicaFixture()
      listeners.clear()
      runInAction(() => spawnPrompts.clear())
    },
    hooks: {
      useWorklistPool: () => pool ?? null,
      useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T, empty: T, active = true) => {
        const projection = useMemo(() => pool ? createPoolProjection(pool, read) : null, [pool, read])
        const last = useMemo(() => ({ paint: undefined as { value: T } | undefined }), [projection])
        projection?.setActive(active)
        useEffect(() => () => projection?.dispose(), [projection])
        return useSyncExternalStore(active && projection ? projection.subscribe : () => () => {}, () => {
          if (!active || !projection) return last.paint?.value ?? empty
          const value = projection.getSnapshot()
          last.paint = { value }
          return value
        })
      },
    },
  }
}
