import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { harnessEnv, reapHarnessSessions, retryHarnessCleanup } from './harness-env'

/**
 * Regression guard for the 2026-06-13 incident: abduco 0.6 silently falls back
 * to the REAL socket dir when ABDUCO_SOCKET_DIR does not exist, so the reap's
 * listing showed the developer's live agent sessions — and SIGTERMed them all.
 * The reap must never kill a master whose session socket is not inside the
 * harness's isolated dir, even when the listing claims pid-bearing sessions.
 */
describe('reapHarnessSessions isolation', () => {
  const PORT = 9911
  const stubDir = join(tmpdir(), `podium-reap-stub-${process.pid}`)
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
    rmSync(stubDir, { recursive: true, force: true })
    rmSync(harnessEnv(PORT).base, { recursive: true, force: true })
  })

  it('does not kill a listed master whose socket is outside the isolated dir', async () => {
    // A sentinel process standing in for a real (non-harness) agent master.
    const sentinel = spawn('sleep', ['30'], { stdio: 'ignore' })
    cleanups.push(() => sentinel.kill('SIGKILL'))

    // Stub abduco emitting the dangerous fallback listing: a live, pid-bearing
    // line for the sentinel (exactly what abduco 0.6 prints for real sessions
    // when the isolated dir is missing).
    mkdirSync(stubDir, { recursive: true })
    const listing = `Active sessions (on host test)\n* Sat\t 2026-06-13 00:00:00\t${sentinel.pid}\tpodium-real-agent\n`
    writeFileSync(
      join(stubDir, 'abduco'),
      `#!/bin/sh\nprintf '%b' '${listing.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}'\n`,
    )
    chmodSync(join(stubDir, 'abduco'), 0o755)

    const origPath = process.env.PATH
    process.env.PATH = `${stubDir}:${origPath}`
    cleanups.push(() => {
      process.env.PATH = origPath
    })

    // Isolated dir intentionally absent — the incident's exact precondition.
    rmSync(harnessEnv(PORT).base, { recursive: true, force: true })
    reapHarnessSessions(PORT)

    // Give a SIGTERM (if wrongly sent) time to land, then assert liveness.
    await new Promise((r) => setTimeout(r, 200))
    expect(sentinel.signalCode).toBeNull()
    expect(sentinel.exitCode).toBeNull()
    expect(() => process.kill(sentinel.pid as number, 0)).not.toThrow()
  })

  it('still kills a master whose socket lives inside the isolated dir', async () => {
    const sentinel = spawn('sleep', ['30'], { stdio: 'ignore' })
    cleanups.push(() => sentinel.kill('SIGKILL'))

    const { abducoSocketDir } = harnessEnv(PORT)
    // abduco 0.6 layout: sockets nest in an `abduco/` subdir of the socket dir.
    // The session's socket file IS in the isolated dir → it's ours → reapable.
    mkdirSync(join(abducoSocketDir, 'abduco'), { recursive: true })
    writeFileSync(join(abducoSocketDir, 'abduco', 'podium-ours@test'), '')

    mkdirSync(stubDir, { recursive: true })
    const listing = `Active sessions (on host test)\n* Sat\t 2026-06-13 00:00:00\t${sentinel.pid}\tpodium-ours\n`
    writeFileSync(
      join(stubDir, 'abduco'),
      `#!/bin/sh\nprintf '%b' '${listing.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}'\n`,
    )
    chmodSync(join(stubDir, 'abduco'), 0o755)

    const origPath = process.env.PATH
    process.env.PATH = `${stubDir}:${origPath}`
    cleanups.push(() => {
      process.env.PATH = origPath
    })

    reapHarnessSessions(PORT)

    await new Promise((r) => setTimeout(r, 200))
    expect(sentinel.signalCode).toBe('SIGTERM')
  })
})

describe('reapHarnessSessions cleanup retries', () => {
  const PORT = 9912

  afterEach(() => {
    rmSync(harnessEnv(PORT).base, { recursive: true, force: true })
  })

  it('removes a late transcript write on each repeated run', () => {
    const { base, stateDir } = harnessEnv(PORT)
    const waits: number[] = []

    for (let run = 1; run <= 4; run += 1) {
      const transcripts = join(stateDir, 'transcripts', 'local')
      mkdirSync(transcripts, { recursive: true })
      writeFileSync(join(transcripts, `initial-${run}.jsonl`), 'initial')
      let attempts = 0

      retryHarnessCleanup(
        () => {
          attempts += 1
          if (attempts === 1) {
            writeFileSync(join(transcripts, `late-${run}.jsonl`), 'late')
            throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' })
          }
          rmSync(base, { recursive: true, force: true })
        },
        (delayMs) => waits.push(delayMs),
      )

      expect(attempts).toBe(2)
      expect(existsSync(base)).toBe(false)
    }

    expect(waits).toEqual([100, 100, 100, 100])
  })

  it('stops after five ENOTEMPTY retries', () => {
    const error = Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' })
    const waits: number[] = []
    let attempts = 0

    expect(() =>
      retryHarnessCleanup(
        () => {
          attempts += 1
          throw error
        },
        (delayMs) => waits.push(delayMs),
      ),
    ).toThrow(error)

    expect(attempts).toBe(6)
    expect(waits).toEqual([100, 200, 300, 400, 500])
  })
})
