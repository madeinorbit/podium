import { resolve } from 'node:path'
import { resolveIssueRelay } from '@podium/runtime/config'

/**
 * `podium worktree [path]` — tell Podium which worktree this agent session is
 * working in. Rides the daemon's issue-relay loopback (PODIUM_ISSUE_RELAY, bound
 * to the session at spawn), where the daemon resolves the path to its git
 * toplevel and restamps the session's worktree grouping. Complements the
 * automatic hook-cwd detection: an agent whose harness doesn't report cwd (or
 * that wants to declare a worktree it hasn't cd'd into) can report explicitly.
 */
export async function runWorktreeCli(
  argv: string[],
  opts: { relayEndpoint?: string | undefined; cwd: string; fetchImpl?: typeof fetch },
): Promise<{ text: string; exitCode: number }> {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    return {
      text: [
        'Usage: podium worktree [path]',
        '',
        '  Tell Podium which git worktree this agent session is working in',
        '  (defaults to the current directory; resolved to its git toplevel).',
        '  Only works inside a Podium-managed agent session (PODIUM_ISSUE_RELAY).',
      ].join('\n'),
      exitCode: 0,
    }
  }
  // Unknown flags are an error, never silently dropped (#345) — a stray flag must
  // not fall through to "set worktree to cwd".
  const unknown = argv.filter((a) => a.startsWith('--'))
  if (unknown.length) {
    return { text: `podium worktree: unknown flag ${unknown[0]} (see --help)`, exitCode: 1 }
  }
  if (!opts.relayEndpoint) {
    return {
      text: 'podium worktree: PODIUM_ISSUE_RELAY is not set — this command only works inside a Podium-managed agent session.',
      exitCode: 1,
    }
  }
  const path = resolve(opts.cwd, argv.find((a) => !a.startsWith('--')) ?? '.')
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(opts.relayEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ router: 'session', proc: 'setWorktree', input: { path } }),
    })
    if (!res.ok) return { text: `podium worktree: relay HTTP ${res.status}`, exitCode: 1 }
    const body = (await res.json()) as {
      ok: boolean
      result?: { worktree?: string }
      error?: string
    }
    if (!body.ok) return { text: `podium worktree: ${body.error ?? 'relay failed'}`, exitCode: 1 }
    return { text: `session worktree set to ${body.result?.worktree ?? path}`, exitCode: 0 }
  } catch (err) {
    return {
      text: `podium worktree: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
    }
  }
}

/** Entry used by scripts/cli.ts. */
export async function worktreeCliMain(argv: string[]): Promise<void> {
  const out = await runWorktreeCli(argv, {
    relayEndpoint: resolveIssueRelay(),
    cwd: process.cwd(),
  })
  ;(out.exitCode === 0 ? console.log : console.error)(out.text)
  if (out.exitCode !== 0) process.exitCode = out.exitCode
}
