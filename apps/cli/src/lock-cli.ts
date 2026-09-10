import {
  asQueuedGrant,
  type IssueTrpc,
  LOCK_COMMANDS,
  makeRelayIssueClient,
  parseDurationSeconds,
} from '@podium/issue-client'
import { DEFAULT_MERGE_LOCK_BRANCH, MERGE_LOCK_PREFIX, mergeLockName } from '@podium/protocol'
import { localServerUrl, resolveAgentRelay, resolvePort } from '@podium/runtime/config'
import {
  declareFlags,
  type FlagDeclaration,
  flagsFromZodShape,
  kebabFlag,
  mergeFlags,
  parseFlags,
  withUnknownFlagAs,
} from './argv'
import { makeOperatorIssueClient } from './operator-client'

/**
 * `podium lock <command>` / `podium merge-lock <command>` [spec:SP-85d1] —
 * advisory named lease locks over the server's `lock.*` procs. Modeled on
 * issue-cli.ts: parse → find command → inject repoPath from cwd → zod validate
 * → run → render (incl. --json). merge-lock is a thin argv mapping onto the
 * same commands with the name `merge:<branch>`.
 *
 * Exit codes (scripts branch on these): 0 granted/ok · 3 queued (acquire
 * without --wait) · 4 --wait's explicit --timeout expired · 130 --wait was
 * interrupted · 1 any error.
 *
 * `--wait` LIFECYCLE (POD-612). A queue place only ever belongs to a process
 * that is still waiting for it:
 *  - bare `--wait` blocks until granted. There is no default deadline, because
 *    a deadline is how the old 300s cap dropped waiters halfway through an
 *    ordinary `test:heavy` run (30m TTL renewed every 10m) — the queue could
 *    not hold anyone through a single lane;
 *  - `--wait --timeout <dur>` is the bounded form, honoured exactly as asked
 *    (no silent clamp);
 *  - both endings, plus SIGINT/SIGTERM, LEAVE the queue before returning, and
 *    say which happened. The waiter row is keyed to the owning agent SESSION,
 *    not to this process, so the server's dead-waiter pruning does NOT cover
 *    an interrupted CLI: the session outlives it and `advanceQueue` would hand
 *    the lease to a command that is no longer running. Only an uncatchable
 *    death (SIGKILL, power loss) can still strand a row, and that one is
 *    cleaned up when the session itself exits (`releaseForSession`).
 * The old failure was dropping the place silently; the rule now is that
 * whoever stops waiting says so, to the server and to the caller.
 *
 * A grant that lands on a queue place is reported as an acquisition, not as
 * the same-session renew the server necessarily sees (asQueuedGrant, POD-675):
 * `alreadyHeld` is a re-entry signal for callers, and a waiter that queued for
 * a lock did not already hold it.
 */

/** Exit code for "acquire returned queued" (distinct from errors). */
export const EXIT_QUEUED = 3
/** Exit code for "an explicit --timeout expired before the grant" (the waiter
 *  has left the queue by then). */
export const EXIT_WAIT_TIMEOUT = 4
/** Exit code for "--wait was interrupted" — the conventional 128+SIGINT, and
 *  like the timeout it means the queue place was handed back. */
export const EXIT_INTERRUPTED = 130

/**
 * Poll cadence: snappy for the first rounds (a merge lock usually frees in
 * seconds), then backing off so an hour-long wait costs the server a handful of
 * acquires per minute rather than 20. The poll doubles as the queue's pump —
 * every acquire sweeps expired leases server-side, so an unbounded wait still
 * advances when a holder dies without releasing.
 */
const WAIT_POLL_MS = 3000
const WAIT_POLL_MAX_MS = 15_000
/** How often an otherwise-unchanged wait re-states itself, so a block that
 *  lasts an hour never looks like a hang. */
const WAIT_HEARTBEAT_MS = 60_000

/** A CLI failure that prints as `podium lock: <message>` and exits 1. */
export class LockCliError extends Error {}

/**
 * `sleep` that wakes early on abort, so an interrupt is acted on in
 * milliseconds rather than after the current poll interval.
 *
 * Both aborted-checks are load-bearing, because an AbortSignal does NOT replay
 * its `abort` event to a listener registered after the fact: a signal already
 * aborted when we subscribe would leave us sleeping the full interval for
 * nothing. The first check covers the caller handing us a spent signal, the
 * second covers registration itself.
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    if (signal?.aborted === true) done()
  })
}

/**
 * Flags the dispatcher itself owns, valid on every lock command and stripped
 * before the (strict) per-command schema sees the args — the same split
 * issue-cli draws.
 */
