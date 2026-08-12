import { asIssueId, type IssueWire, type IssueWireInput } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  applyScreeningDecision,
  buildScreeningQueue,
  reconcileScreeningOrder,
  screeningTally,
} from './screening'

const issue = (partial: Partial<IssueWireInput> & Pick<IssueWire, 'id'>) =>
  ({
    repoPath: '/src/podium',
    seq: 1,
    priority: 2,
    stage: 'proposed',
    title: partial.id,
    archived: false,
    draft: false,
    audience: 'human',
    ...partial,
  }) as IssueWire

/** Recording stand-ins for the mix of ordered server calls and store action. */
function fakeCommands() {
  const calls: string[] = []
  const rec =
    (name: string) =>
    async (id: string, reason?: string): Promise<unknown> => {
      calls.push(`${name}:${JSON.stringify(reason === undefined ? { id } : { id, reason })}`)
      return {}
    }
  return {
    calls,
    commands: {
      promoteIssue: vi.fn(rec('promote')),
      startIssue: vi.fn(rec('start')),
      closeIssue: vi.fn(rec('close')),
    },
  }
}

describe('buildScreeningQueue', () => {
  it('takes only live human proposals, most urgent first', () => {
    const queue = buildScreeningQueue([
      issue({ id: asIssueId('p2-old'), priority: 2, seq: 10 }),
      issue({ id: asIssueId('backlog'), stage: 'backlog' }),
      issue({ id: asIssueId('p0'), priority: 0, seq: 4 }),
      issue({ id: asIssueId('p2-new'), priority: 2, seq: 30 }),
      issue({ id: asIssueId('archived'), archived: true }),
      issue({ id: asIssueId('deleted'), deletedAt: '2026-07-01T00:00:00.000Z' }),
      issue({ id: asIssueId('draft'), draft: true }),
      issue({ id: asIssueId('internal'), audience: 'agent' }),
    ])

    expect(queue.map((i) => i.id)).toEqual(['p0', 'p2-new', 'p2-old'])
  })

  it('leaves out a proposal nested under an unapproved proposal', () => {
    const queue = buildScreeningQueue([
      issue({ id: asIssueId('root') }),
      issue({ id: asIssueId('child'), parentId: 'root', seq: 2 }),
      issue({ id: asIssueId('grandchild'), parentId: 'child', seq: 3 }),
      issue({ id: asIssueId('under-backlog'), parentId: 'approved', seq: 4 }),
      issue({ id: asIssueId('approved'), stage: 'backlog' }),
    ])

    expect(queue.map((i) => i.id)).toEqual(['under-backlog', 'root'])
  })
})

describe('reconcileScreeningOrder', () => {
  const board = [
    issue({ id: asIssueId('a'), seq: 3 }),
    issue({ id: asIssueId('b'), seq: 2 }),
    issue({ id: asIssueId('c'), seq: 1 }),
  ]

  it('keeps decided cards, drops undecided ones that left the lane, appends arrivals', () => {
    const next = reconcileScreeningOrder([asIssueId('a'), asIssueId('b'), asIssueId('c')], 1, [
      // 'a' was accepted by this flow, 'b' was closed from another client.
      issue({ id: asIssueId('a'), stage: 'in_progress' }),
      issue({ id: asIssueId('c'), seq: 1 }),
      issue({ id: asIssueId('d'), seq: 9 }),
    ])

    expect(next).toEqual({ order: ['a', 'c', 'd'], index: 1 })
  })

  it('never reorders the undecided tail around the current card', () => {
    // 'c' outranks the rest on the board, but the deck order is a snapshot.
    const next = reconcileScreeningOrder([asIssueId('a'), asIssueId('b'), asIssueId('c')], 0, [
      ...board,
      issue({ id: asIssueId('z'), priority: 0, seq: 99 }),
    ])

    expect(next).toEqual({ order: ['a', 'b', 'c', 'z'], index: 0 })
  })
})

describe('applyScreeningDecision', () => {
  const proposal = { id: asIssueId('iss_1'), stage: 'proposed' }

  it('accept promotes the proposal and then starts it', async () => {
    const { commands, calls } = fakeCommands()

    await applyScreeningDecision(commands, proposal, 'accepted')

    expect(calls).toEqual(['promote:{"id":"iss_1"}', 'start:{"id":"iss_1"}'])
    expect(commands.closeIssue).not.toHaveBeenCalled()
  })

  it('decline closes the proposal as wontfix', async () => {
    const { commands, calls } = fakeCommands()

    await applyScreeningDecision(commands, proposal, 'declined')

    expect(calls).toEqual(['close:{"id":"iss_1","reason":"wontfix"}'])
    expect(commands.promoteIssue).not.toHaveBeenCalled()
    expect(commands.startIssue).not.toHaveBeenCalled()
  })

  it('skip mutates nothing — the proposal stays proposed', async () => {
    const { commands, calls } = fakeCommands()

    await applyScreeningDecision(commands, proposal, 'skipped')

    expect(calls).toEqual([])
  })

  it('does not start a proposal whose promote failed', async () => {
    const { commands } = fakeCommands()
    commands.promoteIssue.mockRejectedValueOnce(new Error('offline'))

    await expect(applyScreeningDecision(commands, proposal, 'accepted')).rejects.toThrow('offline')
    expect(commands.startIssue).not.toHaveBeenCalled()
  })

  it('resumes a half-applied accept without re-promoting', async () => {
    const { commands, calls } = fakeCommands()

    await applyScreeningDecision(commands, { id: asIssueId('iss_1'), stage: 'backlog' }, 'accepted')

    expect(calls).toEqual(['start:{"id":"iss_1"}'])
  })
})

describe('screeningTally', () => {
  it('counts each outcome', () => {
    expect(screeningTally(['accepted', 'skipped', 'declined', 'accepted'])).toEqual({
      accepted: 2,
      declined: 1,
      skipped: 1,
      total: 4,
    })
  })
})
