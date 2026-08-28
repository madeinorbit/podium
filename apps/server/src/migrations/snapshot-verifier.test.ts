/**
 * The verifier boundary (POD-3068).
 *
 * Two halves are proved separately: the expensive check itself, against real
 * SQLite files, and the orchestrator around it — deadline, kill, correlation,
 * publication, retention — against an injected child so no test spawns a
 * process or waits on a real timeout.
 */

import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readSnapshotCatalogue,
  type SnapshotIdentity,
  snapshotIdentity,
  writeSnapshotCatalogue,
} from './snapshot-catalogue'
import { verifySnapshotFile } from './snapshot-verification'
import {
  type SnapshotChildOutcome,
  SnapshotVerifier,
  spawnSnapshotVerifierChild,
} from './snapshot-verifier'
import {
  runSnapshotVerifierChildIfRequested,
  SNAPSHOT_VERIFIER_ENV,
} from './snapshot-verifier-child'

const tempDirs: string[] = []

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-snapshot-verifier-'))
  tempDirs.push(dir)
  return dir
}

/** A real, valid SQLite file to verify. */
function sqliteFile(dir: string, name: string): string {
  const path = join(dir, name)
  const db = openDatabase(path)
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES ('x');")
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
  return path
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('verifySnapshotFile', () => {
  it('verifies a real snapshot and reports its size and schema identity', () => {
    const dir = tmpDir()
    const path = sqliteFile(dir, 'snapshot.db')
    const expected = snapshotIdentity(path) as SnapshotIdentity

    const result = verifySnapshotFile({ path, expected, correlationId: 'corr' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a verified snapshot')
    expect(result.correlationId).toBe('corr')
    expect(result.bytes).toBe(statSync(path).size)
  })

  it('reports corruption rather than throwing', () => {
    const dir = tmpDir()
    const path = join(dir, 'snapshot.db')
    writeFileSync(path, 'this is definitely not a sqlite database')
    const expected = snapshotIdentity(path) as SnapshotIdentity

    const result = verifySnapshotFile({ path, expected, correlationId: 'corr' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a rejection')
    expect(['corrupt', 'unreadable']).toContain(result.code)
  })

  it('reports a missing and an empty input distinctly', () => {
    const dir = tmpDir()
    const missing = join(dir, 'gone.db')
    const empty = join(dir, 'empty.db')
    writeFileSync(empty, '')
    const identity = { path: empty, size: 0, mtimeMs: 0, sidecars: '' }

    const gone = verifySnapshotFile({ path: missing, expected: identity, correlationId: 'c' })
    const blank = verifySnapshotFile({ path: empty, expected: identity, correlationId: 'c' })

    expect(gone.ok === false && gone.code).toBe('missing')
    expect(blank.ok === false && blank.code).toBe('empty')
  })

  it('refuses a candidate whose identity moved on since it was staged', () => {
    const dir = tmpDir()
    const path = sqliteFile(dir, 'snapshot.db')
    const expected = snapshotIdentity(path) as SnapshotIdentity
    const older = new Date(Date.now() - 60_000)
    utimesSync(path, older, older)

    const result = verifySnapshotFile({ path, expected, correlationId: 'corr' })

    expect(result.ok === false && result.code).toBe('identity-mismatch')
  })

  it('refuses a snapshot that does not carry the expected migration identity', () => {
    const dir = tmpDir()
    const path = sqliteFile(dir, 'snapshot.db')
    const expected = snapshotIdentity(path) as SnapshotIdentity

    const result = verifySnapshotFile({
      path,
      expected,
      correlationId: 'corr',
      expectedSchemaVersion: '9999_a_migration_this_file_never_had',
    })

    expect(result.ok === false && result.code).toBe('schema-mismatch')
  })
})

describe('the child entry', () => {
  it('runs only when the request environment variable is present', async () => {
    const lines: string[] = []

    expect(await runSnapshotVerifierChildIfRequested({}, (line) => lines.push(line))).toBe(false)
    expect(lines).toEqual([])
  })

  it('prints one JSON verdict for the requested snapshot', async () => {
    const dir = tmpDir()
    const path = sqliteFile(dir, 'snapshot.db')
    const request = {
      path,
      expected: snapshotIdentity(path) as SnapshotIdentity,
      correlationId: 'corr-1',
    }
    const lines: string[] = []

    const ran = await runSnapshotVerifierChildIfRequested(
      { [SNAPSHOT_VERIFIER_ENV]: JSON.stringify(request) },
      (line) => lines.push(line),
    )

    expect(ran).toBe(true)
    expect(JSON.parse(lines.join(''))).toMatchObject({ ok: true, correlationId: 'corr-1' })
  })
})

describe('spawnSnapshotVerifierChild', () => {
  function fakeChild() {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const listeners = {
      stdout: [] as Array<(chunk: Buffer) => void>,
      stderr: [] as Array<(chunk: Buffer) => void>,
    }
    return {
      kills: [] as Array<string | undefined>,
      handlers,
      listeners,
      child: {
        stdout: { on: (_: string, fn: (chunk: Buffer) => void) => listeners.stdout.push(fn) },
        stderr: { on: (_: string, fn: (chunk: Buffer) => void) => listeners.stderr.push(fn) },
        once: (event: string, fn: (...args: unknown[]) => void) => handlers.set(event, fn),
        kill: (signal?: string) => {},
      },
    }
  }

  it('passes the request through the environment, never through argv', async () => {
    const spawned = fakeChild()
    const spawnProcess = vi.fn(() => spawned.child)
    const request = {
      path: '/state/podium.db.backup-va',
      expected: { path: '/state/podium.db.backup-va', size: 1, mtimeMs: 2, sidecars: '' },
      correlationId: 'corr',
    }

    const pending = spawnSnapshotVerifierChild(request, 1_000, {
      spawnProcess: spawnProcess as never,
      execPath: '/usr/bin/podium',
      compiled: true,
    })
    spawned.listeners.stdout[0]?.(
      Buffer.from(
        `${JSON.stringify({ ok: true, correlationId: 'corr', bytes: 1, durationMs: 1 })}\n`,
      ),
    )
    spawned.handlers.get('close')?.(0, null)

    await expect(pending).resolves.toMatchObject({ result: { ok: true, correlationId: 'corr' } })
    const [, args, options] = spawnProcess.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ]
    expect(args.join(' ')).not.toContain('/state/podium.db')
    expect(JSON.parse(options.env[SNAPSHOT_VERIFIER_ENV] as string)).toEqual(request)
  })

  it('reports a non-zero exit as a child failure, not as a bad snapshot', async () => {
    const spawned = fakeChild()
    const pending = spawnSnapshotVerifierChild(
      {
        path: '/state/a',
        expected: { path: '/state/a', size: 1, mtimeMs: 2, sidecars: '' },
        correlationId: 'corr',
      },
      1_000,
      { spawnProcess: (() => spawned.child) as never, compiled: true },
    )
    spawned.listeners.stderr[0]?.(Buffer.from('boom'))
    spawned.handlers.get('close')?.(1, null)

    const outcome = (await pending) as SnapshotChildOutcome
    expect(outcome.result).toBeUndefined()
    expect(outcome.failure?.code).toBe('crashed')
    expect(outcome.failure?.detail).toContain('boom')
  })

  it('SIGTERMs at the deadline and SIGKILLs a child that ignores it', async () => {
    vi.useFakeTimers()
    try {
      const spawned = fakeChild()
      const kills: Array<string | undefined> = []
      spawned.child.kill = (signal?: string) => {
        kills.push(signal)
      }

      const pending = spawnSnapshotVerifierChild(
        {
          path: '/state/a',
          expected: { path: '/state/a', size: 1, mtimeMs: 2, sidecars: '' },
          correlationId: 'corr',
        },
        1_000,
        { spawnProcess: (() => spawned.child) as never, compiled: true, killGraceMs: 500 },
      )

      await vi.advanceTimersByTimeAsync(1_000)
      expect(kills).toEqual(['SIGTERM'])
      // A `quick_check` mid-scan is inside a synchronous native call and does not
      // see SIGTERM. The grace window exists so it is killed, not left running.
      await vi.advanceTimersByTimeAsync(500)
      expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
      await expect(pending).resolves.toMatchObject({ failure: { code: 'timeout' } })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('spawnSnapshotVerifierChild cancellation', () => {
  it('SIGTERMs on abort and SIGKILLs a child that ignores it', async () => {
    vi.useFakeTimers()
    try {
      const handlers = new Map<string, (...args: unknown[]) => void>()
      const kills: Array<string | undefined> = []
      const child = {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        once: (event: string, fn: (...args: unknown[]) => void) => handlers.set(event, fn),
        kill: (signal?: string) => {
          kills.push(signal)
        },
      }
      const controller = new AbortController()

      const pending = spawnSnapshotVerifierChild(
        {
          path: '/state/a',
          expected: { path: '/state/a', size: 1, mtimeMs: 2, sidecars: '' },
          correlationId: 'corr',
        },
        600_000,
        {
          spawnProcess: (() => child) as never,
          compiled: true,
          killGraceMs: 500,
          signal: controller.signal,
        },
      )

      controller.abort()
      expect(kills).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(500)
      expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
      await expect(pending).resolves.toMatchObject({ failure: { code: 'cancelled' } })
      void handlers
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SnapshotVerifier', () => {
  function verifierOver(
    dir: string,
    runChild: (request: { path: string; correlationId: string }) => Promise<SnapshotChildOutcome>,
    extra: { keep?: number; schedule?: (fn: () => void) => void } = {},
  ): { dbPath: string; verifier: SnapshotVerifier } {
    const dbPath = join(dir, 'podium.db')
    const verifier = new SnapshotVerifier(dbPath, {
      runChild: (request) => runChild(request),
      schedule: extra.schedule ?? ((fn) => fn()),
      ...(extra.keep !== undefined ? { keep: extra.keep } : {}),
    })
    return { dbPath, verifier }
  }

  it('publishes a verified record only after the child succeeds', async () => {
    const dir = tmpDir()
    const snapshot = sqliteFile(dir, 'podium.db.backup-va')
    const { dbPath, verifier } = verifierOver(dir, async (request) => ({
      result: {
        ok: true,
        correlationId: request.correlationId,
        schemaVersion: '0001_init',
        bytes: 10,
        durationMs: 1,
      },
    }))

    // Nothing is advertised before the proof exists.
    expect(verifier.verifiedFallbackPath()).toBeUndefined()

    const outcome = await verifier.verify(snapshot)

    expect(outcome).toMatchObject({ ok: true, path: snapshot })
    expect(verifier.verifiedFallbackPath()).toBe(snapshot)
    expect(readSnapshotCatalogue(dbPath)[0]).toMatchObject({
      outcome: 'verified',
      schemaVersion: '0001_init',
    })
  })

  it('records a corrupt snapshot as invalid and keeps the file for forensics', async () => {
    const dir = tmpDir()
    const snapshot = join(dir, 'podium.db.backup-va')
    writeFileSync(snapshot, 'not sqlite')
    const { dbPath, verifier } = verifierOver(dir, async (request) => ({
      result: {
        ok: false,
        correlationId: request.correlationId,
        code: 'corrupt',
        detail: 'quick_check answered *** in database main ***',
        durationMs: 1,
      },
    }))

    const outcome = await verifier.verify(snapshot)

    expect(outcome).toMatchObject({ ok: false, code: 'corrupt' })
    expect(verifier.verifiedFallbackPath()).toBeUndefined()
    expect(readSnapshotCatalogue(dbPath)[0]).toMatchObject({ outcome: 'invalid' })
    expect(statSync(snapshot).size).toBeGreaterThan(0)
  })

  it('records a crashed or timed-out child as failed, which condemns nothing', async () => {
    const dir = tmpDir()
    const snapshot = sqliteFile(dir, 'podium.db.backup-va')
    const { dbPath, verifier } = verifierOver(dir, async () => ({
      failure: { code: 'timeout', detail: 'no result within 600000ms' },
    }))

    const outcome = await verifier.verify(snapshot)

    expect(outcome).toMatchObject({ ok: false, code: 'timeout' })
    // `failed` says UNPROVED, not BAD: the record exists, the file stays, and
    // nothing advertises it.
    expect(readSnapshotCatalogue(dbPath)[0]).toMatchObject({ outcome: 'failed' })
    expect(readSnapshotCatalogue(dbPath)[0]?.diagnostic).toContain('600000ms')
    expect(verifier.verifiedFallbackPath()).toBeUndefined()
  })

  it('drops a result that names a different run', async () => {
    const dir = tmpDir()
    const snapshot = sqliteFile(dir, 'podium.db.backup-va')
    const { dbPath, verifier } = verifierOver(dir, async () => ({
      result: {
        ok: true,
        correlationId: 'a-run-that-was-never-launched',
        bytes: 10,
        durationMs: 1,
      },
    }))

    const outcome = await verifier.verify(snapshot)

    expect(outcome).toMatchObject({ ok: false, code: 'superseded' })
    expect(verifier.verifiedFallbackPath()).toBeUndefined()
    expect(readSnapshotCatalogue(dbPath)[0]?.outcome).toBe('pending')
  })

  it('drops a late result for a candidate the file no longer matches', async () => {
    const dir = tmpDir()
    const snapshot = sqliteFile(dir, 'podium.db.backup-va')
    const { verifier } = verifierOver(dir, async (request) => {
      // The snapshot is replaced WHILE the child is scanning the old bytes.
      writeFileSync(snapshot, 'a completely different file with a different length')
      const older = new Date(Date.now() + 60_000)
      utimesSync(snapshot, older, older)
      return {
        result: { ok: true, correlationId: request.correlationId, bytes: 10, durationMs: 1 },
      }
    })

    const outcome = await verifier.verify(snapshot)

    expect(outcome).toMatchObject({ ok: false, code: 'superseded' })
    expect(verifier.verifiedFallbackPath()).toBeUndefined()
  })

  it('runs one verification at a time', async () => {
    const dir = tmpDir()
    const first = sqliteFile(dir, 'podium.db.backup-va')
    const second = sqliteFile(dir, 'podium.db.backup-vb')
    let live = 0
    let peak = 0
    const { verifier } = verifierOver(dir, async (request) => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 0))
      live -= 1
      return {
        result: { ok: true, correlationId: request.correlationId, bytes: 1, durationMs: 1 },
      }
    })

    await Promise.all([verifier.verify(first), verifier.verify(second)])

    expect(peak).toBe(1)
  })

  it('recovers after a restart: a pending record queues exactly one background run', async () => {
    const dir = tmpDir()
    const snapshot = sqliteFile(dir, 'podium.db.backup-va')
    const runs: string[] = []
    const { dbPath, verifier } = verifierOver(dir, async (request) => {
      runs.push(request.path)
      return {
        result: { ok: true, correlationId: request.correlationId, bytes: 1, durationMs: 1 },
      }
    })
    // What a process that died mid-verification leaves behind.
    writeSnapshotCatalogue(dbPath, [
      {
        ...(snapshotIdentity(snapshot) as SnapshotIdentity),
        outcome: 'pending',
        correlationId: 'a-dead-process',
        recordedAtMs: 1,
      },
    ])

    expect(verifier.verifiedFallbackPath()).toBeUndefined()
    expect(verifier.queueBackgroundVerification()).toBe(true)
    // A second ask while the first is in flight starts nothing more.
    expect(verifier.queueBackgroundVerification()).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(runs).toEqual([snapshot])
    expect(verifier.verifiedFallbackPath()).toBe(snapshot)
  })

  it('queues nothing when every record is decided and unchanged', async () => {
    const dir = tmpDir()
    const snapshot = sqliteFile(dir, 'podium.db.backup-va')
    const { dbPath, verifier } = verifierOver(dir, async () => ({
      failure: { code: 'crashed', detail: 'should never run' },
    }))
    writeSnapshotCatalogue(dbPath, [
      {
        ...(snapshotIdentity(snapshot) as SnapshotIdentity),
        outcome: 'verified',
        correlationId: 'corr',
        recordedAtMs: 1,
      },
    ])

    expect(verifier.queueBackgroundVerification()).toBe(false)
  })

  it('discovers a 0.1.0 state dir that has backups and no catalogue at all', async () => {
    // Exactly what an installation upgrading INTO the verifier looks like:
    // retained `<db>.backup-v*` files, written by an older build or by the boot
    // migration, and no `<db>.snapshots.json` anywhere.
    const dir = tmpDir()
    const older = sqliteFile(dir, 'podium.db.backup-vdrizzle-11-2026-08-01T00-00-00-000Z')
    const newer = sqliteFile(dir, 'podium.db.backup-vdrizzle-12-2026-08-02T00-00-00-000Z')
    const stamp = (path: string, when: string) => {
      const at = new Date(when)
      utimesSync(path, at, at)
    }
    stamp(older, '2026-08-01T00:00:00.000Z')
    stamp(newer, '2026-08-02T00:00:00.000Z')
    const runs: string[] = []
    const { dbPath, verifier } = verifierOver(dir, async (request) => {
      runs.push(request.path)
      return {
        result: { ok: true, correlationId: request.correlationId, bytes: 1, durationMs: 1 },
      }
    })

    expect(readSnapshotCatalogue(dbPath)).toEqual([])
    // The cheap read alone starts NOTHING — this is what update planning calls.
    expect(verifier.verifiedFallbackPath()).toBeUndefined()
    expect(runs).toEqual([])

    // Boot is what discovers them, and it takes the NEWEST first.
    expect(verifier.discoverAndQueue()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(runs).toEqual([newer])
    expect(verifier.verifiedFallbackPath()).toBe(newer)
    expect(
      readSnapshotCatalogue(dbPath)
        .map((row) => row.path)
        .sort(),
    ).toEqual([newer, older].sort())
  })

  it('dates a discovered legacy record by the file, not by the discovery', async () => {
    const dir = tmpDir()
    const legacy = sqliteFile(dir, 'podium.db.backup-vdrizzle-9-2026-01-01T00-00-00-000Z')
    const at = new Date('2026-01-01T00:00:00.000Z')
    utimesSync(legacy, at, at)
    // The background run is queued but never released, so the assertion below
    // sees the SEEDED record rather than the verification's own.
    const { dbPath, verifier } = verifierOver(
      dir,
      async () => ({ failure: { code: 'crashed', detail: 'not reached' } }),
      { schedule: () => {} },
    )

    verifier.discoverAndQueue()

    // A pre-existing snapshot is as old as it is; if discovery restamped it,
    // it would outrank every newer candidate in retention forever.
    expect(readSnapshotCatalogue(dbPath)[0]?.recordedAtMs).toBe(at.getTime())
  })

  it('kills the in-flight child when the verifier is closed', async () => {
    const dir = tmpDir()
    const snapshot = sqliteFile(dir, 'podium.db.backup-va')
    let observed: AbortSignal | undefined
    const dbPath = join(dir, 'podium.db')
    const verifier = new SnapshotVerifier(dbPath, {
      runChild: (_request, _timeoutMs, signal) =>
        new Promise((resolve) => {
          observed = signal
          // Stands in for the real child: it answers only when told to stop.
          signal.addEventListener('abort', () =>
            resolve({ failure: { code: 'cancelled', detail: 'the verifier was shut down' } }),
          )
        }),
    })

    const verification = verifier.verify(snapshot)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(observed?.aborted).toBe(false)

    // A flag flip would leave a multi-minute quick_check running past shutdown.
    verifier.close()

    expect(observed?.aborted).toBe(true)
    await expect(verification).resolves.toMatchObject({ ok: false, code: 'cancelled' })
  })

  it('keeps the catalogue finite without dropping the record in use', async () => {
    const dir = tmpDir()
    const proven = sqliteFile(dir, 'podium.db.backup-vproven')
    const { dbPath, verifier } = verifierOver(
      dir,
      async (request) => ({
        result: {
          ok: request.path === proven,
          correlationId: request.correlationId,
          ...(request.path === proven
            ? { bytes: 1, durationMs: 1 }
            : { code: 'corrupt' as const, detail: 'nope', durationMs: 1 }),
        } as never,
      }),
      { keep: 2 },
    )

    await verifier.verify(proven)
    for (const name of ['a', 'b', 'c']) {
      await verifier.verify(sqliteFile(dir, `podium.db.backup-v${name}`))
    }

    const records = readSnapshotCatalogue(dbPath)
    expect(records.length).toBeLessThanOrEqual(3)
    expect(records.some((row) => row.path === proven && row.outcome === 'verified')).toBe(true)
    expect(verifier.verifiedFallbackPath()).toBe(proven)
  })
})
