import {
  issueDisplayRef,
  type AgentPhase,
  type AgentRuntimeState,
  type IssueWire,
} from '@podium/protocol'
import type { PodiumSettings } from '@podium/runtime'
import { pushTelegramText, type TelegramConfig } from '../../notify'
import type { EventBus } from '../bus'
import {
  buildIssuesMessage,
  HELP_TEXT,
  parseIssueCallbackData,
  parseSlashCommand,
  pickIssueSession,
  registerTelegramCommands,
} from './commands'
import { TelegramChannel } from './telegram'
import type { MessagingIssueTopicRow } from '../../store/messaging-topics'
import type {
  ChannelAdapter,
  ConversationRef,
  InboundChatMessage,
  SendOptions,
  TelegramNoticePort,
} from './types'

/** How a superagent turn is dispatched — the slice of SuperagentService the
 *  bridge needs (kept narrow for tests). */
export interface SuperagentTurnPort {
  sendTurn(input: {
    threadId: string
    text: string
  }): Promise<{ threadId: string; podiumSessionId: string }>
  interruptTurn(input: { threadId: string }): void
  restartThread(input: { threadId: string }): void
  startBtwTurn(input: { sessionId: string }): { threadId: string; isNew: boolean }
  ensureConciergeThread(input: { repoPath: string }): { threadId: string; isNew: boolean }
}

/** Persisted forum-topic ↔ superagent-thread bindings. */
export interface MessagingTopicsPort {
  listForChat(chatId: string): MessagingIssueTopicRow[]
  getByIssue(chatId: string, issueId: string): MessagingIssueTopicRow | undefined
  getByThreadRef(chatId: string, threadRef: string): MessagingIssueTopicRow | undefined
  upsert(row: MessagingIssueTopicRow): void
}

export interface MessagingDeps {
  bus: EventBus
  getSettings(): PodiumSettings
  superagent: SuperagentTurnPort
  /** Issue list for /issues slash commands. */
  issues?: { list(): IssueWire[] }
  /** Forum-topic bindings (SQLite). */
  topics?: MessagingTopicsPort
  /** Session → explicit issue attachment for notice topic routing. */
  sessionIssueId?: (sessionId: string) => string | null
  /** True while the settings telegram-setup pairing window owns getUpdates. */
  telegramSetupPending?: () => boolean
  /** Adapter factory — injected in tests. */
  createTelegram?: (config: { botToken: string; chatId: string }) => ChannelAdapter
  /** Telegram setMyCommands — injected in tests. */
  registerTelegramCommands?: (botToken: string) => Promise<void>
}

interface QueuedInbound {
  threadId: string
  source: ConversationRef
  text: string
  senderLabel?: string
}

interface AwaitedReply {
  source: ConversationRef
}

/** One shared typing interval per conversation target, refcounted by owner so
 *  superagent-turn typing and ambient session-working typing never double-fire
 *  into the same topic [spec:SP-62c3]. */
interface TypingLease {
  source: ConversationRef
  interval: ReturnType<typeof setInterval>
  owners: Set<string>
}

const QUEUE_CAP = 20
/** Telegram's typing action lasts ~5s; refresh a beat earlier so it never lapses. */
export const TYPING_REFRESH_MS = 4000

/** Phases that mean the agent is actively working (ambient typing on). */
function isWorkingPhase(phase: AgentPhase): boolean {
  return phase === 'working' || phase === 'compacting'
}

function conversationKey(ref: ConversationRef): string {
  return `${ref.chatId}\0${ref.threadRef ?? ''}`
}

/**
 * Two-way messaging-app bridge [spec:SP-5d81]. Inbound chat messages become
 * superagent turns; the reply text rides the `superagent.turnEnded` bus event
 * back to the chat. Attention notices ride the same ChannelAdapter (formatting,
 * chunking, forum-topic threading) via {@link sendNotice}, with a direct-send
 * fallback when the bridge is stopped.
 *
 * Ambient working signal [spec:SP-62c3]: while a session bound to an issue
 * forum topic is in a working phase, refresh `sendChatAction` typing into that
 * topic. Driven by `session.stateChanged` + session→issue→topic binding (the
 * reverse of {@link noticeThreadRef}). Sessions without a bound topic are
 * silent. Superagent-turn typing shares the same per-topic lease so the two
 * paths never double-fire.
 *
 * Thread mapping: main chat → global; forum topics opened from /issues buttons
 * map to btw_<session> (live agent) or the repo concierge thread. Bindings
 * persist in `messaging_issue_topics`. `resolveThreadId` is the seam.
 */
