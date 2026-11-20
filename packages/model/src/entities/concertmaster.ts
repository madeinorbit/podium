/**
 * THE CONCERTMASTER'S CURATED CONVERSATION (POD-7211).
 *
 * A session marked as a Concertmaster (`SessionMeta.concertmaster`) is talked
 * to through a curated chat. Its person never reads the transcript or the
 * terminal there; they read this timeline, one entry per thing that was said:
 *
 *  - `say`: a message the agent chose to send, with `podium concertmaster say`;
 *  - `user`: a message the person sent into the session, once the agent has it;
 *  - `ask`: something the agent needs from the person (a question, a decision
 *    or a to-do of theirs). An ask stays `open` until the person settles it or
 *    the agent does (answered in the chat's text, or no longer relevant).
 *
 * One record type carries all three, so the chat is one ordered list and the
 * "needs you" list is its open asks. Kind, ask kind and status are open strings
 * on the wire, so a client older than a new value still shows the row.
 */

import { z } from 'zod'
import { asSessionId, type SessionId, SessionIdField } from '../ids/brands'
import { joinKeyParts, splitKeyParts } from '../ids/keys'
import { MessageRecordAttachment } from './message-record'

export const CONCERTMASTER_ENTRY_KINDS = ['say', 'user', 'ask'] as const
export type ConcertmasterEntryKind = (typeof CONCERTMASTER_ENTRY_KINDS)[number]

/** What an ask wants: an answer in words, a choice, or an action of the person's own. */
export const CONCERTMASTER_ASK_KINDS = ['question', 'decision', 'todo'] as const
export type ConcertmasterAskKind = (typeof CONCERTMASTER_ASK_KINDS)[number]

export const isConcertmasterAskKind = (value: string): value is ConcertmasterAskKind =>
  (CONCERTMASTER_ASK_KINDS as readonly string[]).includes(value)

/**
 * Where an ask stands. `open` needs the person. The person settles it as
 * `answered` (a question or a decision), `done` (a to-do) or `dismissed` (not
 * doing it); the agent settles it as `answered` (the person answered in the
 * chat's text) or `retracted` (no longer relevant).
 */
export const CONCERTMASTER_ASK_STATUSES = [
  'open',
  'answered',
  'done',
  'dismissed',
  'retracted',
] as const
export type ConcertmasterAskStatus = (typeof CONCERTMASTER_ASK_STATUSES)[number]

/** The outcomes the person may give an open ask. */
export const CONCERTMASTER_RESPONSES = ['answered', 'done', 'dismissed'] as const
export type ConcertmasterResponse = (typeof CONCERTMASTER_RESPONSES)[number]

/** Who settled an ask. */
export type ConcertmasterSettler = 'user' | 'agent'

/** Limits the commands hold their input to. */
export const CONCERTMASTER_LIMITS = {
  /** A `say` message, or a person's answer. */
  body: 16_000,
  /** An ask's one-line title. */
  title: 240,
  /** An ask's supporting text. */
  detail: 4_000,
  /** A decision's options, and one option's length. */
  options: 6,
  option: 120,
  /** Issue artifacts a `say` may show. */
  artifacts: 6,
  artifact: 512,
} as const

/** One entry of the curated conversation (synced record `concertmasterEntry`). */
export const ConcertmasterEntryWire = z.object({
  /** The entry's own id. The feed id also names the session ({@link concertmasterEntryRowId}). */
  entryId: z.string().min(1),
  sessionId: SessionIdField,
  /** `say` | `user` | `ask`; open, so an older client still lists a new kind. */
  kind: z.string(),
  /** The message text (Markdown for `say`), or an ask's title. */
  body: z.string(),
  createdAt: z.string(),
  /** `say`: issue artifacts shown with the message, by their attachment name. */
  artifacts: z.array(z.string()).optional(),
  /** `user`: who sent it, and what they attached. */
  senderUserId: z.string().optional(),
  attachments: z.array(MessageRecordAttachment).optional(),
  /** `ask`: its number in this conversation, the handle the agent names it by. */
  number: z.number().int().positive().optional(),
  /** `ask`: `question` | `decision` | `todo`. */
  askKind: z.string().optional(),
  /** `ask`: supporting text under the title. */
  detail: z.string().optional(),
  /** `ask`: the choices of a decision; a question may suggest some too. */
  options: z.array(z.string()).optional(),
  /** `ask`: `open` | `answered` | `done` | `dismissed` | `retracted`. */
  status: z.string().optional(),
  /** `ask`: what it was settled with (the answer, a note, the reason). */
  answer: z.string().optional(),
  settledAt: z.string().optional(),
  /** `ask`: `user` | `agent`. */
  settledBy: z.string().optional(),
})
export type ConcertmasterEntryWire = z.infer<typeof ConcertmasterEntryWire>

