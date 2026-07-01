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
    '',
    'Set PODIUM_ISSUE_TOKEN=<contents of <state-dir>/issue-maintainer.token> for maintainer',
    'access; otherwise you act as worker (inside an issue worktree) or reader.',
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

/** Entry used by scripts/cli.ts: build a loopback client and run, printing the result. */
export async function issueCliMain(argv: string[]): Promise<void> {
  const port = Number(process.env.PODIUM_PORT) || 18787
  // Present the operator's issue-tracker credentials so the server gate admits us. Maintainer
  // access requires the EXPLICIT PODIUM_ISSUE_TOKEN env var — we deliberately do NOT auto-read
  // the 0600 maintainer-token file. Agents run as the operator's uid, so they can read that
  // file; auto-reading it would silently hand every CLI agent maintainer rights and defeat the
  // gate. The operator opts in by exporting PODIUM_ISSUE_TOKEN=<contents of the token file>.
  // Without it, our cwd maps us to a worker iff it's inside a live issue worktree, else reader.
  const token = process.env.PODIUM_ISSUE_TOKEN
  const client = makeIssueClient(`http://localhost:${port}`, {
    ...(token ? { token } : {}),
    cwd: process.cwd(),
  })
  try {
    console.log(await runIssueCli(argv, client))
  } catch (err) {
    console.error(`podium issue: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
