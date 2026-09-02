import type { IssueWire, LayoutSnapshot, SessionMeta } from '@podium/model'
import { asIssueId, asMutationId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry } from '../outbox'
import type { SocketHub } from '../socket-transport'
import type { Router } from '../ui-state'
import { allTabIds, emptyWorkspace, openTab, splitPane, type WorkspaceLayout } from '../viewmodels'
import {
  COMMAND_ACTIONS,
  createEngineActions,
  type EngineActionRuntime,
  UI_LOCAL_ACTIONS,
} from './actions'
import type { StoreNotices } from './types'
import type { EngineOutbox, OutboxKinds } from './wiring'

const sessionId = asSessionId('session-1')

/** Attribution is transport-derived; payload identity is inert (ADR 3 D7,
 *  multi-user-readiness 3.1.3 A3). Each name is refused INDIVIDUALLY. */
const ATTRIBUTION_FIELDS = ['actor', 'owner', 'ownerId', 'origin'] as const

function nestedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedKeys)
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, nested]) => [key, ...nestedKeys(nested)])
}

function harness(layout: { seed?: LayoutSnapshot; installed?: LayoutSnapshot[] } = {}) {
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
    issues: [],
    repos: [],
    superThreadId: 'global',
    superOpen: false,
    attachedSessionId: null,
    dockTab: 'chat' as const,
    superThreads: [],
    paletteOpen: false,
    selectedWorktree: null,
    selectedIssueId: null,
    transcriptReveal: null as {
      nonce: number
      sessionId: typeof sessionId
      itemKey: string
    } | null,
    workspaces: {},
    paneA: null,
    paneB: null,
    split: false,
    focusedPane: 'A' as const,
    panelMode: {},
    dockShells: {},
    dockVisibleSession: null,
    autoContinuePromptSessionId: null,
    sidebarSettings: { repoSort: 'lastUsed' as const, repoOrder: [], groupByRepo: false },
    fileTabs: [],
    recentFiles: [],
  }
  const enqueue = vi.fn(async (kind: keyof OutboxKinds, input: unknown) => {
    queued.push({ kind, input })
    const entry = {
      mutationId: asMutationId(`m-`),
      kind,
      input,
      queuedAt: queued.length,
    }
    pending.push(entry)
    return entry
  })
  const refreshSuperThreads = vi.fn(async () => {})
  const dismissOffer = vi.fn(async (_input: unknown) => ({}))
  const router = {
    current: () => ({
      view: 'tasks',
      settingsTab: null,
      issueId: null,
      worktree: null,
      pane: null,
    }),
    navigate: (route: unknown) => navigated.push(route),
  } as unknown as Router
  const runtime = {
    api: {
      layout: { get: { query: async () => ({}) } },
      superagent: { startBtw: { mutate: vi.fn(async () => ({})) } },
      sessions: {
        kill: { mutate: vi.fn(async () => ({})) },
        dismissOffer: { mutate: dismissOffer },
      },
    } as unknown as PodiumClientApi,
    hub: {} as SocketHub,
    outbox: {
      enqueue,
      pending: () => pending,
      awaiting: () => awaiting,
      retireAwaiting: vi.fn(),
    } as unknown as EngineOutbox,
    router,
    notices: { error: (message: string) => errors.push(message), info: vi.fn() } as StoreNotices,
    ...(layout.seed !== undefined ? { layoutSeed: layout.seed } : {}),
    ...(layout.installed !== undefined
      ? { onLayoutBaseInstalled: (snapshot: LayoutSnapshot) => layout.installed?.push(snapshot) }
      : {}),
    state: () => state,
    apply: (patch: Partial<typeof state>) => {
      state = { ...state, ...patch }
      publish()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    enqueueOverlayed: (kind: keyof OutboxKinds, input: unknown) => queued.push({ kind, input }),
    revealFileTab: vi.fn(),
    recordRecentFile: vi.fn(),
    spawnDraftAgent: vi.fn(() => ({ sessionId, issueId: asIssueId('issue-1') })),
    waitForSpawnConfirmed: vi.fn(async () => {}),
    setSessionDraft: vi.fn(),
    refreshSuperThreads,
  } as unknown as EngineActionRuntime<PodiumClientApi>
  return {
    actions: createEngineActions(runtime),
    refreshSuperThreads,
    dismissOffer,
    enqueue,
    pending,
    awaiting,
    retireAwaiting: runtime.outbox.retireAwaiting as ReturnType<typeof vi.fn>,
    errors,
    queued,
    navigated,
    state: () => state,
    /** Seed action state directly — the runtime's `apply`, in miniature. */
    seed: (patch: Record<string, unknown>) => {
      state = { ...state, ...patch } as typeof state
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
    const mode = (): unknown => (h.state().panelMode as Record<string, unknown>)[sessionId]

    h.actions.preferPanelMode(sessionId, 'native')
    expect(mode()).toBe('native')

    h.actions.setPanelMode(sessionId, 'chat')
    h.actions.preferPanelMode(sessionId, 'native')
    expect(mode()).toBe('chat')
  })

  it('opens one permanent tab with a nonce-guarded transcript reveal', () => {
    const h = harness()

    h.actions.openSessionAtTranscript(sessionId, 'cursor-1', { permanent: true })
    const first = h.state().transcriptReveal
    expect(first).toMatchObject({ sessionId, itemKey: 'cursor-1' })
    expect(first?.nonce).toBeTypeOf('number')
    expect(h.state().paneA).toBe(sessionId)

    h.actions.openSessionAtTranscript(sessionId, 'cursor-2', { permanent: true })
    const second = h.state().transcriptReveal
    expect(second?.nonce).toBeGreaterThan(first?.nonce ?? 0)
    expect(allTabIds((h.state().workspaces as Record<string, WorkspaceLayout>).none!)).toEqual([
      sessionId,
    ])

    h.actions.clearTranscriptReveal(first?.nonce ?? 0)
    expect(h.state().transcriptReveal).toEqual(second)
    h.actions.clearTranscriptReveal(second?.nonce ?? 0)
    expect(h.state().transcriptReveal).toBeNull()
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

  it('optimistically applies a representative replicated write while airplane-mode queues it', async () => {
    const h = harness()

    await h.actions.setPinned('panel', sessionId, true)

    expect(h.state().pins.panels).toEqual([sessionId])
    expect(h.queued).toEqual([
      { kind: 'pinSet', input: { kind: 'panel', id: sessionId, pinned: true } },
    ])
  })

  it('queues personal layout writes optimistically through the Actions-owned port', () => {
    const h = harness()

    h.actions.replicatedLayout.set('podium.superOpen.v2', '1')
    h.actions.replicatedLayout.set('dockTab', 'files')
    h.actions.replicatedLayout.set('panelMode', JSON.stringify({ [sessionId]: 'native' }))

    expect(h.actions.replicatedLayout.get('superOpen')).toBe('1')
    expect(h.actions.replicatedLayout.get('dockTab')).toBe('files')
    expect(h.queued).toEqual([
      { kind: 'layoutSet', input: { values: { superOpen: '1' } } },
      { kind: 'layoutSet', input: { values: { dockTab: 'files' } } },
      {
        kind: 'layoutSet',
        input: { values: { panelMode: JSON.stringify({ [sessionId]: 'native' }) } },
      },
    ])
  })

  it('paints a persisted layout base with no fetch, no await and no frame in between', () => {
    // POD-571. The controller used to start empty and fill from
    // `api.layout.get.query()`, so the shell mounted its DEFAULT branch first —
    // an expanded sidebar, an open Flight Deck — and swapped when the network
    // answered. Read SYNCHRONOUSLY here on purpose: an assertion behind an
    // `await` would pass just as happily against the bug it is pinning.
    const h = harness({ seed: { 'sidebar.collapsed': 'true', 'superagent.mode': 'folded' } })

    expect(h.actions.replicatedLayout.get('sidebar.collapsed')).toBe('true')
    expect(h.actions.replicatedLayout.get('podium:superagent:mode')).toBe('folded')
  })

  it('keeps a queued layout write painted over the persisted base', async () => {
    // The offline-reload fold (#263) has to survive the seed: durable optimism
    // is NEWER than the base it was queued against, so a restored queue still
    // wins. Otherwise a reload would paint the value the user just toggled away.
    const h = harness({ seed: { 'sidebar.collapsed': 'true' } })

    h.actions.replicatedLayout.set('sidebar.collapsed', 'false')

    expect(h.actions.replicatedLayout.get('sidebar.collapsed')).toBe('false')
    await vi.waitFor(() => expect(h.queued).toHaveLength(1))
  })

  it('reports authoritative bases for persistence, never the seed or unconfirmed optimism', async () => {
    // What may be written back is exactly what the authority said. A seed
    // round-trip is pointless, and persisting an unaccepted local write would
    // let it survive a reload as though the server had taken it.
    const installed: LayoutSnapshot[] = []
    const h = harness({ seed: { 'sidebar.collapsed': 'true' }, installed })

    expect(installed).toEqual([])

    h.actions.replicatedLayout.set('superOpen', '1')
    await vi.waitFor(() => expect(h.queued).toHaveLength(1))
    expect(installed).toEqual([])

    h.actions.replicatedLayout.replace({ 'sidebar.collapsed': 'false' })
    expect(installed).toEqual([{ 'sidebar.collapsed': 'false' }])
  })

  it('drops a non-layout key from the seed rather than projecting it', () => {
    // The seed comes off a persisted collection, so it is as trustworthy as the
    // disk it was read from. `installBase`'s filter is the same one every other
    // install path goes through — a device-local key must not acquire a
    // replicated home by being written into the cache.
    const h = harness({ seed: { 'sidebar.collapsed': 'true', 'podium.shell.density': 'compact' } })

    expect(h.actions.replicatedLayout.get('sidebar.collapsed')).toBe('true')
    expect(() => h.actions.replicatedLayout.get('podium.shell.density')).toThrow(
      /not a replicated layout key/,
    )
  })

  it('rolls layout reducer optimism back when durable enqueue fails', async () => {
    const h = harness()
    h.enqueue.mockRejectedValueOnce(new Error('storage unavailable'))

    h.actions.replicatedLayout.set('superOpen', '1')
    expect(h.actions.replicatedLayout.get('superOpen')).toBe('1')

    await vi.waitFor(() => expect(h.actions.replicatedLayout.get('superOpen')).toBeUndefined())
    expect(h.errors).toEqual([expect.stringContaining('storage unavailable')])
  })

  it('rolls a denied layout command back instead of leaving or retrying its overlay', async () => {
    const h = harness()
    h.actions.replicatedLayout.set('superOpen', '1')
    await Promise.resolve()
    await Promise.resolve()
    const denied = h.pending.shift()
    expect(denied).toBeDefined()

    h.actions.replicatedLayout.commandDropped(denied!)

    expect(h.actions.replicatedLayout.get('superOpen')).toBeUndefined()
  })

  it('retires an accepted command whose row is absent instead of painting a phantom', async () => {
    const h = harness()
    h.actions.replicatedLayout.set('superOpen', '1')
    await Promise.resolve()
    await Promise.resolve()
    const accepted = h.pending.shift()
    expect(accepted).toBeDefined()
    h.awaiting.push(accepted!)

    expect(h.actions.replicatedLayout.commandApplied(accepted!)).toBe(true)
    h.actions.replicatedLayout.reconcile({}, [accepted!.mutationId])

    expect(h.actions.replicatedLayout.get('superOpen')).toBeUndefined()
    expect(h.retireAwaiting).toHaveBeenCalledWith(accepted!.mutationId)
  })

  it('holds an accepted layout value across a stale feed snapshot', async () => {
    const h = harness()
    h.actions.replicatedLayout.set('superOpen', '1')
    await Promise.resolve()
    await Promise.resolve()
    const accepted = h.pending.shift()
    expect(accepted).toBeDefined()
    h.awaiting.push(accepted!)

    expect(h.actions.replicatedLayout.commandApplied(accepted!)).toBe(true)
    h.actions.replicatedLayout.reconcile({ superOpen: '1' }, [accepted!.mutationId])

    h.actions.replicatedLayout.replace({ superOpen: '0' })
    expect(h.actions.replicatedLayout.get('superOpen')).toBe('1')

    // The next matching feed snapshot releases the guard; later snapshots are
    // then allowed to represent a real newer-device change.
    h.actions.replicatedLayout.replace({ superOpen: '1' })
    h.actions.replicatedLayout.replace({ superOpen: '0' })
    expect(h.actions.replicatedLayout.get('superOpen')).toBe('0')
  })

  it('suppresses old-scope layout overlays on rescope while keeping the command recoverable', async () => {
    const h = harness()
    h.actions.replicatedLayout.set('superOpen', '1')
    await Promise.resolve()
    await Promise.resolve()

    h.actions.replicatedLayout.rescope({ dockTab: 'git' })

    expect(h.actions.replicatedLayout.get('superOpen')).toBeUndefined()
    expect(h.actions.replicatedLayout.get('dockTab')).toBe('git')
    expect(h.pending).toHaveLength(1)
  })

  it('fails closed for a device-local key without touching the Outbox', () => {
    const h = harness()
    expect(() => h.actions.replicatedLayout.set('podium.split', '1')).toThrow(
      /not a replicated layout key/,
    )
    expect(h.queued).toEqual([])
  })

  it('rolls reducer optimism back when durable enqueue itself fails', async () => {
    const h = harness()
    h.enqueue.mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(h.actions.setPinned('panel', sessionId, true)).rejects.toThrow(
      'storage unavailable',
    )
    expect(h.state().pins.panels).toEqual([])
  })

  it('never accepts client attribution fields in assembled command payloads', async () => {
    const h = harness()
    await h.actions.setPinned('panel', sessionId, true)
    await h.actions.setTabOrder('/worktree', [sessionId])
    await h.actions.renameSession(sessionId, 'new name')
    h.actions.replicatedLayout.set('superOpen', '1')
    h.actions.replicatedLayout.clear('superOpen')

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
 * The pane scalars are a MIRROR of the layout (POD-710). Every case here is one
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
      focusedPane: 'B',
    })

    await h.actions.killSession(sessionId)

    // The mirror computed `split: false` all along; killSession cherry-picked
    // `workspaces`/`paneA`/`paneB` out of the patch and dropped it, leaving a
    // phantom second pane that no later write could clear — the compatibility
    // clause saw one leaf both before and after and stopped writing `split`.
    const st = h.state()
    expect(st.split).toBe(false)
    expect(st.paneB).toBeNull()
    expect(st.focusedPane).toBe('A')
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
      focusedPane: 'B',
    })

    h.actions.closeFileTab(fileId)

    const st = h.state()
    expect(st.split).toBe(false)
    expect(st.paneB).toBeNull()
    expect(st.fileTabs).toEqual([])
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

  it('mints no thread: the attachment is local until the turn that carries it', async () => {
    // There is nothing to refresh a thread list FOR any more. The session rides
    // the next `sendTurn` as `attachSessionId` and the server digests it into
    // that turn's preamble, so an offline client can still line one up.
    const h = harness()

    await h.actions.startBtw(asSessionId('sess-btw'))

    expect(h.refreshSuperThreads).not.toHaveBeenCalled()
    expect(h.queued).toEqual([])
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
  const issue = (id: string) => ({ id: asIssueId(id) }) as unknown as IssueWire
  const meta = (id: string, ownedBy: string): SessionMeta =>
    ({
      sessionId: asSessionId(id),
      cwd: '/wt',
      archived: false,
      issueId: asIssueId(ownedBy),
    }) as unknown as SessionMeta

  it('opens the tab for a session that arrives AFTER the start resolved', async () => {
    const h = harness()
    h.seed({ issues: [issue('issue-1')] })

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

    h.seed({ issues: [issue('issue-1')] })
    expect(await landed).toBe('session-1')
    expect(Object.keys(h.state().workspaces)).toEqual(['mission:issue-1'])
  })

  it('does not overrule an operator who selected another task while it waited', async () => {
    const h = harness()
    h.seed({ issues: [issue('issue-1'), issue('issue-2')] })

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
      issues: [issue('issue-1')],
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
    h.seed({ issues: [issue('issue-1')] })

    expect(await h.actions.focusIssueSession(issueId, { timeoutMs: 1 })).toBeNull()
    expect(h.state().selectedIssueId).toBe(issueId)
    expect(h.navigated).toEqual([])
  })
})
