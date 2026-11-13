import { autorun, observable, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import type { FullDeck } from './mission-full-deck'
import { type ProposalAction, ProposalSubmissions, successLabel } from './mission-proposals'

afterEach(() => vi.useRealTimers())

function fixture(policy: 'desktop' | 'brief' = 'desktop') {
  const state = observable({
    ids: ['proposal'],
    rowIds: ['accepted'],
    rootIds: null as string[] | null,
    depths: {} as Record<string, number>,
    abandoned: false,
    abandonedIds: [] as string[],
  })
  const full = {
    get proposalIds() {
      return state.ids
    },
    get rowIds() {
      return state.rowIds
    },
    get filterable() {
      return state.rowIds.length > 0
    },
    root: {
      get childIds() {
        return state.rootIds ?? state.rowIds
      },
    },
    task: (id: string) => ({
      abandoned: state.abandoned || state.abandonedIds.includes(id),
      depth: state.depths[id] ?? 0,
    }),
  } as unknown as FullDeck
  const submissions = new ProposalSubmissions(full, policy)
  const commands = {
    issues: {
      start: { mutate: vi.fn(async (_input: unknown) => {}) },
      promote: { mutate: vi.fn(async (_input: unknown) => {}) },
      close: { mutate: vi.fn(async (_input: unknown) => {}) },
    },
  }
  return { state, submissions, commands }
}

it.each<ProposalAction>([
  'start',
  'backlog',
  'dismiss',
])('brief %s keeps the receipt index and window identity through publication', async (verb) => {
  vi.useFakeTimers()
  const f = fixture('brief')
  const original = Array.from({ length: 100 }, (_, index) => `proposal-${index}`)
  const id = 'proposal-50'
  runInAction(() => {
    f.state.ids = original
  })
  const lists: string[][] = []
  const stop = autorun(() => {
    lists.push([...f.submissions.ids])
    void f.submissions.window.has(id)
  })
  f.submissions.window.appear(id)
  const visible = [...f.submissions.window.visibleRows]
  let resolve = () => {}
  const command =
    verb === 'start'
      ? f.commands.issues.start
      : verb === 'backlog'
        ? f.commands.issues.promote
        : f.commands.issues.close
  command.mutate.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done
      }),
  )
  const submitted = f.submissions.submit(id, verb, f.commands)
  const mutationId = f.submissions.byId.get(id)?.mutationId
  expect(f.submissions.byId.get(id)?.phase).toBe('pending')
  runInAction(() => {
    f.state.ids = original.filter((candidate) => candidate !== id)
    f.state.abandonedIds = verb === 'dismiss' ? [id] : []
  })
  expect(f.submissions.ids).toEqual(original)
  expect(f.submissions.window.visibleRows).toEqual(visible)
  expect(f.submissions.window.has(id)).toBe(true)
  resolve()
  await submitted
  expect(f.submissions.byId.get(id)?.mutationId).toBe(mutationId)
  expect(lists.every((ids) => ids.join() === original.join())).toBe(true)
  vi.advanceTimersByTime(1800)
  f.submissions.expireReceipts()
  expect(f.submissions.ids).toEqual(original.filter((candidate) => candidate !== id))
  stop()
})

it('brief adjacent receipts keep their order when commands publish and expire separately', async () => {
  vi.useFakeTimers()
  const f = fixture('brief')
  runInAction(() => {
    f.state.ids = ['before', 'first', 'second', 'after']
  })
  const stop = autorun(() => f.submissions.ids)
  await f.submissions.submit('second', 'backlog', f.commands)
  runInAction(() => {
    f.state.ids = ['before', 'first', 'after']
  })
  expect(f.submissions.ids).toEqual(['before', 'first', 'second', 'after'])
  vi.advanceTimersByTime(500)
  await f.submissions.submit('first', 'start', f.commands)
  runInAction(() => {
    f.state.ids = ['before', 'after']
  })
  expect(f.submissions.ids).toEqual(['before', 'first', 'second', 'after'])
  vi.advanceTimersByTime(1300)
  f.submissions.expireReceipts()
  expect(f.submissions.ids).toEqual(['before', 'first', 'after'])
  vi.advanceTimersByTime(500)
  f.submissions.expireReceipts()
  expect(f.submissions.ids).toEqual(['before', 'after'])
  stop()
})

