/**
 * `podium mail` — the unified messaging CLI (#237) [spec:SP-34d7]:
 *   send --to <#issue|session-id> --body "…" [--urgency fyi|next-turn|interrupt]
 *        [--lifecycle wait|wake]
 *   inbox [--issue <ref>]
 *   show <id>
 *   status <id>
 *   dismiss <id>
 *   reply <id> --body "…" [--kind ack|message]
 *
 * Speaks to the `messages` relay router (agents, via PODIUM_AGENT_RELAY) or the
 * tRPC `messages` sub-router (operator). The legacy `podium issue mail *`
 * aliases keep working over the same substrate (issue-addressed sends
 * dual-write mirror rows with the SAME ids).
 */

import type { ThreadId } from '@podium/model'
import { deadLetterDeliveryLine, deadLetterSenderGloss, MESSAGE_ACCEPTED_LINE } from '@podium/model'
import {
  makeRelayIssueClient,
  newMessageId,
  pendingSendNote,
  repeatUntilAnswered,
} from '@podium/issue-client'
import { localServerUrl, resolveAgentRelay, resolvePort } from '@podium/runtime/config'
import {
  declareFlags,
  type FlagDeclaration,
  flagTable,
  parseFlags,
  withUnknownFlagAs,
} from './argv'
import { makeOperatorIssueClient } from './operator-client'

type MailProc = {
  mutate(input?: unknown): Promise<unknown>
  query(input?: unknown): Promise<unknown>
}

export interface MailClient {
  messages: {
    send: MailProc
    inbox: MailProc
    show: MailProc
    status: MailProc
    dismiss: MailProc
    reply: MailProc
  }
}

export class MailCliError extends Error {}

/** Flags the dispatcher owns, valid on every mail (and agent) command. */
export const MESSAGING_GLOBAL_FLAGS = declareFlags({
  known: [],
  booleans: ['json', 'outside-scope', 'help'],
})

/**
 * What each `podium mail` command accepts (POD-3836).
 *
 * PER COMMAND. The set this replaced was shared by every mail command, so
 * `podium mail inbox --to someone` passed the check and was then dropped on the
 * floor — a flag on the wrong command reads exactly like a flag that worked.
 */
const MAIL_FLAGS = flagTable(MESSAGING_GLOBAL_FLAGS, {
  send: {
    known: ['to', 'body', 'urgency', 'lifecycle', 'expires-in'],
    // [POD-835] arms a reply request; takes no value.
    booleans: ['expect-response'],
  },
  inbox: { known: ['issue'] },
  show: {},
  status: {},
  dismiss: {},
  reply: { known: ['body', 'kind'] },
})

/** Parse a human duration (`10m`, `30s`, `2h`, bare seconds) to milliseconds. */
export function parseExpiresIn(raw: string): number {
  const m = /^(\d+)([smh]?)$/.exec(raw.trim())
  if (!m) throw new MailCliError(`invalid --expires-in '${raw}' (use e.g. 2m, 30s, 1h, or seconds)`)
  const n = Number(m[1])
  const mult = m[2] === 'h' ? 3_600_000 : m[2] === 'm' ? 60_000 : m[2] === 's' ? 1_000 : 1_000
  const ms = n * mult
  if (ms <= 0) throw new MailCliError(`invalid --expires-in '${raw}': must be positive`)
  return ms
}

/**
 * Pure argv → { command, args, positionals }, refusing any flag `flagsFor` does
 * not declare for the command. `podium agent` shares this parser and passes its
 * own table.
 */
export function parseMailArgs(
  argv: string[],
  opts?: { tool?: string; flagsFor?: (command: string | undefined) => FlagDeclaration },
): {
  command?: string
  args: Record<string, string | boolean>
  positionals: string[]
} {
  const tool = opts?.tool ?? 'mail'
  const [command, ...rest] = argv
  const { args, positionals } = withUnknownFlagAs(
    (m) => new MailCliError(m),
    () =>
      parseFlags(rest, (opts?.flagsFor ?? MAIL_FLAGS)(command), {
        usage: `podium ${tool}${command ? ` ${command}` : ''}`,
        keys: 'raw',
      }),
  )
  return { ...(command ? { command } : {}), args, positionals }
}

