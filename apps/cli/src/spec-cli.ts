import {
  type IssueTrpc,
  makeIssueClient,
  makeRelayIssueClient,
  SPEC_COMMANDS,
} from '@podium/issue-client'
import { IssueCliError, parseIssueArgs } from './issue-cli'

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
    'Run `podium spec prime` for the rules of engagement + current tree.',
  ].join('\n')
}

/** Resolve + run one spec command; returns the text to print. Failures THROW. */
export async function runSpecCli(argv: string[], client: IssueTrpc): Promise<string> {
  const { command, args, positionals } = parseIssueArgs(argv)
  if (!command || command === 'help') return helpText()
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
  const parsed = cmd.args.safeParse(args)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'args'}: ${i.message}`)
      .join('; ')
    throw new IssueCliError(`invalid args for ${command}: ${details}`)
  }
  const res = await cmd.run(client, parsed.data as Record<string, unknown>)
  return args.json === true
    ? JSON.stringify({ command, ok: true, data: res.data ?? null, text: res.text })
    : res.text
}

/** Entry used by apps/cli/src/cli.ts — same transport selection as issueCliMain. */
export async function specCliMain(argv: string[]): Promise<void> {
  const relay = process.env.PODIUM_ISSUE_RELAY
  const client = relay
    ? makeRelayIssueClient(relay)
    : makeIssueClient(`http://localhost:${Number(process.env.PODIUM_PORT) || 18787}`)
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
