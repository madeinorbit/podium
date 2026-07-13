import {
  type IssueTrpc,
  LOCK_COMMANDS,
  makeIssueClient,
  makeRelayIssueClient,
} from '@podium/issue-client'
import { resolveIssueRelay, resolvePort } from '@podium/runtime/config'

/**
 * `podium lock <command>` / `podium merge-lock <command>` [spec:SP-85d1] —
 * advisory named lease locks over the server's `lock.*` procs. Modeled on
 * issue-cli.ts: parse → find command → inject repoPath from cwd → zod validate
 * → run → render (incl. --json). merge-lock is a thin argv mapping onto the
 * same commands with the name `merge:<branch>`.
 *
 * Exit codes (scripts branch on these): 0 granted/ok · 3 queued (acquire
 * without --wait) · 4 --wait timed out · 1 any error.
 */

/** Exit code for "acquire returned queued" (distinct from errors). */
export const EXIT_QUEUED = 3
/** Exit code for "--wait timed out without a grant". */
export const EXIT_WAIT_TIMEOUT = 4

const WAIT_POLL_MS = 3000
const WAIT_DEFAULT_TIMEOUT_S = 300
const WAIT_MAX_TIMEOUT_S = 540

/** A CLI failure that prints as `podium lock: <message>` and exits 1. */
export class LockCliError extends Error {}

/** Kebab-case flag → camelCase key. */
const camelFlag = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** Flags that never take a value. */
const BOOL_FLAGS = new Set(['json', 'wait', 'outsideScope'])

/** Pure argv → { command, args, positionals } (issue-cli parser, lock bool set). */
export function parseLockArgs(argv: string[]): {
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

function helpText(group: 'lock' | 'merge-lock'): string {
  const w = Math.max(...LOCK_COMMANDS.map((c) => c.name.length))
  const extra =
    group === 'merge-lock'
      ? ['', 'Operates on the lock name `merge:<branch>` (--branch, default main).']
      : []
  return [
    `podium ${group} <command> [--flags]`,
    '',
    ...LOCK_COMMANDS.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`),
    ...extra,
  ].join('\n')
}

/**
 * Map `podium merge-lock <verb> [--branch main] …` onto the plain lock argv:
 * the same verb with the positional name `merge:<branch>` (default `main`).
 * Thin CLI-side sugar — there is no separate server surface.
 */
export function mergeLockArgv(argv: string[]): string[] {
  const [verb, ...rest] = argv
  if (!verb || verb === 'help') return argv
  let branch = 'main'
  const passthrough: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (t == null) continue
    if (t === '--branch') {
      const next = rest[i + 1]
      if (next == null || next.startsWith('--')) throw new LockCliError('--branch needs a value')
      branch = next
      i++
      continue
    }
    if (t.startsWith('--branch=')) {
      branch = t.slice('--branch='.length)
      if (!branch) throw new LockCliError('--branch needs a value')
      continue
    }
    passthrough.push(t)
  }
  return [verb, `merge:${branch}`, ...passthrough]
}

export interface LockCliOutcome {
  text: string
  exitCode: number
  data?: unknown
}

/** Run one acquire round against the server; granted is read off the wire. */
async function runCommandOnce(
  command: (typeof LOCK_COMMANDS)[number],
  client: IssueTrpc,
  args: Record<string, unknown>,
): Promise<{ text: string; data?: unknown }> {
  return command.run(client, args)
}

/**
 * Resolve + run one lock command. `opts.pollIntervalMs`/`opts.sleep` exist for
 * tests (the --wait loop). Failures throw; the caller maps them to exit 1.
 */
export async function runLockCli(
  argv: string[],
  client: IssueTrpc,
  opts?: {
    group?: 'lock' | 'merge-lock'
    pollIntervalMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  },
): Promise<LockCliOutcome> {
  const group = opts?.group ?? 'lock'
  const { command, args, positionals } = parseLockArgs(argv)
  if (!command || command === 'help') return { text: helpText(group), exitCode: 0 }
  const cmd = LOCK_COMMANDS.find((c) => c.name === command)
  if (!cmd) throw new LockCliError(`unknown command: ${command}\n\n${helpText(group)}`)
  for (let i = 0; i < (cmd.positionals?.length ?? 0); i++) {
    const key = cmd.positionals?.[i]
    if (key != null && args[key] == null && positionals[i] != null) args[key] = positionals[i]
  }
  // Fill in --repoPath from the cwd when omitted (same best-effort inference as
  // issue-cli: a mock client without `repos` just leaves args unchanged).
  if (args.repoPath == null) {
    try {
      const r = (await client.repos.inferFromPath.query({ path: process.cwd() })) as {
        repoPath: string | null
      }
      if (r.repoPath) args.repoPath = r.repoPath
    } catch {}
  }
  const parsed = cmd.args.safeParse(args)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'args'}: ${i.message}`)
      .join('; ')
    throw new LockCliError(`invalid args for ${command}: ${details}`)
  }
  const validated = parsed.data as Record<string, unknown>

  // acquire --wait: CLI-side poll loop — re-run acquire every ~3s until granted
  // or the timeout (default 300s, capped at 540s) elapses.
  if (command === 'acquire' && validated.wait === true) {
    const timeoutS = Math.min(
      validated.timeout != null ? Number(validated.timeout) : WAIT_DEFAULT_TIMEOUT_S,
      WAIT_MAX_TIMEOUT_S,
    )
    if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
      throw new LockCliError(`invalid --timeout '${validated.timeout}'`)
    }
    const now = opts?.now ?? Date.now
    const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const interval = opts?.pollIntervalMs ?? WAIT_POLL_MS
    const deadline = now() + timeoutS * 1000
    for (;;) {
      const res = await runCommandOnce(cmd, client, validated)
      const granted = (res.data as { granted?: boolean } | undefined)?.granted === true
      if (granted) return { text: res.text, exitCode: 0, data: res.data }
      if (now() >= deadline) {
        // Best-effort: leave the wait queue on timeout so an abandoned --wait
        // doesn't hold a queue slot until its session dies.
        try {
          await client.lock.cancel.mutate({
            repoPath: validated.repoPath as string,
            name: validated.name as string,
          })
        } catch {}
        return {
          text: `timed out after ${timeoutS}s waiting for '${validated.name}'\n${res.text}`,
          exitCode: EXIT_WAIT_TIMEOUT,
          data: res.data,
        }
      }
      await sleep(interval)
    }
  }

  const res = await runCommandOnce(cmd, client, validated)
  const queued =
    command === 'acquire' && (res.data as { granted?: boolean } | undefined)?.granted === false
  return { text: res.text, exitCode: queued ? EXIT_QUEUED : 0, data: res.data }
}