const LOCK_GLOBAL_FLAGS = declareFlags({ known: [], booleans: ['json', 'help', 'outsideScope'] })

/** What `command` accepts: its zod shape plus the globals above (POD-3836). */
function lockFlags(command: string | undefined): FlagDeclaration {
  const cmd = LOCK_COMMANDS.find((c) => c.name === command)
  return cmd
    ? mergeFlags(flagsFromZodShape(cmd.args), LOCK_GLOBAL_FLAGS)
    : // No such command: the caller is about to be told so by name, and
      // refusing its flags first would bury that in a less useful error.
      declareFlags({ known: [], open: true })
}

/** The verb, without parsing flags — safe on argv that will not parse. */
function lockCommandOf(argv: readonly string[]): string | undefined {
  const first = argv[0]
  return first != null && !first.startsWith('-') ? first : undefined
}

/** `1800` → `30m`, `9999` → `2h46m39s` — how timeouts are spelled to callers. */
export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${s ? `${s}s` : ''}`
}

/**
 * `--timeout` → seconds, or null for "no deadline" when it is absent. Same
 * spellings as `--ttl` (`30m`, `2h`, bare seconds), and every value is honoured
 * as asked — the old `Math.min(…, 540)` silently turned a caller's
 * `--timeout 9999` into 540s (POD-612), which is worse than any cap.
 */
export function resolveWaitTimeoutSeconds(raw: unknown): number | null {
  if (raw == null) return null
  try {
    return parseDurationSeconds(String(raw), '--timeout')
  } catch (err) {
    throw new LockCliError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Pure argv → { command, args, positionals }, refusing any flag the command does
 * not declare (POD-3836). The declaration is derived from the command's own zod
 * shape, so `--ttlx` cannot be mistaken for `--ttl` and `--branch` — merge-lock's
 * spelling — is refused on a plain `lock status` instead of being dropped on the
 * way to "list every lock in the repo".
 */
export function parseLockArgs(
  argv: string[],
  group: 'lock' | 'merge-lock' = 'lock',
): {
  command?: string
  args: Record<string, unknown>
  positionals: string[]
} {
  const [command, ...rest] = argv
  const { args, positionals } = withUnknownFlagAs(
    (m) => new LockCliError(m),
    () =>
      parseFlags(rest, lockFlags(command), {
        usage: `podium ${group}${command ? ` ${command}` : ''}`,
      }),
  )
  return { ...(command ? { command } : {}), args, positionals }
}

function helpText(group: 'lock' | 'merge-lock'): string {
  const w = Math.max(...LOCK_COMMANDS.map((c) => c.name.length))
  const extra =
    group === 'merge-lock'
      ? [
          '',
          'Operates on the lock name `merge:<branch>`. Name the branch positionally',
          '(`merge-lock acquire dev/mw`) or with --branch; the default is main.',
        ]
      : []
  return [
    `podium ${group} <command> [--flags]`,
    '',
    ...LOCK_COMMANDS.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`),
    ...extra,
  ].join('\n')
}

/**
 * Map `podium merge-lock <verb> [<branch>] [--branch main] …` onto the plain
 * lock argv: the same verb with the positional name `merge:<branch>` (default
 * `main`). Thin CLI-side sugar — there is no separate server surface.
 *
 * THE BRANCH SLOT (POD-3832). Both spellings name the branch. The positional
 * used to fall through to `passthrough`, which put it AFTER the injected name:
 * every lock verb declares exactly one positional (`name`), so the mapping took
 * the injected `merge:main` and dropped the branch on the floor. `merge-lock
 * acquire dev/mw` then held the mutex for main — the wrong lease, silently,
 * which is the one failure mode a mutex may never have.
 *
 * So a token no flag consumed is the branch, and the flag/value split has to be
 * exact (`--note stuck` must not offer `stuck` as a branch) — it mirrors
 * parseLockArgs, which is what will read this argv back. Two branches that do
 * not name the same lease are refused rather than resolved by precedence: with
 * a mutex, guessing which one the caller meant is how you serialise against
 * nobody.
 */
