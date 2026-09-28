/**
 * ONE ID PER SEND, REPEATED UNTIL ANSWERED (POD-4763; POD-4720 §4 rules 1-2).
 *
 * Over the agent relay a CLI cannot tell "the send was lost" from "the answer was
 * lost": both arrive as `agent relay timed out`, or as a dropped connection while
 * the daemon restarts. Running the command again used to create a second message
 * or a second child session, because every run was a new request.
 *
 * So the CLI mints the id before the first attempt and repeats the SAME request,
 * under the same id, only when no answer came back. The server stores a message
 * once per id (and records a spawn once per id), so a repeat of an attempt that
 * did land is answered with what the first one stored. A refusal is an answer and
 * is never repeated.
 */

import { MESSAGE_ID_PREFIX } from '@podium/model'

/** A fresh message id, in the shape the server checks (`msg_` + UUID). */
export function newMessageId(): string {
  return `${MESSAGE_ID_PREFIX}${crypto.randomUUID()}`
}

/** A fresh spawn request id (a UUID). */
export function newRequestId(): string {
  return crypto.randomUUID()
}

/**
 * Whether an attempt ended WITHOUT an answer: the relay gave up waiting, or the
 * connection to it failed. The daemon's relay answers a server refusal as
 * `{ ok: false, error }`, which is an answer; only these two are silence.
 */
export function isUnanswered(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/agent relay timed out/.test(message)) return true
  // fetch's own network failure: nothing reached the daemon, or it went away.
  return error instanceof TypeError && /fetch|network|connect|socket/i.test(message)
}

export interface RepeatOptions {
  /** Attempts in all, the first included. */
  attempts?: number
  /** Pause before the n-th repeat (1-based); grows so a restarting daemon has time. */
  pauseMs?: (repeat: number) => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Run `attempt` until it answers, at most `attempts` times. Every run must send
 * the same request with the same id — that is the caller's half of the contract,
 * and the reason the id is minted outside this function.
 */
export async function repeatUntilAnswered<T>(
  attempt: () => Promise<T>,
  opts: RepeatOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3
  const pauseMs = opts.pauseMs ?? ((repeat) => 1_000 * 2 ** (repeat - 1))
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let n = 1; ; n++) {
    try {
      return await attempt()
    } catch (error) {
      if (n >= attempts || !isUnanswered(error)) throw error
      await sleep(pauseMs(n))
    }
  }
}
