import { describe, expect, it } from 'vitest'
import { convergeViaGit, GIT_PHASES, type GitPhase } from './update-delivery-git'

/**
 * GIT DELIVERY'S HEARTBEAT (POD-2101). A checkout has no byte count to divide,
 * so what proves it is moving is reaching a later step — and a source machine
 * that goes eight minutes without one is a machine to worry about.
 */

/** A runner that answers each git invocation from a script of exit statuses. */
function runner(script: Record<string, { status: number; stdout?: string }>) {
  return {
    run: async (_cmd: string, args: string[]) => {
      const verb = args.find((arg) => script[arg] !== undefined) ?? ''
      const answer = script[verb] ?? { status: 0 }
      return { status: answer.status, stdout: answer.stdout ?? '' }
    },
  }
}

const clean = { status: 0, stdout: '' }

describe('convergeViaGit phases', () => {
  it('names each step as it reaches it, in order', async () => {
    const phases: GitPhase[] = []
    const result = await convergeViaGit(
      { repo: '/repo', sha: 'abc123' },
      {
        ...runner({
          status: clean,
          'rev-parse': { status: 0, stdout: 'deadbeef\n' },
          fetch: clean,
          checkout: clean,
        }),
        onPhase: (phase) => phases.push(phase),
      },
    )

    expect(result).toEqual({ ok: true })
    expect(phases).toEqual([...GIT_PHASES])
  })

  it('stops naming steps it never reached', async () => {
    // A dirty checkout is refused before anything is fetched, so claiming a
    // fetch phase would be reporting work that did not happen.
    const phases: GitPhase[] = []
    const result = await convergeViaGit(
      { repo: '/repo', sha: 'abc123' },
      {
        ...runner({ status: { status: 0, stdout: ' M src/index.ts\n' } }),
        onPhase: (phase) => phases.push(phase),
      },
    )

    expect(result).toEqual({ ok: false, reason: 'dirty-working-tree' })
    expect(phases).toEqual(['git-status'])
  })

  it('converges with no reporter attached, exactly as before', async () => {
    const result = await convergeViaGit(
      { repo: '/repo', sha: 'abc123' },
      runner({
        status: clean,
        'rev-parse': { status: 0, stdout: 'abc123\n' },
      }),
    )
    // Already on the SHA: nothing to fetch, nothing to check out.
    expect(result).toEqual({ ok: true })
  })
})
