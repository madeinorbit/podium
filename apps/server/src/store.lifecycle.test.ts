import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import type { SnapshotVerifierDeps } from './migrations/snapshot-verifier'
import { type Barrier, barrier, settle } from './store/executor/harness'
import { openTestStore } from './test-support/open-test-store'

/** A child that parks until the test releases it, and dies when the verifier aborts. */
function parkedChild(
  parked: Barrier,
  entered: Barrier,
): NonNullable<SnapshotVerifierDeps['runChild']> {
  return async (request, _timeoutMs, signal) => {
    entered.release()
    if (signal.aborted) {
      return { failure: { code: 'cancelled', detail: 'the verifier was shut down' } }
    }
    await Promise.race([
      parked.wait(),
      new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      }),
    ])
    if (signal.aborted) {
      return { failure: { code: 'cancelled', detail: 'the verifier was shut down' } }
    }
    return {
      result: { ok: true, correlationId: request.correlationId, bytes: 1, durationMs: 1 },
    }
  }
}

async function notBlocked<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const blocked = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} waited on exclusive; the proof must not hold it`)),
      1_000,
    )
  })
  try {
    return await Promise.race([work, blocked])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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

describe('snapshot proof stays off the exclusive lane (rule 67)', () => {
  it('serves store writes while a parked server-replacement proof runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod3557-proof-'))
    const parked = barrier()
    const entered = barrier()
    const store = await openTestStore(join(dir, 'store.db'), undefined, {
      runChild: parkedChild(parked, entered),
    })
    try {
      const proof = store.verifiedSnapshotBeforeUpdate('before', 'after')
      await entered.wait()
      await notBlocked(
        store.repos.addRepo('/during-proof', store.hostMachineId),
        'addRepo during verifiedSnapshotBeforeUpdate',
      )
      expect(await store.repos.listRepoPaths()).toEqual(['/during-proof'])
      parked.release()
      await expect(proof).resolves.toMatchObject({ ok: true })
    } finally {
      parked.release()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves store writes while a parked background boot proof runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod3557-boot-'))
    const parked = barrier()
    const entered = barrier()
    const store = await openTestStore(join(dir, 'store.db'), undefined, {
      runChild: parkedChild(parked, entered),
      schedule: (fn) => fn(),
    })
    try {
      expect(await store.snapshotBeforeUpdate('before', 'after')).toBeDefined()
      expect(store.discoverDatabaseSnapshots()).toBe(true)
      await entered.wait()
      await notBlocked(
        store.repos.addRepo('/during-boot-proof', store.hostMachineId),
        'addRepo during background verification',
      )
      expect(await store.repos.listRepoPaths()).toEqual(['/during-boot-proof'])
      parked.release()
    } finally {
      parked.release()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('close aborts a parked proof without taking exclusive for the scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod3557-close-'))
    const parked = barrier()
    const entered = barrier()
    const store = await openTestStore(join(dir, 'store.db'), undefined, {
      runChild: parkedChild(parked, entered),
    })
    let closed = false
    try {
      const proof = store.verifiedSnapshotBeforeUpdate('before', 'after')
      await entered.wait()
      await notBlocked(store.close(), 'close while a proof is parked')
      closed = true
      await expect(proof).resolves.toMatchObject({ ok: false, code: 'cancelled' })
    } finally {
      parked.release()
      if (!closed) await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
