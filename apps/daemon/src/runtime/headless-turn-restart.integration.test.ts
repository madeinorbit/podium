/**
 * A ONE-SHOT HEADLESS TURN SURVIVES A REAL DAEMON RESTART (POD-4614).
 *
 * Generation 1 is a REAL SEPARATE PROCESS (`headless-turn-restart.gen1.ts`):
 * it starts one fixture-harness turn under the real podium-host through the
 * session layer's engine hold, waits for the harness child to run, prints
 * READY and idles. The test SIGKILLs it. Generation 2 (this process) receives
 * the same turn again and must ADOPT it — the same child, replayed from the
 * host's ring — never rerun it: the stand-in harness appends its pid once per
 * incarnation, and the file must hold exactly one line.
 *
 * Two shapes of restart: the turn still running when generation 2 arrives
 * (adopt, then complete), and the turn finishing while NO daemon is attached
 * (the result lives only in the host's ring, and generation 2 replays it).
 * Both end with the server's acknowledgement releasing the host.
 *
 * Integration lane (a C compile of podium-host, real processes, real
 * sockets); never unit. No skip: without a host binary this must fail, not
 * report a pass it never ran.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearTestManifests } from '@podium/harness'
import { acknowledgeHostedTurn } from '@podium/harness/driver/host'
import { createDurableProcess, hostHasSession, liveHostSocket } from '@podium/process/durable'
import type { HeadlessTurnEvent } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSessionEngineScope } from '../session/engines.js'
import {
  FIXTURE_AGENT_SCRIPT,
  fixtureSnapshot,
  registerFixtureHarness,
  restartTurn,
  runRestartTurn,
} from '../test-support/headless-turn-restart.shared.js'
import { SessionRegistry } from '../session/registry.js'

const GEN1 = fileURLToPath(new URL('../test-support/headless-turn-restart.gen1.ts', import.meta.url))

let root = ''
let hostSockets = ''
let stand = ''
const savedEnv: Record<string, string | undefined> = {}

function shortSockRoot(tag: string): string {
  for (const base of ['/tmp', '/var/tmp', tmpdir()]) {
    try {
      return mkdtempSync(join(base, tag))
    } catch {
      // Next candidate.
    }
  }
  throw new Error('no writable tmp base for podium-host sockets')
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(50)
  }
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : []
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-4614-restart-'))
  mkdirSync(join(root, 'bin'), { recursive: true })
  for (const key of ['HOME', 'PODIUM_STATE_DIR', 'PODIUM_HOST_SOCKET_DIR', 'PODIUM_INSTANCE', 'PODIUM_NO_SCOPE']) {
    savedEnv[key] = process.env[key]
  }
  hostSockets = shortSockRoot('pod-4614-hs-')
  process.env.HOME = join(root, 'home')
  mkdirSync(process.env.HOME, { recursive: true })
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_HOST_SOCKET_DIR = hostSockets
  process.env.PODIUM_INSTANCE = 'restart'
  // No transient user scopes from a test: podium-host daemonizes, so the turn
  // outlives the killed generation without one.
  process.env.PODIUM_NO_SCOPE = '1'
  stand = join(root, 'bin', 'fixture-agent')
  writeFileSync(stand, FIXTURE_AGENT_SCRIPT)
  chmodSync(stand, 0o755)
  registerFixtureHarness()
})

afterAll(() => {
  clearTestManifests()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
  if (hostSockets) rmSync(hostSockets, { recursive: true, force: true })
})

interface Case {
  sessionId: string
  turnId: string
  files: { incarnations: string; homeReceipt: string; release: string; done: string }
  agentHome: string
  cwd: string
}

function newCase(tag: string): Case {
  // Fresh per ATTEMPT: a retried test must not count the last attempt's child.
  const unique = `${tag}${Math.random().toString(36).slice(2, 7)}`
  const dir = join(root, unique)
  mkdirSync(join(dir, 'agent-home'), { recursive: true })
  mkdirSync(join(dir, 'work'), { recursive: true })
  return {
    // Short: the label feeds the socket path.
    sessionId: `r${unique}`,
    turnId: `turn-${tag}`,
    agentHome: join(dir, 'agent-home'),
    cwd: join(dir, 'work'),
    files: {
      incarnations: join(dir, 'incarnations'),
      homeReceipt: join(dir, 'home-receipt'),
      release: join(dir, 'release'),
      done: join(dir, 'done'),
    },
  }
}

/** Start generation 1 on a case and resolve once its turn's child runs. */
async function startGeneration1(c: Case): Promise<ChildProcess> {
  const gen1 = spawn(process.execPath, ['--conditions=@podium/source', GEN1], {
    env: {
      ...process.env,
      GEN1_FIXTURE: stand,
      GEN1_SESSION: c.sessionId,
      GEN1_TURN: c.turnId,
      GEN1_CWD: c.cwd,
      GEN1_AGENT_HOME: c.agentHome,
      GEN1_INCARNATIONS: c.files.incarnations,
      GEN1_HOME_RECEIPT: c.files.homeReceipt,
      GEN1_RELEASE: c.files.release,
      GEN1_DONE: c.files.done,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let stderr = ''
  gen1.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8000)
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`gen1 never became ready: ${output}\n--- stderr ---\n${stderr}`)),
      150_000,
    )
    timer.unref?.()
    gen1.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (/^READY$/m.test(output)) {
        clearTimeout(timer)
        resolve()
      }
    })
    gen1.once('exit', (code) =>
      reject(new Error(`gen1 exited ${code} before ready: ${output}\n--- stderr ---\n${stderr}`)),
    )
    gen1.once('error', reject)
  })
  return gen1
}

