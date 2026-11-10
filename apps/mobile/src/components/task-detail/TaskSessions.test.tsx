import { modelLabel } from '@podium/client-core/agent-models'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from '@podium/client-graph/pool'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ pool: null as MobxPool | null }))
vi.mock('../../client/mobile-pool', () => ({ useMobilePool: () => state.pool }))
vi.mock('../../client/hooks', () => ({ useHttpOrigin: () => 'https://fixture.invalid' }))
vi.mock('../../client/ServerProfileGate', () => ({ useServerProfile: () => ({ bearer: null }) }))
vi.mock('../../client/server-profile-context', () => ({ useOptionalServerProfile: () => null }))
vi.mock('../ArtifactViewer', () => ({ ArtifactViewer: () => null }))
vi.mock('../SessionActionCard', () => ({ composeOfferPrompt: () => '' }))
vi.mock('./PromptSheet', () => ({ PromptSheet: () => null }))
vi.mock('./chrome', () => ({ Disclosure: () => null }))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' }, impactAsync: vi.fn() }))

const { TaskSessions } = await import('./TaskOverview')
afterEach(() => {
  cleanup()
  state.pool?.dispose()
  state.pool = null
})

it('reads live state words and observed/requested models from the shared session', () => {
  const pool = new MobxPool({
    selectedIssueId: null,
    coarseNow: Date.parse('2026-10-01T00:00:00Z'),
  })
  state.pool = pool
  const issue = {
    id: 'task',
    title: 'Task',
    seq: 1,
    repoPath: '/fixture',
    stage: 'in_progress',
    deps: [],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  } as unknown as IssueViewModel
  const session = {
    sessionId: 'seat',
    issueId: 'task',
    title: 'Worker',
    agentKind: 'codex',
    status: 'live',
    createdAt: '2026-10-01T00:00:00Z',
    lastActiveAt: '2026-10-01T00:00:00Z',
    model: 'spawn-model',
    requestedModel: 'requested-model',
    agentState: { phase: 'errored' },
  }
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'issue', id: 'task', value: issue },
      { kind: 'session', id: 'seat', value: session },
    ],
  })
  render(
    <TaskSessions issue={issue} sessions={[session as SessionView]} onOpenSession={() => {}} />,
  )
  expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
    `Worker, ${modelLabel('codex', 'requested-model')} · Error`,
  )
  act(() =>
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'session',
          id: 'seat',
          value: {
            ...session,
            observedModel: 'observed-model',
            agentState: { phase: 'idle' },
            offer: { message: 'Ready', actions: [{ label: 'Accept', prompt: 'Accept' }] },
          },
        },
      ],
    }),
  )
  expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
    `Worker, ${modelLabel('codex', 'observed-model')} · Needs you`,
  )
})