export class MessagingService implements TelegramNoticePort {
  private adapter: ChannelAdapter | undefined
  private adapterKey = ''
  /** Last inbound conversation ref from the configured chat — used when a notice
   *  has no sessionId (e.g. subscription notifyExternal). Session-scoped notices
   *  route via issue-topic bindings instead. */
  private lastInboundRef: ConversationRef | undefined
  /** FIFO of inbound messages not yet dispatched, per superagent thread. */
  private readonly queues = new Map<string, QueuedInbound[]>()
  /** Turns this bridge dispatched and is awaiting, per superagent thread. */
  private readonly awaiting = new Map<string, AwaitedReply>()
  /** Threads with a sendTurn dispatch in flight (pre-ack) — a second pump
   *  while the first promise is pending must not re-send queue[0]. */
  private readonly dispatching = new Set<string>()
  /** Forum-topic threadRef → superagent thread id. */
  private readonly topicThreadByRef = new Map<string, string>()
  /** Issue id → forum-topic threadRef for reopen. */
  private readonly topicRefByIssue = new Map<string, string>()
  /** Shared typing intervals, keyed by conversation (chatId + threadRef). */
  private readonly typingLeases = new Map<string, TypingLease>()
  /** Ambient typing owners still held for a session (sessionId → conversation key). */
  private readonly ambientTypingBySession = new Map<string, string>()

  constructor(private readonly deps: MessagingDeps) {
    deps.bus.on('superagent.turnEnded', (ev) => this.onTurnEnded(ev))
    deps.bus.on('settings.changed', () => this.configure())
    deps.bus.on('session.stateChanged', ({ sessionId, next }) => {
      this.onSessionStateChanged(sessionId, next)
    })
    deps.bus.on('session.exited', ({ sessionId }) => {
      this.stopAmbientTyping(sessionId)
    })
  }

  /** (Re)build the adapter from current settings. Safe to call repeatedly. */
  configure(): void {
    const n = this.deps.getSettings().notifications
    const botToken = n.telegramBotToken.trim()
    const chatId = n.telegramChatId.trim()
    const key = botToken && chatId ? `${botToken}\n${chatId}` : ''
    if (key === this.adapterKey) return
    this.clearAllTyping()
    this.adapter?.stop()
    this.adapter = undefined
    this.adapterKey = key
    if (!key) return
    const create =
      this.deps.createTelegram ??
      ((config: { botToken: string; chatId: string }) =>
        new TelegramChannel(config, this.deps.telegramSetupPending ?? (() => false)))
    this.adapter = create({ botToken, chatId })
    this.adapter.start((msg) => this.onInbound(msg))
    const register = this.deps.registerTelegramCommands ?? registerTelegramCommands
    void register(botToken).catch((err) => {
      console.warn(
        '[podium:messaging] command menu registration failed:',
        err instanceof Error ? err.message : err,
      )
    })
    this.loadTopicMappings(chatId)
    console.log('[podium:messaging] telegram bridge polling as configured chat', chatId)
  }

  stop(): void {
    this.clearAllTyping()
    this.adapter?.stop()
    this.adapter = undefined
    this.adapterKey = ''
    this.lastInboundRef = undefined
  }

  /**
   * Fire-and-forget attention notice. Uses the live ChannelAdapter when running;
   * falls back to bare sendMessage when the bridge is stopped or config differs.
   *
   * When `sessionId` is set, route to the issue's bound forum topic (if any) and
   * otherwise the main chat. Without `sessionId`, thread into the last inbound
   * forum topic (subscription / legacy callers).
   */
  sendNotice(text: string, config: TelegramConfig, opts?: { sessionId?: string }): void {
    const botToken = config.botToken.trim()
    const chatId = config.chatId.trim()
    if (!botToken || !chatId) return
    const key = `${botToken}\n${chatId}`

    if (this.adapter && key === this.adapterKey) {
      const threadRef = this.noticeThreadRef(chatId, opts?.sessionId)
      const target: ConversationRef = {
        channel: 'telegram',
        chatId,
        ...(threadRef ? { threadRef } : {}),
      }
      void this.adapter.send(target, text).catch((err) => {
        console.warn('[podium] Telegram push failed:', err instanceof Error ? err.message : err)
      })
      return
    }
    pushTelegramText(config, text)
  }

