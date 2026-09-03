// apps/daemon/src/claude-sdk-client.ts
//
// The daemon's half of the Claude SDK split. Spawns claude-sdk-host.ts as a child
// process, translates its line protocol back into the same `HeadlessTurnHandle`
// the in-process driver used to return, and — the part that matters — treats the
// child's death as a NORMAL, REPORTABLE OUTCOME rather than as an event that can
// take anything else down with it.
//
// SDK-free by construction. Nothing reachable from this file loads
// `@anthropic-ai/claude-agent-sdk`; claude-sdk-isolation.test.ts proves that by
// walking the import graph rather than by trusting this sentence.

import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { createLogger } from '@podium/logger'
import {
  type ClaudeSdkHostCommand,
  type ClaudeSdkHostFrame,
  claudeSdkHostLaunch,
} from './claude-sdk-protocol.js'
import {
  type HeadlessEmit,
  HeadlessTurnError,
  type HeadlessTurnHandle,
  type HeadlessTurnOutcome,
  type HeadlessTurnSpec,
  headlessChildEnv,
} from './headless-drivers.js'

const log = createLogger('daemon:claude-sdk')

const DEFAULT_TURN_TIMEOUT_MS = 600_000
/** How long a politely-interrupted host gets to wind down before it is killed. */
const INTERRUPT_GRACE_MS = 15_000
/**
 * How long the host gets to say what the provider did with an interrupt.
 *
 * Deliberately far shorter than the kill grace above: this bounds a REPORT, not
 * the wind-down. The operator is owed an answer about their stop request while
 * they are still looking at it, and `unconfirmed` is a truthful answer — waiting
 * the full grace to say "we do not know" would only make the silence longer.
 */
const INTERRUPT_ACK_MS = 5_000

/**
 * What the provider did with one interrupt request.
 *
 * THE THIRD ARM IS THE POINT. `accepted` and `rejected` are the provider's own
 * verdicts; `unconfirmed` is the honest answer when the host died, was killed
 * after its grace, or simply never replied. Collapsing it into either of the
 * other two is how a stop that may not have happened gets reported as one that
 * did — the failure this type exists to make unrepresentable.
 */
export type ClaudeSdkInterruptAck =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; detail: string }
  | { outcome: 'unconfirmed'; detail: string }

/** The child handle, plus the acknowledged interrupt the generic headless shape
 *  has no room for. `interrupt()` stays exactly as it was for teardown callers
 *  that neither want nor wait for an answer. */
export interface ClaudeSdkChildHandle extends HeadlessTurnHandle {
  /** Request an interrupt and resolve with what the provider said about it. */
  requestInterrupt(): Promise<ClaudeSdkInterruptAck>
}

export interface ClaudeSdkChildOptions {
  /** Injected in tests so the framing can be exercised without a real SDK. */
  spawnHost?: () => ChildProcess
  onPermission?: (request: {
    id: string
    toolName: string
    input?: unknown
    suggestions?: readonly unknown[]
  }) => void
  /** One tool call, as the model issued it. Delivered before its result. */
  onToolCall?: (call: { toolUseId: string; toolName: string; input?: unknown }) => void
  /** That call's return. `output` is always present and may be empty. */
  onToolResult?: (result: { toolUseId: string; output: string; isError?: boolean }) => void
}

/**
 * One Claude turn, run in a child process.
 *
 * The contract is deliberately identical to the in-process driver it replaces —
 * same events, same outcome, same `HeadlessTurnError` carrying the harness
 * session id out of a failure — with one addition the old shape could not offer:
 * if the host process dies without answering, the turn FAILS with a true
 * statement about what happened instead of hanging. A hang was the old worst
 * case that could not arise, because a crash there took the daemon with it.
 */
