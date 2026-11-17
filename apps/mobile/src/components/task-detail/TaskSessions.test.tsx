import { modelName } from '@podium/client-core/agent-models'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from '@podium/client-graph/pool'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ pool: null as MobxPool | null }))
vi.mock('../../client/mobile-pool', () => ({ useMobilePool: () => state.pool }))
vi.mock('../../client/hooks', () => ({ useHttpOrigin: () => 'https://fixture.invalid' }))
vi.mock('../../client/ServerProfileGate', () => ({ useServerProfile: () => ({ bearer: null }) }))
vi.mock('../../client/server-profile-context', () => ({ useOptionalServerProfile: () => null }))
vi.mock('../ArtifactViewer', () => ({ ArtifactViewer: () => null }))
vi.mock('../SessionActionCard', () => ({ composeOfferPrompt: () => '' }))
vi.mock('./PromptSheet', () => ({ PromptSheet: () => null }))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' }, impactAsync: vi.fn() }))

const { TaskSessions } = await import('./TaskSessions')
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
    `Worker, Codex · Agent, ${modelName('codex', 'requested-model')} · Error`,
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
    `Worker, Codex · Agent, ${modelName('codex', 'observed-model')} · Needs you`,
  )
})

it('opens every agent from the visible roster without opening Details', () => {
  const stamp = '2026-10-01T00:00:00Z'
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  state.pool = pool
  const issue = {
    id: 'task',
    title: 'Task',
    seq: 1,
    repoPath: '/fixture',
    stage: 'in_progress',
    deps: [],
    createdAt: stamp,
    updatedAt: stamp,
  } as unknown as IssueViewModel
  const sessions = Array.from({ length: 4 }, (_, index) => ({
    sessionId: `seat-${index}`,
    issueId: 'task',
    title: `Agent ${index + 1}`,
    agentKind: 'codex',
    status: 'live',
    createdAt: stamp,
    lastActiveAt: stamp,
    agentState: { phase: 'idle' },
  })) as SessionView[]
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'issue', id: 'task', value: issue },
      ...sessions.map((session) => ({
        kind: 'session' as const,
        id: session.sessionId,
        value: session,
      })),
    ],
  })
  const onOpenSession = vi.fn()
  render(<TaskSessions issue={issue} sessions={sessions} onOpenSession={onOpenSession} />)
  expect(screen.getAllByRole('button')).toHaveLength(4)
  fireEvent.click(screen.getByRole('button', { name: /^Agent 4,/ }))
  expect(onOpenSession).toHaveBeenCalledExactlyOnceWith('seat-3')
})
