import { resolveAgentRelay } from '@podium/runtime/config'

/**
 * `podium workspace fetch <issue|session>` — materialize another agent's
 * CURRENT working state (unpushed commits + dirty + untracked files) as a
 * read-only peek worktree on THIS machine [spec:SP-6d57]. Fully lazy: the source
 * exports on demand and nothing is published or persisted; the source session
 * is never touched. `podium workspace clean` removes every peek this repo has.
 */

const HELP = [
  'Usage: podium workspace <command>',
  '',
  '  fetch <issue|session>   Materialize that agent’s current working state',
  '                          (unpushed commits + dirty + untracked files) as a',
  '                          detached read-only peek worktree on this machine.',
  '                          Point-in-time pinning is not provided: you always',
  '                          fetch the state as of now.',
  '  clean                   Remove every peek worktree fetch created in this repo.',
  '',
  '  Only works inside a Podium-managed agent session (PODIUM_AGENT_RELAY).',
].join('\n')

type FetchResult = {
  path: string
  sameMachine: boolean
  sourceMachine: string
  branch: string
  headSha: string
  dirty: boolean
}

async function relay(
  endpoint: string,
  proc: string,
  input: Record<string, unknown>,
  doFetch: typeof fetch,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const res = await doFetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ router: 'workspace', proc, input }),
  })
  if (!res.ok) return { ok: false, error: `relay HTTP ${res.status}` }
  return (await res.json()) as { ok: boolean; result?: unknown; error?: string }
}

export async function runWorkspaceCli(
  argv: string[],
  opts: { relayEndpoint?: string | undefined; fetchImpl?: typeof fetch },
): Promise<{ text: string; exitCode: number }> {
  const [command, ...rest] = argv
  if (!command || command === 'help' || argv.includes('--help') || argv.includes('-h')) {
    return { text: HELP, exitCode: command || argv.length ? 0 : 1 }
  }
  if (command !== 'fetch' && command !== 'clean') {
    return { text: `podium workspace: unknown command ${command} (see --help)`, exitCode: 1 }
  }
  if (!opts.relayEndpoint) {
    return {
      text: 'podium workspace: PODIUM_AGENT_RELAY is not set — this command only works inside a Podium-managed agent session.',
      exitCode: 1,
    }
  }
  const doFetch = opts.fetchImpl ?? fetch
  try {
    if (command === 'clean') {
      const body = await relay(opts.relayEndpoint, 'clean', {}, doFetch)
      if (!body.ok) return { text: `podium workspace: ${body.error ?? 'clean failed'}`, exitCode: 1 }
      const removed = (body.result as { removed?: string[] } | undefined)?.removed ?? []
      return {
        text: removed.length
          ? `removed ${removed.length} peek worktree${removed.length === 1 ? '' : 's'}:\n${removed.join('\n')}`
          : 'no peek worktrees to remove',
        exitCode: 0,
      }
    }
    const ref = rest.find((a) => !a.startsWith('--'))
    if (!ref) return { text: 'podium workspace fetch: an issue or session ref is required', exitCode: 1 }
    const body = await relay(opts.relayEndpoint, 'fetch', { ref }, doFetch)
    if (!body.ok) return { text: `podium workspace: ${body.error ?? 'fetch failed'}`, exitCode: 1 }
    const r = body.result as FetchResult
    if (r.sameMachine) {
      return {
        text: `that agent runs on THIS machine (${r.sourceMachine}) — its worktree is directly readable at:\n${r.path}`,
        exitCode: 0,
      }
    }
    return {
      text: [
        `fetched workspace from ${r.sourceMachine} (branch ${r.branch || '(detached)'}, head ${r.headSha.slice(0, 12)}${r.dirty ? ', includes uncommitted changes' : ', clean tree'})`,
        r.path,
        '',
        'This is a READ-ONLY point-in-time copy (detached worktree) — inspect it, do not edit it.',
        'Remove all peeks when done: podium workspace clean',
      ].join('\n'),
      exitCode: 0,
    }
  } catch (err) {
    return {
      text: `podium workspace: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
    }
  }
}

/** Entry used by scripts/cli.ts. */
export async function workspaceCliMain(argv: string[]): Promise<void> {
  const out = await runWorkspaceCli(argv, { relayEndpoint: resolveAgentRelay() })
  ;(out.exitCode === 0 ? console.log : console.error)(out.text)
  if (out.exitCode !== 0) process.exitCode = out.exitCode
}
