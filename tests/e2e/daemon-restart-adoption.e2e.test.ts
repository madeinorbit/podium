/**
 * THE DAEMON DIES AND THE SESSION DOES NOT (POD-2056).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES THAT NOTHING ELSE DOES
 * ---------------------------------------------------------------------------
 *
 * `adopt()` for the opencode server driver is implemented, and four conformance
 * properties pin its CONTRACT behaviour against the real driver: exact
 * process-key match, a health probe with the journalled secret, a monotonic turn
 * epoch, a higher observer generation, and a refusal for a process that did not
 * survive. Every one of those is a statement about the driver in isolation.
 *
 * None of them answers the question an operator actually has, which is about the
 * INTEGRATION: I restarted the daemon — is my session still there? Answering it
 * needs two processes and a signal, because the survivor has to be a process
 * that outlives a pid that goes away. That is what
 * {@link ./daemon-restart-harness.ts} exists for, and this is its first lane.
 *
 * The shape of the run:
 *
 *   1. a real server, a real daemon IN ITS OWN PROCESS, a real `opencode serve`
 *   2. a turn, so the session is demonstrably working before anything breaks
 *   3. SIGKILL — the DAEMON only, and then the proof that only the daemon died:
 *      the journalled endpoint still answers its health probe
 *   4. the daemon comes back on the same state dir, same machine id
 *   5. the session rebinds from the 0600 journal, WITHOUT a second server
 *   6. …and takes another turn, at a higher turn epoch
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS OPT-IN
 * ---------------------------------------------------------------------------
 *
 * Same reason as `opencode-server.e2e.test.ts`, and the same switch: it needs a
 * real opencode in the pinned range and a real model credential, and a gate that
 * goes red because a provider was slow is a gate people stop reading. What is
 * NOT opt-in and covers the layers underneath: the conformance corpus, the
 * daemon's own unit tests, and the harness's own self-check below — which runs
 * unconditionally, because a two-process harness that has quietly stopped being
 * able to start a daemon should fail loudly rather than skip.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gateOpencodeVersion, type RuntimeEvent } from '@podium/agent-runtime'
import type { SessionId } from '@podium/model'
import {
  readOrCreateDaemonSecret,
  readOrCreateLocalMachineId,
  stateDir,
} from '@podium/runtime/local-machine'
import { afterAll, describe, expect, it } from 'vitest'
import { startServer } from '../../apps/server/src/server'
import { startDaemonProcess } from './daemon-restart-harness'
import { applyHarnessEnv, reapHarnessSessions } from './harness-env'

// Own isolated state dir / port (relay 9921, multi-machine 9922, split-local
// 9923, runtime-contract 9924, opencode-server 9925).
const ISOLATION_PORT = 9926
reapHarnessSessions(ISOLATION_PORT)
applyHarnessEnv(ISOLATION_PORT)
afterAll(() => reapHarnessSessions(ISOLATION_PORT))

const hostMachineId = (): string => readOrCreateLocalMachineId()

/**
 * A GENEROUS BUDGET, and the number is a measurement rather than a guess.
 *
 * `opencode --version` forks a ~180MB single-file bundle, which was measured at
 * ~10s cold on this project's build host — and longer while contending with a
 * vitest fork still transforming its module graph. A 15s budget sits inside that
 * variance: the probe throws ETIMEDOUT, the whole live lane skips, and nothing
 * distinguishes "there is no opencode here" from "the box was busy". Ninety
 * seconds is far past any honest version probe and still bounded.
 */
const VERSION_PROBE_TIMEOUT_MS = 90_000

/**
 * Why the live half of this file is, or is not, running.
 *
 * A BOOLEAN WOULD HAVE BEEN ENOUGH TO SKIP, which is exactly the problem: an
 * operator who exported `PODIUM_OPENCODE_LIVE=1` asked for this lane, and a
 * silent skip answers them with a green line. Carrying the reason is what lets
 * the guard at the bottom of this file tell them which refusal they actually
 * hit — and it is not a hypothetical, because the first live run of this lane
 * skipped on the probe timeout above and said nothing about it.
 */
type OpencodeGate = { live: true; probeMs: number } | { live: false; why: string }

