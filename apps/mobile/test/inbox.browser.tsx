import type { ClientRuntime } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { allIssueViewModels } from '@podium/client-core/replica'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { checkMobileInbox } from '@podium/client-graph/diagnostics/mobile-inbox-check'
import { mobileInboxViews } from '@podium/client-graph/mobile-inbox'
import { asUserId } from '@podium/model/browser'
import type { PodiumTarget } from '@podium/protocol'
import { Profiler, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthStatusContext } from '../src/client/auth-context'
import {
  attachMobilePool,
  initializeMobileDataLayer,
  mobileDataLayer,
  useMobilePool,
} from '../src/client/mobile-pool'
import { PodiumLinkHost } from '../src/components/PodiumLinkHost'
import { RefChip } from '../src/components/RefChip'
import { followPodiumLink, mobilePodiumRoute } from '../src/lib/podium-link'
import { buildScreeningQueue } from '../src/lib/screening'
import { InboxScreen } from '../src/screens/InboxScreen'
import { ProposalScreeningScreen } from '../src/screens/ProposalScreeningScreen'
import { usePulseFeed } from '../src/screens/usePulseFeed'
import { createInboxFixture } from './inbox-fixture'
import { navigation } from './inbox-platform'

const on = new URLSearchParams(location.search).get('pool') === '1'
const now = Date.now(),
  fixture = createInboxFixture(5600, 5014),
  failures: string[] = []
const tokens = [
  { token: 'SYN-1000', kind: 'issue' as const, prefix: 'SYN' },
  { token: 'SYN-1018', kind: 'issue' as const, prefix: 'SYN' },
  { token: 'SYN-9999', kind: 'issue' as const, prefix: 'SYN' },
  { token: 'SYN-1000-A', kind: 'session' as const, prefix: 'SYN' },
  { token: 'UTF-8', kind: 'issue' as const, prefix: 'UTF' },
]
const targets: PodiumTarget[] = [
  { kind: 'issue', issue: 'SYN-1000' },
  { kind: 'issue', issue: 'SYN-1018' },
  { kind: 'issue', issue: 'SYN-9999' },
  { kind: 'session', session: 'SYN-1000-A' },
]
let owner: ClientRuntime,
  pool: ReturnType<typeof useMobilePool> = null,
  initialized = false,
  commits = 0,
  commitMs = 0,
  pulseReady = false
