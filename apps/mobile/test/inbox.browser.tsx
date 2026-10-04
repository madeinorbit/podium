import type { ClientRuntime } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import { mobileInboxViews } from '@podium/client-graph/mobile-inbox'
import { asUserId } from '@podium/model/browser'
import type { PodiumTarget } from '@podium/protocol'
import { Profiler, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthStatusContext } from '../src/client/auth-context'
import { attachMobilePool, useMobilePool } from '../src/client/mobile-pool'
import { MobileShellProvider } from '../src/client/shell'
import { PodiumLinkHost } from '../src/components/PodiumLinkHost'
import { RefChip } from '../src/components/RefChip'
import { followPodiumLink } from '../src/lib/podium-link'
import { InboxScreen } from '../src/screens/InboxScreen'
import { ProposalScreeningScreen } from '../src/screens/ProposalScreeningScreen'
import { usePulseFeed } from '../src/screens/usePulseFeed'
import { createInboxFixture } from './inbox-fixture'
import { navigation } from './inbox-platform'

const complete = new URLSearchParams(location.search).get('complete') === '1'
const fixture = createInboxFixture(5600, 5014),
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
  commits = 0,
  commitMs = 0,
  pulseReady = false
storeStats.enable()
function Pulse() {
  const data = usePulseFeed()
  pulseReady =
    data.machines.length === 3 && data.hosts.length === 3 && (data.quota?.length ?? 0) > 0
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
  pool = useMobilePool()
  const [screen, setScreen] = useState('inbox')
  return (
    <main>
      <small>
        5,600 synthetic tasks · 5,014 sessions · pool readers
        <br />
        {complete
          ? 'Complete Inbox readers; native launch sheet closed.'
          : 'Isolated proof: launch, storage and refresh siblings stubbed.'}
      </small>
      <nav>
        <button type="button" onClick={() => setScreen('inbox')}>
          Inbox
        </button>
        <button type="button" onClick={() => setScreen('proposals')}>
          Proposals
        </button>
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
      <MobileShellProvider value={{ error: null, notice: null, eraseLocalData: async () => {} }}>
        <Surface />
      </MobileShellProvider>
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
    !!pool &&
    !mobileInboxViews(pool)?.inbox().booting,
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
  outputs() {
    if (!pool) return null
    const views = mobileInboxViews(pool)
    return views
      ? { routes: targets.map((target) => views.route(target)), queue: views.screening().queue }
      : null
  },
  close: () => root.unmount(),
}
Object.assign(window, { __inbox: driver })
declare global {
  interface Window {
    __inbox: typeof driver
  }
}
