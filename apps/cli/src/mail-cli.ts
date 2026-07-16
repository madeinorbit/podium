/**
 * `podium mail` — the unified messaging CLI (#237) [spec:SP-34d7]:
 *   send --to <#issue|session-id> --body "…" [--urgency fyi|next-turn|interrupt]
 *        [--lifecycle wait|wake]
 *   inbox [--issue <ref>]
 *   show <id>
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
    reply: MailProc
  }
}

export class MailCliError extends Error {}

// 'worktree' is `podium agent spawn`'s boolean flag (agent-cli reuses this parser).
const BOOL_FLAGS = new Set(['json', 'outside-scope', 'help', 'worktree'])

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
    '  send --to <#issue|session-id> --body "…" [--urgency fyi|next-turn|interrupt] [--lifecycle wait|wake]',
    '      Send a message. Issue-addressed is the durable default; requests above',
    '      your authority are downgraded (never rejected) and marked clamped.',
    '  inbox [--issue <ref>]',
    '      Read your mailbox (marks messages received). --issue peeks at another box.',
    '  show <id>',
    '      One message in full (sender/recipient/thread/ledger).',
    '  reply <id> --body "…" [--kind ack|message]',
    '      Reply to a message — routed to its sender. Default kind ack: records',
    '      that you handled it (do this before going idle when a message asked for something).',
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
}

function renderRow(m: MessageWire): string {
  const flags = [m.status, m.kind !== 'message' ? m.kind : null, m.ackedBy ? 'acked' : null].filter(
    Boolean,
  )
  return `${m.id} ${m.from} -> ${m.to} ${m.createdAt} [${flags.join(',')}]\n  ${m.body}`
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
      const r = (await client.messages.send.mutate({
        to,
        body,
        ...(args.urgency ? { urgency: args.urgency } : {}),
        ...(args.lifecycle ? { lifecycle: args.lifecycle } : {}),
      })) as { id: string; ok: boolean; queued?: boolean; reason?: string; clamped?: boolean }
      if (!r.ok) throw new MailCliError(r.reason ?? 'send was not accepted')
      const note = [
        r.queued ? 'queued' : 'delivered',
        r.clamped ? 'downgraded to your authority cap' : null,
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
        m.ackedBy ? `acked-by=${m.ackedBy}` : null,
      ]
        .filter(Boolean)
        .join(' ')
      return done(`${renderRow(m)}\n  ${meta}`, m)
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
