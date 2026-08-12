/**
 * `podium logs clients` / `podium logs level` — THE OPERATOR'S KNOB, FROM A
 * SHELL (POD-1947, deferred item 1 of POD-1897).
 *
 * `logs.setLevel` already existed and already did the whole job: it pushes a
 * `setLogLevel` frame down the `/client` socket to every connection matching a
 * selector, and answers with the list of connections it reached. The only thing
 * missing was a caller outside the browser. This file is that caller and nothing
 * more — no second server surface, no second policy, no state.
 *
 * ---------------------------------------------------------------------------
 * THE FLOW IT IS SHAPED FOR
 * ---------------------------------------------------------------------------
 * An agent with a shell on the host, diagnosing a client it cannot click on:
 *
 *   podium logs clients                        # who is connected, and what are they called
 *   podium logs level debug --role web --for 30m
 *   …reproduce…
 *   podium logs web-ludovico                   # read the per-origin file
 *   podium logs level reset --role web
 *
 * Every step but the third is one call to `logs.setLevel`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LISTING IS ALSO A RESET
 * ---------------------------------------------------------------------------
 * There is no "list connected clients" query, deliberately (see
 * `modules/logs/level-director.ts`): the reply IS the discovery mechanism, so
 * the only way to ask who is connected is to send a level command and read who
 * it reached. Of the commands available, `level: null` is the one that is safe
 * to issue when you do not yet know what you are talking to — it puts clients
 * BACK to their boot default rather than turning anything up. So
 * `podium logs clients` is that command, and it says so in its output rather
 * than pretending to be a passive read: an operator who lists mid-investigation
 * has ended their own raise, and must be told.
 *
 * ---------------------------------------------------------------------------
 * ONE KNOB
 * ---------------------------------------------------------------------------
 * `level` is the client's whole verbosity — console and forwarded stream move
 * together, because the forwarding sink pins no threshold of its own. There is
 * no `--forward-level` here and there must never be one; two controls that can
 * disagree about what a client is reporting is the failure the logging design
 * refuses. Per-namespace targeting is likewise absent: the frame carries a
 * global level, so a `--namespace` flag would be a promise the wire cannot keep.
 *
 * ---------------------------------------------------------------------------
 * IT TALKS TO THE LOCAL SERVER, NOT THROUGH THE AGENT RELAY
 * ---------------------------------------------------------------------------
 * `logs.setLevel` is `roleFloor: admin` — it reaches ACROSS into somebody else's
 * running client — so it rides the operator's own credential over `/trpc`, the
 * same path `podium issue` takes outside a managed session. Allowlisting it on
 * the agent relay would hand every managed session admin reach over every
 * connected client, which is a privilege decision this command has no business
 * making on the side.
 */

import { localServerUrl, resolvePort } from '@podium/runtime/config'
import { makeOperatorIssueClient } from './operator-client'

export class LogsLevelCliError extends Error {}

/**
 * The levels, restated. `@podium/commands` owns `forwardedLogLevel` and
 * `@podium/logger` owns `LEVELS`, and this package depends on neither; the enum
 * has been five words since the logger shipped, and a wrong one here is refused
 * by the schema on the way in rather than silently misapplied.
 */
const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const
export type RaiseLevel = (typeof LEVELS)[number]

/** The wire cap, restated for the same reason (`MAX_SET_LEVEL_TTL_MS`). Caught
 *  here so an operator who types `--for 48h` gets a sentence rather than a zod
 *  error out of a tRPC envelope. */
const MAX_TTL_MS = 24 * 60 * 60 * 1000

/** What the client applies when a raise names no duration
 *  (`DEFAULT_LEVEL_TTL_MS` in client-core). Only ever printed. */
const CLIENT_DEFAULT_TTL_MS = 30 * 60 * 1000

/** One connection the command reached, as `SetLevelResult` reports it. */
export interface RaisedClientWire {
  clientId: string
  role?: string
  v?: string
  machineId?: string
}

