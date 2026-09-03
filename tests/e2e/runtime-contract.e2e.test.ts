/**
 * THE FLAG-ON LANE for the Agent Runtime contract (POD-1761 W3; plan §6).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES THAT NOTHING ELSE DOES
 * ---------------------------------------------------------------------------
 *
 * The conformance corpus drives the driver DIRECTLY, in one process, with a
 * fixture world. That is the right shape for the contract's properties and the
 * wrong shape for the question this file answers: does a turn actually cross the
 * wire? Everything between `SessionRuntimeGateway.send()` and a byte arriving at
 * a PTY is untested by the corpus — the RPC correlator, the `runtimeSendRequest`
 * frame, its plane classification, the daemon's control-registry dispatch, the
 * flag being read at bootstrap, the driver being registered by the spawn path,
 * and the receipt finding its way back to the caller that is waiting on it.
 *
 * So this lane starts a REAL server and a REAL daemon, sets the flag, spawns a
 * session, and drives it through the gateway. The plan's acceptance names this
 * lane specifically, and its absence was a finding against the first landing.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT PROVE
 * ---------------------------------------------------------------------------
 *
 * The agent is a fixture TUI, not Claude — the same choice every other e2e here
 * makes, because a real harness is not installable in CI and a test that skips
 * when it is missing proves nothing on the day it matters. The transcript
 * therefore comes from a Claude-shaped JSONL this file writes and a hook this
 * file posts, which is exactly how the daemon learns about a transcript in
 * production: `transcript_path` on a hook payload. That makes the ECHO path real
 * plumbing (tail → `transcriptDelta` → the driver's reset-aware count) and the
 * HOOK path real plumbing (hook ingest → the driver's waiter), while the thing
 * being echoed is ours.
 *
 * `state()`, `transcript.history()` and `snapshot()` are contract verbs with no
 * wire frame (see `packages/protocol/src/messages/runtime.ts`), so they cannot
 * be reached from here at all. The corpus covers them; this file says so rather
 * than implying coverage it does not have.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readOrCreateDaemonSecret,
  readOrCreateLocalMachineId,
  stateDir,
} from '@podium/runtime/local-machine'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterAll, describe, expect, it } from 'vitest'
import { type DaemonOptions, startDaemon } from '../../apps/daemon/src/daemon'
import type { AppRouter } from '../../apps/server/src/router'
import { startServer } from '../../apps/server/src/server'
import { applyHarnessEnv, reapHarnessSessions } from './harness-env'

// Own isolated state dir / port (relay 9921, multi-machine 9922, split-local 9923).
const ISOLATION_PORT = 9924
reapHarnessSessions(ISOLATION_PORT)
applyHarnessEnv(ISOLATION_PORT)
afterAll(() => reapHarnessSessions(ISOLATION_PORT))

const FIXTURE = fileURLToPath(
  new URL('../../packages/pty/test/fixtures/fixture-tui.mjs', import.meta.url),
)
const fixtureLaunch: NonNullable<DaemonOptions['launch']> = () => ({
  cmd: process.execPath,
  args: [FIXTURE],
  cwd: '/tmp',
})

const hostMachineId = (): string => readOrCreateLocalMachineId()

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('e2e: a session driven through the Agent Runtime contract', () => {
  it('carries a turn from the server gateway to the PTY and a receipt back', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'podium-runtime-contract-'))
    const transcriptPath = join(tmp, 'session-transcript.jsonl')
    writeFileSync(transcriptPath, '')
    mkdirSync(join(tmp, 'hooks'), { recursive: true })

    // THE FLAG, set before the daemon boots. `runtimeContractEnabledByEnv` is
    // read ONCE at bootstrap on purpose — a session's driving must not change
    // under it mid-life — so setting it after `startDaemon` would silently test
    // the flag-off path while claiming otherwise.
    const previousFlag = process.env.PODIUM_RUNTIME_CONTRACT
    process.env.PODIUM_RUNTIME_CONTRACT = '1'

    const srv = await startServer()
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${srv.port}`,
      bootstrapToken: readOrCreateDaemonSecret(stateDir()),
      machineId: hostMachineId(),
      identityDir: tmp,
      launch: fixtureLaunch,
      backend: 'none',
      discovery: { background: false, cachePath: join(tmp, 'discovery.db'), homeDir: tmp },
      metrics: { background: false },
      hooks: { port: 0, settingsDir: join(tmp, 'hooks') },
      agentRelay: { port: 0 },
    })

    const sessions = srv.registry.modules.sessions
    const gateway = sessions.runtimeGateway
    const postHook = (sessionId: string, payload: Record<string, unknown>): Promise<Response> =>
      fetch(`http://127.0.0.1:${daemon.hookPort}/hooks/${sessionId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })

    try {
      await waitFor(
        () =>
          srv.registry.modules.machines.listMachines().find((m) => m.id === hostMachineId())
            ?.online === true,
      )

      // A HARNESS KIND, not a shell: the flag only reaches a kind whose manifest
      // declares a terminal runtime, and `terminalProfileFor` returns undefined
      // for a shell by design — there are no turns to be honest about.
      const { sessionId } = sessions.createSession({ agentKind: 'claude-code', cwd: tmp })
      await waitFor(
        () => sessions.listSessions().find((s) => s.sessionId === sessionId)?.status === 'live',
      )

      // ---- 0. hibernate REFUSES before the harness has minted a resume ref -
      //
      // Asserted HERE, before any hook, because that ordering is the whole
      // point: the ref arrives on the harness's own `session_id`, and until it
      // does, parking the session would be data loss wearing a lifecycle verb's
      // name. The driver is the only party that knows which side of that line a
      // session is on, which is why the refusal is its answer and not the
      // server's guess.
      expect(await gateway.lifecycle(sessionId, 'hibernate')).toMatchObject({
        reason: 'no_resume_ref',
      })

      // Bind the observer's transcript tail the way production does: a hook
      // payload carrying `transcript_path`. Without this the driver has no echo
      // channel at all, which is a real state (and the one the next assertion
      // exercises) but not the one this first send is about.
      await postHook(sessionId, {
        hook_event_name: 'SessionStart',
        session_id: 'native-runtime-contract',
        transcript_path: transcriptPath,
        cwd: tmp,
      })

      // ---- 1. a send crosses the wire and comes back as a receipt ----------
      //
      // NOT `not_running`, which is what a session that never reached a driver
      // answers — so this single assertion covers the flag, the spawn-path
      // registration, the frame, its routing and the correlator in one.
      const first = gateway.send({
        sessionId,
        text: 'first turn through the contract',
        origin: 'human',
        delivery: 'when-ready',
      })
      // The causal accept, posted while the send is still inside its window —
      // the same ordering production has, where the CLI fires the hook on submit.
      await new Promise((resolve) => setTimeout(resolve, 300))
      await postHook(sessionId, {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'native-runtime-contract',
        transcript_path: transcriptPath,
        cwd: tmp,
        prompt: 'first turn through the contract',
      })
      const accepted = await first
      expect(accepted.outcome).toBe('accepted')
      if (accepted.outcome !== 'accepted') return
      // Anchored to the hook, not to an echo that happened to arrive.
      expect(accepted.provenBy).toBe('hook')
      expect(accepted.deliveredAs).toBe('when-ready')

      // ---- 2. no proof inside the window is `unverified`, not a guess -------
      const unverified = await gateway.send({
        sessionId,
        text: 'nothing will confirm this one',
        origin: 'steward',
        delivery: 'when-ready',
      })
      expect(unverified.outcome).toBe('unverified')
      if (unverified.outcome !== 'unverified') return
      // The window the driver actually waited — the derived 4.8s ladder, not an
      // RPC timeout standing in for it.
      expect(unverified.verificationWindowMs).toBe(4800)

      // ---- 3. `queue` completes on the server and never crosses the wire ----
      const queued = await gateway.send({
        sessionId,
        text: 'later, durably',
        origin: 'mail',
        delivery: 'queue',
      })
      expect(queued.outcome).toBe('queued')
      if (queued.outcome !== 'queued') return
      expect(queued.position).toBeGreaterThan(0)
      // The durable FIFO is a server table, which is the whole reason this
      // delivery is answered here: the row survives a daemon restart, a machine
      // going offline and a parked session, none of which a machine-local queue
      // could promise.
      expect(
        sessions.listSessions().find((s) => s.sessionId === sessionId)?.queuedMessageCount,
      ).toBeGreaterThan(0)

      // ---- 4. interrupt REQUESTS a fence, over the same path ---------------
      expect(await gateway.interrupt(sessionId)).toEqual({ ok: true })

      // ---- 5. hibernate accepts once the harness HAS minted one -------------
      //
      // The ref reached the driver on the `session_id` the hooks above carried —
      // captured as early as the harness allows, which is what
      // `resumeRefTiming: 'first-turn'` declares — so the same verb that refused
      // at step 0 now parks the session.
      expect(await gateway.lifecycle(sessionId, 'hibernate')).toEqual({ ok: true })

      // ---- 6. a parked session refuses, and says why ------------------------
      //
      // ASSERTED ON THE DRIVER, not on the session row. `hibernate` through the
      // contract is the MACHINE half of the survival table — drop the bridge,
      // reap the durable host — and the row's `status` is the server's own,
      // flipped by the server's hibernate command. W4 is what joins the two.
      // Waiting on the row here would be asserting somebody else's transition
      // and calling it this one's.
      const afterPark = await gateway.send({
        sessionId,
        text: 'anyone home?',
        origin: 'steward',
        delivery: 'when-ready',
      })
      expect(afterPark.outcome).toBe('refused')
      if (afterPark.outcome === 'refused') {
        expect(afterPark.refusal.reason).toBe('not_running')
      }
    } finally {
      await daemon.close({ reapSessions: true })
      await srv.close()
      if (previousFlag === undefined) delete process.env.PODIUM_RUNTIME_CONTRACT
      else process.env.PODIUM_RUNTIME_CONTRACT = previousFlag
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 90_000)

  it('leaves the legacy path alone when the flag is off', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'podium-runtime-contract-off-'))
    mkdirSync(join(tmp, 'hooks'), { recursive: true })
    const previousFlag = process.env.PODIUM_RUNTIME_CONTRACT
    delete process.env.PODIUM_RUNTIME_CONTRACT

    const srv = await startServer()
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${srv.port}`,
      bootstrapToken: readOrCreateDaemonSecret(stateDir()),
      machineId: hostMachineId(),
      identityDir: tmp,
      launch: fixtureLaunch,
      backend: 'none',
      discovery: { background: false, cachePath: join(tmp, 'discovery.db'), homeDir: tmp },
      metrics: { background: false },
      hooks: { port: 0, settingsDir: join(tmp, 'hooks') },
      agentRelay: { port: 0 },
    })
    const sessions = srv.registry.modules.sessions

    try {
      await waitFor(
        () =>
          srv.registry.modules.machines.listMachines().find((m) => m.id === hostMachineId())
            ?.online === true,
      )
      const { sessionId } = sessions.createSession({ agentKind: 'claude-code', cwd: tmp })
      await waitFor(
        () => sessions.listSessions().find((s) => s.sessionId === sessionId)?.status === 'live',
      )

      // THE OTHER HALF OF "FLAG OFF = ZERO DIFF", and the half a passing suite
      // cannot show on its own: the session is live and healthy on the legacy
      // path, and the contract simply does not reach it. `not_running` here is
      // not a failure — it is the honest answer to "drive this through the
      // contract" for a session that is not behind it.
      const receipt = await sessions.runtimeGateway.send({
        sessionId,
        text: 'should not reach a driver',
        origin: 'human',
        delivery: 'when-ready',
      })
      expect(receipt.outcome).toBe('refused')
      if (receipt.outcome === 'refused') expect(receipt.refusal.reason).toBe('not_running')
      // …and the session it refused for is genuinely alive.
      expect(sessions.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe('live')
    } finally {
      await daemon.close({ reapSessions: true })
      await srv.close()
      if (previousFlag === undefined) delete process.env.PODIUM_RUNTIME_CONTRACT
      else process.env.PODIUM_RUNTIME_CONTRACT = previousFlag
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 60_000)

  /**
   * THROUGH THE DOOR EXTERNAL CALLERS ACTUALLY USE (POD-2113).
   *
   * Every other lane in this file — and the opencode-server one next door —
   * spawns with `sessions.createSession(...)`, an in-process call on the service
   * object. That is a fine way to test the daemon and a useless way to test the
   * API, and the difference cost this epic its headline feature: `sessions.create`'s
   * zod input did not declare `runtimeContract`, so the field was stripped at the
   * boundary and the override worked for NOBODY outside the server process —
   * CLI, web, mobile and scripts alike — while every test above kept passing.
   *
   * So this lane goes over HTTP, through the real router, with a real tRPC
   * client. It asserts on a session that must NOT come up, because that is the
   * only shape of assertion the bug could not have satisfied: the whole failure
   * was a healthy session.
   */
  it('carries a per-spawn driver id across the tRPC boundary, and REFUSES a bogus one', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'podium-runtime-contract-trpc-'))
    mkdirSync(join(tmp, 'hooks'), { recursive: true })
    // NO FLAG. A driver id implies the contract is on, so an operator trying a
    // driver never has to find `PODIUM_RUNTIME_CONTRACT` first — and this lane
    // would quietly stop testing the per-spawn field if it set one.
    const previousFlag = process.env.PODIUM_RUNTIME_CONTRACT
    delete process.env.PODIUM_RUNTIME_CONTRACT

    const srv = await startServer()
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${srv.port}`,
      bootstrapToken: readOrCreateDaemonSecret(stateDir()),
      machineId: hostMachineId(),
      identityDir: tmp,
      launch: fixtureLaunch,
      backend: 'none',
      // THE REAL HOME, UNLIKE EVERY OTHER LANE HERE, because this one spawns
      // through the door that checks. `sessions.create` refuses a harness the
      // MACHINE does not report installed, and that inventory comes from
      // discovery — pointed at an empty tmp home it finds nothing, and the
      // refusal arrives at the server before the daemon is ever asked. The lanes
      // above call `createSession` on an already-warm machine record and never
      // meet the check. Nothing is executed either way: `fixtureLaunch` is still
      // what runs, so this reads the box's harness list without trusting its
      // binaries.
      discovery: { background: false, cachePath: join(tmp, 'discovery.db'), homeDir: homedir() },
      metrics: { background: false },
      hooks: { port: 0, settingsDir: join(tmp, 'hooks') },
      agentRelay: { port: 0 },
    })
    const trpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `http://127.0.0.1:${srv.port}/trpc` })],
    })
    const sessions = srv.registry.modules.sessions

    try {
      // ONLINE IS NOT ENOUGH HERE. The spawn gate reads the machine's INVENTORY,
      // which discovery reports after the connection is up, so waiting only for
      // `online` races it — and loses as a "harness is not installed" error that
      // says nothing about the driver id this lane is actually about.
      await waitFor(() => {
        const machine = srv.registry.modules.machines
          .listMachines()
          .find((m) => m.id === hostMachineId())
        return (
          machine?.online === true &&
          machine.inventory?.agents.some((a) => a.kind === 'opencode' && a.installed) === true
        )
      }, 60_000)

      // THE CONTROL EXPERIMENT FROM THE BUG REPORT, run as a test. A driver id
      // this build does not ship is refused BY NAME at the daemon's registry —
      // and it can only get there if the schema, the service, the spawn frame
      // and the daemon all carried the string intact. One assertion, the whole
      // chain, and it is unsatisfiable by a session that came up fine.
      const { sessionId } = await trpc.sessions.create.mutate({
        agentKind: 'opencode',
        cwd: tmp,
        runtimeContract: 'not-a-real-driver',
      })
      // GENEROUS, BECAUSE THE SPAWN PATH PROBES BEFORE IT REFUSES. The daemon
      // asks `opencode --version` on the way to resolution, and POD-2056
      // measured that at 11–15s on the build host (budget 60s). A tighter
      // deadline here would fail on a loaded box and read as a broken refusal.
      await waitFor(
        () => sessions.listSessions().find((s) => s.sessionId === sessionId)?.status === 'exited',
        90_000,
      )
      // Read back through the wire projection too, because that is where an
      // operator would look: a spawn refusal an operator cannot see is barely
      // better than the silent degrade it replaced.
      const meta = (await trpc.sessions.list.query()).find((s) => s.sessionId === sessionId)
      expect(meta?.status).toBe('exited')
      // THE ID, IN THE MESSAGE. `resolveRuntimeDriver` names what it refused so
      // an operator who typo'd `opencode-sever` sees their own string back;
      // asserting only that SOMETHING failed would pass for any spawn error.
      expect(meta?.spawnFailure).toContain('not-a-real-driver')
      // A SPAWN REFUSAL, NOT A DEATH. `-1` is the code `markSpawnError` stamps;
      // a session that came up on a PTY and then exited would carry the
      // harness's own code and no `spawnFailure` at all. The pair is what
      // separates "never started" from "started and lost", and the bug's whole
      // signature was a session that started.
      expect(meta?.exitCode).toBe(-1)

      // ---- THE POSITIVE HALF: A NAMED DRIVER ACTUALLY RUNS ---------------
      //
      // A refusal test alone can be satisfied by a build that refuses
      // EVERYTHING, so the override is only proven by also spawning one that
      // must succeed — through the same external door.
      //
      // GATED ON THE SAME `PODIUM_OPENCODE_LIVE` AS THE NEIGHBOURING LANE,
      // because this half starts a real opencode server and cannot be faked:
      // the fixture launcher above is a PTY, and a PTY is precisely the thing
      // this assertion has to rule out. The refusal half above needs no such
      // gate and always runs.
      if (process.env.PODIUM_OPENCODE_LIVE === '1') {
        const live = await trpc.sessions.create.mutate({
          agentKind: 'opencode',
          cwd: tmp,
          runtimeContract: 'opencode-server',
        })
        await waitFor(
          () =>
            sessions.listSessions().find((s) => s.sessionId === live.sessionId)?.status === 'live',
          90_000,
        )
        // THE JOURNAL IS THE FAMILY TEST, not `runtimeContract: true` — the
        // terminal driver sets that too, so a spawn that asked for
        // `opencode-server` and silently got a PTY passes the boolean and fails
        // four steps later as an `unverified` receipt. The journal file is
        // written by exactly one thing, this driver's own launch, so its
        // presence is the fact. (Learned by `daemon-restart-adoption.e2e.ts`,
        // which says it cost a run.)
        expect(
          existsSync(
            join(stateDir(), 'opencode-servers', `${encodeURIComponent(live.sessionId)}.json`),
          ),
          'the session is live but has no opencode binding journal, so the driver named through tRPC did NOT take',
        ).toBe(true)
      }
    } finally {
      await daemon.close({ reapSessions: true })
      await srv.close()
      if (previousFlag === undefined) delete process.env.PODIUM_RUNTIME_CONTRACT
      else process.env.PODIUM_RUNTIME_CONTRACT = previousFlag
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 150_000)
})
