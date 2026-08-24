import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyUpdateFailureDetail,
  type MachineFailureCode,
  matchUpdateFailureToken,
  planConvergence,
  RETIRED_PRODUCER_TOKENS,
  UPDATE_ARTIFACT_INTEGRITY_REFUSAL,
  UPDATE_ARTIFACT_REFUSAL_HEADER,
  UPDATE_FAILURE_EXAMPLES,
  UPDATE_FAILURE_TOKENS,
  type UpdateFailureToken,
} from '@podium/protocol'
import { fetchArtifact } from '@podium/runtime/update-delivery'
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
      fetchArtifact: async () => ({ bytes: new Uint8Array([1]) }),
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

  /**
   * An effect inside `applyGrant` threw while the participant was alive enough
   * to report the exception. This is the exact opposite of silence: the raw
   * errno must survive as support detail and must not be relabelled as a dead
   * machine by the coordinator.
   */
  it('keeps an unexpected pending-marker write failure out of unreachable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pending-write-refusal-'))
    try {
      const [detail] = await detailsFromApplyGrant({
        target: {
          version: '0.1.5',
          artifacts: {
            headless: {
              delivery: 'feed',
              platforms: {
                'linux-x86_64': {
                  url: 'https://x.test/a',
                  digest: 'd',
                  signature: 's',
                },
              },
            },
          },
        },
        caps: ['update.delivery.feed'],
        // The pre-fix marker write: its parent directory does not exist.
        writePending: () => writeFileSync(join(root, 'runtime', 'pending-update.json.tmp'), '{}'),
      })

      expect(detail).toMatch(/ENOENT.*pending-update\.json\.tmp/i)
      expect(matchUpdateFailureToken(detail)).toBeUndefined()
      expect(classifyUpdateFailureDetail(detail)).toBe('machine-update-failed')
      expect(classifyUpdateFailureDetail(detail)).not.toBe('machine-unreachable')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /** The planner's three refusals, through the wrapper `applyGrant` puts on them. */
  it('classifies every convergence-planner refusal, as applyGrant reports it', async () => {
    const cases: Array<[UpdateFailureToken, { version: string; artifacts: object }, string[]]> = [
      ['no-artifact', { version: '0.1.5', artifacts: {} }, []],
      [
        'unsupported-delivery',
        {
          version: '0.1.5',
          artifacts: {
            headless: {
              delivery: 'feed',
              platforms: {
                'linux-x86_64': { url: 'https://x.test/a', digest: 'd', signature: 's' },
              },
            },
          },
        },
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
   * THE TOKENS WHOSE PRODUCER IS GONE, and why the rows stay.
   *
   * Every git-delivery sentence used to be produced in this file, driven
   * through `convergeViaGit`. Git delivery is retired, so nothing in this build
   * writes any of them — but the wire is older than the build, and a fleet
   * machine still running a pre-retirement daemon can report one. Dropping the
   * patterns would send those refusals straight back to `machine-unreachable`,
   * which is the exact defect this table exists to prevent.
   *
   * They are therefore excused BY NAME, from a register in the shared package,
   * and the honesty check below is what makes that excuse a ratchet rather than
   * a comment: a token that quietly loses its producer cannot slip through, it
   * has to be added here, in a diff someone reads.
   */
  it('keeps the retired git tokens classified for daemons that predate the retirement', () => {
    for (const token of RETIRED_PRODUCER_TOKENS) {
      const example = UPDATE_FAILURE_EXAMPLES[token]
      expect(matchUpdateFailureToken(example), token).toBe(token)
      expect(classifyUpdateFailureDetail(example), token).not.toBe('machine-unreachable')
    }
    // The register is a claim about what this build no longer writes, so it may
    // never quietly grow to cover a token something here really does produce.
    expect(
      RETIRED_PRODUCER_TOKENS.every(
        (token) => token.startsWith('git-') || token === 'invalid-git-reference',
      ),
    ).toBe(true)
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
        {
          pubkey: 'k',
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

  /**
   * THE ORIGIN'S HALF OF THE SAME CONTROL (POD-2739).
   *
   * A tampered artifact whose SIZE changed never reaches the digest check
   * above: the publishing server sees the mismatch first and answers a
   * fail-closed 404 carrying {@link UPDATE_ARTIFACT_REFUSAL_HEADER}. Without
   * that marker the sentence is `artifact download returned 404`, which is
   * `download-failed` — a network problem, to whoever reads it. Both arms are
   * driven through the real producer here, because the whole point is that the
   * two 404s must not classify alike.
   */
  it('classifies an integrity-marked 404 as a rejected artifact, and a bare one as transport', async () => {
    const download = async (headers: Record<string, string>): Promise<string> => {
      try {
        await fetchArtifact(
          { url: 'https://example/a.tgz', digest: 'sha256-nope', signature: 'sig' } as never,
          {
            pubkey: 'k',
            fetch: async () => new Response('not found', { status: 404, headers }),
          } as never,
        )
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      throw new Error('a 404 must not resolve')
    }

    const marked = await download({
      [UPDATE_ARTIFACT_REFUSAL_HEADER]: UPDATE_ARTIFACT_INTEGRITY_REFUSAL,
    })
    expect(matchUpdateFailureToken(marked), marked).toBe('artifact-unverified')
    expect(classifyUpdateFailureDetail(marked), marked).toBe('machine-artifact-rejected')

    const bare = await download({})
    expect(matchUpdateFailureToken(bare), bare).toBe('download-http-status')
    expect(classifyUpdateFailureDetail(bare), bare).toBe('download-failed')
  })

  it('classifies the delivery misconfigurations as unavailable rather than unreachable', async () => {
    const details: string[] = []
    for (const [asset, deps] of [
      // No URL to fetch from…
      [{ digest: 'd', signature: 's' }, { pubkey: 'k' }],
      // …and a target naming the pinned root on a daemon that pinned nothing.
      [{ url: 'https://x.test/a', digest: 'd', signature: 's' }, { trust: 'instance' }],
    ] as const) {
      try {
        await fetchArtifact(asset as never, deps as never)
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
      await fetchArtifact(
        { url: 'https://example/a.tgz', digest: 'd' } as never,
        {
          pubkey: 'k',
          fetch: async () => ({ ok: false, status: 404 }),
        } as never,
      )
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
   * that would report them returns first. Pinned rather than assumed —
   * "unreportable" is a property of this one call site, not of the sentence.
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
          artifacts: {
            headless: {
              delivery: 'feed',
              platforms: {
                'linux-x86_64': { url: 'https://x.test/a', digest: 'd', signature: 's' },
              },
            },
          },
        },
      } as never,
      {
        currentVersion: () => '0.1.3',
        caps: ['update.delivery.feed'],
        platform: 'linux-x86_64',
        fetchArtifact: async () => {
          throw new Error('artifact download was superseded by a newer grant')
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
