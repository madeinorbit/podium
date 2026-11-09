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
const sessionId = asSessionId('session-1')
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** Attribution is transport-derived; payload identity is inert (ADR 3 D7,
 *  multi-user-readiness 3.1.3 A3). Each name is refused INDIVIDUALLY. */
const ATTRIBUTION_FIELDS = ['actor', 'owner', 'ownerId', 'origin'] as const

function nestedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedKeys)
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, nested]) => [key, ...nestedKeys(nested)])
}

const ME = asUserId('u-1')
/** My read state on an issue or a session: a record edit of my own row (POD-6404). */
const myIssue = (id: string, patch: object) => ({
  kind: 'recordEdit',
  input: { kind: 'issueUserState', id: issueUserStateRowId(ME, asIssueId(id)), patch },
})
const mySession = (id: SessionId, patch: object) => ({
  kind: 'recordEdit',
  input: { kind: 'sessionUserState', id: sessionUserStateRowId(ME, id), patch },
})

function harness(
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

describe('engine action ownership boundary', () => {
  it('keeps command and device-local classifications disjoint', () => {
    expect(new Set([...COMMAND_ACTIONS, ...UI_LOCAL_ACTIONS]).size).toBe(
      COMMAND_ACTIONS.length + UI_LOCAL_ACTIONS.length,
    )
  })

  it('lets navigation suggest a panel mode without overwriting the operator’s pick', () => {
    // POD-1702. The native worker rows under a session focus it "in CLI", and
    // that wrote `native` over an explicit Chat pick — durably, so the session
    // reopened on the terminal too. A suggestion now yields to a pick and still
    // decides for a session nobody has decided about.
    const h = harness()
    const mode = (): unknown => h.ui.panelMode[sessionId]

    h.actions.preferPanelMode(sessionId, 'native')
    expect(h.queued).toEqual([
      {
        kind: 'recordEdit',
        input: {
          kind: 'userLayout',
          id: layoutRowId(ME, 'panelMode'),
          patch: { value: JSON.stringify({ [sessionId]: 'native' }) },
        },
      },
    ])
    h.seedLayout({ panelMode: JSON.stringify({ [sessionId]: 'native' }) })
    expect(mode()).toBe('native')

    h.actions.setPanelMode(sessionId, 'chat')
    h.seedLayout({ panelMode: JSON.stringify({ [sessionId]: 'chat' }) })
    h.actions.preferPanelMode(sessionId, 'native')
    expect(mode()).toBe('chat')
    expect(h.queued).toHaveLength(2)
  })

  it('opens one permanent tab and delivers transcript reveal actions to the chat view', () => {
    const h = harness()
    h.actions.openSessionAtTranscript(sessionId, 'cursor-1', { permanent: true })
    h.actions.openSessionAtTranscript(sessionId, 'cursor-2', { permanent: true })
    expect(h.revealTranscript.mock.calls).toEqual([
      [sessionId, 'cursor-1'],
      [sessionId, 'cursor-2'],
    ])
    expect(h.state().paneA).toBe(sessionId)
    expect(allTabIds((h.state().workspaces as Record<string, WorkspaceLayout>).none!)).toEqual([
      sessionId,
    ])
  })

  it('answers a question as a session.answer record created at once, never queued (POD-6415)', async () => {
    const h = harness()

    const id = await h.actions.answerSession(sessionId, {
      via: 'menu',
      interactionId: 'ask-1',
      choices: [{ optionIndices: [2] }],
    })

    expect(id).toMatch(/^eff_/)
    // Online-only: an answer that reached the server later would land on a
    // later menu, so it is never in the durable queue.
    expect(h.queued).toEqual([])
    expect(h.submit).toHaveBeenCalledTimes(1)
    expect(h.submit.mock.calls[0]?.[0]).toMatchObject({
      command: 'effects.create',
      input: {
        id,
        kind: 'session.answer',
        target: { kind: 'session', id: sessionId },
        input: { via: 'menu', interactionId: 'ask-1', choices: [{ optionIndices: [2] }] },
      },
    })
  })

  it('a refused answer rejects in words, and nothing is queued', async () => {
    const h = harness()
    h.submit.mockResolvedValueOnce({
      outcome: 'rejected',
      refusal: { kind: 'target-not-found' },
    } as never)
    await expect(h.actions.answerSession(sessionId, { via: 'menu', skip: true })).rejects.toThrow(
      /answer the question/,
    )
    expect(h.queued).toEqual([])
  })

  it('queues an offer dismissal through the Outbox, carrying the offer it names', async () => {
    const h = harness()

    await h.actions.dismissOffer(sessionId, '2026-08-06T12:00:00.000Z')

    // `offline: 'eligible'` by contract since POD-1110: "none of these" survives
    // an offline gap like every other row edit. The stamp rides the entry, so a
    // late replay meets the server's guard and is refused rather than clearing
    // whatever offer is standing by then.
    expect(h.queued).toEqual([
      {
        kind: 'dismissOffer',
        input: { sessionId, offerCreatedAt: '2026-08-06T12:00:00.000Z' },
      },
    ])
    // No second write: the queued entry IS the dismissal, not a mirror of one.
    expect(h.dismissOffer).not.toHaveBeenCalled()
  })

  it('navigation, pane, selection, focus, and transient view changes never touch the Outbox', () => {
    const h = harness()
    h.actions.setView('workspace')
    h.actions.setSelectedWorktree('/worktree')
    h.actions.setSelectedIssueId(asIssueId('issue-1'))
    h.actions.setPane('A', sessionId)
    h.actions.setFocusedPane('B')
    h.actions.setDockShell('/worktree', sessionId)
    h.actions.toggleSplit()
    h.actions.setPaletteOpen(true)

    expect(h.queued).toEqual([])
    expect(h.navigated).toHaveLength(1)
  })

  it('queues pins, tab orders and personal settings as generic edits of my records (POD-6673)', async () => {
    const h = harness()

    await h.actions.setPinned('panel', sessionId, true)
    await h.actions.setPinned('repo', '/repo', false)
    await h.actions.setTabOrder('/w', [sessionId])
    await h.actions.setTabOrder('/x', [])
    await h.actions.setPreferences({
      'sidebar.repoSort': 'custom',
      'roles.coding.harness': undefined,
    })

    expect(h.queued).toEqual([
      {
        kind: 'recordCreate',
        input: {
          kind: 'pin',
          id: pinRowId(ME, 'panel', sessionId),
          fields: { userId: ME, kind: 'panel', entityId: sessionId },
        },
      },
      { kind: 'recordRemove', input: { kind: 'pin', id: pinRowId(ME, 'repo', '/repo') } },
      {
        kind: 'recordEdit',
        input: {
          kind: 'tabOrder',
          id: tabOrderRowId(ME, '/w'),
          patch: { sessionIds: [sessionId] },
        },
      },
      { kind: 'recordRemove', input: { kind: 'tabOrder', id: tabOrderRowId(ME, '/x') } },
      {
        kind: 'recordEdit',
        input: {
          kind: 'userPreferences',
          id: userPreferencesRowId(ME),
          patch: { 'sidebar.repoSort': 'custom' },
          unset: ['roles.coding.harness'],
        },
      },
    ])
  })

  it('queues the prompt box’s model and effort as an edit of my thread record (POD-6675)', async () => {
    const h = harness()
    await h.actions.setSuperagentBackend('global', { model: 'opus', effort: 'auto' })
    await h.actions.setSuperagentBackend('global', { effort: 'high' })
    await h.actions.setSuperagentBackend('global', {})
    const thread = superagentThreadRowId(ME, 'global')
    expect(h.queued).toEqual([
      {
        kind: 'recordEdit',
        // `auto` clears the field: the thread follows the settings role again.
        input: {
          kind: 'superagentThread',
          id: thread,
          patch: { model: 'opus' },
          unset: ['effort'],
        },
      },
      {
        kind: 'recordEdit',
        input: { kind: 'superagentThread', id: thread, patch: { effort: 'high' } },
      },
    ])
  })

  it('never accepts client attribution fields in assembled command payloads', async () => {
    const h = harness()
    await h.actions.setPinned('panel', sessionId, true)
    await h.actions.setTabOrder('/worktree', [sessionId])
    await h.actions.renameSession(sessionId, 'new name')
    h.ui.setSuperOpen(true)
    h.layout.clear('superOpen')

    // Per-field, deliberately: `not.toEqual(expect.arrayContaining([...]))`
    // only fails when EVERY listed field is present at once, so the realistic
    // drift — one field leaking into one payload — passes silently (POD-1533).
    for (const { kind, input } of h.queued) {
      const keys = nestedKeys(input)
      for (const field of ATTRIBUTION_FIELDS) {
        expect(keys, `${kind} payload asserts attribution field '${field}'`).not.toContain(field)
      }
    }
  })
})

/**
 * The pane scalars are DERIVED from the layout (POD-710). Every case here is one
 * of the writers that used to disagree with it — and a disagreement is not
 * cosmetic: `paneA`/`paneB`/`split` drive the `?pane=` route, PTY-relay
 * priority, the warm set and what the flight deck highlights.
 */
describe('pane scalars follow the layout', () => {
  /** Two panes: p1 holds `a`, p2 holds `b` and has focus — the arrangement
   *  every "second pane" defect below needs. */
  const twoPanes = (a: string, b: string): WorkspaceLayout => {
    let ws = openTab(emptyWorkspace('none'), a, { permanent: true })
    ws = splitPane(ws, 'p1', 'row') // p2: empty, focused
    return openTab(ws, b, { permanent: true }) // …and it lands there
  }
  const meta = (id: string): SessionMeta =>
    ({ sessionId: asSessionId(id), cwd: '/wt', archived: false }) as unknown as SessionMeta

  it('killing the session in the second pane also collapses the split', async () => {
    const h = harness()
    h.seed({
      workspaces: { none: twoPanes('s-a', 'session-1') },
      paneA: asSessionId('s-a'),
      paneB: sessionId,
      split: true,
      focusedPane: 'p2',
    })

    await h.actions.killSession(sessionId)

    // The mirror computed `split: false` all along; killSession cherry-picked
    // `workspaces`/`paneA`/`paneB` out of the patch and dropped it, leaving a
    // phantom second pane that no later write could clear — the compatibility
    // clause saw one leaf both before and after and stopped writing `split`.
    const st = h.state()
    expect(st.split).toBe(false)
    expect(st.paneB).toBeNull()
    expect(st.focusedPane).toBe('p1')
    expect(st.paneA).toBe('s-a')
  })

  it('closing the file tab in the second pane collapses it too', () => {
    const h = harness()
    const fileId = 'file:s:s1:notes.md'
    h.seed({
      workspaces: { none: twoPanes('s-a', fileId) },
      fileTabs: [{ id: fileId, scope: { kind: 'session', sessionId }, path: 'notes.md' }],
      paneA: asSessionId('s-a'),
      paneB: fileId,
      split: true,
      focusedPane: 'p2',
    })

    h.actions.closeFileTab(fileId)

    const st = h.state()
    expect(st.split).toBe(false)
    expect(st.paneB).toBeNull()
    expect(st.fileTabs).toEqual([])
  })

  describe('tab release reports (POD-4435)', () => {
    it('closing a session tab reports its release to the server', () => {
      const reportTabRelease = vi.fn()
      const h = harness({}, { reportTabRelease })
      h.seed({
        workspaces: { none: openTab(emptyWorkspace('none'), 's-a', { permanent: true }) },
      })

      h.actions.closeWorkspaceTab(asSessionId('s-a'))

      expect(reportTabRelease).toHaveBeenCalledTimes(1)
      expect(reportTabRelease).toHaveBeenCalledWith(asSessionId('s-a'))
    })

    it('closing a file tab reports nothing (it carries no session)', () => {
      const reportTabRelease = vi.fn()
      const h = harness({}, { reportTabRelease })
      const fileId = 'file:s:s1:notes.md'
      h.seed({
        workspaces: { none: openTab(emptyWorkspace('none'), fileId, { permanent: true }) },
        fileTabs: [{ id: fileId, scope: { kind: 'session', sessionId }, path: 'notes.md' }],
      })

      h.actions.closeWorkspaceTab(fileId as never)

      expect(reportTabRelease).not.toHaveBeenCalled()
    })
  })

  it('navigating to a session opens it in the FOCUSED pane, not on top of pane A', () => {
    const h = harness()
    h.seed({
      sessions: [meta('s-a'), meta('session-1')],
      workspaces: { none: twoPanes('s-a', 's-b') },
    })

    h.actions.navigateToSession(sessionId)

    // `paneA: meta.sessionId` used to be spread AFTER the mirror, so a split
    // layout put one session in both panes and blanked the other half.
    const st = h.state()
    expect(st.paneB).toBe(sessionId)
    expect(st.paneA).toBe('s-a')
  })

  it('setPane(A, null) leaves the layout — and therefore the scalar — alone', () => {
    const h = harness()
    h.seed({
      workspaces: { none: openTab(emptyWorkspace('none'), 's-a', { permanent: true }) },
      paneA: asSessionId('s-a'),
    })

    h.actions.setPane('A', null)

    // Clearing a pane is not an operation the model has. Writing the scalar
    // anyway blanked the panel while the strip still listed the tab.
    expect(h.state().paneA).toBe('s-a')
  })

  it('setPane(B, …) against a single-leaf layout is inert, not a raw scalar write', () => {
    const h = harness()
    h.seed({
      workspaces: { none: openTab(emptyWorkspace('none'), 's-a', { permanent: true }) },
      paneA: asSessionId('s-a'),
    })

    h.actions.setPane('B', sessionId)

    expect(h.state().paneB).toBeNull()
    expect(h.state().split).toBe(false)
  })
})

describe('tucking the task on screen leaves it (POD-2293)', () => {
  const issue = (id: string, parentId?: string) =>
    ({
      id: asIssueId(id),
      ...(parentId ? { parentId: asIssueId(parentId) } : {}),
    }) as unknown as IssueProjection
  const seeded = (selected = 'root') => {
    const h = harness()
    h.seed({
      issueProjections: [issue('root'), issue('child', 'root'), issue('other')],
      selectedIssueId: asIssueId(selected),
      selectedWorktree: '/wt',
      workspaces: {
        'mission:root': openTab(emptyWorkspace('mission:root'), 's-a', { permanent: true }),
      },
    })
    return { h, workspaces: h.state().workspaces }
  }

  it('enqueues the tuck, then clears only the task and keeps the view, worktree and tabs', async () => {
    const { h, workspaces } = seeded()

    await h.actions.setIssueTucked('root', true)

    // The tuck is a record edit of my own row (POD-6404).
    expect(h.queued.at(-1)).toMatchObject(myIssue('root', { tuckedAt: expect.any(String) }))
    expect(h.state().selectedIssueId).toBeNull()
    // The worktree stays: clearing it would hand over to the worktree fallback.
    expect(h.state().selectedWorktree).toBe('/wt')
    expect(h.navigated.at(-1)).toMatchObject({ view: 'issues' })
    expect(h.state().workspaces).toBe(workspaces)
  })

  it('leaves a sub-task on screen when its mission root is tucked', async () => {
    const { h } = seeded('child')

    await h.actions.setIssueTucked('root', true)

    expect(h.state().selectedIssueId).toBeNull()
  })

  it.each([
    ['a sub-task of the mission on screen', 'child', true],
    ['another task', 'other', true],
    ['the task on screen being brought back', 'root', false],
  ])('stays put when tucking %s', async (_case, id, tucked) => {
    const { h } = seeded()

    await h.actions.setIssueTucked(id, tucked)

    expect(h.state().selectedIssueId).toBe('root')
    expect(h.navigated).toEqual([])
  })
})

describe('ask superagent (BTW) attaches a session to the next turn (POD-1069)', () => {
  it('opens the dock and attaches the session, WITHOUT moving the rendered thread', async () => {
    // THE REGRESSION THIS PINS. The action used to point `superThreadId` at
    // `btw_<sessionId>`. Nothing has rendered a non-global thread since
    // POD-782, so the pane bound a thread with no headless session and went
    // blank — no composer, no way back, and no reset short of a reload, from
    // all three entry points. The dock must stay on the one chat.
    const h = harness()

    await h.actions.startBtw(asSessionId('sess-btw'))

    expect(h.state().superThreadId).toBe('global')
    expect(h.state().attachedSessionId).toBe('sess-btw')
    expect(h.state().superOpen).toBe(true)
    // Opening the dock is not the same as SHOWING the superagent — it also
    // holds Files, Git and Issue. Staging an attachment behind one of those is
    // the same "nothing happened" one surface further in.
    expect(h.state().dockTab).toBe('superagent')
  })

  it('keeps the attachment local while opening the synced dock', async () => {
    // The session rides the next `sendTurn` as `attachSessionId` and the server
    // digests it into that turn's preamble, so an offline client can still line
    // one up.
    const h = harness()

    await h.actions.startBtw(asSessionId('sess-btw'))

    expect(h.queued).toEqual([
      {
        kind: 'recordEdit',
        input: { kind: 'userLayout', id: layoutRowId(ME, 'superOpen'), patch: { value: '1' } },
      },
      {
        kind: 'recordEdit',
        input: {
          kind: 'userLayout',
          id: layoutRowId(ME, 'dockTab'),
          patch: { value: 'superagent' },
        },
      },
    ])
  })

  it("drops the attachment on clear, so the chip's × is not a lie", async () => {
    const h = harness()
    await h.actions.startBtw(asSessionId('sess-btw'))

    h.actions.clearAttachedSession()

    expect(h.state().attachedSessionId).toBeNull()
  })
})

/**
 * LANDING ON A LAUNCH (POD-1202). `issues.start` resolves when the SERVER has
 * spawned; the session row arrives a replica delta later, so a launch that only
 * selected the issue put the operator on an empty tab area and read as having
 * done nothing.
 */
describe('focusIssueSession waits for the session a launch started', () => {
  const issueId = asIssueId('issue-1')
  const issue = (id: string) => ({ id: asIssueId(id) }) as unknown as IssueProjection
  const meta = (id: string, ownedBy: string): SessionMeta =>
    ({
      sessionId: asSessionId(id),
      cwd: '/wt',
      archived: false,
      issueId: asIssueId(ownedBy),
    }) as unknown as SessionMeta

  it('opens the tab for a session that arrives AFTER the start resolved', async () => {
    const h = harness()
    h.seed({ issueProjections: [issue('issue-1')] })

    const landed = h.actions.focusIssueSession(issueId)
    // Nothing to open yet — this is the window the old code navigated in.
    expect(h.state().paneA).toBeNull()
    h.seed({ sessions: [meta('session-1', 'issue-1')] })

    expect(await landed).toBe('session-1')
    expect(h.state().paneA).toBe('session-1')
    expect(h.state().selectedIssueId).toBe(issueId)
    expect(h.navigated.at(-1)).toMatchObject({ view: 'workspace', pane: 'session-1' })
  })

  it('holds for the ISSUE too, so the tab is not written under the wrong workspace key', async () => {
    // A tab lands in the workspace keyed by the issue's MISSION, and that key
    // is only `mission:<id>` once the issue is in the replica. Opening a beat
    // early files the tab under `issue:<id>` and the arriving row moves the
    // workspace out from under it.
    const h = harness()

    const landed = h.actions.focusIssueSession(issueId)
    h.seed({ sessions: [meta('session-1', 'issue-1')] })
    // A full turn of the loop: enough for a wait that had already resolved to
    // have opened its tab. Nothing may have been written yet.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.state().paneA).toBeNull()
    expect(h.state().workspaces).toEqual({})

    h.seed({ issueProjections: [issue('issue-1')] })
    expect(await landed).toBe('session-1')
    expect(Object.keys(h.state().workspaces)).toEqual(['mission:issue-1'])
  })

  it('does not overrule an operator who selected another task while it waited', async () => {
    const h = harness()
    h.seed({ issueProjections: [issue('issue-1'), issue('issue-2')] })

    const landed = h.actions.focusIssueSession(issueId)
    h.actions.setSelectedIssueId(asIssueId('issue-2'))
    h.seed({ sessions: [meta('session-1', 'issue-1')] })

    expect(await landed).toBeNull()
    expect(h.state().selectedIssueId).toBe('issue-2')
    expect(h.state().paneA).toBeNull()
  })

  it('waits past existing sessions when a launch adds another agent', async () => {
    const h = harness()
    const existingId = asSessionId('session-existing')
    h.seed({
      issueProjections: [issue('issue-1')] as never,
      sessions: [meta(existingId, 'issue-1')],
    })

    const landed = h.actions.focusIssueSession(issueId, {
      excludeSessionIds: [existingId],
    })
    expect(h.state().paneA).toBeNull()

    h.seed({ sessions: [meta(existingId, 'issue-1'), meta('session-new', 'issue-1')] })

    expect(await landed).toBe('session-new')
    expect(h.state().paneA).toBe('session-new')
  })

  it('gives up when no session ever arrives, leaving the selection it made', async () => {
    const h = harness()
    h.seed({ issueProjections: [issue('issue-1')] })

    expect(await h.actions.focusIssueSession(issueId, { timeoutMs: 1 })).toBeNull()
    expect(h.state().selectedIssueId).toBe(issueId)
    expect(h.navigated).toEqual([])
  })
})

describe('navigation read command coalescing', () => {
  it('keeps the latest observed receipt when a visit ends during leading enqueue', async () => {
    const h = harness()
    const first = h.actions.markIssueRead('issue-1', '2026-10-29T12:00:00.000Z')
    const last = h.actions.markIssueRead('issue-1', '2026-10-29T12:00:01.000Z')
    await Promise.all([first, last])
    expect(h.queued).toEqual([
      myIssue('issue-1', { readAt: '2026-10-29T12:00:00.000Z' }),
      myIssue('issue-1', { readAt: '2026-10-29T12:00:01.000Z' }),
    ])
  })

  it.each([
    'issue',
    'session',
  ] as const)('manual %s unread cancels a receipt waiting on enqueue', async (kind) => {
    const h = harness()
    const read = kind === 'issue' ? h.actions.markIssueRead : h.actions.markSessionRead
    const unread = kind === 'issue' ? h.actions.markIssueUnread : h.actions.markSessionUnread
    const first = read(sessionId, '2026-10-29T12:00:00.000Z')
    const last = read(sessionId, '2026-10-29T12:00:01.000Z')
    await unread(sessionId)
    await Promise.all([first, last])
    const mine = kind === 'issue' ? myIssue : mySession
    expect(h.queued).toEqual([
      mine(sessionId, { readAt: '2026-10-29T12:00:00.000Z' }),
      mine(sessionId, { readAt: null }),
    ])
  })

  it('writes no read mark for a session that is only a start’s paint (POD-6622)', async () => {
    // The server has no row under the painted id, so the mark would be refused
    // ("Couldn't save session read status"); the paint already reads as read.
    let painted = true
    const h = harness({}, undefined, { launchPainted: (id) => painted && id === sessionId })
    await h.actions.markSessionRead(sessionId)
    await h.actions.markSessionRead(sessionId, '2026-11-08T09:06:00.000Z')
    expect(h.queued).toEqual([])
    // The row has landed: the same press marks it.
    painted = false
    await h.actions.markSessionRead(sessionId, '2026-11-08T09:07:00.000Z')
    expect(h.queued).toEqual([mySession(sessionId, { readAt: '2026-11-08T09:07:00.000Z' })])
  })

  it('shares the reaction and click read until its optimistic overlay is published', async () => {
    const h = harness()
    const issueId = asIssueId('issue-1')
    const first = h.actions.markIssueRead(issueId)
    const duplicate = h.actions.markIssueRead(issueId)
    const session = h.actions.markSessionRead(sessionId)
    const duplicateSession = h.actions.markSessionRead(sessionId)
    expect(duplicate).toBe(first)
    expect(duplicateSession).toBe(session)
    // A press without a cursor marks what this device has seen: now, or the
    // row's later activity (POD-6404).
    expect(h.queued).toEqual([
      myIssue(issueId, { readAt: expect.any(String) }),
      mySession(sessionId, { readAt: expect.any(String) }),
    ])
    await Promise.all([first, session])
    await h.actions.markIssueRead(issueId)
    expect(h.queued).toHaveLength(3)
  })
})

describe('S5 gesture batch', () => {
  it('is device-local and runs navigation plus reads in one caller batch', () => {
    const h = harness()
    expect(UI_LOCAL_ACTIONS).toContain('batchGesture')
    expect(COMMAND_ACTIONS).not.toContain('batchGesture')
    const order: string[] = []
    h.actions.batchGesture(() => {
      order.push('inside')
      h.actions.navigateWorkspace({ selectedIssueId: asIssueId('issue-1') })
    })
    expect(order).toEqual(['inside'])
    expect(h.navigated).toHaveLength(1)
  })
})

describe('session lifecycle as edits of the session record (POD-6399)', () => {
  const sessionEdit = (input: unknown) =>
    input as { kind: string; id: string; patch: unknown; expectedRevision?: number }

  it('stop, hibernate and resume queue records.session edits against the replica revision', async () => {
    const h = harness({}, undefined, { sessionRevision: () => 4 })
    expect(await h.actions.endSession(sessionId)).toEqual({ ok: true })
    await h.actions.hibernateSession(sessionId)
    expect(await h.actions.resurrectSession(sessionId)).toEqual({ ok: true })
    const edits = h.queued.filter((q) => q.kind === 'recordEdit').map((q) => sessionEdit(q.input))
    expect(edits.map((e) => [e.kind, e.id, e.patch])).toEqual([
      ['session', sessionId, { desired: 'stopped' }],
      ['session', sessionId, { desired: 'hibernated' }],
      ['session', sessionId, { desired: 'running' }],
    ])
    expect(edits.every((e) => e.expectedRevision === 4)).toBe(true)
  })

  it('a second edit queued behind an unconfirmed one names the revision the first will make', async () => {
    const h = harness({}, undefined, { sessionRevision: () => 2 })
    h.pending.push({
      mutationId: asMutationId('m-earlier'),
      kind: 'recordEdit',
      input: { kind: 'session', id: sessionId, patch: { desired: 'stopped' }, expectedRevision: 2 },
      queuedAt: 0,
    } as OutboxEntry)
    await h.actions.endSession(sessionId, true)
    const edit = sessionEdit(h.queued.filter((q) => q.kind === 'recordEdit').at(-1)?.input)
    expect(edit).toMatchObject({ patch: { desired: 'stopped', force: true }, expectedRevision: 3 })
  })

  it('kill removes the session record against its revision', async () => {
    const h = harness({}, undefined, { sessionRevision: () => undefined })
    await h.actions.killSession(sessionId)
    const removes = h.queued
      .filter((q) => q.kind === 'recordRemove')
      .map((q) => sessionEdit(q.input))
    expect(removes).toEqual([{ kind: 'session', id: sessionId, expectedRevision: 1 }])
  })
})
