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
 *
 * ---------------------------------------------------------------------------
 * READ THE ASSERTION COUNTS, NOT THE EXIT CODE (until POD-2096 lands)
 * ---------------------------------------------------------------------------
 *
 * A live run of this file exits `1` even when every assertion passes. POD-2096:
 * `SessionRegistry.dispose()` never calls `SuperagentService.dispose()`, so the
 * turn reaper outlives `store.close()` and throws `RangeError: Cannot use a
 * closed database` on shutdown; vitest counts that as an unhandled error and
 * fails the RUN while reporting every TEST green. Without the live flag the
 * same file exits 0, because the self-check never creates a session whose
 * reaper is armed.
 *
 * This is said here, and not only on the issue, because `bun run test:e2e`
 * collects this file: whoever wires the live lane into a gate before POD-2096
 * is fixed will get a red gate and no hint that the cause is a teardown bug in
 * somebody else's module.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gateOpencodeVersion, type RuntimeEvent } from '@podium/agent-runtime'
import type { MachineId, SessionId } from '@podium/model'
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

/** NOT annotated `: string`. `readOrCreateLocalMachineId` already answers a
 *  branded `MachineId`, and widening it here would mean re-branding it at every
 *  `DaemonOptions` that needs one — a cast per call site to undo a loss this
 *  line caused. */
