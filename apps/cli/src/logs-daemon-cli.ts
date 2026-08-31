/**
 * `podium logs daemons` / `podium logs daemon-level` — THE OPERATOR'S KNOB OVER
 * THE FLEET, FROM A SHELL ON THE COORDINATING SERVER (POD-3156).
 *
 * The sibling of `./logs-level-cli.ts`, and deliberately its twin: same verbs in
 * the same order, same "listing IS a reset" property, same `--for` grammar, same
 * "a raise that reached nothing exits non-zero" rule. An operator who has used
 * one has used the other.
 *
 * ---------------------------------------------------------------------------
 * THE FLOW IT IS SHAPED FOR
 * ---------------------------------------------------------------------------
 * An operator on Ludovico, diagnosing Flatblock without an SSH session:
 *
 *   podium logs daemons                        # which machines have a live daemon
 *   podium logs daemon-level debug --machine <flatblock> --for 30m
 *   …reproduce…
 *   podium logs fleet-<flatblock>              # read what it sent
 *   podium logs daemon-level reset --machine <flatblock>
 *
 * Every step but the third is one call to `logs.setDaemonLevel`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LISTING IS ALSO A RESET
 * ---------------------------------------------------------------------------
 * Same reason as the client verb, and it matters more here. There is no "list
 * daemons" query in this family: the server answers "who is connected" only by
 * replying to a level command, and `level: null` is the one that is safe to send
 * before you know what you are talking to — it puts daemons BACK to their boot
 * default and stops them forwarding. An operator who lists mid-investigation has
 * ended their own raise, and is told so rather than left to discover it.
 *
 * (`podium machines` lists machines without touching anything. It is the right
 * command when the question is "what machines exist"; this one answers "which
 * daemons would a raise reach right now", which is a different question and is
 * only answerable by asking.)
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS FORWARDED UNTIL YOU RAISE IT
 * ---------------------------------------------------------------------------
 * Unlike a browser — which forwards `warn`+ to its own server as a matter of
 * course — a daemon ships nothing until this command turns it on, because its
 * records are a DIFFERENT HOST'S contents crossing a network. The help text says
 * so, because an operator who assumes the client behaviour will otherwise read
 * an empty file as a broken pipeline.
 *
 * The raise does carry the recent past: the daemon keeps a flight recorder in
 * memory at all times and ships it as the first batch, so what lands centrally
 * starts BEFORE the moment you typed the command.
 */

import { asMachineId, type MachineId } from '@podium/model'
import { localServerUrl, resolvePort } from '@podium/runtime/config'
import { LogsLevelCliError, formatDuration, parseRaiseDuration } from './logs-level-cli'
import { makeOperatorIssueClient } from './operator-client'

/** The levels, restated for `logs-level-cli.ts`'s reason: this package depends
 *  on neither `@podium/commands` nor `@podium/logger`, the enum has been five
 *  words since the logger shipped, and a wrong one is refused by the schema on
 *  the way in rather than silently misapplied. */
const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const
export type DaemonRaiseLevel = (typeof LEVELS)[number]

/** What the daemon applies when a raise names no duration
 *  (`DEFAULT_DAEMON_LEVEL_TTL_MS`). Only ever printed. */
const DAEMON_DEFAULT_TTL_MS = 30 * 60 * 1000

/** One daemon the command reached, as `SetDaemonLevelResult` reports it. */
export interface RaisedDaemonWire {
  machineId: MachineId
  name: string
  /** Records this machine reported dropping since the server booted. */
  dropped?: number
  /** Records the SERVER dropped under its own ingestion backpressure. */
  serverDropped?: number
}

export interface SetDaemonLevelReply {
  level: string | null
  daemons: RaisedDaemonWire[]
}

/** The one procedure this command calls. Structural, so the direct tRPC client
 *  can be handed over with a cast the way `podium quota` hands over its own. */
export interface LogsDaemonClient {
  logs: {
    setDaemonLevel: {
      mutate(input: unknown): Promise<unknown>
    }
  }
}

export interface SetDaemonLevelInput {
  level: DaemonRaiseLevel | null
  ttlMs?: number
  target?: { machineId?: MachineId }
}

export type LogsDaemonKind = 'daemons' | 'raise' | 'reset'

export interface LogsDaemonPlan {
  kind: LogsDaemonKind
  json: boolean
  input: SetDaemonLevelInput
}