  /** Resolve the forum topic for an outbound notice. */
  private noticeThreadRef(chatId: string, sessionId?: string): string | undefined {
    if (sessionId) {
      const issueId = this.deps.sessionIssueId?.(sessionId)
      if (!issueId) return undefined
      return (
        this.deps.topics?.getByIssue(chatId, issueId)?.threadRef ??
        this.topicRefByIssue.get(issueId)
      )
    }
    if (this.lastInboundRef?.chatId === chatId && this.lastInboundRef.threadRef) {
      return this.lastInboundRef.threadRef
    }
    return undefined
  }

  private loadTopicMappings(chatId: string): void {
    this.topicThreadByRef.clear()
    this.topicRefByIssue.clear()
    for (const row of this.deps.topics?.listForChat(chatId) ?? []) {
      this.topicThreadByRef.set(row.threadRef, row.superagentThreadId)
      this.topicRefByIssue.set(row.issueId, row.threadRef)
    }
  }

  /** Map a chat location to a superagent thread. Main chat → global; a forum
   *  topic → the btw/concierge thread bound when the issue button was opened. */
  private resolveThreadId(msg: InboundChatMessage): string {
    const ref = msg.source.threadRef
    if (!ref) return 'global'
    const cached = this.topicThreadByRef.get(ref)
    if (cached) return cached
    const row = this.deps.topics?.getByThreadRef(msg.source.chatId, ref)
    if (row) {
      this.topicThreadByRef.set(ref, row.superagentThreadId)
      this.topicRefByIssue.set(row.issueId, ref)
      return row.superagentThreadId
    }
    return 'global'
  }

  private resolveIssueThread(issue: IssueWire): string {
    const session = pickIssueSession(issue)
    if (session) {
      return this.deps.superagent.startBtwTurn({ sessionId: session.sessionId }).threadId
    }
    return this.deps.superagent.ensureConciergeThread({ repoPath: issue.repoPath }).threadId
  }

  private issueThreadNote(issue: IssueWire): string {
    const session = pickIssueSession(issue)
    if (session) {
      return `Agent session ${session.name ?? session.title} is wired to this topic.`
    }
    return `No agent session — messages here go to the ${issue.repoPath} concierge.`
  }

  private onInbound(msg: InboundChatMessage): void {
    this.lastInboundRef = msg.source
    if (msg.callback) {
      void this.handleCallback(msg)
      return
    }
    const slash = parseSlashCommand(msg.text)
    if (slash) {
      const threadId = this.resolveThreadId(msg)
      void this.handleSlash(threadId, msg.source, slash)
      return
    }
    const threadId = this.resolveThreadId(msg)
    const queue = this.queues.get(threadId) ?? []
    if (queue.length >= QUEUE_CAP) {
      void this.reply(msg.source, '⚠️ Message queue is full — wait for the current replies.')
      return
    }
    queue.push({
      threadId,
      source: msg.source,
      text: msg.text,
      ...(msg.senderLabel ? { senderLabel: msg.senderLabel } : {}),
    })
    this.queues.set(threadId, queue)
    this.pump(threadId)
  }

  private acquireTyping(owner: string, source: ConversationRef): void {
    const key = conversationKey(source)
    const existing = this.typingLeases.get(key)
    if (existing) {
      existing.owners.add(owner)
      return
    }
    this.adapter?.sendTyping?.(source)
    const interval = setInterval(() => this.adapter?.sendTyping?.(source), TYPING_REFRESH_MS)
    ;(interval as { unref?: () => void }).unref?.()
    this.typingLeases.set(key, { source, interval, owners: new Set([owner]) })
  }

  private releaseTyping(owner: string, source: ConversationRef): void {
    const key = conversationKey(source)
    const lease = this.typingLeases.get(key)
    if (!lease) return
    lease.owners.delete(owner)
    if (lease.owners.size > 0) return
    clearInterval(lease.interval)
    this.typingLeases.delete(key)
  }

  private clearAllTyping(): void {
    for (const lease of this.typingLeases.values()) clearInterval(lease.interval)
    this.typingLeases.clear()
    this.ambientTypingBySession.clear()
  }

