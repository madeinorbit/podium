/**
 * WHAT "DELIVERED CORRECTLY" MEANS, AS A FUNCTION (POD-4779).
 *
 * The delivery-outage lane breaks the chain in many ways, and every scenario
 * ends with the same question: given what the agent actually received, what the
 * server says, and what every device shows — is anything wrong? This module is
 * that question, answered once, as a pure function over an observation. It
 * takes no process and no clock, so its rules are unit-tested on their own
 * (`delivery-oracle.test.ts`) and a lane can never pass because the oracle
 * quietly stopped looking.
 *
 * The rules, per message the lane sent (POD-4720 §4):
 *
 *  1. The agent received it AT MOST ONCE.                       `typed-twice`
 *  2. A transient fault loses nothing: it is typed exactly once. `lost` / `stuck`
 *  3. Its final status matches what the agent received:
 *     confirmed ⇔ typed; cancelled/failed/expired ⇒ not typed.  `status-lies`
 *  4. `unknown` only where the lane declared the ambiguous window. `unknown-outside-window`
 *  5. One message is one server row (the id is the row).        `duplicate-row`
 *  6. Nothing is typed that nobody sent.                          `untracked-prompt`
 *  7. Each device draws it once, and tells the truth about it.   `duplicate-bubble` / `screen-lies`
 *  8. Every device tells the same story.                          `devices-disagree`
 *
 * And per reconnect (`stormViolations`): the frames and prompts a backlog costs
 * are bounded by the backlog, not by how often or how long the link was down.
 */

import { MessageDelivery, type MessageDeliveryStatus } from '@podium/model'
import { type MessageOnScreen, messageIdsIn } from './device'
import type { LinkFrame } from './link-proxy'

/** What the lane expects of one message, given the fault it injected. */
export type Expectation =
  /** A transient fault: it must arrive, exactly once, and say so. */
  | 'delivered'
  /** The device could not reach the server for longer than its give-up window:
   *  an honest "not sent" on the sender is as good as delivery. */
  | 'delivered-or-not-sent'
  /** Retracted by a user: cancelled and never typed, or typed and saying so. */
  | 'retracted'
  /** The daemon died between typing and proof — the ONE window where the chain
   *  may not know. Typed at most once; `unknown` is an allowed answer. */
  | 'ambiguous'

export interface TrackedMessage {
  /** The id the message carries in its text (`[msg_…]`). For a device send it
   *  is also the id the device minted; see {@link trackedBy}. */
  readonly id: string
  /**
   * `id` (default): the server row IS this id — the device minted it and the
   * chain is supposed to keep it. `text`: the sender minted no id (an agent's
   * CLI today), so the lane can only find its rows by the token in the text,
   * and the first such row stands for the message.
   */
  readonly trackedBy?: 'id' | 'text'
  readonly sessionId: string
  readonly expect: Expectation
  /** The device that sent it, if a device did. */
  readonly sender?: string
}

export interface TypedPrompt {
  readonly sessionId: string
  readonly prompt: string
  readonly at: number
}

export interface ServerRow {
  readonly id: string
  readonly sessionId: string
  readonly body: string
  readonly deliveryStatus: MessageDeliveryStatus | undefined
  /** Why the server ended or held it (`delivery_deferred_reason`), for the report. */
  readonly reason?: string
}

export interface DeviceObservation {
  readonly device: string
  readonly sessionId: string
  readonly screen: ReadonlyMap<string, MessageOnScreen>
}

export interface Observation {
  readonly messages: readonly TrackedMessage[]
  readonly typed: readonly TypedPrompt[]
  readonly rows: readonly ServerRow[]
  readonly devices: readonly DeviceObservation[]
  /** Per device, the chat sends its queue still holds, and in which state. */
  readonly outboxes: ReadonlyMap<string, ReadonlyMap<string, 'sending' | 'failed'>>
}

export type ViolationKind =
  | 'typed-twice'
  | 'lost'
  | 'stuck'
  | 'status-lies'
  | 'unknown-outside-window'
  | 'duplicate-row'
  | 'untracked-prompt'
  | 'duplicate-bubble'
  | 'screen-lies'
  | 'devices-disagree'
  | 'storm'

export interface Violation {
  readonly kind: ViolationKind
  readonly messageId?: string
  readonly detail: string
}