export function logsDaemonHelpText(): string {
  return [
    'podium logs daemons [--json]',
    'podium logs daemon-level <level|reset> [--machine <id>] [--for <duration>] [--json]',
    '',
    'Turn up what a REMOTE MACHINE’s daemon records, and keep those records here,',
    'so a host that is misbehaving can be diagnosed without an SSH session on it.',
    'The raised daemon forwards to this server, into logs/fleet/<machine>.ndjson —',
    'read it with `podium logs fleet-<machine>`.',
    '',
    'A daemon forwards NOTHING until it is raised. That is deliberate: its records',
    'are another host’s paths, branches and command output crossing a network, so',
    'the default is closed and every raise expires. The first batch after a raise',
    'is the daemon’s in-memory flight recorder, so you also get the minute before',
    'you typed the command.',
    '',
    'Verbs:',
    '  daemons               List the machines with a live daemon. This is a RESET:',
    '                        it also puts every daemon back to its boot default and',
    '                        stops it forwarding, because the server reports what is',
    '                        connected only by answering a level command.',
    `  daemon-level <level>  Raise the matching daemons. One of: ${LEVELS.join(', ')}.`,
    '  daemon-level reset    Put the matching daemons back to their boot default.',
    '',
    'Selector:',
    '  --machine <id>        One machine. Absent means every daemon online right now.',
    '',
    'Duration:',
    '  --for <30s|30m|2h>    How long the raise lasts. Default 30 minutes (the',
    '                        daemon’s own), maximum 24h. The daemon holds the timer',
    '                        and puts itself back; nothing is persisted on either',
    '                        side, so a daemon that reconnects is at its default.',
    '',
    '  --json                Print the server’s reply verbatim.',
    '  --help                Show this help.',
    '',
    'The reply lists what it reached. A raise that matched no online daemon exits',
    'non-zero rather than reporting success.',
  ].join('\n')
}

/** PURE: the argv a `logs daemons` / `logs daemon-level` invocation means. */
export function parseLogsDaemonArgs(argv: string[]): LogsDaemonPlan {
  const verb = argv[0]
  if (verb !== 'daemons' && verb !== 'daemon-level') {
    throw new LogsLevelCliError(`unexpected argument '${verb ?? ''}'`)
  }
  const rest = argv.slice(1)
  let json = false
  let ttlMs: number | undefined
  const target: { machineId?: MachineId } = {}
  const positional: string[] = []

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string
    if (arg === '--json') {
      json = true
      continue
    }
    // `--machine m1` and `--machine=m1` are the same flag; every other verb in
    // this CLI accepts both and an operator should not have to remember which.
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
    if (flag === '--machine') {
      target.machineId = asMachineId(take())
      continue
    }
    if (arg.startsWith('-')) {
      throw new LogsLevelCliError(`unknown option '${arg}' (see \`podium logs daemon-level --help\`)`)
    }
    positional.push(arg)
  }

  const hasTarget = target.machineId !== undefined
  if (verb === 'daemons') {
    if (positional.length > 0) {
      throw new LogsLevelCliError(
        `unexpected argument '${positional[0]}' — \`podium logs daemons\` takes no selector, ` +
          'because the point of it is to find out what there is to select',
      )
    }
    if (hasTarget) {
      throw new LogsLevelCliError(
        '`podium logs daemons` takes no selector; use `podium logs daemon-level reset --machine ' +
          '<id>` to put one back',
      )
    }
    if (ttlMs !== undefined) throw new LogsLevelCliError('--for has no meaning for a listing')
    return { kind: 'daemons', json, input: { level: null } }
  }

  const level = positional[0]
  if (level === undefined) {
    throw new LogsLevelCliError(
      `podium logs daemon-level needs a level (${LEVELS.join(', ')}) or \`reset\``,
    )
  }
  if (positional.length > 1) {
    throw new LogsLevelCliError(`unexpected argument '${positional[1]}'`)
  }
  if (level === 'reset') {
    // A reset carries no deadline: the level it restores IS the daemon's
    // default, and there is nothing for a timer to undo.
    if (ttlMs !== undefined) throw new LogsLevelCliError('--for has no meaning on a reset')
    return { kind: 'reset', json, input: { level: null, ...(hasTarget ? { target } : {}) } }
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
      level: level as DaemonRaiseLevel,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(hasTarget ? { target } : {}),
    },
  }
}

/**
 * PURE: the file a reached daemon's records land in — the same name
 * `machineFileKey` derives server-side, so an operator goes straight from "I
 * raised this" to "here is its file" without an `ls` in between.
 */
export function fleetFileFor(daemon: RaisedDaemonWire): string {
  const safe = daemon.machineId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 48)
  return `logs/fleet/${safe.length > 0 ? safe : 'unknown'}.ndjson`
}