storeStats.enable()
function Pulse() {
  const data = usePulseFeed()
  pulseReady = data.machines.length === 3 && data.hosts.length === 3 && (data.quota?.length ?? 0) > 0
  return (
    <aside data-testid="pulse">
      {data.machines.map((machine) => machine.name).join(' · ')}
      <br />
      {data.hosts.length} live hosts · {data.quota?.length ?? 0} quota accounts
    </aside>
  )
}
function Surface() {
  owner = useStoreHandle() as ClientRuntime
  if (!initialized) {
    owner.ui.set(MOBX_SIDEBAR_KEY, on ? '1' : '0')
    initializeMobileDataLayer(owner.ui)
    initialized = true
  }
  pool = useMobilePool()
  const [screen, setScreen] = useState('inbox')
  return (
    <main>
      <small>
        5,600 synthetic tasks · 5,014 sessions · {mobileDataLayer()} readers
        <br />
        Isolated proof: launch, storage and refresh siblings stubbed.
      </small>
      <nav>
        <button type="button" onClick={() => setScreen('inbox')}>Inbox</button>
        <button type="button" onClick={() => setScreen('proposals')}>Proposals</button>
      </nav>
      <Profiler
        id="phone-readers"
        onRender={(_id, _phase, ms) => {
          commits++
          commitMs += ms
        }}
      >
        <div className="surface" style={{ display: screen === 'inbox' ? 'flex' : 'none' }}>
          <InboxScreen />
        </div>
        <div className="surface" style={{ display: screen === 'proposals' ? 'flex' : 'none' }}>
          <ProposalScreeningScreen />
        </div>
        <aside>
          {tokens.map((token) => (
            <span key={token.token} data-testid={`ref-${token.token}`} style={{ marginRight: 10 }}>
              <RefChip
                token={token.token}
                refKind={token.kind}
                prefix={token.prefix}
                onPress={(ref) =>
                  followPodiumLink(
                    `podium://${token.kind === 'session' ? 'sessions' : 'issues'}/${ref}`,
                  )
                }
              />
            </span>
          ))}
        </aside>
        <Pulse />
        <PodiumLinkHost />
      </Profiler>
    </main>
  )
}
const root = createRoot(document.getElementById('root')!)
root.render(
  <AuthStatusContext.Provider
    value={{ authed: true, userId: 'operator', needsAuth: true } as never}
  >
    <StoreProvider
      principal={asClientPrincipal(asUserId('operator'))}
      api={fixture.api}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      createReplicaFn={() => fixture.newReplica()}
      networkEnabled={false}
      routerWindow={createMemoryRouterWindow()}
      onFatalError={(error) => failures.push(error)}
      attachRuntime={(runtime) => {
        fixture.bindHub(runtime.hub)
        const detach = attachMobilePool(runtime, (error) => failures.push(error.message))
        fixture.publishMachines()
        fixture.publishMetrics(0)
        return detach
      }}
    >
      <Surface />
    </StoreProvider>
  </AuthStatusContext.Provider>,
)
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const driver = {
  readiness: () => ({
    pulse: pulseReady,
    screening: !!document.querySelector('[data-testid="screening-card"]'),
    attached: !!pool,
    booting: pool ? mobileInboxViews(pool)?.inbox().booting : null,
  }),
  ready: () =>
    pulseReady &&
    !!document.querySelector('[data-testid="screening-card"]') &&
    (!on || (!!pool && !mobileInboxViews(pool)?.inbox().booting)),
  reset() {
    storeStats.reset()
    commits = 0
    commitMs = 0
  },
  async activity(count: number) {
    for (let step = 0; step < count; step++) {
      fixture.activity(step)
      await frame()
    }
  },
  async updates(count: number) {
    for (let step = 0; step < count; step++) {
      fixture.patch('issueProjection', 'synthetic-0', { title: `Inbox task ${step}` })
      fixture.publishMetrics(step)
      await frame()
    }
  },
  stats() {
    const rows = storeStats.snapshot().runtimes
    const slices: Record<string, number> = {}
    for (const row of rows)
      for (const [key, value] of Object.entries(row.slices))
        slices[key] = (slices[key] ?? 0) + value
    return {
      selectors: rows.reduce((sum, row) => sum + row.selectorRuns, 0),
      rowBuilds: rows.reduce((sum, row) => sum + row.rowBuilds, 0),
      slices,
      commits,
      commitMs,
      failures: failures.length,
      routes: navigation.routes,
    }
  },
  check() {
    if (!pool) return null
    const snapshot = owner.getSnapshot(),
      issues = allIssueViewModels(
        snapshot.replica,
        snapshot.issueProjections,
        snapshot.issueUserStates,
      )
    return checkMobileInbox(
      pool,
      {
        issues,
        sessions: snapshot.sessions,
        booting: false,
        outboxSize: snapshot.outboxSize,
        queue: buildScreeningQueue(issues).map((issue) => issue.id),
        routes: targets.map((target) =>
          mobilePodiumRoute(target, { issues, sessions: snapshot.sessions }),
        ),
      },
      {
        now,
        targets,
        tokens,
        screeningIds: ['synthetic-0', 'synthetic-1', 'synthetic-2', 'synthetic-3'],
      },
    )
  },
  close: () => root.unmount(),
}
Object.assign(window, { __inbox: driver })
declare global {
  interface Window {
    __inbox: typeof driver
  }
}
