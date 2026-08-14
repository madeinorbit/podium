/**
 * THE EPIC'S ACCEPTANCE, END TO END (POD-1761 W5; plan §5 "E2E").
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES THAT NOTHING ELSE DOES
 * ---------------------------------------------------------------------------
 *
 * The conformance corpus drives the driver directly against a fake opencode; the
 * live-secret file proves the real binary enforces its credential. Neither of
 * them answers the question this file exists for: does a session spawned through
 * the SERVER — with no PTY anywhere in the picture — actually work?
 *
 * So this lane starts a real server, a real daemon, and a real `opencode serve`
 * under a systemd scope, spawns an opencode session with the per-spawn driver
 * override, and drives it the way the web UI does: through the session gateway,
 * reading the same session row and the same transcript the UI reads. Every layer
 * between is real — the RPC correlator, the `runtimeSendRequest` frame, its
 * plane classification, the daemon's control-registry dispatch, the driver's
 * HTTP client, opencode's own API, and the translation back onto
 * `transcriptDelta`/`agentState` that lets a PTY-shaped UI render a session with
 * no PTY.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS OPT-IN, AND WHY THAT IS NOT A DODGE
 * ---------------------------------------------------------------------------
 *
 * It needs a real opencode binary in the pinned range AND a real model
 * credential, so it cannot be a default gate: a suite that is occasionally red
 * because a provider was slow is a suite people stop reading. `PODIUM_OPENCODE_LIVE=1`
 * turns it on, the issue records the run and its output, and the layers BELOW it
 * — every one listed above except opencode's own inference — are covered
 * unconditionally by the corpus and the daemon unit tests.
 *
 * The model is deliberately a free one: this lane is about plumbing, and a
 * plumbing test should not be a bill.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// Own isolated state dir / port (relay 9921, multi-machine 9922, split-local
// 9923, runtime-contract 9924).
const ISOLATION_PORT = 9925
reapHarnessSessions(ISOLATION_PORT)
applyHarnessEnv(ISOLATION_PORT)
afterAll(() => reapHarnessSessions(ISOLATION_PORT))

const hostMachineId = (): string => readOrCreateLocalMachineId()

function drivableOpencode(): boolean {
  if (process.env.PODIUM_OPENCODE_LIVE !== '1') return false
  try {
    // THE SHARED BUDGET, not a number picked here. A gating probe that times
    // out makes this lane decide it cannot run and SKIP ITSELF — so a 15s budget
    // against a command measured at 11–15s meant the acceptance lane opted out
    // on exactly the loaded machines where it mattered most, and reported green
    // while testing nothing.
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

/** A free model on opencode's own gateway — plumbing, not a bill. */
const MODEL = process.env.PODIUM_OPENCODE_TEST_MODEL ?? 'opencode/laguna-s-2.1-free'

