import { describe, expect, it } from 'vitest'
import {
  type ActiveWorkRow,
  activeWork,
  awaitingMergeOf,
  issueLanding,
  unmergedDeliveryOf,
} from './active-work'

const NOW = Date.parse('2026-10-01T00:00:00.000Z')

function input(
  issues: Record<string, ActiveWorkRow>,
  sessions: Record<string, ActiveWorkRow>,
  history: readonly string[],
  opened?: string,
) {
  const cold = new Set(history)
  return {
    now: NOW,
    issues: new Map(Object.entries(issues)),
    sessions: new Map(Object.entries(sessions)),
    cold: (entity: 'issue' | 'session', id: string) => cold.has(`${entity}:${id}`),
    ...(opened === undefined ? {} : { opened }),
  }
}

const sorted = (ids: ReadonlySet<string>) => [...ids].sort()

describe('active work (POD-5593)', () => {
  it('keeps what the residency rule keeps, and nothing it calls history', () => {
    const work = activeWork(input({ open: {}, old: {} }, { s: { issueId: 'open' }, gone: { issueId: 'old' } }, ['issue:old', 'session:gone']))
    expect(sorted(work.issues)).toEqual(['open'])
    expect(sorted(work.sessions)).toEqual(['s'])
  })

  it('holds every ancestor of an active issue, and stops at a parent cycle', () => {
    const work = activeWork(input(
      {
        root: {},
        mid: { parentId: 'root' },
        leaf: { parentId: 'mid' },
        other: { parentId: 'root' },
        a: { parentId: 'b' },
        b: { parentId: 'a' },
      },
      {},
      ['issue:root', 'issue:mid', 'issue:other', 'issue:b'],
    ))
    expect(sorted(work.issues)).toEqual(['a', 'b', 'leaf', 'mid', 'root'])
  })

  it('holds the issue an active session names, with its ancestors', () => {
    const work = activeWork(input(
      { top: {}, owner: { parentId: 'top' } },
      { run: { issueId: 'owner' } },
      ['issue:top', 'issue:owner'],
    ))
    expect(sorted(work.issues)).toEqual(['owner', 'top'])
  })

  it('holds the opened issue, its ancestors, children and sessions', () => {
    const work = activeWork(input(
      { top: {}, opened: { parentId: 'top' }, child: { parentId: 'opened' }, grandchild: { parentId: 'child' }, other: {} },
      { mine: { issueId: 'opened' }, theirs: { issueId: 'top' } },
      ['issue:top', 'issue:opened', 'issue:child', 'issue:grandchild', 'issue:other', 'session:mine', 'session:theirs'],
      'opened',
    ))
    expect(sorted(work.issues)).toEqual(['child', 'opened', 'top'])
    expect(sorted(work.sessions)).toEqual(['mine'])
  })
})

describe('issueLanding (POD-2151)', () => {
  const landed = {
    stage: 'done' as const,
    closedReason: 'done',
    parentBranch: 'tf.dev',
    landedAt: '2026-10-26T19:59:00Z',
    landedSha: 'fcd1385aa9e0',
    branch: 'issue/1-x',
    // What the merge action writes: the axis it just settled.
    gitState: { shared: false, merged: true, ahead: 0 },
  }

  it('reads where and what a done row landed', () => {
    expect(issueLanding(landed)).toEqual({ at: landed.landedAt, branch: 'tf.dev', sha: 'fcd1385' })
    expect(issueLanding({ ...landed, landedSha: null, parentBranch: null })).toEqual({
      at: landed.landedAt,
      branch: null,
      sha: null,
    })
  })

  it('is null without a stamp, for any ending but done, and while new work awaits merge', () => {
    expect(issueLanding({ ...landed, landedAt: null })).toBeNull()
    expect(issueLanding({ ...landed, closedReason: 'cancelled' })).toBeNull()
    expect(issueLanding({ ...landed, stage: 'in_progress', closedReason: null })).toBeNull()
    // The stamp outlives a reopen; unlanded work outranks it.
    expect(issueLanding({ ...landed, gitState: { shared: false, ahead: 1 } })).toBeNull()
  })
})
