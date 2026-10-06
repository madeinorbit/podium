import { startEngineOnCorpus } from '../../../shared/src/scenarios'
import { mountPage, pageEngineOptions, readPageCorpus, stagePoint } from '../entrylib'
import { noopArmFor, noopFrozenRows, readPlant } from '../noop-arm'

// POD-4561: the bundle is fetched, parsed and evaluated (every static import).
const scriptAt = performance.now()

// POD-4558: the instrument floor — an arm that does nothing on a change,
// timed on the same path as every arm (`noop-arm.tsx`).
const sha = new URLSearchParams(window.location.search).get('sha') ?? 'dev'
// No top-level await and no module binding for the runtime: an async
// module's generator keeps its awaited values alive, and a principal switch
// must be able to drop the old runtime (POD-4561). The boot below is an async
// function that returns once the page is mounted, and no closure in it holds
// the runtime. POD-4747: the stage points stop a `?layers=1` page for the
// layer-split driver; otherwise they resolve at once.
void (async () => {
  await stagePoint('script')
  const { corpus, scale, cell } = readPageCorpus()
  await stagePoint('fixture')
  const boot = await startEngineOnCorpus(corpus, pageEngineOptions())
  // POD-4747: the rows the floor draws, derived once at boot (untimed), so a
  // lifecycle step times only what building any arm costs.
  const frozen = noopFrozenRows(boot)
  mountPage({
    arm:
      readPlant() === null
        ? 'noop'
        : `noop+${new URLSearchParams(window.location.search).get('plant')}`,
    createArm: (over) => noopArmFor(over, readPlant(), frozen),
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
  })
})()
