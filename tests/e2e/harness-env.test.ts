import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyRealAgentCodexEnv,
  harnessEnv,
  harnessPidFile,
  reapHarnessSessions,
  reapStaleHarnessDirs,
  stopHarnessProcess,
} from './harness-env'

describe('applyRealAgentCodexEnv', () => {
  const PORT = 9912
  const sourceHome = join(tmpdir(), `podium-real-agent-home-${process.pid}`)
  const originalCodexHome = process.env.CODEX_HOME
  const originalRolloutTraceRoot = process.env.CODEX_ROLLOUT_TRACE_ROOT

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalCodexHome
    if (originalRolloutTraceRoot === undefined) delete process.env.CODEX_ROLLOUT_TRACE_ROOT
    else process.env.CODEX_ROLLOUT_TRACE_ROOT = originalRolloutTraceRoot
    rmSync(sourceHome, { recursive: true, force: true })
    rmSync(harnessEnv(PORT).base, { recursive: true, force: true })
  })

  it('copies only auth into a private Codex home and leaves historical agent homes absent', () => {
    const sourceCodexHome = join(sourceHome, 'selected-codex-home')
    const auth = '{"tokens":{"access_token":"secret"}}\n'
    mkdirSync(join(sourceCodexHome, 'sessions', '2026', '07', '15'), { recursive: true })
    writeFileSync(join(sourceCodexHome, 'auth.json'), auth, { mode: 0o644 })
    writeFileSync(join(sourceCodexHome, 'history.jsonl'), 'private history\n')
    writeFileSync(join(sourceCodexHome, 'config.toml'), 'model = "live-user-choice"\n')
    writeFileSync(
      join(sourceCodexHome, 'sessions', '2026', '07', '15', 'rollout-live.jsonl'),
      'private rollout\n',
    )
    process.env.CODEX_ROLLOUT_TRACE_ROOT = join(sourceHome, 'live-rollout-traces')

    const dirs = applyRealAgentCodexEnv(PORT, {
      sourceHomeDir: sourceHome,
      sourceCodexHomeDir: sourceCodexHome,
    })

    expect(process.env.CODEX_HOME).toBe(dirs.codexHomeDir)
    expect(process.env.CODEX_ROLLOUT_TRACE_ROOT).toBe(dirs.codexRolloutTraceRoot)
    expect(readFileSync(join(dirs.codexHomeDir, 'auth.json'), 'utf8')).toBe(auth)
    expect(() => readFileSync(join(dirs.codexHomeDir, 'history.jsonl'))).toThrow()
    expect(() => readFileSync(join(dirs.codexHomeDir, 'config.toml'))).toThrow()
    expect(() =>
      readFileSync(join(dirs.codexRolloutRoot, '2026', '07', '15', 'rollout-live.jsonl')),
    ).toThrow()
    expect(statSync(dirs.base).mode & 0o777).toBe(0o700)
    expect(statSync(dirs.codexHomeDir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dirs.codexHomeDir, 'auth.json')).mode & 0o777).toBe(0o600)
    expect(() => statSync(join(dirs.discoveryHomeDir, '.claude'))).toThrow()
    expect(() => statSync(join(dirs.discoveryHomeDir, '.claude.json'))).toThrow()
  })

  it('fails clearly instead of launching real Codex without native auth', () => {
    expect(() =>
      applyRealAgentCodexEnv(PORT, {
        sourceHomeDir: sourceHome,
        sourceCodexHomeDir: join(sourceHome, 'missing-codex-home'),
      }),
    ).toThrow(/requires a native Codex login/)
  })
})

/**
 * Regression guard for POD-688: the harness's abduco socket dir must stay inside
 * abduco's sun_path budget, and must be the same path in every process.
 *
 * abduco builds the master's socket at `$ABDUCO_SOCKET_DIR/abduco/<user>/<label><@host>`
 * and refuses to create the session ("create-session: File name too long") once
 * that reaches sun_path's 108 bytes. Nothing in the harness enforced the budget,
 * so the SP-0be7 TMPDIR container silently spent 23 of the 17 bytes of headroom:
 * every daemon spawn failed and the only visible symptom was an e2e output timeout.
 */
