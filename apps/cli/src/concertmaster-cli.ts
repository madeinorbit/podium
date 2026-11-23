/**
 * `podium concertmaster` — a Concertmaster's side of its curated chat (POD-7211).
 *
 *   concertmaster say "<message>" [--artifact <name>]…
 *   concertmaster ask --title "…" [--kind question|decision|todo] [--detail "…"] [--option "…"]…
 *   concertmaster update <n> [--title "…"] [--detail "…"] [--option "…"]…
 *   concertmaster resolve <n> [--answer "…"]
 *   concertmaster retract <n> [--reason "…"]
 *   concertmaster list [--all]
 *
 * A session its person marked as a Concertmaster is read through a curated
 * chat: the person sees what the agent sends with `say`, their own messages and
 * the agent's asks, and never the transcript. These commands are that agent's
 * whole voice.
 *
 * Every command acts on the CALLING session, identified by the daemon agent
 * relay (PODIUM_AGENT_RELAY) and never by a flag, so it is only meaningful from
 * inside a Podium-managed agent session. The writes are sync commands sent in a
 * `sync.submit` envelope through the relay; `list` is the relay's one read.
 * The server holds the limits and answers a refusal in a sentence.
 */

import { makeRelayIssueClient } from '@podium/issue-client'
import { type SyncSubmitTransport, submitNow } from '@podium/protocol'
import { resolveAgentRelay } from '@podium/runtime/config'
import { declareFlags, flagTable, parseFlags, withUnknownFlagAs } from './argv'

type Proc = { query(input?: unknown): Promise<unknown> }

export interface ConcertmasterClient extends SyncSubmitTransport {
  concertmaster: { list: Proc }
}

export class ConcertmasterCliError extends Error {}

/** One ask as `list` answers it (the server's `ConcertmasterAskSummary`). */
export interface ListedAsk {
  number: number
  kind: string
  title: string
  detail?: string
  options?: string[]
  status: string
  answer?: string
  settledBy?: string
  askedAt: string
  settledAt?: string
}

const COMMANDS = ['say', 'ask', 'update', 'resolve', 'retract', 'list'] as const
type Command = (typeof COMMANDS)[number]

/** What each command accepts. `--option` and `--artifact` repeat, in argv order. */
const FLAGS = flagTable(declareFlags({ known: [], booleans: ['json', 'help'] }), {
  say: { known: ['message', 'artifact'] },
  ask: { known: ['kind', 'title', 'detail', 'option'] },
  update: { known: ['title', 'detail', 'option'], booleans: ['no-options'] },
  resolve: { known: ['answer'] },
  retract: { known: ['reason'] },
  list: { booleans: ['all'] },
})

/** Shell double quotes keep `\n` as two characters; a message means a line break. */
const withNewlines = (value: string): string => value.replace(/\\r\\n|\\n/g, '\n')

export function helpText(): string {
  return [
    'podium concertmaster <command> [arguments]',
    '',
    'For a session its person marked as a Concertmaster. They do NOT see your',
    'transcript, terminal or final answer: they read a curated chat that shows what',
    'you send with `say`, their own messages, and your asks. Every command acts on',
    'THIS session.',
    '',
    '  say "<message>" [--artifact <name>]…',
    '      Send one message to your person. Markdown. `-` reads the message from',
    '      stdin; a literal \\n starts a new line. --artifact shows an issue artifact',
    '      (as added with `podium issue artifact --add`) with it; repeat for more.',
    '  ask --title "<one line>" [--kind question|decision|todo] [--detail "…"] [--option "…"]…',
    '      Put something you need from them on your ask list. question (default): an',
    '      answer in words. decision: they pick an --option (two or more; the one you',
    '      recommend first). todo: something only they can do. Prints the ask number.',
    '  update <n> [--title "…"] [--detail "…"] [--option "…"]… [--no-options]',
    '      Reword an OPEN ask. What you leave out stays as it is.',
    '  resolve <n> [--answer "<what they said>"]',
    '      They answered in a chat message instead of on the ask: settle it.',
    '  retract <n> [--reason "…"]',
    '      The ask no longer matters: take it back.',
    '  list [--all]',
    '      Your open asks; --all adds the settled ones with their answers.',
    '',
    'Writing rules:',
    '  - Say the outcome first, short and plain, like a teammate in a chat. No tool',
    '    logs, no step-by-step narration. A turn that ends without `say` shows nothing.',
    '  - One ask per thing, each answerable cold. Keep the list true: resolve what was',
    '    answered in text, retract what no longer matters.',
    '  - An answer given on the ask reaches you as a message naming its number; it is',
    '    settled already.',
    '',
    'Examples:',
    '  podium concertmaster say "The login fix is merged. Two follow-ups are queued."',
    '  podium concertmaster ask --kind decision --title "Ship the new sidebar today?" \\',
    '    --detail "Tests are green; the phone layout is untested." \\',
    '    --option "Ship today" --option "Wait for the phone check"',
    '  podium concertmaster ask --kind todo --title "Rotate the staging API key"',
    '  podium concertmaster resolve 3 --answer "Go with Postgres"',
    '  podium concertmaster list',
  ].join('\n')
}