function helpText(): string {
  return [
    'podium mail <command> [arguments]',
    '',
    '  send --to <#issue|session-id> --body "…" [--urgency fyi|next-turn|interrupt] [--lifecycle wait|wake] [--expect-response] [--expires-in <duration>]',
    '      Send a message. Issue-addressed is the durable default; requests above',
    '      your authority are downgraded (never rejected) and marked clamped.',
    '      Receipt is mechanical (the ledger records delivery — pull it with',
    '      `podium mail status <id>`); pass --expect-response only when you want a',
    '      reply back (a question does this implicitly). No reply is owed otherwise.',
    '      --expires-in <duration> sets an absolute TTL (e.g. 2m, 30s, 1h, or seconds).',
    '  inbox [--issue <ref>]',
    '      Read your mailbox (marks messages received). --issue peeks at another box.',
    '  show <id>',
    '      One message in full (sender/recipient/thread/ledger).',
    '  status <id>',
    '      What happened to a message you sent: stored / on its way (dispatched …',
    '      typed) / confirmed (in the target’s transcript, or read from its inbox) /',
    '      failed / expired / cancelled, with timestamps.',
    '  dismiss <id>',
    '      Clear a message without opening the inbox; a new transition may notify again.',
    '  reply <id> --body "…" [--kind ack|message]',
    '      Reply to a message that asked for a response — routed to its sender and',
    '      pull-delivered (surfaces at their next stop, never a fresh turn). Any',
    '      reply within the thread clears the request; you need not send a bare ack.',
  ].join('\n')
}

interface MessageWire {
  id: string
  from: string
  to: string
  kind: string
  urgency: string
  lifecycle: string
  body: string
  createdAt: string
  /** Forward-only delivery status (POD-4765). A string, not the model's enum:
   *  a newer server's status must still print. */
  deliveryStatus: string
  /** How the agent program holds an accepted message (POD-4885). */
  held?: string
  ackedBy: string | null
  threadId: ThreadId
  inReplyTo: string | null
  // Lifecycle timestamps (#834) — present on show/status.
  deliveredAt?: string | null
  deliveredTo?: string | null
  readAt?: string | null
  deadLetteredAt?: string | null
  deliveryDeferredAt?: string | null
  deliveryDeferredReason?: string | null
  /** The notice that told the sender it was not delivered (POD-4778). */
  noticeId?: string
  /** The entry in the recipient agent's history it became (POD-4774). */
  transcriptItem?: { id: string; cursor?: string }
  /** The recipient agent program's own ids for it (POD-4841). */
  harnessRef?: { kind: string; id: string }[]
  expiresAt?: string | null
  // A reply was requested [POD-835] — the reader owes a response.
  expectsResponse?: boolean
}

function renderRow(m: MessageWire): string {
  const flags = [
    m.deliveryStatus,
    m.kind !== 'message' ? m.kind : null,
    // Show an OPEN request (not once it is answered) so the reader knows to reply.
    m.expectsResponse && !m.ackedBy ? 'wants-reply' : null,
    m.ackedBy ? 'acked' : null,
  ].filter(Boolean)
  // A dead letter in the inbox must say WHY [POD-4704]: an injected-but-
  // unconfirmed row (delivery-failed) is a delivery failure, not a vanished
  // target. The shared ledger line keeps every surface worded one way.
  const cause =
    m.deliveryStatus === 'failed' ? ` · ${deadLetterDeliveryLine(m.deliveryDeferredReason)}` : ''
  return `${m.id} ${m.from} -> ${m.to} ${m.createdAt} [${flags.join(',')}]${cause}\n  ${m.body}`
}

/** The send disposition, worded for the sender (#834). A send answers at once
 *  and the target's machine settles it later [POD-4661]: `queued` = on its way
 *  to the target's next turn; `held` = no live session (delivers at the issue's
 *  next session); `spawning` = a session is being woken; `delivered` = already
 *  confirmed (a repeat of a send that landed). Anything else — an older
 *  server's word — reads plainly. */
function dispositionLabel(disposition: string | undefined, queued: boolean | undefined): string {
  switch (disposition) {
    case 'delivered':
      return 'delivered'
    case 'queued':
      return 'queued for the target’s next turn'
    case 'held':
      return 'HELD for the issue’s next session (no live session now)'
    case 'spawning':
      return 'waking a session to receive it'
    case 'dead_letter':
      return 'dead-lettered'
    default:
      return queued ? 'queued' : 'sent'
  }
}

/** The message-lifecycle line for `podium mail status` (#834) [POD-834 §04d]:
 *  the honest "what happened", with a one-line gloss so `queued` reads as "landed,
 *  not yet seen" and `delivered` as "in the agent's transcript". */
