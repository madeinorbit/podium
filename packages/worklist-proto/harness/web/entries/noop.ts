import { FIXTURE_SEED, startEngineOnCorpus } from '../../../shared/src/scenarios'
import { buildCorpus } from '../../src/fixture/index'
import { mountPage, readScale } from '../entrylib'
import { noopArmFor, readPlant } from '../noop-arm'

// POD-4561: the bundle is fetched, parsed and evaluated (every static import).
const scriptAt = performance.now()

// POD-4558: the instrument floor — an arm that does nothing on a change,
// timed on the same path as every arm (`noop-arm.tsx`).
const scale = readScale()
const sha = new URLSearchParams(window.location.search).get('sha') ?? 'dev'
const corpus = buildCorpus(scale, FIXTURE_SEED)
// No top-level await and no module binding for the runtime: an async
// module's generator keeps its awaited values alive, and a principal switch
// must be able to drop the old runtime (POD-4561).
void startEngineOnCorpus(corpus).then((boot) => {
  mountPage({
    arm:
      readPlant() === null
        ? 'noop'
        : `noop+${new URLSearchParams(window.location.search).get('plant')}`,
    createArm: (over) => noopArmFor(over, readPlant()),
    boot,
    scale,
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
})
