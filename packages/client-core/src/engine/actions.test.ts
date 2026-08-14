import type { LayoutSnapshot, SessionMeta } from '@podium/model'
import { asIssueId, asMutationId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry } from '../outbox'
import type { SocketHub } from '../socket-transport'
import type { Router } from '../ui-state'
import { emptyWorkspace, openTab, splitPane, type WorkspaceLayout } from '../viewmodels'
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
    },
  }
}

describe('engine action ownership boundary', () => {
  it('keeps command and device-local classifications disjoint', () => {
    expect(new Set([...COMMAND_ACTIONS, ...UI_LOCAL_ACTIONS]).size).toBe(
      COMMAND_ACTIONS.length + UI_LOCAL_ACTIONS.length,
    )
  })

  it('sends an offer dismissal straight at the server, never through the Outbox', async () => {
    const h = harness()

    await h.actions.dismissOffer(sessionId, '2026-08-06T12:00:00.000Z')

    // `offline: 'direct-only'` by contract. A queued dismissal draining hours
    // later would aim at whatever offer is standing by then, and the stamp guard
    // would turn that into a silent no-op rather than a correct write.
    expect(h.dismissOffer).toHaveBeenCalledWith({
      sessionId,
      offerCreatedAt: '2026-08-06T12:00:00.000Z',
    })
    expect(h.queued).toEqual([])
  })

  it('lets an offer dismissal failure reach the caller', async () => {
    const h = harness()
    h.dismissOffer.mockRejectedValueOnce(new Error('offline'))

    // Swallowing it would leave the surface claiming the offer is gone while the
    // server still holds it — the caller un-hides its control on this rejection.
    await expect(h.actions.dismissOffer(sessionId, '2026-08-06T12:00:00.000Z')).rejects.toThrow(
      'offline',
    )
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
