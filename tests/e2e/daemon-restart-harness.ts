/**
 * A DAEMON YOU CAN KILL (POD-2056).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * Starting, killing and restarting {@link ./daemon-process.ts} — the daemon as
 * a real child process — so a test can assert what only a two-process lane can
 * see: that the things the daemon spawned OUTLIVE it, and that the daemon which
 * comes back finds them again.
 *
 * The whole harness is about one distinction the in-process lanes cannot make.
 * `daemon.close()` is a shutdown the daemon PARTICIPATES in. SIGKILL is not:
 * no handler runs, no socket is closed politely, no state is flushed on the way
 * out. Recovery code that only ever sees the first one is recovery code nobody
 * has tested, and `crash()` here is what makes the second one available.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONFIG GOES THROUGH A FILE
 * ---------------------------------------------------------------------------
 *
 * A restart must be able to reproduce the daemon's options EXACTLY — same
 * machine id, same state dir, same ports — because a daemon that came back as a
 * slightly different machine would fail to adopt for a reason that has nothing
 * to do with adoption. Holding the options as one object and writing it once
 * makes that guarantee structural: {@link restart} re-reads the same file.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DaemonProcessConfig, SerializableDaemonOptions } from './daemon-process'

const ENTRY = fileURLToPath(new URL('./daemon-process.ts', import.meta.url))

const READY_POLL_MS = 25
const EXIT_POLL_MS = 25
/** How long a SIGKILLed process may stay visible to `kill(pid, 0)`. It is not
 *  instant — the pid remains until its parent reaps it — so a lane that treated
 *  "still visible" as "still running" would flake on a machine under load. */
const REAPED_TIMEOUT_MS = 5_000
/** How much of the child's log to retain. One daemon boot at debug is well
 *  under this; the cap exists so a wedged child cannot grow the buffer without
 *  bound over a long lane. */
const CAPTURE_LIMIT = 256_000

export interface DaemonProcessHandle {
  /** The pid of the daemon RIGHT NOW. Changes across {@link restart}. */
  readonly pid: number
  /** Is that pid still a live process? */
  alive(): boolean
  /**
   * SIGKILL, and wait for the pid to go away.
   *
   * The signal is not configurable on purpose. A harness that offered SIGTERM
   * here would let a lane quietly test the graceful path while its name still
   * said "crash", and the difference between those two is the entire subject of
   * every test that uses this file.
   */
  crash(): Promise<void>
  /** SIGTERM, wait for the handler's `close()` to finish and the pid to go. */
  stop(): Promise<void>
  /** Start a new daemon process from the SAME options. Resolves when it is up. */
  restart(): Promise<void>
  /**
   * Whatever the child wrote to stdout/stderr since it last started, newest
   * kept. Often the only thing a failure in the PARENT has to say about what
   * the daemon was doing — so a lane that asserts on daemon behaviour should
   * attach it, and should raise the child's log level to make it worth
   * attaching (see {@link StartDaemonProcessInput.env}).
   *
   * `maxChars` trims the tail for an assertion message; omitted returns all of
   * the retained buffer.
   */
  output(maxChars?: number): string
}

