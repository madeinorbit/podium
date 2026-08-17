import {
  classifyUpdateFailureDetail,
  type MachineFailureCode,
  matchUpdateFailureToken,
  planConvergence,
  UPDATE_FAILURE_EXAMPLES,
  UPDATE_FAILURE_TOKENS,
  type UpdateFailureToken,
} from '@podium/protocol'
import { fetchArtifact } from '@podium/runtime/update-delivery'
import {
  convergeViaGit,
  GIT_ABORTED_STATUS,
  GIT_TIMED_OUT_STATUS,
  type GitRun,
} from '@podium/runtime/update-delivery-git'
import { describe, expect, it } from 'vitest'
import {
  createSchemaGate,
  MAX_CONVERGENCE_ATTEMPTS,
  refuseConvergence,
  refuseSchemaRegression,
  resolveOnBoot,
} from './convergence'
import { applyGrant, type GrantApplyDeps } from './grant-apply'

/**
 * WHAT THE SYSTEM PRODUCES, NOT WHAT ANYONE IMAGINED IT PRODUCES (POD-2241).
 *
 * The class of defect this closes is a refusal sentence read one way by
 * apps/server and another by apps/web. That is now impossible by construction —
 * there is one classifier, in `@podium/protocol`, and both consumers are
 * exhaustive over its codes. What is still possible, and what this file exists
 * to stop, is the OTHER half: a pattern that no longer matches the sentence it
 * was written for, because the producer reworded it.
 *
 * So every case below CALLS THE REAL CONSTRUCTOR and hands what came back to
 * the shared classifier. Nothing here hand-writes a refusal. POD-2238 and
 * POD-2240 were both found this way and both had passed suites full of
 * hand-written fixtures, which prove only that the classifier reads the
 * fixture.
 *
 * apps/server and apps/web cannot run this — no app may import another — so
 * they drive their coverage off `UPDATE_FAILURE_EXAMPLES`, and the last test
 * here is what keeps those examples honest.
 */

/** Details a run of `applyGrant` reported, with every effect injected. */
async function detailsFromApplyGrant(
  overrides: Partial<GrantApplyDeps> & { target: { version: string; artifacts: object } },
): Promise<string[]> {
  const details: string[] = []
  const { target, ...rest } = overrides
  await applyGrant(
    { type: 'updateGrant', grantId: 'g1', target } as never,
    {
      currentVersion: () => '0.1.3',
      caps: [],
      platform: 'linux-x86_64',
      fetchArtifact: async () => ({ git: true }),
      swap: () => {},
      writePending: () => {},
      restart: () => {},
      now: () => 0,
      ...rest,
      report: (status) => {
        if (status.detail) details.push(status.detail)
      },
    } as GrantApplyDeps,
  )
  return details
}

/** A git runner that answers each subcommand from a plan. */
const gitRunner =
  (plan: Record<string, { status: number; stdout?: string }>): GitRun =>
  async (_cmd, args) => {
    const step = args[2] ?? ''
    const answer = plan[step] ?? { status: 0, stdout: '' }
    return { status: answer.status, stdout: answer.stdout ?? '' }
  }