export function runClaudeSdkChildTurn(
  spec: HeadlessTurnSpec,
  emit: HeadlessEmit,
  opts: ClaudeSdkChildOptions = {},
): ClaudeSdkChildHandle {
  const child = opts.spawnHost ? opts.spawnHost() : spawnDefaultHost(spec)

  /** The last session id the host reported. Kept OUTSIDE the frame loop because
   *  its whole job is to still be here when the frame loop stops early. */
  let harnessSessionId = spec.resumeValue ?? spec.sessionUuid ?? ''
  let timedOut = false
  let settled = false

  let resolve!: (v: HeadlessTurnOutcome) => void
  let reject!: (e: Error) => void
  const done = new Promise<HeadlessTurnOutcome>((res, rej) => {
    resolve = res
    reject = rej
  })
  const succeed = (outcome: HeadlessTurnOutcome): void => {
    if (settled) return
    settled = true
    resolve(outcome)
  }
  const fail = (message: string): void => {
    if (settled) return
    settled = true
    reject(new HeadlessTurnError(message, harnessSessionId || undefined))
  }

  const send = (cmd: ClaudeSdkHostCommand): void => {
    try {
      child.stdin?.write(`${JSON.stringify(cmd)}\n`)
    } catch {
      // A dead child's stdin is not an error path of its own — the exit handler
      // below is what reports the death, once, with the real reason.
    }
  }

  /**
   * Interrupt requests waiting on the host's verdict, by id.
   *
   * Each entry resolves EXACTLY ONCE, from whichever comes first: the host's
   * `interrupt-ack`, the child dying, or the ack deadline. `settleAck` is the
   * only way in, so a host that answers twice — or answers a request the close
   * handler has already given up on — cannot produce two receipts for one stop.
   */
  const pendingAcks = new Map<string, (ack: ClaudeSdkInterruptAck) => void>()
  const settleAck = (requestId: string, ack: ClaudeSdkInterruptAck): void => {
    const resolve = pendingAcks.get(requestId)
    if (!resolve) return
    pendingAcks.delete(requestId)
    resolve(ack)
  }
  const settleAllAcks = (ack: ClaudeSdkInterruptAck): void => {
    for (const requestId of [...pendingAcks.keys()]) settleAck(requestId, ack)
  }

  let killTimer: ReturnType<typeof setTimeout> | undefined
  const killAfterGrace = (): void => {
    if (killTimer) return
    killTimer = setTimeout(() => child.kill('SIGKILL'), INTERRUPT_GRACE_MS)
    killTimer.unref?.()
  }

  const timer = setTimeout(() => {
    timedOut = true
    send({ t: 'interrupt' })
    killAfterGrace()
  }, spec.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS)
  timer.unref?.()

  // stderr is not protocol, but it IS the only explanation a crashed host gets to
  // leave behind, so keep a bounded tail for the death message.
  let stderrTail = ''
  child.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-8192)
  })

  const frames = createInterface({ input: child.stdout as NodeJS.ReadableStream })
  frames.on('line', (line) => {
    let frame: ClaudeSdkHostFrame
    try {
      frame = JSON.parse(line) as ClaudeSdkHostFrame
    } catch {
      // Stray non-protocol output on the host's stdout is ignored rather than
      // fatal: a dependency that logs must not be able to fail a live turn.
      return
    }
    switch (frame.t) {
      case 'session':
        harnessSessionId = frame.harnessSessionId
        break
      case 'event':
        emit(frame.event)
        break
      case 'interrupt-ack':
        settleAck(
          frame.requestId ?? '',
          frame.accepted
            ? { outcome: 'accepted' }
            : { outcome: 'rejected', detail: frame.detail || 'the provider refused the interrupt' },
        )
        break
      case 'tool-call':
        // Forwarded in frame order and never buffered: the host emits the call
        // before the result, and this is the only place that ordering is
        // preserved on the way to the transcript.
        opts.onToolCall?.({
          toolUseId: frame.toolUseId,
          toolName: frame.toolName,
          ...(frame.input !== undefined ? { input: frame.input } : {}),
        })
        break
      case 'tool-result':
        opts.onToolResult?.({
          toolUseId: frame.toolUseId,
          output: frame.output,
          ...(frame.isError ? { isError: true } : {}),
        })
        break
      case 'permission':
        opts.onPermission?.({
          id: frame.interactionId,
          toolName: frame.toolName,
          ...(frame.input !== undefined ? { input: frame.input } : {}),
          ...(frame.suggestions ? { suggestions: frame.suggestions } : {}),
        })
        break
      case 'done':
        harnessSessionId = frame.harnessSessionId
        // A TIMED-OUT TURN IS NEVER A SUCCESS, however gracefully it ended.
        // `interrupt` asks the SDK to wind down, and a wound-down stream reports
        // `done` with whatever text it had — so without this branch a turn cut
        // off at its deadline arrived as the assistant's complete reply, and the
        // human read half a sentence as the whole answer. The in-process driver
        // this replaced ended with `if (interrupted) fail('turn timed out')`
        // for exactly this reason; losing it was a regression, not a redesign.
        if (timedOut) fail('turn timed out')
        else
          succeed({
            harnessSessionId: frame.harnessSessionId,
            output: frame.output,
            ...(frame.observedModel ? { observedModel: frame.observedModel } : {}),
            ...(frame.observedEffort ? { observedEffort: frame.observedEffort } : {}),
          })
        break
      case 'error':
        if (frame.harnessSessionId) harnessSessionId = frame.harnessSessionId
        fail(timedOut ? 'turn timed out' : frame.message)
        break
    }
  })

  child.on('error', (err: Error) => {
    fail(`claude sdk host could not start: ${err.message}`)
  })

  child.on('close', (code, signal) => {
    clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    frames.close()
    // The host is gone, so every interrupt still waiting on it is now waiting on
    // nothing. Say what is true — the request went out and was never answered —
    // rather than leaving the caller to time out into the same conclusion.
    settleAllAcks({
      outcome: 'unconfirmed',
      detail: 'the Claude model host exited before it confirmed the interrupt',
    })
    if (settled) return
    // THE CASE THIS WHOLE SPLIT EXISTS FOR. The host is gone and never answered:
    // OOM-killed, crashed inside the SDK, or killed by us after a timeout. Say so
    // plainly — the human on the other end of this session is owed a reason, and
    // an unanswered promise would leave them watching a turn that never ends.
    if (timedOut) {
      fail('turn timed out')
      return
    }
    const how = signal ? `on ${signal}` : `with code ${code}`
    const why = stderrTail.trim() ? `: ${stderrTail.trim().slice(-2000)}` : ''
    log.warn('claude sdk host died mid-turn', { signal, code, harnessSessionId })
    fail(`the Claude model host process exited ${how} before the turn finished${why}`)
  })

  // Handlers are wired BEFORE the turn is sent, so a host that dies instantly
  // still lands in `close` above rather than in an unobserved gap.
  send({ t: 'turn', spec })

  return {
    done,
    interrupt: () => {
      send({ t: 'interrupt' })
      killAfterGrace()
    },
    requestInterrupt: () => {
      const requestId = randomUUID()
      const answered = new Promise<ClaudeSdkInterruptAck>((res) => {
        pendingAcks.set(requestId, res)
      })
      const deadline = setTimeout(() => {
        settleAck(requestId, {
          outcome: 'unconfirmed',
          detail: 'the Claude model host did not confirm the interrupt in time',
        })
      }, INTERRUPT_ACK_MS)
      deadline.unref?.()
      send({ t: 'interrupt', requestId })
      killAfterGrace()
      return answered.finally(() => clearTimeout(deadline))
    },
    answerPermission: (interactionId, answer) => {
      send({
        t: 'answer',
        interactionId,
        decision: answer.decision,
        ...(answer.feedback ? { feedback: answer.feedback } : {}),
      })
    },
    dispose: () => {
      if (settled) return
      send({ t: 'interrupt' })
      child.kill('SIGKILL')
    },
  }
}

/**
 * The environment the host child inherits.
 *
 * The host builds the CLI's own environment from `spec` itself, exactly as the
 * in-process driver did. What it inherits here is the daemon's environment plus
 * the same per-turn overrides, so `process.env` reads inside the host see what
 * they saw when the SDK ran in the daemon.
 *
 * Exported so a test can spawn a real process with it and read back the `HOME`
 * that process actually ran under — the fact POD-3057 turns on — rather than
 * re-asserting this merge expression against itself.
 */
export function claudeSdkHostEnv(spec: HeadlessTurnSpec): Record<string, string> {
  return headlessChildEnv(spec.agent, spec.env)
}

function spawnDefaultHost(spec: HeadlessTurnSpec): ChildProcess {
  const launch = claudeSdkHostLaunch()
  return spawn(launch.cmd, launch.args, {
    cwd: spec.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...claudeSdkHostEnv(spec), ...launch.env },
  })
}
