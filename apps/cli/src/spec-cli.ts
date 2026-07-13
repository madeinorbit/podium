import {
  type IssueTrpc,
  makeIssueClient,
  makeRelayIssueClient,
  SPEC_COMMANDS,
} from '@podium/issue-client'
import { resolveIssueRelay, resolvePort } from '@podium/runtime/config'
import {
  IssueCliError,
  parseIssueArgs,
  registryHelp,
  renderArgIssues,
  stripGlobalFlags,
} from './issue-cli'

/**
 * `podium spec` — agent/operator CLI over the living project spec (pspec v1).
 * Same shape and transports as `podium issue` (./issue-cli.ts): relayed
 * through the daemon when PODIUM_ISSUE_RELAY is set (agent path), direct tRPC
 * otherwise (operator path). Commands live in @podium/issue-client (spec-commands).
 */

function helpText(): string {
  const w = Math.max(...SPEC_COMMANDS.map((c) => c.name.length))
  return [
    'podium spec <command> [--flags]   (the living project spec in <repo>/pspec/)',
    '',
    ...SPEC_COMMANDS.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`),
    '',
    'Run `podium spec <command> --help` for that command’s flags.',
    'Run `podium spec prime` for the rules of engagement + current tree.',
  ].join('\n')
}

/** Resolve + run one spec command; returns the text to print. Failures THROW. */
export async function runSpecCli(argv: string[], client: IssueTrpc): Promise<string> {
  // `-h` ≡ `--help`; a leading `--help` reads as the `help` command (no command to attach to).
  const mapped = argv.map((a) => (a === '-h' ? '--help' : a))
  if (mapped[0] === '--help') mapped[0] = 'help'
  const parsedArgs = parseIssueArgs(mapped)
  const { command, args, positionals } = parsedArgs
  const help = registryHelp('spec', SPEC_COMMANDS, helpText, parsedArgs)
  if (help != null) return help
  if (!command) return helpText() // unreachable (registryHelp covers it) — narrows the type
  const cmd = SPEC_COMMANDS.find((c) => c.name === command)
  if (!cmd) throw new IssueCliError(`unknown command: ${command}\n\n${helpText()}`)
  for (let i = 0; i < (cmd.positionals?.length ?? 0); i++) {
    const key = cmd.positionals![i]!
    if (args[key] == null && positionals[i] != null) args[key] = positionals[i]
  }
  // Variadic tail joins with SPACES (it's prose here — search terms), unlike the
  // issue CLI's comma-joined id lists.
  if (cmd.restKey && args[cmd.restKey] == null) {
    const rest = positionals.slice(cmd.positionals?.length ?? 0)
    if (rest.length) args[cmd.restKey] = rest.join(' ')
  }
  // Fill in --repoPath from the cwd when omitted (all spec commands take one).
  if (args.repoPath == null) {
    try {
      const r = (await client.repos.inferFromPath.query({ path: process.cwd() })) as {
        repoPath: string | null
      }
      if (r.repoPath) args.repoPath = r.repoPath
    } catch {
      // best-effort — zod reports the missing repoPath below
    }
  }
  const parsed = cmd.args.safeParse(stripGlobalFlags(args))
  if (!parsed.success) {
    throw new IssueCliError(`invalid args for ${command}: ${renderArgIssues(command, parsed.error)}`)
  }
  const res = await cmd.run(client, parsed.data as Record<string, unknown>)
  return args.json === true
    ? JSON.stringify({ command, ok: true, data: res.data ?? null, text: res.text })
    : res.text
}

/** Entry used by apps/cli/src/cli.ts — same transport selection as issueCliMain. */
export async function specCliMain(argv: string[]): Promise<void> {
  const relay = resolveIssueRelay()
  const client = relay
    ? makeRelayIssueClient(relay)
    : makeIssueClient(`http://localhost:${resolvePort()}`)
  try {
    console.log(await runSpecCli(argv, client))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (argv.includes('--json')) {
      const { command } = parseIssueArgs(argv)
      console.log(JSON.stringify({ ...(command ? { command } : {}), ok: false, error: msg }))
    } else {
      console.error(`podium spec: ${msg}`)
    }
    process.exitCode = 1
  }
}
