import type { IssueBodyField, IssueBodyWire } from '@podium/model/browser'
import { autorun } from 'mobx'
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
  const readers: (() => void)[] = []
  const watch = (
    store: IssueBodyStore,
    id: string,
    field: IssueBodyField = 'brief',
    digest = 'd',
  ) => {
    const close = autorun(() => {
      store.read(id, field, digest)
    })
    readers.push(close)
    return close
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    for (const close of readers.splice(0)) close()
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
    const held = new Map([['a', [body('a', 'brief', 'd1', 'First')]]])
    const { calls, fetch } = server(held)
    store.bind(fetch)
    store.read('a', 'brief', 'd1')
    await settle()
    held.set('a', [body('a', 'brief', 'd2', 'Second')])
    expect(store.read('a', 'brief', 'd2')).toEqual({ value: 'First', current: false })
    await settle()
    expect(calls).toHaveLength(2)
    expect(store.read('a', 'brief', 'd2')).toEqual({ value: 'Second', current: true })
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

  it('backs off repeated failures without reads bypassing the delay, capped at 30 seconds', async () => {
    const store = new IssueBodyStore()
    const fetch = vi.fn(async () => {
      throw new Error('offline')
    })
    store.bind(fetch)
    watch(store, 'a')
    await settle()
    let attempts = 1
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      for (let read = 0; read < 20; read++) store.read('a', 'brief', 'd')
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(fetch).toHaveBeenCalledTimes(attempts)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetch).toHaveBeenCalledTimes(++attempts)
      expect(vi.getTimerCount()).toBe(1)
    }
  })

  it('retries only failed batches and keeps the 50 issue request limit', async () => {
    const store = new IssueBodyStore()
    const fetch = vi.fn(async (ids: readonly string[]) =>
      ids.map((id) => body(id, 'brief', 'd', id)),
    )
    fetch.mockRejectedValueOnce(new Error('offline'))
    store.bind(fetch)
    for (let i = 0; i < BODY_BATCH_IDS + 7; i++) watch(store, `i${i}`)
    await settle()
    expect(fetch.mock.calls.map(([ids]) => ids.length)).toEqual([BODY_BATCH_IDS, 7])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetch.mock.calls.map(([ids]) => ids.length)).toEqual([BODY_BATCH_IDS, 7, BODY_BATCH_IDS])
    expect(fetch.mock.calls[2]).toEqual(fetch.mock.calls[0])
    expect(store.read('i0', 'brief', 'd')).toEqual({ value: 'i0', current: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops retries for closed issues and requeues the same digest on the next read', async () => {
    const store = new IssueBodyStore()
    const fetch = vi.fn(async (ids: readonly string[]) =>
      ids.map((id) => body(id, 'brief', 'd', id)),
    )
    fetch.mockRejectedValueOnce(new Error('offline'))
    store.bind(fetch)
    const close = watch(store, 'a')
    watch(store, 'b')
    await settle()
    close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch.mock.calls.map(([ids]) => [...ids])).toEqual([['a', 'b'], ['b']])
    expect(vi.getTimerCount()).toBe(0)
    watch(store, 'a')
    await settle()
    expect(fetch.mock.calls.map(([ids]) => [...ids])).toEqual([['a', 'b'], ['b'], ['a']])
    expect(store.read('a', 'brief', 'd')).toEqual({ value: 'a', current: true })
  })

  it('keeps retries until the last field reader closes, then cancels the timer', async () => {
    const store = new IssueBodyStore()
    const fetch = vi.fn(async () => {
      throw new Error('offline')
    })
    store.bind(fetch)
    const closeBrief = watch(store, 'a')
    const closeDescription = watch(store, 'a', 'description')
    await settle()
    closeBrief()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    closeDescription()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    watch(store, 'a', 'description')
    await settle()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('does not retry a failure with no observer, but permits the next imperative read', async () => {
    const store = new IssueBodyStore()
    const fetch = vi.fn(async () => [body('a', 'brief', 'd', 'Recovered')])
    fetch.mockRejectedValueOnce(new Error('offline'))
    store.bind(fetch)
    store.read('a', 'brief', 'd')
    await settle()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(store.read('a', 'brief', 'd')).toBe(LOADING)
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(store.read('a', 'brief', 'd')).toEqual({ value: 'Recovered', current: true })
  })

  it('does not queue a failed flight after its last reader closes', async () => {
    const store = new IssueBodyStore()
    let fail!: (error: Error) => void
    const fetch = vi.fn(async () => [body('a', 'brief', 'd', 'Recovered')])
    fetch.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
    store.bind(fetch)
    const close = watch(store, 'a')
    await settle()
    close()
    fail(new Error('offline'))
    await settle()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    watch(store, 'a')
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(store.read('a', 'brief', 'd')).toEqual({ value: 'Recovered', current: true })
  })

  it('retries pending text on reconnect once and releases the subscription on unbind', async () => {
    const store = new IssueBodyStore()
    let reconnect = () => {}
    const stopReconnect = vi.fn()
    const fetch = vi.fn(async () => [body('a', 'brief', 'd', 'Recovered')])
    fetch.mockRejectedValueOnce(new Error('offline'))
    const unbind = store.bind(fetch, (listener) => {
      reconnect = listener
      return stopReconnect
    })
    watch(store, 'a')
    await settle()
    for (let event = 0; event < 20; event++) reconnect()
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(store.read('a', 'brief', 'd')).toEqual({ value: 'Recovered', current: true })
    reconnect()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    unbind()
    expect(stopReconnect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('pauses failed requests on unbind and resumes them on bind without a new read', async () => {
    const store = new IssueBodyStore()
    const fetch = vi.fn(async () => [body('a', 'brief', 'd', 'Recovered')])
    fetch.mockRejectedValueOnce(new Error('offline'))
    const unbind = store.bind(fetch)
    watch(store, 'a')
    await settle()
    unbind()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    store.bind(fetch)
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(store.read('a', 'brief', 'd')).toEqual({ value: 'Recovered', current: true })
  })

  it('keeps retries serial when more readers arrive during a request', async () => {
    const store = new IssueBodyStore()
    let finish!: (bodies: readonly IssueBodyWire[]) => void
    const fetch = vi.fn(
      async (ids: readonly string[]): Promise<readonly IssueBodyWire[]> =>
        ids.map((id) => body(id, 'brief', 'd', id)),
    )
    fetch.mockRejectedValueOnce(new Error('offline'))
    fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    store.bind(fetch)
    watch(store, 'a')
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    store.read('b', 'brief', 'd')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    finish([body('a', 'brief', 'd', 'a')])
    await settle()
    expect(fetch.mock.calls.map(([ids]) => [...ids])).toEqual([['a'], ['a'], ['b']])
    expect(store.read('b', 'brief', 'd')).toEqual({ value: 'b', current: true })
  })

  it('resumes in-flight requests on rebind and ignores the old binding response', async () => {
    const store = new IssueBodyStore()
    let finish!: (bodies: readonly IssueBodyWire[]) => void
    const fetch = vi.fn(
      async (): Promise<readonly IssueBodyWire[]> => [body('a', 'brief', 'd', 'New')],
    )
    fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const unbind = store.bind(fetch)
    store.read('a', 'brief', 'd')
    await settle()
    unbind()
    store.bind(fetch)
    // The old cleanup must not unbind a newer attachment of the same fetch.
    unbind()
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    finish([body('a', 'brief', 'd', 'Old')])
    await Promise.resolve()
    expect(store.read('a', 'brief', 'd')).toEqual({ value: 'New', current: true })
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

  it.each([
    'description',
    'brief',
  ] as const)('loads reverted %s text again through A, B, A and releases the edit guard', async (field) => {
    const rowAt = (digest: string) => issueRow({ bodies: { [field]: { digest, size: 1 } } })
    const pool = poolWith(rowAt('A'))
    const held = new Map<string, IssueBodyWire[]>()
    const { calls, fetch } = server(held)
    const unbind = pool.issueBodies.bind(fetch)
    const issue = pool.issueObject('a')
    const paints: unknown[] = []
    const close = autorun(() => {
      paints.push([issue[field], issue.bodyLoading(field)])
    })
    try {
      for (const digest of ['A', 'B', 'A']) {
        const value = field === 'description' ? { value: digest } : digest
        held.set('a', [body('a', field, digest, value)])
        pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'a', value: rowAt(digest) }] })
        await settle()
        expect(paints.at(-1)).toEqual([digest, false])
      }
      expect(calls).toEqual([['a'], ['a'], ['a']])
    } finally {
      close()
      unbind()
      pool.dispose()
    }
  })

  it('delivers brief and description after a failed fetch while the same reader stays open', async () => {
    const pool = poolWith(
      issueRow({
        bodies: { brief: { digest: 'd1', size: 7 }, description: { digest: 'd2', size: 3 } },
      }),
    )
    const fetch = vi.fn(async () => [
      body('a', 'brief', 'd1', 'Brief A'),
      body('a', 'description', 'd2', { value: 'Sum' }),
    ])
    fetch.mockRejectedValueOnce(new Error('offline'))
    const unbind = pool.issueBodies.bind(fetch)
    const issue = pool.issueObject('a')
    const paints: unknown[] = []
    const close = autorun(() => {
      paints.push([
        issue.brief,
        issue.description,
        issue.bodyLoading('brief'),
        issue.bodyLoading('description'),
      ])
    })
    try {
      expect(paints).toEqual([[undefined, '', true, true]])
      await settle()
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(paints).toHaveLength(1)
      // No read, redraw, header update or navigation triggers the retry.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(paints).toEqual([
        [undefined, '', true, true],
        ['Brief A', 'Sum', false, false],
      ])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      close()
      unbind()
      pool.dispose()
    }
  })
})
