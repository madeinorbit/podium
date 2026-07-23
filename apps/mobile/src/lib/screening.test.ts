import type { IssueWire } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  applyScreeningDecision,
  buildScreeningQueue,
  reconcileScreeningOrder,
  screeningTally,
} from './screening'

const issue = (partial: Partial<IssueWire> & Pick<IssueWire, 'id'>) =>
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

/** A recording stand-in for the mobile tRPC client's issue procedures. */
function fakeApi() {
  const calls: string[] = []
  const rec =
    (name: string) =>
    async (input: Record<string, unknown>): Promise<unknown> => {
      calls.push(`${name}:${JSON.stringify(input)}`)
      return {}
    }
  return {
    calls,
    api: {
      issues: {
        promote: { mutate: vi.fn(rec('promote')) },
        start: { mutate: vi.fn(rec('start')) },
        close: { mutate: vi.fn(rec('close')) },
      },
    },
  }
}

describe('buildScreeningQueue', () => {
  it('takes only live human proposals, most urgent first', () => {
    const queue = buildScreeningQueue([
      issue({ id: 'p2-old', priority: 2, seq: 10 }),
      issue({ id: 'backlog', stage: 'backlog' }),
      issue({ id: 'p0', priority: 0, seq: 4 }),
      issue({ id: 'p2-new', priority: 2, seq: 30 }),
      issue({ id: 'archived', archived: true }),
      issue({ id: 'deleted', deletedAt: '2026-07-01T00:00:00.000Z' }),
      issue({ id: 'draft', draft: true }),
      issue({ id: 'internal', audience: 'agent' }),
    ])

    expect(queue.map((i) => i.id)).toEqual(['p0', 'p2-new', 'p2-old'])
  })

  it('leaves out a proposal nested under an unapproved proposal', () => {
    const queue = buildScreeningQueue([
      issue({ id: 'root' }),
      issue({ id: 'child', parentId: 'root', seq: 2 }),
      issue({ id: 'grandchild', parentId: 'child', seq: 3 }),
      issue({ id: 'under-backlog', parentId: 'approved', seq: 4 }),
      issue({ id: 'approved', stage: 'backlog' }),
    ])

    expect(queue.map((i) => i.id)).toEqual(['under-backlog', 'root'])
  })
})

describe('reconcileScreeningOrder', () => {
  const board = [issue({ id: 'a', seq: 3 }), issue({ id: 'b', seq: 2 }), issue({ id: 'c', seq: 1 })]

  it('keeps decided cards, drops undecided ones that left the lane, appends arrivals', () => {
    const next = reconcileScreeningOrder(['a', 'b', 'c'], 1, [
      // 'a' was accepted by this flow, 'b' was closed from another client.
      issue({ id: 'a', stage: 'in_progress' }),
      issue({ id: 'c', seq: 1 }),
      issue({ id: 'd', seq: 9 }),
    ])

    expect(next).toEqual({ order: ['a', 'c', 'd'], index: 1 })
  })

  it('never reorders the undecided tail around the current card', () => {
    // 'c' outranks the rest on the board, but the deck order is a snapshot.
    const next = reconcileScreeningOrder(['a', 'b', 'c'], 0, [
      ...board,
      issue({ id: 'z', priority: 0, seq: 99 }),
    ])

    expect(next).toEqual({ order: ['a', 'b', 'c', 'z'], index: 0 })
  })
})

describe('applyScreeningDecision', () => {
  const proposal = { id: 'iss_1', stage: 'proposed' }

  it('accept promotes the proposal and then starts it', async () => {
    const { api, calls } = fakeApi()

    await applyScreeningDecision(api, proposal, 'accepted')

    expect(calls).toEqual(['promote:{"id":"iss_1"}', 'start:{"id":"iss_1"}'])
    expect(api.issues.close.mutate).not.toHaveBeenCalled()
  })

  it('decline closes the proposal as wontfix', async () => {
    const { api, calls } = fakeApi()

    await applyScreeningDecision(api, proposal, 'declined')

    expect(calls).toEqual(['close:{"id":"iss_1","reason":"wontfix"}'])
    expect(api.issues.promote.mutate).not.toHaveBeenCalled()
    expect(api.issues.start.mutate).not.toHaveBeenCalled()
  })

  it('skip mutates nothing — the proposal stays proposed', async () => {
    const { api, calls } = fakeApi()

    await applyScreeningDecision(api, proposal, 'skipped')

    expect(calls).toEqual([])
  })

  it('does not start a proposal whose promote failed', async () => {
    const { api } = fakeApi()
    api.issues.promote.mutate.mockRejectedValueOnce(new Error('offline'))

    await expect(applyScreeningDecision(api, proposal, 'accepted')).rejects.toThrow('offline')
    expect(api.issues.start.mutate).not.toHaveBeenCalled()
  })

  it('resumes a half-applied accept without re-promoting', async () => {
    const { api, calls } = fakeApi()

    await applyScreeningDecision(api, { id: 'iss_1', stage: 'backlog' }, 'accepted')

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
