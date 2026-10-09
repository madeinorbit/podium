import { omitGone } from '@podium/client-graph/lookup'
import { referenceState } from '../../../tests/worklist/diagnostics/reference-state'
/** Real production consumers and one offline runtime. Every row is synthetic. */
import type { ClientRuntime } from '@podium/client-core/engine'
import type { ReferenceState as Store } from '../../../tests/worklist/diagnostics/reference-state'
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import type { SidebarSnapshot } from '../../../tests/worklist/diagnostics/sidebar-check'
import { observer } from '@podium/client-graph/react'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asIssueId, asSessionId, asUserId } from '@podium/model/browser'
import { Profiler, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { ApprovalDialog } from '../src/app/ApprovalDialog'
import { AutoContinueDialog } from '../src/app/AutoContinueDialog'
import { BrowserOpenOverlay } from '../src/app/BrowserOpenOverlay'
import { CommandPaletteBoundary } from '../src/app/CommandPaletteBoundary'
import { isComplexFlightDeckMission } from '../src/app/flight-deck-display'
import { MachinesPanel } from '../src/app/MachinesPanel'
import { RightDock } from '../src/app/RightDock'
import { RightRail } from '../src/app/RightRail'
import { useShellChrome, useShellClose, useShellDock } from '../src/app/shell-data'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { DesktopCloseTab } from '../src/app/use-desktop-close-tab'
import { PodiumLinkHost } from '../src/components/PodiumLinkHost'
import { ConfirmProvider } from '../src/lib/hooks/use-confirm'
import { activatePodiumHref } from '../src/lib/podium-link'
import { createHeaderFixture } from './header-fixture'
import '../src/index.css'
import '../src/styles.css'

const sessionIndex = { calls: 0, first: undefined as string | undefined }
Object.assign(globalThis, { __shellSessionIndex: sessionIndex })
const count = Number(new URLSearchParams(location.search).get('rows') ?? 5600)
const fixture = createHeaderFixture(count, Math.min(count, 5014))
const artifactIssueId = `synthetic-${count - 1}`,
  artifactRef = `SYN-${1000 + count - 1}`
const artifactRecord = fixture.records.get(`issueProjection:${artifactIssueId}`)!
fixture.records.set(`issueProjection:${artifactIssueId}`, {
  ...artifactRecord,
  value: {
    ...(artifactRecord.value as object),
    stage: 'done',
    archived: true,
    updatedAt: '2026-01-01T00:00:00Z',
    panel: {
      todos: [],
      artifacts: [
        {
          artifactId: 'synthetic-artifact',
          path: 'review/index.html',
          entry: 'index.html',
          addedAt: '2026-01-01T00:00:00Z',
          files: [{ path: 'index.html', size: 3 }],
        },
      ],
    },
  },
})
// Exercise shipping values without a server or any shipping command.
const orders = ['waiting', 'needs_you', 'in_progress', 'shipped'].map((humanState, index) => ({
  id: `synthetic-order-${index}`,
  issueId: `synthetic-${index}`,
  repoId: 'synthetic-repo',
  destination: 'main',
  targetBranch: `issue/synthetic-${index}`,
  humanState,
  state: humanState === 'shipped' ? 'completed' : 'queued',
  activity: humanState === 'waiting' ? 'waiting' : humanState === 'shipped' ? 'shipped' : 'held',
  queuedAt: new Date(Date.now() - 60000).toISOString(),
  stateChangedAt: new Date(Date.now() - 60000).toISOString(),
  queueRank: 99,
}))
for (const value of orders)
  fixture.records.set(`shipOrder:${value.id}`, {
    entity: 'shipOrder',
    entityId: value.id,
    value,
    provenance: { seq: 1 },
  })
const lane = {
  id: 'synthetic-lane',
  repoId: 'synthetic-repo',
  destination: 'main',
  trains: [{ orderIds: [orders[0]!.id] }],
  blockedOrderIds: [],
}
fixture.records.set(`shipLane:${lane.id}`, {
  entity: 'shipLane',
  entityId: lane.id,
  value: lane,
  provenance: { seq: 1 },
})
const lifecycle = {
  ...fixture.inputs().lifecycle,
  autoContinue: { enabled: false, promptDismissed: false },
}
Object.assign(fixture.api, {
  settings: { get: { query: async () => lifecycle }, updatePersonal: { mutate: async () => ({}) } },
  approvals: { approve: { mutate: async () => ({}) }, deny: { mutate: async () => ({}) } },
  features: {
    state: {
      query: async () => ({
        devMode: true,
        channel: 'edge',
        flags: ['shipping', 'git-panel', 'messages-panel', 'merge-queue'],
      }),
    },
  },
  setup: { info: { query: async () => ({ version: 'synthetic', serverVersion: 'synthetic' }) } },
  updates: { fleet: { query: async () => [] } },
  operations: { active: { query: async () => [] }, history: { query: async () => [] } },
})
let runtime: ClientRuntime | undefined,
  pool: ReturnType<typeof useWorklistPool> = null
let ready = false,
  started = false
let capture: ReturnType<typeof storeStats.begin> | undefined
const failures: string[] = [],
  effects = { dismisses: 0, callbacks: 0 }
const commits: Record<string, number> = { chrome: 0, dock: 0, rail: 0, machines: 0 }
const recordCommit = (id: string) => {
  commits[id] = (commits[id] ?? 0) + 1
}
storeStats.enable()
document.documentElement.classList.add('dark')
const emit = (kind: string, value: unknown) =>
  (runtime!.hub as unknown as { emit(kind: string, value: unknown): void }).emit(kind, value)
const apply = (value: object) => (runtime as unknown as { apply(value: object): void }).apply(value)
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

const ChromeControls = observer(function ChromeControls() {
  const chrome = useShellChrome()
  return (
    <>
      <h1>Shell controls parity</h1>
      <p data-mission>
        {chrome.missionRoot?.id ?? 'none'} · {chrome.missionRoot?.title ?? 'No mission'}
      </p>
      <p>
        {isComplexFlightDeckMission(chrome.missionRoot) ? 'Expanded' : 'Compact'} mission chrome
      </p>
      <p>
        {chrome.repoCount} repositories · {chrome.worktreeCount} worktrees · {chrome.sessionCount}{' '}
        sessions
      </p>
      <p>
        Palette {String(chrome.paletteOpen)} · Superagent {String(chrome.superOpen)}
      </p>
    </>
  )
})
function dockFields(dock: ReturnType<typeof useShellDock>) {
  const shown = <T,>(value: T | typeof LOADING | undefined) => (value === LOADING ? undefined : value)
  return { active: shown(dock?.active), gitIssue: shown(dock?.gitIssue), mailIssueId: shown(dock?.mailIssueId) }
}
const DockContext = observer(function DockContext() {
  const dock = dockFields(useShellDock()),
    close = useShellClose()
  return (
    <>
      <p>{close?.workspaceKey ?? 'loading'}</p>
      <p>
        Dock {dock.active?.cwd ?? 'none'} · {dock.gitIssue?.id ?? 'none'} ·{' '}
        {dock.mailIssueId ?? 'none'}
      </p>
    </>
  )
})
function Surfaces() {
  const owner = useStoreHandle() as ClientRuntime,
    graph = useWorklistPool()
  useEffect(() => {
    runtime = owner
    pool = graph
    if (!started && graph) {
      started = true
      referenceState(owner).setSelectedIssueId(asIssueId('synthetic-3'))
      referenceState(owner).openFileInWorktree({ root: '/synthetic/project', path: 'readme.md' })
      referenceState(owner).setSuperOpen(true)
    }
    ready = started && Boolean(graph) && Boolean(omitGone(graph?.row('shellWindow', 'window')))
  }, [owner, graph])
  return (
    <div className="min-h-screen bg-background text-foreground">
      <section data-proof="chrome" className="p-4 border-b space-y-2">
        <Profiler id="chrome" onRender={recordCommit}>
          <ChromeControls />
        </Profiler>
        <DockContext />
        <button
          type="button"
          data-testid="ordinary-shell-click"
          onClick={() => referenceState(owner).setPane('A', asSessionId('synthetic-session-3'))}
        >
          Select existing session
        </button>
      </section>
      <a
        href={`/issues/${artifactRef}/artifacts/synthetic-artifact/index.html`}
        data-testid="cold-artifact-link"
        onClick={(event) => {
          if (activatePodiumHref(event.currentTarget.href)) event.preventDefault()
        }}
      >
        Open cold artifact
      </a>
      <div className="flex">
        <section data-proof="machines" className="w-1/2 p-4">
          <Profiler id="machines" onRender={recordCommit}>
            <MachinesPanel />
          </Profiler>
        </section>
        <section data-proof="dock" className="w-1/2 min-h-[400px]">
          <Profiler id="dock" onRender={recordCommit}>
            <RightDock tab="shipping" onClose={() => {}} />
          </Profiler>
        </section>
        <section data-proof="rail">
          <Profiler id="rail" onRender={recordCommit}>
            <RightRail rightPanel="shipping" onPanelChange={() => {}} />
          </Profiler>
        </section>
      </div>
      <ApprovalDialog />
      <AutoContinueDialog />
      <BrowserOpenOverlay />
      <PodiumLinkHost />
      <DesktopCloseTab />
      <CommandPaletteBoundary />
      <Toaster />
    </div>
  )
}
const root = createRoot(document.getElementById('root')!)
root.render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('operator'))}
    config={{ httpOrigin: location.origin, wsClientUrl: 'ws://offline.invalid' }}
    api={fixture.api}
    createReplicaFn={() => fixture.newReplica()}
    networkEnabled={false}
    onFatalError={(message) => failures.push(message)}
    attachRuntime={(owner) => {
      runtime = owner
      fixture.bindHub(owner.hub)
      fixture.publishMachines()
      Object.assign(owner.hub, {
        dismissOpenUrl: () => {
          effects.dismisses++
        },
        submitOpenUrlCallback: () => {
          effects.callbacks++
        },
      })
      void referenceState(owner).refreshRepos()
      return attachWorklistPool(owner, (error) => failures.push(error.message))
    }}
  >
    <ConfirmProvider>
      <Surfaces />
    </ConfirmProvider>
  </StoreProvider>,
)

