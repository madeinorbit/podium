/**
 * A MESSAGE SENT TO AN ENDED CLAUDE SESSION REACHES THE RESUMED PROCESS (POD-4663).
 *
 * The acceptance instance found it: End session on the desktop parks a headed
 * claude-code session (`hibernated`), a send from the phone wakes it
 * (`resumeAndSend` → `receiptSend('wake')`), the CLI relaunches with `--resume`
 * — and the message is never typed. The daemon logs `prompt_queued` and then
 * nothing; the row sits pending behind "Waking the agent" for good.
 *
 * Real server, real daemon, real spawn and resume paths. The agent is a fixture
 * TUI that records every byte it is typed, and the Claude hooks are posted by
 * this file exactly as the CLI posts them: nothing at boot (Claude Code fires
 * no SessionStart at interactive launch, `--resume` included), then
 * UserPromptSubmit/Stop around each turn.
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { afterAll, describe, expect, it } from 'vitest'
import { type DaemonOptions, startDaemon } from '../../apps/daemon/src/daemon'
import { startServer } from '../../apps/server/src/test-support/enrolled-server'
import { applyHarnessEnv, reapHarnessSessions } from './harness-env'

const ISOLATION_PORT = 9927
reapHarnessSessions(ISOLATION_PORT)
applyHarnessEnv(ISOLATION_PORT)
afterAll(() => reapHarnessSessions(ISOLATION_PORT))

/** A Claude-shaped TUI that appends every input chunk to `$RECORD` and keeps a
 *  quiet screen, so the drain's settle detector can see it go idle. */
const RECORDER = `
const { appendFileSync } = require('node:fs')
const record = process.env.PODIUM_TEST_RECORD
process.stdout.write('\\x1b[2J\\x1b[H> ')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', (buf) => {
  appendFileSync(record, Buffer.from(buf).toString('utf8'))
  if (buf.length === 1 && buf[0] === 3) process.exit(0)
})
`

const hostMachineId = (): string => readOrCreateLocalMachineId()

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  what = 'condition',
): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

type World = Awaited<ReturnType<typeof startWorld>>

/** A real server and daemon on an isolated state dir, with the recorder as the
 *  agent CLI and Claude's own on-disk layout under a throwaway home. */
