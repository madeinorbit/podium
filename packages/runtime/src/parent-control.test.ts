import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearParentRequest,
  readParentRequest,
  readParentResult,
  requestParentHandover,
  requestParentSwap,
  writeParentRequest,
  writeParentResult,
} from './parent-control'
import { writeRecord } from './run-registry'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-parent-ctl-'))
  roots.push(dir)
  mkdirSync(join(dir, 'run'), { recursive: true })
  return dir
}

describe('parent-control request file', () => {
  it('round-trips a swap request, target and pin included', () => {
    const dir = tempState()
    writeParentRequest(
      {
        requestId: 'r1',
        kind: 'swap',
        expectedVersion: '1.2.3',
        requestedAt: '2026-08-21T00:00:00.000Z',
        target: { version: '1.2.3' },
        pinnedPubkey: 'PUB',
      },
      dir,
    )
    expect(readParentRequest(dir)).toEqual({
      requestId: 'r1',
      kind: 'swap',
      expectedVersion: '1.2.3',
      requestedAt: '2026-08-21T00:00:00.000Z',
      target: { version: '1.2.3' },
      pinnedPubkey: 'PUB',
    })
    clearParentRequest(dir)
    expect(readParentRequest(dir)).toBeUndefined()
  })

  it('a result only answers the request it was written for', () => {
    const dir = tempState()
    writeParentResult(
      { requestId: 'r1', kind: 'swap', ok: true, completedAt: '2026-08-21T00:00:01.000Z' },
      dir,
    )
    expect(readParentResult('r1', dir)?.ok).toBe(true)
    expect(readParentResult('r2', dir), 'a stale result is not this ask').toBeUndefined()
  })

  it('writing a new request clears the previous answer', () => {
    const dir = tempState()
    writeParentResult(
      { requestId: 'r1', kind: 'swap', ok: true, completedAt: '2026-08-21T00:00:01.000Z' },
      dir,
    )
    writeParentRequest(
      {
        requestId: 'r2',
        kind: 'swap',
        expectedVersion: '2.0.0',
        requestedAt: '2026-08-21T00:00:02.000Z',
      },
      dir,
    )
    expect(readParentResult('r1', dir)).toBeUndefined()
  })
})

describe('requestParentHandover', () => {
  it('signals the live parent and refuses when none is registered', () => {
    const dir = tempState()
    const prev = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = dir
    try {
      const signaled: Array<{ pid: number; signal: string | undefined }> = []
      expect(
        requestParentHandover(
          { expectedVersion: '9.9.9' },
          { stateDir: dir, signal: (pid, signal) => signaled.push({ pid, signal }) },
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
        { expectedVersion: '9.9.9', releaseHadMigrations: false },
        { stateDir: dir, signal: (pid, signal) => signaled.push({ pid, signal }) },
      )
      expect(result).toEqual({ ok: true, pid: process.pid })
      expect(signaled).toEqual([{ pid: process.pid, signal: 'SIGUSR1' }])
      const written = readParentRequest(dir)
      expect(written?.kind).toBe('handover')
      expect(written?.expectedVersion).toBe('9.9.9')
      expect(written?.releaseHadMigrations).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prev
    }
  })
})

describe('requestParentSwap', () => {
  it('resolves with the parent answer and surfaces its failure sentence', async () => {
    const dir = tempState()
    const prev = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = dir
    try {
      writeRecord({
        role: 'parent',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        mode: 'systemd',
      })
      // The "parent" answers on the first poll.
      const answerWith = (result: { ok: boolean; error?: string; migrations?: boolean }) => {
        const request = readParentRequest(dir)
        writeParentResult(
          {
            requestId: request?.requestId ?? 'missing',
            kind: 'swap',
            ok: result.ok,
            ...(result.error ? { error: result.error } : {}),
            ...(result.migrations !== undefined ? { releaseHadMigrations: result.migrations } : {}),
            completedAt: new Date().toISOString(),
          },
          dir,
        )
      }

      const ok = requestParentSwap(
        { expectedVersion: '2.0.0', target: { version: '2.0.0' }, pinnedPubkey: 'PUB' },
        {
          stateDir: dir,
          signal: () => answerWith({ ok: true, migrations: true }),
          sleep: async () => {},
        },
      )
      await expect(ok).resolves.toEqual({ releaseHadMigrations: true })
      expect(readParentRequest(dir)?.pinnedPubkey).toBe('PUB')

      const failed = requestParentSwap(
        { expectedVersion: '3.0.0', target: { version: '3.0.0' } },
        {
          stateDir: dir,
          signal: () => answerWith({ ok: false, error: 'cannot converge: schema-advanced — …' }),
          sleep: async () => {},
        },
      )
      await expect(failed).rejects.toThrow(/schema-advanced/)
    } finally {
      if (prev === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prev
    }
  })

  it('refuses with machine-cannot-restart when no parent is registered', async () => {
    const dir = tempState()
    const prev = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = dir
    try {
      await expect(
        requestParentSwap(
          { expectedVersion: '2.0.0', target: { version: '2.0.0' } },
          { stateDir: dir, signal: () => {}, sleep: async () => {} },
        ),
      ).rejects.toThrow(/machine-cannot-restart/)
    } finally {
      if (prev === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prev
    }
  })
})
