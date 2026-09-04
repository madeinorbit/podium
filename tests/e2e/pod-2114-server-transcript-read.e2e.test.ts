/**
 * POD-2114 VERIFICATION LANE — the read path the bug was actually reported on.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS ALONGSIDE opencode-server.e2e.test.ts
 * ---------------------------------------------------------------------------
 *
 * The acceptance lane asserts the reply renders via `sessions.transcriptFor()`.
 * That is the in-process ring buffer on the session's terminal object, fed by
 * live `transcriptDelta` frames (session-meta-ops.ts → terminal.ts). It fills
 * whether or not the row ever learned its opencode session id — which is why it
 * stayed GREEN throughout the window in which POD-2114 was reproducible.
 *
 * The bug was reported on the OTHER store. `sessions.read` (and the web chat's
 * `sessions.transcriptRead`) both go through `rpc.readTranscript`, which serves
 * from the lake mirror or a daemon-resolved harness transcript source — and BOTH
 * of those are keyed on the session row's `resume.value`:
 *
 *   lake.ts        `const nativeId = session.resume?.value; if (!nativeId) return undefined`
 *   opencode.ts    `if (!input.resumeValue) return { readSlice: async () => ({items: [], hasMore: false}) }`
 *
 * With `resume` null, the reader falls through to an empty page and chat renders
 * nothing while opencode's own store holds the whole exchange. That is exactly
 * the reported `{items: [], cursor: null, hasMore: false}` for a completed turn.
 *
 * So this lane pins the thing the fix (435f834f8, `reportResumeRef` on launch and
 * adopt) actually changed: the row carries an exact `ses_…` ref, and the
 * resume-keyed read returns the conversation rather than an empty page.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { gateOpencodeVersion, OPENCODE_VERSION_PROBE_TIMEOUT_MS } from '@podium/agent-runtime'
import {
  readOrCreateDaemonSecret,
  readOrCreateLocalMachineId,
  stateDir,
} from '@podium/runtime/local-machine'
import { afterAll, describe, expect, it } from 'vitest'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { startServer } from '../../apps/server/src/server'
import { applyHarnessEnv, reapHarnessSessions } from './harness-env'

// Own isolation port, distinct from every other lane (9925 is the acceptance
// lane this one complements).
const ISOLATION_PORT = 9931
reapHarnessSessions(ISOLATION_PORT)
applyHarnessEnv(ISOLATION_PORT)
afterAll(() => reapHarnessSessions(ISOLATION_PORT))

const hostMachineId = (): string => readOrCreateLocalMachineId()

function drivableOpencode(): boolean {
  if (process.env.PODIUM_OPENCODE_LIVE !== '1') return false
  try {
    const version = execFileSync('opencode', ['--version'], {
      encoding: 'utf8',
      timeout: OPENCODE_VERSION_PROBE_TIMEOUT_MS,
    }).trim()
    return gateOpencodeVersion(version) === null
  } catch {
    return false
  }
}

const live = drivableOpencode()

const MODEL = process.env.PODIUM_OPENCODE_TEST_MODEL ?? 'opencode/laguna-s-2.1-free'

async function waitFor(pred: () => boolean, timeoutMs = 30_000, what = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor(${what}): timed out`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe.skipIf(!live)('e2e: POD-2114 — a server session is readable through sessions.read', () => {
  it('carries an exact resume ref and serves the turn from the resume-keyed source', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'podium-pod2114-'))
    mkdirSync(join(tmp, 'hooks'), { recursive: true })

    const srv = await startServer()
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${srv.port}`,
      bootstrapToken: readOrCreateDaemonSecret(stateDir()),
      machineId: hostMachineId(),
      identityDir: tmp,
      backend: 'none',
      // homeDir IS THE READ PATH, not incidental test furniture. `sourceForRead`
      // passes `ctx.homeDir` (which daemon options take from `discovery.homeDir`)
      // to `opencodeDbSource`, which derives `<home>/.local/share/opencode/opencode.db`.
      // The acceptance lane points this at its mkdtemp — harmless there, because
      // it only ever asserts the in-memory buffer. Here it would guarantee a miss:
      // the `opencode serve` this daemon launches inherits the REAL home and
      // writes its rows there, so a temp homeDir makes the reader open a database
      // that does not exist and answer an empty page for reasons that have
      // nothing to do with POD-2114. Point both halves at the same home.
      //
      // AND THE MISS IS SILENT, which is what makes this a trap rather than a
      // nuisance. `openOpencodeDb` returns undefined for a database that is not
      // there and `opencodeDbSource` swallows it — `catch { return {items: [],
      // hasMore: false} }` — so a wrong home produces EXACTLY the shape this
      // lane exists to catch: `{items: [], cursor: null, hasMore: false}` for a
      // completed exchange, indistinguishable from the original bug. It failed
      // this way for me first, and reporting that as a surviving defect would
      // have been wrong. If this lane ever goes red, confirm the home before
      // concluding anything: open the DB directly with the `ses_…` id from the
      // failure and see whether the rows are there.
      discovery: { background: false, cachePath: join(tmp, 'discovery.db'), homeDir: homedir() },
      metrics: { background: false },
      hooks: { port: 0, settingsDir: join(tmp, 'hooks') },
      agentRelay: { port: 0 },
    })

    const sessions = srv.registry.modules.sessions
    const gateway = sessions.runtimeGateway

    try {
      await waitFor(
        () =>
          srv.registry.modules.machines.listMachines().find((m) => m.id === hostMachineId())
            ?.online === true,
        30_000,
        'machine online',
      )

      const { sessionId } = sessions.createSession({
        agentKind: 'opencode',
        cwd: tmp,
        model: MODEL,
        runtimeContract: 'opencode-server',
      })
      await waitFor(
        () => sessions.listSessions().find((s) => s.sessionId === sessionId)?.status === 'live',
        90_000,
        'session live',
      )

      // ---- THE STRUCTURAL FIX ---------------------------------------------
      //
      // `resumeRefTiming: 'spawn'` means the id exists the moment `POST /session`
      // returns, so this needs no turn to have happened. A null here IS the bug:
      // every resume-keyed reader below would return an empty page.
      await waitFor(
        () => sessions.listSessions().find((s) => s.sessionId === sessionId)?.resume != null,
        60_000,
        'row carries a resume ref',
      )
      const row = sessions.listSessions().find((s) => s.sessionId === sessionId)
      expect(row?.resume?.kind).toBe('opencode-session')
      expect(row?.resume?.value, 'resume ref should be an opencode ses_ id').toMatch(/^ses_/)

      // ---- A REAL TURN -----------------------------------------------------
      const receipt = await gateway.send({
        sessionId,
        text: 'Reply with exactly the word: pong',
        origin: 'human',
        delivery: 'when-ready',
      })
      expect(receipt.outcome, `receipt was ${JSON.stringify(receipt)}`).toBe('accepted')

      const phaseOf = (): string | undefined =>
        sessions.listSessions().find((s) => s.sessionId === sessionId)?.agentState?.phase
      await waitFor(() => phaseOf() === 'working', 60_000, 'badge working')
      await waitFor(() => phaseOf() === 'idle', 180_000, 'badge idle')

      // ---- THE READ THAT WAS EMPTY ----------------------------------------
      //
      // `readToolkit.read` is exactly what the `sessions.read` procedure calls
      // (queries.ts: `s.modules.readToolkit.read(input, …)`), so this is the
      // reported surface rather than a near neighbour of it. Polled, because the
      // lake mirror and the daemon round-trip are both asynchronous with respect
      // to the turn ending.
      const readToolkit = srv.registry.modules.readToolkit
      let lastRead: Awaited<ReturnType<typeof readToolkit.read>> | undefined
      const start = Date.now()
      while (Date.now() - start < 120_000) {
        lastRead = await readToolkit.read({ sessionId, turns: 20 }, 'operator')
        if (lastRead.items.some((i) => i.role === 'assistant' && /pong/i.test(i.text ?? ''))) break
        await new Promise((r) => setTimeout(r, 1000))
      }

      // ---- DIAGNOSTICS, so one run localises a failure -------------------
      const rowNow = sessions.listSessions().find((s) => s.sessionId === sessionId)
      console.log('[pod-2114] resume ref      :', JSON.stringify(rowNow?.resume))
      console.log('[pod-2114] status/phase    :', rowNow?.status, rowNow?.agentState?.phase)
      console.log('[pod-2114] sessions.read   :', JSON.stringify(lastRead))
      console.log(
        '[pod-2114] transcriptFor  :',
        JSON.stringify(sessions.transcriptFor(sessionId).map((i) => ({ r: i.role, t: i.text?.slice(0, 60) }))),
      )
      try {
        const direct = await srv.registry.modules.rpc.readTranscript(
          { sessionId, direction: 'before', limit: 20 },
          { kind: 'system', id: 'pod-2114-verify' },
        )
        console.log('[pod-2114] rpc.readTranscript:', JSON.stringify(direct).slice(0, 2000))
      } catch (err) {
        console.log('[pod-2114] rpc.readTranscript threw:', String(err))
      }

      // The exact shape the bug report quoted, asserted as an absence.
      expect(
        lastRead?.items.length ?? 0,
        `sessions.read returned ${JSON.stringify(lastRead)} — the POD-2114 symptom`,
      ).toBeGreaterThan(0)
      expect(
        lastRead?.items.some((i) => i.role === 'assistant' && /pong/i.test(i.text ?? '')),
        `no assistant reply in the resume-keyed read: ${JSON.stringify(lastRead)}`,
      ).toBe(true)
      expect(
        lastRead?.items.some((i) => i.role === 'user'),
        `no user turn in the resume-keyed read: ${JSON.stringify(lastRead)}`,
      ).toBe(true)
    } finally {
      await daemon.close({ reapSessions: true })
      await srv.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 600_000)
})

describe.skipIf(live)('e2e: POD-2114 verification lane — skipped', () => {
  it('says so rather than passing silently', () => {
    expect(process.env.PODIUM_OPENCODE_LIVE).not.toBe('1')
  })
})