export interface SetLevelReply {
  level: string | null
  clients: RaisedClientWire[]
}

/** The one procedure this command calls. Structural, so the direct tRPC client
 *  can be handed over with a cast the way `podium quota` hands over its own. */
export interface LogsLevelClient {
  logs: {
    setLevel: {
      mutate(input: unknown): Promise<unknown>
    }
  }
}

export interface SetLevelInput {
  level: RaiseLevel | null
  ttlMs?: number
  target?: { clientId?: string; role?: string; machineId?: string }
}

/** `clients` and `reset` send the same frame; they differ in what the operator
 *  asked for, which is what the output has to answer. */
export type LogsLevelKind = 'clients' | 'raise' | 'reset'

export interface LogsLevelPlan {
  kind: LogsLevelKind
  json: boolean
  input: SetLevelInput
}

export function logsLevelHelpText(): string {
  return [
    'podium logs clients [--json]',
    'podium logs level <level|reset> [selector] [--for <duration>] [--json]',
    '',
    'Turn up what a CONNECTED client records, so a problem on someone else’s',
    'machine can be reproduced and read without shipping them a new build. The',
    'raised client forwards to this server, into logs/clients/<origin>.ndjson —',
    'read it with `podium logs <origin>`.',
    '',
    'Verbs:',
    '  clients               List the connected clients. This is a RESET: it also',
    '                        puts every client back to its boot default, because',
    '                        the server answers "who is connected" only by',
    '                        replying to a level command.',
    `  level <level>         Raise the matching clients. One of: ${LEVELS.join(', ')}.`,
    '  level reset           Put the matching clients back to their boot default.',
    '',
    'Selector (all optional, and they AND together; none means every client):',
    '  --client <id>         The connection id, as a previous reply printed it',
    '  --role <role>         web | desktop | mobile — what the client calls itself',
    '  --machine <id>        The client’s machine id',
    '',
    'Duration:',
    '  --for <30s|30m|2h>    How long the raise lasts. Default 30 minutes (the',
    '                        client’s own), maximum 24h. Every raise expires, and',
    '                        a client that reloads is back at its default anyway —',
    '                        nothing is persisted on either side.',
    '',
    '  --json                Print the server’s reply verbatim.',
    '  --help                Show this help.',
    '',
    'The reply lists what it reached. A raise that matched no connected client',
    'exits non-zero rather than reporting success.',
  ].join('\n')
}

/** PURE: `30m` → 1_800_000. A unit is REQUIRED — a bare `--for 30` is thirty of
 *  something, and the two readings (minutes, milliseconds) differ by 60000×. */
export function parseRaiseDuration(raw: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(raw.trim())
  if (!match) {
    throw new LogsLevelCliError(
      `--for expects a duration with a unit, like 30m, 90s or 2h (got '${raw}')`,
    )
  }
  const amount = Number(match[1])
  const unitMs = match[2] === 's' ? 1000 : match[2] === 'm' ? 60_000 : 3_600_000
  const ms = amount * unitMs
  if (ms <= 0) throw new LogsLevelCliError('--for must be a positive duration')
  if (ms > MAX_TTL_MS) {
    throw new LogsLevelCliError(`--for is capped at 24h (got '${raw}'); re-issue the raise instead`)
  }
  return ms
}

const SELECTORS = { '--client': 'clientId', '--role': 'role', '--machine': 'machineId' } as const

