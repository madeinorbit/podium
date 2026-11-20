/**
 * THE CONCERTMASTER COMMANDS (POD-7211).
 *
 * A Concertmaster session's person talks to it through a curated conversation
 * (the synced record `concertmasterEntry`). Three parties write it:
 *
 *  - THE AGENT, from inside its own session, through the relay only:
 *    `say` (a message to its person), `ask` (something it needs from them),
 *    `update`, `resolve` (the person answered in the chat's text) and `retract`
 *    (no longer relevant). The target is always the calling session, taken from
 *    the capability and never from the input.
 *  - THE PERSON, over tRPC only: `assign` (mark a session of theirs as a
 *    Concertmaster, or clear the mark) and `respond` (settle an open ask; the
 *    response is also delivered to the agent as the person's message).
 *  - THE SERVER, with no command: it records each message the person sends
 *    into the session once the agent has it.
 *
 * Every command refuses while the `concertmaster` feature is off. The agent's
 * inputs keep their limits in the handler, in sentences an agent can act on
 * (the `offer` commands' rule); the schemas here only shape them.
 *
 * Sent on `sync.submit`. The entries reach every device through the feed, so
 * the answers carry only what the caller needs next (an ask's number).
 */

import { z } from 'zod'
import { type CommandDef, defineCommands } from '../framework'

/** `say`: one message, with issue artifacts to show beside it. */
export const concertmasterSayInput = z.object({
  body: z.unknown(),
  artifacts: z.unknown().optional(),
})

/** `ask`: a question, a decision or a to-do for the person. */
export const concertmasterAskInput = z.object({
  kind: z.unknown().optional(),
  title: z.unknown(),
  detail: z.unknown().optional(),
  options: z.unknown().optional(),
})

/** `update`: rewrite an open ask's words. A field left out keeps its value. */
export const concertmasterUpdateInput = z.object({
  number: z.unknown(),
  title: z.unknown().optional(),
  detail: z.unknown().optional(),
  options: z.unknown().optional(),
})

/** `resolve`: the person answered in the chat's text; record what they said. */
export const concertmasterResolveInput = z.object({
  number: z.unknown(),
  answer: z.unknown().optional(),
})

/** `retract`: the ask is no longer relevant. */
export const concertmasterRetractInput = z.object({
  number: z.unknown(),
  reason: z.unknown().optional(),
})

/** `assign`: mark one of the caller's sessions as a Concertmaster, or clear the mark. */
export const concertmasterAssignInput = z.object({
  sessionId: z.string().min(1).max(200),
  on: z.boolean(),
})
export type ConcertmasterAssignInput = z.infer<typeof concertmasterAssignInput>

/** `respond`: the person settles an open ask of one of their sessions. */
export const concertmasterRespondInput = z.object({
  sessionId: z.string().min(1).max(200),
  entryId: z.string().min(1).max(400),
  response: z.enum(['answered', 'done', 'dismissed']),
  /** The answer, a note on a to-do, or why it is dismissed. */
  text: z.string().max(16_000).optional(),
})
export type ConcertmasterRespondInput = z.infer<typeof concertmasterRespondInput>

/** `concertmaster.list` (a read, on the relay): the calling session's asks. */
export const concertmasterListInput = z
  .object({
    /** `open` (the default): asks that still need the person. `all`: settled ones too. */
    show: z.enum(['open', 'all']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .passthrough()
export type ConcertmasterListInput = z.infer<typeof concertmasterListInput>

const RELAY_ONLY = ['relay'] as const
const TRPC_ONLY = ['trpc'] as const

const agentWrite = <In extends z.ZodTypeAny>(input: In, summary: string): CommandDef<In> => ({
  input,
  action: 'write',
  exposure: RELAY_ONLY,
  conflict: 'single-writer',
  visibility: 'personal',
  cli: { summary },
})

const personWrite = <In extends z.ZodTypeAny>(input: In, summary: string): CommandDef<In> => ({
  input,
  action: 'write',
  exposure: TRPC_ONLY,
  conflict: 'single-writer',
  visibility: 'personal',
  cli: { summary },
})

export const concertmasterCommands = defineCommands('concertmaster', {
  say: agentWrite(concertmasterSayInput, "Send a message to the calling session's person."),
  ask: agentWrite(concertmasterAskInput, 'Open an ask for the person.'),
  update: agentWrite(concertmasterUpdateInput, "Rewrite an open ask's words."),
  resolve: agentWrite(concertmasterResolveInput, 'Settle an ask the person answered in the chat.'),
  retract: agentWrite(concertmasterRetractInput, 'Take back an ask that is no longer relevant.'),
  assign: personWrite(concertmasterAssignInput, 'Mark a session as a Concertmaster, or clear it.'),
  respond: personWrite(concertmasterRespondInput, 'Answer, complete or dismiss an open ask.'),
} satisfies Record<
  'say' | 'ask' | 'update' | 'resolve' | 'retract' | 'assign' | 'respond',
  CommandDef
>)

export const CONCERTMASTER_SYNC_COMMANDS = [
  'concertmaster.say',
  'concertmaster.ask',
  'concertmaster.update',
  'concertmaster.resolve',
  'concertmaster.retract',
  'concertmaster.assign',
  'concertmaster.respond',
] as const
