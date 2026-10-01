/** Read-only operator replay. No export file, titles, paths or text are
 * emitted. The live bootstrap stays in memory on ludovico throughout.
 * timeout 180s bun --conditions=@podium/source diagnostics/issue-chips-replay.ts
 */
import { hostname } from 'node:os'
import {
  allIssueViewModels,
  createKernelReplica,
  createSideCache,
  memoryStorage,
} from '../packages/client-core/src/replica/index'
import { canonicalIssueRef } from '../packages/client-core/src/viewmodels/issue-reference'
import { checkIssueChips } from '../packages/client-graph/diagnostics/chip-check'
import { createWorklistPool } from '../packages/client-graph/src/create'
import { issueRefKey } from '../packages/client-graph/src/issue-reference'
import { createEngineLocals } from '../packages/client-graph/src/shared/engine-locals'
import { createRowSource } from '../packages/client-graph/src/shared/row-source'
import { readLive } from '../packages/worklist-proto/harness/src/fixture/export-snapshot'
import { corpusFromLive } from '../packages/worklist-proto/harness/src/fixture/live-snapshot'
import { sidebarReplayStore } from '../packages/worklist-proto/harness/src/oracle/sidebar-replay'
import { seedCacheFromCorpus } from '../packages/worklist-proto/shared/src/scenarios'

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
  const legacy = allIssueViewModels(replica, store.issueProjections, store.issues)
  const tokens = legacy.map(canonicalIssueRef)
  // The replay's authority resolves against the captured bootstrap in memory.
  // The running server is not restarted to install the additive endpoint.
  const authority = new Map(legacy.map((row) => [issueRefKey(canonicalIssueRef(row)), row.id]))
  const runtime = {
    getSnapshot: () => store,
    subscribe: () => () => {},
    pendingOverlaysByRow: () => new Map(),
  }
  const rows = createRowSource(runtime, replica, { mode: 'overlaid' })
  const locals = createEngineLocals(runtime)
  const handle = createWorklistPool(rows.source, locals.source, {
    resolveReferences: async (refs) => refs.map((ref) => ({ ref, id: authority.get(ref) ?? null })),
  })
  try {
    for (let round = 0; round < 128; round++) {
      const result = checkIssueChips(handle.pool.references, legacy, tokens)
      if (!result.pending) {
        const opaqueId = (id: string | null) => (id && /^iss_[\w-]+$/.test(id) ? id : null)
        console.log(
          JSON.stringify({
            issues: corpus.issues.length,
            sessions: corpus.sessions.length,
            ...result,
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
