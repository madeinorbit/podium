import type { IssueBodyField, IssueBodyWire } from '@podium/model/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BODY_BATCH_IDS, BODY_WINDOW_MS, IssueBodyStore } from './issue-bodies'
import { LOADING } from './loading'
import { MobxPool } from './pool'

/**
 * The body store (POD-6767): bodies read by issue id, batched over 50 ms,
 * kept by the digest their header names.
 */

const body = (
  issueId: string,
  field: IssueBodyField,
  digest: string,
  value: unknown,
): IssueBodyWire => ({ issueId, field, digest, value }) as IssueBodyWire

/** A fetch that answers from `held`, recording every call's ids. */
function server(held: Map<string, IssueBodyWire[]>) {
  const calls: string[][] = []
  const fetch = vi.fn(async (ids: readonly string[]) => {
    calls.push([...ids])
    return ids.flatMap((id) => held.get(id) ?? [])
  })
  return { calls, fetch }
}

const settle = async () => {
  await vi.advanceTimersByTimeAsync(BODY_WINDOW_MS)
}

describe('IssueBodyStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers LOADING, then the body; reads in one window are one call', async () => {
    const store = new IssueBodyStore()
    const { calls, fetch } = server(
      new Map([
        ['a', [body('a', 'brief', 'd1', 'Brief A')]],
        ['b', [body('b', 'description', 'd2', { value: 'Summary B' })]],
      ]),
    )
    store.bind(fetch)
    expect(store.read('a', 'brief', 'd1')).toBe(LOADING)
    expect(store.read('b', 'description', 'd2')).toBe(LOADING)
    // Asking again before the answer starts no second load.
    expect(store.read('a', 'brief', 'd1')).toBe(LOADING)
    await settle()
    expect(calls).toEqual([['a', 'b']])
    expect(store.read('a', 'brief', 'd1')).toEqual({ value: 'Brief A', current: true })
    expect(store.read('b', 'description', 'd2')).toEqual({
      value: { value: 'Summary B' },
      current: true,
    })
    // A held body at its digest costs nothing.
    await settle()
    expect(calls).toHaveLength(1)
  })

  it('splits a window into calls of at most 50 issues', async () => {
    const store = new IssueBodyStore()
    const { calls, fetch } = server(new Map())
    store.bind(fetch)
    for (let i = 0; i < BODY_BATCH_IDS + 7; i++) store.read(`i${i}`, 'brief', 'd')
    await settle()
    expect(calls.map((ids) => ids.length)).toEqual([BODY_BATCH_IDS, 7])
  })

  it('keeps showing the held body while a moved header loads, marked not current', async () => {
    const store = new IssueBodyStore()
    const held = new Map([['a', [body('a', 'activityNotes', 'd1', 'First')]]])
    const { calls, fetch } = server(held)
    store.bind(fetch)
    store.read('a', 'activityNotes', 'd1')
    await settle()
    held.set('a', [body('a', 'activityNotes', 'd2', 'Second')])
    expect(store.read('a', 'activityNotes', 'd2')).toEqual({ value: 'First', current: false })
    await settle()
    expect(calls).toHaveLength(2)
    expect(store.read('a', 'activityNotes', 'd2')).toEqual({ value: 'Second', current: true })
  })

  it('shows the text a settled edit painted until its body arrives', async () => {
    const store = new IssueBodyStore()
    const held = new Map([['a', [body('a', 'brief', 'd1', 'Old')]]])
    const { fetch } = server(held)
    store.bind(fetch)
    store.read('a', 'brief', 'd1')
    await settle()
    // The edit paints "New"; its paint retires and the header moves.
    store.remember('a', 'brief', 'New')
    held.set('a', [body('a', 'brief', 'd2', 'New')])
    expect(store.read('a', 'brief', 'd2')).toEqual({ value: 'New', current: false })
    await settle()
    expect(store.read('a', 'brief', 'd2')).toEqual({ value: 'New', current: true })
  })

  it('asks again after a failed call', async () => {
    const store = new IssueBodyStore()
    let fail = true
    const fetch = vi.fn(async (ids: readonly string[]) => {
      if (fail) throw new Error('offline')
      return ids.map((id) => body(id, 'brief', 'd', `Brief ${id}`))
    })
    store.bind(fetch)
    store.read('a', 'brief', 'd')
    await settle()
    expect(store.read('a', 'brief', 'd')).toBe(LOADING)
    fail = false
    await settle()
    expect(store.read('a', 'brief', 'd')).toEqual({ value: 'Brief a', current: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('holds reads made before the fetch is bound until it is', async () => {
    const store = new IssueBodyStore()
    store.read('a', 'brief', 'd')
    await settle()
    const { calls, fetch } = server(new Map([['a', [body('a', 'brief', 'd', 'Late')]]]))
    store.bind(fetch)
    await settle()
    expect(calls).toEqual([['a']])
    expect(store.read('a', 'brief', 'd')).toEqual({ value: 'Late', current: true })
  })
})

describe('IssueModel bodies', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const issueRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'a',
    seq: 1,
    title: 'Task',
    stage: 'in_progress',
    createdAt: '2026-11-10T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
    priority: 2,
    type: 'task',
    labels: [],
    audience: 'human' as const,
    repoPath: '/fixture',
    deps: [],
    ...overrides,
  })

  function poolWith(value: Record<string, unknown>) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() }, undefined, {
      load: () => undefined,
      schedule: () => () => {},
    })
    pool.apply({ type: 'replace', rows: [{ kind: 'issue' as const, id: 'a', value }] })
    return pool
  }

  it('answers none, loading, then the value through the headers', async () => {
    const pool = poolWith(
      issueRow({
        bodies: { brief: { digest: 'd1', size: 7 }, description: { digest: 'd2', size: 3 } },
      }),
    )
    const { calls, fetch } = server(
      new Map([
        [
          'a',
          [body('a', 'brief', 'd1', 'Brief A'), body('a', 'description', 'd2', { value: 'Sum' })],
        ],
      ]),
    )
    pool.issueBodies.bind(fetch)
    const issue = pool.issueObject('a')
    // No header: the field has nothing, and nothing is fetched for it.
    expect(issue.activityNotes).toBeUndefined()
    expect(issue.bodyLoading('activityNotes')).toBe(false)
    // A header: loading until the body arrives.
    expect(issue.brief).toBeUndefined()
    expect(issue.description).toBe('')
    expect(issue.bodyLoading('brief')).toBe(true)
    await settle()
    expect(calls).toEqual([['a']])
    expect(issue.brief).toBe('Brief A')
    expect(issue.description).toBe('Sum')
    expect(issue.bodyLoading('brief')).toBe(false)
  })

  it('prefers a body the row paints over the fetched one', async () => {
    const pool = poolWith(
      issueRow({ brief: 'Typed', bodies: { brief: { digest: 'd1', size: 7 } } }),
    )
    const { calls, fetch } = server(new Map())
    pool.issueBodies.bind(fetch)
    const issue = pool.issueObject('a')
    expect(issue.brief).toBe('Typed')
    expect(issue.bodyLoading('brief')).toBe(false)
    await settle()
    expect(calls).toEqual([])
  })
})