function renderLifecycle(m: MessageWire): string {
  // `delivered`/`read` with NO delivered_to is a WEAKER fact than the same status
  // with a session named, and conflating them is how a sender's every instrument
  // reported a message was fine [POD-1420]. It arises when the row was consumed
  // with no recipient to record — a self-suppressed send (the sender was the only
  // member) or a readerless operator/UI peek. Say that, rather than asserting an
  // agent has it while naming nobody.
  const anonymous = !m.deliveredTo
  // One shared wording for every dead-letter cause [POD-4704].
  const failed = deadLetterSenderGloss(m.deliveryDeferredReason)
  const gloss: Record<string, string> = {
    stored: 'captured + waiting for the target (not yet in its context)',
    dispatched: 'handed to the target session — not yet confirmed in its context',
    'reached-machine': 'the target machine has it — not yet typed',
    typing: 'being typed into the target session',
    typed: 'typed into the target session — not yet confirmed it took it',
    // The program took it; its history has not recorded it yet (POD-4885).
    accepted: `${MESSAGE_ACCEPTED_LINE} — the agent program has it, not yet in its history`,
    confirmed: m.readAt
      ? anonymous
        ? 'opened from an inbox, but NO recipient session was named'
        : 'the recipient opened its inbox and read it'
      : anonymous
        ? 'recorded as consumed, but NO recipient session was named — nobody is known to have it'
        : 'appeared in the target’s transcript — the agent has it',
    // The drain reasons name what actually happened to the target [POD-2132,
    // POD-2202]; without one, the plain "gone" story is the right one. An
    // injected-but-unconfirmed failure (delivery-failed) is a delivery failure,
    // not a vanished target [POD-4704] — the shared gloss keeps the CLI worded
    // the same way as the web ledger and the steward notice.
    failed,
    unknown: 'handed on, but it cannot be told whether it arrived — check before resending',
    expired: 'sat undelivered past its TTL',
    cancelled: 'withdrawn',
  }
  const stamps = [
    m.deliveredAt ? `delivered=${m.deliveredAt}` : null,
    m.readAt ? `read=${m.readAt}` : null,
    m.deadLetteredAt ? `dead-lettered=${m.deadLetteredAt}` : null,
    m.deliveryDeferredAt ? `deferred=${m.deliveryDeferredAt}` : null,
    m.deliveryDeferredReason ? `deferred-reason=${m.deliveryDeferredReason}` : null,
    m.deliveredTo ? `to-session=${m.deliveredTo}` : null,
    m.held ? `held=${m.held}` : null,
    m.noticeId ? `notified=${m.noticeId}` : null,
    m.transcriptItem ? `entry=${m.transcriptItem.id}` : null,
    m.harnessRef?.length
      ? `program-ids=${m.harnessRef.map((ref) => `${ref.kind}:${ref.id}`).join(',')}`
      : null,
  ].filter(Boolean)
  return [
    `${m.id} ${m.from} -> ${m.to}`,
    `  status: ${m.deliveryStatus} — ${gloss[m.deliveryStatus] ?? 'a status this podium does not know yet — treat it as still on its way'}`,
    `  captured=${m.createdAt}${stamps.length ? ` ${stamps.join(' ')}` : ''}`,
  ].join('\n')
}

