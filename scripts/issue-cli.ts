import {
  type IssueTrpc,
  makeIssueClient,
  makeRelayIssueClient,
} from '../apps/server/src/issue-client'
import { ISSUE_COMMANDS } from '../apps/server/src/issue-commands'

/** Kebab-case flag → camelCase key, so `--outside-scope` becomes `outsideScope`. */
const camelFlag = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** Pure argv → { command, args }. Positionals are ignored except the command (argv[0]). */
export function parseIssueArgs(argv: string[]): {
  command?: string
  args: Record<string, unknown>
} {
  const [command, ...rest] = argv
  const args: Record<string, unknown> = {}
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (!t?.startsWith('--')) continue
    const eq = t.indexOf('=')
    if (eq >= 0) {
      args[camelFlag(t.slice(2, eq))] = t.slice(eq + 1)
    } else {
      const key = camelFlag(t.slice(2))
      const next = rest[i + 1]
      if (next == null || next.startsWith('--')) {
        args[key] = true
      } else {
        args[key] = next
        i++
      }
    }
  }
  return { ...(command ? { command } : {}), args }
}

function helpText(): string {
  const w = Math.max(...ISSUE_COMMANDS.map((c) => c.name.length))
  return [
    'podium issue <command> [--flags]',
    '',
    ...ISSUE_COMMANDS.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`),
  ].join('\n')
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

/** Resolve + run one issue command against the given client; returns the text to print. */
export async function runIssueCli(argv: string[], client: IssueTrpc): Promise<string> {
  const { command, args } = parseIssueArgs(argv)
  if (!command || command === 'help') return helpText()
  const cmd = ISSUE_COMMANDS.find((c) => c.name === command)
  if (!cmd) return `unknown command: ${command}\n\n${helpText()}`
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
  const parsed = cmd.args.safeParse(resolved)
  if (!parsed.success)
    return `invalid args for ${command}: ${parsed.error.issues.map((i) => i.message).join('; ')}`
  const out = await cmd.run(client, parsed.data as Record<string, unknown>)
  return args.json ? JSON.stringify({ command, ok: true }) + '\n' + out : out
}

/** Entry used by scripts/cli.ts: build a client and run, printing the result.
 *  A constrained agent's process gets PODIUM_ISSUE_RELAY (a daemon endpoint bound to its
 *  session id) — its calls ride the daemon, which applies scope. Otherwise the operator CLI
 *  talks to the local server directly. `--outside-scope` rides through to the daemon; the
 *  session id is bound in the relay URL, so there is deliberately no `--session` flag. */
export async function issueCliMain(argv: string[]): Promise<void> {
  const relay = process.env.PODIUM_ISSUE_RELAY
  const outsideScope = argv.includes('--outside-scope')
  const client = relay
    ? makeRelayIssueClient(relay, { outsideScope })
    : makeIssueClient(`http://localhost:${Number(process.env.PODIUM_PORT) || 18787}`)
  try {
    console.log(await runIssueCli(argv, client))
  } catch (err) {
    console.error(`podium issue: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
