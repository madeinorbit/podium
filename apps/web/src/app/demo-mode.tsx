/**
 * Web demo mode (`?demo=1`, POD-5277) — the phone's demo mode for the web app.
 *
 * Made-up data, no server: the shared demo fixtures
 * (`@podium/client-core/demo`) seed a kernel-backed facade through
 * `createDemoReplica` — the same `createKernelReplica` the product assembly
 * hands the pool — and the ordinary `StoreProvider` runs over it, so the
 * sidebar and the issue page exercise the same pool readers as the product.
 * What is stubbed is only the network: a tRPC surface that answers the
 * handful of reads the fixture flows make and resolves mutations without
 * changing the world. Boot enrichments fail harmlessly against it, the same
 * way they do on the phone.
 */

import {
  createDemoReplica,
  DEMO_PRINCIPAL,
  DEMO_SUPER_SESSION,
  DEMO_TRANSCRIPTS,
  demoEnabled,
  publishDemoSlice,
} from '@podium/client-core/demo'
import { asClientPrincipal } from '@podium/client-core/principal'
import type { SessionId } from '@podium/model'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { useFeature } from '@/lib/use-feature'
import { WebSyncProgressStore } from '@/lib/sync-progress'
import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AppBody } from './AppShell'
import { DensityProvider } from './density'
import { ErrorBoundary } from './ErrorBoundary'
import { StoreProvider } from './store'
import { useWorklistPool } from './store-worklist-pool'
import { ToolbarSlotProvider } from './ToolbarSlot'
import type { Trpc } from './trpc'

export { demoEnabled }

/** The demo origin. Nothing here is fetched: the stubbed API answers locally
 *  and the socket it names never connects, the same way the phone's demo
 *  keeps its configured origin while stubbing the transport. */
const DEMO_CONFIG = {
  httpOrigin: 'http://demo.invalid',
  wsClientUrl: 'ws://demo.invalid/client',
} as const

/** The stubbed network for demo mode: the reads the fixture flows make, and
 *  mutations that resolve without changing the fixture. Mirrors the phone's
 *  `demoTrpc`, plus the three boot reads the web shell gates on
 *  (discovery / settings / features). */
export function demoTrpc(): Trpc {
  const noop = async () => {}
  return {
    discovery: {
      refreshRepos: {
        mutate: async () => ({
          repositories: [
            {
              path: '/home/dev/src/podium',
              repoId: 'fixture:/home/dev/src/podium',
              kind: 'repository',
              branch: 'main',
              worktrees: [],
            },
          ],
          machines: [],
          diagnostics: [],
        }),
      },
    },
    settings: {
      // The boot publishes `settings.sidebar` straight into engine state, so
      // the answer must carry the sidebar (an answer without it would replace
      // the default with undefined and the work list would crash reading it).
      get: {
        query: async () => ({
          sessionDefaults: { agent: 'codex' },
          sidebar: { repoSort: 'lastUsed', repoOrder: [], groupByRepo: false },
        }),
      },
    },
    features: {
      state: { query: async () => ({ devMode: true, channel: 'edge', flags: [] }) },
    },
    usage: {
      // The shell footer and usage sheet share this host-telemetry reader.
      // Demo sessions have no harvested usage or real scan timestamps.
      summary: { query: async () => ({ hostname: 'demo', buckets: [] }) },
    },
    superagent: {
      // The screen reads this thread's session transcript, so the demo thread
      // must name a session DEMO_TRANSCRIPTS has rows for (POD-344).
      listThreads: {
        query: async () => [
          { id: 'global', kind: 'global' as const, podiumSessionId: DEMO_SUPER_SESSION },
        ],
      },
      sendTurn: { mutate: async () => ({ threadId: 'global' }) },
      interruptTurn: { mutate: noop },
      clear: { mutate: noop },
    },
    repos: { list: { query: async () => ['/home/dev/src/podium'] } },
    sessions: {
      transcriptRead: {
        query: async ({ sessionId }: { sessionId: SessionId }) => ({
          items: DEMO_TRANSCRIPTS[sessionId] ?? [],
          hasMore: false,
        }),
      },
      sendText: { mutate: noop },
      answerAskUserQuestion: { mutate: noop },
      // The working demo sessions draw Stop; a press must land, not read "Not stopped".
      interrupt: { mutate: async () => ({ ok: true }) },
    },
    issues: {
      promote: { mutate: async () => ({}) },
      start: { mutate: async () => ({}) },
      close: { mutate: async () => ({}) },
      update: { mutate: noop },
      addComment: { mutate: noop },
      panelApply: { mutate: async () => ({}) },
      clearNeedsHuman: { mutate: noop },
      archive: { mutate: noop },
    },
  } as unknown as Trpc
}

function DemoDensityProvider({ children }: { children: ReactNode }): JSX.Element {
  const densityEnabled = useFeature('shell-density')
  return <DensityProvider densityEnabled={densityEnabled}>{children}</DensityProvider>
}

/**
 * The demo shell: the same `AppBody` the product renders, over demo rows.
 * Skips the login, setup and replica gates — there is no server to ask — and
 * reports the replica as settled from the first frame.
 */
export function WebDemoApp(): JSX.Element {
  return (
    <TooltipProvider>
      <ErrorBoundary resetKey="demo" onRetry={() => {}}>
        <WebDemoProvider>
          <DemoDensityProvider>
            <ToolbarSlotProvider>
              <DemoBody />
            </ToolbarSlotProvider>
          </DemoDensityProvider>
        </WebDemoProvider>
      </ErrorBoundary>
      <Toaster
        position="top-center"
        offset={{ top: 'calc(env(safe-area-inset-top, 0px) + var(--topbar-h) + 10px)' }}
        mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + var(--topbar-h) + 8px)' }}
      />
    </TooltipProvider>
  )
}

function DemoBody(): JSX.Element {
  const [syncProgress] = useState(() => {
    const progress = new WebSyncProgressStore()
    progress.begin('live')
    return progress
  })
  return <AppBody syncProgress={syncProgress} />
}

/**
 * Publishes the demo slice's install event once the pool exists. The pool's
 * presence means its row source has subscribed, so the install's replace
 * batch is observed and the event-fed question indexes fill.
 */
function DemoSlicePublisher({
  replica,
}: {
  replica: ReturnType<typeof createDemoReplica>
}): null {
  const pool = useWorklistPool()
  const published = useRef(false)
  useEffect(() => {
    if (pool !== null && !published.current) {
      published.current = true
      publishDemoSlice(replica)
    }
  }, [pool, replica])
  return null
}

/**
 * Focused-test/demo harness provider: the demo store with the web pool
 * attached, without the shell chrome. Tests render the sidebar or an issue
 * page inside this and read demo rows through the real pool. The confirm
 * dialog lives here (as in the product shell) because work-list rows reach
 * for it on render.
 */
export function WebDemoProvider({ children }: { children: ReactNode }): JSX.Element {
  const [api] = useState(demoTrpc)
  const [principal] = useState(() => asClientPrincipal(DEMO_PRINCIPAL))
  const [demoReplica] = useState(createDemoReplica)
  const createReplicaFn = useMemo(() => () => demoReplica, [demoReplica])
  return (
    // The default attachRuntime already attaches the worklist pool (plus
    // reload preparation), exactly what the demo shell reads through.
    <StoreProvider
      principal={principal}
      config={DEMO_CONFIG}
      api={api}
      onFatalError={() => {}}
      createReplicaFn={createReplicaFn}
    >
      <DemoSlicePublisher replica={demoReplica} />
      <ConfirmProvider>{children}</ConfirmProvider>
    </StoreProvider>
  )
}
