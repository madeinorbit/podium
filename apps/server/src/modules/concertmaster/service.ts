/**
 * THE CONCERTMASTER SERVICE (POD-7211).
 *
 * A session marked as a Concertmaster is talked to through a curated
 * conversation: what its agent sends, what its person sends, and the agent's
 * asks. This service is every write to that conversation and the mark itself:
 *
 *  - the AGENT's commands, on its own session: {@link ConcertmasterService.say},
 *    {@link ConcertmasterService.ask}, {@link ConcertmasterService.update},
 *    {@link ConcertmasterService.resolve}, {@link ConcertmasterService.retract};
 *  - the PERSON's: {@link ConcertmasterService.assign} (the mark) and
 *    {@link ConcertmasterService.respond} (settle an ask, and tell the agent);
 *  - the SERVER's: {@link ConcertmasterService.recordDelivered}, which adds a
 *    message the person sent once the agent has it.
 *
 * WHO MAY is decided by the commands (`sync-write.ts`), from the caller's
 * capability; this service checks what is true of the session and the ask.
 * Limits are refused in sentences an agent can act on ({@link ConcertmasterRefusal}).
 *
 * EVERYTHING REFUSES WHILE THE FEATURE IS OFF. The mark is stored either way,
 * so turning the flag off and on again loses nothing.
 */

import { createLogger } from '@podium/logger'
import {
  CONCERTMASTER_ASK_KINDS,
  CONCERTMASTER_LIMITS,
  CONCERTMASTER_RESPONSE_MESSAGE_PREFIX,
  type ConcertmasterEntryWire,
  type ConcertmasterResponse,
  concertmasterAskNoun,
  concertmasterEntryId,
  concertmasterResponseText,
  concertmasterUserEntryId,
  isConcertmasterAskKind,
  isConcertmasterResponseMessageId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { ConcertmasterEntryRow, ConcertmasterRepository } from '../../store/concertmaster'
import type { MessageRow } from '../../store/types'
import type { MessageSender, MessageSendInput, MessageSendResult } from '../messages/types'
import type { MessageWriter } from '../messages/writer'
import type { SessionWriter } from '../sessions/session-lifecycle-types'
import { concertmasterBriefing, concertmasterRelease } from './briefing'
import { concertmasterEntryWireOf } from './records'

const log = createLogger('server:concertmaster')

/** What the service reads of a session: is it marked, and whose is it. */
export interface ConcertmasterSessionFacts {
  readonly concertmaster: boolean
  readonly agentKind: string
  readonly headless: boolean
  readonly deleted: boolean
}

/** A refusal in the service's own words. `kind` is the sync refusal it becomes. */
export class ConcertmasterRefusal extends Error {
  constructor(
    readonly kind: 'invalid' | 'unauthorized' | 'target-not-found' | 'conflict',
    message: string,
  ) {
    super(message)
  }
}

const invalid = (message: string): never => {
  throw new ConcertmasterRefusal('invalid', message)
}

/** The sender name of the server's own messages to a Concertmaster. */
export const CONCERTMASTER_SYSTEM_SENDER = 'concertmaster'

export interface ConcertmasterDeps {
  readonly entries: ConcertmasterRepository
  /** The `concertmaster` feature, read on every call. */
  enabled(): boolean
  now(): number
  /** A short random token: what makes an entry id unique within its instant. */
  mint(): string
  session(sessionId: SessionId): Promise<ConcertmasterSessionFacts | undefined>
  /** Write the mark on the session's own record. */
  setMark(writer: SessionWriter, sessionId: SessionId, concertmaster: boolean): Promise<void>
  /** The message service's one send path. */
  send(
    writer: MessageWriter,
    from: MessageSender,
    input: MessageSendInput,
  ): Promise<MessageSendResult>
  /** A stored message by id, for the delivered-message record. */
  message(id: string): Promise<MessageRow | null>
}

export interface ConcertmasterAskSummary {
  readonly number: number
  readonly kind: string
  readonly title: string
  readonly detail?: string
  readonly options?: readonly string[]
  readonly status: string
  readonly answer?: string
  readonly settledBy?: string
  readonly askedAt: string
  readonly settledAt?: string
}

/** A server composed without the service (a hand-built module set). */
export const CONCERTMASTER_NOT_SERVED = 'Concertmaster is not available on this server.'

const NOT_ENABLED =
  'Concertmaster is not enabled on this Podium instance (Settings → Labs → Concertmaster).'
const NOT_A_CONCERTMASTER =
  'This session is not a Concertmaster, so `podium concertmaster` does nothing here: its person reads the transcript. Use `podium offer` for next steps.'

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function optionsOf(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) invalid('options must be a list of short choices')
  const list = (raw as unknown[]).map((option, at) => {
    const choice = text(option)
    if (!choice || choice.length > CONCERTMASTER_LIMITS.option) {
      invalid(`option ${at + 1} must contain 1..${CONCERTMASTER_LIMITS.option} characters`)
    }
    return choice
  })
  if (list.length > CONCERTMASTER_LIMITS.options) {
    invalid(`at most ${CONCERTMASTER_LIMITS.options} options are allowed`)
  }
  if (new Set(list.map((option) => option.toLowerCase())).size !== list.length) {
    invalid('options must differ from each other')
  }
  return list
}

