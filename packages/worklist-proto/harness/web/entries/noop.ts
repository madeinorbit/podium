import { buildCorpus } from '../../src/fixture/index'
import { FIXTURE_SEED, startEngineOnCorpus } from '../../../shared/src/scenarios'
import { createRowSource } from '../../../shared/src/row-source'
import { mountPage, readScale } from '../entrylib'
import { noopArmFor } from '../noop-arm'

// POD-4558: the instrument floor — an arm that does nothing on a change,
// timed on the same path as every arm (`noop-arm.tsx`).
const scale = readScale()
const sha = new URLSearchParams(window.location.search).get('sha') ?? 'dev'
const corpus = buildCorpus(scale, FIXTURE_SEED)
const boot = await startEngineOnCorpus(corpus)
const source = createRowSource(boot.engine, boot.replica, { mode: 'overlaid' })
mountPage({
  arm: 'noop',
  createArm: () => noopArmFor(boot, [boot.targets.visibleRootId, boot.targets.markReadId]),
  source: source.source,
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
})