async function startWorld(prefix: string) {
  const tmp = mkdtempSync(join(tmpdir(), prefix))
  const record = join(tmp, 'typed.log')
  writeFileSync(record, '')
  const recorder = join(tmp, 'recorder.cjs')
  writeFileSync(recorder, RECORDER)
  const nativeId = `${prefix}native`
  // Where Claude really keeps it: `<home>/.claude/projects/<slug(cwd)>/<id>.jsonl`.
  const projectDir = join(tmp, '.claude', 'projects', tmp.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${nativeId}.jsonl`)
  mkdirSync(join(tmp, 'hooks'), { recursive: true })
  process.env.PODIUM_TEST_RECORD = record

  const launch: NonNullable<DaemonOptions['launch']> = () => ({
    cmd: process.execPath,
    args: [recorder],
    cwd: tmp,
  })
  const srv = await startServer()
  // The transport fixture enrolls the host as a server only; agents need it
  // assigned to run them too.
  await srv.registry.modules.machines.changeAssignment(
    asMachineId(hostMachineId()),
    { server: true, agentExecution: true },
    'resume-send-lane',
  )
  const daemon = await startDaemon({
    serverUrl: `ws://localhost:${srv.port}`,
    machineToken: srv.machineToken,
    machineId: hostMachineId(),
    identityDir: tmp,
    launch,
    // A durable process is required for every spawn (POD-4617); `none` is refused.
    backend: 'host',
    discovery: { background: false, cachePath: join(tmp, 'discovery.db'), homeDir: tmp },
    metrics: { background: false },
    hooks: { port: 0, settingsDir: join(tmp, 'hooks') },
    agentRelay: { port: 0 },
  })
  const sessions = srv.registry.modules.sessions
  await waitFor(
    async () =>
      (await srv.registry.modules.machines.listMachines()).find((m) => m.id === hostMachineId())
        ?.online === true,
    15_000,
    'machine online',
  )
  return {
    tmp,
    nativeId,
    transcriptPath,
    sessions,
    postHook: (sessionId: string, payload: Record<string, unknown>): Promise<Response> =>
      fetch(`http://127.0.0.1:${daemon.hookPort}/hooks/${sessionId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: nativeId, transcript_path: transcriptPath, cwd: tmp, ...payload }),
      }),
    row: async (sessionId: string) => {
      const current = sessions.sessions.get(sessionId as never)
      if (current?.spawnFailure) throw new Error(`spawn refused: ${current.spawnFailure}`)
      return current
    },
    typed: (): string => (existsSync(record) ? readFileSync(record, 'utf8') : ''),
    clearTyped: (): void => writeFileSync(record, ''),
    transcriptTurn: (prompt: string, answer: string): void => {
      const at = new Date().toISOString()
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({ type: 'user', uuid: `u-${prompt}`, sessionId: nativeId, timestamp: at, message: { role: 'user', content: prompt } })}\n` +
          `${JSON.stringify({ type: 'assistant', uuid: `a-${prompt}`, sessionId: nativeId, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })}\n`,
      )
    },
    close: async (): Promise<void> => {
      await daemon.close({ reapSessions: true })
      await srv.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

/** The durable row that carried `text` was typed, and the server admitted its
 *  delivery outcome — the row only leaves the queue on that admission. */
async function expectTypedAndCleared(world: World, sessionId: string, text: string, what: string) {
  await waitFor(() => world.typed().includes(text), 40_000, what)
  await world.postHook(sessionId, { hook_event_name: 'UserPromptSubmit', prompt: text })
  await waitFor(
    async () => (await world.row(sessionId))?.queuedMessageCount === 0,
    20_000,
    'the queued row to clear on the server',
  )
}

describe('e2e: a send to an ended claude-code session', () => {
  it('wakes it and types the message into the resumed CLI', async () => {
    const world = await startWorld('podium-resume-send-')
    const { sessions, row, typed, postHook } = world
    try {
      const { sessionId } = await sessions.createSession({ agentKind: 'claude-code', cwd: world.tmp })
      await waitFor(async () => (await row(sessionId))?.status === 'live', 15_000, 'first launch live')

      // One ordinary turn, so the session is idle with a resume ref — the state
      // the tester ended it from.
      const firstText = 'first turn before the end'
      const first = sessions.receiptSend('now', { sessionId, text: firstText })
      await waitFor(() => typed().includes(firstText), 20_000, 'first turn typed')
      await postHook(sessionId, { hook_event_name: 'UserPromptSubmit', prompt: firstText })
      world.transcriptTurn(firstText, 'ok')
      await postHook(sessionId, { hook_event_name: 'Stop' })
      const firstResult = await first
      expect(firstResult.ok, JSON.stringify(firstResult)).toBe(true)

      // The tester's precondition: idle, with the resume ref Claude reported.
      await waitFor(
        async () => {
          const current = await row(sessionId)
          return current?.resume?.value === world.nativeId && current.agentState?.phase === 'idle'
        },
        20_000,
        'idle with a resume ref',
      )

      // ---- End session ------------------------------------------------------
      const ended = await sessions.hibernateSession({ sessionId })
      expect(ended.ok, JSON.stringify(ended)).toBe(true)
      await waitFor(async () => (await row(sessionId))?.status === 'hibernated', 15_000, 'hibernated')
      world.clearTyped()

      // ---- the phone send wakes it ------------------------------------------
      const phoneText = 'phone message after the end'
      const sent = sessions.receiptSend('wake', { sessionId, text: phoneText })
      // It is held as a durable row first — the count the last step waits to clear.
      await waitFor(
        async () => ((await row(sessionId))?.queuedMessageCount ?? 0) > 0 || typed().includes(phoneText),
        20_000,
        'the wake send to be queued',
      )
      expect(typed()).not.toContain(phoneText)
      await waitFor(async () => (await row(sessionId))?.status === 'live', 20_000, 'resumed live')
      // NO hook here, and that is the case under test: Claude Code posts nothing
      // at interactive boot, `--resume` included — its first hook is the
      // UserPromptSubmit of the prompt somebody types. A resumed session that
      // waits for a hook before it will type is waiting for itself. The server
      // side of the same fault: the resumed process's events are admitted only
      // once its observer generation has a bootstrap (the
      // `replacement-requires-bootstrap` rejection the tester logged).
      await expectTypedAndCleared(world, sessionId, phoneText, 'the phone message typed into the resumed CLI')
      await sent
    } finally {
      await world.close()
    }
  }, 120_000)

  it('types a durable first message into a fresh session that has had no prompt yet', async () => {
    // The sibling case: New session with no initial prompt, then a first
    // message that takes the durable queue (a queued send, or any send while
    // the native terminal view is open). Claude has posted no hook and written
    // no transcript yet, so nothing but the spawn itself can say it is idle.
    const world = await startWorld('podium-fresh-send-')
    const { sessions, row, typed } = world
    try {
      const { sessionId } = await sessions.createSession({ agentKind: 'claude-code', cwd: world.tmp })
      await waitFor(async () => (await row(sessionId))?.status === 'live', 15_000, 'fresh launch live')
      const text = 'first message into a fresh session'
      const sent = sessions.receiptSend('queue', { sessionId, text })
      await expectTypedAndCleared(world, sessionId, text, 'the first message typed into the fresh CLI')
      await sent
    } finally {
      await world.close()
    }
  }, 120_000)
})