/**
 * THE DAEMON'S OWN BUDGET FOR THE SAME PROBE, restated here as a number this
 * lane can compare against.
 *
 * `opencodeVersionDiagnostic()` in `apps/daemon/src/runtime/opencode-server.ts`
 * spawns `opencode --version` with a 15s timeout, and a machine whose probe does
 * not answer inside it is reported as not able to run the driver at all. This
 * lane measures its own probe so a failure downstream can say whether the box
 * was inside that budget — the difference between "this driver is broken" and
 * "this host was too slow to be asked".
 */
const DAEMON_VERSION_PROBE_BUDGET_MS = 15_000

function opencodeGate(): OpencodeGate {
  if (process.env.PODIUM_OPENCODE_LIVE !== '1') {
    return { live: false, why: 'PODIUM_OPENCODE_LIVE is not 1' }
  }
  const started = Date.now()
  let version: string
  try {
    version = execFileSync('opencode', ['--version'], {
      encoding: 'utf8',
      timeout: VERSION_PROBE_TIMEOUT_MS,
    }).trim()
  } catch (err) {
    return {
      live: false,
      why: `\`opencode --version\` did not answer within ${VERSION_PROBE_TIMEOUT_MS}ms: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const probeMs = Date.now() - started
  const diagnostic = gateOpencodeVersion(version)
  if (diagnostic) return { live: false, why: `opencode ${version}: ${diagnostic.title}` }
  return { live: true, probeMs }
}

const gate = opencodeGate()
const live = gate.live

/** A free model on opencode's own gateway — plumbing, not a bill. */
const MODEL = process.env.PODIUM_OPENCODE_TEST_MODEL ?? 'opencode/laguna-s-2.1-free'

/**
 * `detail` is a THUNK, evaluated only on the timeout path.
 *
 * A wait that fails across a process boundary has nothing to say for itself —
 * the thing that did not happen happened (or did not) in another process. So
 * every wait that is really waiting on the DAEMON passes its log here. Lazy
 * because attaching a 6KB tail to every poll of a 120s wait is a cost paid
 * 2400 times to be read zero.
 */
async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  what: string,
  detail?: () => string,
): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor(${what}): timed out after ${timeoutMs}ms${detail ? `\n${detail()}` : ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

// ---------------------------------------------------------------------------
// The binding journal, read the way an OPERATOR would
// ---------------------------------------------------------------------------

/**
 * The journal is read here from the FILE, not through the daemon's journal
 * object, and that is the point of reading it at all: the claim under test is
 * that a *different process* can rebind from it. Going through the writer's own
 * in-memory cache would prove nothing about what actually landed on disk, which
 * is the only thing the restarted daemon will have.
 */
interface JournalledServer {
  baseUrl: string
  username: string
  secret: string
  process: { key: string; pid?: number; scopeUnit?: string }
  turnEpoch: number
  bindingVersion: number
}

const journalPath = (sessionId: SessionId): string =>
  join(stateDir(), 'opencode-servers', `${encodeURIComponent(sessionId)}.json`)

function readJournal(sessionId: SessionId): JournalledServer {
  return JSON.parse(readFileSync(journalPath(sessionId), 'utf8')) as JournalledServer
}

/** One bounded probe with the journalled credential. `false` covers dead,
 *  not-listening AND wrong-secret — all three mean "not usable", which is the
 *  only question a survival check is asking. */
async function serverAnswers(entry: JournalledServer): Promise<boolean> {
  try {
    const response = await fetch(`${entry.baseUrl}/global/health`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${entry.username}:${entry.secret}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(2000),
    })
    return response.ok
  } catch {
    return false
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The harness's own self-check — NOT opt-in
// ---------------------------------------------------------------------------

describe('e2e harness: a daemon in its own process', () => {
  it('starts, reports its pid, survives its parent asking questions, and stops', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'podium-daemon-process-'))
    mkdirSync(join(tmp, 'hooks'), { recursive: true })
    const srv = await startServer()
    try {
      const daemon = await startDaemonProcess({
        dir: join(tmp, 'harness'),
        options: {
          serverUrl: `ws://localhost:${srv.port}`,
          bootstrapToken: readOrCreateDaemonSecret(stateDir()),
          machineId: hostMachineId(),
          identityDir: tmp,
          backend: 'none',
          discovery: { background: false, cachePath: join(tmp, 'discovery.db'), homeDir: tmp },
          metrics: { background: false },
          hooks: { port: 0, settingsDir: join(tmp, 'hooks') },
          agentRelay: { port: 0 },
        },
      })
      try {
        expect(daemon.pid).toBeGreaterThan(1)
        expect(daemon.alive()).toBe(true)
        // The daemon is a real peer of the server, not a library the test
        // called: the machine row is the server's own evidence of a handshake
        // that crossed a socket.
        await waitFor(
          () =>
            srv.registry.modules.machines.listMachines().find((m) => m.id === hostMachineId())
              ?.online === true,
          60_000,
          'machine online',
        )
        await daemon.stop()
        expect(daemon.alive()).toBe(false)
      } finally {
        if (daemon.alive()) await daemon.crash()
      }
    } finally {
      await srv.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

describe.skipIf(!live)('e2e: an opencode session outlives its daemon', () => {
  it('rebinds from the journal after a daemon crash and keeps taking turns', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'podium-daemon-restart-'))
    mkdirSync(join(tmp, 'hooks'), { recursive: true })

    const srv = await startServer()
    const daemonOptions = {
      serverUrl: `ws://localhost:${srv.port}`,
      bootstrapToken: readOrCreateDaemonSecret(stateDir()),
      machineId: hostMachineId(),
      identityDir: tmp,
      // No `launch` override is possible across a process boundary, and none is
      // wanted: a server-family session never reaches the PTY launch path, so
      // there is nothing here for a fixture launcher to stand in for.
      backend: 'none' as const,
      discovery: { background: false, cachePath: join(tmp, 'discovery.db'), homeDir: tmp },
      metrics: { background: false },
      hooks: { port: 0, settingsDir: join(tmp, 'hooks') },
      agentRelay: { port: 0 },
    }

    const sessions = srv.registry.modules.sessions
    const gateway = sessions.runtimeGateway

    const daemon = await startDaemonProcess({
      dir: join(tmp, 'harness'),
      options: daemonOptions,
      // THE DAEMON'S LOG IS THIS LANE'S ONLY NARRATION. Everything it decides —
      // which driver a spawn resolved to, what a reattach found — happens in a
      // process the assertions cannot step into, and at the default level the
      // decisions this lane is about say nothing. Scoped to `daemon:*` so the
      // captured tail is the daemon's reasoning and not the whole dependency
      // graph's.
      env: { PODIUM_LOG: 'daemon:*=debug' },
    })

    // Every contract event this session produces, from before the crash to after
    // it. Subscribed BEFORE the session exists so the count of `adopted` events
    // below is a count over the whole run and not over a window that happens to
    // start where the answer is convenient.
    const events: RuntimeEvent[] = []
    let watched: SessionId | undefined
    const unsubscribe = gateway.onEvent((sessionId, event) => {
      if (sessionId === watched) events.push(event)
    })

    try {
      await waitFor(
        () =>
          srv.registry.modules.machines.listMachines().find((m) => m.id === hostMachineId())
            ?.online === true,
        60_000,
        'machine online',
      )

      // ---- 1. A WORKING SESSION, BEFORE ANYTHING BREAKS -------------------
      //
      // A restart lane that started from a session it never saw work would not
      // be able to tell adoption from a session that was broken all along.
      const { sessionId } = sessions.createSession({
        agentKind: 'opencode',
        cwd: tmp,
        model: MODEL,
        runtimeContract: 'opencode-server',
      })
      watched = sessionId
      await waitFor(
        () => sessions.listSessions().find((s) => s.sessionId === sessionId)?.status === 'live',
        120_000,
        'session live',
        // A spawn that REFUSED never reaches `live`, and the refusal is a frame
        // this wait cannot see. The daemon's own log is where it said why.
        () => `daemon log (tail):\n${daemon.output(6000)}`,
      )

      // ASSERTED BEFORE THE FIRST TURN, and the ordering is the whole point.
      //
      // A session that was never put behind the contract still goes `live` and
      // still accepts a `send` — it just takes the legacy PTY route, which for
      // this family types at a terminal that does not exist and reports an
      // `unverified` receipt. Checking the turn first would surface that as "the
      // model did not answer", which is the wrong problem, in the wrong
      // component, and costs an hour. So the routing fact is checked where it is
      // decided, with the daemon's own log attached: whatever refused the
      // `opencode-server` override will have said so there.
      //
      // THE JOURNAL, NOT `runtimeContract`, IS THE FAMILY TEST — and finding that
      // out cost a run. `runtimeContract: true` on the row means the session is
      // behind SOME driver contract; the terminal driver sets it too. So a spawn
      // that asked for `opencode-server` and silently got a PTY passes that
      // check, and then fails four steps later as an `unverified` receipt, which
      // reads as a model problem. The journal file is written by exactly one
      // thing — `createOpencodeHost`'s launch — so its presence is the fact.
      //
      // The probe timing is attached because it is the known cause. The daemon
      // decides this driver's availability from `opencode --version` under a
      // 15s budget, and that binary was measured at 11–15s on this project's
      // build host: when the probe loses, `resolveRuntimeDriver` reports the
      // driver unavailable and the explicit override degrades to a terminal
      // session rather than refusing.
      expect(
        existsSync(journalPath(sessionId)),
        [
          'the session is live but has no opencode binding journal, so the `opencode-server` override did NOT take and this lane would be measuring the PTY path.',
          `row runtimeContract: ${sessions.sessions.get(sessionId)?.runtimeContract} (true here means SOME contract, not necessarily this family)`,
          `this process probed \`opencode --version\` in ${gate.live ? gate.probeMs : -1}ms; the daemon allows ${DAEMON_VERSION_PROBE_BUDGET_MS}ms before reporting the driver unavailable`,
          // DISCOUNT THE LOG LINE BELOW BEFORE ANYONE ACTS ON IT. When the probe
          // loses its race the daemon warns "opencode is outside the server
          // driver range" with `observedVersion: "(no output)"` — for a binary
          // that is squarely inside the range and answers correctly when asked
          // with more patience. It is the first thing anyone will grep, and it
          // sends them to inspect a good binary, so this lane says so here.
          'NOTE: a daemon warning of "opencode is outside the server driver range" with observedVersion "(no output)" is NOT a bad binary — it is the version probe timing out. Check the version by hand before touching PATH.',
          `daemon log (tail):\n${daemon.output(6000)}`,
        ].join('\n'),
      ).toBe(true)
      expect(sessions.sessions.get(sessionId)?.runtimeContract).toBe(true)

      const first = await gateway.send({
        sessionId,
        text: 'Reply with exactly the word: pong',
        origin: 'human',
        delivery: 'when-ready',
      })
      expect(first.outcome, `receipt was ${JSON.stringify(first)}`).toBe('accepted')
      if (first.outcome !== 'accepted') return
      expect(first.provenBy).toBe('protocol-ack')
      await waitFor(
        () =>
          sessions
            .transcriptFor(sessionId)
            .some((item) => item.role === 'assistant' && /pong/i.test(item.text ?? '')),
        180_000,
        'assistant reply before the crash',
      )
      const beforeTranscript = sessions.transcriptFor(sessionId).length

      // ---- 2. THE JOURNAL, AS IT LANDED ON DISK ---------------------------
      //
      // 0600 is asserted rather than assumed, because the file holds the
      // session's server credential and the driver's own header calls its mode
      // "part of the mechanism, not hygiene". A journal that widened to 0644
      // would keep every assertion below green while handing any local process
      // the ability to drive someone's agent.
      const journalMode = statSync(journalPath(sessionId)).mode & 0o777
      expect(journalMode.toString(8)).toBe('600')
      const before = readJournal(sessionId)
      expect(before.process.key).toBe(`podium-oc-${sessionId}`)
      expect(await serverAnswers(before)).toBe(true)

      // ---- 3. KILL THE DAEMON. ONLY THE DAEMON. ---------------------------
      const deadPid = daemon.pid
      await daemon.crash()
      expect(processIsAlive(deadPid)).toBe(false)

      // THE SURVIVAL CLAIM, and it is checked before anything about adoption:
      // if `opencode serve` went down with its parent there is no survivor to
      // adopt, and every failure below would be a misleading second symptom of
      // this one fact.
      expect(
        await serverAnswers(before),
        'opencode serve did not survive the daemon it was spawned by',
      ).toBe(true)
      if (before.process.pid !== undefined) {
        expect(processIsAlive(before.process.pid)).toBe(true)
      }

      // ---- 4. THE DAEMON COMES BACK ---------------------------------------
      await daemon.restart()
      expect(daemon.pid).not.toBe(deadPid)
      await waitFor(
        () =>
          srv.registry.modules.machines.listMachines().find((m) => m.id === hostMachineId())
            ?.online === true,
        60_000,
        'machine online after restart',
      )

      // ---- 5. THE SESSION REBINDS, WITHOUT A SECOND SERVER ----------------
      const adoptedEvents = (): RuntimeEvent[] =>
        events.filter((e) => e.t === 'process' && e.ev.ev === 'adopted')
      await waitFor(
        () => adoptedEvents().length > 0,
        120_000,
        'the restarted daemon adopted the surviving opencode session',
      )
      // EXACTLY ONE. The contract's words are "emit one bootstrap snapshot", and
      // a second adoption would mean a second event stream over one session —
      // every item delivered twice, and a consumer with no way to tell which
      // fold is current.
      expect(adoptedEvents()).toHaveLength(1)

      // THE SAME SERVER, not a fresh one. This is the assertion that separates
      // adoption from a relaunch that happens to look like it: a relaunch mints
      // a new port, a new secret and a new pid, and would lose the conversation
      // while reporting success.
      const after = readJournal(sessionId)
      expect(after.process.key).toBe(before.process.key)
      expect(after.baseUrl).toBe(before.baseUrl)
      expect(after.process.pid).toBe(before.process.pid)

      // A HIGHER OBSERVER GENERATION. The envelope's own rule: the generation is
      // bumped when the observer rebinds, so a stale one can be rejected rather
      // than merged. If it did not move, a frame from the dead daemon's fold
      // would still be indistinguishable from a live one.
      const generationBefore = Math.max(
        ...events
          .slice(
            0,
            events.findIndex((e) => e.t === 'process' && e.ev.ev === 'adopted'),
          )
          .map((e) => e.observerGeneration),
      )
      const adopted = adoptedEvents()[0]
      expect(adopted?.observerGeneration).toBeGreaterThan(generationBefore)

      await waitFor(
        () => sessions.listSessions().find((s) => s.sessionId === sessionId)?.status === 'live',
        60_000,
        'session live again',
      )
      // …and the row still knows it is behind the contract, which is what routes
      // the next send to the driver instead of to a PTY it does not have.
      expect(sessions.sessions.get(sessionId)?.runtimeContract).toBe(true)

      // ---- 6. AND IT KEEPS TAKING TURNS -----------------------------------
      const second = await gateway.send({
        sessionId,
        text: 'Reply with exactly the word: pang',
        origin: 'human',
        delivery: 'when-ready',
      })
      expect(second.outcome, `receipt was ${JSON.stringify(second)}`).toBe('accepted')
      if (second.outcome !== 'accepted') return
      expect(second.provenBy).toBe('protocol-ack')
      // MONOTONIC ACROSS THE REBIND. The journal is written synchronously on the
      // turn-open path precisely so this holds; a turn epoch that rewound would
      // reopen a fence the causal envelope says is absorbing.
      expect(second.turnEpoch).toBeGreaterThan(first.turnEpoch)

      await waitFor(
        () =>
          sessions
            .transcriptFor(sessionId)
            .some((item) => item.role === 'assistant' && /pang/i.test(item.text ?? '')),
        180_000,
        'assistant reply after the restart',
      )
      // THE CONVERSATION, NOT JUST THE PROCESS. A rebind that reached the right
      // server but dropped everything said before it is not the thing the
      // operator was promised.
      expect(sessions.transcriptFor(sessionId).length).toBeGreaterThan(beforeTranscript)
      expect(
        sessions
          .transcriptFor(sessionId)
          .some((item) => item.role === 'assistant' && /pong/i.test(item.text ?? '')),
      ).toBe(true)
    } finally {
      unsubscribe()
      if (daemon.alive()) await daemon.crash()
      await srv.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 900_000)
})

describe.skipIf(live)('e2e: daemon-restart adoption — LIVE lane skipped', () => {
  it('says so rather than passing silently', () => {
    // The harness self-check above still ran. What is skipped is only the half
    // that needs a real opencode and a real model credential — and if the
    // operator ASKED for that half, a skip is a failure, reported with the
    // reason rather than as a bare boolean nobody can act on.
    expect(
      process.env.PODIUM_OPENCODE_LIVE,
      `live lane refused: ${gate.live ? '' : gate.why}`,
    ).not.toBe('1')
  })
})