/** PURE: the argv a `logs clients` / `logs level` invocation means. */
export function parseLogsLevelArgs(argv: string[]): LogsLevelPlan {
  const verb = argv[0]
  if (verb !== 'clients' && verb !== 'level') {
    throw new LogsLevelCliError(`unexpected argument '${verb ?? ''}'`)
  }
  const rest = argv.slice(1)
  let json = false
  let ttlMs: number | undefined
  const target: { clientId?: string; role?: string; machineId?: string } = {}
  const positional: string[] = []

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string
    if (arg === '--json') {
      json = true
      continue
    }
    // `--role web` and `--role=web` are the same flag; the CLI's other verbs
    // accept both and an operator should not have to remember which this is.
    const eq = arg.indexOf('=')
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg
    const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : undefined
    const take = (): string => {
      const value = inline ?? rest[i + 1]
      if (value === undefined || (inline === undefined && value.startsWith('-'))) {
        throw new LogsLevelCliError(`${flag} needs a value`)
      }
      if (inline === undefined) i += 1
      return value
    }
    if (flag === '--for') {
      ttlMs = parseRaiseDuration(take())
      continue
    }
    if (Object.hasOwn(SELECTORS, flag)) {
      target[SELECTORS[flag as keyof typeof SELECTORS]] = take()
      continue
    }
    if (arg.startsWith('-')) {
      throw new LogsLevelCliError(`unknown option '${arg}' (see \`podium logs level --help\`)`)
    }
    positional.push(arg)
  }

  const hasTarget = Object.keys(target).length > 0
  if (verb === 'clients') {
    if (positional.length > 0) {
      throw new LogsLevelCliError(
        `unexpected argument '${positional[0]}' — \`podium logs clients\` takes no selector, ` +
          'because the point of it is to find out what there is to select',
      )
    }
    if (hasTarget) {
      throw new LogsLevelCliError(
        '`podium logs clients` takes no selector; use `podium logs level reset` to put a ' +
          'specific client back',
      )
    }
    if (ttlMs !== undefined) throw new LogsLevelCliError('--for has no meaning for a listing')
    return { kind: 'clients', json, input: { level: null } }
  }

  const level = positional[0]
  if (level === undefined) {
    throw new LogsLevelCliError(
      `podium logs level needs a level (${LEVELS.join(', ')}) or \`reset\``,
    )
  }
  if (positional.length > 1) {
    throw new LogsLevelCliError(`unexpected argument '${positional[1]}'`)
  }
  if (level === 'reset') {
    // A reset carries no deadline: the level it restores IS the client's
    // default, and there is nothing for a timer to undo.
    if (ttlMs !== undefined) throw new LogsLevelCliError('--for has no meaning on a reset')
    return {
      kind: 'reset',
      json,
      input: { level: null, ...(hasTarget ? { target } : {}) },
    }
  }
  if (!(LEVELS as readonly string[]).includes(level)) {
    throw new LogsLevelCliError(
      `unknown level '${level}' (expected one of: ${LEVELS.join(', ')}, or \`reset\`)`,
    )
  }
  return {
    kind: 'raise',
    json,
    input: {
      level: level as RaiseLevel,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(hasTarget ? { target } : {}),
    },
  }
}

/** PURE: `1_800_000` → `30m`, in the units the operator typed them in. */
export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

/**
 * PURE: the per-origin log file a reached client's records land in — the same
 * name `originKey` derives server-side (`modules/logs/service.ts`), so the
 * operator can go straight from "I raised this" to "here is its file" without a
 * `ls` in between.
 */
export function originFileFor(client: RaisedClientWire): string {
  const raw = client.machineId ? `${client.role ?? 'unknown'}-${client.machineId}` : client.role
  const safe = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 48)
  return `logs/clients/${safe.length > 0 ? safe : 'unknown'}.ndjson`
}

