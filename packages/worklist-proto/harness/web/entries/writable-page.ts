/**
 * POD-4825 (item 1) — the MobX pages for the arm that owns optimism: the
 * round-three pool with its write layer (`writableMobxPoolArm`), built by
 * the page through `createArm` like every arm (`entrylib.ts`). Two pages,
 * two variants (`harness/src/writable-arm.ts`):
 *
 * - `mobx-write`: the layer attached, nothing pending;
 * - `mobx-pending`: title edits on the last rows of the page's first window
 *   (never a rename target: an open root with children) queued in the kernel
 *   outbox when the arm is built, re-applied by the layer at once and never
 *   receipted. The page's parity holds the arm to the oracle with those
 *   titles laid over it; a principal switch picks them again on the new
 *   engine.
 *
 * The transport sends nowhere and never answers: the scenarios' own writes
 * are the kernel's, as on the `mobx` page. Not a module binding for the
 * runtime (see `mobx.ts`): only the pending titles (strings) outlive a build.
 */

import { writableMobxPoolArm } from '../../../arms/mobx/pool/write/arm'
import { startEngineOnCorpus, targetRules } from '../../../shared/src/scenarios'
import { oracleSnapshot } from '../../src/oracle/index'
import {
  pendingTitleEditsOn,
  silentTransport,
  type WriteVariant,
  withPendingTitles,
} from '../../src/writable-arm'
import {
  firstWindowRows,
  mountPage,
  pageEngineOptions,
  readPageCorpus,
  stagePoint,
} from '../entrylib'

export function bootWritablePage(variant: WriteVariant, scriptAt: number): void {
  const params = new URLSearchParams(window.location.search)
  const sha = params.get('sha') ?? 'dev'
  let titles: ReadonlyMap<string, string> = new Map()
  void (async () => {
    await stagePoint('script')
    const { corpus, scale, cell } = readPageCorpus()
    await stagePoint('fixture')
    const boot = await startEngineOnCorpus(corpus, pageEngineOptions())
    mountPage({
      arm: `mobx-${variant === 'idle' ? 'write' : 'pending'}`,
      createArm: (over, source) => {
        if (variant === 'idle') return writableMobxPoolArm(silentTransport())
        const rules = targetRules(over.corpus)
        const edits = pendingTitleEditsOn(
          source.snapshot('issue'),
          oracleSnapshot(over.engine.getSnapshot()).order,
          (id) => rules.openRootWithChildren(id),
          firstWindowRows(),
          Date.now(),
        )
        titles = edits.titles
        return writableMobxPoolArm(silentTransport(edits.queued))
      },
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