  /** Ambient typing into the issue's bound forum topic while the agent works
   *  [spec:SP-62c3]. No-op when the session has no bound topic. */
  private onSessionStateChanged(sessionId: string, next: AgentRuntimeState): void {
    if (isWorkingPhase(next.phase)) this.startAmbientTyping(sessionId)
    else this.stopAmbientTyping(sessionId)
  }

  private startAmbientTyping(sessionId: string): void {
    if (this.ambientTypingBySession.has(sessionId)) return
    if (!this.adapter) return
    const chatId = this.deps.getSettings().notifications.telegramChatId.trim()
    if (!chatId) return
    const threadRef = this.noticeThreadRef(chatId, sessionId)
    // Only indicate for sessions with a bound issue topic — never main chat.
    if (!threadRef) return
    const source: ConversationRef = {
      channel: 'telegram',
      chatId,
      threadRef,
    }
    const owner = ambientTypingOwner(sessionId)
    this.acquireTyping(owner, source)
    this.ambientTypingBySession.set(sessionId, conversationKey(source))
  }

  private stopAmbientTyping(sessionId: string): void {
    const key = this.ambientTypingBySession.get(sessionId)
    if (!key) return
    this.ambientTypingBySession.delete(sessionId)
    const lease = this.typingLeases.get(key)
    if (!lease) return
    this.releaseTyping(ambientTypingOwner(sessionId), lease.source)
  }