/** An ask's title: one line, so it reads in a list. */
function titleOf(raw: unknown): string {
  const title = text(raw).replace(/\s+/g, ' ')
  if (!title || title.length > CONCERTMASTER_LIMITS.title) {
    invalid(
      `title must be one line of 1..${CONCERTMASTER_LIMITS.title} characters; put the rest in --detail`,
    )
  }
  return title
}

function detailOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const detail = text(raw)
  if (detail.length > CONCERTMASTER_LIMITS.detail) {
    invalid(`detail must contain at most ${CONCERTMASTER_LIMITS.detail} characters`)
  }
  return detail || undefined
}

function numberOf(raw: unknown): number {
  const number = typeof raw === 'string' ? Number(raw.replace(/^#/, '')) : raw
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    invalid('name the ask by its number, as `podium concertmaster list` shows it (for example 3)')
  }
  return number as number
}

/** What a kind requires of its options. */
function checkOptions(kind: string, options: readonly string[] | undefined): void {
  if (kind === 'decision' && (options?.length ?? 0) < 2) {
    invalid(
      'a decision needs at least two options to pick from (--option "…" --option "…"); for an open answer use --kind question',
    )
  }
  if (kind === 'todo' && (options?.length ?? 0) > 0) {
    invalid('a todo takes no options: it is something the person does, not a choice')
  }
}

const settledWords = (ask: ConcertmasterEntryRow): string =>
  `ask #${ask.number} is already ${ask.status}${ask.settledBy === 'user' ? ' by the person' : ''}`

function summaryOf(row: ConcertmasterEntryRow): ConcertmasterAskSummary {
  return {
    number: row.number ?? 0,
    kind: row.askKind ?? 'question',
    title: row.body,
    ...(row.detail !== null ? { detail: row.detail } : {}),
    ...(row.options !== null && row.options.length > 0 ? { options: row.options } : {}),
    status: row.status ?? 'open',
    ...(row.answer !== null ? { answer: row.answer } : {}),
    ...(row.settledBy !== null ? { settledBy: row.settledBy } : {}),
    askedAt: row.createdAt,
    ...(row.settledAt !== null ? { settledAt: row.settledAt } : {}),
  }
}

export class ConcertmasterService {
  constructor(private readonly deps: ConcertmasterDeps) {}

  /** Whether the feature is on: what every surface asks before it offers anything. */
  enabled(): boolean {
    return this.deps.enabled()
  }

  /** Whether the session is a Concertmaster right now (marked, and the feature on). */
  async isConcertmaster(sessionId: SessionId): Promise<boolean> {
    if (!this.deps.enabled()) return false
    return (await this.deps.session(sessionId))?.concertmaster === true
  }

  private at(): string {
    return new Date(this.deps.now()).toISOString()
  }

  /** The calling session, proven a Concertmaster; refuses in the agent's words otherwise. */
  private async requireConcertmaster(sessionId: SessionId): Promise<void> {
    if (!this.deps.enabled()) throw new ConcertmasterRefusal('unauthorized', NOT_ENABLED)
    const session = await this.deps.session(sessionId)
    if (session === undefined || session.deleted) {
      throw new ConcertmasterRefusal('target-not-found', 'this session no longer exists')
    }
    if (!session.concertmaster) throw new ConcertmasterRefusal('unauthorized', NOT_A_CONCERTMASTER)
  }

  private async requireAsk(
    sessionId: SessionId,
    rawNumber: unknown,
  ): Promise<ConcertmasterEntryRow> {
    const number = numberOf(rawNumber)
    const ask = await this.deps.entries.ask(sessionId, number)
    if (ask === undefined) {
      throw new ConcertmasterRefusal(
        'target-not-found',
        `this session has no ask #${number}; \`podium concertmaster list --all\` shows its asks`,
      )
    }
    return ask
  }

  // -------------------------------------------------------------------------
  // The agent's commands
  // -------------------------------------------------------------------------

  /** Send one message to the session's person. */
  async say(
    sessionId: SessionId,
    input: { body?: unknown; artifacts?: unknown },
  ): Promise<{ entryId: string }> {
    await this.requireConcertmaster(sessionId)
    const body = text(input.body)
    if (!body || body.length > CONCERTMASTER_LIMITS.body) {
      invalid(`a message must contain 1..${CONCERTMASTER_LIMITS.body} characters`)
    }
    let artifacts: string[] | undefined
    if (input.artifacts !== undefined && input.artifacts !== null) {
      if (!Array.isArray(input.artifacts)) invalid('artifacts must be a list of artifact names')
      artifacts = (input.artifacts as unknown[]).map((raw, at) => {
        const name = text(raw)
        if (!name || name.length > CONCERTMASTER_LIMITS.artifact) {
          invalid(
            `artifact ${at + 1}: name must contain 1..${CONCERTMASTER_LIMITS.artifact} characters`,
          )
        }
        return name
      })
      if (artifacts.length > CONCERTMASTER_LIMITS.artifacts) {
        invalid(`at most ${CONCERTMASTER_LIMITS.artifacts} artifacts are allowed`)
      }
    }
    const createdAt = this.at()
    const row = await this.deps.entries.addSay({
      id: concertmasterEntryId(createdAt, this.deps.mint()),
      sessionId,
      body,
      ...(artifacts !== undefined && artifacts.length > 0 ? { artifacts } : {}),
      createdAt,
    })
    return { entryId: row.id }
  }

  /** Open an ask; answers its number, the handle every later command names. */
  async ask(
    sessionId: SessionId,
    input: { kind?: unknown; title?: unknown; detail?: unknown; options?: unknown },
  ): Promise<{ number: number; entryId: string }> {
    await this.requireConcertmaster(sessionId)
    const kind = input.kind === undefined || input.kind === null ? 'question' : text(input.kind)
    if (!isConcertmasterAskKind(kind)) {
      invalid(`kind must be one of ${CONCERTMASTER_ASK_KINDS.join(', ')}`)
    }
    const title = titleOf(input.title)
    const detail = detailOf(input.detail)
    const options = optionsOf(input.options)
    checkOptions(kind, options)
    const createdAt = this.at()
    const row = await this.deps.entries.addAsk({
      id: concertmasterEntryId(createdAt, this.deps.mint()),
      sessionId,
      askKind: kind,
      title,
      ...(detail !== undefined ? { detail } : {}),
      ...(options !== undefined && options.length > 0 ? { options } : {}),
      createdAt,
    })
    return { number: row.number ?? 0, entryId: row.id }
  }

  /** Rewrite an open ask's words; a field left out keeps its value. */
  async update(
    sessionId: SessionId,
    input: { number?: unknown; title?: unknown; detail?: unknown; options?: unknown },
  ): Promise<{ number: number }> {
    await this.requireConcertmaster(sessionId)
    const ask = await this.requireAsk(sessionId, input.number)
    if (ask.status !== 'open') {
      throw new ConcertmasterRefusal(
        'conflict',
        `${settledWords(ask)}, so its words can no longer change; open a new ask instead`,
      )
    }
    if (input.title === undefined && input.detail === undefined && input.options === undefined) {
      invalid('nothing to change: give --title, --detail or --option')
    }
    const title = input.title === undefined ? ask.body : titleOf(input.title)
    const detail = input.detail === undefined ? (ask.detail ?? undefined) : detailOf(input.detail)
    const options =
      input.options === undefined ? (ask.options ?? undefined) : optionsOf(input.options)
    checkOptions(ask.askKind ?? 'question', options)
    const rewritten = await this.deps.entries.rewriteAsk(ask.id, {
      title,
      detail: detail ?? null,
      options: options ?? null,
    })
    if (rewritten === null) {
      throw new ConcertmasterRefusal('conflict', `ask #${ask.number} was settled just now`)
    }
    return { number: ask.number ?? 0 }
  }

  /**
   * The agent settles an ask. Settling one that is already settled is no
   * error: the list is true either way, and the answer says which it was.
   */
  private async settleByAgent(
    sessionId: SessionId,
    rawNumber: unknown,
    status: 'answered' | 'retracted',
    words: unknown,
  ): Promise<{ number: number; settled: boolean; notice?: string }> {
    await this.requireConcertmaster(sessionId)
    const ask = await this.requireAsk(sessionId, rawNumber)
    const answer = text(words)
    if (answer.length > CONCERTMASTER_LIMITS.body) {
      invalid(`the text must contain at most ${CONCERTMASTER_LIMITS.body} characters`)
    }
    const number = ask.number ?? 0
    if (ask.status !== 'open') return { number, settled: false, notice: `${settledWords(ask)}.` }
    const settled = await this.deps.entries.settleAsk(ask.id, {
      status,
      answer: answer || null,
      settledAt: this.at(),
      settledBy: 'agent',
    })
    return settled === null
      ? { number, settled: false, notice: `ask #${number} was settled just now.` }
      : { number, settled: true }
  }

  /** The person answered in the chat's text: record what they said. */
  async resolve(
    sessionId: SessionId,
    input: { number?: unknown; answer?: unknown },
  ): Promise<{ number: number; settled: boolean; notice?: string }> {
    return await this.settleByAgent(sessionId, input.number, 'answered', input.answer)
  }

  /** The ask is no longer relevant. */
  async retract(
    sessionId: SessionId,
    input: { number?: unknown; reason?: unknown },
  ): Promise<{ number: number; settled: boolean; notice?: string }> {
    return await this.settleByAgent(sessionId, input.number, 'retracted', input.reason)
  }

  /** The calling session's asks, the newest first: open ones, or settled ones too. */
  async list(
    sessionId: SessionId,
    input: { show?: 'open' | 'all'; limit?: number } = {},
  ): Promise<{ asks: ConcertmasterAskSummary[] }> {
    await this.requireConcertmaster(sessionId)
    const asks = await this.deps.entries.asks(sessionId, input.limit ?? 50)
    const shown = input.show === 'all' ? asks : asks.filter((ask) => ask.status === 'open')
    return { asks: shown.map(summaryOf) }
  }

  // -------------------------------------------------------------------------
  // The person's commands
  // -------------------------------------------------------------------------

  /**
   * Mark a session as a Concertmaster, or clear the mark, and tell its agent
   * what changed. Marking what is already marked changes nothing and tells
   * nobody twice.
   */
  async assign(
    writer: SessionWriter & MessageWriter,
    sessionId: SessionId,
    on: boolean,
  ): Promise<{ concertmaster: boolean; changed: boolean }> {
    if (!this.deps.enabled()) throw new ConcertmasterRefusal('unauthorized', NOT_ENABLED)
    const session = await this.deps.session(sessionId)
    if (session === undefined || session.deleted) {
      throw new ConcertmasterRefusal('target-not-found', 'unknown session')
    }
    if (on && (session.agentKind === 'shell' || session.headless)) {
      invalid('Only an agent session with a chat can be a Concertmaster.')
    }
    if (session.concertmaster === on) return { concertmaster: on, changed: false }
    await this.deps.setMark(writer, sessionId, on)
    // Next-turn and no wake: a running agent reads it when its turn ends, a
    // parked one when its person next talks to it.
    const told = await this.deps.send(
      writer,
      { kind: 'system', name: CONCERTMASTER_SYSTEM_SENDER },
      {
        to: { kind: 'session', id: sessionId },
        kind: 'message',
        urgency: 'next-turn',
        lifecycle: 'wait',
        body: on ? concertmasterBriefing() : concertmasterRelease(),
      },
    )
    if (told.disposition === 'dead_letter') {
      // The mark stands: the agent also reads the rules from its prime and its
      // launch instructions. Say so in the log rather than failing the mark.
      log.warn('concertmaster briefing was not delivered', { sessionId, reason: told.reason })
    }
    return { concertmaster: on, changed: true }
  }

  /**
   * The person settles an open ask, and the agent is told in the same unit:
   * the response reaches it as the person's own message, naming the ask. A
   * response that cannot be delivered settles nothing.
   */
  async respond(
    writer: MessageWriter,
    from: MessageSender,
    input: {
      sessionId: SessionId
      entryId: string
      response: ConcertmasterResponse
      text?: string
    },
  ): Promise<{ settled: boolean; status: string }> {
    if (!this.deps.enabled()) throw new ConcertmasterRefusal('unauthorized', NOT_ENABLED)
    const ask = await this.deps.entries.entry(input.entryId)
    // One answer for a missing ask and another session's: no existence oracle.
    if (ask === undefined || ask.kind !== 'ask' || ask.sessionId !== input.sessionId) {
      throw new ConcertmasterRefusal('target-not-found', 'unknown ask')
    }
    const words = input.text?.trim() ?? ''
    const kind = ask.askKind ?? 'question'
    if (input.response === 'done' && kind !== 'todo') {
      invalid(`A ${concertmasterAskNoun(kind)} is answered, not marked done.`)
    }
    if (input.response === 'answered') {
      if (kind === 'todo') invalid('A to-do is marked done, not answered.')
      if (!words) invalid('An answer needs some text.')
    }
    if (ask.status !== 'open') return { settled: false, status: ask.status ?? 'open' }
    const settledAt = this.at()
    const settled = await this.deps.entries.settleAsk(ask.id, {
      status: input.response,
      answer: words || null,
      settledAt,
      settledBy: 'user',
    })
    if (settled === null) {
      const now = await this.deps.entries.entry(ask.id)
      return { settled: false, status: now?.status ?? 'open' }
    }
    const told = await this.deps.send(writer, from, {
      to: { kind: 'session', id: input.sessionId },
      // Its own id class, so the delivered-message record leaves it out: the
      // conversation shows the response on the ask itself.
      messageId: `${CONCERTMASTER_RESPONSE_MESSAGE_PREFIX}${ask.id}:${this.deps.mint()}`,
      kind: 'message',
      urgency: 'next-turn',
      lifecycle: 'wake',
      body: concertmasterResponseText(
        { number: ask.number ?? undefined, body: ask.body, askKind: kind },
        input.response,
        words || undefined,
      ),
    })
    if (told.disposition === 'dead_letter') {
      // Thrown, so the unit rolls back and the ask stays open for another try.
      throw new ConcertmasterRefusal(
        'conflict',
        `The response could not be delivered to the agent${told.reason ? ` (${told.reason})` : ''}. The ask is still open.`,
      )
    }
    return { settled: true, status: input.response }
  }

  // -------------------------------------------------------------------------
  // The server's own write
  // -------------------------------------------------------------------------

  /**
   * A chat message was confirmed delivered to a session. When that session is
   * a Concertmaster and the message is a person's own, add it to the
   * conversation. Idempotent: the entry's id is derived from the message.
   *
   * Called after the delivery's commit, on its own unit, so a failure here
   * never fails or delays a delivery. What it misses (the server stopping in
   * between) is one message absent from the curated chat; the agent has it.
   */
  async recordDelivered(sessionId: SessionId, messageId: string): Promise<boolean> {
    if (!this.deps.enabled()) return false
    if (isConcertmasterResponseMessageId(messageId)) return false
    const session = await this.deps.session(sessionId)
    if (session === undefined || !session.concertmaster) return false
    const message = await this.deps.message(messageId)
    if (
      message === null ||
      message.fromKind !== 'operator' ||
      message.toKind !== 'session' ||
      message.toId !== sessionId ||
      message.deliveryStatus !== 'confirmed'
    ) {
      return false
    }
    const actor = message.attribution?.actor
    const sender = message.attribution?.onBehalfOf ?? (actor?.kind === 'user' ? actor.id : null)
    const added = await this.deps.entries.addUserEntry({
      id: concertmasterUserEntryId(message.createdAt, message.id),
      sessionId,
      body: message.body,
      senderUserId: (sender ?? null) as UserId | null,
      ...(message.attachments?.length
        ? {
            attachments: message.attachments.map(({ id, filename, mediaType, kind }) => ({
              ...(id !== undefined ? { id } : {}),
              filename,
              mediaType,
              kind,
            })),
          }
        : {}),
      createdAt: message.createdAt,
    })
    return added !== null
  }

  /** A session's entries as its record carries them: for a test or a tool that
   *  reads the conversation without a device. */
  async conversation(sessionId: SessionId, limit = 200): Promise<ConcertmasterEntryWire[]> {
    return (await this.deps.entries.tail(sessionId, limit)).map(concertmasterEntryWireOf)
  }
}
