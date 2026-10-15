import {
  asIssueId,
  asSessionId,
  type IssueDeck,
  type IssueDeckNode,
  tallyTaskWords,
} from '@podium/model'
import { expect, it } from 'vitest'
import { renderIssueDeck } from './deck'

it('renders phases, seats, state labels, blockers, leaf totals and proposal provenance', () => {
  const node = (seq: number, title: string, patch: Partial<IssueDeckNode> = {}): IssueDeckNode => ({
    id: asIssueId(`iss_${seq}`),
    displayRef: `POD-${seq}`,
    title,
    type: 'task',
    stage: 'backlog',
    word: 'not-started',
    hidden: false,
    counter: { done: 0, total: 0 },
    sessions: [],
    blockers: [],
    children: [],
    ...patch,
  })
  const root = node(1, 'Mission', { word: 'needs-you' })
  const task = node(3, 'Review result', {
    word: 'needs-you',
    sessions: [
      {
        sessionId: asSessionId('s'),
        displayRef: 'POD-3-A',
        agentKind: 'codex',
        status: 'live',
        seat: 'worker',
        word: 'needs-you',
      },
    ],
    blockers: [
      { id: asIssueId('iss_9'), displayRef: 'POD-9', title: 'External work', external: true },
    ],
  })
  root.children = [
    node(2, 'Build', {
      type: 'phase',
      word: 'needs-you',
      counter: { done: 1, total: 2 },
      children: [task, node(4, 'Cancelled secret', { hidden: true, word: 'done' })],
    }),
  ]
  const deck: IssueDeck = {
    root,
    counts: tallyTaskWords(['needs-you', 'done'] as const, (word) => word),
    proposals: [
      {
        ...node(5, 'Next idea'),
        placement: 'own-issue',
        proposedBy: { sessionId: asSessionId('s'), displayRef: 'POD-3-A' },
      },
    ],
  }
  const text = renderIssueDeck(deck)
  expect(text).toContain('POD-1 Mission — Needs you')
  expect(text).toContain('1/2 tasks done')
  expect(text).toContain('Phase: POD-2 Build — Needs you · 1/2')
  expect(text).toContain('POD-3-A [worker] Needs you · codex')
  expect(text).toContain('waits on POD-9 External work (outside deck)')
  expect(text).toContain('Proposed (1)')
  expect(text).toContain('own issue · proposed by POD-3-A')
  expect(text).not.toContain('Cancelled secret')
})
