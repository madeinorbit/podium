import {
  type IssueTrpc,
  makeIssueClient,
  makeRelayIssueClient,
} from '../apps/server/src/issue-client'
import { ISSUE_COMMANDS } from '../apps/server/src/issue-commands'

/** Kebab-case flag → camelCase key, so `--outside-scope` becomes `outsideScope`. */
const camelFlag = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** Flags that never take a value; a following bare token is a positional, not their value. */
const BOOL_FLAGS = new Set(['json', 'start', 'outsideScope'])

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

/** Resolve + run one issue command; returns the text to print. Failures (unknown
 *  command, invalid args, server errors) THROW — the caller maps them to a non-zero
 *  exit. `--json` renders `{command, ok, data, text}` on one line instead of text. */
export async function runIssueCli(
  argv: string[],
  client: IssueTrpc,
  opts?: { defaultAuthor?: string },
): Promise<string> {
  const { command, args, positionals } = parseIssueArgs(argv)
  if (!command || command === 'help') return helpText()
  const cmd = ISSUE_COMMANDS.find((c) => c.name === command)
  if (!cmd) throw new IssueCliError(`unknown command: ${command}\n\n${helpText()}`)
  // Positionals map onto the command's declared keys (flags win on conflict),
  // so `podium issue start 10` ≡ `podium issue start --id 10`.
  for (let i = 0; i < (cmd.positionals?.length ?? 0); i++) {
    const key = cmd.positionals![i]!
    if (args[key] == null && positionals[i] != null) args[key] = positionals[i]
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
  const parsed = cmd.args.safeParse(resolved)
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

/** Entry used by scripts/cli.ts: build a client and run, printing the result.
 *  A constrained agent's process gets PODIUM_ISSUE_RELAY (a daemon endpoint bound to its
 *  session id) — its calls ride the daemon, which applies scope. Otherwise the operator CLI
 *  talks to the local server directly. `--outside-scope` rides through to the daemon; the
 *  session id is bound in the relay URL, so there is deliberately no `--session` flag.
 *  Any failure exits 1; with `--json` the error is a JSON object on stdout. */
export async function issueCliMain(argv: string[]): Promise<void> {
  const relay = process.env.PODIUM_ISSUE_RELAY
  const outsideScope = argv.includes('--outside-scope')
  const client = relay
    ? makeRelayIssueClient(relay, { outsideScope })
    : makeIssueClient(`http://localhost:${Number(process.env.PODIUM_PORT) || 18787}`)
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
