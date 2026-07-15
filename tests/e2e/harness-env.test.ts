import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { harnessEnv, harnessPidFile, reapHarnessSessions, stopHarnessProcess } from './harness-env'

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
const WRITING_HARNESS_FIXTURE = [
  "const fs = require('node:fs')",
  'const pidFile = process.env.HARNESS_PID_FILE',
  'const readyFile = process.env.HARNESS_READY_FILE',
  'const stoppedFile = process.env.HARNESS_STOPPED_FILE',
  'const transcriptDir = process.env.HARNESS_TRANSCRIPT_DIR',
  'fs.mkdirSync(transcriptDir, { recursive: true })',
  'const timer = setInterval(() => {',
  '  fs.mkdirSync(transcriptDir, { recursive: true })',
  "  fs.writeFileSync(transcriptDir + '/active.jsonl', String(Date.now()))",
  '}, 2)',
  'const stop = () => {',
  '  clearInterval(timer)',
  '  setTimeout(() => {',
  '    fs.rmSync(pidFile, { force: true })',
  "    fs.writeFileSync(stoppedFile, 'stopped')",
  '    process.exit(0)',
  '  }, Number(process.env.HARNESS_STOP_DELAY_MS))',
  '}',
  "process.on('SIGTERM', process.env.HARNESS_IGNORE_TERM === '1' ? () => {} : stop)",
  'fs.writeFileSync(pidFile, String(process.pid))',
  "fs.writeFileSync(readyFile, 'ready')",
].join('\n')

async function waitForPath(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit')), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

describe('harness process shutdown ordering', () => {
  const PORT = 9912
  const children: ReturnType<typeof spawn>[] = []

  function startWriter(ignoreTerm: boolean): {
    child: ReturnType<typeof spawn>
    readyFile: string
    stoppedFile: string
  } {
    const { stateDir } = harnessEnv(PORT)
    const readyFile = join(stateDir, 'writer.ready')
    const stoppedFile = join(stateDir, 'writer.stopped')
    const transcriptDir = join(stateDir, 'transcripts', 'machine')
    mkdirSync(stateDir, { recursive: true })
    const child = spawn(process.execPath, ['-e', WRITING_HARNESS_FIXTURE], {
      stdio: 'ignore',
      env: {
        ...process.env,
        HARNESS_PID_FILE: harnessPidFile(PORT),
        HARNESS_READY_FILE: readyFile,
        HARNESS_STOPPED_FILE: stoppedFile,
        HARNESS_TRANSCRIPT_DIR: transcriptDir,
        HARNESS_STOP_DELAY_MS: '150',
        HARNESS_IGNORE_TERM: ignoreTerm ? '1' : '0',
      },
    })
    children.push(child)
    return { child, readyFile, stoppedFile }
  }

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await waitForExit(child).catch(() => {})
    }
    rmSync(harnessEnv(PORT).base, { recursive: true, force: true })
  })

  it('waits for the writer shutdown acknowledgement before removing transcript state', async () => {
    const { child, readyFile, stoppedFile } = startWriter(false)
    await waitForPath(readyFile)

    await stopHarnessProcess(PORT, { graceMs: 1_000, pollMs: 10 })

    expect(existsSync(stoppedFile)).toBe(true)
    await waitForExit(child)
    reapHarnessSessions(PORT)
    expect(existsSync(harnessEnv(PORT).base)).toBe(false)
  })

  it('force-kills an unresponsive writer before removing transcript state', async () => {
    const { child, readyFile } = startWriter(true)
    await waitForPath(readyFile)

    await stopHarnessProcess(PORT, { graceMs: 50, forceKillWaitMs: 1_000, pollMs: 10 })

    await waitForExit(child)
    expect(child.signalCode).toBe('SIGKILL')
    reapHarnessSessions(PORT)
    expect(existsSync(harnessEnv(PORT).base)).toBe(false)
  })
})
