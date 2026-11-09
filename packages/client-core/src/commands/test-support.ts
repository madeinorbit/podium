import type { IssueProjection, LayoutSnapshot, SessionId, SessionMeta } from '@podium/model'
import {
  asIssueId,
  asMutationId,
  asSessionId,
  asUserId,
  issueUserStateRowId,
  layoutRowId,
  pinRowId,
  sessionUserStateRowId,
  superagentThreadRowId,
  tabOrderRowId,
  userPreferencesRowId,
} from '@podium/model'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { COMMAND_ACTIONS, fixtureCommands, UI_LOCAL_ACTIONS } from '../../test-support/commands'
import { layoutFixture } from '../../test-support/layout'
import { fixtureNavigation } from '../../test-support/navigation'
import type { PodiumClientApi } from '../api'
import type { RuntimeState } from '../engine/state'
import type { StoreNotices } from '../engine/types'
import type { OutboxEntry } from '../outbox'
import { loadRecordDeclarations } from '../records'
import type { EngineOutbox, OutboxKinds } from '../runtime-root/outbox/wiring'
import type { SessionView } from '../session-values'
import type { SocketHub } from '../socket-transport'
import { type NavigationIntent, planNavigation } from '../ui/navigation'
import { UiStore } from '../ui/ui-store'
import { AutoContinueDialogModel, PaletteViewModel } from '../ui/view-models'
import type { Router } from '../ui-state'
import { createRoutedUiState } from '../ui-state'
import { allTabIds, emptyWorkspace, openTab, splitPane, type WorkspaceLayout } from '../values'
import type { CommandDeps } from './context'

beforeAll(loadRecordDeclarations)
export const sessionId = asSessionId('session-1')
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** Attribution is transport-derived; payload identity is inert (ADR 3 D7,
 *  multi-user-readiness 3.1.3 A3). Each name is refused INDIVIDUALLY. */
export const ATTRIBUTION_FIELDS = ['actor', 'owner', 'ownerId', 'origin'] as const

export function nestedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedKeys)
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, nested]) => [key, ...nestedKeys(nested)])
}

export const ME = asUserId('u-1')
/** My read state on an issue or a session: a record edit of my own row (POD-6404). */
export const myIssue = (id: string, patch: object) => ({
  kind: 'recordEdit',
  input: { kind: 'issueUserState', id: issueUserStateRowId(ME, asIssueId(id)), patch },
})
export const mySession = (id: SessionId, patch: object) => ({
  kind: 'recordEdit',
  input: { kind: 'sessionUserState', id: sessionUserStateRowId(ME, id), patch },
})

