import { createLogger, describeError } from '@podium/logger'
import type {
  AgentKind,
  AgentPhase,
  AgentRuntimeState,
  SessionId,
  SessionStatus,
  TranscriptItem,
  UserId,
} from '@podium/model'
import type { MessagingSessionAttachmentRow } from '../../store/messaging-session-attachments'
import type { EventBus } from '../bus'
import { parseSessionCallbackData, sessionCallbackData, type SlashCommand } from './commands'
import { formatTopicRecap } from './topic-recap'
import type { ConversationRef, InboundChatMessage, InlineButton, SendOptions } from './types'

const log = createLogger('server:messaging:attach')

/**
 * What the bridge knows about a session it may attach a chat to. Read fresh
 * from the server for every message — the attachment row names a session, it
 * never caches what that session is doing.
 */
export interface AttachableSession {
  sessionId: SessionId
  ownerUserId: UserId
  /** The session's name, else its title. */
  label: string
  /** Birth ref (`POD-12-A`) when it has one. */
  ref?: string
  status: SessionStatus
  /** Running, and the server has no daemon link to its machine right now
   *  (`isSessionReconnecting`, ADR 12 D1). */
  reconnecting: boolean
  archived: boolean
  /** The superagent's own sessions — never attachable. */
  headless: boolean
  agentKind: AgentKind
  /** A parked/exited session that can be resumed. */
  resumable: boolean
  phase?: AgentPhase
  lastActiveAt: string
}

export type SessionResolution =
  | { kind: 'session'; session: AttachableSession }
  /** Unknown, or not a session this user may command — deliberately one answer. */
  | { kind: 'absent' }
  | { kind: 'ambiguous'; message: string }

/** What a send through the session command plane answered. */
export interface DirectSendOutcome {
  ok: boolean
  /** Held behind a running turn (or a reconnecting machine) in the durable queue. */
  queued?: boolean
  position?: number
  reason?: string
}

/**
 * The bridge's way into sessions, AS THE BOUND USER. Every method runs under
 * the user's own principal through the same command plane and transcript read
 * the web uses, so the bridge adds no second answer to "who may do what".
 */
export interface DirectSessionPort {
  /** An id, short id or birth ref, resolved and gated by the user's access. */
  resolve(userId: UserId, identifier: string): Promise<SessionResolution>
  /** One session's current facts under the same gate; undefined when absent. */
  describe(userId: UserId, sessionId: SessionId): Promise<AttachableSession | undefined>
  /** The user's own running sessions, for discovery. */
  listRunning(userId: UserId): Promise<AttachableSession[]>
  /** `sessions.sendText`: never wakes a live session, queues behind a busy one. */
  send(userId: UserId, sessionId: SessionId, text: string): Promise<DirectSendOutcome>
  /** `sessions.interrupt`. */
  interrupt(userId: UserId, sessionId: SessionId): Promise<{ ok: boolean; reason?: string }>
  /** `sessions.resurrect` — the only path here that starts a process. */
  wake(userId: UserId, sessionId: SessionId): Promise<{ ok: boolean; reason?: string }>
  /** The newest transcript items, read as the user. */
  readTail(userId: UserId, sessionId: SessionId, limit: number): Promise<TranscriptItem[]>
}

export interface SessionAttachmentStore {
  get(chatId: string, threadRef: string): Promise<MessagingSessionAttachmentRow | undefined>
  listForSession(sessionId: SessionId): Promise<MessagingSessionAttachmentRow[]>
  upsert(row: MessagingSessionAttachmentRow): Promise<void>
  remove(chatId: string, threadRef: string): Promise<void>
  markRelayed(chatId: string, threadRef: string, sessionId: SessionId, itemId: string): Promise<void>
}

export interface SessionAttachmentDeps {
  bus: EventBus
  store: SessionAttachmentStore
  sessions: DirectSessionPort
  reply(target: ConversationRef, text: string, opts?: SendOptions): Promise<void>
  /** Dismiss an inline-button press's spinner. */
  answerCallback(callbackQueryId: string, text?: string): Promise<void>
  /** The bridge's per-conversation typing lease (shared with its other typing). */
  typing: {
    acquire(owner: string, source: ConversationRef): void
    release(owner: string, source: ConversationRef): void
  }
  /** What a conversation talks to when nothing is attached ("the superagent", …). */
  defaultRoute(source: ConversationRef): Promise<string>
  now?: () => number
  /** Delay before re-reading a transcript that had no new reply yet at turn end. */
  relayRetryMs?: number
}

