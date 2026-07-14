import { makeIssueClient, makeRelayIssueClient } from '@podium/issue-client'

type SessionResult = { ok: boolean; queued?: boolean; reason?: string }
type SessionProc = { mutate(input: Record<string, unknown>): Promise<SessionResult> }
type SessionQuery = { query(input: Record<string, unknown>): Promise<unknown> }

/** `sessions.title` (#490): the agent names its OWN session — refusal (the user
 *  already named it) comes back as ok:false + reason, not as a thrown error. */
type TitleResult = { ok: boolean; name?: string; reason?: string }

export interface SessionControlClient {
  sessions: {
    sendText: SessionProc
    resumeAndSend: SessionProc
    continue: SessionProc
    /** Read toolkit tiers 1–4 (#237) [spec:SP-34d7]. */
    status: SessionQuery
    read: SessionQuery
    recap: SessionQuery
    ask: { mutate(input: Record<string, unknown>): Promise<unknown> }
    /** Self-titling (#490) — no sessionId: the server binds the CALLING session. */
    title: { mutate(input: Record<string, unknown>): Promise<TitleResult> }
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

/** Tier-3 recap wire shape (modules/sessions/read-toolkit). */
interface RecapWire {
  sessionId: string
  recap: string
  watermark: string | null
  newItems: number
  delta: boolean
}

/** Tier-4 seance wire shape (modules/messages/gate `ask`). */
interface AskWire {
  answered: boolean
  questionId: string
  answer?: string
  ackId?: string
  reason?: string
  clamped?: boolean
  snapshot: { sessionId: string; status: string; phase?: string; issueId?: string } | null
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

function renderRecap(r: RecapWire): string {
  return [
    r.recap,
    r.watermark
      ? `(watermark: ${r.watermark} — persisted; next recap covers only what follows)`
      : null,
  ]
    .filter(Boolean)
    .join('\n')
}

function renderAsk(a: AskWire): string {
  if (a.answered) return a.answer ?? '(empty answer)'
  const snap = a.snapshot
    ? ` — session ${a.snapshot.sessionId} is ${a.snapshot.status}${a.snapshot.phase ? `/${a.snapshot.phase}` : ''}`
    : ''
  return `no answer yet (question ${a.questionId} sent${a.clamped ? ', clamped' : ''})${snap}`
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
    '  recap <session-id> [--since <watermark>] [--outside-scope]',
    '      Server-side summary since a watermark; returns recap + new watermark.',
    '      The watermark persists per caller, so repeated check-ins pay only for the delta.',
    '  ask <session-id> --question <text> [--timeout SECONDS] [--outside-scope]',
    "      The seance: send a question message (next-turn + wake — resumes a parked session's",
    '      full context), then wait (bounded) for the ack carrying the answer.',
    '  title "<title>"',
    '      Name THIS session (#490) — no session id: it always targets the calling',
    '      session. 3–5 words naming the thing, not the activity; it must distinguish',
    '      this session from the others on the same issue. Re-run to retitle as the',
    '      work becomes clear. A name the USER set always wins and is never overwritten.',
    '      Only works inside a Podium-managed agent session (PODIUM_ISSUE_RELAY).',
  ].join('\n')
}

export async function runSessionCli(
  argv: string[],
  client: SessionControlClient,
  opts: { hasRelay?: boolean } = {},
): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h')) return helpText()
  const { command, args, positionals } = parseSessionArgs(argv)
  if (!command || command === 'help') return helpText()
  // Unknown flags are an error, never silently dropped (#345).
  const known = new Set([
    'text',
    'wake',
    'json',
    'outside-scope',
    'turns',
    'cursor',
    'since',
    'question',
    'timeout',
  ])
  const unknown = Object.keys(args).filter((k) => !known.has(k))
  if (unknown.length) {
    throw new SessionCliError(
      `unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `--${k}`).join(', ')} (see \`podium session --help\`)`,
    )
  }
  // `podium session title "<title>"` (#490) — the ONLY session command that takes no
  // session id: it names the CALLING session, which the server binds from the relay
  // capability. Accepting an id here would be a lie (the server ignores it) and would
  // suggest an agent can rename its neighbours, which it cannot.
  if (command === 'title') {
    if (opts.hasRelay === false) {
      throw new SessionCliError(
        'PODIUM_ISSUE_RELAY is not set — `session title` names the calling session, so it only works inside a Podium-managed agent session.',
      )
    }
    const title = positionals.join(' ').trim()
    if (!title) throw new SessionCliError('title needs a title: podium session title "…"')
    const r = await client.sessions.title.mutate({ name: title })
    if (!r.ok) throw new SessionCliError(r.reason ?? 'the title was not accepted')
    return args.json === true
      ? JSON.stringify({ command, ok: true, name: r.name ?? title })
      : `session titled "${r.name ?? title}"`
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
  // Tier 3 (#237) [spec:SP-34d7 read-toolkit]: delta-priced server-side recap.
  if (command === 'recap') {
    const r = (await client.sessions.recap.query({
      sessionId,
      ...(typeof args.since === 'string' ? { since: args.since } : {}),
    })) as RecapWire
    return args.json === true ? JSON.stringify({ command, ok: true, data: r }) : renderRecap(r)
  }
  // Tier 4 (#237) [spec:SP-34d7 read-toolkit]: the seance.
  if (command === 'ask') {
    const question = args.question
    if (typeof question !== 'string' || question.length === 0) {
      throw new SessionCliError('ask needs --question')
    }
    if (question.length > 32_768) throw new SessionCliError('question exceeds 32768 characters')
    if (args.timeout !== undefined && !/^\d+$/.test(String(args.timeout))) {
      throw new SessionCliError('--timeout must be a whole number of seconds')
    }
    const a = (await client.sessions.ask.mutate({
      sessionId,
      question,
      ...(args.timeout !== undefined ? { timeoutSeconds: Number(args.timeout) } : {}),
    })) as AskWire
    return args.json === true ? JSON.stringify({ command, ok: true, data: a }) : renderAsk(a)
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
    console.log(await runSessionCli(argv, client, { hasRelay: Boolean(relay) }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: message }))
    else console.error(`podium session: ${message}`)
    process.exitCode = 1
  }
}
