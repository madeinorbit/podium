/**
 * POD-4694 — the hand page mounts the ROUND-THREE pool (`arms/hand/pool`:
 * the pool, its worklist, `pool/react/list.tsx`), built by the page through
 * `createArm(boot)` like every arm (`entrylib.ts`: held pages, the lifecycle
 * steps and parity per sample are the page's). Before this issue it mounted
 * the frozen round-two store with its known correctness bugs
 * while the matrix timed it as the round-three pool: every
 * record mismatched the oracle from bootstrap (i1026 queued/false vs
 * waiting/true), identically at the base SHA. Parity carries the pool's one
 * named allowance, POD-4671's row, as the fence roster does
 * (`worklist/known-gaps.ts`); each record names it when applied. Mirrors
 * `entries/mobx.ts` (POD-4572), minus its MobX-only console trap.
 */

import { handPoolArm } from '../../../arms/hand/pool/arm'
import { HAND_POOL_ALLOWANCES } from '../../../arms/hand/pool/worklist/known-gaps'
import { FIXTURE_SEED, startEngineOnCorpus } from '../../../shared/src/scenarios'
import { buildCorpus } from '../../src/fixture/index'
import { mountPage, readScale } from '../entrylib'

// POD-4561: the bundle is fetched, parsed and evaluated (every static import).
const scriptAt = performance.now()

const scale = readScale()
const params = new URLSearchParams(window.location.search)
const sha = params.get('sha') ?? 'dev'
const corpus = buildCorpus(scale, FIXTURE_SEED)
// No top-level await and no module binding for the runtime: an async
// module's generator keeps its awaited values alive, and a principal switch
// must be able to drop the old runtime (POD-4561).
void startEngineOnCorpus(corpus).then((boot) => {
  mountPage({
    arm: 'hand',
    createArm: () => handPoolArm,
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
    // POD-4671's one row, the roster's own named allowance (`known-gaps.ts`).
    parityAllowance: HAND_POOL_ALLOWANCES.parity,
  })
})
