import type { SessionView } from '@podium/client-core/session-values'
import type { IssueNavigationModel } from '@podium/client-core/values'
import { asIssueId, asSessionId } from '@podium/model'
import { expect, it } from 'vitest'
import { type DeckSeats, deckTaskOpen } from './mission-deck-targets'

const session = (id: string, issueId: string, lastActiveAt = '2026-11-13T07:00:00Z') =>
  ({
    sessionId: asSessionId(id),
    issueId: asIssueId(issueId),
    name: id,
    title: id,
    cwd: '/src/podium',
    agentKind: 'codex',
    status: 'live',
    archived: false,
    origin: { kind: 'spawn' },
    createdAt: '2026-11-13T07:00:00Z',
    lastActiveAt,
    agentState: { phase: 'working', since: lastActiveAt },
  }) as SessionView

const task = (id: string, fields: Partial<IssueNavigationModel> = {}) =>
  ({ id: asIssueId(id), stage: 'in_progress', title: id, ...fields }) as IssueNavigationModel

const crew = [
  session('root-lead', 'root'),
  session('child-lead', 'child'),
  session('child-helper', 'child', '2026-11-13T08:00:00Z'),
]
const seats = (byTask: Record<string, string[]>): DeckSeats => ({
  full: { task: (id) => ({ sessionIds: byTask[id] ?? [] }) },
  pool: { sessionObject: (id) => crew.find((s) => s.sessionId === id) },
})

it('opens a task on its own coordinator through the shared desktop pick', () => {
  const open = deckTaskOpen(
    task('child', { coordinatorSessionId: asSessionId('child-lead') }),
    seats({ child: ['child-lead', 'child-helper'] }),
    'root-lead',
  )
  // The mission-wide remembered tab (the root's lead) is not one of this
  // task's seats, so it cannot pull the tap onto the parent conversation.
  expect(open).toEqual({ kind: 'chat', sessionId: 'child-lead' })
})

it('keeps a remembered seat when it belongs to the tapped task', () => {
  expect(
    deckTaskOpen(
      task('child', { coordinatorSessionId: asSessionId('child-lead') }),
      seats({ child: ['child-lead', 'child-helper'] }),
      'child-helper',
    ),
  ).toEqual({ kind: 'chat', sessionId: 'child-helper' })
})

it('sends proposals to the inspector and unseated tasks to their details', () => {
  expect(deckTaskOpen(task('idea', { stage: 'proposed' }), seats({}), null)).toEqual({
    kind: 'push',
    href: '/inspect/idea',
  })
  expect(deckTaskOpen(task('child'), seats({}), null)).toEqual({
    kind: 'push',
    href: '/issue/child',
  })
})