/** An ask that still needs the person. */
export const isOpenConcertmasterAsk = (
  entry: Pick<ConcertmasterEntryWire, 'kind' | 'status'>,
): boolean => entry.kind === 'ask' && entry.status === 'open'

/** Conversation order: by time, the id breaking ties so the order is total
 *  (the order of the ids themselves, see {@link concertmasterEntryId}). */
export function compareConcertmasterEntries(
  a: Pick<ConcertmasterEntryWire, 'createdAt' | 'entryId'>,
  b: Pick<ConcertmasterEntryWire, 'createdAt' | 'entryId'>,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0
}

const ROW_SEP = '\n'

/**
 * The feed id of an entry: its session, then its own id. Who may read an entry
 * is who may see its session, and that has to be answerable from the id alone,
 * for a removed row too (the reason `interactionRowId` names its session).
 */
export function concertmasterEntryRowId(sessionId: string, entryId: string): string {
  return joinKeyParts(ROW_SEP, [sessionId, entryId])
}

/** Inverse of {@link concertmasterEntryRowId}. Throws on a malformed id. */
export function parseConcertmasterEntryRowId(id: string): {
  sessionId: SessionId
  entryId: string
} {
  const [session, entry] = splitKeyParts(ROW_SEP, id, 2) as [string, string]
  if (session === '' || entry === '') {
    throw new Error(`malformed concertmaster entry row id: ${JSON.stringify(id)}`)
  }
  return { sessionId: asSessionId(session), entryId: entry }
}

/**
 * An entry's id: its time, then what makes it unique. The ids of one session
 * therefore sort in conversation order, which is how the store reads them.
 * `createdAt` is the `toISOString()` form the entry also carries.
 */
export const concertmasterEntryId = (createdAt: string, unique: string): string =>
  `${createdAt}_${unique}`

/**
 * The id of the `user` entry a chat message becomes. Derived from the message
 * (its time and its own id), so recording one message twice names one entry.
 */
export const concertmasterUserEntryId = (createdAt: string, messageId: string): string =>
  concertmasterEntryId(createdAt, `m_${messageId}`)

/**
 * The id prefix of the message that tells the agent an ask was settled. That
 * message is the person's response as the agent reads it; the conversation
 * shows the response on the ask itself, so it is not recorded as a `user` entry.
 */
export const CONCERTMASTER_RESPONSE_MESSAGE_PREFIX = 'cmask:'

export const isConcertmasterResponseMessageId = (messageId: string): boolean =>
  messageId.startsWith(CONCERTMASTER_RESPONSE_MESSAGE_PREFIX)

/** A short word for the ask kind, as the agent and the UI name it. */
export function concertmasterAskNoun(askKind: string | undefined): string {
  return askKind === 'decision' ? 'decision' : askKind === 'todo' ? 'to-do' : 'question'
}

/**
 * What the agent reads when its person settles an ask: one line that names the
 * ask by number and title and carries the response in the person's words.
 */
export function concertmasterResponseText(
  ask: Pick<ConcertmasterEntryWire, 'number' | 'body' | 'askKind'>,
  response: ConcertmasterResponse,
  text: string | undefined,
): string {
  const head = `ask #${ask.number ?? '?'} (${concertmasterAskNoun(ask.askKind)}: "${ask.body}")`
  const words = text?.trim()
  if (response === 'done') return `Done: ${head}.${words ? ` Note: ${words}` : ''}`
  if (response === 'dismissed') {
    return `Dismissed: ${head}. I will not act on it.${words ? ` Reason: ${words}` : ''}`
  }
  return `Answer to ${head}: ${words ?? ''}`
}
