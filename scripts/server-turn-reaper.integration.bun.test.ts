import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeError } from '@podium/logger'
import { SuperagentService } from '../apps/server/src/modules/superagent'
import { type ServerHandle, startServer } from '../apps/server/src/server'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('normal server turn-reaper shutdown', () => {
  it('settles a timer read outside shutdown scope before scheduler drain and reopens cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-reaper-close-'))
    const priorStateDir = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = dir
    let handle: ServerHandle | undefined
    let closing: Promise<void> | undefined
    let pass: Promise<void> | undefined
    const readEntered = barrier()
    const releaseRead = barrier()
    const quiescing = barrier()
    const draining = barrier()
    const releasePersist = barrier()
    const intervals = spyOn(globalThis, 'setInterval')
    const create = SuperagentService.create
    let tick!: () => Promise<void>
    const createSpy = spyOn(SuperagentService, 'create').mockImplementation(async (...args) => {
      const firstInterval = intervals.mock.calls.length
      const service = await create(...args)
      tick = intervals.mock.calls[firstInterval]?.[0] as () => Promise<void>
      return service
    })
    const restore: Array<() => void> = []
    try {
      // Normal server and real janitor, no daemon, model turn or retained profile.
      handle = await startServer({ port: 0 })
      createSpy.mockRestore()
      intervals.mockRestore()
      expect((await fetch(`http://127.0.0.1:${handle.port}/health`)).status).toBe(200)
      const store = handle.registry.sessionStore
      const read = store.superagent.listPendingTurns.bind(store.superagent)
      const readSpy = spyOn(store.superagent, 'listPendingTurns').mockImplementationOnce(
        async () => {
          readEntered.release()
          await releaseRead.promise
          return await read()
        },
      )
      restore.push(() => readSpy.mockRestore())
      const dispose = SuperagentService.prototype.dispose
      const disposeSpy = spyOn(SuperagentService.prototype, 'dispose').mockImplementation(function (
        this: SuperagentService,
      ) {
        quiescing.release()
        return dispose.call(this)
      })
      restore.push(() => disposeSpy.mockRestore())
      const close = store.close.bind(store)
      const closeSpy = spyOn(store, 'close').mockImplementation(async (persist) => {
        await close(async () => {
          // Keep the scheduler observably draining on the unfixed baseline.
          draining.release()
          await releasePersist.promise
          await persist?.()
        })
      })
      restore.push(() => closeSpy.mockRestore())
      const errors: unknown[] = []
      pass = Promise.resolve(tick()).catch((error: unknown) => {
        errors.push(error)
      })
      await readEntered.promise
      const firstBoundary = Promise.race([
        quiescing.promise.then(() => 'quiescing'),
        draining.promise.then(() => 'draining'),
      ])
      closing = handle.close()
      const boundary = await firstBoundary
      releaseRead.release()
      await pass
      releasePersist.release()
      await closing
      handle = undefined
      // Assert the actual query outcome first: baseline evidence retains the
      // DrizzleQueryError -> SchedulerClosedError: scheduler is draining cause.
      expect(errors.map((error) => serializeError(error))).toEqual([])
      expect(boundary).toBe('quiescing')
      const readsAtClose = readSpy.mock.calls.length
      await Promise.resolve(tick())
      expect(readSpy.mock.calls.length).toBe(readsAtClose)
      for (const undo of restore.splice(0)) undo()
      handle = await startServer({ port: 0 })
      expect((await fetch(`http://127.0.0.1:${handle.port}/health`)).status).toBe(200)
      await handle.close()
      handle = undefined
    } finally {
      releaseRead.release()
      releasePersist.release()
      await pass
      await closing
      for (const undo of restore) undo()
      createSpy.mockRestore()
      intervals.mockRestore()
      await handle?.close()
      if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = priorStateDir
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
