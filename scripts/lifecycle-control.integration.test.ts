/**
 * REAL-PROCESS proof that swap and topology asks travel on the private line
 * [POD-3763].
 *
 * Everything else about this change is proved over fake peers, which is right
 * for a protocol. What only real processes can prove is the two facts the design
 * rests on: that the descriptor `spawn` hands a supervised child carries a
 * request UP and its answer back DOWN through the real `ParentProcess`, and that
 * a supervisor which dies with a request in flight ENDS that request instead of
 * leaving the asker waiting — the behaviour that replaces polling a result file
 * for twenty minutes.
 *
 * Both cases also assert the guard: no `parent-request.json` is ever written.
 * That file is the channel-less caller's inlet, and a child holding a line must
 * never reach it — not on success, and not when its supervisor dies under it.
 *
 * The stack is scripts/fixtures/parent-stack-fixture.ts driven by the real
 * `ParentProcess`, the same shape as scripts/parent-lifecycle.integration.test.ts.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parentRequestPath } from '../packages/runtime/src/parent-control'

const ROOT = join(import.meta.dirname, '..')
const FIXTURE = join(ROOT, 'scripts/fixtures/parent-stack-fixture.ts')

const roots: string[] = []
const started: ChildProcess[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

async function until<T>(read: () => T | undefined, label: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('could not reserve a loopback port'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

interface Stack {
  parentPid: number
  stateDir: string
  output: () => string
  /** What the server child recorded about the ask it made on its line. */
  ask: () => { ok?: boolean; error?: string; releaseHadMigrations?: boolean } | undefined
  /** True if the channel-less inlet was touched. It never should be. */
  requestFileWritten: () => boolean
  /** True once the supervisor has actually STARTED running the ask. */
  swapStarted: () => boolean
}

async function startStack(env: Record<string, string>): Promise<Stack> {
  const root = await mkdtemp(join(tmpdir(), 'podium-lifecycle-control-'))
  roots.push(root)
  const port = await freePort()
  mkdirSync(join(root, 'run'), { recursive: true })
  writeFileSync(join(root, 'VERSION'), '1.0.0\n')
  const inherited = { ...process.env }
  delete inherited.PODIUM_AGENT_RELAY
  delete inherited.NOTIFY_SOCKET
  const parent = spawn('bun', ['--conditions=@podium/source', FIXTURE, 'parent', '--takeover'], {
    cwd: ROOT,
    env: {
      ...inherited,
      PODIUM_STATE_DIR: root,
      PODIUM_HOME: root,
      PODIUM_PORT: String(port),
      PODIUM_APP_VERSION: '1.0.0',
      FIXTURE_PARENT_CHILDREN: 'server',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  started.push(parent)
  let output = ''
  parent.stdout?.on('data', (c) => (output += String(c)))
  parent.stderr?.on('data', (c) => (output += String(c)))
  const askPath = join(root, 'run', 'fixture-server-ask.json')
  /** A request file written at ANY point in the run, not just at the end. */
  let sawRequestFile = false
  const watch = setInterval(() => {
    if (existsSync(parentRequestPath(root))) sawRequestFile = true
  }, 20)
  watch.unref?.()
  return {
    parentPid: parent.pid as number,
    stateDir: root,
    output: () => output,
    ask: () => {
      if (!existsSync(askPath)) return undefined
      try {
        return JSON.parse(readFileSync(askPath, 'utf8'))
      } catch {
        return undefined
      }
    },
    requestFileWritten: () => sawRequestFile || existsSync(parentRequestPath(root)),
    swapStarted: () => existsSync(join(root, 'run', 'fixture-swap-started.json')),
  }
}

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.pid && alive(child.pid)) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  }
  await new Promise((r) => setTimeout(r, 100))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('control requests over the private line', () => {
  it('carries a swap ask to the supervisor and its answer back, touching no file', async () => {
    const stack = await startStack({
      FIXTURE_SERVER_ASK: 'swap',
      FIXTURE_SERVER_ASK_VERSION: '2.0.0',
      FIXTURE_SWAP: '1',
      FIXTURE_SWAP_MIGRATIONS: '1',
    })

    const answer = await until(() => stack.ask(), `the swap answer; log:\n${stack.output()}`)

    expect(answer, stack.output()).toEqual({ ok: true, releaseHadMigrations: true })
    expect(stack.requestFileWritten(), 'the file+signal inlet must not be reachable').toBe(false)
  })

  it('brings the parent’s own failure sentence back down the line', async () => {
    const stack = await startStack({
      FIXTURE_SERVER_ASK: 'swap',
      FIXTURE_SWAP: '1',
      FIXTURE_SWAP_ERROR: 'cannot converge: schema-advanced — this build cannot open this database',
    })

    const answer = await until(() => stack.ask(), `the swap refusal; log:\n${stack.output()}`)

    expect(answer?.ok, stack.output()).toBe(false)
    expect(answer?.error).toMatch(/schema-advanced/)
    expect(stack.requestFileWritten()).toBe(false)
  })

  it('ends an ask whose supervisor dies under it, instead of waiting for an answer', {
    timeout: 60_000,
  }, async () => {
    // The swap never finishes, so the request is in flight when the supervisor
    // is killed. Before this change the asker polled a result file until its own
    // twenty-minute deadline; now the close IS the answer.
    const stack = await startStack({
      FIXTURE_SERVER_ASK: 'swap',
      FIXTURE_SWAP: '1',
      FIXTURE_SWAP_DELAY_MS: '600000',
    })

    // Wait for the ask to be IN FLIGHT — the supervisor writes this from inside
    // the swap, before it starts waiting — so the kill lands mid-request rather
    // than before the frame was ever read. A delay would only look like this.
    await until(
      () => (stack.swapStarted() ? true : undefined),
      `the supervisor to start the ask; log:\n${stack.output()}`,
    )
    process.kill(stack.parentPid, 'SIGKILL')

    const answer = await until(
      () => stack.ask(),
      `the ask to end when the supervisor died; log:\n${stack.output()}`,
    )
    expect(answer?.ok).toBe(false)
    expect(answer?.error).toMatch(/closed the line before answering/)
    expect(stack.requestFileWritten(), 'a dead supervisor is not a reason to write a file').toBe(
      false,
    )
  })
})