export async function runMailCli(argv: string[], client: MailClient): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h')) return helpText()
  const { command, args, positionals } = parseMailArgs(argv)
  if (!command || command === 'help') return helpText()
  const asJson = args.json === true
  const done = (text: string, data: unknown): string =>
    asJson ? JSON.stringify({ command, ok: true, data }) : text

  switch (command) {
    case 'send': {
      const to = args.to
      const body = args.body
      if (typeof to !== 'string' || !to)
        throw new MailCliError('send needs --to <#issue|session-id>')
      if (typeof body !== 'string' || !body) throw new MailCliError('send needs --body')
      if (body.length > 32_768) throw new MailCliError('message exceeds 32768 characters')
      if (
        args.urgency !== undefined &&
        !['fyi', 'next-turn', 'interrupt'].includes(String(args.urgency))
      ) {
        throw new MailCliError('--urgency must be fyi|next-turn|interrupt')
      }
      if (args.lifecycle !== undefined && !['wait', 'wake'].includes(String(args.lifecycle))) {
        throw new MailCliError('--lifecycle must be wait|wake')
      }
      let expiresAt: string | undefined
      if (args['expires-in'] !== undefined) {
        const rawExpiresIn = args['expires-in']
        if (typeof rawExpiresIn !== 'string') {
          throw new MailCliError('send needs --expires-in <duration> (e.g. 2m)')
        }
        expiresAt = new Date(Date.now() + parseExpiresIn(rawExpiresIn)).toISOString()
      }
      // One id for every attempt (POD-4763): a repeat after a relay timeout is
      // the same message, answered with what the server stored.
      const request = {
        to,
        body,
        messageId: newMessageId(),
        ...(args.urgency ? { urgency: args.urgency } : {}),
        ...(args.lifecycle ? { lifecycle: args.lifecycle } : {}),
        ...(args['expect-response'] === true ? { expectResponse: true } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      }
      const r = (await repeatUntilAnswered(() => client.messages.send.mutate(request))) as {
        id: string
        ok: boolean
        queued?: boolean
        reason?: string
        clamped?: boolean
        disposition?: string
        expectsResponse?: boolean
      }
      if (!r.ok) throw new MailCliError(r.reason ?? 'send was not accepted')
      // The honest, sender-facing outcome (#834): held / spawning are named
      // explicitly so a message with no live target is never a bare "sent".
      // With --expect-response [POD-835] a reply is owed (else receipt is mechanical
      // and no ack traffic is generated); the reply arrives pull-delivered.
      const note = [
        dispositionLabel(r.disposition, r.queued),
        r.clamped ? 'downgraded to your authority cap' : null,
        r.expectsResponse ? 'response expected (pull-delivered)' : null,
      ]
        .filter(Boolean)
        .join(', ')
      // Still on its way: a failure is pushed to the sender, so it need not poll.
      const pending = r.disposition !== 'delivered' && r.disposition !== 'dead_letter'
      return done(`sent ${r.id} (${note}${pending ? `; ${pendingSendNote(r.id)}` : ''})`, r)
    }
    case 'inbox': {
      const rows = (await client.messages.inbox.mutate(
        typeof args.issue === 'string' ? { issue: args.issue } : {},
      )) as MessageWire[]
      return done(rows.length ? rows.map(renderRow).join('\n') : '(no messages)', rows)
    }
    case 'show': {
      const id = positionals[0]
      if (!id) throw new MailCliError('show needs a message id')
      const m = (await client.messages.show.query({ id })) as MessageWire
      const meta = [
        `thread=${m.threadId}`,
        m.inReplyTo ? `in-reply-to=${m.inReplyTo}` : null,
        `urgency=${m.urgency}`,
        `lifecycle=${m.lifecycle}`,
        m.expectsResponse ? (m.ackedBy ? 'response=received' : 'response=requested') : null,
        m.ackedBy ? `acked-by=${m.ackedBy}` : null,
      ]
        .filter(Boolean)
        .join(' ')
      // `show` is the full ledger view: it carries the same lifecycle line as
      // `status` so a dead-lettered unconfirmed send reads as delivery failed
      // here too [POD-4704], never as a vanished target.
      return done(`${renderRow(m)}\n  ${meta}\n${renderLifecycle(m)}`, m)
    }
    case 'status': {
      const id = positionals[0]
      if (!id) throw new MailCliError('status needs a message id')
      const m = (await client.messages.status.query({ id })) as MessageWire
      return done(renderLifecycle(m), m)
    }
    case 'dismiss': {
      const id = positionals[0]
      if (!id) throw new MailCliError('dismiss needs a message id')
      const m = (await client.messages.dismiss.mutate({ id })) as MessageWire
      return done('dismissed ' + m.id, m)
    }
    case 'reply': {
      const id = positionals[0]
      if (!id) throw new MailCliError('reply needs a message id')
      const body = args.body
      if (typeof body !== 'string' || !body) throw new MailCliError('reply needs --body')
      if (args.kind !== undefined && !['ack', 'message'].includes(String(args.kind))) {
        throw new MailCliError('--kind must be ack|message')
      }
      const r = (await client.messages.reply.mutate({
        id,
        body,
        ...(args.kind ? { kind: args.kind } : {}),
      })) as { id: string; ok: boolean; acked: boolean; queued?: boolean; reason?: string }
      if (!r.ok) throw new MailCliError(r.reason ?? 'reply was not accepted')
      return done(`replied ${r.id}${r.acked ? ` (acked ${id})` : ''}`, r)
    }
    default:
      throw new MailCliError(`unknown command: ${command}\n\n${helpText()}`)
  }
}

export async function mailCliMain(argv: string[]): Promise<void> {
  const relay = resolveAgentRelay()
  const outsideScope = argv.includes('--outside-scope')
  const client = (relay
    ? makeRelayIssueClient(relay, { outsideScope })
    : makeOperatorIssueClient(localServerUrl(resolvePort()))) as unknown as MailClient
  try {
    console.log(await runMailCli(argv, client))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: message }))
    else console.error(`podium mail: ${message}`)
    process.exitCode = 1
  }
}