describe('harness abduco socket budget', () => {
  const SUN_PATH_MAX = 108 // sizeof(struct sockaddr_un.sun_path)

  it('leaves room for a podium-<uuid> session socket under the harness socket dir', () => {
    const { abducoSocketDir } = harnessEnv(9921)
    // What abduco actually concatenates, worst-case, for one of our sessions.
    const layout = `${abducoSocketDir}/abduco/${userInfo().username}/podium-${randomUUID()}@${hostname()}`
    expect(layout.length).toBeLessThan(SUN_PATH_MAX)
  })

  it('anchors the base outside the per-test-file TMPDIR container so every process agrees', () => {
    // test-hermetic-env.ts points TMPDIR at a random per-fork container; a
    // harness path derived from it could not be reaped by Playwright's
    // globalTeardown or the next run's startup reap, which never load it.
    expect(process.env.PODIUM_TEST_HOST_TMPDIR).toBeTruthy()
    expect(harnessEnv(9921).base).toBe(
      join(process.env.PODIUM_TEST_HOST_TMPDIR as string, 'podium-e2e-9921'),
    )
    expect(harnessEnv(9921).base.startsWith(tmpdir())).toBe(false)
  })
})

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
/**
 * POD-107: reapHarnessSessions is keyed by port, so a hard-killed run on an
 * ad-hoc port parked its abduco masters under /tmp/podium-e2e-<port> forever.
 * reapStaleHarnessDirs sweeps abandoned sibling-port dirs — and ONLY those.
 */
describe('reapStaleHarnessDirs', () => {
  const root = join(tmpdir(), `podium-stale-root-${process.pid}`)
  let origRoot: string | undefined

  beforeEach(() => {
    origRoot = process.env.PODIUM_TEST_HOST_TMPDIR
    process.env.PODIUM_TEST_HOST_TMPDIR = root
    mkdirSync(root, { recursive: true })
  })
  afterEach(() => {
    if (origRoot === undefined) delete process.env.PODIUM_TEST_HOST_TMPDIR
    else process.env.PODIUM_TEST_HOST_TMPDIR = origRoot
    rmSync(root, { recursive: true, force: true })
  })

  const seedDir = (port: number, pid?: number | string): string => {
    const base = join(root, `podium-e2e-${port}`)
    mkdirSync(join(base, 'state'), { recursive: true })
    if (pid !== undefined) writeFileSync(harnessPidFile(port), String(pid))
    return base
  }

  it('reaps a dir whose recorded harness pid is dead', () => {
    // Far beyond any kernel pid_max — kill(pid, 0) is a guaranteed ESRCH.
    const base = seedDir(9931, 2 ** 30)
    expect(reapStaleHarnessDirs()).toContain(9931)
    expect(existsSync(base)).toBe(false)
  })

  it('leaves a dir whose harness pid is alive (a concurrent run on another port)', () => {
    const base = seedDir(9932, process.pid)
    expect(reapStaleHarnessDirs()).not.toContain(9932)
    expect(existsSync(base)).toBe(true)
  })

  it('does not turn a corrupt pid marker into a reap of a fresh dir', () => {
    const base = seedDir(9933, 'not-a-pid')
    expect(reapStaleHarnessDirs()).not.toContain(9933)
    expect(existsSync(base)).toBe(true)
  })

  it('age-gates pid-file-less dirs: fresh stays (a harness mid-startup), stale goes', () => {
    const base = seedDir(9934)
    expect(reapStaleHarnessDirs()).not.toContain(9934)
    expect(existsSync(base)).toBe(true)
    expect(reapStaleHarnessDirs(Date.now() + 31 * 60 * 1000)).toContain(9934)
    expect(existsSync(base)).toBe(false)
  })

  it('age-gates orphaned scratch repos whose state dir is already gone', () => {
    const orphan = join(root, 'zz-podium-e2e-repo-9936')
    mkdirSync(orphan, { recursive: true })
    reapStaleHarnessDirs()
    expect(existsSync(orphan)).toBe(true) // fresh — could belong to a starting run
    reapStaleHarnessDirs(Date.now() + 31 * 60 * 1000)
    expect(existsSync(orphan)).toBe(false)
  })

  it('reaps the per-port scratch repos alongside the state dir', () => {
    seedDir(9935, 2 ** 30)
    const scratch = join(root, 'zz-podium-e2e-repo-9935')
    for (const dir of [scratch, `${scratch}-feat`, `${scratch}-target`]) {
      mkdirSync(dir, { recursive: true })
    }
    expect(reapStaleHarnessDirs()).toContain(9935)
    for (const dir of [scratch, `${scratch}-feat`, `${scratch}-target`]) {
      expect(existsSync(dir)).toBe(false)
    }
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