const LIST_CAP = 10
const TAIL_LIMIT = 40
const RELAY_RETRY_MS = 2000
/** Phases a turn ends INTO; `compacting` is still inside the turn. */
const TURN_END_PHASES: ReadonlySet<AgentPhase> = new Set(['idle', 'needs_user', 'errored', 'ended'])
const TURN_PHASES: ReadonlySet<AgentPhase> = new Set(['working', 'compacting'])
const RUNNING: ReadonlySet<SessionStatus> = new Set(['live', 'starting'])
const NOT_AVAILABLE = '⚠️ The attached session is no longer available, so this was not sent.'

function threadRefOf(source: ConversationRef): string {
  return source.threadRef ?? ''
}

function conversationOf(row: MessagingSessionAttachmentRow): ConversationRef {
  return {
    channel: 'telegram',
    chatId: row.chatId,
    ...(row.threadRef ? { threadRef: row.threadRef } : {}),
  }
}

function typingOwner(sessionId: SessionId): string {
  return `attached:${sessionId}`
}

function nameOf(session: AttachableSession): string {
  return session.ref ? `${session.ref} ${session.label}` : session.label
}

function parked(session: AttachableSession): boolean {
  return session.status === 'hibernated' || session.status === 'exited'
}

/** Plain words for where a session is, for phone replies. */
export function sessionStateWords(session: AttachableSession): string {
  if (session.archived) return 'archived'
  if (parked(session)) return session.resumable ? 'parked' : 'ended'
  if (session.reconnecting) return 'reconnecting'
  if (session.status === 'starting') return 'starting'
  switch (session.phase) {
    case 'working':
    case 'compacting':
      return 'working'
    case 'needs_user':
      return 'waiting for you'
    case 'errored':
      return 'stopped on an error'
    default:
      return 'idle'
  }
}

/** The reply a turn ended with: its newest non-empty assistant text. */
export function latestReply(items: readonly TranscriptItem[]): TranscriptItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role !== 'assistant' || item.toolName || item.queued || item.dropped) continue
    if (item.text.trim()) return item
  }
  return undefined
}

/**
 * DIRECT SESSION ATTACHMENT (POD-6212). A bound Telegram conversation — the
 * main chat or one forum topic, each on its own — can be attached to one of the
 * bound user's own sessions. While attached, its plain messages are sent to
 * that session through the session command plane as the user, and each turn the
 * session finishes is relayed back as its reply.
 *
 * The attachment is a row, not memory: it survives restarts, and it is read on
 * every message, so a detach in one topic never moves another.
 *
 * NOTHING HERE CHOOSES A SESSION FOR THE USER. A session that is parked, has
 * exited, was archived or is no longer the user's is reported as exactly that
 * and the message is not sent anywhere — it is never woken implicitly and never
 * handed to the superagent or to another session instead. `/wake` is the one
 * explicit way to start it again.
 */
export class SessionAttachments {
  /** One relay at a time per session: two quick turn ends must not both send
   *  the same reply. Live runtime state, gone when the relay settles. */
  private readonly relayTails = new Map<SessionId, Promise<void>>()

  constructor(private readonly deps: SessionAttachmentDeps) {
    deps.bus.on('session.stateChanged', async ({ sessionId, prev, next }) => {
      await this.onStateChanged(sessionId, prev, next)
    })
    deps.bus.on('session.exited', async ({ sessionId }) => await this.onExited(sessionId))
  }

  /** This conversation's attachment, when the bound user made it. A row left by
   *  another account (the chat was re-bound since) speaks for nobody: it is
   *  cleared rather than used. */
  async attachmentFor(
    source: ConversationRef,
    userId: UserId,
  ): Promise<MessagingSessionAttachmentRow | undefined> {
    const row = await this.deps.store.get(source.chatId, threadRefOf(source))
    if (!row) return undefined
    if (row.userId === userId) return row
    await this.deps.store.remove(source.chatId, threadRefOf(source))
    return undefined
  }