const driver = {
  ready: () => ready,
  close: () => root.unmount(),
  failures: () => failures.length,
  resetCommits() {
    for (const id of Object.keys(commits)) commits[id] = 0
  },
  commits: () => ({ ...commits }),
  reset() {
    storeStats.reset()
    sessionIndex.calls = 0
    sessionIndex.first = undefined
    capture = storeStats.begin('feed')
  },
  async activity(steps: number) {
    for (let step = 0; step < steps; step++) {
      fixture.patch('session', `synthetic-session-${step % 12}`, {
        lastActiveAt: new Date(Date.now() + step + 1).toISOString(),
        agentState: {
          phase: Math.floor(step / 12) % 2 ? 'working' : 'idle',
          since: new Date(Date.now() + step + 1).toISOString(),
        },
      })
      await frame()
    }
    if (capture) {
      storeStats.end(capture)
      capture = undefined
    }
  },
  stats() {
    const all = storeStats.snapshot(),
      runtimes = all.windows.at(-1)?.runtimes ?? all.runtimes
    return {
      runtimeCount: runtimes.filter((row) => row.publishes > 0).length,
      diagnosticOwners: runtimes.length,
      dropped: all.dropped,
      sessionIndexCalls: sessionIndex.calls,
      firstSessionIndexCaller: sessionIndex.first ?? null,
      feedUpdates: 200,
      publishes: runtimes.reduce((sum, row) => sum + row.publishes, 0),
      selectors: runtimes.reduce((sum, row) => sum + row.selectorRuns, 0),
      wakes: runtimes.reduce((sum, row) => sum + row.subscriberWakes, 0),
      legacyDerivations: runtimes.reduce(
        (sum, row) => sum + Object.values(row.slices).reduce((total, value) => total + value, 0),
        0,
      ),
      failures: failures.length,
    }
  },
  async check() {
    if (!pool || !runtime) return null
    const { checkShell, poolShellSnapshot } = await import(
      '../../../tests/worklist/diagnostics/shell-check'
    )
    for (let round = 0; round < 64; round++) {
      poolShellSnapshot(pool)
      if (!pool.hydrate()) break
    }
    return checkShell(pool, referenceState(runtime))
  },
  snapshot(): SidebarSnapshot {
    const sections = [...document.querySelectorAll<HTMLElement>('[data-proof]')].map((node) => ({
      key: node.dataset.proof!,
      fields: {
        text: node.innerText.replace(/\s+/g, ' ').trim(),
        buttons: [...node.querySelectorAll('button')].map((button) => ({
          label: button.getAttribute('aria-label') ?? button.textContent?.trim(),
          pressed: button.getAttribute('aria-pressed'),
          disabled: button.disabled,
        })),
      },
      rows: [],
    }))
    for (const [key, selector] of [
      ['approval', '[role=alertdialog]'],
      ['prompt', '[role=dialog]'],
      ['browser', '[aria-label="Pending agent browser requests"]'],
    ] as const) {
      const node = document.querySelector<HTMLElement>(selector)
      sections.push({
        key,
        fields: { text: node?.innerText.replace(/\s+/g, ' ').trim() ?? '', buttons: [] },
        rows: [],
      })
    }
    return { pending: 0, sections }
  },
  select(id: string | null) {
    referenceState(runtime!).setSelectedIssueId(id ? asIssueId(id) : null)
  },
  approvals() {
    emit(
      'approvals',
      [0, 1].map((index) => ({
        id: `synthetic-approval-${index}`,
        machineId: 'host-one',
        machineName: 'Host 1',
        sessionId: `synthetic-session-${index}`,
        issueSeq: 1000 + index,
        issueDisplayRef: `SYN-${1000 + index}`,
        issueTitle: `Synthetic task ${index}`,
        op: { kind: 'channel', target: 'dev' },
        status: 'pending',
        createdAt: new Date().toISOString(),
      })),
    )
  },
  prompt() {
    apply({ autoContinuePromptSessionId: 'synthetic-session-0' })
  },
  browser() {
    emit('openUrl', {
      type: 'sessionOpenUrl',
      sessionId: 'synthetic-session-0',
      requestId: 'synthetic-login',
      url: 'https://synthetic.example.invalid/login',
      intent: 'login',
      callbackTarget: { port: 12345, path: '/callback' },
    })
  },
  effects: () => ({ ...effects }),
  activate: () => activatePodiumHref('/issues/SYN-1003'),
  closeTab() {
    return (
      (globalThis as { __PODIUM_CLOSE_TAB__?: () => boolean }).__PODIUM_CLOSE_TAB__?.() ?? false
    )
  },
  state: () => ({
    files: referenceState(runtime!).fileTabs.length,
    selected: referenceState(runtime!).selectedIssueId,
    pane: referenceState(runtime!).paneA,
  }),
  artifacts: () =>
    referenceState(runtime!).fileTabs.filter((file) => file.scope.kind === 'artifact').length,
  artifactCold: () => pool?.residency?.isCold('issue', artifactIssueId) ?? null,
}
Object.assign(window, { __shellReaders: driver })
declare global {
  interface Window {
    __shellReaders: typeof driver
  }
}
