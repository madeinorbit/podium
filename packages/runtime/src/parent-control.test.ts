import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearParentRequest,
  type ParentControlLink,
  readParentRequest,
  readParentResult,
  registeredParentPid,
  requestParentHandover,
  requestParentSwap,
  requestParentTopology,
  setParentControlLink,
  signalParentTopology,
  supervisorLineOpen,
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
  it('round-trips a swap request, target, pin and publisher key included', () => {
    const dir = tempState()
    writeParentRequest(
      {
        requestId: 'r1',
        kind: 'swap',
        expectedVersion: '1.2.3',
        requestedAt: '2026-08-21T00:00:00.000Z',
        target: { version: '1.2.3' },
        pinnedPubkey: 'PUB',
        publisherPubkey: 'PUBLISHER',
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
      publisherPubkey: 'PUBLISHER',
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
  it('signals the live parent and refuses when none is registered', async () => {
    const dir = tempState()
    const prev = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = dir
    try {
      const signaled: Array<{ pid: number; signal: string | undefined }> = []
      await expect(
        requestParentHandover(
          { expectedVersion: '9.9.9' },
          { stateDir: dir, link: null, signal: (pid, signal) => signaled.push({ pid, signal }) },
        ),
      ).resolves.toEqual({ ok: false, reason: 'no-parent' })

      // Use this process's PID so liveRecord's isAlive check succeeds.
      writeRecord({
        role: 'parent',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        mode: 'systemd',
      })
      const result = await requestParentHandover(
        { expectedVersion: '9.9.9', releaseHadMigrations: false },
        { stateDir: dir, link: null, signal: (pid, signal) => signaled.push({ pid, signal }) },
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

describe('requestParentTopology', () => {
  it('writes the desired child set and waits for the parent health result', async () => {
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
      const pending = requestParentTopology(
        { children: ['daemon'], restartDaemon: true, health: 'daemon' },
        {
          stateDir: dir,
          link: null,
          signal: () => {
            const request = readParentRequest(dir)
            expect(request).toMatchObject({
              kind: 'topology',
              children: ['daemon'],
              restartDaemon: true,
              topologyHealth: 'daemon',
            })
            writeParentResult(
              {
                requestId: request?.requestId ?? 'missing',
                kind: 'topology',
                ok: true,
                completedAt: new Date().toISOString(),
              },
              dir,
            )
          },
          sleep: async () => {},
        },
      )
      await expect(pending).resolves.toBeUndefined()
      await expect(
        signalParentTopology(
          { children: ['server'], health: 'none' },
          { stateDir: dir, link: null, signal: () => {} },
        ),
      ).resolves.toMatchObject({ ok: true, pid: process.pid })
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
        {
          expectedVersion: '2.0.0',
          target: { version: '2.0.0' },
          pinnedPubkey: 'PUB',
          publisherPubkey: 'PUBLISHER',
        },
        {
          stateDir: dir,
          link: null,
          signal: () => answerWith({ ok: true, migrations: true }),
          sleep: async () => {},
        },
      )
      await expect(ok).resolves.toEqual({ releaseHadMigrations: true })
      expect(readParentRequest(dir)?.pinnedPubkey).toBe('PUB')
      expect(readParentRequest(dir)?.publisherPubkey).toBe('PUBLISHER')

      const failed = requestParentSwap(
        { expectedVersion: '3.0.0', target: { version: '3.0.0' } },
        {
          stateDir: dir,
          link: null,
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
          { stateDir: dir, link: null, signal: () => {}, sleep: async () => {} },
        ),
      ).rejects.toThrow(/machine-cannot-restart/)
    } finally {
      if (prev === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prev
    }
  })
})

/**
 * WHICH INLET, AND WHY IT IS NOT A FALLBACK (POD-3763).
 *
 * The guard these cases exist for: a child that HOLDS a line must never be able
 * to reach the file+signal inlet — not on a refused frame, not on a supervisor
 * that closed the line mid-ask, not on an answer it cannot read. A silent
 * downgrade there would put this process back to identifying its supervisor by a
 * pid on disk, which is the whole defect this epic removes (POD-2721/POD-3752),
 * and it would do it invisibly, on the rare path, in production.
 */
describe('a child that holds a line', () => {
  /** A registered parent AND a state dir, so the file inlet would work if reached. */
  function withFileInletAvailable<T>(body: (dir: string) => T): T {
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
      return body(dir)
    } finally {
      if (prev === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prev
    }
  }

  function brokenLink(reason: string): ParentControlLink {
    return {
      open: () => true,
      post: async () => {
        throw new Error(reason)
      },
      request: async () => {
        throw new Error(reason)
      },
    }
  }

  it('asks on the line, and writes no request file when it does', async () => {
    await withFileInletAvailable(async (dir) => {
      const asked: Array<[string, Record<string, unknown>]> = []
      const signals: number[] = []
      const link: ParentControlLink = {
        open: () => true,
        post: async () => {},
        request: async (requestId, request) => {
          asked.push([requestId, request])
          return {
            requestId,
            kind: 'swap',
            ok: true,
            releaseHadMigrations: true,
            completedAt: new Date().toISOString(),
          }
        },
      }

      await expect(
        requestParentSwap(
          { expectedVersion: '2.0.0', target: { version: '2.0.0' }, pinnedPubkey: 'PUB' },
          { stateDir: dir, link, signal: (pid) => signals.push(pid), sleep: async () => {} },
        ),
      ).resolves.toEqual({ releaseHadMigrations: true })

      expect(asked[0]?.[1]).toMatchObject({
        kind: 'swap',
        expectedVersion: '2.0.0',
        pinnedPubkey: 'PUB',
      })
      expect(readParentRequest(dir), 'the file inlet was not touched').toBeUndefined()
      expect(signals, 'no supervisor was signalled').toEqual([])
    })
  })

  it('surfaces a failed channel ask instead of writing a request file', async () => {
    await withFileInletAvailable(async (dir) => {
      const signals: number[] = []
      const opts = {
        stateDir: dir,
        link: brokenLink('the supervising parent closed the line before answering'),
        signal: (pid: number) => signals.push(pid),
        sleep: async () => {},
      }

      await expect(
        requestParentSwap({ expectedVersion: '2.0.0', target: { version: '2.0.0' } }, opts),
      ).rejects.toThrow(/closed the line before answering/)
      await expect(
        requestParentTopology({ children: ['server'], health: 'none' }, opts),
      ).rejects.toThrow(/closed the line before answering/)
      const handover = await requestParentHandover({ expectedVersion: '2.0.0' }, opts)
      expect(handover).toEqual({
        ok: false,
        reason: 'the supervising parent closed the line before answering',
      })
      const topology = await signalParentTopology({ children: ['server'], health: 'none' }, opts)
      expect(topology.ok).toBe(false)

      expect(readParentRequest(dir), 'no ask fell back to a request file').toBeUndefined()
      expect(signals, 'no ask fell back to a signal').toEqual([])
    })
  })

  it('treats an answer it cannot read as a failure, not as a reason to try files', async () => {
    await withFileInletAvailable(async (dir) => {
      const signals: number[] = []
      const link: ParentControlLink = {
        open: () => true,
        post: async () => {},
        request: async () => ({ nonsense: true }),
      }

      await expect(
        requestParentSwap(
          { expectedVersion: '2.0.0', target: { version: '2.0.0' } },
          { stateDir: dir, link, signal: (pid) => signals.push(pid), sleep: async () => {} },
        ),
      ).rejects.toThrow(/cannot read/)
      expect(readParentRequest(dir)).toBeUndefined()
      expect(signals).toEqual([])
    })
  })

  it('is not on the line once it is closed, so a channel-less caller keeps the file inlet', async () => {
    await withFileInletAvailable(async (dir) => {
      const closed: ParentControlLink = {
        open: () => false,
        post: async () => {
          throw new Error('must not be used')
        },
        request: async () => {
          throw new Error('must not be used')
        },
      }
      const signals: number[] = []
      const posted = await requestParentHandover(
        { expectedVersion: '2.0.0' },
        { stateDir: dir, link: closed, signal: (pid) => signals.push(pid) },
      )
      expect(posted).toEqual({ ok: true, pid: process.pid })
      expect(readParentRequest(dir)?.kind).toBe('handover')
      expect(signals).toEqual([process.pid])
    })
  })
})

describe('supervisorLineOpen', () => {
  it('is the supervised child question, and registeredParentPid the channel-less one', () => {
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
      // A registered pid does NOT mean this process holds a line...
      expect(registeredParentPid()).toBe(process.pid)
      expect(supervisorLineOpen()).toBe(false)

      setParentControlLink({
        open: () => true,
        post: async () => {},
        request: async () => ({}),
      })
      expect(supervisorLineOpen()).toBe(true)
      setParentControlLink(undefined)
      // ...and a line that has closed does not mean the pid record went away,
      // which is the POD-2721 hole: the record can vanish under a live parent.
      expect(supervisorLineOpen()).toBe(false)
    } finally {
      setParentControlLink(undefined)
      if (prev === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prev
    }
  })
})