  /** Slash commands this feature owns, plus `/stop` and `/new` while attached.
   *  Answers whether it handled the command. */
  async handleSlash(userId: UserId, source: ConversationRef, slash: SlashCommand): Promise<boolean> {
    switch (slash.command) {
      case 'sessions':
        await this.listSessions(userId, source)
        return true
      case 'attach': {
        const identifier = slash.rawArgs[0]
        if (identifier) await this.attach(userId, source, identifier)
        else await this.listSessions(userId, source)
        return true
      }
      case 'detach':
        await this.detach(userId, source)
        return true
      case 'status':
        await this.status(userId, source)
        return true
      case 'wake':
        await this.wake(userId, source)
        return true
      case 'stop': {
        const row = await this.attachmentFor(source, userId)
        if (!row) return false
        const result = await this.deps.sessions.interrupt(userId, row.sessionId)
        await this.deps.reply(
          source,
          result.ok ? 'Stopping the attached session’s turn…' : `⚠️ ${result.reason ?? 'Could not stop it.'}`,
        )
        return true
      }
      case 'new': {
        const row = await this.attachmentFor(source, userId)
        if (!row) return false
        await this.deps.reply(
          source,
          '/new restarts the superagent, but this chat is attached to a session. /detach first.',
        )
        return true
      }
      default:
        return false
    }
  }

  /** An attach button from /sessions. Answers whether the press was one. */
  async handleCallback(msg: InboundChatMessage, userId: UserId): Promise<boolean> {
    const sessionId = msg.callback ? parseSessionCallbackData(msg.callback.data) : undefined
    if (!msg.callback || !sessionId) return false
    await this.deps.answerCallback(msg.callback.id)
    await this.attach(userId, msg.source, sessionId)
    return true
  }

  /** A plain message. Answers whether this conversation is attached — when it
   *  is, the message is this feature's whatever happens to it. */
  async handleChat(msg: InboundChatMessage, userId: UserId): Promise<boolean> {
    const row = await this.attachmentFor(msg.source, userId)
    if (!row) return false
    const session = await this.deps.sessions.describe(userId, row.sessionId)
    const refusal = await this.sendRefusal(session, userId, msg.source)
    if (refusal !== undefined || !session) {
      await this.deps.reply(msg.source, refusal ?? NOT_AVAILABLE)
      return true
    }
    // The check above and the send below are two reads of the session's state;
    // the command plane re-reads it, and only a process that ended in between
    // can still be woken by this send.
    let outcome: DirectSendOutcome
    try {
      outcome = await this.deps.sessions.send(userId, row.sessionId, msg.text)
    } catch (err) {
      outcome = { ok: false, reason: describeError(err) }
    }
    if (!outcome.ok) {
      await this.deps.reply(msg.source, `⚠️ Not delivered to ${nameOf(session)}: ${outcome.reason ?? 'unknown reason'}.`)
      return true
    }
    if (outcome.queued) {
      const position = outcome.position ? ` (#${outcome.position})` : ''
      const why =
        session.reconnecting || session.status === 'starting'
          ? `${nameOf(session)} is ${sessionStateWords(session)}; it gets this once it is running.`
          : `${nameOf(session)} is busy; it gets this when the current turn ends.`
      await this.deps.reply(msg.source, `⏳ Queued${position}. ${why}`)
    }
    return true
  }

  /** Why a message cannot go to the attached session, or undefined when it can. */
  private async sendRefusal(
    session: AttachableSession | undefined,
    userId: UserId,
    source: ConversationRef,
  ): Promise<string | undefined> {
    if (!session || session.ownerUserId !== userId || session.archived) {
      return `${NOT_AVAILABLE} /detach returns this chat to ${await this.deps.defaultRoute(source)}.`
    }
    if (parked(session)) {
      return session.resumable
        ? `⏸ ${nameOf(session)} is parked, so this was not sent. /wake resumes it; then send again.`
        : `⚠️ ${nameOf(session)} has ended and cannot be resumed, so this was not sent. /detach returns this chat to ${await this.deps.defaultRoute(source)}.`
    }
    return undefined
  }