/** What a user reads off one bubble, in words that devices can agree on:
 *  the sender's own "sending…" and another device's queued record both say
 *  "on its way"; a failed bubble says "not delivered" on every device (POD-4764
 *  draws them all from the one record, by id); and a message nobody can vouch
 *  for says so. */
export type UserVerdict =
  | 'delivered'
  | 'on-its-way'
  | 'not-delivered'
  | 'unconfirmed'
  | 'interrupted'
  | 'absent'

export function verdictOf(shown: MessageOnScreen | undefined): UserVerdict {
  const as = shown?.shownAs ?? 'absent'
  switch (as) {
    case 'in-transcript':
      return 'delivered'
    case 'pending:sending':
    case 'pending:sent':
    case 'pending:queued':
      return 'on-its-way'
    case 'pending:failed':
      return 'not-delivered'
    case 'pending:unknown':
      return 'unconfirmed'
    case 'pending:interrupted':
      return 'interrupted'
    // Taken back (POD-4776): not in the conversation, which is what every other
    // device shows once the record leaves its feed.
    case 'pending:retracted':
      return 'absent'
    default:
      return 'absent'
  }
}

function countTyped(typed: readonly TypedPrompt[], id: string): number {
  return typed.filter((prompt) => messageIdsIn(prompt.prompt).includes(id)).length
}

function statusRule(
  message: TrackedMessage,
  typed: number,
  row: ServerRow | undefined,
  senderHolds: 'sending' | 'failed' | undefined,
): Violation | undefined {
  const id = message.id
  const status = row?.deliveryStatus
  const say = (kind: ViolationKind, detail: string): Violation => ({ kind, messageId: id, detail })
  const pending =
    status !== undefined && !MessageDelivery.isTerminal(status) && status !== 'unknown'

  if (message.expect === 'retracted') {
    if (typed === 0 && (status === 'cancelled' || status === undefined)) return undefined
    if (typed === 1 && status === 'confirmed') return undefined
    if (typed === 1)
      return say('status-lies', `retracted, typed once, but the server says ${status ?? 'nothing'}`)
    if (pending) return say('stuck', `retracted, never typed, still ${status}`)
    return say('status-lies', `retracted, never typed, but the server says ${status}`)
  }

  if (message.expect === 'ambiguous') {
    if (status === 'unknown') return undefined
    if (typed === 1 && status === 'confirmed') return undefined
    if (typed === 0 && status === 'confirmed')
      return say('status-lies', 'confirmed, but the agent never received it')
    if (pending)
      return say('stuck', `${typed === 1 ? 'typed once' : 'never typed'}, still ${status}`)
    if (typed === 1)
      return say('status-lies', `typed once, but the server says ${status ?? 'nothing'}`)
    return say('lost', `never typed, and the server says ${status ?? 'nothing'} instead of unknown`)
  }

  // delivered / delivered-or-not-sent
  if (typed === 1) {
    if (status === 'confirmed') return undefined
    if (status === 'unknown')
      return say('unknown-outside-window', 'typed once, but the server says unknown')
    if (pending) return say('stuck', `typed once, but the server still says ${status}`)
    return say('status-lies', `typed once, but the server says ${status ?? 'nothing (no row)'}`)
  }
  if (typed > 1) return undefined // reported by rule 1; its status is moot
  if (!row) {
    if (message.expect === 'delivered-or-not-sent' && senderHolds === 'failed') return undefined
    if (senderHolds === 'sending')
      return say('stuck', 'never reached the server; the device is still sending it')
    return say('lost', `never reached the server${senderHolds ? ` (device: ${senderHolds})` : ''}`)
  }
  if (status === 'confirmed')
    return say('status-lies', 'confirmed, but the agent never received it')
  if (status === 'unknown')
    return say('unknown-outside-window', 'never typed, and the server says unknown')
  if (pending) return say('stuck', `never typed, still ${status}`)
  return say('lost', `never typed; the server gave up with ${status}`)
}

/** The server row that stands for a message, and any other rows carrying it. */
export function rowsFor(
  message: TrackedMessage,
  rows: readonly ServerRow[],
): { primary: ServerRow | undefined; copies: ServerRow[] } {
  const carrying = rows.filter((row) => messageIdsIn(row.body).includes(message.id))
  const primary =
    message.trackedBy === 'text' ? carrying[0] : rows.find((row) => row.id === message.id)
  return { primary, copies: carrying.filter((row) => row !== primary) }
}

