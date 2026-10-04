import type { PodiumClientApi } from '@podium/client-core'
import type { SpawnPlaceholderEvent } from '@podium/client-core/engine'
import { asUserId } from '@podium/model'
import { afterEach, expect, it, vi } from 'vitest'
import { PoolSpawns } from './spawns'

afterEach(() => vi.useRealTimers())

function fixture() {
  vi.useFakeTimers()
  const create = vi.fn<() => Promise<void>>()
  const error = vi.fn()
  const truth = new Map<string, object>()
  const pending = new Set<string>()
  const events: SpawnPlaceholderEvent[] = []
  const owner = new PoolSpawns({
    api: { sessions: { create: { mutate: create } }, issues: { create: { mutate: create } } } as unknown as PodiumClientApi,
    userId: asUserId('u-1'),
    notices: { error, info: () => {} },
    truth: (kind, id) => truth.get(`${kind}:${id}`),
    pending: id => pending.has(id),
    sortKey: () => 'a0',
    paint: event => {
      events.push(event)
      if (event.type === 'painted') pending.add(event.sessionId)
      else for (const id of event.ids) pending.delete(id)
    },
    graceMs: 2000,
  })
  const args = { target: { path: '/repo/tree', repoPath: '/repo' }, agentKind: 'codex' as const }
  return { owner, args, create, error, events, truth, pending }
}

it('paints the session, task, personal markers and first turn before creation', async () => {
  const f = fixture()
  f.create.mockResolvedValue()
  const result = f.owner.spawnDraftAgent({ ...f.args, firstPrompt: 'First turn', requestedDriverId: 'generic-pty' })
  expect(f.events).toHaveLength(1)
  expect(f.events[0]).toMatchObject({ type: 'painted', sessionId: result.sessionId, prompt: 'First turn' })
  if (f.events[0]?.type !== 'painted') throw new Error('missing paint')
  expect(f.events[0].overlays.map(o => o.entity)).toEqual(['sessions', 'sessionUserStates', 'issueProjections', 'issueUserStates'])
  expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ initialPrompt: 'First turn', requestedDriverId: 'generic-pty' }))
  expect(await result.settled).toBe(true)
  f.owner.dispose()
})

it('waits for truth before releasing a composer send', async () => {
  const f = fixture()
  f.create.mockResolvedValue()
  const result = f.owner.spawnDraftAgent(f.args)
  const confirmed = vi.fn()
  void f.owner.waitForSpawnConfirmed(result.sessionId).then(confirmed)
  await Promise.resolve()
  expect(confirmed).not.toHaveBeenCalled()
  f.pending.delete(result.sessionId)
  f.owner.confirmed()
  await Promise.resolve()
  expect(confirmed).toHaveBeenCalledOnce()
  f.owner.dispose()
})

it('accepts a lost HTTP answer when the session arrives during the grace window', async () => {
  const f = fixture()
  f.create.mockRejectedValue(new Error('response lost'))
  const result = f.owner.spawnDraftAgent(f.args)
  await vi.advanceTimersByTimeAsync(1000)
  f.truth.set(`sessions:${result.sessionId}`, {})
  await vi.advanceTimersByTimeAsync(1000)
  expect(await result.settled).toBe(true)
  expect(f.error).not.toHaveBeenCalled()
  expect(f.events).toHaveLength(1)
  f.owner.dispose()
})

it('rolls back both placeholders after a definitive spawn failure and releases waiters', async () => {
  const f = fixture()
  f.create.mockRejectedValue(new Error('refused'))
  const result = f.owner.spawnDraftAgent(f.args)
  const waiter = f.owner.waitForSpawnConfirmed(result.sessionId)
  await vi.advanceTimersByTimeAsync(1999)
  expect(f.pending.has(result.sessionId)).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  await waiter
  expect(await result.settled).toBe(false)
  expect(f.events.at(-1)).toEqual({ type: 'removed', ids: [result.sessionId, result.issueId] })
  expect(f.error).toHaveBeenCalledWith("Couldn't start the agent — refused")
  f.owner.dispose()
})

it('keeps an authoritative task when only starting its agent failed', async () => {
  const f = fixture()
  f.create.mockRejectedValue(new Error('launch refused'))
  const result = f.owner.spawnIssueAgent({ ...f.args, title: 'Task', description: 'Authored turn' })
  f.truth.set(`issueProjections:${result.issueId}`, {})
  await vi.advanceTimersByTimeAsync(2000)
  expect(await result.outcome).toBe('issue-only')
  expect(f.truth.has(`issueProjections:${result.issueId}`)).toBe(true)
  expect(f.events.at(-1)).toEqual({ type: 'removed', ids: [result.sessionId, result.issueId] })
  f.owner.dispose()
})

it('retires principal-owned timers and waiters on disposal', async () => {
  const f = fixture()
  f.create.mockRejectedValue(new Error('late failure'))
  const result = f.owner.spawnDraftAgent(f.args)
  const waiter = f.owner.waitForSpawnConfirmed(result.sessionId)
  await Promise.resolve()
  await Promise.resolve()
  f.owner.dispose()
  await waiter
  expect(await result.settled).toBe(false)
  await vi.advanceTimersByTimeAsync(3000)
  expect(f.events).toHaveLength(1)
  expect(f.error).not.toHaveBeenCalled()
})

it('ignores a create response arriving after the principal was disposed', async () => {
  const f = fixture()
  let finish!: () => void
  f.create.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const result = f.owner.spawnDraftAgent(f.args)
  f.owner.dispose()
  expect(await result.settled).toBe(false)
  finish()
  await Promise.resolve()
  expect(f.events).toHaveLength(1)
  expect(f.error).not.toHaveBeenCalled()
})