  private async attach(userId: UserId, source: ConversationRef, identifier: string): Promise<void> {
    const resolution = await this.deps.sessions.resolve(userId, identifier)
    if (resolution.kind === 'ambiguous') {
      await this.deps.reply(source, `⚠️ ${resolution.message}`)
      return
    }
    const session = resolution.kind === 'session' ? resolution.session : undefined
    // Another user's session is the SAME answer as no session: the bridge must
    // not tell a chat which sessions exist beyond its own user's.
    if (!session || session.ownerUserId !== userId) {
      await this.deps.reply(source, `⚠️ No session of yours matches “${identifier}”. /sessions lists them.`)
      return
    }
    const refusal = attachRefusal(session)
    if (refusal) {
      await this.deps.reply(source, `⚠️ ${refusal}`)
      return
    }
    // The watermark starts at the newest reply already there, so attaching
    // never relays an old turn as if it were new.
    const items = await this.readTail(userId, session.sessionId)
    const previous = await this.deps.store.get(source.chatId, threadRefOf(source))
    if (previous) this.deps.typing.release(typingOwner(previous.sessionId), source)
    await this.deps.store.upsert({
      chatId: source.chatId,
      threadRef: threadRefOf(source),
      userId,
      sessionId: session.sessionId,
      attachedAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
      relayedItemId: latestReply(items)?.id ?? null,
    })
    const lines = [
      `🔗 Attached to ${nameOf(session)} (${sessionStateWords(session)}).`,
      'Messages here now go to this session, and its replies come back here.',
      `/detach returns this chat to ${await this.deps.defaultRoute(source)}.`,
    ]
    if (parked(session)) lines.push('⏸ It is parked: messages will not wake it. /wake resumes it.')
    await this.deps.reply(source, lines.join('\n'))
    const recap = formatTopicRecap(items)
    if (recap) await this.deps.reply(source, recap)
    if (session.phase && TURN_PHASES.has(session.phase) && RUNNING.has(session.status)) {
      this.deps.typing.acquire(typingOwner(session.sessionId), source)
    }
  }

  private async detach(userId: UserId, source: ConversationRef): Promise<void> {
    const row = await this.attachmentFor(source, userId)
    const route = await this.deps.defaultRoute(source)
    if (!row) {
      await this.deps.reply(source, `This chat is not attached to a session. It talks to ${route}.`)
      return
    }
    await this.deps.store.remove(source.chatId, threadRefOf(source))
    this.deps.typing.release(typingOwner(row.sessionId), source)
    const session = await this.deps.sessions.describe(userId, row.sessionId)
    const name = session ? nameOf(session) : 'the session'
    await this.deps.reply(source, `Detached from ${name}. This chat talks to ${route} again.`)
  }

  private async status(userId: UserId, source: ConversationRef): Promise<void> {
    const row = await this.attachmentFor(source, userId)
    const route = await this.deps.defaultRoute(source)
    if (!row) {
      await this.deps.reply(source, `This chat talks to ${route}. /sessions to attach one of your sessions.`)
      return
    }
    const session = await this.deps.sessions.describe(userId, row.sessionId)
    if (!session || session.ownerUserId !== userId) {
      await this.deps.reply(
        source,
        `This chat is attached to a session that is no longer available. /detach returns it to ${route}.`,
      )
      return
    }
    await this.deps.reply(
      source,
      `This chat is attached to ${nameOf(session)} (${sessionStateWords(session)}). /detach returns it to ${route}.`,
    )
  }

  private async wake(userId: UserId, source: ConversationRef): Promise<void> {
    const row = await this.attachmentFor(source, userId)
    if (!row) {
      await this.deps.reply(source, 'This chat is not attached to a session. /sessions to attach one.')
      return
    }
    const session = await this.deps.sessions.describe(userId, row.sessionId)
    if (!session || session.ownerUserId !== userId || session.archived) {
      await this.deps.reply(source, '⚠️ The attached session is no longer available. /detach to leave it.')
      return
    }
    if (!parked(session)) {
      await this.deps.reply(source, `${nameOf(session)} is already running (${sessionStateWords(session)}).`)
      return
    }
    if (!session.resumable) {
      await this.deps.reply(source, `⚠️ ${nameOf(session)} has ended and cannot be resumed.`)
      return
    }
    const result = await this.deps.sessions.wake(userId, session.sessionId)
    await this.deps.reply(
      source,
      result.ok
        ? `Waking ${nameOf(session)}… send your message once it is running.`
        : `⚠️ Could not wake ${nameOf(session)}: ${result.reason ?? 'unknown reason'}.`,
    )
  }

  private async listSessions(userId: UserId, source: ConversationRef): Promise<void> {
    const [running, row] = await Promise.all([
      this.deps.sessions.listRunning(userId),
      this.attachmentFor(source, userId),
    ])
    const sessions = running
      .filter((s) => s.ownerUserId === userId && !attachRefusal(s))
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    if (sessions.length === 0) {
      await this.deps.reply(source, 'No running sessions of yours. /attach <id> attaches a parked one.')
      return
    }
    const shown = sessions.slice(0, LIST_CAP)
    const lines = shown.map((s) => {
      const mark = row?.sessionId === s.sessionId ? ' ← attached here' : ''
      return `• ${nameOf(s)} (${sessionStateWords(s)})${mark}`
    })
    const more = sessions.length > LIST_CAP ? `\n…and ${sessions.length - LIST_CAP} more` : ''
    const buttons: InlineButton[][] = shown.map((s) => [
      { label: buttonLabel(s), data: sessionCallbackData(s.sessionId) },
    ])
    await this.deps.reply(
      source,
      `Your running sessions:\n${lines.join('\n')}${more}\nTap one to attach this chat, or /attach <id>.`,
      { replyMarkup: { inlineKeyboard: buttons } },
    )
  }

