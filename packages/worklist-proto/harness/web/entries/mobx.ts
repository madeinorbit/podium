/**
 * POD-4572 (Mb4) — the MobX page mounts the ROUND-THREE pool
 * (`arms/mobx/pool`: the pool, its worklist, `pool/react/list.tsx`), built by
 * the page through `createArm(boot)` like every arm (`entrylib.ts`: held
 * pages, the lifecycle steps and parity per sample are the page's). Parity
 * carries the pool's one named allowance, POD-4671's row, as the fence
 * roster does (`worklist/known-gaps.ts`); each record names it when applied.
 *
 * THE CONSOLE TRAP (M3 note N3). The page is a production build, where
 * MobX's enforcement warnings are compiled out (`__MOBX_DEV__`); a throw
 * inside a reaction is still reported, through `console.error`. The driver
 * (`run.ts`) fails a candidate arm's run on any console warning or error.
 * `?consoleplant=warn` / `?consoleplant=reaction` plant one of each after the
 * page boots (a direct `console.warn`; a reaction that throws, which MobX
 * reports): a run with either must fail (`run.ts --console-plant`).
 */

import { observable, reaction, runInAction } from 'mobx'
import { mobxPoolArm } from '../../../arms/mobx/pool/arm'
import { MOBX_POOL_ALLOWANCES } from '../../../arms/mobx/pool/worklist/known-gaps'
import { FIXTURE_SEED, startEngineOnCorpus } from '../../../shared/src/scenarios'
import { buildCorpus } from '../../src/fixture/index'
import { mountPage, readScale } from '../entrylib'

// POD-4561: the bundle is fetched, parsed and evaluated (every static import).
const scriptAt = performance.now()

const scale = readScale()
const params = new URLSearchParams(window.location.search)
const sha = params.get('sha') ?? 'dev'
const corpus = buildCorpus(scale, FIXTURE_SEED)

/** The trap's proof plants (never a timing run). */
function plantConsole(kind: string | null): void {
  if (kind === 'warn') console.warn('[plant] console warning')
  if (kind === 'reaction') {
    const box = observable.box(0, { name: 'plant.box' })
    const stop = reaction(
      () => box.get(),
      () => {
        throw new Error('[plant] thrown inside a reaction')
      },
    )
    runInAction(() => box.set(1))
    stop()
  }
}

// No top-level await and no module binding for the runtime: an async
// module's generator keeps its awaited values alive, and a principal switch
// must be able to drop the old runtime (POD-4561).
void startEngineOnCorpus(corpus).then((boot) => {
  mountPage({
    arm: 'mobx',
    createArm: () => mobxPoolArm,
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
    parityAllowance: MOBX_POOL_ALLOWANCES.parity,
  })
  plantConsole(params.get('consoleplant'))
})
