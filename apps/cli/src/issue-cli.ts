import {
  ISSUE_COMMANDS,
  type IssueTrpc,
  makeIssueClient,
  makeRelayIssueClient,
} from '@podium/issue-client'
import { resolveIssueRelay, resolvePort } from '@podium/runtime/config'
import type { z } from 'zod'

/** Kebab-case flag → camelCase key, so `--outside-scope` becomes `outsideScope`. */
const camelFlag = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** Flags that never take a value; a following bare token is a positional, not their value. */
const BOOL_FLAGS = new Set([
  'json',
  'start',
  'outsideScope',
  'recursive',
  'clear',
  'nudge',
  'notify',
  'help',
])

/** A CLI failure that should print as `podium issue: <message>` and exit non-zero. */
export class IssueCliError extends Error {}

/** Pure argv → { command, args, positionals }. `--flag value`/`--flag=value` become args;
 *  bare tokens after the command are positionals (mapped per command in runIssueCli). */
export function parseIssueArgs(argv: string[]): {
  command?: string
  args: Record<string, unknown>
  positionals: string[]
} {
  const [command, ...rest] = argv
  const args: Record<string, unknown> = {}
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (!t?.startsWith('--')) {
      if (t != null) positionals.push(t)
      continue
    }
    const eq = t.indexOf('=')
    if (eq >= 0) {
      args[camelFlag(t.slice(2, eq))] = t.slice(eq + 1)
    } else {
      const key = camelFlag(t.slice(2))
      const next = rest[i + 1]
      if (BOOL_FLAGS.has(key) || next == null || next.startsWith('--')) {
        args[key] = true
      } else {
        args[key] = next
        i++
      }
    }
  }
  return { ...(command ? { command } : {}), args, positionals }
}

function helpText(): string {
  const w = Math.max(...ISSUE_COMMANDS.map((c) => c.name.length))
  return [
    'podium issue <command> [--flags]',
    '',
    ...ISSUE_COMMANDS.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`),
    '',
    'Run `podium issue <command> --help` for that command’s flags.',
  ].join('\n')
}

/** The registry slice per-command help renders (both ISSUE_COMMANDS and SPEC_COMMANDS fit). */
interface HelpableCommand {
  name: string
  summary: string
  args: unknown
  positionals?: string[]
  restKey?: string
}

/** Render `podium <tool> <command> --help` from the command's zod object shape:
 *  usage line (positionals from the registry), summary, then one row per flag with a
 *  (required) marker for non-optional keys. Boolean flags render without `<value>`. */
export function commandHelpText(tool: string, cmd: HelpableCommand): string {
  const shape =
    ((cmd.args as { shape?: Record<string, { isOptional?: () => boolean }> }).shape ?? {}) || {}
  const pos = (cmd.positionals ?? []).map((p) => `<${p}>`).join(' ')
  const rest = cmd.restKey ? ` [<${cmd.restKey}>…]` : ''
  const keys = Object.keys(shape)
  const flag = (k: string): string =>
    `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}${BOOL_FLAGS.has(k) ? '' : ' <value>'}`
  const w = Math.max(0, ...keys.map((k) => flag(k).length))
  return [
    `Usage: podium ${tool} ${cmd.name}${pos ? ` ${pos}` : ''}${rest}${keys.length ? ' [--flags]' : ''}`,
    '',
    `  ${cmd.summary}`,
    ...(keys.length
      ? [
          '',
          'Flags:',
          ...keys.map((k) => {
            const optional = shape[k]?.isOptional?.() ?? true
            return `  ${flag(k).padEnd(w)}${optional ? '' : '  (required)'}`
          }),
        ]
      : []),
    ...('repoPath' in shape ? ['', '(--repo-path is inferred from the cwd when omitted)'] : []),
  ].join('\n')
}

/** Shared help dispatch for the registry-driven CLIs (issue/spec): handles
 *  `--help`, `help`, and `help <command>`. Returns undefined when not a help request. */
export function registryHelp(
  tool: string,
  commands: readonly HelpableCommand[],
  overview: () => string,
  parsed: { command?: string; args: Record<string, unknown>; positionals: string[] },
): string | undefined {
  const { command, args, positionals } = parsed
  const forCommand = (name: string): string => {
    const cmd = commands.find((c) => c.name === name)
    if (!cmd) throw new IssueCliError(`unknown command: ${name}\n\n${overview()}`)
    return commandHelpText(tool, cmd)
  }
  if (args.help === true) return command && command !== 'help' ? forCommand(command) : overview()
  if (command === 'help') return positionals[0] ? forCommand(positionals[0]) : overview()
  if (!command) return overview()
  return undefined
}

/** Flags valid on EVERY command, handled by the dispatcher itself — stripped before
 *  the (strict) per-command schema sees the args, so they never trip
 *  unrecognized-key rejection (#345). */
export function stripGlobalFlags(args: Record<string, unknown>): Record<string, unknown> {
  const { json: _json, help: _help, outsideScope: _outsideScope, ...rest } = args
  return rest
}

const kebab = (k: string): string => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** Render zod issues for the CLI: unrecognized keys become `unknown flag --x` with a
 *  --help pointer (the strict schemas reject them since #345); everything else keeps
 *  the field: message form. */
export function renderArgIssues(command: string, error: z.ZodError): string {
  return error.issues
    .map((i) =>
      i.code === 'unrecognized_keys'
        ? `unknown flag${i.keys.length > 1 ? 's' : ''} ${i.keys.map((k) => `--${kebab(k)}`).join(', ')} (see \`${command} --help\`)`
        : `${i.path.join('.') || 'args'}: ${i.message}`,
    )
    .join('; ')
}