/** The sentence `fetchArtifact` throws for a git convergence, verbatim. */
async function gitDeliveryDetail(
  plan: Record<string, { status: number; stdout?: string }>,
): Promise<string> {
  try {
    await fetchArtifact({ repo: '/repo', sha: 'abc1234' } as never, 'git', {
      git: { run: gitRunner(plan) },
    } as never)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the git delivery to fail')
}

const CLEAN = { status: { status: 0, stdout: '' }, 'rev-parse': { status: 0, stdout: 'deadbee' } }

describe('every refusal a daemon can produce is classified by the shared table', () => {
  /**
   * POD-2210. The daemon that declines ON PURPOSE because finishing would have
   * stopped the server sharing its process. The first sentence this class of
   * defect was ever found on.
   */
  it('classifies the foreground all-in-one refusal from `refuseConvergence`', () => {
    const detail = refuseConvergence({ exitStopsServer: true, env: {} })
    expect(detail).toBeDefined()
    expect(matchUpdateFailureToken(detail)).toBe('foreground-all-in-one')
    expect(classifyUpdateFailureDetail(detail)).toBe('machine-cannot-restart')
  })

  /**
   * POD-2213/POD-2239. Three tokens, three states of knowledge, and the second
   * time this epic shipped an arm on one side only.
   */
  it('classifies all three schema refusals from their own constructors', () => {
    const advanced = refuseSchemaRegression({
      applied: ['0042_add_operations'],
      targetDefines: ['0001_init'],
      currentVersion: '0.1.7',
      targetVersion: '0.1.3',
    })
    const unknown = refuseSchemaRegression({
      applied: ['0042_add_operations'],
      targetDefines: undefined,
      currentVersion: '0.1.7',
      targetVersion: '0.1.3',
    })
    const unreadable = createSchemaGate({
      readApplied: () => {
        throw new Error('SQLITE_BUSY: database is locked')
      },
      currentVersion: '0.1.7',
    })({ version: '0.1.3' })

    expect(matchUpdateFailureToken(advanced)).toBe('schema-advanced')
    expect(matchUpdateFailureToken(unknown)).toBe('schema-unknown')
    expect(matchUpdateFailureToken(unreadable)).toBe('schema-unreadable')

    const codes = [advanced, unknown, unreadable].map(classifyUpdateFailureDetail)
    expect(new Set(codes).size).toBe(3)
    for (const code of codes) expect(code).not.toBe('machine-unreachable')
  })

  /**
   * The errno inside `schema-unreadable` is arbitrary text, and the download
   * family below it in the table is built to catch exactly that shape. Driven
   * through the real gate so the ordering is proved on a real sentence.
   */
  it('classifies an unreadable ledger by its token, not by the errno it quotes', () => {
    const detail = createSchemaGate({
      readApplied: () => {
        throw new Error('ETIMEDOUT waiting for the database lock')
      },
      currentVersion: '0.1.7',
    })({ version: '0.1.3' })
    expect(classifyUpdateFailureDetail(detail)).toBe('machine-schema-unreadable')
  })

  /** The planner's three refusals, through the wrapper `applyGrant` puts on them. */
  it('classifies every convergence-planner refusal, as applyGrant reports it', async () => {
    const cases: Array<[UpdateFailureToken, { version: string; artifacts: object }, string[]]> = [
      ['no-artifact', { version: '0.1.5', artifacts: {} }, []],
      [
        'unsupported-delivery',
        { version: '0.1.5', artifacts: { headless: { delivery: 'git', repo: '/r', sha: 'a' } } },
        [],
      ],
      [
        'unsupported-platform',
        {
          version: '0.1.5',
          artifacts: {
            headless: {
              delivery: 'feed',
              platforms: { 'darwin-aarch64': { url: 'https://x', digest: 'd', signature: 's' } },
            },
          },
        },
        ['update.delivery.feed'],
      ],
    ]
    for (const [token, target, caps] of cases) {
      const [detail] = await detailsFromApplyGrant({ target, caps })
      expect(detail, token).toBeDefined()
      expect(matchUpdateFailureToken(detail), token).toBe(token)
      expect(classifyUpdateFailureDetail(detail), token).not.toBe('machine-unreachable')
    }
    // And the planner really does produce only those three.
    expect(
      planConvergence({
        current: 'a',
        target: { version: 'b', artifacts: {} } as never,
        caps: [],
        platform: 'linux-x86_64',
      }),
    ).toEqual({ action: 'cannot', reason: 'no-artifact' })
  })

  /**
   * Every git step, driven through `convergeViaGit` and the wrapper
   * `fetchArtifact` puts on it. ALL of these used to be `machine-unreachable` —
   * a machine that had just reported a precise git failure was described to the
   * operator as having stopped responding, and promised a resumption that was
   * never coming.
   */
  it('classifies every git delivery step failure as a delivery failure', async () => {
    const cases: Array<[UpdateFailureToken, Record<string, { status: number; stdout?: string }>]> =
      [
        ['dirty-working-tree', { status: { status: 0, stdout: ' M file\n' } }],
        ['git-status-failed', { status: { status: 1 } }],
        ['git-fetch-failed', { ...CLEAN, fetch: { status: 1 } }],
        ['git-checkout-failed', { ...CLEAN, fetch: { status: 0 }, checkout: { status: 1 } }],
        ['git-timed-out', { status: { status: GIT_TIMED_OUT_STATUS } }],
        ['git-cancelled', { status: { status: GIT_ABORTED_STATUS } }],
      ]
    for (const [token, plan] of cases) {
      const detail = await gitDeliveryDetail(plan)
      expect(matchUpdateFailureToken(detail), token).toBe(token)
    }

    // The one git refusal that comes from the ARGUMENTS rather than a step.
    const invalid = await convergeViaGit({ repo: '', sha: 'abc' }, { run: gitRunner({}) })
    expect(invalid.ok).toBe(false)
    expect(
      matchUpdateFailureToken(`git delivery failed: ${invalid.ok ? '' : invalid.reason}`),
    ).toBe('invalid-git-reference')
  })

  /**
   * The verification failures. A SECURITY EVENT reported as "that machine
   * stopped responding" is the worst single row the old default produced: it
   * describes a tampered or corrupt artifact as a connectivity problem.
   */
  it('classifies a failed digest check as a rejected artifact, never as unreachable', async () => {
    let detail = ''
    try {
      await fetchArtifact(
        { url: 'https://example/a.tgz', digest: 'sha256-nope', signature: 'sig' } as never,
        'feed',
        {
          fetch: async () => ({
            ok: true,
            status: 200,
            headers: new Map(),
            arrayBuffer: async () => new ArrayBuffer(8),
          }),
        } as never,
      )
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    expect(matchUpdateFailureToken(detail)).toBe('artifact-unverified')
    expect(classifyUpdateFailureDetail(detail)).toBe('machine-artifact-rejected')
  })

  it('classifies the delivery misconfigurations as unavailable rather than unreachable', async () => {
    const details: string[] = []
    for (const [asset, delivery] of [
      [{ delivery: 'git' }, 'git'],
      [{ digest: 'd' }, 'feed'],
    ] as const) {
      try {
        await fetchArtifact(asset as never, delivery, {} as never)
      } catch (error) {
        details.push(error instanceof Error ? error.message : String(error))
      }
    }
    expect(details).toHaveLength(2)
    for (const detail of details) {
      expect(matchUpdateFailureToken(detail), detail).toBe('delivery-misconfigured')
      expect(classifyUpdateFailureDetail(detail), detail).toBe('machine-delivery-unavailable')
    }
  })

  it('classifies a bad HTTP status from the artifact fetch as a download failure', async () => {
    let detail = ''
    try {
      await fetchArtifact({ url: 'https://example/a.tgz', digest: 'd' } as never, 'feed', {
        fetch: async () => ({ ok: false, status: 404 }),
      } as never)
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    expect(matchUpdateFailureToken(detail)).toBe('download-http-status')
    expect(classifyUpdateFailureDetail(detail)).toBe('download-failed')
  })

  /**
   * The boot reconciler's two verdicts, from `resolveOnBoot` and from the
   * sentence `host-runtime` composes around a retry. The machine is UP in both
   * — the boot is what is reporting — so "stopped responding; it will resume
   * when it reconnects" was false on its face.
   */
  it('classifies both boot-reconciliation verdicts as an unconfirmed update', () => {
    const stuck = resolveOnBoot({
      pending: {
        grantId: 'g',
        targetVersion: '0.1.5',
        previousVersion: '0.1.3',
        attempts: MAX_CONVERGENCE_ATTEMPTS,
        startedAt: 0,
      },
      runningVersion: '0.1.3',
    })
    expect(stuck?.action).toBe('rollback')
    const stuckDetail = stuck?.action === 'rollback' ? stuck.detail : ''
    expect(matchUpdateFailureToken(stuckDetail)).toBe('convergence-attempts-exhausted')
    expect(classifyUpdateFailureDetail(stuckDetail)).toBe('machine-update-not-confirmed')

    // The retry sentence is composed in `host-runtime.ts`; its shape is what is
    // pinned here, and the token is what survives a reword of the numbers.
    const retryDetail =
      'attempt 1 of 2 did not reach 0.1.5 (running 0.1.3); applying again will retry it'
    expect(matchUpdateFailureToken(retryDetail)).toBe('convergence-retry-pending')
  })

  /**
   * A SUPERSEDED GRANT MUST STAY SILENT, which is why `git-cancelled` and the
   * superseded-download sentence have no operator copy in practice: the run
   * that would report them returns first. Pinned rather than assumed — the
   * table carries a row for the cancelled case anyway, because "unreportable"
   * is a property of this one call site.
   */
  it('reports nothing at all when a newer grant supersedes the one in flight', async () => {
    const controller = new AbortController()
    controller.abort()
    const details: string[] = []
    await applyGrant(
      {
        type: 'updateGrant',
        grantId: 'g1',
        target: {
          version: '0.1.5',
          artifacts: { headless: { delivery: 'git', repo: '/r', sha: 'abc1234' } },
        },
      } as never,
      {
        currentVersion: () => '0.1.3',
        caps: ['update.delivery.git'],
        platform: 'linux-x86_64',
        fetchArtifact: async () => {
          throw new Error('git delivery failed: cancelled')
        },
        swap: () => {},
        writePending: () => {},
        restart: () => {},
        now: () => 0,
        report: (status) => {
          if (status.detail) details.push(status.detail)
        },
      } as GrantApplyDeps,
      controller.signal,
    )
    expect(details).toEqual([])
  })

  /**
   * THE TEST THAT KEEPS THE OTHER TWO PACKAGES HONEST.
   *
   * apps/server and apps/web may not import this app, so they drive their
   * exhaustiveness off `UPDATE_FAILURE_EXAMPLES`. Every example above has been
   * produced by a real constructor in this file; this asserts the table's own
   * copy of each sentence still classifies as its own token, so a producer that
   * rewords a refusal reds here rather than leaving two packages testing a
   * sentence nothing writes any more.
   */
  it('leaves no token in the shared table without a producer behind it', () => {
    const byCode = new Map<MachineFailureCode, UpdateFailureToken[]>()
    for (const token of UPDATE_FAILURE_TOKENS) {
      const example = UPDATE_FAILURE_EXAMPLES[token]
      expect(matchUpdateFailureToken(example), token).toBe(token)
      const code = classifyUpdateFailureDetail(example)
      byCode.set(code, [...(byCode.get(code) ?? []), token])
    }
    // Only the machine that genuinely went quiet may take the old default.
    expect(byCode.get('machine-unreachable')).toEqual(['stopped-reporting-progress'])
  })
})
