/**
 * THE TERMINAL DRIVER UNDER THE DRIVER CONFORMANCE CORPUS (POD-1761 W3).
 *
 * ---------------------------------------------------------------------------
 * THE REAL DRIVER, A FIXTURE WORLD
 * ---------------------------------------------------------------------------
 *
 * Every line of `terminal-driver.ts` and of the ported injection state machine
 * runs here. What is faked is the WORLD the driver's host port describes: a PTY
 * that records what was typed and echoes a user turn back the way a CLI does, a
 * durable host that is alive until something reaps it, and an observation stream
 * a test can post to. That is the same split the corpus's own header describes —
 * "the PROPERTIES stay identical; only the way the world is nudged differs".
 *
 * WHY NOT A REAL CLAUDE SESSION HERE. The plan is explicit about which lane
 * proves which receipt: the e2e harness (`tests/e2e/serve-harness.ts`) runs a
 * keyecho jig, not a real harness, so no hook ever fires there. Hook-anchored
 * acceptance is therefore proven at the FIXTURE level — by feeding the injected
 * hook port a real `UserPromptSubmit` payload (see the sibling
 * `terminal-driver.test.ts`) — and the flag-on e2e lane proves echo-based
 * acceptance and `unverified`. Running the corpus against a live agent would
 * make its timing assertions a flake generator and would prove less, not more.
 *
 * ---------------------------------------------------------------------------
 * TIME IS VIRTUAL, AND THAT IS A CORRECTNESS DECISION
 * ---------------------------------------------------------------------------
 *
 * The injection ladder waits real seconds by design (1.6s per verification tick,
 * a 4.8s window). A corpus that waited them out would take a minute and would
 * still be racing. So the fixture's clock advances to each timer as it fires:
 * ORDER is preserved exactly, durations are honoured exactly, and nothing is
 * skipped — only the wall-clock waiting is removed. A property that passed here
 * because a timer was dropped would fail the ordering assertions immediately.
 */

import type { PendingInteraction } from '@podium/agent-runtime'
import { TERMINAL_PERMITTED_FAILURES } from '@podium/agent-runtime'
import type { ConformanceControl, ConformanceTarget } from '@podium/agent-runtime/testing'
import { runConformance } from '@podium/agent-runtime/testing'
import type { AgentRuntimeState, SessionId, TranscriptItem } from '@podium/model'
import type { AgentObservation, DaemonMessage } from '@podium/protocol'
import {
  createTerminalRuntime,
  type TerminalHarnessProfile,
  type TerminalRuntime,
  type TerminalRuntimeHost,
} from './terminal-driver'

/**
 * A generic-PTY harness: no causal hook channel, submit-verification on, screen
 * classifier interactions.
 *
 * THE HARDEST PROFILE ON PURPOSE. It is the one that has to reach `unverified`
 * honestly and the one whose interactions are at-least-once, so it exercises
 * both of the terminal family's permitted failures. A Claude profile would pass
 * more of the corpus for a reason that says nothing about the family.
 */
const PROFILE: TerminalHarnessProfile = {
  driverId: 'generic-pty',
  sendProof: ['transcript-echo'],
  hookAnchoredAccept: false,
  needsSubmitVerification: true,
  usesRawFirstTurn: false,
  archivable: false,
  reportsContextPercent: false,
}

/** The bracketed-paste envelope, parsed without a regex: the escape bytes are
 *  literal control characters, which a `RegExp` literal cannot carry legibly. */
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
const pastedText = (text: string): string | undefined =>
  text.startsWith(PASTE_START) && text.endsWith(PASTE_END)
    ? text.slice(PASTE_START.length, text.length - PASTE_END.length)
    : undefined

interface VirtualTimer {
  at: number
  fn: () => void
  cancelled: boolean
}