function buildClient(argv: string[]): IssueTrpc {
  const relay = resolveIssueRelay()
  const outsideScope = argv.includes('--outside-scope')
  return relay
    ? makeRelayIssueClient(relay, { outsideScope })
    : makeIssueClient(`http://localhost:${resolvePort()}`)
}

async function cliMain(argv: string[], group: 'lock' | 'merge-lock'): Promise<void> {
  let mapped = argv
  try {
    mapped = group === 'merge-lock' ? mergeLockArgv(argv) : argv
    const outcome = await runLockCli(mapped, buildClient(argv), { group })
    if (argv.includes('--json')) {
      const { command } = parseLockArgs(mapped)
      console.log(
        JSON.stringify({
          ...(command ? { command } : {}),
          ok: outcome.exitCode === 0,
          exitCode: outcome.exitCode,
          data: outcome.data ?? null,
          text: outcome.text,
        }),
      )
    } else {
      console.log(outcome.text)
    }
    if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (argv.includes('--json')) {
      const { command } = parseLockArgs(mapped)
      console.log(JSON.stringify({ ...(command ? { command } : {}), ok: false, error: msg }))
    } else {
      console.error(`podium ${group}: ${msg}`)
    }
    process.exitCode = 1
  }
}

/** Entry for `podium lock …`. */
export async function lockCliMain(argv: string[]): Promise<void> {
  await cliMain(argv, 'lock')
}

/** Entry for `podium merge-lock …` — the merge:<branch> sugar. */
export async function mergeLockCliMain(argv: string[]): Promise<void> {
  await cliMain(argv, 'merge-lock')
}
