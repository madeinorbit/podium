import { buildCorpus } from '../src/fixture/index'
import { startEngineFromCorpus } from '../src/engine-bootstrap'
import { legacyControlArmFor } from '../src/legacy-control/arm'
import { createRowSource } from '../../shared/src/row-source'
import { mountPage, readScale } from '../entrylib'

const scale = readScale()
const sha = new URLSearchParams(window.location.search).get('sha') ?? 'dev'
const corpus = buildCorpus(scale, 4443)
const boot = await startEngineFromCorpus(corpus)
const source = createRowSource(boot.engine, boot.replica)
mountPage({
  arm: 'control',
  createArm: () => legacyControlArmFor(boot.engine),
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
