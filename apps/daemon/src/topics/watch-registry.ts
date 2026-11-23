/**
 * THE DAEMON'S ONE WATCH REGISTRY — ADR 7 Amendment 2 D22.
 *
 * `kind → { start(id) → stop }`, the same producer interface as the server's.
 * Nothing samples or tails without demand: the server's `topicWatch { key, on }`
 * is a DESIRED STATE (the `runtimeWatch` rule), so a repeated `on` is a no-op
 * and a lost frame is corrected by the next.
 *
 * The registry is PER LINK. It is emptied when the link to the server is lost
 * (the host runtime's `linkLost`), again when a link is established, and when
 * the daemon closes: the server forgets what it told the previous connection
 * and re-sends `on` for every key that still has subscribers (D21). So nothing
 * samples or watches during an outage, and a key whose last subscriber left
 * while the link was down stays stopped after it.
 *
 * `runtimeWatch` (the transcript's fine watch) is deliberately NOT here yet: the
 * session kinds move last (POD-6679).
 */

import { createLogger } from '@podium/logger'
import { isTopicKind, parseTopicKey, TOPIC_KINDS, type TopicKind } from '@podium/protocol'

const log = createLogger('daemon:topics')

/** Start producing one id; returns the stop. */
export type TopicWatchStart = (id: string, input?: unknown) => () => void

export class TopicWatchRegistry {
  private readonly producers = new Map<TopicKind, TopicWatchStart>()
  private readonly running = new Map<string, () => void>()

  /** Declare the producer for a daemon-produced kind. Once per kind. */
  register(kind: TopicKind, start: TopicWatchStart): void {
    if (TOPIC_KINDS[kind].producer !== 'daemon') {
      throw new Error(`topic kind ${kind} is not produced by the daemon`)
    }
    if (this.producers.has(kind)) throw new Error(`topic kind ${kind} already has a producer`)
    this.producers.set(kind, start)
  }

  /** Apply the server's desired state for one key. */
  apply(key: string, on: boolean, input?: unknown): void {
    const ref = parseTopicKey(key)
    if (!ref || !isTopicKind(ref.kind)) {
      log.warn('ignored a watch for an unknown topic', { key })
      return
    }
    if (!on) {
      this.stopKey(key)
      return
    }
    if (this.running.has(key)) return
    const start = this.producers.get(ref.kind)
    if (!start) {
      log.warn('ignored a watch for a topic this daemon does not produce', { key })
      return
    }
    try {
      this.running.set(key, start(ref.id, input))
    } catch (err) {
      log.warn('topic producer failed to start', { key, err })
    }
  }

  isRunning(key: string): boolean {
    return this.running.has(key)
  }

  /** The link was lost or (re)established, or the daemon is closing: stop everything. */
  reset(): void {
    for (const key of [...this.running.keys()]) this.stopKey(key)
  }

  private stopKey(key: string): void {
    const stop = this.running.get(key)
    if (!stop) return
    this.running.delete(key)
    try {
      stop()
    } catch (err) {
      log.warn('topic producer failed to stop', { key, err })
    }
  }
}