export interface StartDaemonProcessInput {
  options: SerializableDaemonOptions
  /**
   * Where the config and ready marker live. A path the TEST owns, not a temp
   * dir this file invents: the lane already has one, and a second one would be
   * a second thing to clean up.
   */
  dir: string
  /**
   * Extra environment for the child. The parent's env is inherited first, so
   * the isolation vars `applyHarnessEnv` installed carry over unchanged — which
   * is what puts both processes on the same PODIUM_STATE_DIR, and therefore on
   * the same binding journal.
   *
   * `PODIUM_LOG` belongs here for any lane that will assert on what the daemon
   * DID: across a process boundary its log is the only narration available, and
   * at the default level the interesting decisions (a driver resolution that
   * fell back, a session that reattached to nothing) say nothing at all.
   */
  env?: Readonly<Record<string, string>>
  readyTimeoutMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function startDaemonProcess(
  input: StartDaemonProcessInput,
): Promise<DaemonProcessHandle> {
  mkdirSync(input.dir, { recursive: true, mode: 0o700 })
  const configPath = join(input.dir, 'daemon-process.json')
  const readyFile = join(input.dir, 'daemon-process.ready')
  const config: DaemonProcessConfig = { options: input.options, readyFile }
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })

  const readyTimeoutMs = input.readyTimeoutMs ?? 60_000
  let child: ChildProcess | undefined
  let pid = 0
  let captured = ''

  async function launch(): Promise<void> {
    // A marker left by the PREVIOUS life would read as this one being ready
    // before it has even bound its socket.
    rmSync(readyFile, { force: true })
    captured = ''
    // `process.execPath` is the runtime the SUITE is under, which is how the
    // child ends up on the same one rather than on whatever `bun` happens to be
    // on PATH. The whole suite runs `bun --bun vitest` (vitest.config.ts pins
    // the reason: bun:sqlite), so this is Bun — and the assertion is here rather
    // than implied because under node the child would fail on the first `.ts`
    // import with an error about syntax, which names the wrong problem.
    if (!process.versions.bun) {
      throw new Error(
        'the daemon-process harness needs the Bun runtime to execute a TypeScript entry; run this suite with `bun --bun vitest`',
      )
    }
    const spawned = spawn(
      process.execPath,
      // The same conditions every other standalone e2e entry runs under: the
      // workspace packages resolve to THIS checkout's source rather than to a
      // built dist that may be stale or absent.
      ['--conditions=@podium/source', ENTRY, configPath],
      {
        env: { ...process.env, ...input.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        // NOT detached. The child must be an ordinary child so that a test which
        // forgets to clean up still loses it with its own process group — and
        // more importantly so the agent processes IT spawns are grandchildren of
        // this test, which is the shape the survival claim is about.
        detached: false,
      },
    )
    child = spawned
    const capture = (chunk: Buffer): void => {
      // Generous, because this is a whole process's log and the useful line is
      // often well before the newest one. Trimmed at the point of USE
      // (`output(maxChars)`) rather than here.
      captured = `${captured}${chunk.toString('utf8')}`.slice(-CAPTURE_LIMIT)
    }
    spawned.stdout?.on('data', capture)
    spawned.stderr?.on('data', capture)

    let exited: number | null = null
    spawned.once('exit', (code) => {
      exited = code ?? 0
    })

    const deadline = Date.now() + readyTimeoutMs
    while (!existsSync(readyFile)) {
      if (exited !== null) {
        throw new Error(
          `daemon process exited with ${exited} before becoming ready${captured ? `: ${captured.trim()}` : ''}`,
        )
      }
      if (Date.now() > deadline) {
        spawned.kill('SIGKILL')
        throw new Error(
          `daemon process did not become ready within ${readyTimeoutMs}ms${captured ? `: ${captured.trim()}` : ''}`,
        )
      }
      await sleep(READY_POLL_MS)
    }
    // The pid the DAEMON reported, not `spawned.pid`. They are the same today,
    // and asserting the daemon's own answer is what would catch it if a future
    // wrapper ever re-execs in between.
    pid = Number.parseInt(readFileSync(readyFile, 'utf8').trim(), 10)
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error(`daemon process wrote an unusable pid: ${readFileSync(readyFile, 'utf8')}`)
    }
  }

  async function waitGone(signalled: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (processIsAlive(signalled)) {
      if (Date.now() > deadline) {
        throw new Error(`daemon pid ${signalled} was still alive ${timeoutMs}ms after the signal`)
      }
      await sleep(EXIT_POLL_MS)
    }
  }

  await launch()

  return {
    get pid() {
      return pid
    },
    alive: () => processIsAlive(pid),
    output: (maxChars) => (maxChars === undefined ? captured : captured.slice(-maxChars)),
    async crash() {
      const target = pid
      try {
        process.kill(target, 'SIGKILL')
      } catch {
        return // already gone; the lane's own assertions will say whether that is ok
      }
      await waitGone(target, REAPED_TIMEOUT_MS)
    },
    async stop() {
      const target = pid
      try {
        process.kill(target, 'SIGTERM')
      } catch {
        return
      }
      // Longer than the crash wait: this path actually runs `close()`, which
      // closes the server connection and every durable-backend handle.
      await waitGone(target, 30_000)
    },
    async restart() {
      if (processIsAlive(pid)) {
        throw new Error(
          `restart() would leave daemon pid ${pid} running — two daemons on one state dir race for the same sessions`,
        )
      }
      await launch()
    },
  }
}