export function mergeLockArgv(argv: string[]): string[] {
  const [verb, ...rest] = argv
  if (!verb || verb === 'help') return argv
  // An unknown verb is passed through untouched: `runLockCli` names it, and
  // refusing its flags first would bury the more useful error.
  if (!LOCK_COMMANDS.some((c) => c.name === verb)) return argv
  // `--branch` is merge-lock's own flag — it names the branch rather than
  // reaching the lock command — so it is declared HERE and nowhere else. On a
  // plain `podium lock` it stays unknown, which is the POD-3836 report's first
  // case.
  const { args, positionals, occurrences } = withUnknownFlagAs(
    (m) => new LockCliError(m),
    () =>
      parseFlags(rest, mergeFlags(lockFlags(verb), declareFlags({ known: ['branch'] })), {
        usage: `podium merge-lock ${verb}`,
      }),
  )
  const branchArg = args.branch
  if (branchArg === true) throw new LockCliError('--branch needs a value')
  const flagBranch = typeof branchArg === 'string' && branchArg !== '' ? branchArg : null
  if (branchArg === '') throw new LockCliError('--branch needs a value')
  const [positionalBranch = null, extraBranch] = positionals
  if (extraBranch != null) {
    throw new LockCliError(
      `merge-lock takes one branch, but got '${positionalBranch}' and '${extraBranch}' — ` +
        'the lock name is supplied for you.',
    )
  }
  // Every flag but `--branch` rides through to the lock command. A value goes in
  // the INLINE `--flag=value` form, which round-trips whatever it holds: the
  // two-token spelling loses a value that itself begins with `--`, because the
  // parser reading it back would take that for the next flag and leave the one
  // before it looking like a boolean. `podium merge-lock steal --note "--urgent"`
  // then stole the lease with no note at all.
  const passthrough = occurrences
    .filter((o) => o.key !== 'branch')
    .map((o) =>
      o.value === true ? `--${kebabFlag(o.key)}` : `--${kebabFlag(o.key)}=${String(o.value)}`,
    )
  for (const [flag, raw] of [
    ['', positionalBranch],
    ['--branch ', flagBranch],
  ] as const) {
    // `merge-lock acquire merge:dev/mw` reads as right and would build
    // `merge:merge:dev/mw`, a second lease that serialises against nothing —
    // the POD-672 failure, reachable again the moment the branch slot works.
    if (raw?.trim().toLowerCase().startsWith(MERGE_LOCK_PREFIX) === true) {
      const branch = raw.trim().slice(MERGE_LOCK_PREFIX.length)
      throw new LockCliError(
        `merge-lock's branch slot takes a branch, not a lock name: ${flag}'${raw}' would key ` +
          `the mutex '${mergeLockName(raw)}'. Use \`podium merge-lock ${verb} ${branch}\`.`,
      )
    }
  }
  if (positionalBranch != null && flagBranch != null) {
    const fromPositional = mergeLockName(positionalBranch)
    const fromFlag = mergeLockName(flagBranch)
    if (fromPositional !== fromFlag) {
      throw new LockCliError(
        `merge-lock got two different branches: '${positionalBranch}' (${fromPositional}) and ` +
          `--branch '${flagBranch}' (${fromFlag}) — pass one.`,
      )
    }
  }
  // Through the shared builder, so `--branch refs/heads/main` and `--branch main`
  // reach the SAME lease rather than two independent ones (POD-672).
  return [
    verb,
    mergeLockName(positionalBranch ?? flagBranch ?? DEFAULT_MERGE_LOCK_BRANCH),
    ...passthrough,
  ]
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
 * Hand the queue place back when the wait stops (deadline or interrupt).
 * `cancel` refuses a HOLDER, so a failed cancel is ambiguous — the grant may
 * have landed in the gap since the last poll. One more acquire settles which
 * it was, rather than dropping a lock the caller now owns (and would then
 * never release).
 */
async function leaveQueue(
  cmd: (typeof LOCK_COMMANDS)[number],
  client: IssueTrpc,
  validated: Record<string, unknown>,
  name: string,
): Promise<{ cancelled: boolean; granted: boolean; text?: string; data?: unknown }> {
  try {
    await client.lock.cancel.mutate({ repoPath: validated.repoPath as string, name })
    return { cancelled: true, granted: false }
  } catch {}
  try {
    // Only ever reached from inside the wait loop, i.e. after a queued round —
    // so a grant here is this waiter's own queue place landing, not a
    // pre-existing hold of the same session (asQueuedGrant).
    const settle = asQueuedGrant(await runCommandOnce(cmd, client, validated))
    if ((settle.data as { granted?: boolean } | undefined)?.granted === true) {
      return { cancelled: false, granted: true, text: settle.text, data: settle.data }
    }
  } catch {}
  return { cancelled: false, granted: false }
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
    /** Per-round wait narration (stderr in the real CLI, so --json stdout stays
     *  machine-readable). A silent wait is how a lost place goes unnoticed. */
    onProgress?: (line: string) => void
    /**
     * Aborts the `--wait` loop and makes it leave the queue before returning.
     * `cliMain` binds this to SIGINT/SIGTERM; tests drive it directly. It is
     * the whole interrupt lifecycle, so nothing here has to touch `process`.
     */
    signal?: AbortSignal
  },
): Promise<LockCliOutcome> {
  const group = opts?.group ?? 'lock'
  const { command, args, positionals } = parseLockArgs(argv, group)
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
  // The dispatcher's own flags never reach the (strict) command schema.
  const { json: _json, help: _help, outsideScope: _outsideScope, ...forSchema } = args
  const parsed = cmd.args.safeParse(forSchema)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'args'}: ${i.message}`)
      .join('; ')
    throw new LockCliError(`invalid args for ${command}: ${details}`)
  }
  const validated = parsed.data as Record<string, unknown>

  // acquire --wait: CLI-side poll loop — re-run acquire (idempotent while
  // queued: it reports the caller's existing position) until granted, until an
  // explicit --timeout expires, or until the caller is interrupted. The queue
  // place is only ever held by a process still inside this loop: bare --wait
  // never abandons it, and BOTH exits (deadline, signal) leave the queue before
  // returning. That cleanup is not optional — the waiter row is keyed to the
  // owning agent session, which outlives this process, so a killed CLI would
  // otherwise be handed a lease it is no longer around to use.
  if (command === 'acquire' && validated.wait === true) {
    const timeoutS = resolveWaitTimeoutSeconds(validated.timeout)
    const name = validated.name as string
    const signal = opts?.signal
    const interrupted = (): boolean => signal?.aborted === true
    const now = opts?.now ?? Date.now
    const sleep = opts?.sleep ?? ((ms: number) => sleepUnlessAborted(ms, signal))
    const progress = opts?.onProgress ?? (() => {})
    const baseInterval = opts?.pollIntervalMs ?? WAIT_POLL_MS
    // An explicit poll interval is a floor, not something the backoff undercuts.
    const maxInterval = Math.max(WAIT_POLL_MAX_MS, baseInterval)
    const started = now()
    const deadline = timeoutS != null ? started + timeoutS * 1000 : null

    /**
     * Stop waiting, from either end: hand the queue place back, then report
     * which of the two happened. A grant that landed in the gap wins over both
     * — the caller holds the lock, so saying "timed out" (or silently
     * abandoning it on Ctrl-C) would strand a lease nobody releases.
     */
    const giveUp = async (
      reason: 'timeout' | 'interrupt',
      res: { text: string; data?: unknown },
    ): Promise<LockCliOutcome> => {
      const left = await leaveQueue(cmd, client, validated, name)
      if (left.granted) {
        return {
          text:
            reason === 'interrupt'
              ? `${left.text ?? res.text}\ngranted as the wait was interrupted — release it with \`podium lock release ${name}\` if you no longer want it`
              : (left.text ?? res.text),
          exitCode: 0,
          data: left.data,
        }
      }
      const head =
        reason === 'timeout' && deadline != null
          ? `timed out after ${fmtDuration(Math.round((deadline - started) / 1000))} waiting for '${name}'`
          : `interrupted after ${fmtDuration(Math.round((now() - started) / 1000))} waiting for '${name}'`
      return {
        text: [
          `${head}; ${
            left.cancelled
              ? 'left the queue — nothing will be granted to you now'
              : `could NOT leave the queue — run \`podium lock cancel ${name}\` so a later grant does not strand the lock`
          }`,
          res.text,
        ].join('\n'),
        exitCode: reason === 'timeout' ? EXIT_WAIT_TIMEOUT : EXIT_INTERRUPTED,
        data: res.data,
      }
    }

    let interval = baseInterval
    let opened = false
    let wasQueued = false
    let lastPosition: number | null = null
    let narratedAt = started
    for (;;) {
      // Once a round has come back queued, the lock is held by someone else, so
      // any later grant is this waiter's queue place being advanced onto —
      // never a hold the caller already had. The server reports that as a
      // same-session renew; asQueuedGrant restores the caller's view of it.
      const raw = await runCommandOnce(cmd, client, validated)
      const res = wasQueued ? asQueuedGrant(raw) : raw
      const data = res.data as { granted?: boolean; position?: number } | undefined
      if (data?.granted === true) return { text: res.text, exitCode: 0, data: res.data }
      wasQueued = true
      const position = typeof data?.position === 'number' ? data.position : null
      const waited = (): string => fmtDuration(Math.round((now() - started) / 1000))
      if (!opened) {
        const bound =
          timeoutS != null ? `waiting up to ${fmtDuration(timeoutS)}` : 'waiting until granted'
        progress(`${bound} — ${res.text}`)
        opened = true
        narratedAt = now()
      } else if (position != null && position !== lastPosition) {
        progress(`'${name}': now position ${position} (was ${lastPosition})`)
        narratedAt = now()
      } else if (now() - narratedAt >= WAIT_HEARTBEAT_MS) {
        progress(
          position != null
            ? `'${name}': still queued at position ${position} after ${waited()}`
            : `'${name}': still waiting after ${waited()}`,
        )
        narratedAt = now()
      }
      lastPosition = position

      // Both ways of stopping give the place back the same way. Only ever
      // reached with a NOT-granted round in hand: a grant returns above, and
      // leaveQueue's settle covers a grant landing in the gap.
      if (interrupted()) return giveUp('interrupt', res)
      if (deadline != null && now() >= deadline) return giveUp('timeout', res)

      // Never sleep past the deadline — "timed out after 10m" should be true.
      const nap = deadline != null ? Math.min(interval, deadline - now()) : interval
      await sleep(Math.max(0, nap))
      // An interrupt lands mid-sleep; notice it here rather than after another
      // full acquire round.
      if (interrupted()) return giveUp('interrupt', res)
      interval = Math.min(Math.ceil(interval * 1.5), maxInterval)
    }
  }

  const res = await runCommandOnce(cmd, client, validated)
  const queued =
    command === 'acquire' && (res.data as { granted?: boolean } | undefined)?.granted === false
  return { text: res.text, exitCode: queued ? EXIT_QUEUED : 0, data: res.data }
}

function buildClient(argv: string[]): IssueTrpc {
  const relay = resolveAgentRelay()
  const outsideScope = argv.includes('--outside-scope')
  return relay
    ? makeRelayIssueClient(relay, { outsideScope })
    : makeOperatorIssueClient(localServerUrl(resolvePort()))
}

/**
 * Catch SIGINT/SIGTERM for a blocking `--wait` ONLY, so the loop can leave the
 * queue on the way out. Every other command is fast and keeps the default
 * signal behaviour — swallowing Ctrl-C on `status` would be an unkindness. A
 * second signal is the escape hatch: it exits at once, stranding the waiter
 * row (nothing else can be done once the caller insists).
 */
function waitAbortSignal(
  mapped: string[],
): { signal: AbortSignal; dispose: () => void } | undefined {
  if (lockCommandOf(mapped) !== 'acquire' || !mapped.includes('--wait')) return undefined
  const controller = new AbortController()
  const onSignal = (): void => {
    if (controller.signal.aborted) process.exit(EXIT_INTERRUPTED)
    controller.abort()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    },
  }
}

async function cliMain(argv: string[], group: 'lock' | 'merge-lock'): Promise<void> {
  let mapped = argv
  let interrupts: ReturnType<typeof waitAbortSignal>
  try {
    mapped = group === 'merge-lock' ? mergeLockArgv(argv) : argv
    interrupts = waitAbortSignal(mapped)
    const outcome = await runLockCli(mapped, buildClient(argv), {
      group,
      // stderr: a --wait that blocks for half an hour must not look hung, and
      // --json's stdout payload stays a single parseable object.
      onProgress: (line) => console.error(`podium ${group}: ${line}`),
      ...(interrupts ? { signal: interrupts.signal } : {}),
    })
    if (argv.includes('--json')) {
      const command = lockCommandOf(mapped)
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
      const command = lockCommandOf(mapped)
      console.log(JSON.stringify({ ...(command ? { command } : {}), ok: false, error: msg }))
    } else {
      console.error(`podium ${group}: ${msg}`)
    }
    process.exitCode = 1
  } finally {
    interrupts?.dispose()
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