  private pump(threadId: string): void {
    if (this.awaiting.has(threadId) || this.dispatching.has(threadId)) return
    const queue = this.queues.get(threadId)
    const next = queue?.[0]
    if (!next) return
    this.dispatching.add(threadId)
    const turnOwner = turnTypingOwner(threadId)
    this.acquireTyping(turnOwner, next.source)
    void this.deps.superagent
      .sendTurn({ threadId, text: this.turnText(next) })
      .then(() => {
        this.dispatching.delete(threadId)
        queue?.shift()
        this.awaiting.set(threadId, { source: next.source })
      })
      .catch((err: unknown) => {
        this.dispatching.delete(threadId)
        this.releaseTyping(turnOwner, next.source)
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('already running')) return
        queue?.shift()
        void this.reply(next.source, `⚠️ Could not reach the superagent: ${message}`)
        this.pump(threadId)
      })
  }

  private async handleSlash(
    threadId: string,
    source: ConversationRef,
    slash: { command: string; args: string[] },
  ): Promise<void> {
    try {
      switch (slash.command) {
        case 'help':
          await this.reply(source, HELP_TEXT)
          return
        case 'issues': {
          const list = this.deps.issues?.list()
          if (!list) {
            await this.reply(source, 'Issue list is unavailable.')
            return
          }
          const built = buildIssuesMessage(list, slash.args[0])
          await this.reply(
            source,
            built.text,
            built.buttons ? { replyMarkup: { inlineKeyboard: built.buttons } } : undefined,
          )
          return
        }
        case 'stop':
          try {
            this.deps.superagent.interruptTurn({ threadId })
            await this.reply(source, 'Stopping the current turn…')
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            await this.reply(source, `⚠️ ${message}`)
          }
          return
        case 'new':
          try {
            this.deps.superagent.restartThread({ threadId })
            this.queues.delete(threadId)
            await this.reply(source, 'Superagent thread restarted — next message uses a fresh harness session.')
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            await this.reply(source, `⚠️ ${message}`)
          }
          return
      }
    } catch (err) {
      console.warn('[podium:messaging] slash command failed:', err)
      await this.reply(source, '⚠️ Command failed — try again or use /help.')
    }
  }

  private turnText(msg: QueuedInbound): string {
    const sender = msg.senderLabel ? ` from ${msg.senderLabel}` : ''
    return `(Telegram message${sender} — you are replying into a phone chat: be concise, plain text, no markdown tables)\n\n${msg.text}`
  }

  private onTurnEnded(ev: { threadId: string; ok: boolean; output?: string; error?: string }): void {
    const awaited = this.awaiting.get(ev.threadId)
    if (awaited) {
      this.releaseTyping(turnTypingOwner(ev.threadId), awaited.source)
      this.awaiting.delete(ev.threadId)
      const text = ev.ok
        ? (ev.output?.trim() || '(the superagent finished without a text reply)')
        : `⚠️ Turn failed: ${ev.error ?? 'unknown error'}`
      void this.reply(awaited.source, text)
    }
    this.pump(ev.threadId)
  }

  private async handleCallback(msg: InboundChatMessage): Promise<void> {
    const cb = msg.callback
    if (!cb) return
    const issueId = parseIssueCallbackData(cb.data)
    try {
      if (!issueId) {
        await this.adapter?.answerCallback?.(cb.id, 'Unknown button')
        return
      }
      const issues = this.deps.issues?.list()
      const issue = issues?.find((i) => i.id === issueId)
      if (!issue) {
        await this.adapter?.answerCallback?.(cb.id, 'Issue not found')
        return
      }
      const opened = await this.openIssueTopic(msg.source.chatId, issue)
      await this.adapter?.answerCallback?.(cb.id, opened.reused ? 'Opened topic' : 'Created topic')
      await this.reply(
        { channel: msg.source.channel, chatId: msg.source.chatId, threadRef: opened.threadRef },
        opened.text,
      )
    } catch (err) {
      console.warn('[podium:messaging] callback failed:', err)
      try {
        // Bot API 9.3: bots may only create topics in a private chat after the
        // USER enables topic mode for it — surface the one-time setup step
        // instead of a dead-end toast.
        if (isNotAForumError(err)) {
          await this.adapter?.answerCallback?.(cb.id, 'Topic mode not enabled for this bot')
          await this.reply(
            { channel: msg.source.channel, chatId: msg.source.chatId },
            'Topic mode is off for this bot: enable it in @BotFather → /mybots → ' +
              'select this bot → Bot Settings → "Thread mode". Then tap the issue button again.',
          )
          return
        }
        await this.adapter?.answerCallback?.(cb.id, 'Could not open issue topic')
      } catch {
        /* best-effort */
      }
    }
  }

  private persistTopicBinding(
    issueId: string,
    chatId: string,
    threadRef: string,
    superagentThreadId: string,
  ): void {
    this.topicRefByIssue.set(issueId, threadRef)
    this.topicThreadByRef.set(threadRef, superagentThreadId)
    this.deps.topics?.upsert({
      issueId,
      chatId,
      threadRef,
      superagentThreadId,
      updatedAt: new Date().toISOString(),
    })
  }

  private async openIssueTopic(
    chatId: string,
    issue: IssueWire,
  ): Promise<{ threadRef: string; text: string; reused: boolean }> {
    const threadId = this.resolveIssueThread(issue)
    const ref = issueDisplayRef(issue)
    const sessionNote = this.issueThreadNote(issue)
    const existing =
      this.deps.topics?.getByIssue(chatId, issue.id)?.threadRef ??
      this.topicRefByIssue.get(issue.id)
    if (existing) {
      this.persistTopicBinding(issue.id, chatId, existing, threadId)
      return {
        threadRef: existing,
        reused: true,
        text: `${ref} ${issue.title}\n${sessionNote}\nReply in this topic to continue.`,
      }
    }
    if (!this.adapter?.createForumTopic) {
      throw new Error('forum topics are not supported by the messaging adapter')
    }
    const topicName = `${ref} ${issue.title}`.slice(0, 128)
    const { threadRef } = await this.adapter.createForumTopic(chatId, topicName)
    this.persistTopicBinding(issue.id, chatId, threadRef, threadId)
    return {
      threadRef,
      reused: false,
      text: `${ref} ${issue.title}\n${sessionNote}\nReply in this topic to continue.`,
    }
  }

  private async reply(
    target: ConversationRef,
    text: string,
    opts?: SendOptions,
  ): Promise<void> {
    try {
      await this.adapter?.send(target, text, opts)
    } catch (err) {
      console.warn('[podium:messaging] reply send failed:', err instanceof Error ? err.message : err)
    }
  }
}
/** Telegram's "Bad Request: the chat is not a forum" — topic mode not enabled
 *  by the user for this private chat (Bot API 9.3 has_topics_enabled). */
function isNotAForumError(err: unknown): boolean {
  return err instanceof Error && /not a forum/i.test(err.message)
}

function turnTypingOwner(threadId: string): string {
  return `turn:${threadId}`
}

function ambientTypingOwner(sessionId: string): string {
  return `session:${sessionId}`
}