  private async readTail(userId: UserId, sessionId: SessionId): Promise<TranscriptItem[]> {
    try {
      return await this.deps.sessions.readTail(userId, sessionId, TAIL_LIMIT)
    } catch (err) {
      log.warn('attached session transcript read failed', { err, sessionId })
      return []
    }
  }

  private async onStateChanged(
    sessionId: SessionId,
    prev: AgentRuntimeState | undefined,
    next: AgentRuntimeState,
  ): Promise<void> {
    const rows = await this.deps.store.listForSession(sessionId)
    if (rows.length === 0) return
    const working = TURN_PHASES.has(next.phase)
    for (const row of rows) {
      if (working) this.deps.typing.acquire(typingOwner(sessionId), conversationOf(row))
      else this.deps.typing.release(typingOwner(sessionId), conversationOf(row))
    }
    if (prev && TURN_PHASES.has(prev.phase) && TURN_END_PHASES.has(next.phase)) {
      await this.relay(sessionId, next, true)
    }
  }

  private async onExited(sessionId: SessionId): Promise<void> {
    const rows = await this.deps.store.listForSession(sessionId)
    for (const row of rows) {
      const source = conversationOf(row)
      this.deps.typing.release(typingOwner(sessionId), source)
      await this.deps.reply(
        source,
        `⏹ The attached session stopped running. Messages here will not reach it until /wake; /detach returns this chat to ${await this.deps.defaultRoute(source)}.`,
      )
    }
  }

  /** Relay each attached conversation's new reply, one relay per session at a time. */
  private async relay(sessionId: SessionId, state: AgentRuntimeState, retry: boolean): Promise<void> {
    const before = this.relayTails.get(sessionId) ?? Promise.resolve()
    const run = before.then(async () => await this.relayNow(sessionId, state, retry))
    const tail = run.catch((err: unknown) => {
      log.warn('attached session relay failed', { err, sessionId })
    })
    this.relayTails.set(sessionId, tail)
    await tail
    if (this.relayTails.get(sessionId) === tail) this.relayTails.delete(sessionId)
  }

  private async relayNow(sessionId: SessionId, state: AgentRuntimeState, retry: boolean): Promise<void> {
    const rows = await this.deps.store.listForSession(sessionId)
    let pending = false
    const tails = new Map<UserId, Promise<TranscriptItem[]>>()
    for (const row of rows) {
      const tail = tails.get(row.userId) ?? this.readTail(row.userId, sessionId)
      tails.set(row.userId, tail)
      const reply = latestReply(await tail)
      if (!reply || reply.id === row.relayedItemId) {
        pending = true
        continue
      }
      const waiting =
        state.phase === 'needs_user'
          ? '\n\n⏸ It is waiting for your answer to a question or permission prompt in Podium.'
          : ''
      await this.deps.reply(conversationOf(row), `${reply.text.trim()}${waiting}`)
      await this.deps.store.markRelayed(row.chatId, row.threadRef, sessionId, reply.id)
    }
    // The state can reach the server before the transcript's last line does;
    // look once more, a moment later, rather than lose the reply.
    if (pending && retry) {
      const timer = setTimeout(() => {
        void this.relay(sessionId, state, false)
      }, this.deps.relayRetryMs ?? RELAY_RETRY_MS)
      ;(timer as { unref?: () => void }).unref?.()
    }
  }
}

/** Why a session cannot be attached at all, or undefined when it can. */
function attachRefusal(session: AttachableSession): string | undefined {
  if (session.headless) return 'That is the superagent’s own session; talk to it in the main chat.'
  if (session.agentKind === 'shell') return 'That is a plain terminal, not an agent session.'
  if (session.archived) return `${nameOf(session)} is archived.`
  if (parked(session) && !session.resumable) return `${nameOf(session)} has ended and cannot be resumed.`
  return undefined
}

function buttonLabel(session: AttachableSession): string {
  const label = session.label.length > 24 ? `${session.label.slice(0, 23)}…` : session.label
  return session.ref ? `${session.ref} ${label}` : label
}