function describe(client: RaisedClientWire): string {
  const meta: string[] = []
  if (client.role !== undefined) meta.push(`role=${client.role}`)
  if (client.v !== undefined) meta.push(`v=${client.v}`)
  if (client.machineId !== undefined) meta.push(`machine=${client.machineId}`)
  // The connection id is what the next call is typed against (`--client c3`),
  // so it sits alone in its own column rather than in the run of key=values.
  return `  ${client.clientId}  ${meta.join(' ')}`.trimEnd()
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/**
 * PURE: the reply as the operator needs to read it — the REACHED LIST, never a
 * bare ok. A selector that matched nothing and a selector that matched three
 * clients both "succeed" at the transport, and the difference is the whole
 * content of the answer.
 */
export function renderSetLevelReply(
  kind: LogsLevelKind,
  reply: SetLevelReply,
  opts: { ttlMs?: number },
): string {
  const { clients } = reply
  if (kind === 'raise') {
    if (clients.length === 0) {
      return [
        'No connected client matched. Nothing was raised.',
        'Run `podium logs clients` to see what is connected right now.',
      ].join('\n')
    }
    const window = opts.ttlMs
      ? formatDuration(opts.ttlMs)
      : `${formatDuration(CLIENT_DEFAULT_TTL_MS)} (the client default)`
    return [
      `Raised ${plural(clients.length, 'client')} to ${reply.level} for ${window}:`,
      ...clients.map(describe),
      '',
      'Reproduce the problem, then read:',
      ...[...new Set(clients.map(originFileFor))].map((f) => `  ${f}`),
      'It turns itself back down when the window expires; `podium logs level reset` is sooner.',
    ].join('\n')
  }
  if (kind === 'reset') {
    if (clients.length === 0) {
      return 'No connected client matched — a client that is gone is already at its default.'
    }
    return [
      `Restored ${plural(clients.length, 'client')} to its boot default:`,
      ...clients.map(describe),
    ].join('\n')
  }
  if (clients.length === 0) {
    return 'No clients connected.'
  }
  return [
    `${plural(clients.length, 'client')} connected, now at ${clients.length === 1 ? 'its' : 'their'} boot default:`,
    ...clients.map(describe),
    '',
    'Listing IS a reset — the server reports who is connected only by answering a',
    'level command, and `level: null` is the safe one to send blind.',
    'Raise one with `podium logs level debug --role <role>`.',
  ].join('\n')
}

export interface LogsLevelResult {
  text: string
  /** False when a RAISE reached nothing — the one outcome that must not read as
   *  success. A listing and a reset are honest at zero. */
  ok: boolean
}

const isHelp = (argv: string[]): boolean =>
  argv.includes('--help') || argv.includes('-h') || argv[1] === 'help'

export async function runLogsLevelCli(
  argv: string[],
  client: LogsLevelClient,
): Promise<LogsLevelResult> {
  if (isHelp(argv)) return { text: logsLevelHelpText(), ok: true }
  const plan = parseLogsLevelArgs(argv)
  const reply = (await client.logs.setLevel.mutate(plan.input)) as SetLevelReply
  const ok = plan.kind !== 'raise' || reply.clients.length > 0
  const command = plan.kind === 'clients' ? 'logs clients' : 'logs level'
  const window = plan.input.ttlMs !== undefined ? { ttlMs: plan.input.ttlMs } : {}
  return {
    text: plan.json
      ? JSON.stringify({ command, ok, data: reply })
      : renderSetLevelReply(plan.kind, reply, window),
    ok,
  }
}

/** The `podium logs clients` / `podium logs level` entry point. */
export async function logsLevelCliMain(argv: string[]): Promise<void> {
  const json = argv.includes('--json')
  const fail = (message: string): void => {
    if (json) console.log(JSON.stringify({ command: `logs ${argv[0]}`, ok: false, error: message }))
    else console.error(`podium logs ${argv[0]}: ${message}`)
    process.exitCode = 1
  }
  if (isHelp(argv)) {
    console.log(logsLevelHelpText())
    return
  }
  try {
    const client = makeOperatorIssueClient(
      localServerUrl(resolvePort()),
    ) as unknown as LogsLevelClient
    const result = await runLogsLevelCli(argv, client)
    console.log(result.text)
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(
      error instanceof LogsLevelCliError
        ? message
        : // The far end is this host's server. "fetch failed" on its own sends a
          // reader to check their network; the likely cause is that nothing is
          // listening, which they can check in one command.
          `${message} (this command talks to the local server over /trpc — is it running? \`podium status\`)`,
    )
  }
}
