/**
 * THE LIVE RE-PROOF — a real `codex app-server`, a real subscription, real turns
 * (POD-1761 W6).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS OPT-IN, AND WHAT RUNS WITHOUT IT
 * ---------------------------------------------------------------------------
 *
 * Same layering W5 used for its secret evidence, and the same reasoning:
 *
 *   1. THE RECORDED FRAMES (`./__fixtures__`) — captured from a live 0.147.0
 *      app-server and asserted on EVERY run by `./protocol.test.ts`, so a
 *      reviewer sees the exact wire shapes without installing anything.
 *   2. THE DRIVER'S OWN BEHAVIOUR — `./runtime.test.ts` and the conformance
 *      corpus, against a fake built from those frames. It is no use knowing what
 *      Codex sends if our driver mishandles it.
 *   3. THIS FILE — opt-in via `PODIUM_CODEX_LIVE=1`, because it spends a real
 *      subscription quota, takes minutes of wall clock on a loaded box, and
 *      depends on a network the CI lane may not have. A gate that is
 *      occasionally red for reasons unrelated to the change is a gate people
 *      learn to ignore.
 *
 * It is also how the fixtures get RE-RECORDED when the pinned version moves, and
 * it is the acceptance item "subscription-authed headless turn demonstrated end
 * to end" in a form a reviewer can re-run rather than take on trust.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@podium/model'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentSessionHandle } from '../../driver.js'
import type { RuntimeEvent } from '../../events.js'
import {
  type CodexJournal,
  type CodexJournalEntry,
  type CodexRuntimeHost,
  type CodexTransport,
  createCodexRuntime,
} from './index.js'
import { gateCodexVersion, SUPPORTED_CODEX } from './version.js'

const LIVE = process.env.PODIUM_CODEX_LIVE === '1'
const describeLive = LIVE ? describe : describe.skip

/**
 * The daemon's host, re-implemented in miniature.
 *
 * NOT IMPORTED FROM THE DAEMON, deliberately: `apps/daemon` depends on this
 * package and not the other way round, and inverting that for a test would
 * create the cycle the layer manifest exists to prevent. What matters is that
 * the pieces under test are the REAL ones — the child, the pipe, the line
 * splitting, the client, the driver — and they are. The spawn flags mirror
 * `codexAppServerConfigArgs` exactly; if they drift, this test stops
 * demonstrating what the daemon does, which is why they are named here.
 */
function liveHost(workdir: string): {
  host: CodexRuntimeHost
  authReports: { authMethod: string | undefined; subscription: boolean }[]
  killAll(): void
} {
  const { spawn } = require('node:child_process') as typeof import('node:child_process')
  const entries = new Map<SessionId, CodexJournalEntry>()
  const children: ReturnType<typeof spawn>[] = []
  const authReports: { authMethod: string | undefined; subscription: boolean }[] = []
  let seq = 0

  const journal: CodexJournal = {
    read: (id) => entries.get(id),
    write: (entry) => void entries.set(entry.sessionId, entry),
    clear: (id) => void entries.delete(id),
  }

  const host: CodexRuntimeHost = {
    journal,
    now: () => Date.now(),
    mintSessionId: () => `live-${++seq}` as SessionId,
    reportAuthMode: ({ authMethod, subscription }) =>
      void authReports.push({ authMethod, subscription }),

    async launch(input) {
      const env = { ...process.env }
      // THE ENV HYGIENE THE ACCEPTANCE ITEM IS ABOUT. Without this the run below
      // could pass on an inherited API key and the `authMethod` assertion would
      // be demonstrating the wrong thing.
      for (const key of [
        'OPENAI_API_KEY',
        'CODEX_API_KEY',
        'CODEX_ACCESS_TOKEN',
        'OPENAI_ORGANIZATION',
        'OPENAI_BASE_URL',
      ]) {
        delete env[key]
      }
      const child = spawn(
        'codex',
        ['app-server', '-c', 'approval_policy="untrusted"', '-c', 'sandbox_mode="workspace-write"'],
        { cwd: input.workdir, env, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      children.push(child)
      let buffer = ''
      let closed = false
      const transport: CodexTransport = {
        write: (line) => void child.stdin?.write(line),
        onLine(handler) {
          child.stdout?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8')
            let boundary = buffer.indexOf('\n')
            while (boundary >= 0) {
              const line = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 1)
              boundary = buffer.indexOf('\n')
              if (line.trim()) handler.line(line)
            }
          })
          const ended = (): void => {
            if (closed) return
            closed = true
            handler.closed()
          }
          child.once('exit', ended)
          child.once('error', ended)
        },
        close() {
          closed = true
          child.stdin?.end()
        },
      }
      return {
        transport,
        process: { key: `live-${input.sessionId}`, ...(child.pid ? { pid: child.pid } : {}) },
        stop: async () => void child.stdin?.end(),
        kill: async () => void child.kill('SIGKILL'),
        memoryBytes: () => undefined,
      }
    },
  }
  return { host, authReports, killAll: () => children.forEach((c) => c.kill('SIGKILL')) }
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Wait for a predicate over the collected events, or give up. */
async function until(
  events: () => RuntimeEvent[],
  predicate: (events: RuntimeEvent[]) => boolean,
  timeoutMs = 180_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(events())) return true
    await settle(250)
  }
  return false
}

