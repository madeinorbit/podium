import type { FeedServerFrame, FeedSinkPort } from '../socket-transport'

/** Same-origin delivery is a platform plug; native supplies no channel. */
export interface FeedBroadcastChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage(message: unknown): void
  close(): void
}

export type FeedBroadcastChannelFactory = (name: string) => FeedBroadcastChannel

export function browserFeedChannel(): FeedBroadcastChannelFactory | undefined {
  return typeof globalThis.BroadcastChannel === 'function'
    ? (name) => new globalThis.BroadcastChannel(name)
    : undefined
}

type RelayedFrame = Extract<FeedServerFrame, { type: 'feedDelta' | 'feedRescope' }>
interface RelayedMessage {
  readonly kind: 'podium-kernel-feed'
  readonly version: 1
  readonly principal: string
  readonly frame: RelayedFrame
}

const SEEN_LIMIT = 512

function frameKey(frame: RelayedFrame): string {
  return frame.type === 'feedDelta'
    ? `${frame.type}\0${frame.feedId}\0${frame.epoch}\0${frame.fromSeq}\0${frame.seq}`
    : `${frame.type}\0${frame.feedId}\0${frame.epoch}\0${frame.seq}`
}

function isRelayedMessage(value: unknown, principal: string): value is RelayedMessage {
  if (value === null || typeof value !== 'object') return false
  const message = value as Partial<RelayedMessage>
  if (
    message.kind !== 'podium-kernel-feed' ||
    message.version !== 1 ||
    message.principal !== principal ||
    message.frame === null ||
    typeof message.frame !== 'object'
  ) return false
  return message.frame.type === 'feedDelta' || message.frame.type === 'feedRescope'
}

/** Relay ordered deltas/rescopes, never another tab's bootstrap or resync walk.
 * The bounded seen set makes socket/relay races converge without echoing. */
export function createFeedRelay(
  sink: FeedSinkPort,
  options: {
    principal: string
    channelName: string
    createChannel?: FeedBroadcastChannelFactory
  },
): { feed: FeedSinkPort; dispose(): void } {
  const channel = options.createChannel?.(options.channelName)
  let stopped = false
  const seen = new Map<string, undefined>()
  const remember = (key: string): boolean => {
    if (seen.has(key)) return false
    seen.set(key, undefined)
    if (seen.size > SEEN_LIMIT) {
      const oldest = seen.keys().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    return true
  }
  const deliver = (frame: FeedServerFrame, fromSocket: boolean): void => {
    if (stopped) return
    if (frame.type !== 'feedDelta' && frame.type !== 'feedRescope') {
      if (fromSocket) sink.frame(frame)
      return
    }
    if (!remember(frameKey(frame))) return
    sink.frame(frame)
    if (fromSocket) {
      channel?.postMessage({
        kind: 'podium-kernel-feed', version: 1, principal: options.principal, frame,
      } satisfies RelayedMessage)
    }
  }
  if (channel) channel.onmessage = (event) => {
    if (isRelayedMessage(event.data, options.principal)) deliver(event.data.frame, false)
  }
  return {
    feed: {
      syncHttp: sink.syncHttp,
      requestRebootstrap: () => { if (!stopped) sink.requestRebootstrap?.() },
      helloFields: () => sink.helloFields(),
      connected: (worldPromised) => { if (!stopped) sink.connected(worldPromised) },
      disconnected: () => sink.disconnected(),
      frame: (frame) => deliver(frame, true),
    },
    dispose: () => {
      if (stopped) return
      stopped = true
      if (channel) channel.onmessage = null
      channel?.close()
      seen.clear()
    },
  }
}
