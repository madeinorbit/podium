import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import type { IssueNavigationModel } from '@podium/client-core/viewmodels'
import type { SidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import type { TaskCostRowWire, TaskCostWire } from '@podium/model/browser'
import { asIssueId, asSessionId, asUserId } from '@podium/model/browser'
import { Profiler, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { FlightDeckHandoff } from '../src/app/FlightDeckHandoff'
import { useWaterfallActivity } from '../src/app/FlightDeckWaterfall'
import { MissionCostChip } from '../src/app/MissionCostChip'
import { MessageLedgerView } from '../src/features/messages/MessageLedgerView'
import { UsageView } from '../src/features/usage/UsageView'
import { createHeaderFixture } from './header-fixture'
import '../src/index.css'

const fixture = createHeaderFixture(5600, 5014)
const now = Date.now(),
  stamp = new Date(now).toISOString()
const issue = {
  id: asIssueId('utility-root'),
  seq: 1,
  title: 'Synthetic review',
  stage: 'review',
  updatedAt: stamp,
  deps: [],
  parentId: null,
  activityNotes: 'Utility transport proof',
  notesUpdatedAt: stamp,
} as unknown as IssueNavigationModel
const session = {
  sessionId: asSessionId('utility-session'),
  issueId: issue.id,
  agentKind: 'codex',
  cwd: '/synthetic',
  title: 'Synthetic agent',
  status: 'live',
  archived: false,
  createdAt: stamp,
  lastInputAt: stamp,
  lastActiveAt: stamp,
  transcriptAvailable: true,
  agentState: { phase: 'idle', since: stamp },
} as SessionView
const models = [
  {
    model: 'claude-opus-5',
    inputTokens: 2e6,
    outputTokens: 1e5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    messages: 50,
  },
]
const answers: Record<string, unknown> = {
  usage: {
    hostname: 'synthetic',
    sampledAt: stamp,
    buckets: Array.from({ length: 24 }, (_, index) => ({
      ...models[0],
      hour: new Date(now - index * 3600000).toISOString(),
    })),
  },
  quota: [
    {
      accountKey: 'codex::synthetic@example.invalid',
      agent: 'codex',
      windowKey: 'weekly',
      label: 'Weekly',
      startedAt: new Date(now - 7 * 86400000).toISOString(),
      resetsAt: stamp,
      windowMinutes: 10080,
      firstSeenAt: new Date(now - 7 * 86400000).toISOString(),
      lastSeenAt: stamp,
      firstPercent: 0,
      peakPercent: 71,
      lastPercent: 71,
      sampleCount: 400,
      closed: true,
      partial: false,
      source: 'live',
    },
  ],
  tasks: [
    {
      issueId: issue.id,
      seq: 1,
      title: issue.title,
      stage: 'review',
      models,
      messages: 50,
      rollupModels: models,
      rollupMessages: 50,
      uncostedSessionCount: 0,
      windowModels: models,
      windowMessages: 50,
      sessionCount: 1,
      floor: 'none',
      harnesses: ['claude-code'],
    },
  ] satisfies TaskCostRowWire[],
  cost: {
    issueId: issue.id,
    state: 'costed',
    own: { models, messages: 50, sessionCount: 1 },
    rollup: { models, messages: 50, sessionCount: 1 },
    descendantCount: 0,
    provisional: false,
    floor: 'none',
    harnesses: ['claude-code'],
    uncostedSessionCount: 0,
    sessions: [],
  } satisfies TaskCostWire,
  ledger: [
    {
      id: 'utility-message',
      threadId: 'utility-thread',
      inReplyTo: null,
      from: 'Synthetic sender',
      to: 'Synthetic recipient',
      kind: 'note',
      urgency: 'next-turn',
      lifecycle: 'wait',
      body: 'Synthetic message',
      createdAt: stamp,
      deliveryStatus: 'confirmed',
      ackedBy: session.sessionId,
      deliveredAt: stamp,
      deliveredTo: session.sessionId,
      expiresAt: null,
      clampedFrom: null,
      hop: 0,
    },
  ],
  events: [],
  transcript: {
    items: [
      { id: 'utility-prompt', role: 'user', text: 'Synthetic question', ts: stamp },
      {
        id: 'utility-answer',
        role: 'assistant',
        text: 'Synthetic answer',
        ts: stamp,
        answer: true,
      },
    ],
    hasMore: false,
  },
  history: { sessions: { [session.sessionId]: [{ at: stamp, phase: 'working' }] } },
}
const calls: Record<string, number> = {}
function query(key: string) {
  return async (..._input: unknown[]) => {
    calls[key] = (calls[key] ?? 0) + 1
    return answers[key]
  }
}
Object.assign(fixture.api, {
  usage: { summary: { query: query('usage') } },
  quota: { history: { query: query('quota') } },
  cost: { tasks: { query: query('tasks') }, task: { query: query('cost') } },
  messages: { ledger: { query: query('ledger') } },
  issues: { events: { query: query('events') } },
  sessions: {
    transcriptRead: { query: query('transcript') },
    activityHistory: { query: query('history') },
  },
})
const failures: string[] = []
let commits = 0,
  commitMs = 0,
  mounted = false
storeStats.enable()
function History() {
  const history = useWaterfallActivity([session])
  return <output data-utility-surface="waterfall">{JSON.stringify([...history])}</output>
}
function Surface() {
  useEffect(() => {
    mounted = true
    return () => {
      mounted = false
    }
  }, [])
  return (
    <Profiler
      id="utilities"
      onRender={(_id, _phase, ms) => {
        commits++
        commitMs += ms
      }}
    >
      <main style={{ padding: 24 }}>
        <section data-utility-surface="usage">
          <UsageView onClose={() => {}} />
        </section>
        <section data-utility-surface="ledger">
          <MessageLedgerView issueId={issue.id} sessionId={session.sessionId} />
        </section>
        <section data-utility-surface="cost">
          <MissionCostChip issueId={issue.id} onOpenInExplorer={() => {}} />
        </section>
        <section data-utility-surface="handoff">
          <FlightDeckHandoff
            rootIssue={issue}
            issues={[issue]}
            lookupSession={(id) => (id === session.sessionId ? session : undefined)}
            poolValues={{
              crew: [session],
              retired: { count: 0, latestPrompt: null },
              current: [{ kind: 'review', issueId: issue.id, text: 'Ready for review.' }],
              next: [],
            }}
            visitReadAt={null}
            proposed={null}
            onOpenTranscript={() => {}}
            onOpenSession={() => {}}
            onOpenIssue={() => {}}
          />
        </section>
        <History />
      </main>
    </Profiler>
  )
}
const root = createRoot(document.getElementById('root')!)
root.render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('utility-synthetic'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={fixture.api}
    createReplicaFn={() => fixture.newReplica()}
    networkEnabled={false}
    onFatalError={() => failures.push('provider-failure')}
    attachRuntime={(runtime) => {
      fixture.bindHub(runtime.hub)
      return () => {}
    }}
  >
    <Surface />
  </StoreProvider>,
)
const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
const driver = {
  ready: () =>
    mounted &&
    ['usage', 'quota', 'tasks', 'cost', 'ledger', 'events', 'transcript', 'history'].every(
      (key) => calls[key],
    ),
  reset() {
    storeStats.reset()
    commits = 0
    commitMs = 0
  },
  async activity(count: number) {
    for (let step = 1; step <= count; step++)
      fixture.patch('session', `synthetic-session-${step % 12}`, {
        lastActiveAt: new Date(now + step).toISOString(),
        agentState: {
          phase: step % 2 ? 'working' : 'idle',
          since: new Date(now + step).toISOString(),
        },
      })
    await nextFrame()
  },
  stats: () => {
    const runtimes = storeStats.snapshot().runtimes
    return {
      runtimeCount: runtimes.length,
      publishes: runtimes.reduce((sum, row) => sum + row.publishes, 0),
      selectors: runtimes.reduce((sum, row) => sum + row.selectorRuns, 0),
      wakes: runtimes.reduce((sum, row) => sum + row.subscriberWakes, 0),
      legacyDerivations: runtimes.reduce(
        (sum, row) => sum + Object.values(row.slices).reduce((a, b) => a + b, 0),
        0,
      ),
      commits,
      commitMs,
      calls,
      failures,
    }
  },
  snapshot: (): SidebarSnapshot => ({
    pending: 0,
    sections: [...document.querySelectorAll('[data-utility-surface]')].map((node) => ({
      key: node.getAttribute('data-utility-surface')!,
      rows: [],
      fields: {
        text: node.textContent,
        titles: [...node.querySelectorAll('[title]')].map((child) => child.getAttribute('title')),
        labels: [...node.querySelectorAll('[aria-label]')].map((child) =>
          child.getAttribute('aria-label'),
        ),
      },
    })),
  }),
  close: () => root.unmount(),
}
Object.assign(window, { __utilityReaders: driver })
declare global {
  interface Window {
    __utilityReaders: typeof driver
  }
}
