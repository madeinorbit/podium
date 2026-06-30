import { type IssueTrpc, makeIssueClient } from '../apps/server/src/issue-client'
import { ISSUE_COMMANDS } from '../apps/server/src/issue-commands'

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
      args[t.slice(2, eq)] = t.slice(eq + 1)
    } else {
      const key = t.slice(2)
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

/** Resolve + run one issue command against the given client; returns the text to print. */
export async function runIssueCli(argv: string[], client: IssueTrpc): Promise<string> {
  const { command, args } = parseIssueArgs(argv)
  if (!command || command === 'help') return helpText()
  const cmd = ISSUE_COMMANDS.find((c) => c.name === command)
  if (!cmd) return `unknown command: ${command}\n\n${helpText()}`
  const parsed = cmd.args.safeParse(args)
  if (!parsed.success)
    return `invalid args for ${command}: ${parsed.error.issues.map((i) => i.message).join('; ')}`
  const out = await cmd.run(client, parsed.data as Record<string, unknown>)
  return args.json ? JSON.stringify({ command, ok: true }) + '\n' + out : out
}

/** Entry used by scripts/cli.ts: build a loopback client and run, printing the result. */
export async function issueCliMain(argv: string[]): Promise<void> {
  const port = Number(process.env.PODIUM_PORT) || 18787
  const client = makeIssueClient(`http://localhost:${port}`)
  try {
    console.log(await runIssueCli(argv, client))
  } catch (err) {
    console.error(`podium issue: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
