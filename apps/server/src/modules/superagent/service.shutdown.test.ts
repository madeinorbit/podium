import { addSink, type LogRecord } from '@podium/logger'
import { asSessionId, asThreadId, firstAdminMemberId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { SuperagentService, TURN_REAP_GRACE_MS } from './index'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function harness() {
  vi.useFakeTimers()
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  const store = registry.sessionStore
  const intervals = vi.spyOn(globalThis, 'setInterval')
  const sa = await SuperagentService.create(
    registry.modules,
    new RepoRegistry(registry, store),
    store,
    {
      reapIntervalMs: 1_000,
    },
  )
  registry.adoptSuperagent(sa)
  const callback = intervals.mock.calls[0]?.[0] as () => Promise<void>
  const interval = intervals.mock.results[0]?.value
  intervals.mockRestore()
  return {
    registry,
    store,
    sa,
    interval,
    tick: () => Promise.resolve(callback()),
    async close() {
      await sa.dispose()
      await registry.dispose()
      await store.close()
      vi.restoreAllMocks()
      vi.useRealTimers()
    },
  }
}

describe('turn reaper shutdown', () => {
  it('registry disposal awaits a reap through its read and pending-turn writes', async () => {
    const h = await harness()
    const readEntered = barrier()
    const releaseRead = barrier()
    let pass: Promise<void> | undefined
    let closing: Promise<void> | undefined
    try {
      const ownerUserId = await firstAdminMemberId(h.store)
      const threadId = asThreadId('shutdown-expired')
      await h.store.superagent.upsertSuperagentThread({ id: threadId, ownerUserId, kind: 'global' })
      const expired = await h.store.superagent.putPendingTurn({
        turnId: 'shutdown-expired',
        ownerUserId,
        threadId,
        podiumSessionId: asSessionId('shutdown-expired'),
        firstTurn: false,
        payload: { agent: 'claude-code', cwd: '/unused', prompt: 'already accepted', timeoutMs: 1 },
      })
      vi.setSystemTime(Date.parse(expired.createdAt) + TURN_REAP_GRACE_MS + 2)
      const fresh = await h.store.superagent.putPendingTurn({
        ...expired,
        turnId: 'shutdown-fresh',
        threadId: asThreadId('shutdown-fresh'),
      })
      const queued = await h.store.superagent.putQueuedInput({
        inputId: 'shutdown-queued',
        ownerUserId,
        threadId,
        text: 'wait for the next server',
      })
      const dispatch = vi.spyOn(h.registry.modules.headless, 'headlessTurn')
      const ended: unknown[] = []
      h.registry.modules.bus.on('superagent.turnEnded', (event) => {
        ended.push(event)
      })
      const read = h.store.superagent.listPendingTurns.bind(h.store.superagent)
      vi.spyOn(h.store.superagent, 'listPendingTurns').mockImplementationOnce(async () => {
        const rows = await read()
        readEntered.release()
        await releaseRead.promise
        return rows
      })
      pass = h.tick()
      await readEntered.promise
      let disposed = false
      closing = h.registry.dispose().then(() => {
        disposed = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(disposed).toBe(false)

      // A callback already queued when clearInterval runs must also be harmless.
      await h.tick()
      releaseRead.release()
      await pass
      await closing
      expect(await read()).toEqual([fresh])
      expect(ended).toEqual([
        expect.objectContaining({
          threadId,
          ok: false,
          deliveryStatus: 'unknown',
        }),
      ])
      expect(await h.store.superagent.loadSuperagentMessages(threadId)).toEqual([
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringMatching(/outcome is unknown/),
        }),
      ])
      expect(await h.store.superagent.listQueuedInputs(threadId)).toEqual([
        expect.objectContaining(queued),
      ])
      expect(dispatch).not.toHaveBeenCalled()
      await h.tick()
      expect(ended).toHaveLength(1)
    } finally {
      releaseRead.release()
      await pass
      await closing
      await h.close()
    }
  })

  it('disarms the interval and rejects a captured tick after the store closes', async () => {
    const h = await harness()
    try {
      const reads = vi.spyOn(h.store.superagent, 'listPendingTurns')
      const clear = vi.spyOn(globalThis, 'clearInterval')
      await h.tick()
      expect(reads).toHaveBeenCalledTimes(1)
      await h.sa.dispose()
      await h.sa.dispose()
      expect(clear).toHaveBeenCalledWith(h.interval)
      await h.store.close()
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(h.tick()).resolves.toBeUndefined()
      expect(reads).toHaveBeenCalledTimes(1)
    } finally {
      await h.close()
    }
  })

  it('reports a failed periodic read once and allows the next pass', async () => {
    const h = await harness()
    const records: LogRecord[] = []
    const removeSink = addSink({
      name: 'reaper-shutdown-test',
      minLevel: 'trace',
      write: (r) => {
        records.push(r)
      },
    })
    try {
      const failure = new Error('pending-turn read failed')
      const reads = vi.spyOn(h.store.superagent, 'listPendingTurns').mockRejectedValueOnce(failure)
      await expect(h.tick()).resolves.toBeUndefined()
      expect(records).toEqual([
        expect.objectContaining({
          level: 'error',
          err: expect.objectContaining({ name: 'Error', message: failure.message }),
        }),
      ])
      await h.tick()
      expect(reads).toHaveBeenCalledTimes(2)
      await h.sa.dispose()
      expect(records).toHaveLength(1)
    } finally {
      removeSink()
      await h.close()
    }
  })
})
