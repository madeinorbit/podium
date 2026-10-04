/**
 * POD-4825 (item 1) — the MobX pages for the arm that owns optimism, built by
 * the page through `createArm` like every arm (`entrylib.ts`). Two pages,
 * two variants (`harness/src/writable-arm.ts`):
 *
 * - `mobx-write`: nothing pending;
 * - `mobx-pending`: title edits on the last rows of the page's first window
 *   (never a rename target: an open root with children) queued in the kernel
 *   outbox before the arm is built and never answered. The page's parity
 *   holds the arm to the oracle with those titles laid over it; a principal
 *   switch queues them again on the new engine.
 *
 * POD-5432: the arm owns optimism the product's way: the round-three pool on
 * the `owned` feed (`mountPage({ owned })`), its pool given the
 * runtime's transaction log, which rebuilds the queued edits when it is built.
 * The scenarios' own writes route through that log, as the app's do. Not a
 * module binding for the runtime (see `mobx.ts`): only the pending titles
 * (strings) outlive a build.
 */

import { POOL_OWNED_KINDS } from '@podium/client-graph/host'
import type { MobxPool } from '@podium/client-graph/pool'
import { attachRuntimeWriter, createRuntimeTransactions } from '@podium/client-graph/runtime-pool'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { harnessMobxPoolArm } from '../../src/adapters/mobx-pool'
import {
  type ScenarioEngine,
  startEngineOnCorpus,
  targetRules,
} from '../../../shared/src/scenarios'
import { oracleSnapshot } from '../../src/oracle/index'
import {
  holdingServer,
  ownedEngineOptions,
  pendingTitleEditsOn,
  queuePendingTitles,
  type WriteVariant,
  withPendingTitles,
} from '../../src/writable-arm'
import {
  firstWindowRows,
  mountPage,
  type OwnedFeed,
  pageEngineOptions,
  readPageCorpus,
  stagePoint,
} from '../entrylib'

/** The product's wiring of `owns: POOL_OWNED_KINDS`, over one page engine. */
function ownedFeed(over: ScenarioEngine): OwnedFeed {
  const transactions = createRuntimeTransactions(over.engine)
  let stopWriter = (): void => {}
  return {
    options: { mode: 'pooled', pending: transactions.pending, owned: new Set(POOL_OWNED_KINDS) },
    bind(source) {
      transactions.bind(source)
      stopWriter = attachRuntimeWriter(over.engine, transactions)
    },
    attach(handle) {
      ;(handle as unknown as { pool: MobxPool }).pool.attachTransactions(
        transactions,
        POOL_OWNED_KINDS.includes('session'),
      )
    },
    release() {
      stopWriter()
      transactions.dispose()
    },
  }
}

export function bootWritablePage(variant: WriteVariant, scriptAt: number): void {
  const params = new URLSearchParams(window.location.search)
  const sha = params.get('sha') ?? 'dev'
  let titles: ReadonlyMap<string, string> = new Map()
  void (async () => {
    await stagePoint('script')
    const { corpus, scale, cell } = readPageCorpus()
    await stagePoint('fixture')
    const held = holdingServer()
    const engineOptions = ownedEngineOptions(held.server)
    const boot = await startEngineOnCorpus(corpus, { ...pageEngineOptions(), ...engineOptions })
    // The pending edits are real outbox records, queued before the arm exists.
    const prepareEngine = async (over: ScenarioEngine): Promise<void> => {
      if (variant === 'idle') return
      const rules = targetRules(over.corpus)
      const probe = createRowSource(over.engine, over.replica, { mode: 'overlaid' })
      try {
        titles = pendingTitleEditsOn(
          probe.source.snapshot('issue'),
          oracleSnapshot(over.engine.access).order,
          (id) => rules.openRootWithChildren(id),
          firstWindowRows(),
          Date.now(),
        ).titles
      } finally {
        probe.dispose()
      }
      held.hold(titles.keys())
      await queuePendingTitles(over.engine, titles)
    }
    await prepareEngine(boot)
    mountPage({
      arm: `mobx-${variant === 'idle' ? 'write' : 'pending'}`,
      owned: ownedFeed,
      engineOptions,
      prepareEngine,
      createArm: () => harnessMobxPoolArm,
      boot,
      scale,
      cell,
      counts: {
        issues: corpus.stats.issues,
        sessions: corpus.stats.sessions,
        repos: corpus.stats.repos,
        worktrees: corpus.stats.worktrees,
      },
      runtimeSha: sha,
      el: document.getElementById('root')!,
      scriptAt,
      expected: (oracle) => withPendingTitles(oracle, titles),
    })
  })()
}