describe('the pinned version, checked without spawning anything', () => {
  it('matches the codex on PATH, or explains why the live run is skipped', () => {
    let output = ''
    try {
      output = execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 15_000 })
    } catch {
      // No codex here. The recorded fixtures are the evidence on this machine,
      // and `./protocol.test.ts` asserts them on every run.
      expect(SUPPORTED_CODEX.recordedAt).toBeTruthy()
      return
    }
    const diagnostic = gateCodexVersion(output)
    if (diagnostic) {
      // A machine whose codex is outside the range is EXPECTED to fail the gate;
      // saying so is the point, and it is exactly what the daemon does before
      // refusing to spawn.
      expect(diagnostic.code).toBe('codex-app-server-version-unsupported')
      return
    }
    expect(gateCodexVersion(output)).toBeNull()
    /**
     * THE TIMEOUT IS GENEROUS BECAUSE THE PROBE IS A FORK OF A 250MB BINARY.
     * Measured at 26s on a loaded shared box, against vitest's 20s default —
     * which failed this test while every live assertion below passed. A version
     * check that flakes under load is exactly the kind of red that teaches
     * people to ignore a suite.
     */
  }, 120_000)
})

describeLive('a real subscription-authed session, end to end', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'podium-codex-live-'))
  const { host, authReports, killAll } = liveHost(workdir)
  const runtime = createCodexRuntime(host)
  let handle: AgentSessionHandle | undefined
  const collected: RuntimeEvent[] = []

  afterAll(() => {
    killAll()
    runtime.dispose()
    rmSync(workdir, { recursive: true, force: true })
  })

  it('starts a thread and rides ~/.codex/auth.json — NOT an inherited API key', async () => {
    handle = await runtime.driver.create({
      harness: 'codex',
      selection: { auth: 'subscription', platform: 'linux', available: ['codex-app-server'] },
      workdir,
      model: {},
      instructions: { supported: false, reason: 'live' },
      mcpServers: { supported: false, reason: 'live' },
    })
    void (async () => {
      try {
        for await (const event of handle.events('bootstrap')) collected.push(event)
      } catch {
        // ends with the session
      }
    })()
    expect(handle.binding.resume?.kind).toBe('codex-thread')
    /**
     * THE ACCEPTANCE ITEM. The env strip above is the mechanism; this is the
     * proof, and it comes from the SERVER rather than from our own bookkeeping —
     * Codex resolves credentials from several places, so only asking it settles
     * which one won.
     */
    expect(authReports).toHaveLength(1)
    expect(authReports[0]?.authMethod).toBe('chatgpt')
    expect(authReports[0]?.subscription).toBe(true)
  }, 180_000)

  it('takes a real turn and fences it on the provider own completion', async () => {
    if (!handle) return
    const receipt = await handle.send(
      { text: 'Reply with exactly: PODIUM_LIVE_OK' },
      { origin: 'human', delivery: 'when-ready' },
    )
    expect(receipt.outcome).toBe('accepted')
    if (receipt.outcome !== 'accepted') return
    expect(receipt.provenBy).toBe('protocol-ack')

    const fenced = await until(
      () => collected,
      (events) => events.some((e) => e.t === 'turn' && e.ev.ev === 'completed'),
    )
    expect(fenced).toBe(true)
    // …and the model's words reached the transcript through the item mapper.
    const text = collected
      .filter((e) => e.t === 'item' && e.item.kind === 'complete')
      .map((e) => (e.t === 'item' && e.item.kind === 'complete' ? e.item.item.text : ''))
      .join(' ')
    expect(text).toContain('PODIUM_LIVE_OK')
  }, 240_000)

  it('STEERS a running turn — the thing no other driver in the fleet can do', async () => {
    if (!handle) return
    const opened = await handle.send(
      { text: 'Think step by step, then list the first 12 prime numbers, one per line.' },
      { origin: 'human', delivery: 'when-ready' },
    )
    expect(opened.outcome).toBe('accepted')
    if (opened.outcome !== 'accepted') return

    const steered = await handle.send(
      { text: 'Also append the word PODIUM_BANANA on its own final line.' },
      { origin: 'human', delivery: 'steer' },
    )
    expect(steered.outcome).toBe('accepted')
    if (steered.outcome !== 'accepted') return
    /**
     * THE DEMONSTRATION the acceptance checklist asks for: `deliveredAs:
     * 'steer'`, not the `queue` downgrade every other driver reports. And the
     * epoch is UNCHANGED, because a steer joins the open turn rather than
     * opening a new one.
     */
    expect(steered.deliveredAs).toBe('steer')
    expect(steered.turnEpoch).toBe(opened.turnEpoch)

    const fenced = await until(
      () => collected,
      (events) =>
        events.filter((e) => e.t === 'turn' && e.ev.ev === 'completed').length >= 2,
    )
    expect(fenced).toBe(true)
    // The steered words landed IN the turn that was already running.
    const text = collected
      .filter((e) => e.t === 'item' && e.item.kind === 'complete')
      .map((e) => (e.t === 'item' && e.item.kind === 'complete' ? e.item.item.text : ''))
      .join(' ')
    expect(text).toContain('PODIUM_BANANA')
  }, 300_000)

  it('hibernates and resumes the SAME conversation in a fresh child', async () => {
    if (!handle) return
    const before = await handle.snapshot()
    const resumeRef = before.binding.resume
    expect(resumeRef).toBeDefined()
    if (!resumeRef) return

    // `hibernate()` never refuses for this family: the thread id exists from
    // `thread/start`, before the first turn.
    expect(await handle.hibernate()).toEqual({ ok: true })

    const resumed = await runtime.driver.resume(resumeRef, {
      harness: 'codex',
      selection: { auth: 'subscription', platform: 'linux', available: ['codex-app-server'] },
      workdir,
      model: {},
      instructions: { supported: false, reason: 'live' },
      mcpServers: { supported: false, reason: 'live' },
    })
    // THE CONVERSATION SURVIVED THE PROCESS, which is the whole basis of this
    // family's cheap parking — and, for this driver, of `adopt()` as well.
    expect(resumed.binding.resume?.value).toBe(resumeRef.value)
    const history = await resumed.transcript.history({ limit: 50 })
    expect(Array.isArray(history)).toBe(true)
    await resumed.kill()
  }, 240_000)
})
