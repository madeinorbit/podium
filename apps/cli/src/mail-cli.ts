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

import { makeIssueClient, makeRelayIssueClient } from '@podium/issue-client'
import { resolveAgentRelay, resolvePort } from '@podium/runtime/config'

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

// 'worktree' is `podium agent spawn`'s boolean flag (agent-cli reuses this parser).
// 'expect-response' [POD-835] arms a reply request on `mail send`.
const BOOL_FLAGS = new Set(['json', 'outside-scope', 'help', 'worktree', 'expect-response'])

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

export function parseMailArgs(argv: string[]): {
  command?: string
  args: Record<string, string | boolean>
  positionals: string[]
} {
  const [command, ...rest] = argv
  const args: Record<string, string | boolean> = {}
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (!token?.startsWith('--')) {
      if (token !== undefined) positionals.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq >= 0) {
      args[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const key = token.slice(2)
    const next = rest[i + 1]
    if (BOOL_FLAGS.has(key) || next === undefined || next.startsWith('--')) args[key] = true
    else {
      args[key] = next
      i++
    }
  }
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
    '      What happened to a message you sent: queued / delivered (in the target’s',
    '      transcript) / read (inbox-pulled) / dead-lettered, with timestamps.',
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
  status: string
  ackedBy: string | null
  threadId: string
  inReplyTo: string | null
  // Lifecycle timestamps (#834) — present on show/status.
  deliveredAt?: string | null
  deliveredTo?: string | null
  readAt?: string | null
  deadLetteredAt?: string | null
  expiresAt?: string | null
  // A reply was requested [POD-835] — the reader owes a response.
  expectsResponse?: boolean
}

function renderRow(m: MessageWire): string {
  const flags = [
    m.status,
    m.kind !== 'message' ? m.kind : null,
    // Show an OPEN request (not once it is answered) so the reader knows to reply.
    m.expectsResponse && !m.ackedBy ? 'wants-reply' : null,
    m.ackedBy ? 'acked' : null,
  ].filter(Boolean)
  return `${m.id} ${m.from} -> ${m.to} ${m.createdAt} [${flags.join(',')}]\n  ${m.body}`
}

/** The send disposition, worded for the sender (#834, [POD-854] blocking send).
 *  A blocking send (interrupt / next-turn) waits for the trustworthy outcome:
 *  `delivered` = CONFIRMED in the target's transcript; `accepted` = the budget
 *  expired with the row still queued (busy / composer-draft-held / lost echo) —
 *  durably captured, not yet confirmed, query `podium mail status`. `queued` = fyi
 *  landed for the next pause; `held` = no live session (delivers at the issue's
 *  next session); `spawning` = a session is being woken. Falls back to the legacy
 *  queued/delivered wording when a server predates the field. */
function dispositionLabel(disposition: string | undefined, queued: boolean | undefined): string {
  switch (disposition) {
    case 'delivered':
      return 'delivered'
    case 'accepted':
      return 'accepted — not yet confirmed delivered'
    case 'queued':
      return 'queued for the target’s next turn'
    case 'held':
      return 'HELD for the issue’s next session (no live session now)'
    case 'spawning':
      return 'waking a session to receive it'
    case 'dead_letter':
      return 'dead-lettered'
    default:
      return queued ? 'queued' : 'delivered'
  }
}

/** The message-lifecycle line for `podium mail status` (#834) [POD-834 §04d]:
 *  the honest "what happened", with a one-line gloss so `queued` reads as "landed,
 *  not yet seen" and `delivered` as "in the agent's transcript". */
function renderLifecycle(m: MessageWire): string {
  const gloss: Record<string, string> = {
    queued: 'captured + waiting for the target (not yet in its context)',
    delivered: 'appeared in the target’s transcript — the agent has it',
    read: 'the recipient opened its inbox and read it',
    dead_letter: 'target was gone — dead-lettered, not dropped',
    expired: 'sat undelivered past its TTL',
    cancelled: 'withdrawn',
  }
  const stamps = [
    m.deliveredAt ? `delivered=${m.deliveredAt}` : null,
    m.readAt ? `read=${m.readAt}` : null,
    m.deadLetteredAt ? `dead-lettered=${m.deadLetteredAt}` : null,
    m.deliveredTo ? `to-session=${m.deliveredTo}` : null,
  ].filter(Boolean)
  return [
    `${m.id} ${m.from} -> ${m.to}`,
    `  status: ${m.status} — ${gloss[m.status] ?? ''}`,
    `  captured=${m.createdAt}${stamps.length ? ` ${stamps.join(' ')}` : ''}`,
  ].join('\n')
}

export async function runMailCli(argv: string[], client: MailClient): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h')) return helpText()
  const { command, args, positionals } = parseMailArgs(argv)
  if (!command || command === 'help') return helpText()
  const known = new Set([
    'to',
    'body',
    'urgency',
    'lifecycle',
    'issue',
    'kind',
    'expect-response',
    'expires-in',
    'json',
    'outside-scope',
  ])
  const unknown = Object.keys(args).filter((k) => !known.has(k))
  if (unknown.length) {
    throw new MailCliError(
      `unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `--${k}`).join(', ')} (see \`podium mail --help\`)`,
    )
  }
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
        if (typeof args['expires-in'] !== 'string' || args['expires-in'] === true) {
          throw new MailCliError('send needs --expires-in <duration> (e.g. 2m)')
        }
        expiresAt = new Date(Date.now() + parseExpiresIn(args['expires-in'])).toISOString()
      }
      const r = (await client.messages.send.mutate({
        to,
        body,
        ...(args.urgency ? { urgency: args.urgency } : {}),
        ...(args.lifecycle ? { lifecycle: args.lifecycle } : {}),
        ...(args['expect-response'] === true ? { expectResponse: true } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      })) as {
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
        // An accepted send is never a bare success [POD-854]: point the sender at
        // the ledger so they can see it flip to delivered (or dead-lettered).
        r.disposition === 'accepted' ? `run 'podium mail status ${r.id}' to track it` : null,
      ]
        .filter(Boolean)
        .join(', ')
      return done(`sent ${r.id} (${note})`, r)
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
      return done(`${renderRow(m)}\n  ${meta}`, m)
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
    : makeIssueClient(`http://localhost:${resolvePort()}`)) as unknown as MailClient
  try {
    console.log(await runMailCli(argv, client))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: message }))
    else console.error(`podium mail: ${message}`)
    process.exitCode = 1
  }
}
