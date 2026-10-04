import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
/** Actual menus, one existing offline runtime/replica/outbox. Synthetic data only. */
import type { ClientRuntime } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { asIssueId, asMachineId, asSessionId, asUserId } from '@podium/model/browser'
import { Profiler, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CommandPaletteBoundary } from '../src/app/CommandPaletteBoundary'
import { NewPanelMenu } from '../src/app/NewPanelMenu'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { NewIssueDialog } from '../src/features/issues/NewIssueDialog'
import { ConfirmProvider } from '../src/lib/hooks/use-confirm'
import { createHeaderFixture } from './header-fixture'
import '../src/index.css'
import '../src/styles.css'

const fixture = createHeaderFixture(5600, 5014)
const calls: { kind: string; input: unknown }[] = [],
  failures: string[] = []
const api = fixture.api as unknown as Record<string, unknown>
const machine = {
  id: 'host-one',
  name: 'Synthetic host',
  hostname: 'synthetic-host',
  online: true,
  lastSeenAt: new Date().toISOString(),
  serviceAssignment: { agentExecution: true },
  availability: { daemon: true },
  inventory: {
    agents: [
      { kind: 'codex', installed: true, login: { state: 'in' } },
      { kind: 'claude-code', installed: true, login: { state: 'in' } },
    ],
  },
}
const repos = [
  {
    path: '/synthetic/project',
    repoId: 'synthetic-repo',
    kind: 'repository',
    branch: 'main',
    machineId: machine.id,
    worktrees: [{ path: '/synthetic/project/guests', branch: 'guests' }],
  },
  {
    path: '/synthetic/empty',
    repoId: 'empty-repo',
    kind: 'repository',
    branch: 'main',
    machineId: machine.id,
    worktrees: [],
  },
]
api.discovery = {
  refreshRepos: {
    mutate: async () => ({ repositories: repos, machines: [machine], diagnostics: [] }),
  },
}
api.sessions = {
  create: {
    mutate: async (input: unknown) => {
      calls.push({ kind: 'session', input })
      return { sessionId: asSessionId('synthetic-launched') }
    },
  },
}
api.issues = {
  searchNormalized: { query: async () => [] },
  create: {
    mutate: async (input: unknown) => {
      calls.push({ kind: 'issue', input })
      return { id: asIssueId('synthetic-created') }
    },
  },
  update: {
    mutate: async (input: unknown) => {
      calls.push({ kind: 'update', input })
      return {}
    },
  },
}
let owner: ClientRuntime,
  pool: ReturnType<typeof useWorklistPool> = null,
  booted = false,
  commits = 0,
  commitMs = 0
storeStats.enable()
document.documentElement.classList.add('dark')
document.documentElement.dataset.theme = 'podium'
function Surface() {
  const runtime = useStoreHandle() as ClientRuntime
  owner = runtime
  pool = useWorklistPool()
  const [newIssue, setNewIssue] = useState(false),
    [opened, setOpened] = useState('')
  useEffect(() => {
    let active = true
    void referenceState(runtime)
      .refreshRepos()
      .then(() => {
        if (active) booted = true
      })
    return () => {
      active = false
      booted = false
    }
  }, [runtime])
  return (
    <main style={{ margin: '80px auto', maxWidth: 720 }}>
      <h1>Command and launch choices</h1>
      <p>5,600 synthetic tasks · 5,014 sessions</p>
      <button type="button" onClick={() => referenceState(owner).setPaletteOpen(true)}>
        Open commands
      </button>
      <button type="button" onClick={() => setNewIssue(true)}>
        New task composer
      </button>
      <Profiler
        id="menus"
        onRender={(_id, _phase, duration) => {
          commits++
          commitMs += duration
        }}
      >
        <CommandPaletteBoundary />
        <NewPanelMenu
          worktree={{
            path: '/synthetic/project',
            repoPath: '/synthetic/project',
            isMain: true,
            machineId: asMachineId(machine.id),
          }}
          onOpened={(id) => setOpened(id)}
        />
        {newIssue && <NewIssueDialog onClose={() => setNewIssue(false)} />}
      </Profiler>
      <output data-launched>{opened}</output>
    </main>
  )
}
const root = createRoot(document.getElementById('root')!)
root.render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('command-synthetic'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={fixture.api}
    createReplicaFn={() => fixture.newReplica()}
    networkEnabled={false}
    onFatalError={(error) => failures.push(error)}
    attachRuntime={(runtime) => {
      fixture.bindHub(runtime.hub)
      return attachWorklistPool(runtime, (error) => failures.push(error.message))
    }}
  >
    <ConfirmProvider>
      <Surface />
    </ConfirmProvider>
  </StoreProvider>,
)
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const driver = {
  ready: () => booted && pool !== null && typeof pool.row('commandWindow', 'window') === 'object',
  reset() {
    storeStats.reset()
    commits = 0
    commitMs = 0
  },
  async activity(count: number) {
    for (let step = 1; step <= count; step++) {
      fixture.activity(step)
      await frame()
    }
  },
  stats() {
    const runtimes = storeStats.snapshot().runtimes
    return {
      selectors: runtimes.reduce((sum, row) => sum + row.selectorRuns, 0),
      legacyDerivations: runtimes.reduce(
        (sum, row) => sum + Object.values(row.slices).reduce((a, n) => a + n, 0),
        0,
      ),
      commits,
      commitMs,
      failures: [...failures],
    }
  },
  calls: () => calls,
  selection: () => ({ issueId: referenceState(owner).openIssueId, view: referenceState(owner).view }),
  async check() {
    if (!pool) return null
    const { checkCommandLaunch, poolCommandLaunchSnapshot } = await import(
      '@podium/client-graph/diagnostics/command-launch-check'
    )
    for (let round = 0; round < 32; round++) {
      poolCommandLaunchSnapshot(pool)
      if (!pool.hydrate()) break
    }
    const result = checkCommandLaunch(pool, referenceState(owner))
    return {
      differences: result.differences,
      pending: result.pending,
      positions: result.rows,
      first: result.first
        ? {
            sectionIndex: result.first.sectionIndex,
            rowIndex: result.first.rowIndex,
            field: result.first.field,
          }
        : null,
    }
  },
  close: () => root.unmount(),
}
Object.assign(window, { __commandLaunch: driver })
declare global {
  interface Window {
    __commandLaunch: typeof driver
  }
}
