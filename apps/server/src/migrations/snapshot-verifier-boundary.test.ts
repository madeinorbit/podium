/**
 * The failure boundary POD-3068 exists to move.
 *
 * The Ludovico outage was not a restart: `updates.start` called planning
 * context, which called the snapshot scan, which opened three ~747 MiB retained
 * backups and ran `PRAGMA quick_check` on the event-loop thread. `updates.start`
 * took ~79.9 seconds and nothing else was served for the duration.
 *
 * These tests assert the boundary directly: the read a request performs stays
 * bounded while a deliberately slow verification is in flight, and an unrelated
 * request completes during it.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../store'
import {
  type SnapshotIdentity,
  snapshotIdentity,
  writeSnapshotCatalogue,
} from './snapshot-catalogue'
import { SnapshotVerifier, type SnapshotVerifierDeps } from './snapshot-verifier'

const tempDirs: string[] = []

/**
 * The verifier child is stubbed out everywhere below: these tests are about the
 * READ path's cost, and a store that could spawn a real scanner mid-assertion
 * would be measuring the harness rather than the boundary.
 */
function tmpStore(runChild?: SnapshotVerifierDeps['runChild']): {
  store: SessionStore
  dbPath: string
  dir: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'podium-snapshot-boundary-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'podium.db')
  const deps: SnapshotVerifierDeps = {
    runChild:
      runChild ?? (async () => ({ failure: { code: 'crashed', detail: 'no child in this test' } })),
  }
  return { store: new SessionStore(dbPath, undefined, deps), dbPath, dir }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('planning reads never scan the retained backups', () => {
  it('answers latestDatabaseSnapshot in bounded time with a staged snapshot present', () => {
    const { store, dbPath } = tmpStore()
    // A real staged snapshot of a real database — the exact shape whose
    // quick_check used to cost ~27 seconds each on the production files.
    const staged = store.snapshotBeforeUpdate('0.4.1', '0.4.2') as string
    expect(staged).toBeDefined()

    const startedAt = performance.now()
    for (let i = 0; i < 200; i += 1) store.latestDatabaseSnapshot()
    const elapsed = performance.now() - startedAt

    // Two hundred planning reads. The old path opened every retained file on the
    // FIRST one; a budget this tight cannot be met by any implementation that
    // does. (Generous against CI jitter: the regression was four orders out.)
    expect(elapsed).toBeLessThan(2_000)
    // Nothing is verified yet, and saying so is the honest, non-blocking answer.
    expect(store.latestDatabaseSnapshot()).toBeUndefined()
    store.close()
    void dbPath
  })

  it('an upgraded 0.1.0 state dir finds its existing backups at boot, not at a request', async () => {
    // The 0.1.0 shape: the store's own boot migration stages `<db>.backup-v*`
    // files (migrations/index.ts calls backupDatabase directly) and publishes no
    // catalogue. Before POD-3068 the request path discovered them by opening
    // every one of them; after it, nothing must discover them at request time
    // and boot must still find them.
    const runs: string[] = []
    const { store, dbPath } = tmpStore(async (request) => {
      runs.push(request.path)
      return {
        result: { ok: true, correlationId: request.correlationId, bytes: 1, durationMs: 1 },
      }
    })
    const legacy = store.snapshotBeforeUpdate('0.1.0', '0.1.0') as string
    // Erase the catalogue: this instance now looks exactly like one that was
    // running before the verifier existed.
    rmSync(`${dbPath}.snapshots.json`, { force: true })

    // Update planning still answers honestly, and still starts nothing.
    expect(store.latestDatabaseSnapshot()).toBeUndefined()
    expect(runs).toEqual([])

    // Boot is what reconciles the catalogue with the directory.
    expect(store.discoverDatabaseSnapshots()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(runs).toEqual([legacy])
    expect(store.latestDatabaseSnapshot()).toBe(legacy)
    store.close()
  })

  it('serves the cached verified path without touching the file contents', () => {
    const { store, dbPath } = tmpStore()
    const staged = store.snapshotBeforeUpdate('0.4.1', '0.4.2') as string
    writeSnapshotCatalogue(dbPath, [
      {
        ...(snapshotIdentity(staged) as SnapshotIdentity),
        outcome: 'verified',
        correlationId: 'corr',
        recordedAtMs: Date.now(),
      },
    ])

    expect(store.latestDatabaseSnapshot()).toBe(staged)
    store.close()
  })

  it('keeps serving planning reads while a deliberately slow verification runs', async () => {
    const { store, dbPath } = tmpStore()
    const staged = store.snapshotBeforeUpdate('0.4.1', '0.4.2') as string

    // A verifier whose child takes as long as the outage did. It is a promise,
    // not a synchronous scan, which is the entire difference.
    let released!: () => void
    const child = new Promise<void>((resolve) => {
      released = resolve
    })
    const verifier = new SnapshotVerifier(dbPath, {
      runChild: async (request) => {
        await child
        return {
          result: { ok: true, correlationId: request.correlationId, bytes: 1, durationMs: 1 },
        }
      },
    })
    const verification = verifier.verify(staged)

    // The request path, exercised repeatedly WHILE the verification is
    // outstanding. Under the old implementation the first of these was the
    // ~80-second call.
    const startedAt = performance.now()
    const answers: Array<string | undefined> = []
    for (let i = 0; i < 50; i += 1) {
      answers.push(store.latestDatabaseSnapshot())
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const elapsed = performance.now() - startedAt

    expect(answers).toHaveLength(50)
    expect(answers.every((answer) => answer === undefined)).toBe(true)
    expect(elapsed).toBeLessThan(2_000)

    released()
    await expect(verification).resolves.toMatchObject({ ok: true, path: staged })
    // Only NOW does the request path have a verified path to offer.
    expect(store.latestDatabaseSnapshot()).toBe(staged)
    verifier.close()
    store.close()
  })
})
