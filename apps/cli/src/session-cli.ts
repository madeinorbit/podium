import { makeIssueClient, makeRelayIssueClient } from '@podium/issue-client'

type SessionResult = { ok: boolean; queued?: boolean; reason?: string }
type SessionProc = { mutate(input: Record<string, unknown>): Promise<SessionResult> }

export interface SessionControlClient {
  sessions: {
    sendText: SessionProc
    resumeAndSend: SessionProc
    continue: SessionProc
  }
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
  const booleans = new Set(['json', 'outside-scope', 'wake'])
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
  ].join('\n')
}

export async function runSessionCli(argv: string[], client: SessionControlClient): Promise<string> {
  const { command, args, positionals } = parseSessionArgs(argv)
  if (!command || command === 'help') return helpText()
  const sessionId = positionals[0]
  if (!sessionId) throw new SessionCliError(`${command} needs a session id`)
  if (positionals.length > 1) throw new SessionCliError(`unexpected argument: ${positionals[1]}`)

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
