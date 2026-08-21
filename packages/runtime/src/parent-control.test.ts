import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearHandoverRequest,
  readHandoverRequest,
  requestParentHandover,
  writeHandoverRequest,
} from './parent-control'
import { writeRecord } from './run-registry'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('parent-control handover request', () => {
  it('round-trips the request file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-parent-ctl-'))
    roots.push(dir)
    writeHandoverRequest(
      {
        expectedVersion: '1.2.3',
        performSwap: true,
        releaseHadMigrations: false,
        requestedAt: '2026-08-21T00:00:00.000Z',
      },
      dir,
    )
    expect(readHandoverRequest(dir)).toEqual({
      expectedVersion: '1.2.3',
      performSwap: true,
      releaseHadMigrations: false,
      requestedAt: '2026-08-21T00:00:00.000Z',
    })
    clearHandoverRequest(dir)
    expect(readHandoverRequest(dir)).toBeUndefined()
  })

  it('signals the live parent and refuses when none is registered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-parent-ctl-'))
    roots.push(dir)
    mkdirSync(join(dir, 'run'), { recursive: true })
    const prev = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = dir
    try {
      const signaled: Array<{ pid: number; signal: string | undefined }> = []
      expect(
        requestParentHandover(
          { expectedVersion: '9.9.9' },
          {
            stateDir: dir,
            signal: (pid, signal) => signaled.push({ pid, signal }),
          },
        ),
      ).toEqual({ ok: false, reason: 'no-parent' })

      // Use this process's PID so liveRecord's isAlive check succeeds.
      writeRecord({
        role: 'parent',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        mode: 'systemd',
      })
      const result = requestParentHandover(
        { expectedVersion: '9.9.9', performSwap: false },
        {
          stateDir: dir,
          signal: (pid, signal) => signaled.push({ pid, signal }),
        },
      )
      expect(result).toEqual({ ok: true, pid: process.pid })
      expect(signaled).toEqual([{ pid: process.pid, signal: 'SIGUSR1' }])
      expect(readHandoverRequest(dir)?.expectedVersion).toBe('9.9.9')
    } finally {
      if (prev === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prev
    }
  })
})