export function harness(
  layout: { seed?: LayoutSnapshot } = {},
  hub?: { reportTabRelease: (sessionId: SessionId) => void },
  extra: {
    sessionRevision?: (id: SessionId) => number | undefined
    launchPainted?: (id: SessionId) => boolean
  } = {},
) {
  const queued: { kind: keyof OutboxKinds; input: unknown }[] = []
  const pending: OutboxEntry[] = []
  const awaiting: OutboxEntry[] = []
  const errors: string[] = []
  const navigated: unknown[] = []
  // The runtime publishes a snapshot on every state change; the actions that
  // WAIT on replicated state (focusIssueSession) subscribe to that.
  const listeners = new Set<() => void>()
  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }
  let state = {
    pins: { panels: [], worktrees: [], repos: [] },
    tabOrders: {},
    sessions: [],
    issueProjections: [],
    issueUserStates: [],
    issueDeps: [],
    issueGitStates: [],
    repoProjections: [],
    repos: [],
  }
  const enqueue = vi.fn(async (kind: keyof OutboxKinds, input: unknown) => {
    queued.push({ kind, input })
    const entry = {
      mutationId: asMutationId(`m-${queued.length}`),
      kind,
      input,
      queuedAt: queued.length,
    }
    pending.push(entry)
    return entry
  })
  const dismissOffer = vi.fn(async (_input: unknown) => ({}))
  const submit = vi.fn(async (_envelope: unknown) => ({
    outcome: 'applied',
    result: {},
    receipt: { feedId: 'f', epoch: 'e', seq: 0 },
    replayed: false,
  }))
  const router = {
    current: () => ({
      view: 'issues',
      settingsTab: null,
      issueId: null,
      worktree: null,
      pane: null,
    }),
    navigate: (route: unknown) => navigated.push(route),
  } as unknown as Router
  const runtime = {
    palette: new PaletteViewModel(),
    autoContinueDialog: new AutoContinueDialogModel(),
    userId: ME,
    api: {
      superagent: { startBtw: { mutate: vi.fn(async () => ({})) } },
      sessions: {
        kill: { mutate: vi.fn(async () => ({})) },
        dismissOffer: { mutate: dismissOffer },
      },
      sync: { submit: { mutate: submit } },
    } as unknown as PodiumClientApi,
    hub: (hub ?? {}) as SocketHub,
    outbox: {
      enqueue,
      pending: () => pending,
      awaiting: () => awaiting,
    } as unknown as EngineOutbox,
    router,
    notices: { error: (message: string) => errors.push(message), info: vi.fn() } as StoreNotices,
    state: () => readState(),
    navigate: (intent: NavigationIntent) => {
      const plan = planNavigation(readState(), router.current(), intent, {
        visible: true,
        now: '2026-09-18T00:00:00.000Z',
      })
      ui.patch(plan.patch)
      router.navigate(plan.route)
      publish()
      return true
    },
    // S5 gesture batch in miniature: run synchronously, like runtime.batch.
    batch: (fn: () => void) => fn(),
    onLocals: (_keys: readonly string[], listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    write: (kind: keyof OutboxKinds, input: unknown) => queued.push({ kind, input }),
    spawnDraftAgent: vi.fn(() => ({ sessionId, issueId: asIssueId('issue-1') })),
    waitForSpawnConfirmed: vi.fn(async () => {}),
    setSessionDraft: vi.fn(),
    ...extra,
  } as unknown as CommandDeps<PodiumClientApi>
  const navigation = fixtureNavigation({
    issues: () => state.issueProjections as IssueProjection[],
    sessions: () => state.sessions as SessionView[],
    follow: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  })
  const layoutPath = layoutFixture(
    ME,
    async (kind, input) => {
      await enqueue(kind, input)
    },
    layout.seed ?? {},
  )
  cleanups.push(layoutPath.dispose)
  const values = new Map<string, string>()
  const keys = createRoutedUiState({
    local: {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => {
        if (value === null) values.delete(key)
        else values.set(key, value)
      },
      subscribe: () => () => {},
    },
    replicated: layoutPath.layout,
  })
  const revealTranscript = vi.fn()
  const ui = new UiStore({
    api: runtime.api,
    hub: runtime.hub,
    notices: runtime.notices,
    keys,
    router,
    revealTranscript,
    repositories: () => [],
    isVisible: () => true,
    changed: () => {
      publish()
    },
    watch: (_keys, listener) => runtime.onLocals(['selectedIssueId', 'navigation'], listener),
    navigate: (runtime as unknown as { navigate: (intent: NavigationIntent) => boolean }).navigate,
  })
  cleanups.push(() => ui.dispose())
  ui.patch({ view: 'issues', navigation })
  function readState() {
    return {
      ...state,
      ...ui.screen,
      paletteOpen: runtime.palette.open,
      autoContinuePromptSessionId: runtime.autoContinueDialog.sessionId,
      issueVisitBaseline: null,
    }
  }
  Object.assign(runtime, { ui })
  const actions = fixtureCommands(runtime)
  return {
    actions,
    ui,
    revealTranscript,
    dismissOffer,
    submit,
    enqueue,
    pending,
    awaiting,
    layout: layoutPath.layout,
    keys,
    seedLayout: layoutPath.seed,
    errors,
    queued,
    navigated,
    state: () => readState(),
    /** Seed action state directly — the runtime's `apply`, in miniature. */
    seed: (patch: Record<string, unknown>) => {
      state = {
        ...state,
        ...Object.fromEntries(
          Object.entries(patch).filter(([key]) => !Object.hasOwn(ui.screen, key)),
        ),
      } as typeof state
      ui.patch(patch as Partial<RuntimeState>)
      publish()
    },
  }
}

