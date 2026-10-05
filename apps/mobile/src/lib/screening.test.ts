import type { IssueViewModel } from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph/pool'
import { asIssueId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { openScreeningPool, readPoolScreening } from '../../test/pool-board-fixture'
import { reconcileScreeningIds } from '../client/use-inbox-data'
import { applyScreeningDecision, screeningTally } from './screening'

const issue = (partial: Partial<IssueViewModel> & Pick<IssueViewModel, 'id'>) =>
  ({
    repoPath: '/src/podium',
    seq: 1,
    priority: 2,
    stage: 'proposed',
    title: partial.id,
    archived: false,
    isDraftVessel: false,
    audience: 'human',
    ...partial,
  }) as IssueViewModel

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

describe('pool screening queue', () => {
  it('takes only live human proposals, most urgent first', () => {
    const queue = readPoolScreening([
      issue({ id: asIssueId('p2-old'), priority: 2, seq: 10 }),
      issue({ id: asIssueId('backlog'), stage: 'backlog' }),
      issue({ id: asIssueId('p0'), priority: 0, seq: 4 }),
      issue({ id: asIssueId('p2-new'), priority: 2, seq: 30 }),
      issue({ id: asIssueId('archived'), archived: true }),
      issue({ id: asIssueId('deleted'), deletedAt: '2026-07-01T00:00:00.000Z' }),
      issue({ id: asIssueId('draft'), isDraftVessel: true }),
      issue({ id: asIssueId('internal'), audience: 'agent' }),
    ])

    expect(queue).toEqual(['p0', 'p2-new', 'p2-old'])
  })

  it('leaves out a proposal nested under an unapproved proposal', () => {
    const queue = readPoolScreening([
      issue({ id: asIssueId('root') }),
      issue({ id: asIssueId('child'), parentId: asIssueId('root'), seq: 2 }),
      issue({ id: asIssueId('grandchild'), parentId: asIssueId('child'), seq: 3 }),
      issue({ id: asIssueId('under-backlog'), parentId: asIssueId('approved'), seq: 4 }),
      issue({ id: asIssueId('approved'), stage: 'backlog' }),
    ])

    expect(queue).toEqual(['under-backlog', 'root'])
  })
})

describe('pool screening reconciliation', () => {
  const board = [
    issue({ id: asIssueId('a'), seq: 3 }),
    issue({ id: asIssueId('b'), seq: 2 }),
    issue({ id: asIssueId('c'), seq: 1 }),
  ]

  it('keeps decided cards, drops undecided ones that left the lane, appends arrivals', () => {
    const next = reconcileScreeningIds(
      [asIssueId('a'), asIssueId('b'), asIssueId('c')],
      1,
      readPoolScreening([
        // 'a' was accepted by this flow, 'b' was closed from another client.
        issue({ id: asIssueId('a'), stage: 'in_progress' }),
        issue({ id: asIssueId('c'), seq: 1 }),
        issue({ id: asIssueId('d'), seq: 9 }),
      ]),
    )

    expect(next).toEqual({ order: ['a', 'c', 'd'], index: 1 })
  })

  it('never reorders the undecided tail around the current card', () => {
    // 'c' outranks the rest on the board, but the deck order is a snapshot.
    const next = reconcileScreeningIds(
      [asIssueId('a'), asIssueId('b'), asIssueId('c')],
      0,
      readPoolScreening([...board, issue({ id: asIssueId('z'), priority: 0, seq: 99 })]),
    )

    expect(next).toEqual({ order: ['a', 'b', 'c', 'z'], index: 0 })
  })
})

describe('pool screening incrementality', () => {
  const proposal = (at: number) =>
    issue({ id: asIssueId(`scale-${at}`), priority: 2, seq: at + 1 })

  /** Issue summary reads through the pool while `run` executes. */
  function countSummaryReads(pool: MobxPool, run: () => void): { reads: number; ids: string[] } {
    let reads = 0
    const ids: string[] = []
    const raw = pool.row.bind(pool) as (...args: unknown[]) => unknown
    const spy = vi.spyOn(pool, 'row')
    spy.mockImplementation(((...args: unknown[]) => {
      if (args[0] === 'issue' && args[2] === 'summary') {
        reads++
        ids.push(args[1] as string)
      }
      return raw(...args)
    }) as never)
    try {
      run()
    } finally {
      spy.mockRestore()
    }
    return { reads, ids }
  }

  it('re-reads one summary on an unrelated proposal edit, flat at 1x/4x', () => {
    // The legacy arm reprojected every proposal on any summary touch: P
    // summary reads plus ancestor walks per single-row update (P/4P). It
    // reads ~25/100 summaries here and fails the flat bound below.
    const cells: { scale: number; proposals: number; summaryReads: number }[] = []
    for (const scale of [1, 4]) {
      const count = 25 * scale
      const opened = openScreeningPool(Array.from({ length: count }, (_, at) => proposal(at)))
      try {
        const first = opened.views.screening()
        expect(first.booting).toBe(false)
        expect(first.queue).toHaveLength(count)
        const target = opened.issues[7]!
        const update = () =>
          opened.pool.apply({
            type: 'update',
            rows: [
              {
                kind: 'issue',
                id: target.id,
                value: { ...target, title: 'retitled proposal' } as never,
              },
            ],
          })
        const duringApply = countSummaryReads(opened.pool, update)
        const duringRead = countSummaryReads(opened.pool, () => {
          const next = opened.views.screening()
          expect(next.booting).toBe(false)
          expect(next.queue).toEqual(first.queue)
        })
        console.log(
          'DEBUG scale',
          scale,
          'apply:',
          duringApply.reads,
          'reread:',
          duringRead.reads,
          'ids:',
          [...new Set(duringApply.ids.concat(duringRead.ids))].slice(0, 8),
        )
        cells.push({ scale, proposals: count, summaryReads: duringApply.reads + duringRead.reads })
      } finally {
        opened.dispose()
      }
    }
      } finally {
        opened.dispose()
      }
    }
    const [oneX, fourX] = cells
    expect(fourX?.proposals).toBe((oneX?.proposals ?? 0) * 4)
    // One touched summary re-reads its own entry; the other P-1 share the
    // maintained branches. No ancestor walk: the touched root has no parent.
    expect(oneX?.summaryReads).toBeLessThanOrEqual(3)
    expect(fourX?.summaryReads).toBe(oneX?.summaryReads)
  })

  it('re-reads the touched entry when its queue position changes, flat at 1x/4x', () => {
    const cells: { scale: number; summaryReads: number; head: string }[] = []
    for (const scale of [1, 4]) {
      const count = 25 * scale
      const opened = openScreeningPool(Array.from({ length: count }, (_, at) => proposal(at)))
      try {
        const first = opened.views.screening()
        expect(first.booting).toBe(false)
        expect(first.queue[first.queue.length - 1]).toBe(opened.issues[0]!.id)
        const target = opened.issues[0]!
        let head = ''
        const measured = countSummaryReads(opened.pool, () => {
          opened.pool.apply({
            type: 'update',
            rows: [
              {
                kind: 'issue',
                id: target.id,
                value: { ...target, priority: 0 } as never,
              },
            ],
          })
          const next = opened.views.screening()
          expect(next.booting).toBe(false)
          head = next.queue[0]!
          expect(head).toBe(target.id)
        })
        if (measured.reads > 3) {
          const hist = new Map<string, number>()
          for (const id of measured.ids) hist.set(id, (hist.get(id) ?? 0) + 1)
          console.log('DEBUG reads:', measured.reads, [...hist.entries()])
        }
        cells.push({ scale, summaryReads: measured.reads, head })
      } finally {
        opened.dispose()
      }
    }
    const [oneX, fourX] = cells
    expect(oneX?.head).toBe('scale-0')
    expect(fourX?.head).toBe('scale-0')
    // The promoted entry re-reads once and takes one tree path; ordering
    // re-derives from the maintained answer with no further row reads.
    expect(oneX?.summaryReads).toBeLessThanOrEqual(3)
    expect(fourX?.summaryReads).toBe(oneX?.summaryReads)
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

  it('decline closes the proposal as cancelled', async () => {
    const { commands, calls } = fakeCommands()

    await applyScreeningDecision(commands, proposal, 'declined')

    expect(calls).toEqual(['close:{"id":"iss_1","reason":"cancelled"}'])
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
