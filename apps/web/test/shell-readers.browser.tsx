/** Real production consumers and one offline runtime. Every row is synthetic. */
import type { ClientRuntime, Store } from '@podium/client-core/engine'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { beginSidebarCheck, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { asIssueId, asUserId } from '@podium/model/browser'
import { observer } from '@podium/client-graph/react'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { ApprovalDialog } from '../src/app/ApprovalDialog'
import { AutoContinueDialog } from '../src/app/AutoContinueDialog'
import { BrowserOpenOverlay } from '../src/app/BrowserOpenOverlay'
import { CommandPaletteBoundary } from '../src/app/CommandPaletteBoundary'
import { MachinesPanel } from '../src/app/MachinesPanel'
import { RightDock } from '../src/app/RightDock'
import { RightRail } from '../src/app/RightRail'
import { DesktopCloseTab } from '../src/app/use-desktop-close-tab'
import { initializePoolScreens } from '../src/app/pool-screens'
import { useShellChrome, useShellClose, useShellDock } from '../src/app/shell-data'
import { shellDataLayer } from '../src/app/shell-pool-screen'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { PodiumLinkHost } from '../src/components/PodiumLinkHost'
import { activatePodiumHref } from '../src/lib/podium-link'
import { ConfirmProvider } from '../src/lib/hooks/use-confirm'
import type { SidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import { createHeaderFixture } from './header-fixture'
import '../src/index.css'
import '../src/styles.css'

initializePoolScreens({ get: () => null } as never)
const count = Number(new URLSearchParams(location.search).get('rows') ?? 5600)
const fixture = createHeaderFixture(count, Math.min(count, 5014))
const artifactIssueId = `synthetic-${count - 1}`, artifactRef = `SYN-${1000 + count - 1}`
const artifactRecord = fixture.records.get(`issueProjection:${artifactIssueId}`)!
fixture.records.set(`issueProjection:${artifactIssueId}`, { ...artifactRecord, value: { ...artifactRecord.value as object,
  stage: 'done', archived: true, updatedAt: '2026-01-01T00:00:00Z', panel: { todos: [], artifacts: [{
    artifactId: 'synthetic-artifact', path: 'review/index.html', entry: 'index.html', addedAt: '2026-01-01T00:00:00Z', files: [{ path: 'index.html', size: 3 }],
  }] },
} })
// Exercise shipping values without a server or any shipping command.
const orders = ['waiting', 'needs_you', 'in_progress', 'shipped'].map((humanState, index) => ({
  id: `synthetic-order-${index}`, issueId: `synthetic-${index}`, repoId: 'synthetic-repo', destination: 'main',
  targetBranch: `issue/synthetic-${index}`, humanState, state: humanState === 'shipped' ? 'completed' : 'queued',
  activity: humanState === 'waiting' ? 'waiting' : humanState === 'shipped' ? 'shipped' : 'held',
  queuedAt: new Date(Date.now() - 60000).toISOString(), stateChangedAt: new Date(Date.now() - 60000).toISOString(), queueRank: 99,
}))
for (const value of orders) fixture.records.set(`shipOrder:${value.id}`, { entity: 'shipOrder', entityId: value.id, value, provenance: { seq: 1 } })
const lane = { id: 'synthetic-lane', repoId: 'synthetic-repo', destination: 'main', trains: [{ orderIds: [orders[0]!.id] }], blockedOrderIds: [] }
fixture.records.set(`shipLane:${lane.id}`, { entity: 'shipLane', entityId: lane.id, value: lane, provenance: { seq: 1 } })
const lifecycle = { ...fixture.inputs().lifecycle, autoContinue: { enabled: false, promptDismissed: false } }
Object.assign(fixture.api, {
  settings: { get: { query: async () => lifecycle }, updatePersonal: { mutate: async () => ({}) } },
  approvals: { approve: { mutate: async () => ({}) }, deny: { mutate: async () => ({}) } },
  features: { state: { query: async () => ({ devMode: true, channel: 'edge', flags: ['shipping', 'git-panel', 'messages-panel', 'merge-queue'] }) } },
  setup: { info: { query: async () => ({ version: 'synthetic', serverVersion: 'synthetic' }) } },
  updates: { fleet: { query: async () => [] } },
  operations: { active: { query: async () => [] }, history: { query: async () => [] } },
})
let runtime: ClientRuntime | undefined, pool: ReturnType<typeof useWorklistPool> = null
let ready = false, started = false
let capture: ReturnType<typeof storeStats.begin> | undefined
const failures: string[] = [], effects = { dismisses: 0, callbacks: 0 }
storeStats.enable()
document.documentElement.classList.add('dark')
const emit = (kind: string, value: unknown) => (runtime!.hub as unknown as { emit(kind: string, value: unknown): void }).emit(kind, value)
const apply = (value: object) => (runtime as unknown as { apply(value: object): void }).apply(value)
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

const Chrome = observer(function Chrome() {
  const chrome = useShellChrome(), dock = useShellDock(), close = useShellClose()
  return <section data-proof="chrome" className="p-4 border-b space-y-2">
    <h1>Shell controls parity</h1>
    <p data-mission>{chrome.missionRoot?.id ?? 'none'} · {chrome.missionRoot?.title ?? 'No mission'}</p>
    <p>{chrome.repoCount} repositories · {chrome.worktreeCount} worktrees · {chrome.sessionCount} sessions</p>
    <p>Palette {String(chrome.paletteOpen)} · Superagent {String(chrome.superOpen)} · {close?.workspaceKey ?? 'loading'}</p>
    <p>Dock {dock.active?.cwd ?? 'none'} · {dock.gitIssue?.id ?? 'none'} · {dock.mailIssueId ?? 'none'}</p>
  </section>
})
function Surfaces() {
  const owner = useStoreHandle() as ClientRuntime, graph = useWorklistPool()
  useEffect(() => {
    runtime = owner; pool = graph
    if (!started) {
      started = true
      owner.getSnapshot().setSelectedIssueId(asIssueId('synthetic-3'))
      owner.getSnapshot().openFileInWorktree({ root: '/synthetic/project', path: 'readme.md' })
      owner.getSnapshot().setSuperOpen(true)
    }
    ready = shellDataLayer() === 'legacy' || Boolean(graph?.row('shellWindow', 'window'))
  }, [owner, graph])
  return <div className="min-h-screen bg-background text-foreground">
    <Chrome />
    <a href={`/issues/${artifactRef}/artifacts/synthetic-artifact/index.html`} data-testid="cold-artifact-link"
      onClick={event => { if (activatePodiumHref(event.currentTarget.href)) event.preventDefault() }}>Open cold artifact</a>
    <div className="flex"><section data-proof="machines" className="w-1/2 p-4"><MachinesPanel /></section>
      <section data-proof="dock" className="w-1/2 min-h-[400px]"><RightDock tab="shipping" onClose={() => {}} /></section>
      <section data-proof="rail"><RightRail rightPanel="shipping" onPanelChange={() => {}} /></section></div>
    <ApprovalDialog /><AutoContinueDialog /><BrowserOpenOverlay /><PodiumLinkHost /><DesktopCloseTab /><CommandPaletteBoundary /><Toaster />
  </div>
}
const root = createRoot(document.getElementById('root')!)
root.render(<StoreProvider principal={asClientPrincipal(asUserId('operator'))}
  config={{ httpOrigin: location.origin, wsClientUrl: 'ws://offline.invalid' }} api={fixture.api}
  createReplicaFn={() => fixture.newReplica()} networkEnabled={false}
  onFatalError={message => failures.push(message)} attachRuntime={owner => {
    runtime = owner; fixture.bindHub(owner.hub); fixture.publishMachines()
    Object.assign(owner.hub, { dismissOpenUrl: () => { effects.dismisses++ }, submitOpenUrlCallback: () => { effects.callbacks++ } })
    void owner.getSnapshot().refreshRepos()
    return attachWorklistPool(owner, error => failures.push(error.message))
  }}><ConfirmProvider><Surfaces /></ConfirmProvider></StoreProvider>)

const driver = {
  ready: () => ready, close: () => root.unmount(), failures: () => failures.length,
  reset() { storeStats.reset(); capture = storeStats.begin('feed') },
  async activity(steps: number) {
    for (let step = 0; step < steps; step++) {
      fixture.patch('session', `synthetic-session-${step % 12}`, { lastActiveAt: new Date(Date.now() + step + 1).toISOString(),
        agentState: { phase: Math.floor(step / 12) % 2 ? 'working' : 'idle', since: new Date(Date.now() + step + 1).toISOString() } })
      await frame()
    }
    if (capture) { storeStats.end(capture); capture = undefined }
  },
  stats() {
    const all = storeStats.snapshot(), runtimes = all.windows.at(-1)?.runtimes ?? all.runtimes
    return { runtimeCount: runtimes.filter(row => row.publishes > 0).length, diagnosticOwners: runtimes.length, dropped: all.dropped,
      publishes: runtimes.reduce((sum, row) => sum + row.publishes, 0),
      selectors: runtimes.reduce((sum, row) => sum + row.selectorRuns, 0), wakes: runtimes.reduce((sum, row) => sum + row.subscriberWakes, 0),
      legacyDerivations: runtimes.reduce((sum, row) => sum + Object.values(row.slices).reduce((total, value) => total + value, 0), 0), failures: failures.length }
  },
  async check() {
    if (!pool || !runtime) return null
    const { checkShell, poolShellSnapshot } = await import('@podium/client-graph/diagnostics/shell-check')
    const finish = beginSidebarCheck(runtime)
    try {
      for (let round = 0; round < 64; round++) { poolShellSnapshot(pool); if (!pool.hydrate()) break }
      return checkShell(pool, runtime.getSnapshot())
    } finally { finish() }
  },
  snapshot(): SidebarSnapshot {
    const sections = [...document.querySelectorAll<HTMLElement>('[data-proof]')].map(node => ({ key: node.dataset.proof!,
      fields: { text: node.innerText.replace(/\s+/g, ' ').trim(), buttons: [...node.querySelectorAll('button')].map(button => ({
        label: button.getAttribute('aria-label') ?? button.textContent?.trim(), pressed: button.getAttribute('aria-pressed'), disabled: button.disabled,
      })) }, rows: [] }))
    for (const [key, selector] of [['approval', '[role=alertdialog]'], ['prompt', '[role=dialog]'], ['browser', '[aria-label="Pending agent browser requests"]']] as const) {
      const node = document.querySelector<HTMLElement>(selector)
      sections.push({ key, fields: { text: node?.innerText.replace(/\s+/g, ' ').trim() ?? '', buttons: [] }, rows: [] })
    }
    return { pending: 0, sections }
  },
  select(id: string | null) { runtime!.getSnapshot().setSelectedIssueId(id ? asIssueId(id) : null) },
  approvals() { emit('approvals', [0, 1].map(index => ({ id: `synthetic-approval-${index}`, machineId: 'host-one', machineName: 'Host 1',
    sessionId: `synthetic-session-${index}`, issueSeq: 1000 + index, issueDisplayRef: `SYN-${1000 + index}`, issueTitle: `Synthetic task ${index}`,
    op: { kind: 'channel', target: 'dev' }, status: 'pending', createdAt: new Date().toISOString() }))) },
  prompt() { apply({ autoContinuePromptSessionId: 'synthetic-session-0' }) },
  browser() { emit('openUrl', { type: 'sessionOpenUrl', sessionId: 'synthetic-session-0', requestId: 'synthetic-login',
    url: 'https://synthetic.example.invalid/login', intent: 'login', callbackTarget: { port: 12345, path: '/callback' } }) },
  effects: () => ({ ...effects }),
  activate: () => activatePodiumHref('/issues/SYN-1003'),
  closeTab() { return (globalThis as { __PODIUM_CLOSE_TAB__?: () => boolean }).__PODIUM_CLOSE_TAB__?.() ?? false },
  state: () => ({ files: runtime!.getSnapshot().fileTabs.length, selected: runtime!.getSnapshot().selectedIssueId }),
  artifacts: () => runtime!.getSnapshot().fileTabs.filter(file => file.scope.kind === 'artifact').length,
  artifactCold: () => pool?.residency?.isCold('issue', artifactIssueId) ?? null,
}
Object.assign(window, { __shellReaders: driver })
declare global { interface Window { __shellReaders: typeof driver } }
