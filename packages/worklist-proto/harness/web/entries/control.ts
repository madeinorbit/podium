import { startEngineOnCorpus } from '../../../shared/src/scenarios'
import { legacyControlArmFor } from '../../src/legacy-control/arm'
import { mountPage, pageEngineOptions, readPageCorpus, stagePoint } from '../entrylib'

// POD-4561: the bundle is fetched, parsed and evaluated (every static import).
const scriptAt = performance.now()

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
  mountPage({
    arm: 'control',
    createArm: (over) => legacyControlArmFor(over.engine),
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