/** One fixture world plus the driver runtime standing on it. */
function makeWorld(): { target: ConformanceTarget } {
  let runtime: TerminalRuntime | undefined
  let clock = Date.UTC(2026, 7, 14)
  let timers: VirtualTimer[] = []
  let draining = false
  let nextId = 0

  const alive = new Map<string, boolean>()
  const phases = new Map<SessionId, AgentRuntimeState>()
  const suppressEcho = new Set<SessionId>()
  const turnEpochs = new Map<SessionId, number>()
  const bridgeOf = new Map<SessionId, { write(dataBase64: string): void; pid: number }>()
  const pendingPaste = new Map<SessionId, string>()
  /** Deliveries of the caller's TEXT, counted at the PTY. A bracketed paste is
   *  one delivery; the CR and the bounded verification nudges that follow it are
   *  the same delivery finishing, not new ones. */
  const deliveries = new Map<SessionId, number>()

  const labelFor = (sessionId: SessionId): string => `podium-${sessionId}`
  const iso = (): string => new Date(clock).toISOString()

  /**
   * Fire timers one at a time, advancing the clock to each.
   *
   * ONE PER MICROTASK, earliest first: the injection machine interleaves awaits
   * with timers, so firing a batch synchronously would run a later timer before
   * the promise the earlier one resolved had a chance to continue.
   */
  const pump = (): void => {
    if (draining) return
    draining = true
    queueMicrotask(() => {
      draining = false
      timers = timers.filter((timer) => !timer.cancelled)
      if (timers.length === 0) return
      timers.sort((a, b) => a.at - b.at)
      const next = timers.shift()
      if (next) {
        clock = Math.max(clock, next.at)
        next.fn()
      }
      if (timers.length > 0) pump()
    })
  }

  /** The world's own view of a session's transcript, fed back the way a CLI's
   *  native store would produce it. */
  const echoUserTurn = (sessionId: SessionId, text: string): void => {
    const item: TranscriptItem = {
      id: `item-${++nextId}`,
      cursor: `c${nextId}`,
      role: 'user',
      ts: iso(),
      text,
    }
    runtime?.observe({ type: 'transcriptDelta', sessionId, items: [item] })
  }

  const observation = (
    sessionId: SessionId,
    transitionKind: AgentObservation['transitionKind'],
    nextPhase: AgentRuntimeState['phase'],
  ): AgentObservation => {
    const turnEpoch = turnEpochs.get(sessionId) ?? 0
    return {
      podiumSessionId: sessionId,
      provider: 'claude-code',
      providerSessionId: `native-${sessionId}`,
      bindingVersion: 1,
      providerTurnId: null,
      providerPromptId: null,
      observerGeneration: 1,
      providerCursor: { segmentId: `seg-${sessionId}`, components: { transcript: ++nextId } },
      providerAt: iso(),
      receivedAt: iso(),
      sourceEventKind: 'fixture',
      transitionKind,
      provenance: 'live',
      inputOrigin: 'human',
      turnEpoch,
      priorPhase: phases.get(sessionId)?.phase ?? 'unknown',
      nextPhase,
      transitionId: `t-${++nextId}`,
      state: { phase: nextPhase, since: iso(), nativeSubagentCount: 0 },
    }
  }

  const host: TerminalRuntimeHost = {
    send: () => {
      // The frames a real daemon would forward. Nothing in the corpus reads them:
      // every property is stated against the CONTRACT surface, which is the whole
      // reason one corpus can run against every family.
    },
    bridge: (sessionId) => bridgeOf.get(sessionId),
    trackedState: (sessionId) => phases.get(sessionId),
    draftSyncing: () => false,
    durableLabel: labelFor,
    scopeUnit: () => undefined,
    durableHostAlive: async (label) => alive.get(label) === true,
    stopSession: ({ sessionId, durableLabel }) => {
      alive.set(durableLabel, false)
      bridgeOf.delete(sessionId)
    },
    launch: async (msg) => {
      const label = labelFor(msg.sessionId)
      alive.set(label, true)
      phases.set(msg.sessionId, { phase: 'idle', since: iso(), nativeSubagentCount: 0 })
      turnEpochs.set(msg.sessionId, 0)
      bridgeOf.set(msg.sessionId, {
        pid: 4242,
        write: (dataBase64) => {
          const text = Buffer.from(dataBase64, 'base64').toString('utf8')
          const paste = pastedText(text)
          if (paste !== undefined) {
            pendingPaste.set(msg.sessionId, paste)
            deliveries.set(msg.sessionId, (deliveries.get(msg.sessionId) ?? 0) + 1)
            return
          }
          if (text !== '\r') return
          const pasted = pendingPaste.get(msg.sessionId)
          if (pasted === undefined) return
          pendingPaste.delete(msg.sessionId)
          // A CLI that is NOT going to accept this turn simply records nothing —
          // which is exactly what an unprovable send looks like from outside.
          if (suppressEcho.delete(msg.sessionId)) return
          turnEpochs.set(msg.sessionId, (turnEpochs.get(msg.sessionId) ?? 0) + 1)
          echoUserTurn(msg.sessionId, pasted)
        },
      })
    },
    readTranscript: async () => [],
    archiveTranscript: async () => {
      throw new Error('fixture harness declares no handoff transcript')
    },
    readFileBytes: async () => new Uint8Array(),
    memoryBytes: () => undefined,
    now: () => clock,
    setTimer: (fn, delayMs) => {
      const timer: VirtualTimer = { at: clock + delayMs, fn, cancelled: false }
      timers.push(timer)
      pump()
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as VirtualTimer).cancelled = true
    },
  }

  const control: ConformanceControl = {
    askInteraction(sessionId, kind, payload) {
      const id = `ask-${++nextId}`
      phases.set(sessionId, { phase: 'needs_user', since: iso(), nativeSubagentCount: 0 })
      const interaction: PendingInteraction = {
        id,
        sessionId,
        kind,
        payload: (payload as PendingInteraction['payload']) ?? {},
        askedAt: iso(),
        // The classifier is what sees a menu on a screen; it is the family's
        // source wherever there is no hook channel, and it is why the identity
        // below is best-effort.
        source: 'screen-classifier',
        answerable: 'keystroke-emulated',
      }
      runtime?.control.askInteraction(sessionId, interaction)
      return id
    },
    reaskInteraction(sessionId, id) {
      // A RE-RENDERED MENU MINTS A SECOND ID FOR THE SAME LOGICAL ASK. That is
      // the at-least-once weakness the permitted-failures table names, produced
      // here rather than described.
      void id
      return control.askInteraction(sessionId, 'permission', {})
    },
    completeTurn(sessionId) {
      phases.set(sessionId, { phase: 'idle', since: iso(), nativeSubagentCount: 0 })
      runtime?.observe({
        type: 'agentObservation',
        observation: observation(sessionId, 'turn_terminal', 'idle'),
      } as DaemonMessage)
    },
    processEvent(sessionId, ev) {
      if (ev.ev !== 'exited') return
      runtime?.observe({ type: 'agentExit', sessionId, code: ev.code ?? 0 })
    },
    deliveryAttempts(sessionId) {
      return deliveries.get(sessionId) ?? 0
    },
    failNextVerification(sessionId) {
      // THE WORLD STOPS ECHOING, AND THAT IS ALL. The driver has no switch that
      // makes a send answer `unverified`; it reaches that outcome by running its
      // real ladder — bracketed paste, CR, two bounded retries, a 4.8s window —
      // and finding no proof at the end of it. This is the same thing the flag-on
      // e2e lane does, and it is why this property means something.
      suppressEcho.add(sessionId)
    },
    restartSupervisor() {
      // Handles die; the durable hosts in `alive` do not. That is a daemon
      // restart, and it is what `adopt()` then has to find.
      runtime?.control.restartSupervisor()
    },
    connectWithoutSecret() {
      // A terminal session exposes no network endpoint, so there is nothing to
      // authenticate. Stated rather than skipped.
      return { refused: false }
    },
  }

  return {
    target: {
      name: 'generic-pty',
      family: 'terminal',
      createDriver: () => {
        runtime = createTerminalRuntime(host)
        return { driver: runtime.driverFor('grok', PROFILE), control }
      },
      reset: () => {
        runtime?.dispose()
        runtime = undefined
        clock = Date.UTC(2026, 7, 14)
        timers = []
        nextId = 0
        alive.clear()
        phases.clear()
        suppressEcho.clear()
        turnEpochs.clear()
        bridgeOf.clear()
        pendingPaste.clear()
        deliveries.clear()
      },
      spec: () => ({
        harness: 'grok',
        selection: { auth: 'subscription', platform: 'linux', available: ['generic-pty'] },
        workdir: '/tmp/conformance',
        model: {},
        instructions: { supported: false, reason: 'fixture' },
        mcpServers: { supported: false, reason: 'fixture' },
      }),
    },
  }
}

const { target } = makeWorld()
/**
 * The one body of properties, run against the REAL terminal driver.
 *
 * `exemptions` is a CLAIM the suite checks, not a set of skips it obeys: it must
 * equal the terminal family's row in `PERMITTED_FAILURES` exactly, so this
 * driver fails both by claiming a weakness the family does not permit and by
 * exhibiting one it did not claim. A property that does not hold is a driver fix
 * or an argued addition to that table — never a skip here.
 */
runConformance(target.createDriver, {
  name: target.name,
  family: target.family,
  reset: target.reset,
  spec: target.spec,
  exemptions: TERMINAL_PERMITTED_FAILURES,
})