function describe(daemon: RaisedDaemonWire): string {
  // The machine id is what the next call is typed against (`--machine …`), so it
  // sits alone in its own column rather than in the run of key=values.
  const meta = [`name=${daemon.name}`]
  // A drop count is the difference between "this daemon went quiet" and "this
  // daemon's queue overflowed", which are opposite diagnoses — so it is on the
  // line the operator reads BEFORE they go looking at the file. The two counts
  // are named apart because they have different fixes: `dropped` is a lossy link
  // or a daemon louder than its socket, `serverDropped` is this server unable to
  // keep up with what it accepted.
  if (daemon.dropped !== undefined) meta.push(`dropped=${daemon.dropped}`)
  if (daemon.serverDropped !== undefined) meta.push(`serverDropped=${daemon.serverDropped}`)
  return `  ${daemon.machineId}  ${meta.join(' ')}`.trimEnd()
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/** PURE: the reply as the operator needs to read it — the REACHED LIST, never a
 *  bare ok. */
export function renderSetDaemonLevelReply(
  kind: LogsDaemonKind,
  reply: SetDaemonLevelReply,
  opts: { ttlMs?: number },
): string {
  const { daemons } = reply
  if (kind === 'raise') {
    if (daemons.length === 0) {
      return [
        'No online daemon matched. Nothing was raised.',
        'Run `podium logs daemons` to see which machines have a live daemon right now.',
      ].join('\n')
    }
    const window = opts.ttlMs
      ? formatDuration(opts.ttlMs)
      : `${formatDuration(DAEMON_DEFAULT_TTL_MS)} (the daemon default)`
    return [
      `Raised ${plural(daemons.length, 'daemon')} to ${reply.level} for ${window}:`,
      ...daemons.map(describe),
      '',
      'Reproduce the problem, then read:',
      ...[...new Set(daemons.map(fleetFileFor))].map((f) => `  ${f}`),
      'The first batch is the daemon’s flight recorder, so the file starts before now.',
      'It turns itself back down when the window expires; `podium logs daemon-level reset`',
      'is sooner.',
    ].join('\n')
  }
  if (kind === 'reset') {
    if (daemons.length === 0) {
      return 'No online daemon matched — a daemon that is gone is already at its default.'
    }
    return [
      `Restored ${plural(daemons.length, 'daemon')} to its boot default; forwarding is off:`,
      ...daemons.map(describe),
    ].join('\n')
  }
  if (daemons.length === 0) {
    return [
      'No daemons connected.',
      '`podium machines` lists the machines that exist; this lists the ones a raise',
      'would reach right now.',
    ].join('\n')
  }
  return [
    `${plural(daemons.length, 'daemon')} connected, now at ${daemons.length === 1 ? 'its' : 'their'} boot default:`,
    ...daemons.map(describe),
    '',
    'Listing IS a reset — the server reports what is connected only by answering a',
    'level command, and `level: null` is the safe one to send blind.',
    'Raise one with `podium logs daemon-level debug --machine <id>`.',
  ].join('\n')
}

export interface LogsDaemonResult {
  text: string
  /** False when a RAISE reached nothing — the one outcome that must not read as
   *  success. A listing and a reset are honest at zero. */
  ok: boolean
}

const isHelp = (argv: string[]): boolean =>
  argv.includes('--help') || argv.includes('-h') || argv[1] === 'help'

export async function runLogsDaemonCli(
  argv: string[],
  client: LogsDaemonClient,
): Promise<LogsDaemonResult> {
  if (isHelp(argv)) return { text: logsDaemonHelpText(), ok: true }
  const plan = parseLogsDaemonArgs(argv)
  const reply = (await client.logs.setDaemonLevel.mutate(plan.input)) as SetDaemonLevelReply
  const ok = plan.kind !== 'raise' || reply.daemons.length > 0
  const command = plan.kind === 'daemons' ? 'logs daemons' : 'logs daemon-level'
  const window = plan.input.ttlMs !== undefined ? { ttlMs: plan.input.ttlMs } : {}
  return {
    text: plan.json
      ? JSON.stringify({ command, ok, data: reply })
      : renderSetDaemonLevelReply(plan.kind, reply, window),
    ok,
  }
}

/** The `podium logs daemons` / `podium logs daemon-level` entry point. */
export async function logsDaemonCliMain(argv: string[]): Promise<void> {
  const json = argv.includes('--json')
  const fail = (message: string): void => {
    if (json) console.log(JSON.stringify({ command: `logs ${argv[0]}`, ok: false, error: message }))
    else console.error(`podium logs ${argv[0]}: ${message}`)
    process.exitCode = 1
  }
  if (isHelp(argv)) {
    console.log(logsDaemonHelpText())
    return
  }
  try {
    const client = makeOperatorIssueClient(
      localServerUrl(resolvePort()),
    ) as unknown as LogsDaemonClient
    const result = await runLogsDaemonCli(argv, client)
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