const hostMachineId = (): MachineId => readOrCreateLocalMachineId()

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
        // THE FAILURE THIS FILE EXISTS TO PRODUCE, so it says what it means
        // rather than leaving a bare timeout to be interpreted.
        //
        // The caller this waits on is `adoptServerDriverSession` in
        // `apps/daemon/src/control/session.ts`, which runs on the reattach path
        // BEFORE the durable-host lookup. It is the caller `adopt()` spent its
        // whole life without, and this lane is why it exists: until POD-2023
        // landed it, a server-family session fell through to the PTY branch,
        // which looked for an abduco socket named for the durable label, found
        // none — there is no PTY — and answered `reattachFailed: session not
        // found` while the `opencode serve` kept running with nothing bound to
        // it. If this wait ever times out again, that branch is the first place
        // to look: the symptom is identical and the journal read is what
        // separates them.
        () =>
          [
            'No `adopted` event arrived. The daemon came back and the opencode server survived — the two facts this lane checked before this point — so what is missing is the rebind between them.',
            `journal still readable: ${existsSync(journalPath(sessionId))}; server still answering: awaited above`,
            `session status after restart: ${sessions.listSessions().find((s) => s.sessionId === sessionId)?.status}`,
            // AN EMPTY LOG BELOW IS A CLUE, NOT AN ABSENCE OF ONE. Verified by
            // disabling the adopt caller and watching this failure: the daemon
            // refuses a reattach it cannot serve with a `reattachFailed` FRAME,
            // and a frame is not a log line — so the tail stays empty while the
            // session quietly never comes back. If it is empty, suspect the
            // reattach path rather than concluding the daemon was idle.
            `daemon log since restart (tail, may legitimately be empty — see above):\n${daemon.output(8000)}`,
          ].join('\n'),
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
      //
      // NOT `process.key`, AND THE OMISSION IS THE POINT. `opencodeScopeLabel`
      // is `podium-oc-${sessionId}` — derived from the session id and nothing
      // else — so comparing it across the restart compares a pure function of a
      // constant with itself. It passes for a relaunch, a re-spawn, and a driver
      // that adopted the wrong process entirely. Its one honest use is the
      // format pin already made before the crash; as evidence of identity it is
      // worth exactly nothing, and it read like the load-bearing check.
      //
      // These four are the facts a relaunch could not fake.
      const after = readJournal(sessionId)

      // THE PID, which is the actual operating-system identity of the survivor.
      // Asserted PRESENT first: the field is optional on the endpoint type, and
      // `undefined === undefined` is a green line that proves nothing.
      expect(
        before.process.pid,
        'the journal recorded no pid for the server, so the identity check below would compare undefined with undefined and pass vacuously',
      ).toBeDefined()
      expect(after.process.pid).toBe(before.process.pid)
      expect(processIsAlive(after.process.pid as number)).toBe(true)

      // THE PORT. `freeLoopbackPort()` takes whatever the kernel hands out, so a
      // relaunch lands somewhere else with overwhelming probability.
      expect(after.baseUrl).toBe(before.baseUrl)

      // THE SECRET — 32 bytes from the CSPRNG, minted once per launch. This is
      // the one a relaunch cannot collide with even in principle, which is why
      // it is worth a line of its own rather than being folded into the health
      // probe that merely used it.
      expect(after.secret).toBe(before.secret)

      // AND THE BINDING VERSION MOVED. The other three say "same process"; this
      // one says "new binding over it", which is the half that distinguishes an
      // adoption from the journal simply never having been rewritten. `adopt()`
      // attaches at `binding.bindingVersion + 1` and `persist()` writes it on
      // the `adopted` emit, so a journal that still carried the old number would
      // mean the rebind never reached disk.
      expect(after.bindingVersion).toBeGreaterThan(before.bindingVersion)

      // A HIGHER OBSERVER GENERATION. The envelope's own rule: the generation is
      // bumped when the observer rebinds, so a stale one can be rejected rather
      // than merged. If it did not move, a frame from the dead daemon's fold
      // would still be indistinguishable from a live one.
      const beforeAdoption = events.slice(
        0,
        events.findIndex((e) => e.t === 'process' && e.ev.ev === 'adopted'),
      )
      // GUARDED, because `Math.max()` of nothing is -Infinity and every
      // generation beats that. A vacuous pass here would be worse than no
      // assertion: it would read, in the report, as evidence the observer
      // rebound. The pre-crash turn guarantees these events exist, so an empty
      // slice means something upstream is not reaching the tap at all.
      expect(
        beforeAdoption.length,
        'no events were observed before adoption, so the generation comparison below would compare against -Infinity and pass without proving anything',
      ).toBeGreaterThan(0)
      const generationBefore = Math.max(...beforeAdoption.map((e) => e.observerGeneration))
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

      // ---- 5b. ONE BOOTSTRAP SNAPSHOT, AND NOTHING RETROACTIVE ------------
      //
      // THE ASSERTION THIS LANE IS CHARTERED ON, and it is not the same one as
      // "exactly one `adopted` event" above. `reattachment-design.md` states the
      // reattach contract as *one bootstrap snapshot and zero retroactive live
      // edges*, and the two halves fail differently: a second snapshot is a
      // double fold, whereas a retroactive LIVE edge is history being replayed
      // as if it had just happened. Only the second one wakes a parent, emits
      // `session.phase`, fires a Telegram notification and advances live
      // recency — which is why the design names those effects specifically.
      //
      // Counting `adopted` events cannot see either failure. Everything below
      // reads `provenance`, which the driver stamps and `RuntimeGateway.record`
      // forwards untouched, so this tap has carried it the whole time.
      //
      // MEASURED, NOT ASSUMED (this is what the census run was for). At this
      // point the rebound generation contains exactly one event — the `adopted`
      // one — tagged `bootstrap`, and the ten pre-crash events all sit at the
      // old generation tagged `live`. That the adoption lands INSIDE the
      // snapshot rather than after it is structural rather than lucky:
      // `adoptFromJournal` awaits `driver.adopt()` (which emits `adopted` into
      // the session log) and only then calls `pump()`, which opens the stream
      // with `events('bootstrap')` and replays everything already logged with
      // the bootstrap tag. There is no ordering in which it arrives live.
      const rebound = events.filter((e) => e.observerGeneration > generationBefore)
      // NON-VACUITY FIRST, for the same reason the `-Infinity` guard above
      // exists: every assertion in this block is "no events of kind X", and an
      // empty rebound set satisfies all of them while proving nothing.
      expect(
        rebound.length,
        'no events arrived at the new observer generation, so the snapshot and retroactivity checks below would all pass over an empty set',
      ).toBeGreaterThan(0)

      // EXACTLY ONE SNAPSHOT — expressed as contiguity, because that is what
      // "one snapshot opens the stream" means on a stream. Bootstrap events form
      // the head of the rebound generation; once a live edge appears the
      // snapshot is closed, and a bootstrap event after that point is a SECOND
      // fold — every item delivered twice with no way to tell which is current.
      const snapshotLength = rebound.findIndex((e) => e.provenance !== 'bootstrap')
      const snapshot = snapshotLength === -1 ? rebound : rebound.slice(0, snapshotLength)
      expect(
        snapshot.length,
        'the rebind produced no bootstrap-provenance events at all, so the session was restored without a snapshot to restore it from',
      ).toBeGreaterThan(0)
      expect(
        rebound.slice(snapshot.length).filter((e) => e.provenance === 'bootstrap'),
        'a bootstrap event arrived after the snapshot had already closed — that is a second fold over one session',
      ).toHaveLength(0)
      // …and the adoption is part of it, not a live edge announcing itself.
      expect(adopted?.provenance).toBe('bootstrap')

      // ZERO RETROACTIVE LIVE EDGES. Checked HERE, before the second send, and
      // the placement is what makes it exact: nothing new has been said since
      // the crash, so at this instant *any* live `item` or `turn` in the rebound
      // generation is by construction a replay of something that already
      // happened. No turn-epoch fence is needed to say so, and none is used —
      // a fence would have had to guess which epoch counted as "old".
      //
      // This is the check that would have caught a fold republishing the
      // pre-crash transcript as live: the lane's transcript assertions further
      // down would stay green through exactly that regression, because the
      // conversation really would still be there — twice.
      expect(
        rebound.filter((e) => e.provenance === 'live' && (e.t === 'item' || e.t === 'turn')),
        'history was republished as live edges after the rebind — these are the events that wake parents and notify humans, and the reattach contract requires zero of them',
      ).toHaveLength(0)

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
