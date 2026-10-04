/** Read-only operator replay. No export file, titles, paths or text are
 * emitted. The live bootstrap stays in memory on ludovico throughout.
 * timeout 180s bun --conditions=@podium/source diagnostics/issue-chips-replay.ts
 */
import { hostname } from 'node:os'
import { withKeyedInputs } from '../packages/client-core/test-support/keyed-inputs'
import { createKernelReplica, createSideCache, memoryStorage, type Replica } from '../packages/client-core/src/replica/index'
import { allIssueViewModels } from '../packages/client-graph/diagnostics/reference/issue-view-models'
import { canonicalIssueRef } from '../packages/client-core/src/values/issue-reference'
import { checkIssueChips } from '../packages/client-graph/diagnostics/chip-check'
import { createWorklistPool } from '../packages/client-graph/src/create'
import { issueRefKey } from '../packages/client-graph/src/issue-reference'
import { createEngineLocals } from '../packages/client-graph/src/shared/engine-locals'
import { createRowSource } from '../packages/worklist-proto/shared/src/row-source'
import { parseAnyRef } from '../packages/protocol/src/index'
import { readLive } from '../packages/worklist-proto/harness/src/fixture/export-snapshot'
import { corpusFromLive } from '../packages/worklist-proto/harness/src/fixture/live-snapshot'
import { sidebarReplayStore } from '../packages/worklist-proto/harness/src/oracle/sidebar-replay'
import { seedCacheFromCorpus } from '../packages/worklist-proto/shared/src/scenarios'

/** Same ordering as the app's hydrate-first ReplicaBinding, not transport order. */
export function chipReplayLegacy(replica: Replica) {
  return allIssueViewModels(replica)
}

export function chipReplayTokens(legacy: Parameters<typeof checkIssueChips>[1]): string[] {
  return legacy.map(canonicalIssueRef).filter((token) => parseAnyRef(token)?.kind === 'issue')
}

async function main(): Promise<void> {
  if (hostname() !== 'ludovico') throw new Error('Live replay is restricted to ludovico')
  const origin = (process.env.PODIUM_ORIGIN ?? 'http://127.0.0.1:18787').replace(/\/$/, '')
  const { raw } = await readLive(origin)
  const corpus = corpusFromLive(raw, Date.now())
  const replica = createKernelReplica({
    cache: seedCacheFromCorpus(corpus),
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const store = sidebarReplayStore(corpus, replica)
  // ReplicaBinding seeds the app from replica order. Bootstrap transport order
  // is not the legacy UI order, particularly for colliding display refs.
  const legacy = chipReplayLegacy(replica)
  // A prefix-less #seq is a fallback label, not a parseable issue reference.
  // Those orphan rows can share sequence numbers across repositories; they
  // cannot be mentioned by the Markdown reference decorator or miniview.
  const tokens = chipReplayTokens(legacy)
  const counts = new Map<string, number>()
  for (const token of tokens) {
    const key = issueRefKey(token)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const collisions = [...counts].filter(([, count]) => count > 1)
  const runtime = withKeyedInputs({
    getSnapshot: () => store,
    subscribe: () => () => {},
    pendingOverlaysByRow: () => new Map(),
  })
  const rows = createRowSource(runtime, replica, { mode: 'pooled' })
  const locals = createEngineLocals(runtime)
  const handle = createWorklistPool(rows.source, locals.source)
  try {
    for (let round = 0; round < 128; round++) {
      const result = checkIssueChips(handle.pool.references, legacy, tokens)
      if (!result.pending) {
        const opaqueId = (id: string | null) => (id && /^iss_[\w-]+$/.test(id) ? id : null)
        console.log(
          JSON.stringify({
            issues: corpus.issues.length,
            sessions: corpus.sessions.length,
            nonReferenceRows: legacy.length - tokens.length,
            ...result,
            ...(process.argv.includes('--explain-collisions')
              ? {
                  collisions: {
                    groups: collisions.length,
                    rows: collisions.reduce((sum, [, count]) => sum + count, 0),
                    prefixedGroups: collisions.filter(([ref]) => !ref.startsWith('#')).length,
                  },
                }
              : {}),
            first: result.first
              ? {
                  ...result.first,
                  expectedId: opaqueId(result.first.expectedId),
                  actualId: opaqueId(result.first.actualId),
                }
              : null,
          }),
        )
        if (result.differences) process.exitCode = 1
        return
      }
      handle.pool.hydrate()
      await Promise.resolve()
    }
    throw new Error('Live chip load windows did not settle')
  } finally {
    handle.dispose()
    locals.dispose()
    rows.dispose()
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch {
    console.error('Chip replay failed; input and error text withheld')
    process.exitCode = 1
  }
}
