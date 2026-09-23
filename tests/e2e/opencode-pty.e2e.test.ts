/**
 * Opt-in real-model proof for POD-4047. The production PTY launch must accept
 * effort, deliver the initial work, and remain usable for a second turn.
 * Run with PODIUM_OPENCODE_LIVE=1 and PODIUM_OPENCODE_TEST_MODEL set through
 * `bun run test:lane -- integration tests/e2e/opencode-pty.e2e.test.ts`.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { opencodeSessionDbPath } from '../../packages/harness/src/opencode/db'
import { connectHost, hostSocketPath } from '../../packages/pty/src/host'
import { asMachineId } from '@podium/model'
import { readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { afterAll, describe, expect, it } from 'vitest'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { startServer } from '../../apps/server/src/test-support/enrolled-server'
import { applyHarnessEnv, reapHarnessSessions } from './harness-env'
import { seedOpencodeLogin } from './opencode-login'

// A test daemon must enroll under its own identity, not inherit the hosting
// supervisor's machine token or publisher pin (the shared scrubber misses these).
for (const key of Object.keys(process.env)) {
  if (key.startsWith('PODIUM_SUPERVISOR_')) delete process.env[key]
}

const PORT = 9947
reapHarnessSessions(PORT)
applyHarnessEnv(PORT)
afterAll(() => reapHarnessSessions(PORT))

async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function startEnrolledDaemon(
  srv: Awaited<ReturnType<typeof startServer>>,
  root: string,
  home: string,
): Promise<Awaited<ReturnType<typeof startDaemon>>> {
  const machineId = readOrCreateLocalMachineId()
  // The transport fixture enrolls the host as a server only; this lane runs
  // agents on it, which session placement now requires to be assigned.
  await srv.registry.modules.machines.changeAssignment(
    asMachineId(machineId),
    { server: true, agentExecution: true },
    'opencode-pty-lane',
  )
  const daemon = await startDaemon({
    serverUrl: `ws://localhost:${srv.port}`,
    machineToken: srv.machineToken,
    machineId,
    identityDir: home,
    backend: 'host',
    discovery: { background: false, cachePath: join(root, 'discovery.db'), homeDir: home },
    metrics: { background: false },
    hooks: { port: 0, settingsDir: join(root, 'hooks') },
    agentRelay: { port: 0 },
  })
  await waitFor(
    async () =>
      (await srv.registry.modules.machines.listMachines()).some(
        (m) => m.id === machineId && m.online,
      ),
    'machine online',
  )
  return daemon
}

describe.skipIf(process.env.PODIUM_OPENCODE_LIVE !== '1')('OpenCode terminal first turn', () => {
  it('reads real work, reports back, and answers another turn on the same live session', async () => {
    const model = process.env.PODIUM_OPENCODE_TEST_MODEL
    if (!model) throw new Error('Set PODIUM_OPENCODE_TEST_MODEL to an authorized live model')
    const root = mkdtempSync(join(tmpdir(), 'pod4047-'))
    const home = join(root, 'home')
    const cwd = join(root, 'repo')
    const token = `ALIVE-${randomUUID()}`
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
    try {
      mkdirSync(cwd, { recursive: true })
      writeFileSync(join(cwd, 'proof.txt'), token)
      seedOpencodeLogin(home)
      const srv = await startServer({ port: 0 })
      server = srv
      daemon = await startEnrolledDaemon(srv, root, home)
      const sessions = srv.registry.modules.sessions
      const { sessionId } = await sessions.createSession({
        agentKind: 'opencode',
        cwd,
        model,
        effort: 'low',
        runtimeContract: 'generic-pty',
        initialPrompt:
          'This is an isolated acceptance probe. Read proof.txt in the current directory using a tool, then reply with exactly its contents. Do not edit files or manage issues.',
      })
      const row = () => sessions.sessions.get(sessionId)
      const replies = () =>
        sessions.transcriptFor(sessionId).filter((item) => item.role === 'assistant')
      const assertRunning = async () => {
        if (row()?.spawnFailure) throw new Error(`Spawn refused: ${row()?.spawnFailure}`)
        if (row()?.status === 'exited') {
          const conn = connectHost(hostSocketPath(`podium-${sessionId}`), { mode: 'reader' })
          let output = ''
          conn.onData((_seq, bytes) => {
            output = (output + bytes.toString()).slice(-8000)
          })
          try {
            await conn.welcome
            await conn.replay(8000)
          } finally {
            conn.destroy()
          }
          throw new Error(`OpenCode exited ${row()?.exitCode}: ${output}`)
        }
      }
      await waitFor(async () => {
        await assertRunning()
        return replies().some((item) => item.text?.trim() === token)
      }, 'a tool-backed first reply in the Podium transcript')
      expect(row()?.status).toBe('live')
      expect(row()?.resume?.value).toBeTruthy()
      const db = openDatabase(opencodeSessionDbPath(home, sessionId), { readOnly: true })
      let observedModel: unknown
      try {
        const native = db
          .prepare('SELECT model FROM session WHERE id = ?')
          .get(row()?.resume?.value) as { model: string }
        observedModel = JSON.parse(native.model)
        const [providerID, ...modelParts] = model.split('/')
        expect(observedModel).toMatchObject({
          providerID,
          id: modelParts.join('/'),
          variant: 'low',
        })
      } finally {
        db.close()
      }
      const receipt = await sessions.runtimeGateway.send({
        sessionId,
        text: 'Reply with exactly: STILL_ALIVE',
        origin: 'human',
        delivery: 'when-ready',
      })
      expect(receipt.outcome, JSON.stringify(receipt)).toBe('accepted')
      await waitFor(async () => {
        await assertRunning()
        return replies().some((item) => item.text?.trim() === 'STILL_ALIVE')
      }, 'second reply on the same live process')
      expect(row()?.status).toBe('live')
      console.log(
        'OPENCODE_PTY_PROOF',
        JSON.stringify({
          sessionId,
          model,
          effort: 'low',
          observedModel,
          cwd,
          driver: row()?.selectedDriverId,
          resume: row()?.resume,
          firstReply: token,
          secondReply: 'STILL_ALIVE',
          status: row()?.status,
        }),
      )
    } finally {
      await daemon?.close({ reapSessions: true })
      await server?.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 300_000)

  // POD-4638: Stop wrote one Esc, which opencode 1.18 reads only as "esc again
  // to interrupt" — the turn ran to its end, ~30 s later. The verdict matters
  // as much as the timing: `interrupted` exists only where opencode recorded
  // an abort, so a turn that finished by itself cannot pass.
  it('Stop ends a running turn as interrupted within seconds', async () => {
    const model = process.env.PODIUM_OPENCODE_TEST_MODEL
    if (!model) throw new Error('Set PODIUM_OPENCODE_TEST_MODEL to an authorized live model')
    const root = mkdtempSync(join(tmpdir(), 'pod4638-'))
    const home = join(root, 'home')
    const cwd = join(root, 'repo')
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
    try {
      mkdirSync(cwd, { recursive: true })
      seedOpencodeLogin(home)
      const srv = await startServer({ port: 0 })
      server = srv
      daemon = await startEnrolledDaemon(srv, root, home)
      const sessions = srv.registry.modules.sessions
      const { sessionId } = await sessions.createSession({
        agentKind: 'opencode',
        cwd,
        model,
        effort: 'low',
        runtimeContract: 'generic-pty',
        initialPrompt:
          'Write the numbers from 1 to 400, each on its own line with one short sentence about it. Do not use any tools.',
      })
      const state = () => sessions.sessions.get(sessionId)?.agentState
      await waitFor(() => state()?.phase === 'working', 'the long turn to start')
      // The tester's timing: Stop a few seconds into the answer.
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      expect(state()?.phase).toBe('working')
      const stoppedAt = Date.now()
      // The server call the chat composer's Stop reaches (sessions.interrupt).
      await expect(sessions.interruptTurn({ sessionId })).resolves.toMatchObject({ ok: true })
      await waitFor(() => state()?.phase === 'idle', 'the stopped turn to end', 60_000)
      const endedAfterMs = Date.now() - stoppedAt
      expect(state()?.idle?.kind).toBe('interrupted')
      expect(endedAfterMs).toBeLessThan(10_000)
      console.log('OPENCODE_PTY_STOP', JSON.stringify({ sessionId, model, endedAfterMs, idle: state()?.idle }))
    } finally {
      await daemon?.close({ reapSessions: true })
      await server?.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 300_000)
})