async function waitFor(pred: () => boolean, timeoutMs = 30_000, what = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor(${what}): timed out`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe.skipIf(!live)('e2e: an opencode session on the SERVER driver', () => {
  it('spawns, answers, renders, interrupts and parks', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'podium-opencode-e2e-'))
    mkdirSync(join(tmp, 'hooks'), { recursive: true })

    const srv = await startServer()
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${srv.port}`,
      bootstrapToken: readOrCreateDaemonSecret(stateDir()),
      machineId: hostMachineId(),
      identityDir: tmp,
      // NO `launch` OVERRIDE, and that is the point: a server-family session
      // never reaches the PTY launch path at all. If this driver were secretly
      // spawning a terminal, the absence of a fixture launcher here would show
      // it — the real harness binary would run instead.
      backend: 'none',
      discovery: { background: false, cachePath: join(tmp, 'discovery.db'), homeDir: tmp },
      metrics: { background: false },
      hooks: { port: 0, settingsDir: join(tmp, 'hooks') },
      agentRelay: { port: 0 },
    })

    const sessions = srv.registry.modules.sessions
    const gateway = sessions.runtimeGateway
    const interactions = srv.registry.modules.interactions

    try {
      await waitFor(
        () =>
          srv.registry.modules.machines.listMachines().find((m) => m.id === hostMachineId())
            ?.online === true,
        30_000,
        'machine online',
      )

      // ---- 1. SPAWN ON THE SERVER DRIVER ---------------------------------
      //
      // The per-spawn override, which is the whole selection story: default
      // stays terminal, and this one session says otherwise.
      const { sessionId } = sessions.createSession({
        agentKind: 'opencode',
        cwd: tmp,
        model: MODEL,
        runtimeContract: 'opencode-server',
      })
      // `bind` is what flips the row live, and for this family it is sent by the
      // driver's own launch rather than by a PTY coming up.
      await waitFor(
        () => sessions.listSessions().find((s) => s.sessionId === sessionId)?.status === 'live',
        90_000,
        'session live',
      )

      // ---- 1b. THE ROW KNOWS IT IS BEHIND THE CONTRACT --------------------
      //
      // `bind.runtimeContract` is what W4's migrated senders branch on to choose
      // between the contract and the legacy PTY path. A server-family session
      // that reported `false` here would be handed to a path that types at a PTY
      // it does not have — the write would go nowhere and report success — so
      // this is asserted on the ROW the server actually recorded, not on the
      // daemon's intent.
      // Read off the INTERNAL session record, which is the exact object
      // `onContract` consults (`bag.sessions.get(id)?.runtimeContract === true`
      // in session-wiring). The wire `SessionMeta` does not carry the field —
      // it is a daemon-reported bind fact for the server's own routing, not
      // something a client renders — so asserting the projection would have
      // asserted nothing.
      expect(sessions.sessions.get(sessionId)?.runtimeContract).toBe(true)

      // ---- 2. A TURN, WITH A PROTOCOL RECEIPT -----------------------------
      const receipt = await gateway.send({
        sessionId,
        text: 'Reply with exactly the word: pong',
        origin: 'human',
        delivery: 'when-ready',
      })
      // The message carries the receipt because a bare 'expected refused to be
      // accepted' says nothing about WHY — and the two refusals this can produce
      // (`not_running` from a handle nobody registered, `needs_user` from an ask
      // nobody answered) want completely different fixes.
      expect(receipt.outcome, `receipt was ${JSON.stringify(receipt)}`).toBe('accepted')
      if (receipt.outcome !== 'accepted') return
      // THE FAMILY'S WHOLE CLAIM IN ONE FIELD. Not `transcript-echo`, not a
      // hook, and above all not `unverified`: opencode acknowledged the turn.
      expect(receipt.provenBy).toBe('protocol-ack')
      expect(receipt.deliveredAs).toBe('when-ready')
      expect(receipt.turnEpoch).toBeGreaterThan(0)

      // ---- 3. THE STATE BADGE TRACKS working → idle -----------------------
      const phaseOf = (): string | undefined =>
        sessions.listSessions().find((s) => s.sessionId === sessionId)?.agentState?.phase
      await waitFor(() => phaseOf() === 'working', 60_000, 'badge working')
      await waitFor(() => phaseOf() === 'idle', 180_000, 'badge idle')

      // ---- 4. THE REPLY RENDERS IN CHAT -----------------------------------
      //
      // Read from the SESSION's transcript — the same buffer the web UI renders
      // — rather than from the driver, because the thing under test is the
      // translation onto `transcriptDelta` that makes a PTY-shaped UI work for a
      // session that has no PTY.
      await waitFor(
        () =>
          sessions
            .transcriptFor(sessionId)
            .some((item) => item.role === 'assistant' && /pong/i.test(item.text ?? '')),
        60_000,
        'assistant reply in the session transcript',
      )
      // …and the user's own turn is there too, which is what proves the item
      // stream is the session's and not a one-way echo of the model.
      expect(
        sessions.transcriptFor(sessionId).some((item) => item.role === 'user'),
      ).toBe(true)

      // ---- 5. INTERRUPT ----------------------------------------------------
      //
      // REQUESTS a fence; the fence itself arrives on the causal stream when
      // opencode confirms the turn ended. What crosses the wire here is the
      // request, and `{ok: true}` is the honest report of that.
      expect(await gateway.interrupt(sessionId)).toEqual({ ok: true })

      // ---- 6. AN OPEN ASK IS AN ENUMERABLE ASK ----------------------------
      //
      // Not forced here: whether this turn trips a permission depends on the
      // model's own tool use, so the assertion is about the AGGREGATE's shape
      // rather than about the model's behaviour. What is pinned is that every
      // ask this session produced arrived as a PROTOCOL ask with a real request
      // id — which is what makes it answerable over REST rather than by typing
      // digits at a terminal that does not exist.
      for (const open of interactions.listForSession(sessionId)) {
        expect(open.source).toBe('protocol')
        expect(open.answerable).toBe('structured')
        expect(['permission', 'question']).toContain(open.kind)
      }

      // ---- 7. HIBERNATE ----------------------------------------------------
      //
      // NOT "and resume": there is no server-family revival path in the daemon
      // yet, so nothing here can call `driver.resume()` end to end. It is
      // implemented and covered against the fake by the conformance corpus, and
      // the acceptance doc marks the live half `[~]` rather than claiming it.
      //
      // The server process dies and the CONVERSATION does not — it is rows in a
      // database that outlives it. That is the property that makes a
      // server-family session cheap to park, and `resumeRefTiming: 'spawn'` is
      // why this verb never has to refuse.
      expect(await gateway.lifecycle(sessionId, 'hibernate')).toEqual({ ok: true })
      const parked = await gateway.send({
        sessionId,
        text: 'anyone home?',
        origin: 'steward',
        delivery: 'when-ready',
      })
      expect(parked.outcome).toBe('refused')
      if (parked.outcome === 'refused') expect(parked.refusal.reason).toBe('not_running')
    } finally {
      await daemon.close({ reapSessions: true })
      await srv.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 600_000)
})

describe.skipIf(live)('e2e: opencode server driver — LIVE lane skipped', () => {
  it('says so rather than passing silently', () => {
    // A green line that reads "skipped" is a fact a reviewer can act on. What is
    // NOT skipped, and covers every layer below opencode's own inference: the
    // conformance corpus (26 properties against a real listener), the recorded
    // protocol fixtures, the version gate, and the daemon's own unit tests.
    expect(process.env.PODIUM_OPENCODE_LIVE).not.toBe('1')
  })
})
