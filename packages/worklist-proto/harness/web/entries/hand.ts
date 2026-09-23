import { handArm } from '../../../arms/hand/arm'
import { buildCorpus } from '../../src/fixture/index'
import { FIXTURE_SEED, startEngineOnCorpus } from '../../../shared/src/scenarios'
import { mountPage, readScale } from '../entrylib'

// POD-4561: the bundle is fetched, parsed and evaluated (every static import).
const scriptAt = performance.now()

const scale = readScale()
const sha = new URLSearchParams(window.location.search).get('sha') ?? 'dev'
const corpus = buildCorpus(scale, FIXTURE_SEED)
const boot = await startEngineOnCorpus(corpus)
mountPage({
  arm: 'hand',
  createArm: () => handArm,
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
