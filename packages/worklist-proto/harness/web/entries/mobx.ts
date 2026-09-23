import { mobxArm } from '../../../arms/mobx/arm'
import { FIXTURE_SEED, startEngineOnCorpus } from '../../../shared/src/scenarios'
import { buildCorpus } from '../../src/fixture/index'
import { mountPage, readScale } from '../entrylib'

// POD-4561: the bundle is fetched, parsed and evaluated (every static import).
const scriptAt = performance.now()

const scale = readScale()
const sha = new URLSearchParams(window.location.search).get('sha') ?? 'dev'
const corpus = buildCorpus(scale, FIXTURE_SEED)
// No top-level await and no module binding for the runtime: an async
// module's generator keeps its awaited values alive, and a principal switch
// must be able to drop the old runtime (POD-4561).
void startEngineOnCorpus(corpus).then((boot) => {
  mountPage({
    arm: 'mobx',
    createArm: () => mobxArm,
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