/** THE RESTART: SIGKILL the whole generation; its sockets close with it. */
async function killGeneration(gen1: ChildProcess): Promise<void> {
  gen1.kill('SIGKILL')
  await new Promise<void>((resolve) => {
    if (gen1.exitCode !== null || gen1.signalCode !== null) return resolve()
    gen1.once('exit', () => resolve())
  })
}

describe('a real daemon restart replays a one-shot headless turn (POD-4614)', () => {
  it('adopts the turn still running under podium-host and completes it — replay, not rerun', async () => {
    const c = newCase('a')
    const gen1 = await startGeneration1(c)
    const snapshot = fixtureSnapshot(stand)
    const turn = restartTurn({ ...c, snapshot })
    try {
      expect(lines(c.files.incarnations)).toHaveLength(1)
      await killGeneration(gen1)
      // The daemon is gone; the turn is not.
      expect(await hostHasSession(turn.label)).toBe(true)

      // Generation 2: new objects, the same turn from the server again.
      const engines = createSessionEngineScope(createDurableProcess('host', { host: true, abduco: false }), { sessions: new SessionRegistry() })
      const events: HeadlessTurnEvent[] = []
      const handle = runRestartTurn(engines, turn, snapshot, events)
      await wait(300)
      writeFileSync(c.files.release, '')
      const outcome = await handle.done
      expect(outcome).toEqual({
        harnessSessionId: `uuid-${c.sessionId}`,
        output: 'fixture answer: survive the restart',
      })
      // REPLAY, NOT RERUN: one incarnation across both generations.
      expect(lines(c.files.incarnations)).toHaveLength(1)
      // The child ran under the instance-owned HOME, not the machine home.
      expect(readFileSync(c.files.homeReceipt, 'utf8').trim()).toBe(c.agentHome)
      expect(events).toContainEqual({
        kind: 'status',
        status: 'running',
        harnessSessionId: `uuid-${c.sessionId}`,
      })

      // The result is kept until the server acknowledges it; then released.
      expect(await liveHostSocket(turn.label)).toBeDefined()
      await acknowledgeHostedTurn(engines, turn.label, turn.identity)
      await waitFor(async () => (await liveHostSocket(turn.label)) === undefined, 10_000, 'host release')
    } finally {
      gen1.kill('SIGKILL')
      await createDurableProcess('host', { host: true, abduco: false }).kill(turn.label)
    }
  }, 240_000)

  it('replays a turn that FINISHED while no daemon ran, from the host ring alone', async () => {
    const c = newCase('b')
    const gen1 = await startGeneration1(c)
    const snapshot = fixtureSnapshot(stand)
    const turn = restartTurn({ ...c, snapshot })
    try {
      await killGeneration(gen1)
      // The turn ends with nobody attached.
      writeFileSync(c.files.release, '')
      await waitFor(() => existsSync(c.files.done), 30_000, 'the child to finish')
      await waitFor(async () => !(await hostHasSession(turn.label)), 10_000, 'the child to exit')
      await wait(500)

      const engines = createSessionEngineScope(createDurableProcess('host', { host: true, abduco: false }), { sessions: new SessionRegistry() })
      const outcome = await runRestartTurn(engines, turn, snapshot).done
      expect(outcome).toEqual({
        harnessSessionId: `uuid-${c.sessionId}`,
        output: 'fixture answer: survive the restart',
      })
      expect(lines(c.files.incarnations)).toHaveLength(1)
      await acknowledgeHostedTurn(engines, turn.label, turn.identity)
      await waitFor(async () => (await liveHostSocket(turn.label)) === undefined, 10_000, 'host release')
    } finally {
      gen1.kill('SIGKILL')
      await createDurableProcess('host', { host: true, abduco: false }).kill(turn.label)
    }
  }, 240_000)
})
