import type { TelegramConfig } from '../../notify'

/**
 * Messaging-app bridge seam [spec:SP-5d81]. One normalized shape for "a human
 * said something in an external chat app" plus a thin per-platform adapter —
 * everything protocol-agnostic (thread mapping, per-thread queueing, reply
 * relay) lives in MessagingService, so a new app (Slack, WhatsApp, …) only
 * implements transport.
 */

/** Optional NotifyService injection — attention notices through the live adapter
 *  with a direct-send fallback when the bridge is stopped. */
export interface TelegramNoticePort {
  sendNotice(text: string, config: TelegramConfig): void
}

/** Normalized address of an external conversation. Different apps have
 *  different conversation models (bot DMs, channels, threads, forum topics) —
 *  `threadRef` carries the app's sub-conversation id when one exists. */
export interface ConversationRef {
  channel: string
  chatId: string
  threadRef?: string
}

/** An inbound human message from a messaging app. */
export interface InboundChatMessage {
  source: ConversationRef
  text: string
  senderLabel?: string
}

/** Transport adapter for one messaging platform. Implementations stay thin:
 *  receive → normalize → onMessage; send → chunk/format for the platform. */
export interface ChannelAdapter {
  readonly channel: string
  /** Begin receiving. Must be idempotent-safe to call after stop(). */
  start(onMessage: (msg: InboundChatMessage) => void): void
  stop(): void
  send(target: ConversationRef, text: string): Promise<void>
  /** Best-effort "the agent is typing" signal; optional per platform. */
  sendTyping?(target: ConversationRef): void
}