/** Every rule, over one quiescent observation. */
export function violations(observation: Observation): Violation[] {
  const found: Violation[] = []
  const tracked = new Set(observation.messages.map((message) => message.id))

  for (const message of observation.messages) {
    const id = message.id
    const typed = countTyped(observation.typed, id)
    if (typed > 1)
      found.push({ kind: 'typed-twice', messageId: id, detail: `typed ${typed} times` })

    const { primary, copies } = rowsFor(message, observation.rows)
    const rows = primary ? [primary] : []
    if (copies.length > 0) {
      found.push({
        kind: 'duplicate-row',
        messageId: id,
        detail: `${copies.length} more server row(s) carry it: ${copies.map((row) => `${row.id}=${row.deliveryStatus}`).join(', ')}`,
      })
    }
    const senderHolds = message.sender
      ? observation.outboxes.get(message.sender)?.get(id)
      : undefined
    const statusViolation = statusRule(message, typed, rows[0], senderHolds)
    if (statusViolation) found.push(statusViolation)

    // Screens: the same message, on every device that shows its session.
    const seen = observation.devices.filter((device) => device.sessionId === message.sessionId)
    const verdicts = new Map<string, UserVerdict>()
    for (const device of seen) {
      const shown = device.screen.get(id)
      if (shown && shown.bubbles > 1) {
        found.push({
          kind: 'duplicate-bubble',
          messageId: id,
          detail: `${device.device} draws it ${shown.bubbles} times`,
        })
      }
      const verdict = verdictOf(shown)
      verdicts.set(device.device, verdict)
      if (typed >= 1 && verdict !== 'delivered') {
        found.push({
          kind: 'screen-lies',
          messageId: id,
          detail: `${device.device} shows ${shown?.shownAs ?? 'nothing'} for a typed message`,
        })
      } else if (typed === 0 && verdict === 'delivered') {
        found.push({
          kind: 'screen-lies',
          messageId: id,
          detail: `${device.device} shows it delivered; the agent never received it`,
        })
      } else if (
        typed === 0 &&
        verdict === 'on-its-way' &&
        rows[0]?.deliveryStatus &&
        MessageDelivery.isTerminal(rows[0].deliveryStatus)
      ) {
        found.push({
          kind: 'screen-lies',
          messageId: id,
          detail: `${device.device} shows ${shown?.shownAs} for a message the server ended as ${rows[0].deliveryStatus}`,
        })
      }
    }
    if (new Set(verdicts.values()).size > 1) {
      found.push({
        kind: 'devices-disagree',
        messageId: id,
        detail: [...verdicts].map(([device, verdict]) => `${device}=${verdict}`).join(', '),
      })
    }
  }

  for (const prompt of observation.typed) {
    const ids = messageIdsIn(prompt.prompt)
    if (ids.length === 0 || ids.some((id) => !tracked.has(id))) {
      found.push({
        kind: 'untracked-prompt',
        detail: `${prompt.sessionId} was typed ${JSON.stringify(prompt.prompt.slice(0, 120))}`,
      })
    }
  }
  return found
}

export interface StormBudget {
  /** Messages the backlog held when the link came back. */
  readonly backlog: number
  /** Server → daemon delivery frames allowed per backlog message. */
  readonly perMessage: number
  /** Frames every reconnect may cost regardless of backlog (handshake-scale). */
  readonly fixed: number
}

/** Frame types that carry a message toward the agent. */
export const DELIVERY_DOWN_TYPES = new Set(['runtimeDurableSendRequest', 'runtimeSendRequest'])

/**
 * The storm check: after a reconnect, how many delivery frames went down the
 * link, against what the backlog justifies.
 */
export function stormViolations(
  frames: readonly LinkFrame[],
  since: number,
  budget: StormBudget,
): Violation[] {
  const down = frames.filter(
    (frame) =>
      frame.dir === 'down' &&
      !frame.dropped &&
      frame.at >= since &&
      DELIVERY_DOWN_TYPES.has(frame.type),
  )
  const allowed = budget.backlog * budget.perMessage + budget.fixed
  if (down.length <= allowed) return []
  return [
    {
      kind: 'storm',
      detail: `${down.length} delivery frames went down for a backlog of ${budget.backlog} (allowed ${allowed})`,
    },
  ]
}

/** The kinds found, sorted and de-duplicated — the shape a scenario pins. */
export function kindsOf(found: readonly Violation[]): ViolationKind[] {
  return [...new Set(found.map((violation) => violation.kind))].sort()
}
