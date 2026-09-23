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

async function waitFor(pred: () => boolean, timeoutMs = 15_000, what = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('e2e: a send to an ended claude-code session', () => {
  it('wakes it and types the message into the resumed CLI', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'podium-resume-send-'))
    const record = join(tmp, 'typed.log')
    writeFileSync(record, '')
    const recorder = join(tmp, 'recorder.cjs')
    writeFileSync(recorder, RECORDER)
    const nativeId = 'e2e-resume-send-native'
    const transcriptPath = join(tmp, `${nativeId}.jsonl`)
    writeFileSync(transcriptPath, '')
    mkdirSync(join(tmp, 'hooks'), { recursive: true })
    process.env.PODIUM_TEST_RECORD = record

    const launches: string[][] = []
    const launch: NonNullable<DaemonOptions['launch']> = (...args: unknown[]) => {
      launches.push(args.map((a) => JSON.stringify(a)))
      return { cmd: process.execPath, args: [recorder], cwd: tmp }
    }

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
      backend: 'none',
      discovery: { background: false, cachePath: join(tmp, 'discovery.db'), homeDir: tmp },
      metrics: { background: false },
      hooks: { port: 0, settingsDir: join(tmp, 'hooks') },
      agentRelay: { port: 0 },
    })
    const sessions = srv.registry.modules.sessions
    const postHook = (sessionId: string, payload: Record<string, unknown>): Promise<Response> =>
      fetch(`http://127.0.0.1:${daemon.hookPort}/hooks/${sessionId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: nativeId, transcript_path: transcriptPath, cwd: tmp, ...payload }),
      })
    const row = (sessionId: string) => sessions.listSessions().find((s) => s.sessionId === sessionId)
    const typed = (): string => (existsSync(record) ? readFileSync(record, 'utf8') : '')
    const transcriptTurn = (prompt: string, answer: string): void => {
      const at = new Date().toISOString()
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({ type: 'user', uuid: `u-${prompt}`, sessionId: nativeId, timestamp: at, message: { role: 'user', content: prompt } })}\n` +
          `${JSON.stringify({ type: 'assistant', uuid: `a-${prompt}`, sessionId: nativeId, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })}\n`,
      )
    }

    try {
      await waitFor(
        () => srv.registry.modules.machines.listMachines().find((m) => m.id === hostMachineId())?.online === true,
        15_000,
        'machine online',
      )
      const { sessionId } = sessions.createSession({ agentKind: 'claude-code', cwd: tmp })
      await waitFor(() => row(sessionId)?.status === 'live', 15_000, 'first launch live')

      // One ordinary turn, so the session is idle with a resume ref — the state
      // the tester ended it from.
      const firstText = 'first turn before the end'
      const first = sessions.receiptSend('now', { sessionId, text: firstText })
      await waitFor(() => typed().includes(firstText), 20_000, 'first turn typed')
      await postHook(sessionId, { hook_event_name: 'UserPromptSubmit', prompt: firstText })
      transcriptTurn(firstText, 'ok')
      await postHook(sessionId, { hook_event_name: 'Stop' })
      expect(await first).toMatchObject({ ok: true })

      // ---- End session ------------------------------------------------------
      const ended = await sessions.hibernateSession({ sessionId })
      expect(ended).toMatchObject({ ok: true })
      await waitFor(() => row(sessionId)?.status === 'hibernated', 15_000, 'hibernated')
      writeFileSync(record, '')

      // ---- the phone send wakes it ------------------------------------------
      const phoneText = 'phone message after the end'
      const sent = sessions.receiptSend('wake', { sessionId, text: phoneText })
      await waitFor(() => row(sessionId)?.status === 'live', 20_000, 'resumed live')
      // NO hook here, and that is the case under test: Claude Code posts nothing
      // at interactive boot, `--resume` included — its first hook is the
      // UserPromptSubmit of the prompt somebody types. A resumed session that
      // waits for a hook before it will type is waiting for itself.

      await waitFor(() => typed().includes(phoneText), 40_000, 'the phone message typed into the resumed CLI')
      await postHook(sessionId, { hook_event_name: 'UserPromptSubmit', prompt: phoneText })
      await sent
    } finally {
      console.log('launches', JSON.stringify(launches).slice(0, 2000))
      await daemon.close({ reapSessions: true })
      await srv.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 120_000)
})
