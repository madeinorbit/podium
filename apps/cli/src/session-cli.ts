import { makeIssueClient, makeRelayIssueClient } from '@podium/issue-client'

type SessionResult = { ok: boolean; queued?: boolean; reason?: string }
type SessionProc = { mutate(input: Record<string, unknown>): Promise<SessionResult> }
type SessionQuery = { query(input: Record<string, unknown>): Promise<unknown> }

export interface SessionControlClient {
  sessions: {
    sendText: SessionProc
    resumeAndSend: SessionProc
    continue: SessionProc
    /** Read toolkit tiers 1–2 (#237) [spec:SP-34d7]. */
    status: SessionQuery
    read: SessionQuery
  }
}

/** Tier-1 status wire shape (modules/sessions/read-toolkit). */
interface StatusWire {
  sessionId: string
  agentKind: string
  status: string
  phase: string
  issue: { seq: number; stage: string; title: string; todos: string[] } | null
  commits: string[]
  files: string[]
  unackedMessages: number
}

interface ReadWire {
  items: { role: string; text: string; toolName?: string; toolInput?: string }[]
  cursor: string | null
  hasMore: boolean
  truncated: boolean
}

function renderStatus(s: StatusWire): string {
  return [
    `${s.sessionId} (${s.agentKind}) ${s.status}/${s.phase}`,
    s.issue
      ? `issue #${s.issue.seq} [${s.issue.stage}] ${s.issue.title}` +
        (s.issue.todos.length
          ? `\n  todos:\n${s.issue.todos.map((t) => `    ${t}`).join('\n')}`
          : '')
      : 'no issue bound',
    s.commits.length ? `commits:\n${s.commits.map((c) => `  ${c}`).join('\n')}` : 'commits: (none)',
    s.files.length
      ? `working tree:\n${s.files.map((f) => `  ${f}`).join('\n')}`
      : 'working tree: clean',
    `unacked messages: ${s.unackedMessages}`,
  ].join('\n')
}

function renderRead(r: ReadWire): string {
  const body = r.items
    .map((i) => {
      const head = i.toolName ? `${i.role} [${i.toolName}] ${i.toolInput ?? ''}`.trim() : i.role
      return `--- ${head} ---\n${i.text}`.trim()
    })
    .join('\n')
  const tail = [
    r.cursor && r.hasMore ? `(more: --cursor ${r.cursor})` : null,
    r.truncated ? '(truncated to the per-call cap)' : null,
  ]
    .filter(Boolean)
    .join(' ')
  return [body || '(no transcript items)', tail].filter(Boolean).join('\n')
}

export class SessionCliError extends Error {}

export function parseSessionArgs(argv: string[]): {
  command?: string
  args: Record<string, string | boolean>
  positionals: string[]
} {
  const [command, ...rest] = argv
  const args: Record<string, string | boolean> = {}
  const positionals: string[] = []
  const booleans = new Set(['json', 'outside-scope', 'wake', 'help'])
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
    if (booleans.has(key) || next === undefined || next.startsWith('--')) args[key] = true
    else {
      args[key] = next
      i++
    }
  }
  return { ...(command ? { command } : {}), args, positionals }
}

function helpText(): string {
  return [
    'podium session <command> [arguments]',
    '',
    '  send <session-id> --text <message> [--wake] [--outside-scope]',
    '      Submit a real user turn. --wake durably queues it and resumes a parked session.',
    '  resume-and-send <session-id> --text <message> [--outside-scope]',
    '      Explicit spelling of send --wake.',
    '  continue <session-id> [--outside-scope]',
    '      Type continue only when the running session is in an errored phase.',
    '  status <session-id|#issue> [--outside-scope]',
    '      Structured peek: phase, issue stage/todos, last commits, files touched,',
    '      unacked message count. No transcript text (~200 tokens).',
    '  read <session-id> [--turns N] [--cursor C] [--outside-scope]',
    '      Bounded raw-transcript window (newest first page; --cursor pages back).',
    '      Hard-capped per call; every read is event-logged.',
  ].join('\n')
}

export async function runSessionCli(argv: string[], client: SessionControlClient): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h')) return helpText()
  const { command, args, positionals } = parseSessionArgs(argv)
  if (!command || command === 'help') return helpText()
  // Unknown flags are an error, never silently dropped (#345).
  const known = new Set(['text', 'wake', 'json', 'outside-scope', 'turns', 'cursor'])
  const unknown = Object.keys(args).filter((k) => !known.has(k))
  if (unknown.length) {
    throw new SessionCliError(
      `unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `--${k}`).join(', ')} (see \`podium session --help\`)`,
    )
  }
  const sessionId = positionals[0]
  if (!sessionId) {
    throw new SessionCliError(
      `${command} needs a ${command === 'status' ? 'session id or #issue ref' : 'session id'}`,
    )
  }
  if (positionals.length > 1) throw new SessionCliError(`unexpected argument: ${positionals[1]}`)

  // Read toolkit tiers 1–2 (#237) [spec:SP-34d7].
  if (command === 'status') {
    const s = (await client.sessions.status.query({ ref: sessionId })) as StatusWire
    return args.json === true ? JSON.stringify({ command, ok: true, data: s }) : renderStatus(s)
  }
  if (command === 'read') {
    if (args.turns !== undefined && !/^\d+$/.test(String(args.turns))) {
      throw new SessionCliError('--turns must be a positive integer')
    }
    const r = (await client.sessions.read.query({
      sessionId,
      ...(args.turns !== undefined ? { turns: Number(args.turns) } : {}),
      ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
    })) as ReadWire
    return args.json === true ? JSON.stringify({ command, ok: true, data: r }) : renderRead(r)
  }

  let result: SessionResult
  let action: string
  if (command === 'send' || command === 'resume-and-send') {
    const text = args.text
    if (typeof text !== 'string' || text.length === 0) {
      throw new SessionCliError(`${command} needs --text`)
    }
    if (text.length > 32_768) throw new SessionCliError('message exceeds 32768 characters')
    const wake = command === 'resume-and-send' || args.wake === true
    result = await (wake ? client.sessions.resumeAndSend : client.sessions.sendText).mutate({
      sessionId,
      text,
    })
    action = wake ? 'resume-and-send' : 'send'
  } else if (command === 'continue') {
    result = await client.sessions.continue.mutate({ sessionId })
    action = 'continue'
  } else {
    throw new SessionCliError(`unknown command: ${command}\n\n${helpText()}`)
  }

  if (!result.ok) throw new SessionCliError(result.reason ?? `${action} was not accepted`)
  const text = result.queued ? 'queued for delivery' : action === 'continue' ? 'continued' : 'sent'
  return args.json === true
    ? JSON.stringify({ command: action, ok: true, sessionId, queued: result.queued === true })
    : text
}

export async function sessionCliMain(argv: string[]): Promise<void> {
  const relay = process.env.PODIUM_ISSUE_RELAY
  const outsideScope = argv.includes('--outside-scope')
  const client = (relay
    ? makeRelayIssueClient(relay, { outsideScope })
    : makeIssueClient(
        `http://localhost:${Number(process.env.PODIUM_PORT) || 18787}`,
      )) as unknown as SessionControlClient
  try {
    console.log(await runSessionCli(argv, client))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: message }))
    else console.error(`podium session: ${message}`)
    process.exitCode = 1
  }
}
