import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import type { ContextDetailApi } from '@podium/client-graph/context-detail'
import { asUserId } from '@podium/model/browser'
import { createRoot } from 'react-dom/client'
import { createSidebarFixture } from '../test/sidebar-fixture'
import { ContextComposerFixture } from './context-composer-fixture'
import {
  type ContextFixtureState,
  contextStates,
  createContextFixture,
  detailFor,
  measured,
} from './context-usage-fixture'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')
const state = params.get('state') as ContextFixtureState | null
const fixture = createContextFixture(
  state && state in contextStates ? state : 'reported',
  params.has('future'),
  params.has('readonly'),
)
const provider = createSidebarFixture(0, Date.parse(measured.sample.at), true)
const reads: { sample: unknown; aborted: boolean }[] = []
const counts = { sends: 0, interrupts: 0, globalEscapes: 0 }
const api: ContextDetailApi = {
  sessions: {
    contextRead: {
      query: async (input, options) => {
        const record = {
          sample: input.read.intent === 'breakdown' ? input.read.sample : undefined,
          aborted: false,
        }
        reads.push(record)
        options?.signal?.addEventListener(
          'abort',
          () => {
            record.aborted = true
          },
          { once: true },
        )
        await new Promise((resolve) => setTimeout(resolve, Number(params.get('delay') ?? 40)))
        if (params.has('error')) throw new Error('Synthetic detail failure')
        return {
          intent: 'breakdown',
          result: {
            ...detailFor(fixture.session.context ?? measured, state === 'requestOnly'),
            sample: input.read.intent === 'breakdown' ? input.read.sample : measured.sample,
          },
        }
      },
    },
  },
}
Object.assign(provider.api, api)
Object.assign(window, {
  __contextFixture: {
    reads,
    counts,
    publish: (name: ContextFixtureState) => fixture.publish(contextStates[name]),
    offline: () => fixture.live.online(fixture.row.machineId, false),
  },
})
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') counts.globalEscapes++
})

const root = document.getElementById('root')
if (!root) throw new Error('Missing context fixture root')
createRoot(root).render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('fixture-operator'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={provider.api}
    createReplicaFn={() => provider.replica}
    networkEnabled={false}
    onFatalError={(message) => {
      throw new Error(message)
    }}
    attachRuntime={(owner) => owner.attachPool(fixture.pool, () => fixture.pool.dispose())}
  >
    <main
      className="mx-auto flex min-h-screen w-full max-w-[48rem] flex-col bg-background text-foreground"
      data-prompt-bounds
    >
      <header className="border-b border-hairline-soft px-6 py-4">
        <h1 className="text-sm font-medium">Context usage</h1>
        <p className="text-xs text-text-faint">
          Synthetic conversation · {params.has('compact') ? 'Compact' : 'Regular'} composer ·{' '}
          {state ?? 'reported'}
        </p>
      </header>
      <div className="flex flex-1 flex-col justify-end gap-5 px-6 pb-10 pt-8">
        <p className="self-end rounded-lg bg-hairline-soft px-4 py-2 text-sm">
          Show the available context beside the model controls.
        </p>
        <p className="text-sm text-text-dim">
          The summary updates with the session. Open the circle to inspect the measurement and its
          supported breakdown.
        </p>
      </div>
      <ContextComposerFixture
        session={fixture.session}
        compact={params.has('compact')}
        onSend={() => counts.sends++}
        onInterrupt={() => counts.interrupts++}
      />
    </main>
  </StoreProvider>,
)
