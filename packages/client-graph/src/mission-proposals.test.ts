import { autorun, observable, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import type { FullDeck } from './mission-full-deck'
import { type ProposalAction, ProposalSubmissions, successLabel } from './mission-proposals'

afterEach(() => vi.useRealTimers())

function fixture(policy: 'desktop' | 'brief' = 'desktop') {
  const state = observable({ ids: ['proposal'], abandoned: false })
  const full = {
    get proposalIds() {
      return state.ids
    },
    task: () => ({ abandoned: state.abandoned }),
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