interface Parsed {
  command: Command
  args: Record<string, string | boolean>
  positionals: string[]
  options: string[]
  artifacts: string[]
}

export function parseConcertmasterArgs(argv: string[]): Parsed {
  const [first, ...rest] = argv
  if (first === undefined || !(COMMANDS as readonly string[]).includes(first)) {
    throw new ConcertmasterCliError(
      `${first === undefined ? 'missing command' : `unknown command: ${first}`}\n\n${helpText()}`,
    )
  }
  const command = first as Command
  const parsed = withUnknownFlagAs(
    (message) => new ConcertmasterCliError(message),
    () =>
      parseFlags(rest, FLAGS(command), { usage: `podium concertmaster ${command}`, keys: 'raw' }),
  )
  const options: string[] = []
  const artifacts: string[] = []
  for (const { key, value } of parsed.occurrences) {
    if (typeof value !== 'string') continue
    if (key === 'option') options.push(value)
    if (key === 'artifact') artifacts.push(value)
  }
  return { command, args: parsed.args, positionals: parsed.positionals, options, artifacts }
}

const stringFlag = (args: Record<string, string | boolean>, key: string): string | undefined => {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/** The ask number a command names: its first positional, with or without `#`. */
function askNumber(command: Command, positionals: string[]): number {
  const raw = positionals[0]?.replace(/^#/, '')
  const number = raw === undefined ? Number.NaN : Number(raw)
  if (!Number.isInteger(number) || number < 1) {
    throw new ConcertmasterCliError(
      `${command} needs the ask's number, as \`podium concertmaster list\` shows it (for example: podium concertmaster ${command} 3)`,
    )
  }
  return number
}

function askLine(ask: ListedAsk): string {
  const head = `#${ask.number} [${ask.kind}] ${ask.title}`
  const lines = [ask.status === 'open' ? head : `${head} — ${ask.status}`]
  if (ask.detail) lines.push(`    ${ask.detail.replace(/\n/g, '\n    ')}`)
  if (ask.options?.length) lines.push(`    options: ${ask.options.join(' | ')}`)
  if (ask.status !== 'open' && ask.answer) {
    lines.push(`    ${ask.settledBy === 'user' ? 'their answer' : 'settled with'}: ${ask.answer}`)
  }
  return lines.join('\n')
}

export interface ConcertmasterCliIo {
  /** Read all of stdin: the message of `say -`. */
  readStdin(): Promise<string>
}

export async function runConcertmasterCli(
  argv: string[],
  client: ConcertmasterClient,
  io: ConcertmasterCliIo,
): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') return helpText()
  const { command, args, positionals, options, artifacts } = parseConcertmasterArgs(argv)
  const asJson = args.json === true
  const done = (text: string, data: unknown): string =>
    asJson ? JSON.stringify({ command, ok: true, data }) : text
  const noticed = (text: string, result: { notice?: string }): string =>
    result.notice ? `${text}\n${result.notice}` : text

  switch (command) {
    case 'say': {
      const typed = stringFlag(args, 'message') ?? positionals.join(' ')
      const message = typed === '-' ? await io.readStdin() : withNewlines(typed)
      if (!message.trim()) {
        throw new ConcertmasterCliError(
          'say needs a message: podium concertmaster say "…" (or `-` to read it from stdin)',
        )
      }
      const input = {
        body: message.trim(),
        ...(artifacts.length > 0 ? { artifacts: artifacts.map((name) => name.trim()) } : {}),
      }
      const result = await submitNow(client, 'concertmaster.say', input, {
        action: 'send the message',
      })
      return done(
        artifacts.length > 0
          ? `said (${artifacts.length} artifact${artifacts.length > 1 ? 's' : ''})`
          : 'said',
        result,
      )
    }
    case 'ask': {
      const title = stringFlag(args, 'title') ?? positionals.join(' ')
      if (!title.trim()) {
        throw new ConcertmasterCliError('ask needs --title "<one line>"')
      }
      const kind = stringFlag(args, 'kind')
      const detail = stringFlag(args, 'detail')
      const input = {
        title: title.trim(),
        ...(kind !== undefined ? { kind: kind.trim() } : {}),
        ...(detail !== undefined ? { detail: withNewlines(detail) } : {}),
        ...(options.length > 0 ? { options } : {}),
      }
      const result = await submitNow<{ number: number }>(client, 'concertmaster.ask', input, {
        action: 'open the ask',
      })
      return done(`ask #${result.number} opened`, result)
    }
    case 'update': {
      const number = askNumber(command, positionals)
      const title = stringFlag(args, 'title')
      const detail = stringFlag(args, 'detail')
      if (args['no-options'] === true && options.length > 0) {
        throw new ConcertmasterCliError('give --option or --no-options, not both')
      }
      const input = {
        number,
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(detail !== undefined ? { detail: withNewlines(detail) } : {}),
        ...(options.length > 0 ? { options } : args['no-options'] === true ? { options: [] } : {}),
      }
      const result = await submitNow(client, 'concertmaster.update', input, {
        action: 'update the ask',
      })
      return done(`ask #${number} updated`, result)
    }
    case 'resolve': {
      const number = askNumber(command, positionals)
      const answer = stringFlag(args, 'answer')
      const result = await submitNow<{ settled: boolean; notice?: string }>(
        client,
        'concertmaster.resolve',
        { number, ...(answer !== undefined ? { answer: withNewlines(answer) } : {}) },
        { action: 'resolve the ask' },
      )
      return done(
        noticed(result.settled ? `ask #${number} resolved` : `ask #${number} unchanged`, result),
        result,
      )
    }
    case 'retract': {
      const number = askNumber(command, positionals)
      const reason = stringFlag(args, 'reason')
      const result = await submitNow<{ settled: boolean; notice?: string }>(
        client,
        'concertmaster.retract',
        { number, ...(reason !== undefined ? { reason: withNewlines(reason) } : {}) },
        { action: 'retract the ask' },
      )
      return done(
        noticed(result.settled ? `ask #${number} retracted` : `ask #${number} unchanged`, result),
        result,
      )
    }
    case 'list': {
      const result = (await client.concertmaster.list.query({
        show: args.all === true ? 'all' : 'open',
      })) as { asks: ListedAsk[] }
      if (asJson) return done('', result)
      if (result.asks.length === 0) {
        return args.all === true ? 'no asks yet' : 'no open asks'
      }
      // The server answers newest first; a list reads oldest first.
      return [...result.asks].reverse().map(askLine).join('\n')
    }
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

export async function concertmasterCliMain(argv: string[]): Promise<void> {
  // Help renders without a relay/server (and without a calling session).
  if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    console.log(helpText())
    return
  }
  const fail = (message: string): void => {
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: message }))
    else console.error(`podium concertmaster: ${message}`)
    process.exitCode = 1
  }
  const relay = resolveAgentRelay()
  if (!relay) {
    fail('only available inside a Podium-managed agent session (PODIUM_AGENT_RELAY is unset).')
    return
  }
  const client = makeRelayIssueClient(relay, {}) as unknown as ConcertmasterClient
  try {
    console.log(await runConcertmasterCli(argv, client, { readStdin: readAllStdin }))
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}
