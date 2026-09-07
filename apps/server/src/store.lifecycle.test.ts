import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { barrier, settle } from './store/executor/harness'
import { openTestStore } from './test-support/open-test-store'

describe('store file operations behind transactions', () => {
  it('stages the update snapshot only after the parked transaction commits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod3264-snapshot-'))
    const store = await openTestStore(join(dir, 'store.db'))
    const held = barrier()
    const entered = barrier()
    try {
      const write = store.transact(async () => {
        await store.repos.addRepo('/snapshot/committed', store.hostMachineId)
        entered.release()
        await held.wait()
      })
      await entered.wait()
      let staged = false
      const snapshot = store.snapshotBeforeUpdate('before', 'after').then((path) => {
        staged = true
        return path
      })
      await settle()
      expect(staged).toBe(false)
      held.release()
      await write
      const path = await snapshot
      expect(path).toBeDefined()
      const copy = openDatabase(path!, { readOnly: true })
      try {
        expect(copy.prepare('SELECT path FROM repos').all()).toEqual([
          { path: '/snapshot/committed' },
        ])
      } finally {
        copy.close()
      }
    } finally {
      held.release()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('takes the in-process transfer fence after a parked transaction, then refuses writes', async () => {
    const store = await openTestStore(':memory:')
    const held = barrier()
    const entered = barrier()
    try {
      const write = store.transact(async () => {
        await store.repos.addRepo('/fence/committed', store.hostMachineId)
        entered.release()
        await held.wait()
      })
      await entered.wait()
      let fenced = false
      const fence = store.beginTransferFence().then(() => {
        fenced = true
      })
      await settle()
      expect(fenced).toBe(false)
      held.release()
      await Promise.all([write, fence])
      await expect(
        store.repos.addRepo('/fence/refused', store.hostMachineId).catch((error: unknown) => {
          let cause = error
          while (cause instanceof Error && cause.cause !== undefined) cause = cause.cause
          throw cause
        }),
      ).rejects.toThrow(/readonly/i)
      await store.endTransferFence()
      await store.repos.addRepo('/fence/reopened', store.hostMachineId)
      expect(await store.repos.listRepoPaths()).toEqual(['/fence/committed', '/fence/reopened'])
    } finally {
      held.release()
      await store.close()
    }
  })
})