it('brief holds proposal order only until the last receipt expires', async () => {
  vi.useFakeTimers()
  const f = fixture('brief')
  runInAction(() => {
    f.state.ids = ['before', 'proposal', 'after']
  })
  const stop = autorun(() => f.submissions.ids)
  await f.submissions.submit('proposal', 'backlog', f.commands)
  runInAction(() => {
    f.state.ids = ['new', 'after', 'before']
  })
  expect(f.submissions.ids).toEqual(['before', 'proposal', 'after', 'new'])
  vi.advanceTimersByTime(1800)
  f.submissions.expireReceipts()
  expect(f.submissions.ids).toEqual(['new', 'after', 'before'])
  stop()
})

it('desktop keeps its existing live ordering and appends its persistent receipt', async () => {
  const f = fixture()
  runInAction(() => {
    f.state.ids = ['before', 'proposal', 'after']
  })
  const stop = autorun(() => f.submissions.ids)
  await f.submissions.submit('proposal', 'start', f.commands)
  runInAction(() => {
    f.state.ids = ['after', 'before']
  })
  expect(f.submissions.ids).toEqual(['after', 'before', 'proposal'])
  stop()
})

it.each([
  'brief',
  'desktop',
] as const)('%s publishes the accepted row at its receipt boundary', async (policy) => {
  vi.useFakeTimers()
  const f = fixture(policy)
  const stop = autorun(() => f.submissions.acceptedTree)
  await f.submissions.submit('proposal', 'start', f.commands)
  runInAction(() => {
    f.state.ids = []
    f.state.rowIds = ['accepted', 'proposal']
  })
  expect(f.submissions.acceptedTree.rowIds).toEqual(
    policy === 'brief' ? ['accepted'] : ['accepted', 'proposal'],
  )
  vi.advanceTimersByTime(1800)
  f.submissions.expireReceipts()
  expect(f.submissions.acceptedTree.rowIds).toEqual(['accepted', 'proposal'])
  expect(f.submissions.ids).toEqual(policy === 'brief' ? [] : ['proposal'])
  stop()
})

it.each([
  'brief',
  'desktop',
] as const)('%s publishes the first accepted task and its filters together', async (policy) => {
  vi.useFakeTimers()
  const f = fixture(policy)
  runInAction(() => {
    f.state.rowIds = []
  })
  const stop = autorun(() => f.submissions.acceptedTree)
  await f.submissions.submit('proposal', 'start', f.commands)
  runInAction(() => {
    f.state.ids = []
    f.state.rowIds = ['proposal']
  })
  expect(f.submissions.acceptedTree).toEqual(
    policy === 'brief'
      ? { rowIds: [], filterable: false }
      : { rowIds: ['proposal'], filterable: true },
  )
  vi.advanceTimersByTime(1800)
  f.submissions.expireReceipts()
  expect(f.submissions.acceptedTree).toEqual({ rowIds: ['proposal'], filterable: true })
  stop()
})

it('brief withholds a promoted task and its visible descendants until the receipt expires', async () => {
  vi.useFakeTimers()
  const f = fixture('brief')
  runInAction(() => {
    f.state.ids = ['proposal', 'neighbour']
    f.state.rowIds = ['before', 'after']
    f.state.rootIds = ['before', 'after']
    f.state.depths = { child: 1, grandchild: 2 }
  })
  const stop = autorun(() => f.submissions.acceptedTree)
  await f.submissions.submit('proposal', 'start', f.commands)
  runInAction(() => {
    f.state.ids = ['neighbour']
    f.state.rowIds = ['before', 'proposal', 'child', 'grandchild', 'after']
    f.state.rootIds = ['before', 'proposal', 'after']
  })
  expect(f.submissions.acceptedTree).toEqual({ rowIds: ['before', 'after'], filterable: true })
  vi.advanceTimersByTime(1800)
  f.submissions.expireReceipts()
  expect(f.submissions.acceptedTree).toEqual({
    rowIds: ['before', 'proposal', 'child', 'grandchild', 'after'],
    filterable: true,
  })
  stop()
})