/** Inject the inferred repo when the command takes a `--repoPath` and none was given.
 *  A command "needs a repo" iff its zod `args` shape has a `repoPath` key; `infer`
 *  (cwd → repo) is only consulted in that case and only when `repoPath` is absent. */
export async function resolveRepoArg(
  command: string,
  args: Record<string, unknown>,
  infer: () => Promise<string | undefined>,
): Promise<Record<string, unknown>> {
  const cmd = ISSUE_COMMANDS.find((c) => c.name === command)
  const shape = (cmd?.args as { shape?: Record<string, unknown> } | undefined)?.shape ?? {}
  if (cmd && 'repoPath' in shape && args.repoPath == null) {
    const inferred = await infer()
    if (inferred) return { ...args, repoPath: inferred }
  }
  return args
}

/** Resolve + run one issue command; returns the text to print. Failures (unknown
 *  command, invalid args, server errors) THROW — the caller maps them to a non-zero
 *  exit. `--json` renders `{command, ok, data, text}` on one line instead of text. */
export async function runIssueCli(
  argv: string[],
  client: IssueTrpc,
  opts?: { defaultAuthor?: string },
): Promise<string> {
  // `-h` ≡ `--help`; a leading `--help` reads as the `help` command (no command to attach to).
  const mapped = argv.map((a) => (a === '-h' ? '--help' : a))
  if (mapped[0] === '--help') mapped[0] = 'help'
  const parsedArgs = parseIssueArgs(mapped)
  const { command, args, positionals } = parsedArgs
  const help = registryHelp('issue', ISSUE_COMMANDS, helpText, parsedArgs)
  if (help != null) return help
  if (!command) return helpText() // unreachable (registryHelp covers it) — narrows the type
  const cmd = ISSUE_COMMANDS.find((c) => c.name === command)
  if (!cmd) throw new IssueCliError(`unknown command: ${command}\n\n${helpText()}`)
  // Positionals map onto the command's declared keys (flags win on conflict),
  // so `podium issue start 10` ≡ `podium issue start --id 10`.
  for (let i = 0; i < (cmd.positionals?.length ?? 0); i++) {
    const key = cmd.positionals![i]!
    if (args[key] == null && positionals[i] != null) args[key] = positionals[i]
  }
  // Variadic tail (issue #82): leftover positionals join into the command's restKey,
  // so `show 1 2 3` ≡ `show 1 --ids 2,3` (an explicit --ids flag wins).
  if (cmd.restKey && args[cmd.restKey] == null) {
    const rest = positionals.slice(cmd.positionals?.length ?? 0)
    if (rest.length) args[cmd.restKey] = rest.join(',')
  }
  // Comment-style commands: default the author to who we are (agent via relay,
  // operator when talking to the server directly) unless explicitly given.
  const shape = (cmd.args as { shape?: Record<string, unknown> }).shape ?? {}
  if ('author' in shape && args.author == null && opts?.defaultAuthor) {
    args.author = opts.defaultAuthor
  }
  // Fill in --repoPath from the cwd when the command takes one and it was omitted.
  // The infer call is best-effort: a mock client without `repos` (unit tests) throws
  // synchronously, which the try/catch swallows so the args pass through unchanged.
  const resolved = await resolveRepoArg(command, args, async () => {
    try {
      const r = (await client.repos.inferFromPath.query({ path: process.cwd() })) as {
        repoPath: string | null
      }
      return r.repoPath ?? undefined
    } catch {
      return undefined
    }
  })
  const parsed = cmd.args.safeParse(stripGlobalFlags(resolved))
  if (!parsed.success) {
    throw new IssueCliError(
      `invalid args for ${command}: ${renderArgIssues(command, parsed.error)}`,
    )
  }
  const res = await cmd.run(client, parsed.data as Record<string, unknown>)
  return args.json === true
    ? JSON.stringify({ command, ok: true, data: res.data ?? null, text: res.text })
    : res.text
}

/** Entry used by scripts/cli.ts: build a client and run, printing the result.
 *  A constrained agent's process gets PODIUM_ISSUE_RELAY (a daemon endpoint bound to its
 *  session id) — its calls ride the daemon, which applies scope. Otherwise the operator CLI
 *  talks to the local server directly. `--outside-scope` rides through to the daemon; the
 *  session id is bound in the relay URL, so there is deliberately no `--session` flag.
 *  Any failure exits 1; with `--json` the error is a JSON object on stdout. */
export async function issueCliMain(argv: string[]): Promise<void> {
  const relay = resolveIssueRelay()
  const outsideScope = argv.includes('--outside-scope')
  // The session-injected relay wins over PODIUM_STATE_DIR/PODIUM_PORT targeting.
  // Say so instead of silently routing to the session's server (footgun when
  // driving an isolated instance from inside an agent session); unset
  // PODIUM_ISSUE_RELAY to talk to the targeted instance directly.
  if (relay && process.env.PODIUM_STATE_DIR)
    console.error(
      'podium issue: routing via this session’s issue relay (PODIUM_STATE_DIR/PODIUM_PORT ignored; unset PODIUM_ISSUE_RELAY to target another instance)',
    )
  const client = relay
    ? makeRelayIssueClient(relay, { outsideScope })
    : makeIssueClient(`http://localhost:${resolvePort()}`)
  try {
    console.log(await runIssueCli(argv, client, { defaultAuthor: relay ? 'agent' : 'operator' }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (argv.includes('--json')) {
      const { command } = parseIssueArgs(argv)
      console.log(JSON.stringify({ ...(command ? { command } : {}), ok: false, error: msg }))
    } else {
      console.error(`podium issue: ${msg}`)
    }
    process.exitCode = 1
  }
}