it.each<ProposalAction>([
  'start',
  'backlog',
  'dismiss',
])('brief %s receipt survives publication then expires', async (verb) => {
  vi.useFakeTimers()
  const f = fixture('brief')
  const stop = autorun(() => f.submissions.ids)
  await f.submissions.submit('proposal', verb, f.commands)
  runInAction(() => {
    f.state.ids = []
    f.state.abandoned = verb === 'dismiss'
  })
  expect(f.submissions.ids).toEqual(['proposal'])
  const status = f.submissions.byId.get('proposal')
  if (!status) throw new Error('Missing receipt')
  expect(successLabel[status.action]).toBe(
    verb === 'start' ? 'Started' : verb === 'backlog' ? 'In backlog' : 'Dismissed',
  )
  expect(f.submissions.receiptDeadline).toBe(Date.now() + 1800)
  vi.advanceTimersByTime(1799)
  f.submissions.expireReceipts()
  expect(f.submissions.ids).toEqual(['proposal'])
  vi.advanceTimersByTime(1)
  f.submissions.expireReceipts()
  expect(f.submissions.ids).toEqual([])
  expect(f.submissions.receiptDeadline).toBeNull()
  await f.submissions.submit('proposal', verb, f.commands)
  const command =
    verb === 'start'
      ? f.commands.issues.start
      : verb === 'backlog'
        ? f.commands.issues.promote
        : f.commands.issues.close
  expect(command.mutate).toHaveBeenCalledOnce()
  stop()
})

it.each<ProposalAction>([
  'start',
  'backlog',
  'dismiss',
])('desktop %s receipt keeps its existing lifetime', async (verb) => {
  const f = fixture()
  const stop = autorun(() => f.submissions.ids)
  await f.submissions.submit('proposal', verb, f.commands)
  runInAction(() => {
    f.state.ids = []
  })
  expect(f.submissions.ids).toEqual(verb === 'dismiss' ? [] : ['proposal'])
  expect(f.submissions.receiptDeadline).toBeNull()
  f.submissions.expireReceipts(Infinity)
  expect(f.submissions.ids).toEqual(verb === 'dismiss' ? [] : ['proposal'])
  stop()
})

it('uses the existing direct Start command, guards repeated submission and retries with one mutation ID', async () => {
  const f = fixture('brief')
  f.commands.issues.start.mutate.mockRejectedValueOnce(new Error('Offline'))
  await f.submissions.submit('proposal', 'start', f.commands)
  expect(f.submissions.byId.get('proposal')?.error).toBe('Offline')
  const mutationId = f.commands.issues.start.mutate.mock.calls[0]?.[0]
  await Promise.all([
    f.submissions.submit('proposal', 'start', f.commands),
    f.submissions.submit('proposal', 'start', f.commands),
  ])
  expect(f.commands.issues.start.mutate).toHaveBeenCalledTimes(2)
  expect(f.commands.issues.start.mutate).toHaveBeenLastCalledWith(mutationId)
  expect(f.commands.issues.promote.mutate).not.toHaveBeenCalled()
})

it.each([
  'desktop',
  'brief',
] as const)('%s drops a declined proposal when publication beats a command refusal', async (policy) => {
  const f = fixture(policy)
  const stop = autorun(() => f.submissions.ids)
  let refuse = (_error: Error) => {}
  f.commands.issues.start.mutate.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        refuse = reject
      }),
  )
  const command = f.submissions.submit('proposal', 'start', f.commands)
  runInAction(() => {
    f.state.ids = []
    f.state.abandoned = true
  })
  expect(f.submissions.ids).toEqual(policy === 'brief' ? ['proposal'] : [])
  refuse(new Error('Proposal already declined'))
  await command
  expect(f.submissions.byId.get('proposal')?.phase).toBe('error')
  expect(f.submissions.ids).toEqual([])
  expect(f.submissions.receiptDeadline).toBeNull()
  stop()
})
