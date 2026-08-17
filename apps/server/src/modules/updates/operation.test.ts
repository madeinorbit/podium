import { asMachineId, type UpdateChannel } from '@podium/model'
import type { Operation, UpdateGrantMessage, UpdateTarget } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDrizzleMigrations } from '../../migrations'
import { DRIZZLE_MIGRATIONS } from '../../migrations/drizzle-manifest.generated'
import {
  DEFAULT_WAITING_GRACE_MS,
  type OperationClock,
  OperationEngine,
  type OperationTimerHandle,
} from '../operations/engine'
import { OperationKindRegistry } from '../operations/kinds'
import { OperationStore } from '../operations/store'
import {
  admissibleDeferredPlaces,
  classifyMachineFailure,
  createUpdateFleetBridge,
  DESKTOP_INSTALL_ASK,
  describeUpdateOperationFailure,
  describeUpdateWaitingExpiry,
  exclusiveUpdateVersion,
  LIFECYCLE_EXCLUSION_GROUP,
  planUpdateOperation,
  RELOAD_SURFACES_ASK,
  reconcileUpdateOperation,
  resetUpdateOperationState,
  STEP_HEARTBEAT_INTERVAL_MS,
  UPDATE_BUDGETS,
  UPDATE_NOT_INSTALLED_ERROR_CODE,
  UPDATE_OPERATION_KIND,
  UPDATE_STEP_DEADLINES,
  UPDATE_STEP_MACHINES,
  UPDATE_STEP_PREPARE,
  UPDATE_STEP_SERVER,
  UPDATE_STEP_WEB,
  type UpdateErrorCode,
  type UpdateFailure,
  type UpdateOperationContext,
  type UpdatePlanInput,
  updateOperationKind,
} from './operation'
import { DevBundleUnavailableError } from './dev-bundle'
import { ARTIFACT_ORIGIN_UNCONFIGURED_REASON } from './dev-publisher-wiring'
import { UpdatesService } from './service'
import { offeredDeliveries, type WaveMachine } from './wave'

/**
 * THE `update` KIND (POD-2098), proven the way the framework next door is: a
 * FAKE CLOCK and an injected scheduler, so nothing here sleeps. A `setTimeout`
 * before an assertion is a bug in this repo's unit lane, and it is also the
 * exact defect this whole epic is removing from the product.
 */

afterEach(() => {
  resetUpdateOperationState()
})

// ───────────────────────────── fixtures ──────────────────────────────

const WEB_DIGEST = 'abc1234'

function devTarget(over: Partial<UpdateTarget> = {}): UpdateTarget {
  return {
    version: 'dev+abc1234',
    critical: false,
    artifacts: { web: { digest: WEB_DIGEST } },
    ...over,
  } as UpdateTarget
}

/**
 * WHAT THE DEV PUBLISHER ACTUALLY PUBLISHES for a bare `dev+<sha>` identity
 * (`devIdentityTarget`): no tarball, and git as the delivery a machine that owns
 * the checkout can take today. `devTarget()` above is the degenerate shape that
 * offers NOTHING — kept, because it is what a plan must refuse to wave.
 */
function gitIdentityTarget(): UpdateTarget {
  return devTarget({
    artifacts: {
      web: { digest: WEB_DIGEST },
      headlessAlternatives: [{ delivery: 'git', repo: '/src/podium', sha: 'abc1234' }],
    },
  } as Partial<UpdateTarget>)
}

const GIT_CAPS = ['update.delivery.git']
const BUNDLE_CAPS = ['update.delivery.feed', 'update.delivery.bundle']

/** The same dev target once the tarball has been packed for it. */
function packedTarget(): UpdateTarget {
  return devTarget({
    artifacts: {
      web: { digest: WEB_DIGEST },
      headless: { delivery: 'bundle', platforms: {} },
    },
  } as Partial<UpdateTarget>)
}

function machine(over: Partial<WaveMachine> & { id: string }): WaveMachine {
  return {
    name: over.id,
    version: '0.4.1',
    state: 'current',
    online: true,
    busy: false,
    ...over,
  }
}

const planInput = (over: Partial<UpdatePlanInput> = {}): UpdatePlanInput => ({
  target: devTarget(),
  channel: 'dev',
  fleet: [],
  channelOf: () => 'dev',
  appVersion: '0.4.1',
  servedWebDigest: 'older99',
  canPrepare: true,
  canRebuildWeb: true,
  canRestartServer: true,
  ...over,
})

const stepIds = (plan: { steps: Array<{ id: string }> }): string[] =>
  plan.steps.map((step) => step.id)

// ─────────────────────────── §3.1 the plan ───────────────────────────

describe('planUpdateOperation', () => {
  /**
   * THE STEP LIST IS THE PLAN, and the panel renders "step 2 of 4" straight off
   * it — so a step that was never going to do anything would make that sentence
   * a lie. Every row here is a claim about what is OMITTED as much as included.
   */
  const rows: Array<{ name: string; input: Partial<UpdatePlanInput>; steps: string[] }> = [
    {
      name: 'a dev identity behind everywhere plans all four steps, in dependency order',
      input: { fleet: [machine({ id: 'vmi' })] },
      steps: [UPDATE_STEP_PREPARE, UPDATE_STEP_MACHINES, UPDATE_STEP_SERVER, UPDATE_STEP_WEB],
    },
    {
      name: 'an already-packed target needs no preparation',
      input: { target: packedTarget(), fleet: [machine({ id: 'vmi' })] },
      steps: [UPDATE_STEP_MACHINES, UPDATE_STEP_SERVER, UPDATE_STEP_WEB],
    },
    {
      name: 'a server already on the target keeps its machines and its website',
      input: { appVersion: 'dev+abc1234', fleet: [machine({ id: 'vmi' })] },
      steps: [UPDATE_STEP_PREPARE, UPDATE_STEP_MACHINES, UPDATE_STEP_WEB],
    },
    {
      name: 'a website already at the target digest is not rebuilt',
      input: { servedWebDigest: WEB_DIGEST, fleet: [machine({ id: 'vmi' })] },
      steps: [UPDATE_STEP_PREPARE, UPDATE_STEP_MACHINES, UPDATE_STEP_SERVER],
    },
    /**
     * The three rows below have no machine to update — one is already there,
     * one belongs to another channel, one does not exist. No pack is planned in
     * any of them and that is the POD-2195 rule seen from its quiet side: a
     * tarball is packed FOR someone, so with nobody in scope there is nobody to
     * pack for.
     */
    {
      name: 'a machine already at the target is not a step, and needs no package',
      input: { fleet: [machine({ id: 'vmi', version: 'dev+abc1234' })] },
      steps: [UPDATE_STEP_SERVER, UPDATE_STEP_WEB],
    },
    {
      name: 'a machine on another channel is not this operation‘s business',
      input: { fleet: [machine({ id: 'vmi' })], channelOf: () => 'stable' as UpdateChannel },
      steps: [UPDATE_STEP_SERVER, UPDATE_STEP_WEB],
    },
    {
      name: 'a server that cannot restart itself does not promise to',
      input: { canRestartServer: false, fleet: [] },
      steps: [UPDATE_STEP_WEB],
    },
    {
      name: 'an installation that can do nothing about its website omits the web step',
      input: {
        target: packedTarget(),
        canRestartServer: false,
        canRebuildWeb: false,
        canPrepare: false,
        appVersion: 'dev+abc1234',
        fleet: [machine({ id: 'vmi' })],
      },
      steps: [UPDATE_STEP_MACHINES],
    },
    {
      // A bare identity on a server with no publisher has no bytes to hand
      // anyone and nothing that will ever produce them, so a machines step
      // here would be a step that can never finish.
      name: 'a server that cannot pack does not promise a wave it cannot deliver',
      input: { canPrepare: false, fleet: [machine({ id: 'vmi' })] },
      steps: [UPDATE_STEP_SERVER, UPDATE_STEP_WEB],
    },
  ]

  for (const row of rows) {
    it(row.name, () => {
      expect(stepIds(planUpdateOperation(planInput(row.input)))).toEqual(row.steps)
    })
  }

  /**
   * POD-2195 — THE PACK IS PLANNED PER DELIVERY CAPABILITY, NOT ALWAYS.
   *
   * Spec §9.2: the machine that owns the checkout needs no build and no
   * download. A bare `dev+<sha>` identity already offers that machine everything
   * it needs — a repo and a sha — so packing a tarball for it is a compile whose
   * output nothing in the plan will ever read, and (measured on the live box)
   * 325 MB of it. The pack is planned for the machines that CANNOT take what the
   * target already offers, and for nobody else.
   */
  it('plans no pack when every machine in scope can take git delivery', () => {
    const plan = planUpdateOperation(
      planInput({
        target: gitIdentityTarget(),
        fleet: [machine({ id: 'src', deliveryCaps: GIT_CAPS })],
      }),
    )
    expect(stepIds(plan)).toEqual([UPDATE_STEP_MACHINES, UPDATE_STEP_SERVER, UPDATE_STEP_WEB])
    expect(plan.steps.find((step) => step.id === UPDATE_STEP_MACHINES)?.places).toEqual([
      expect.objectContaining({ id: 'src' }),
    ])
  })

  /**
   * …and a fleet with nothing to update at all is the same answer for the same
   * reason: nobody is waiting on a tarball, so nobody is served by building one.
   */
  it('plans no pack for a fleet with no machine behind', () => {
    const plan = planUpdateOperation(planInput({ target: gitIdentityTarget(), fleet: [] }))
    expect(stepIds(plan)).toEqual([UPDATE_STEP_SERVER, UPDATE_STEP_WEB])
  })

  /**
   * THE MIXED FLEET, which is where the pack is genuinely needed. One machine
   * owns a checkout, one can only take a bundle; the honest plan packs once and
   * waves BOTH — the installed machine is not deferred for the state of an
   * artifact this very plan is about to produce.
   */
  it('plans the pack for the one machine that can only take a bundle, and waves both', () => {
    const plan = planUpdateOperation(
      planInput({
        target: gitIdentityTarget(),
        fleet: [
          machine({ id: 'src', deliveryCaps: GIT_CAPS }),
          machine({ id: 'vmi', deliveryCaps: BUNDLE_CAPS }),
        ],
      }),
    )
    expect(stepIds(plan)).toEqual([
      UPDATE_STEP_PREPARE,
      UPDATE_STEP_MACHINES,
      UPDATE_STEP_SERVER,
      UPDATE_STEP_WEB,
    ])
    expect(
      plan.steps.find((step) => step.id === UPDATE_STEP_MACHINES)?.places?.map((p) => p.id),
    ).toEqual(['src', 'vmi'])
    expect(plan.deferred).toEqual([])
  })

  /**
   * A SLEEPING MACHINE STILL COUNTS TOWARDS THE PACK. It is deferred from the
   * wave, but the standing reconciler converges it against whatever is PUBLISHED
   * when it wakes — and a bare identity is nothing it could ever take. Not
   * packing here would strand it until a human ran another update.
   */
  it('packs for a bundle-only machine that is asleep, and defers it', () => {
    const plan = planUpdateOperation(
      planInput({
        target: gitIdentityTarget(),
        fleet: [machine({ id: 'vmi', deliveryCaps: BUNDLE_CAPS, online: false })],
      }),
    )
    expect(stepIds(plan)).toContain(UPDATE_STEP_PREPARE)
    expect(plan.deferred).toEqual([{ id: 'vmi', name: 'vmi', reason: 'offline' }])
  })

  /**
   * A machine that has never reported a build is not evidence that git will do.
   * `machineCanTakeDelivery` says yes to unknown caps so nothing is stranded;
   * the PACK question is the stricter one — do we positively know this machine
   * can take what we already have — because getting it wrong costs a wave of
   * rejections rather than a build.
   */
  it('packs for a machine whose delivery capabilities are unknown', () => {
    const plan = planUpdateOperation(
      planInput({ target: gitIdentityTarget(), fleet: [machine({ id: 'legacy' })] }),
    )
    expect(stepIds(plan)).toContain(UPDATE_STEP_PREPARE)
  })

  /**
   * §9.3 — development is the continuous test of the production mechanism, so
   * the source path must not need the publisher either. A server that cannot
   * pack anything can still hand a checkout-owning machine a sha.
   */
  it('waves a git-capable machine even where nothing can pack', () => {
    const plan = planUpdateOperation(
      planInput({
        target: gitIdentityTarget(),
        canPrepare: false,
        fleet: [machine({ id: 'src', deliveryCaps: GIT_CAPS })],
      }),
    )
    expect(stepIds(plan)).toContain(UPDATE_STEP_MACHINES)
    expect(stepIds(plan)).not.toContain(UPDATE_STEP_PREPARE)
  })

  it('defers an offline machine instead of letting it hold the outcome open', () => {
    const plan = planUpdateOperation(
      planInput({ fleet: [machine({ id: 'vmi' }), machine({ id: 'laptop', online: false })] }),
    )
    const machines = plan.steps.find((step) => step.id === UPDATE_STEP_MACHINES)
    expect(machines?.places?.map((place) => place.id)).toEqual(['vmi'])
    expect(plan.deferred).toEqual([{ id: 'laptop', name: 'laptop', reason: 'offline' }])
  })

  it('plans no machines step at all when every behind machine is asleep', () => {
    const plan = planUpdateOperation(
      planInput({ fleet: [machine({ id: 'laptop', online: false })] }),
    )
    expect(stepIds(plan)).not.toContain(UPDATE_STEP_MACHINES)
    expect(plan.deferred).toHaveLength(1)
  })

  /**
   * A supervised daemon lives inside a signed application bundle. It is
   * EXCLUDED, not deferred: deferred means "we will do this later", and this one
   * is never ours to do (§4, P5 — no surface updates someone else's native app).
   */
  it('excludes a desktop-supervised daemon from the wave and from the deferred list', () => {
    const plan = planUpdateOperation(
      planInput({ fleet: [machine({ id: 'macbook', supervised: true })] }),
    )
    expect(stepIds(plan)).not.toContain(UPDATE_STEP_MACHINES)
    expect(plan.deferred).toEqual([])
  })

  it('defers a machine that cannot take the packed artifact', () => {
    const plan = planUpdateOperation(
      planInput({
        target: packedTarget(),
        fleet: [machine({ id: 'src', deliveryCaps: ['update.delivery.git'] })],
      }),
    )
    expect(stepIds(plan)).not.toContain(UPDATE_STEP_MACHINES)
    expect(plan.deferred?.[0]).toMatchObject({ id: 'src', reason: 'cannot-take-delivery' })
  })

  /**
   * §5: in all-in-one the shell carries server + daemon + web atomically, so
   * there is nothing a runner may do. The plan is empty and the ask is REQUIRED,
   * which is precisely what makes the engine settle it into `waiting`.
   */
  it('plans an all-in-one install as a required ask and no steps at all', () => {
    const plan = planUpdateOperation(
      planInput({
        hostMachineId: 'macbook',
        fleet: [machine({ id: 'macbook', supervised: true, name: 'macbook' })],
      }),
    )
    expect(plan.steps).toEqual([])
    expect(plan.awaiting).toEqual([
      expect.objectContaining({ id: DESKTOP_INSTALL_ASK, required: true, place: 'macbook' }),
    ])
  })

  /**
   * POD-2182. The test above cannot see this defect: its machine's name and id
   * are the same word, so `place: host.id` and `place: host.name` are the same
   * string and the assertion passes either way. Here they differ, which is the
   * ordinary case — an id is `m_01j…` and a name is what its owner typed.
   *
   * `place` is read by exactly one thing, the panel's `askLine`, which appends
   * "on <place>" unless the chosen sentence already contains it. So the two
   * fields have to agree as STRINGS, not merely refer to the same machine:
   * disagreeing left a person reading "Finish this in Podium Desktop on
   * ludovico. on m_01jhost". Nothing resolves an ask by its place — the engine
   * matches on `id` — so there is no identity to preserve here.
   */
  it('names the host in the ask the way the detail does, never by machine id', () => {
    const plan = planUpdateOperation(
      planInput({
        hostMachineId: 'm_01jhost',
        fleet: [machine({ id: 'm_01jhost', supervised: true, name: 'ludovico' })],
      }),
    )
    const ask = plan.awaiting?.[0]
    expect(ask?.place).toBe('ludovico')
    expect(ask?.detail).toBe('Finish this in Podium Desktop on ludovico.')
    expect(ask?.detail).toContain(ask?.place)
  })

  /**
   * The fallback stays coherent for the same reason: an unnamed machine has
   * only its id to be called, and both fields must then use it — otherwise the
   * guard misses again in the other direction.
   */
  it('falls back to the id in both fields when the host has no name', () => {
    const plan = planUpdateOperation(
      planInput({
        hostMachineId: 'm_01jhost',
        // `name: undefined` deliberately: the helper defaults `name` to the id,
        // which would make this assertion pass without the fallback existing.
        fleet: [machine({ id: 'm_01jhost', supervised: true, name: undefined })],
      }),
    )
    const ask = plan.awaiting?.[0]
    expect(ask?.place).toBe('m_01jhost')
    expect(ask?.detail).toBe('Finish this in Podium Desktop on m_01jhost.')
  })

  /**
   * The mirror image, and the distinction the whole `required` flag exists for:
   * an idle tab that has not reloaded is a straggler who self-serves on their
   * next load, so it must NOT hold the operation open (§3.5).
   */
  it('asks open tabs to reload without letting that ask hold the operation open', () => {
    const plan = planUpdateOperation(planInput())
    const reload = plan.awaiting?.find((ask) => ask.id === RELOAD_SURFACES_ASK)
    expect(reload).toBeDefined()
    expect(reload?.required).toBe(false)
  })

  it('plans only the remainder when a retry names one', () => {
    const plan = planUpdateOperation(
      planInput({
        fleet: [machine({ id: 'vmi' }), machine({ id: 'ludovico' })],
        onlyMachines: ['ludovico'],
        retryOf: 'op_1',
      }),
    )
    const machines = plan.steps.find((step) => step.id === UPDATE_STEP_MACHINES)
    expect(machines?.places?.map((place) => place.id)).toEqual(['ludovico'])
    expect(plan.retryOf).toBe('op_1')
  })

  it('carries the target and the version it is updating FROM into details', () => {
    const plan = planUpdateOperation(planInput())
    expect(plan.details).toMatchObject({
      target: expect.objectContaining({ version: 'dev+abc1234' }),
      channel: 'dev',
      fromVersion: '0.4.1',
    })
  })
})

// ────────────────────── §3.4 / §8 reconciliation ─────────────────────

describe('reconcileUpdateOperation', () => {
  const operation = (steps: Operation['steps']): Operation => ({
    id: 'op_1',
    kind: UPDATE_OPERATION_KIND,
    state: 'running',
    details: { target: devTarget(), channel: 'dev' },
    steps,
  })

  const reality = (over: Partial<Parameters<typeof reconcileUpdateOperation>[1]> = {}) => ({
    appVersion: 'dev+abc1234',
    servedWebDigest: WEB_DIGEST,
    machineDirectory: [] as WaveMachine[],
    now: 1_000,
    ...over,
  })

  it('§8: the successor booted at the target, so the server step is done', () => {
    const next = reconcileUpdateOperation(
      operation([{ id: UPDATE_STEP_SERVER, state: 'running' }]),
      reality(),
    )
    expect(next.steps?.[0]?.state).toBe('done')
    expect(next.state).toBe('running')
  })

  /**
   * The case that today silently produces a FRESH DIALOG offering the same
   * update again, with nothing anywhere saying the swap failed.
   */
  it('§8: the successor booted on the wrong version, so the operation failed', () => {
    const next = reconcileUpdateOperation(
      operation([{ id: UPDATE_STEP_SERVER, state: 'running' }]),
      reality({ appVersion: '0.4.2' }),
    )
    expect(next.state).toBe('failed')
    expect(next.error?.code).toBe('server-did-not-reach-target')
    expect(next.error?.message).toContain('0.4.2')
    expect(next.finishedAt).toBe(1_000)
  })

  it('leaves a server step that had not started yet alone', () => {
    const next = reconcileUpdateOperation(
      operation([{ id: UPDATE_STEP_SERVER, state: 'pending' }]),
      reality({ appVersion: '0.4.1' }),
    )
    expect(next.steps?.[0]?.state).toBe('pending')
    expect(next.state).toBe('running')
  })

  it('§8: re-derives a wave mid-flight from the machine directory, not from memory', () => {
    const next = reconcileUpdateOperation(
      operation([
        {
          id: UPDATE_STEP_MACHINES,
          state: 'running',
          progress: { done: 0, total: 2 },
          places: [
            { id: 'vmi', state: 'downloading' },
            { id: 'ludovico', state: 'granted' },
          ],
        },
      ]),
      reality({
        machineDirectory: [
          machine({ id: 'vmi', version: 'dev+abc1234' }),
          machine({ id: 'ludovico', version: '0.4.1', online: false }),
        ],
      }),
    )
    const step = next.steps?.[0]
    expect(step?.places).toEqual([
      expect.objectContaining({ id: 'vmi', state: 'current' }),
      expect.objectContaining({ id: 'ludovico', state: 'offline' }),
    ])
    expect(step?.progress).toEqual({ done: 1, total: 2 })
    // Not `done` — the runner re-ensures on resume and is the one place that
    // decides a wave has finished.
    expect(step?.state).toBe('pending')
  })

  it('finishes a wave whose every machine reports the target', () => {
    const next = reconcileUpdateOperation(
      operation([
        { id: UPDATE_STEP_MACHINES, state: 'running', places: [{ id: 'vmi', state: 'granted' }] },
      ]),
      reality({ machineDirectory: [machine({ id: 'vmi', version: 'dev+abc1234' })] }),
    )
    expect(next.steps?.[0]?.state).toBe('done')
  })

  it('takes a served website at the target digest as proof the web step is done', () => {
    const next = reconcileUpdateOperation(
      operation([{ id: UPDATE_STEP_WEB, state: 'running' }]),
      reality(),
    )
    expect(next.steps?.[0]?.state).toBe('done')
  })

  it('re-queues a build that died with its process rather than waiting for its report', () => {
    for (const stepId of [UPDATE_STEP_WEB, UPDATE_STEP_PREPARE]) {
      const next = reconcileUpdateOperation(
        operation([{ id: stepId, state: 'running' }]),
        reality({ servedWebDigest: 'older99' }),
      )
      expect(next.steps?.[0]?.state).toBe('pending')
    }
  })

  /**
   * An operation whose payload names no target cannot be reconciled against
   * anything. Failing it is what stops it wedging the lifecycle group forever.
   */
  it('fails bytes that do not name a target instead of leaving the group wedged', () => {
    const next = reconcileUpdateOperation(
      { id: 'op_1', kind: UPDATE_OPERATION_KIND, state: 'running', steps: [] },
      reality(),
    )
    expect(next.state).toBe('failed')
  })
})

// ───────────────────────── §7 typed errors ───────────────────────────

describe('the error taxonomy', () => {
  const rows: Array<[string | undefined, string]> = [
    ['git delivery refused: dirty-working-tree', 'machine-dirty-checkout'],
    ['cannot converge: unsupported-delivery', 'machine-unsupported'],
    ['unsupported-platform', 'machine-unsupported'],
    ['no-artifact for linux-x64', 'machine-unsupported'],
    ['fetch failed', 'download-failed'],
    ['ECONNREFUSED 127.0.0.1:18787', 'download-failed'],
    ['The machine stopped reporting progress while updating.', 'machine-unreachable'],
    [undefined, 'machine-unreachable'],
    // POD-2210: the daemon that declined ON PURPOSE, because finishing would
    // have stopped the server sharing its process. Landing in the
    // `machine-unreachable` default would tell the operator to go and check
    // whether a machine that just answered them is running.
    [
      'cannot converge: foreground-all-in-one — this daemon shares its process with the ' +
        'Podium server and nothing would start that process again',
      'machine-cannot-restart',
    ],
  ]
  for (const [detail, code] of rows) {
    it(`reads ${JSON.stringify(detail)} as ${code}`, () => {
      expect(classifyMachineFailure(detail)).toBe(code)
    })
  }

  it('names the machine in the sentence a human reads', () => {
    const error = describeUpdateOperationFailure({
      code: 'machine-dirty-checkout',
      places: ['m_a'],
      names: ['vmi'],
      detail: 'dirty-working-tree',
    })
    expect(error.message).toContain('vmi')
    expect(error.places).toEqual(['m_a'])
    expect(error.detail).toBe('dirty-working-tree')
  })

  it('tells a foreground Podium what was NOT done, and the two ways out', () => {
    const error = describeUpdateOperationFailure({
      code: 'machine-cannot-restart',
      places: ['m_a'],
      names: ['ludovico'],
      detail: 'cannot converge: foreground-all-in-one — …',
    })
    expect(error.message).toContain('ludovico')
    expect(error.message).toMatch(/single foreground process/i)
    expect(error.message).toMatch(/nothing was changed/i)
    expect(error.message).toMatch(/start it again/i)
    expect(error.message).toMatch(/podium setup/i)
    // Never the sentence the default would have produced.
    expect(error.message).not.toMatch(/stopped responding/i)
  })

  /**
   * POD-2239. The three schema refusals, on the path a real update takes.
   *
   * The detail strings below are the daemon's OWN sentences, copied from
   * `refuseSchemaRegression` and `createSchemaGate` in apps/daemon — not
   * paraphrases. A classifier fixture that invents its input proves the
   * classifier reads the fixture, which is not the question.
   *
   * The previous version of this block had no schema row at all, so all three
   * landed in the `machine-unreachable` default and the suite ratified it.
   * These rows exist to make that collapse impossible to reintroduce quietly.
   */
  const SCHEMA_ADVANCED_DETAIL =
    "cannot converge: schema-advanced — this machine's database has applied migration " +
    "'0042_add_operations' (and 2 more), which 0.1.3 does not define, so that build would " +
    'refuse to open the database and the server would not come back. Nothing was fetched and ' +
    'nothing was swapped; this machine stays on 0.1.7, which is the version that works here. ' +
    'Going back across a migration is not something Podium can do for you — it needs a ' +
    'database restore by hand (docs/data-and-upgrades.md), because restoring silently would ' +
    'discard every write made since the schema advanced.'
  const SCHEMA_UNKNOWN_DETAIL =
    'cannot converge: schema-unknown — 0.1.5 does not declare which schema migrations it can ' +
    'open, it is not a version this machine can prove is newer than the dev+abc1234 it runs, ' +
    "and this machine's database has 12 applied, so nothing here can tell whether that build " +
    'would start against it. Nothing was fetched and nothing was swapped; this machine stays ' +
    'on dev+abc1234, which is the version that works here.'
  const SCHEMA_UNREADABLE_DETAIL =
    "cannot converge: schema-unreadable — this machine's database could not be read " +
    '(SQLITE_BUSY: database is locked), so there is no way to tell whether 0.1.5 could open ' +
    'it. Nothing was fetched and nothing was swapped; this machine stays on 0.1.7.'

  it('reads the three schema refusals as three DISTINCT codes, none of them unreachable', () => {
    const advanced = classifyMachineFailure(SCHEMA_ADVANCED_DETAIL)
    const unknown = classifyMachineFailure(SCHEMA_UNKNOWN_DETAIL)
    const unreadable = classifyMachineFailure(SCHEMA_UNREADABLE_DETAIL)

    // The defect: all three fell through to the machine that stopped answering.
    for (const code of [advanced, unknown, unreadable]) {
      expect(code).not.toBe('machine-unreachable')
    }
    // Three states of knowledge, three codes. Asserting the SET is what the
    // previous suite could not do: it asserted one collapsed sentence, which a
    // single arm matching all three satisfies just as well as three arms do.
    expect(new Set([advanced, unknown, unreadable]).size).toBe(3)
    expect(advanced).toBe('machine-schema-advanced')
    expect(unknown).toBe('machine-schema-unknown')
    expect(unreadable).toBe('machine-schema-unreadable')
  })

  const schemaCopy = (code: UpdateErrorCode, detail: string) =>
    describeUpdateOperationFailure({
      code,
      places: ['m_a'],
      names: ['vmi'],
      detail,
    } as UpdateFailure)

  it('never tells the operator a machine that answered on purpose stopped responding', () => {
    const messages = [
      schemaCopy('machine-schema-advanced', SCHEMA_ADVANCED_DETAIL).message,
      schemaCopy('machine-schema-unknown', SCHEMA_UNKNOWN_DETAIL).message,
      schemaCopy('machine-schema-unreadable', SCHEMA_UNREADABLE_DETAIL).message,
    ]
    for (const message of messages) {
      expect(message).toContain('vmi')
      // The two false claims this issue exists to delete.
      expect(message).not.toMatch(/stopped responding/i)
      expect(message).not.toMatch(/resume when it reconnects/i)
      // What is true of all three, and the first thing an operator asks.
      expect(message).toMatch(/nothing was changed/i)
    }
    // Three sentences, not one repeated three times.
    expect(new Set(messages).size).toBe(3)
  })

  it('tells a schema-advanced refusal the target is older and names the one way back', () => {
    const { message } = schemaCopy('machine-schema-advanced', SCHEMA_ADVANCED_DETAIL)
    expect(message).toMatch(/older version/i)
    expect(message).toMatch(/cannot open the data it already has/i)
    expect(message).toMatch(/at least as new/i)
    expect(message).toMatch(/restore/i)
  })

  /**
   * The arm that must assert LESS than the others. A coordinator on a source
   * build reports `dev+<sha>`, which orders against nothing published — so
   * "pick something newer" names a version that does not exist and every
   * choice returns here. The action that exists belongs to the release.
   */
  it('asserts nothing about age for a schema-unknown refusal', () => {
    const { message } = schemaCopy('machine-schema-unknown', SCHEMA_UNKNOWN_DETAIL)
    expect(message).toMatch(/does not say which data it can open/i)
    expect(message).not.toMatch(/older/i)
    expect(message).not.toMatch(/at least as new/i)
    expect(message).toMatch(/ask the server operator/i)
    expect(message).toMatch(/declares which data it can open/i)
  })

  it('sends a schema-unreadable refusal to the database file, and only there', () => {
    const { message } = schemaCopy('machine-schema-unreadable', SCHEMA_UNREADABLE_DETAIL)
    expect(message).toMatch(/could not read its own database/i)
    // It knows nothing about the target, so it must claim nothing about it.
    expect(message).not.toMatch(/older/i)
    expect(message).not.toMatch(/at least as new/i)
    expect(message).toMatch(/try again/i)
  })

  it('quotes the publisher‘s public reason for a preparation failure', () => {
    const error = describeUpdateOperationFailure({
      code: 'preparation-failed',
      detail: 'The website has not been built for HEAD yet.',
    })
    expect(error.message).toContain('The website has not been built for HEAD yet.')
  })
})

// ──────────────────────── the driven operation ───────────────────────

function fakeClock() {
  let now = 0
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const clock: OperationClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const handle = ++seq
      pending.set(handle, { at: now + ms, fn })
      return handle
    },
    clearTimeout: (handle: OperationTimerHandle) => {
      pending.delete(handle as number)
    },
  }
  return {
    clock,
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!due || due[1].at > target) break
        pending.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = target
    },
  }
}

interface HarnessOptions {
  machines?: WaveMachine[]
  target?: UpdateTarget
  appVersion?: string
  servedWebDigest?: () => string | undefined
  requestDestBundle?: () => Promise<unknown>
  requestWebRebuild?: () => void
  requestCoordinatorRestart?: () => void
  preparation?: () => { webReady: boolean; bundleReady: boolean; failureDetail?: string }
  hostMachineId?: string
  /** POD-2101: how often a watched step says it is still there. */
  heartbeatIntervalMs?: number
}

/**
 * One store, one registry, and a REAL `UpdatesService` over fake transport —
 * the wave planner, the grant protocol and the convergence bookkeeping are the
 * muscle this issue drives, so they are exercised rather than mocked.
 */
function harness(options: HarnessOptions = {}) {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  const store = new OperationStore(db)
  const clock = fakeClock()
  const sent: Array<{ machineId: string; message: UpdateGrantMessage }> = []
  const fleet = options.machines ?? [machine({ id: 'vmi' })]
  /**
   * Declared before the service that reads it: seeding a target runs
   * `setTarget`, which now asks the engine what is running, and `relay.ts` has
   * the same shape — `operations?.engine` is optional there for the same reason.
   */
  let engine: OperationEngine | undefined
  const requireEngine = (): OperationEngine => {
    if (!engine) throw new Error('harness engine is not constructed yet')
    return engine
  }
  /**
   * SINGLE-FLIGHT IS WIRED HERE BECAUSE IT IS WIRED IN `relay.ts` (POD-2228).
   *
   * The harness used to leave both of these out, so every publication in every
   * drill landed unconditionally — no test in this file could observe a target
   * being queued behind the running operation, which is exactly the half that
   * deadlocked a restart. A harness that cannot reproduce production's guards
   * cannot say no to a bug in them.
   */
  const newUpdatesService = (
    driver: () => OperationEngine | undefined,
    seed: UpdateTarget | undefined = options.target ?? devTarget(),
  ) => {
    const service = new UpdatesService({
      machines: () => fleet,
      send: (machineId, message) => sent.push({ machineId, message }),
      now: () => clock.clock.now(),
      nextGrantId: () => `grant_${sent.length + 1}`,
      concurrency: 3,
      fleetChannel: () => 'dev',
      exclusiveOperationActive: () =>
        driver()?.active(LIFECYCLE_EXCLUSION_GROUP) !== undefined,
      exclusiveOperationVersion: (channel) =>
        exclusiveUpdateVersion(driver()?.active(LIFECYCLE_EXCLUSION_GROUP), channel),
    })
    if (seed) service.setTarget('dev', seed)
    return service
  }
  const updates = newUpdatesService(() => engine)

  /** Deferred work the watchers schedule; drained explicitly, never slept on. */
  const scheduled: Array<() => void> = []
  const contextOver = (
    service: UpdatesService,
    driver: () => OperationEngine,
  ): UpdateOperationContext => ({
    updates: service,
    channel: 'dev',
    appVersion: () => options.appVersion ?? '0.4.1',
    ...(options.hostMachineId ? { hostMachineId: options.hostMachineId } : {}),
    ...(options.servedWebDigest ? { servedWebDigest: options.servedWebDigest } : {}),
    ...(options.requestDestBundle ? { requestDestBundle: options.requestDestBundle } : {}),
    ...(options.requestWebRebuild ? { requestWebRebuild: options.requestWebRebuild } : {}),
    ...(options.requestCoordinatorRestart
      ? { requestCoordinatorRestart: options.requestCoordinatorRestart }
      : {}),
    ...(options.preparation ? { preparation: options.preparation } : {}),
    report: (id, stepId, patch) => {
      void driver().recordProgress(id, stepId, patch)
    },
    // Wired exactly as `updateOperationContext` wires it, because a watcher
    // that cannot be stopped is precisely what POD-2173 was about: a harness
    // that left this out would prove the fix nothing.
    stepActive: (id, stepId) => driver().watching(id, stepId),
    schedule: (fn) => {
      scheduled.push(fn)
    },
    // The watchers' own clock is the fake one, so a heartbeat is earned by the
    // clock being advanced and never by a test sleeping (POD-2101).
    now: () => clock.clock.now(),
    ...(options.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
      : {}),
  })
  const context = (): UpdateOperationContext => contextOver(updates, requireEngine)

  const registry = new OperationKindRegistry()
  registry.register(updateOperationKind())
  let minted = 0
  engine = new OperationEngine({
    store,
    registry,
    clock: clock.clock,
    newId: () => `op_${++minted}`,
  })

  return {
    store,
    registry,
    updates,
    clock,
    sent,
    context,
    get engine() {
      return requireEngine()
    },
    /** Run everything the watchers queued, and whatever that queues in turn. */
    async drain(): Promise<void> {
      for (let guard = 0; guard < 20 && scheduled.length > 0; guard++) {
        const due = scheduled.splice(0, scheduled.length)
        for (const fn of due) fn()
        await Promise.resolve()
      }
    },
    read(id = 'op_1'): Operation {
      const operation = store.get(id)?.operation
      if (!operation) throw new Error(`operation ${id} is not readable`)
      return operation
    },
    /** A second engine over the SAME store — the successor process (§3.4). */
    successor(): OperationEngine {
      return new OperationEngine({ store, registry, clock: clock.clock })
    },
    /**
     * THE WHOLE PROCESS, REPLACED. `successor()` keeps the `UpdatesService` the
     * dead engine was using, which is fine for a drill about the operation ROW —
     * but a real restart loses every in-memory grant with the process, and a
     * successor that still believes a machine is mid-download will never plan
     * one. This is the boundary reconciliation actually crosses: same store,
     * same fleet, nothing else.
     */
    reboot(opts: { seedTarget?: UpdateTarget | undefined } = {}): {
      engine: OperationEngine
      updates: UpdatesService
      context: () => UpdateOperationContext
    } {
      const nextEngine = new OperationEngine({ store, registry, clock: clock.clock })
      // `seedTarget: undefined` is the honest shape of a successor that has not
      // published yet: `targets` is EMPTY across a restart, and pre-seeding it
      // is what hid POD-2228 from every adoption drill in this file.
      const nextUpdates =
        'seedTarget' in opts
          ? newUpdatesService(() => nextEngine, opts.seedTarget)
          : newUpdatesService(() => nextEngine)
      return {
        engine: nextEngine,
        updates: nextUpdates,
        context: () => contextOver(nextUpdates, () => nextEngine),
      }
    },
  }
}

const stepState = (operation: Operation, id: string): string | undefined =>
  operation.steps?.find((step) => step.id === id)?.state

describe('the update operation, driven', () => {
  it('runs the plan in order and reaches its first blocking step', async () => {
    const restart = vi.fn()
    const h = harness({
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
      requestCoordinatorRestart: restart,
    })
    const started = await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    expect(started.started).toBe(true)
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(stepIds({ steps: operation.steps ?? [] })).toEqual([
      UPDATE_STEP_MACHINES,
      UPDATE_STEP_SERVER,
    ])
    // The wave is in flight, so the server step has NOT been reached: the old
    // choreography expressed this ordering as a 250 ms poll loop; it is now
    // simply the order of the plan.
    expect(stepState(operation, UPDATE_STEP_MACHINES)).toBe('running')
    expect(stepState(operation, UPDATE_STEP_SERVER)).toBe('pending')
    expect(restart).not.toHaveBeenCalled()
    expect(h.sent).toHaveLength(1)
  })

  /**
   * SINGLE-FLIGHT (P6, §8's "two tabs / two users click Update"). The second
   * caller is handed the SAME operation, not an error: both tabs then render one
   * panel, which is the behaviour the whole spec is built around.
   */
  it('gives two concurrent starts one operation', async () => {
    const h = harness({ target: packedTarget(), servedWebDigest: () => WEB_DIGEST })
    const [first, second] = await Promise.all([
      h.engine.start(UPDATE_OPERATION_KIND, h.context()),
      h.engine.start(UPDATE_OPERATION_KIND, h.context()),
    ])
    const ids = [first, second].map((r) =>
      r.started ? r.operation.id : 'alreadyRunning' in r ? r.alreadyRunning : 'refused',
    )
    expect(new Set(ids).size).toBe(1)
    expect(h.store.history(UPDATE_OPERATION_KIND).length).toBe(1)
  })

  it('settles an all-in-one operation into waiting on its required ask', async () => {
    const h = harness({
      machines: [machine({ id: 'macbook', supervised: true })],
      hostMachineId: 'macbook',
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    const operation = h.read()
    expect(operation.state).toBe('waiting')
    expect(operation.awaiting?.[0]?.id).toBe(DESKTOP_INSTALL_ASK)
  })

  /**
   * NOBODY CLICKED (POD-2186).
   *
   * The panel appeared, the person closed the window, and ten minutes later the
   * grace fired. The framework's default is to complete — right when the steps
   * did the work and only a surface-local courtesy went unanswered, and wrong
   * here, where the plan has zero steps and the ask WAS the update. Completing
   * put "0.4.4 · succeeded" in Settings history against a machine still running
   * 0.4.3 and made §3.7's answer to *did last night's update finish?* a lie.
   */
  it('fails an ignored all-in-one operation rather than recording an update that never happened', async () => {
    const h = harness({
      machines: [machine({ id: 'macbook', supervised: true, name: 'macbook' })],
      hostMachineId: 'macbook',
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.read().state).toBe('waiting')

    h.clock.advance(DEFAULT_WAITING_GRACE_MS)
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe(UPDATE_NOT_INSTALLED_ERROR_CODE)
    // §7: a sentence a person reads, naming where it was offered — and one the
    // panel renders through its unknown-code fallback, so a bundle that predates
    // the code still owes the operator the truth.
    expect(operation.error?.message).toContain('macbook')
    expect(operation.error?.message).toContain('nobody installed it')
    // The ask stays listed. Failing is not pretending it was answered either.
    expect(operation.awaiting?.[0]?.id).toBe(DESKTOP_INSTALL_ASK)
  })

  /**
   * …and the other side of the same rule: a plan that DID something keeps the
   * framework's answer. The wave updated the fleet; a browser tab that never
   * reloaded is not a reason to call that a failure.
   */
  it('still completes a plan whose steps succeeded, whatever went unanswered', () => {
    const asked = (steps: Operation['steps']): Operation =>
      ({
        steps,
        awaiting: [{ id: DESKTOP_INSTALL_ASK, surface: 'desktop-all-in-one', required: true }],
      }) as Operation

    // The wave updated the fleet. A surface that never answered is not a reason
    // to call that a failure.
    expect(
      describeUpdateWaitingExpiry({
        operation: asked([{ id: UPDATE_STEP_MACHINES, state: 'done' }]),
      }),
    ).toBeUndefined()
    // A step that did not apply is not work achieved either — and the rule is
    // "did anything get done", not "is this the all-in-one plan", because the
    // question the framework asks is whether completing would be honest.
    expect(
      describeUpdateWaitingExpiry({
        operation: asked([{ id: UPDATE_STEP_MACHINES, state: 'skipped' }]),
      })?.code,
    ).toBe(UPDATE_NOT_INSTALLED_ERROR_CODE)
  })

  it('completes rather than waiting on a voluntary reload ask', async () => {
    const h = harness({
      machines: [],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    // Nothing is behind except the ask itself; the plan is empty and the
    // voluntary ask must not hold it open.
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.read().state).toBe('done')
  })
})

describe('the step runners', () => {
  it('prepare: packs once however many times ensure() runs', async () => {
    let resolvePack: (() => void) | undefined
    const requestDestBundle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePack = resolve
        }),
    )
    // A machine that can only take a bundle is what makes a pack necessary at
    // all (POD-2195); with nobody needing one the plan would not contain the
    // step this test is about.
    const h = harness({
      machines: [machine({ id: 'vmi', deliveryCaps: BUNDLE_CAPS })],
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
      requestDestBundle,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_PREPARE)).toBe('running')
    expect(requestDestBundle).toHaveBeenCalledTimes(1)

    // The engine re-enters `ensure()` on a stall retry; idempotence means the
    // second call joins the build in flight rather than starting a second one.
    h.clock.advance(21 * 60_000)
    await h.engine.whenSettled('op_1')
    expect(requestDestBundle).toHaveBeenCalledTimes(1)

    resolvePack?.()
    await h.engine.whenSettled('op_1')
  })

  it('prepare: does nothing at all when the package already exists', async () => {
    const requestDestBundle = vi.fn(() => Promise.resolve())
    const h = harness({
      machines: [],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
      requestDestBundle,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.read().steps?.some((step) => step.id === UPDATE_STEP_PREPARE)).toBe(false)
    expect(requestDestBundle).not.toHaveBeenCalled()
  })

  it('prepare: a refused pack fails the operation with the publisher‘s own words', async () => {
    const refusal = Object.assign(new Error('internal diagnostic with paths'), {
      publicReason: 'The website has not been built for HEAD (abc1234) yet.',
    })
    const h = harness({
      machines: [machine({ id: 'vmi', deliveryCaps: BUNDLE_CAPS })],
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
      requestDestBundle: () => Promise.reject(refusal),
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe('preparation-failed')
    expect(operation.error?.message).toContain('The website has not been built for HEAD')
    expect(operation.error?.message).not.toContain('internal diagnostic')
  })

  it('server: is persisted as running BEFORE the restart is requested', async () => {
    const seen: string[] = []
    const h = harness({
      machines: [],
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
      requestCoordinatorRestart: () => {
        // Read the store from inside the restart request: this is the exact
        // instant the process may stop existing, so what is on disk here is
        // everything the successor will have (§3.4).
        seen.push(stepState(h.read(), UPDATE_STEP_SERVER) ?? 'absent')
      },
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(seen).toEqual(['running'])
  })

  it('server: a server already on the target does not restart', async () => {
    const restart = vi.fn()
    const h = harness({
      machines: [],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
      requestCoordinatorRestart: restart,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(restart).not.toHaveBeenCalled()
    expect(h.read().state).toBe('done')
  })

  it('web: rebuilds once and finishes when the served stamp catches up', async () => {
    let served = 'older99'
    const requestWebRebuild = vi.fn(() => {
      /* the builder is asynchronous; the stamp flips below */
    })
    const h = harness({
      machines: [],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => served,
      requestWebRebuild,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_WEB)).toBe('running')
    expect(requestWebRebuild).toHaveBeenCalledTimes(1)

    // Still building: the watcher re-reads and re-arms, it does not conclude.
    await h.drain()
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_WEB)).toBe('running')

    served = WEB_DIGEST
    await h.drain()
    await h.engine.whenSettled('op_1')
    expect(h.read().state).toBe('done')
  })

  it('web: a failed build is a typed failure, not an indefinite wait', async () => {
    const h = harness({
      machines: [],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => 'older99',
      requestWebRebuild: () => {},
      preparation: () => ({
        webReady: false,
        bundleReady: false,
        failureDetail: 'The website could not be rebuilt for dev+abc1234. See the server log.',
      }),
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    await h.drain()
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe('web-build-failed')
  })

  it('machines: a rejected machine fails the operation with a typed, named error', async () => {
    const h = harness({
      machines: [machine({ id: 'vmi', name: 'vmi3407763' })],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')

    const bridge = createUpdateFleetBridge({ engine: h.engine, updates: h.updates, now: () => h.clock.clock.now() })
    h.updates.onStatus(asMachineId('vmi'), {
      type: 'updateStatus',
      grantId: 'grant_1',
      state: 'rejected',
      version: '0.4.1',
      detail: 'cannot converge: dirty-working-tree',
    })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe('machine-dirty-checkout')
    expect(operation.error?.message).toContain('vmi3407763')
  })

  /**
   * TRY AGAIN HAS TO BE ABLE TO CLEAR A REFUSAL (POD-2201, spec §6.2 "the
   * failure is never a dead end", §7's retry semantics).
   *
   * The panel's answer to the failure above is **Try again**, which is a NEW
   * operation — and a new operation is a new human decision. It was not one:
   * the step settled on the machine's last word before it authorized anything,
   * so `updates.start` and `updates.retry` alike failed in ten milliseconds
   * having issued zero grants and asked the machine nothing (the POD-2200 live
   * drills measured both with the grant counter). The operator was left holding
   * a button that could not work, and the only escape found on that drive was
   * publishing a different commit.
   *
   * THE GRANT COUNTER IS THE ASSERTION, not the step state: "it asked the
   * machine again" is the claim, and a step that merely stays `running` while
   * granting nobody would satisfy a weaker one.
   */
  it('machines: a new operation asks a machine that refused an earlier one again', async () => {
    const h = harness({
      machines: [machine({ id: 'vmi', name: 'vmi3407763' })],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.sent).toHaveLength(1)

    const bridge = createUpdateFleetBridge({
      engine: h.engine,
      updates: h.updates,
      now: () => h.clock.clock.now(),
    })
    h.updates.onStatus(asMachineId('vmi'), {
      type: 'updateStatus',
      grantId: 'grant_1',
      state: 'rejected',
      version: '0.4.1',
      detail: 'cannot converge: dirty-working-tree',
    })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')
    expect(h.read().state).toBe('failed')

    // Try again: the remainder, as its own operation (§3.2).
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_2')

    const retry = h.read('op_2')
    expect(h.sent.map((grant) => grant.machineId)).toEqual(['vmi', 'vmi'])
    expect(retry.state).toBe('running')
    expect(stepState(retry, UPDATE_STEP_MACHINES)).toBe('running')
  })

  /**
   * …AND THE MACHINE THAT IS STILL REFUSING IS ASKED EXACTLY ONCE.
   *
   * One grant per human decision: the retry that gets refused fails like any
   * other operation, rather than the refusal being cleared by the very thing
   * that was told about it.
   */
  it('machines: refusing the retry fails it, after exactly one new grant', async () => {
    const h = harness({
      machines: [machine({ id: 'vmi', name: 'vmi3407763' })],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    const bridge = createUpdateFleetBridge({
      engine: h.engine,
      updates: h.updates,
      now: () => h.clock.clock.now(),
    })
    const refuse = (grantId: string): void => {
      h.updates.onStatus(asMachineId('vmi'), {
        type: 'updateStatus',
        grantId,
        state: 'rejected',
        version: '0.4.1',
        detail: 'cannot converge: dirty-working-tree',
      })
      bridge.onFleetChanged()
    }

    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    refuse('grant_1')
    await h.engine.whenSettled('op_1')

    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_2')
    refuse('grant_2')
    await h.engine.whenSettled('op_2')

    const retry = h.read('op_2')
    expect(retry.state).toBe('failed')
    expect(retry.error?.code).toBe('machine-dirty-checkout')
    expect(h.sent).toHaveLength(2)
  })

  /**
   * THE LOOP GUARD, ARMED (POD-2105).
   *
   * The reason the fix above is per-place and not "forget every verdict on
   * every pass": the step is re-entered while it is still running, and a runner
   * that cleared indiscriminately would erase a refusal THIS operation was just
   * given and hand the machine another grant with no human involved — the hot
   * loop POD-2105's terminal guard exists to prevent, moved into the one path
   * that is allowed to grant.
   *
   * The re-entry here is a real one and not a contrivance: a deferred machine
   * reconnecting admits itself into the running step (§3.6), and the bridge
   * RETURNS on that path — the admission drives the runner, so it is the
   * runner's own settle that has to hold. `vmi`'s refusal is recorded without a
   * fleet event, which is what leaves the verdict standing when `laptop` walks
   * in with it.
   *
   * Proven able to fire: with the verdict cleared unconditionally instead of
   * per-place, the refusal is erased, the operation carries on as though it had
   * never been given one, and the wave grants the next machine.
   */
  it('machines: keeps the refusal THIS operation was given, across a re-entry', async () => {
    const fleet = [machine({ id: 'vmi', name: 'vmi3407763' }), machine({ id: 'laptop', online: false })]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.sent.map((grant) => grant.machineId)).toEqual(['vmi'])

    h.updates.onStatus(asMachineId('vmi'), {
      type: 'updateStatus',
      grantId: 'grant_1',
      state: 'rejected',
      version: '0.4.1',
      detail: 'cannot converge: dirty-working-tree',
    })
    fleet[1] = machine({ id: 'laptop' })
    createUpdateFleetBridge({
      engine: h.engine,
      updates: h.updates,
      now: () => h.clock.clock.now(),
    }).onFleetChanged()
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(h.sent.map((grant) => grant.machineId)).toEqual(['vmi'])
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe('machine-dirty-checkout')
  })

  /**
   * THE SEVERE ONE: A CANCEL LEFT THE OPERATOR UNABLE TO START ANOTHER UPDATE.
   *
   * A cancel does not recall a grant already sent, so the machines that held one
   * are marked `stuck` — a terminal verdict, and by the same defect the verdict
   * decided the next operation before anyone asked the machine anything. Cancel
   * is a thing an operator is invited to do; it must not be a one-way door.
   *
   * The two service calls after the cancel are the composition root's terminal
   * transition (`relay.ts`), which the kind under test does not own and this
   * harness does not wire — spelled out here rather than mocked so the state the
   * next operation meets is the state a real cancel leaves behind.
   */
  it('machines: an operation started after a cancel asks the stuck machine again', async () => {
    const h = harness({
      machines: [machine({ id: 'vmi', name: 'vmi3407763' })],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.sent).toHaveLength(1)

    expect(h.engine.cancel('op_1').canceled).toBe(true)
    await h.engine.whenSettled('op_1')
    h.updates.withdrawAuthorization()
    expect(
      h.updates.releaseInFlightGrants('The update was canceled while this machine was updating.'),
    ).toEqual(['vmi'])

    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_2')

    expect(h.sent.map((grant) => grant.machineId)).toEqual(['vmi', 'vmi'])
    expect(stepState(h.read('op_2'), UPDATE_STEP_MACHINES)).toBe('running')
  })

  /**
   * POD-2195, THE OTHER HALF. Even with the pack out of the plan, the runner
   * refused to tick until a packed descriptor was published — so the machine
   * that needed no package sat behind "Waiting for the update package." for the
   * whole of the step's deadline. The gate is real (never grant what cannot be
   * delivered) but it is a question about the MACHINES this step is waiting on,
   * and this one can take what is published today.
   */
  it('machines: grants a git-capable machine without waiting for any package', async () => {
    const h = harness({
      machines: [machine({ id: 'src', deliveryCaps: GIT_CAPS })],
      target: gitIdentityTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(stepIds({ steps: operation.steps ?? [] })).toEqual([UPDATE_STEP_MACHINES])
    expect(
      operation.steps?.find((step) => step.id === UPDATE_STEP_MACHINES)?.detail ?? '',
    ).not.toContain('Waiting for the update package')
    expect(h.sent.map((grant) => grant.machineId)).toEqual(['src'])
  })

  /**
   * …and the gate still closes for the fleet it was written for: a machine that
   * can only take a bundle is not handed a bare identity to refuse.
   */
  it('machines: still waits for the package when no awaited machine can take git', async () => {
    const h = harness({
      machines: [machine({ id: 'vmi', deliveryCaps: BUNDLE_CAPS })],
      target: gitIdentityTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
      // The pack "succeeds" without publishing a packed descriptor — which is
      // the window this gate exists for: the step after it must not hand the
      // machine a bare identity it can only refuse.
      requestDestBundle: () => Promise.resolve(),
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    await h.engine.whenSettled('op_1')

    expect(stepState(h.read(), UPDATE_STEP_PREPARE)).toBe('done')
    expect(h.read().steps?.find((step) => step.id === UPDATE_STEP_MACHINES)?.detail).toBe(
      'Waiting for the update package.',
    )
    expect(h.sent).toEqual([])
  })

  it('machines: a daemon reporting the target advances the step to done', async () => {
    const fleet = [machine({ id: 'vmi' })]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_MACHINES)).toBe('running')

    // The daemon reconnects on the new build: the machine DIRECTORY is the proof.
    fleet[0] = machine({ id: 'vmi', version: 'dev+abc1234' })
    createUpdateFleetBridge({ engine: h.engine, updates: h.updates, now: () => h.clock.clock.now() }).onFleetChanged()
    await h.engine.whenSettled('op_1')
    expect(h.read().state).toBe('done')
  })
})

// ───────────────────── §3.4 the kill-and-adopt drill ─────────────────

describe('surviving the coordinator restart', () => {
  /**
   * THE ACCEPTANCE DRILL. An operation is started, the server step is marked
   * running, the engine driving it is torn down as the process would be, and a
   * NEW engine over the same store adopts it against successor reality.
   */
  async function killAfterServerStep(appVersion: string) {
    const h = harness({
      machines: [],
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
      requestCoordinatorRestart: () => {},
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_SERVER)).toBe('running')
    // The process ends here. Nothing in memory survives; the row does.
    h.engine.stop()

    const successor = h.successor()
    await successor.adoptOnBoot(
      () => ({
        appVersion,
        servedWebDigest: WEB_DIGEST,
        machineDirectory: [] as WaveMachine[],
        now: h.clock.clock.now(),
      }),
      () => h.context(),
    )
    await successor.whenSettled('op_1')
    return h.read()
  }

  it('resumes and completes when the successor is at the target', async () => {
    const operation = await killAfterServerStep('dev+abc1234')
    expect(stepState(operation, UPDATE_STEP_SERVER)).toBe('done')
    expect(operation.state).toBe('done')
  })

  it('fails with server-did-not-reach-target when the successor is not', async () => {
    const operation = await killAfterServerStep('0.4.1')
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe('server-did-not-reach-target')
  })

  it('adopts across a restart that happened mid-wave and finishes the wave', async () => {
    const fleet = [machine({ id: 'vmi' })]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    h.engine.stop()

    fleet[0] = machine({ id: 'vmi', version: 'dev+abc1234' })
    const successor = h.successor()
    await successor.adoptOnBoot(
      () => ({
        appVersion: 'dev+abc1234',
        servedWebDigest: WEB_DIGEST,
        machineDirectory: fleet,
        now: h.clock.clock.now(),
      }),
      () => h.context(),
    )
    await successor.whenSettled('op_1')
    expect(h.read().state).toBe('done')
  })

  /**
   * THE ALL-IN-ONE ACCEPTANCE (§5, POD-2104): one click, one restart, the SAME
   * operation id reading `done` on the other side.
   *
   * This is the one shape with no steps at all, so every assertion the drills
   * above make is unavailable — there is no `server` step whose state proves the
   * restart happened. The ask is the whole operation, and the successor's own
   * version is the only evidence that it was answered.
   */
  async function killWaitingOnTheDesktopAsk(appVersion: string) {
    const h = harness({
      machines: [machine({ id: 'macbook', supervised: true })],
      hostMachineId: 'macbook',
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.read().state).toBe('waiting')
    // The user pressed Restart Podium. The shell installs and execs; this
    // process — the embedded server — dies with it.
    h.engine.stop()

    const successor = h.successor()
    await successor.adoptOnBoot(
      () => ({
        appVersion,
        servedWebDigest: WEB_DIGEST,
        machineDirectory: [machine({ id: 'macbook', supervised: true, version: appVersion })],
        now: h.clock.clock.now(),
      }),
      () => h.context(),
    )
    await successor.whenSettled('op_1')
    return h.read()
  }

  it('completes the all-in-one operation when the shell came back at the target', async () => {
    const operation = await killWaitingOnTheDesktopAsk('dev+abc1234')
    expect(operation.state).toBe('done')
    expect(operation.awaiting ?? []).toEqual([])
  })

  /**
   * The shell restarted without installing (a crash, a declined dialog, a
   * failed swap). Answering the ask here would tell the user an update they
   * never got had been applied, and the panel would stop offering the one
   * button that could still finish it.
   */
  it('keeps the desktop ask when the shell came back on the old version', async () => {
    const operation = await killWaitingOnTheDesktopAsk('0.4.1')
    expect(operation.state).toBe('waiting')
    expect(operation.awaiting?.[0]?.id).toBe(DESKTOP_INSTALL_ASK)
  })

  /**
   * THE WINDOW THE OTHER DRILLS STEP OVER (POD-2167).
   *
   * Every case above hands the successor a machine that is already at the
   * target — so the wave has nothing left to do and adoption looks complete.
   * The real boot is not like that: `adoptOnBoot` is awaited BEFORE the daemon
   * gateway listens (`server.ts`), so the resumed `machines` step runs its
   * `ensure()` against a fleet in which every machine is offline. It grants
   * nobody, answers `running`, and the daemons arrive seconds later.
   *
   * Until now nothing carried that arrival back into the step. The reconnect
   * reached the bridge, which recorded progress and re-armed a deadline, and the
   * wave sat at zero grants for its whole ten-minute silence budget — the STALL
   * RETRY was what issued the first grant. An update resumed, but not restarted.
   */
  it('re-drives the wave when the daemons reconnect, instead of waiting out the stall', async () => {
    const fleet = [machine({ id: 'vmi', name: 'vmi3407763' })]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.sent).toHaveLength(1)
    h.engine.stop()

    // The wave had been running a while when the coordinator went down — long
    // enough that the places carry stamps older than the whole silence budget.
    // A successor judged on those would stall the instant it resumed, on the
    // predecessor's silence rather than on any of its own.
    h.clock.advance((UPDATE_STEP_DEADLINES[UPDATE_STEP_MACHINES]?.silenceMs ?? 0) + 60_000)

    // The coordinator restarts. The daemon gateway is not listening yet, so the
    // machine directory this boot reads says everyone is unreachable.
    fleet[0] = machine({ id: 'vmi', name: 'vmi3407763', online: false })
    const boot = h.reboot()
    const sentBefore = h.sent.length
    await boot.engine.adoptOnBoot(
      () => ({
        appVersion: 'dev+abc1234',
        servedWebDigest: WEB_DIGEST,
        machineDirectory: fleet,
        now: h.clock.clock.now(),
      }),
      () => boot.context(),
    )
    await boot.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_MACHINES)).toBe('running')
    expect(h.sent).toHaveLength(sentBefore)

    // …and now the daemon reconnects, well inside the silence budget.
    const bridge = createUpdateFleetBridge({
      engine: boot.engine,
      updates: boot.updates,
      now: () => h.clock.clock.now(),
    })
    h.clock.advance(3_000)
    fleet[0] = machine({ id: 'vmi', name: 'vmi3407763' })
    bridge.onFleetChanged()
    await boot.engine.whenSettled('op_1')

    // A grant, three seconds after the reconnect — not ten minutes after it.
    expect(h.sent.length).toBeGreaterThan(sentBefore)
    expect(h.sent.at(-1)?.machineId).toBe('vmi')
    expect(h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)?.stalls ?? 0).toBe(0)
  })

  /**
   * THE OTHER HALF OF POD-2227, WHERE A PERSON CAN SEE IT.
   *
   * A source coordinator with a paired machine and no configured address knows
   * exactly what is wrong. It wrote it to its own log, packed the tarball
   * anyway, reported "The update package is ready." and left the `machines`
   * step on "Waiting for the update package." with nothing to click. §6.2 says
   * a failure is never a dead end; §7 says it names itself and the next action.
   */
  it('fails the update with the configuration remedy instead of waiting for a package', async () => {
    const h = harness({
      machines: [machine({ id: 'vmi', deliveryCaps: BUNDLE_CAPS })],
      servedWebDigest: () => WEB_DIGEST,
      appVersion: 'dev+abc1234',
      requestDestBundle: () =>
        Promise.reject(
          new DevBundleUnavailableError(
            'development artifact publishing requires PODIUM_DEV_ARTIFACT_BASE_URL or ' +
              'config.publicUrl while remote managed machines are registered',
            ARTIFACT_ORIGIN_UNCONFIGURED_REASON,
          ),
        ),
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    await h.drain()
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(stepState(operation, UPDATE_STEP_PREPARE)).toBe('failed')
    expect(operation.state).toBe('failed')
    // The remedy is in the sentence the panel shows, not only in the log.
    expect(operation.error?.message).toMatch(/Public URL/)
    expect(operation.error?.message).toMatch(/PODIUM_DEV_ARTIFACT_BASE_URL/)
    // It gave up rather than granting anything it could not deliver.
    expect(h.sent).toHaveLength(0)
  })

  /**
   * THE DEADLOCK THIS EPIC'S CENTRAL CLAIM WAS HIDING (POD-2228).
   *
   * Adoption across a restart is proven; what was not proven is that an adopted
   * operation can still be COMPLETED. The successor's `targets` map is empty, so
   * when the resumed `prepare` finished its pack and the publisher offered the
   * tarball, single-flight read that publication as a rival version and queued
   * it. The `machines` step then waited for a package this very process was
   * holding back, forever, and no other version could be published on the
   * channel until a human cancelled the operation.
   *
   * Measured live on 2026-08-17: `/version` served `dev+a094223` with its full
   * bundle while `updates.fleet` reported `targetVersion: null`, and cancelling
   * the operation published it instantly with nothing else changed.
   */
  it('completes an operation adopted across a restart, package and all', async () => {
    const fleet = [machine({ id: 'vmi', deliveryCaps: BUNDLE_CAPS })]
    // The publisher republishes into whichever process is alive — which is the
    // whole point: after the restart that is the successor, with no memory.
    let publisher: UpdatesService | undefined
    const packed = packedTarget()
    const h = harness({
      machines: fleet,
      servedWebDigest: () => WEB_DIGEST,
      appVersion: 'dev+abc1234',
      requestDestBundle: async () => {
        publisher?.setTarget('dev', packed)
      },
    })
    publisher = h.updates
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    expect(h.read().steps?.map((step) => step.id)).toContain(UPDATE_STEP_PREPARE)

    // Down mid-update, before the pack was published.
    h.engine.stop()
    const sentBefore = h.sent.length

    const boot = h.reboot({ seedTarget: undefined })
    publisher = boot.updates
    await boot.engine.adoptOnBoot(
      () => ({
        appVersion: 'dev+abc1234',
        servedWebDigest: WEB_DIGEST,
        machineDirectory: fleet,
        now: h.clock.clock.now(),
      }),
      () => boot.context(),
    )
    await boot.engine.whenSettled('op_1')
    await h.drain()
    await boot.engine.whenSettled('op_1')

    // The package the adopted operation was waiting for is PUBLISHED, not
    // parked behind it…
    expect(boot.updates.target('dev')?.artifacts.headless).toBeDefined()
    expect(boot.updates.nextTarget('dev')).toBeUndefined()
    // …the step it was blocking got its grant…
    expect(stepState(h.read(), UPDATE_STEP_PREPARE)).toBe('done')
    expect(h.sent.length).toBeGreaterThan(sentBefore)
    // …and it is not still saying it has nothing to hand anyone.
    expect(h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)?.detail).not.toBe(
      'Waiting for the update package.',
    )
  })
})

// ────────────────── §3.2 single-flight and nextTarget ────────────────

describe('a version published mid-operation', () => {
  function service(active: () => boolean, deliveringVersion?: () => string | undefined) {
    const sent: string[] = []
    const updates = new UpdatesService({
      machines: () => [machine({ id: 'vmi' })],
      send: (machineId) => sent.push(machineId),
      now: () => 0,
      nextGrantId: () => 'grant_1',
      concurrency: 3,
      fleetChannel: () => 'dev',
      exclusiveOperationActive: active,
      ...(deliveringVersion
        ? { exclusiveOperationVersion: (channel: UpdateChannel) =>
            channel === 'dev' ? deliveringVersion() : undefined }
        : {}),
    })
    return { updates, sent }
  }

  it('queues a NEW version instead of mutating the running wave', () => {
    let running = false
    const { updates } = service(() => running)
    updates.setTarget('dev', devTarget({ version: '0.4.3' }))
    expect(updates.target('dev')?.version).toBe('0.4.3')

    updates.authorize('dev')
    running = true
    updates.setTarget('dev', devTarget({ version: '0.4.4' }))
    // The running wave is untouched…
    expect(updates.target('dev')?.version).toBe('0.4.3')
    // …and the newcomer is waiting its turn, visibly.
    expect(updates.nextTarget('dev')?.version).toBe('0.4.4')
  })

  it('publishes the queued version when the operation terminates, as an OFFER', () => {
    let running = false
    const { updates, sent } = service(() => running)
    updates.setTarget('dev', devTarget({ version: '0.4.3' }))
    updates.authorize('dev')
    const grantsBefore = sent.length

    running = true
    updates.setTarget('dev', devTarget({ version: '0.4.4' }))
    running = false
    expect(updates.publishNextTargets()).toEqual(['dev'])

    expect(updates.target('dev')?.version).toBe('0.4.4')
    expect(updates.nextTarget('dev')).toBeUndefined()
    // An offer, not an operation: nothing was granted by the publication.
    expect(sent.length).toBe(grantsBefore)
  })

  /**
   * The one publication that must NOT be queued: the development identity
   * acquiring the tarball it is about to deliver. It is the SAME version, and
   * the running operation is waiting for exactly those bytes.
   */
  it('lets the same version gain its packed artifact mid-operation', () => {
    let running = false
    const { updates } = service(() => running)
    updates.setTarget('dev', devTarget())
    running = true
    updates.setTarget('dev', packedTarget())
    expect(updates.target('dev')?.artifacts.headless).toBeDefined()
    expect(updates.nextTarget('dev')).toBeUndefined()
  })

  /**
   * THE SAME PUBLICATION, AFTER A RESTART (POD-2228).
   *
   * The test above is the whole of what the guard could recognise: it matched
   * the arriving version against the target already in memory. A successor
   * process has no such memory — `targets` is empty — so the operation it just
   * adopted was starved of the very bytes it was waiting for, and the channel
   * was blocked for everyone else until a human cancelled it. The operation
   * knows the version it is delivering; that is the fact the guard must ask.
   */
  it('lets an ADOPTED operation gain its packed artifact with nothing in memory', () => {
    const { updates } = service(
      () => true,
      () => 'dev+abc1234',
    )
    expect(updates.target('dev')).toBeUndefined()
    updates.setTarget('dev', packedTarget())
    expect(updates.target('dev')?.artifacts.headless).toBeDefined()
    expect(updates.nextTarget('dev')).toBeUndefined()
  })

  /** …and a version the running operation is NOT delivering is still queued. */
  it('still queues a version the running operation is not delivering', () => {
    const { updates } = service(
      () => true,
      () => 'dev+abc1234',
    )
    updates.setTarget('dev', devTarget({ version: '0.4.4' }))
    expect(updates.target('dev')).toBeUndefined()
    expect(updates.nextTarget('dev')?.version).toBe('0.4.4')
  })

  /**
   * THE DELETED BEHAVIOUR (spec §10.2). Re-publishing a descriptor used to also
   * tick an authorized wave, which made publishing a way to start granting.
   * Sequencing belongs to the operation now.
   */
  it('does not grant anything just because a descriptor was re-published', () => {
    const { updates, sent } = service(() => false)
    updates.setTarget('dev', devTarget())
    updates.markAuthorized('dev')
    const before = sent.length
    updates.setTarget('dev', packedTarget())
    expect(sent.length).toBe(before)
  })

  it('drops a queued version for a channel that can no longer advertise one', () => {
    const { updates } = service(() => true)
    updates.setTarget('dev', devTarget({ version: '0.4.3' }))
    updates.setTarget('dev', devTarget({ version: '0.4.4' }))
    expect(updates.nextTarget('dev')).toBeDefined()
    updates.setTargetUnavailable('dev', 'nothing published for this commit')
    expect(updates.nextTarget('dev')).toBeUndefined()
  })
})

describe('the fleet bridge', () => {
  it('is silent when no update operation is running', () => {
    const h = harness()
    const recordProgress = vi.fn(() => Promise.resolve())
    const admitDeferred = vi.fn(() => Promise.resolve())
    createUpdateFleetBridge({
      engine: {
        active: () => undefined,
        recordProgress,
        admitDeferred,
        reensure: () => Promise.resolve(),
      },
      updates: h.updates,
    }).onFleetChanged()
    expect(recordProgress).not.toHaveBeenCalled()
    expect(admitDeferred).not.toHaveBeenCalled()
  })

  it('stamps the heartbeat on every accepted fleet event', async () => {
    const h = harness({
      machines: [machine({ id: 'vmi' })],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    const before = h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)?.lastProgressAt

    h.clock.advance(1_000)
    h.updates.onStatus(asMachineId('vmi'), {
      type: 'updateStatus',
      grantId: 'grant_1',
      state: 'downloading',
      version: '0.4.1',
    })
    createUpdateFleetBridge({ engine: h.engine, updates: h.updates, now: () => h.clock.clock.now() }).onFleetChanged()
    await h.engine.whenSettled('op_1')

    const step = h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)
    expect(step?.lastProgressAt).toBeGreaterThan(before ?? 0)
    expect(step?.places?.[0]).toMatchObject({ id: 'vmi', state: 'downloading' })
  })

  /**
   * §3.6, THE MID-OPERATION RECONNECT. A machine that was asleep at plan time is
   * `deferred` — the operation's honest note that it is not waiting for it. If
   * it wakes up while its own step is STILL RUNNING, that note stops being true,
   * and it has to stop being true in one move: a place in neither list is
   * invisible, and a place in both is counted twice by everyone reading the
   * operation.
   */
  it('admits a deferred machine that reconnects while the wave is still running', async () => {
    const fleet = [machine({ id: 'vmi' }), machine({ id: 'laptop', online: false })]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.read().deferred).toEqual([{ id: 'laptop', name: 'laptop', reason: 'offline' }])

    fleet[1] = machine({ id: 'laptop' })
    createUpdateFleetBridge({ engine: h.engine, updates: h.updates, now: () => h.clock.clock.now() }).onFleetChanged()
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(operation.deferred).toEqual([])
    const step = operation.steps?.find((s) => s.id === UPDATE_STEP_MACHINES)
    expect(step?.places?.map((place) => place.id)).toEqual(['vmi', 'laptop'])
    expect(step?.progress).toEqual({ done: 0, total: 2 })
  })

  /**
   * …AND SOMETHING ACTUALLY ACTS ON IT (POD-2187).
   *
   * The case above asserts the place appears, which was the half that worked.
   * The missing half is this one, and it is the whole point of admitting a
   * machine at all: `machinesRunner.ensure` is the only thing in the system that
   * hands out a grant, and nothing on the admission path used to re-enter it.
   * The step then had a place it was counting and had asked nothing of.
   *
   * THREE MACHINES, not two, and that is the review's scenario rather than a
   * bigger version of it: the canary must already be PROVED when the laptop
   * wakes, or `planWave` is refusing to widen for its own good reason and the
   * missing drive is invisible behind it. So `vmi` converges first, `vps` is
   * still going — which is what keeps the step running — and the laptop arrives
   * into a wave that has room for it.
   *
   * NO CLOCK IS MOVED HERE, deliberately. The old code did eventually grant the
   * laptop — ten minutes later, when the step's silence budget stalled it and
   * the stall retry called `ensure()`. That is the defect stated exactly: a
   * "stalled" step shown to an operator for ten minutes for nothing, and the
   * operation's ONE permitted stall spent, so the next genuine silence failed
   * the update outright. Asserting the grant against an unmoved clock is what
   * separates "granted at admission" from "granted by the stall".
   */
  it('grants the machine it just admitted, instead of waiting out the silence budget', async () => {
    const fleet = [
      machine({ id: 'vmi' }),
      machine({ id: 'vps' }),
      machine({ id: 'laptop', online: false }),
    ]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.sent.map((grant) => grant.machineId)).toEqual(['vmi'])

    const bridge = createUpdateFleetBridge({
      engine: h.engine,
      updates: h.updates,
      now: () => h.clock.clock.now(),
    })
    fleet[0] = machine({ id: 'vmi', version: 'dev+abc1234' })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')
    expect(h.sent.map((grant) => grant.machineId)).toEqual(['vmi', 'vps'])
    expect(stepState(h.read(), UPDATE_STEP_MACHINES)).toBe('running')
    const before = h.clock.clock.now()

    fleet[2] = machine({ id: 'laptop' })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')

    expect(h.sent.map((grant) => grant.machineId)).toEqual(['vmi', 'vps', 'laptop'])
    expect(h.clock.clock.now()).toBe(before)
    const step = h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)
    // The place the panel names is a place with a grant against it, not one
    // still `pending` because its turn never came.
    expect(step?.places?.find((place) => place.id === 'laptop')?.state).not.toBe('pending')
    expect(step?.state).toBe('running')
  })

  /**
   * …and the other half of the same sentence: once the wave is over it stays
   * deferred, because the operation is no longer the thing that would carry it.
   * The standing reconciler is, and that is the honest outcome rather than a
   * fallback.
   */
  it('leaves a machine deferred when it reconnects after the wave finished', async () => {
    const fleet = [machine({ id: 'vmi' }), machine({ id: 'laptop', online: false })]
    // A server step AFTER the wave, so the operation is still RUNNING when the
    // laptop wakes up: that is what puts the finished-STEP guard under test
    // rather than the terminal-OPERATION one, which would refuse for a reason
    // this case is not about.
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
      requestCoordinatorRestart: vi.fn(),
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')

    // `vmi` arrives, which is the whole of the planned wave.
    fleet[0] = machine({ id: 'vmi', version: 'dev+abc1234' })
    const bridge = createUpdateFleetBridge({ engine: h.engine, updates: h.updates, now: () => h.clock.clock.now() })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_MACHINES)).toBe('done')
    expect(h.read().state).toBe('running')

    fleet[1] = machine({ id: 'laptop' })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')

    expect(h.read().deferred).toEqual([{ id: 'laptop', name: 'laptop', reason: 'offline' }])
  })

  /** A daemon that became desktop-supervised while it slept is the SHELL's now,
   *  whatever the plan said when it was still an ordinary fleet machine (§4, P5). */
  it('does not admit a reconnected machine a desktop app has since claimed', async () => {
    const fleet = [machine({ id: 'vmi' }), machine({ id: 'laptop', online: false })]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')

    fleet[1] = machine({ id: 'laptop', supervised: true })
    createUpdateFleetBridge({ engine: h.engine, updates: h.updates, now: () => h.clock.clock.now() }).onFleetChanged()
    await h.engine.whenSettled('op_1')

    expect(h.read().deferred).toEqual([{ id: 'laptop', name: 'laptop', reason: 'offline' }])
    const step = h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)
    expect(step?.places?.map((place) => place.id)).toEqual(['vmi'])
  })

  /**
   * …and the same exclusion when the caps question CANNOT answer it.
   *
   * The case above is guarded twice over: a packed target offers a delivery, and
   * `machineCanTakeDelivery` refuses a supervised daemon whatever its caps say.
   * While the target is still a bare `dev+<sha>` identity it offers NOTHING, so
   * that question is skipped for everyone — and the supervised exclusion is the
   * only thing standing between a wave and the inside of a signed .app.
   */
  it('excludes a supervised daemon even from a target that offers no delivery yet', () => {
    const fleet = [machine({ id: 'laptop', supervised: true })]
    const h = harness({ machines: fleet })
    const operation = {
      id: 'op_1',
      kind: UPDATE_OPERATION_KIND,
      state: 'running',
      deferred: [{ id: 'laptop', name: 'laptop', reason: 'offline' }],
    } as Operation

    expect(offeredDeliveries(devTarget())).toEqual([])
    expect(
      admissibleDeferredPlaces(operation, { target: devTarget(), channel: 'dev' }, h.updates),
    ).toEqual([])
  })
})

describe('§3.2 the cancel boundary', () => {
  it('allows cancel while the wave is the step in flight', async () => {
    const h = harness({ target: packedTarget(), servedWebDigest: () => WEB_DIGEST })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_MACHINES)).toBe('running')
    expect(h.engine.cancel('op_1')).toMatchObject({ canceled: true })
  })

  it('refuses cancel from the server swap onward', async () => {
    const h = harness({
      machines: [],
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
      requestCoordinatorRestart: () => {},
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_SERVER)).toBe('running')
    expect(h.engine.cancel('op_1')).toMatchObject({
      canceled: false,
      refused: 'irreversible',
      step: UPDATE_STEP_SERVER,
    })
  })
})

describe('the exclusion group', () => {
  it('is the one a server move will join, not one per kind', () => {
    expect(updateOperationKind().exclusionGroup).toBe(LIFECYCLE_EXCLUSION_GROUP)
    expect(LIFECYCLE_EXCLUSION_GROUP).toBe('lifecycle')
  })
})

// ──────────────────── §3.3 liveness (POD-2101) ────────────────────

/**
 * ONE TABLE, AND IT HAS TO NEST. Every number below belongs to a different
 * process — a daemon's download timeout, its git budget, this server's step
 * deadlines — and the only thing that keeps them coherent is that somebody
 * asserts the order they have to be in.
 */
describe('the budgets nest', () => {
  const machines = UPDATE_STEP_DEADLINES[UPDATE_STEP_MACHINES]
  const prepare = UPDATE_STEP_DEADLINES[UPDATE_STEP_PREPARE]
  const web = UPDATE_STEP_DEADLINES[UPDATE_STEP_WEB]
  const server = UPDATE_STEP_DEADLINES[UPDATE_STEP_SERVER]

  it('lets a daemon fail on its OWN deadline before the coordinator gives up on it', () => {
    // Otherwise the machine's real reason — a dead remote, a refused checkout —
    // is replaced by the coordinator's guess that it went quiet.
    expect(UPDATE_BUDGETS.downloadTimeoutMs).toBeLessThan(machines?.silenceMs ?? 0)
    expect(UPDATE_BUDGETS.gitConvergenceMs).toBeLessThan(machines?.silenceMs ?? 0)
  })

  it('measures the wave against the LONGEST legitimate silence, not the cadence', () => {
    // A daemon that predates `percent` reports `downloading` once and works in
    // silence for its whole budget. Judging the step on the heartbeat cadence
    // would stall and re-grant that machine mid-transfer, every time.
    expect(machines?.silenceMs).toBe(
      UPDATE_BUDGETS.gitConvergenceMs + UPDATE_BUDGETS.machineSilenceMarginMs,
    )
    expect(UPDATE_BUDGETS.downloadHeartbeatMs).toBeLessThan(machines?.silenceMs ?? 0)
  })

  it('keeps every silence budget inside its own step total', () => {
    for (const budget of [machines, prepare, web, server]) {
      if (budget?.silenceMs === undefined || budget.totalMs === undefined) continue
      expect(budget.silenceMs).toBeLessThan(budget.totalMs)
    }
  })

  it('beats faster than the panel calls a step stale', () => {
    // The panel's threshold is sixty seconds (POD-2102); four beats inside it
    // means one lost tick never reads as trouble.
    expect(STEP_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(60_000 / 4)
    for (const budget of [prepare, web]) {
      expect(STEP_HEARTBEAT_INTERVAL_MS).toBeLessThan(budget?.silenceMs ?? Infinity)
    }
  })
})

describe('a step that hands work off still says it is there', () => {
  it('prepare: heartbeats with elapsed time while the pack runs', async () => {
    // A pack is quiet for minutes; the panel calls sixty seconds of quiet
    // trouble. Both were true before this, which is why it said "stuck".
    const h = harness({ requestDestBundle: () => new Promise(() => {}) })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    const before = h.read().steps?.find((s) => s.id === UPDATE_STEP_PREPARE)?.lastProgressAt ?? 0

    h.clock.advance(STEP_HEARTBEAT_INTERVAL_MS)
    await h.drain()
    await h.engine.whenSettled('op_1')

    const step = h.read().steps?.find((s) => s.id === UPDATE_STEP_PREPARE)
    expect(step?.state).toBe('running')
    expect(step?.lastProgressAt).toBeGreaterThan(before)
    expect(step?.detail).toContain('15s')
  })

  it('prepare: says nothing more once the pack has answered', async () => {
    let settle = (): void => {}
    const h = harness({
      requestDestBundle: () => new Promise<void>((resolve) => (settle = resolve)),
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')

    settle()
    await Promise.resolve()
    await h.engine.whenSettled('op_1')
    const settledAt = h.read().steps?.find((s) => s.id === UPDATE_STEP_PREPARE)?.lastProgressAt ?? 0

    h.clock.advance(STEP_HEARTBEAT_INTERVAL_MS * 4)
    await h.drain()
    await h.engine.whenSettled('op_1')

    // The outcome came from the pack settling, not from a watcher still ticking.
    expect(h.read().steps?.find((s) => s.id === UPDATE_STEP_PREPARE)?.lastProgressAt).toBe(
      settledAt,
    )
  })

  it('web: heartbeats with elapsed time while the rebuild runs', async () => {
    const h = harness({
      machines: [],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => 'older99',
      requestWebRebuild: () => {},
      preparation: () => ({ webReady: false, bundleReady: false }),
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_WEB)).toBe('running')

    h.clock.advance(STEP_HEARTBEAT_INTERVAL_MS)
    await h.drain()
    await h.engine.whenSettled('op_1')

    const step = h.read().steps?.find((s) => s.id === UPDATE_STEP_WEB)
    expect(step?.state).toBe('running')
    expect(step?.detail).toContain('Rebuilding the app')
    expect(step?.detail).toContain('15s')
  })
})

/**
 * THE DRILL THE OLD DESIGN COULD NOT PASS. Nothing here reads `fleet()`, no
 * panel is open, no poller exists: the only thing that happens is that time
 * passes. The grant deadline used to age inside a `fleet()` read, so this whole
 * sequence would have produced exactly nothing.
 */
describe('a silent grant, with nobody watching', () => {
  const silentWave = () =>
    harness({
      machines: [machine({ id: 'vmi', name: 'vmi3407763' })],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
  const silenceMs = UPDATE_STEP_DEADLINES[UPDATE_STEP_MACHINES]?.silenceMs ?? 0

  it('stalls visibly, re-issues the grant once, then fails', async () => {
    const h = silentWave()
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.sent).toHaveLength(1)

    h.clock.advance(silenceMs)
    await h.engine.whenSettled('op_1')

    // ONE retry, and a retry here MEANS re-issuing the grant: the wave planner
    // skips a machine it believes is mid-grant, so a plain tick would have
    // granted nobody and changed nothing.
    const step = h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)
    expect(step?.stalls).toBe(1)
    expect(step?.state).toBe('running')
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.machineId).toBe('vmi')

    h.clock.advance(silenceMs)
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(operation.state).toBe('failed')
    // AND IT SAYS WHO (POD-2167). This used to be a bare `stalled` with no
    // places — the generic sentence, on the one failure §7 invented `places`
    // for. The machine whose own clock ran out is named, in the code, in the
    // list, and in the sentence a human reads.
    expect(operation.error?.code).toBe('machine-unreachable')
    expect(operation.error?.places).toEqual(['vmi'])
    expect(operation.error?.message).toContain('vmi3407763')
    // And the coordinator stops believing in the grant it was waiting on, so
    // the machine is not excluded from every future wave (POD-2101).
    expect(h.updates.releaseInFlightGrants()).toEqual(['vmi'])
  })

  it('a heartbeat re-arms the deadline, so a slow download is not a stalled one', async () => {
    const h = silentWave()
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    const bridge = createUpdateFleetBridge({ engine: h.engine, updates: h.updates, now: () => h.clock.clock.now() })

    for (const percent of [20, 55, 91]) {
      h.clock.advance(silenceMs - 60_000)
      h.updates.onStatus(asMachineId('vmi'), {
        type: 'updateStatus',
        grantId: 'grant_1',
        state: 'downloading',
        version: '0.4.1',
        percent,
      })
      bridge.onFleetChanged()
      await h.engine.whenSettled('op_1')

      const step = h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)
      expect(step?.state).toBe('running')
      expect(step?.stalls ?? 0).toBe(0)
      // "vmi3407763 downloading 62%" (§6.2) — the number the panel renders.
      expect(step?.places?.[0]).toMatchObject({ id: 'vmi', state: 'downloading', percent })
    }
    // Three quarters of an hour of a healthy download, never once stalled.
    expect(h.read().state).toBe('running')
  })

  it('drops the percentage from a place that is no longer moving', async () => {
    const h = silentWave()
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    const bridge = createUpdateFleetBridge({ engine: h.engine, updates: h.updates, now: () => h.clock.clock.now() })

    h.updates.onStatus(asMachineId('vmi'), {
      type: 'updateStatus',
      grantId: 'grant_1',
      state: 'downloading',
      version: '0.4.1',
      percent: 62,
    })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')
    h.updates.onStatus(asMachineId('vmi'), {
      type: 'updateStatus',
      grantId: 'grant_1',
      state: 'restarting',
      version: '0.4.1',
    })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')

    const place = h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)?.places?.[0]
    expect(place).toMatchObject({ state: 'restarting' })
    expect(place).not.toHaveProperty('percent')
  })
})

/**
 * THE FLEET SIZE THE OLD DESIGN COULD NOT SEE (POD-2167).
 *
 * Every stall case above has ONE machine — the only fleet size where the step's
 * silence and a machine's silence are the same number. With two, the difference
 * is the whole defect: the step's single `lastProgressAt` was stamped by any
 * fleet event from anyone, so a healthy machine's two-second heartbeats held the
 * budget open over a dead one for as long as the healthy one kept working.
 */
describe('two machines, one of them dead', () => {
  const silenceMs = UPDATE_STEP_DEADLINES[UPDATE_STEP_MACHINES]?.silenceMs ?? 0
  const machinesStep = (h: ReturnType<typeof harness>) =>
    h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)

  /**
   * A wave grants a CANARY alone and only widens once it is healthy, so the
   * fleet that can have two machines in flight at once needs three: `canary`
   * converges, then `busy` and `silent` are granted together — the shape the
   * whole defect lives in.
   */
  const trio = () => {
    const fleet = [
      machine({ id: 'a-canary', name: 'macbook' }),
      machine({ id: 'busy', name: 'ludovico' }),
      machine({ id: 'silent', name: 'vmi3407763' }),
    ]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    const bridge = createUpdateFleetBridge({ engine: h.engine, updates: h.updates, now: () => h.clock.clock.now() })
    return {
      ...h,
      bridge,
      /** Take the canary all the way to the target — proof, not optimism. */
      async openTheWave(): Promise<void> {
        await h.engine.start(UPDATE_OPERATION_KIND, h.context())
        await h.engine.whenSettled('op_1')
        const canary = fleet[0]
        if (canary) canary.version = 'dev+abc1234'
        h.updates.onStatus(asMachineId('a-canary'), {
          type: 'updateStatus',
          grantId: 'grant_1',
          state: 'current',
          version: 'dev+abc1234',
        })
        // The canary's own frame goes through the bridge in production, and it
        // is what first projects the widened wave — so this is where the two
        // newly granted machines get their clocks.
        bridge.onFleetChanged()
        await h.engine.whenSettled('op_1')
      },
    }
  }

  /**
   * WHICH MACHINES HAVE BEEN GRANTED SOMETHING, once each.
   *
   * Deliberately a set rather than the message sequence: `tick()` reads
   * `fleet()`, `fleet()` continues a ready wave by calling `tick()` back, and the
   * outer call then plans against the snapshot it took before the inner one
   * granted anything — so widening past the canary sends every newly selected
   * machine a second grant. That is a coordinator defect of its own (filed), it
   * predates this work, and the daemon supersedes the duplicate; asserting on the
   * raw sequence here would only tie these cases to it.
   */
  const grantedMachines = (h: { sent: Array<{ machineId: string }> }): string[] => [
    ...new Set(h.sent.map((grant) => grant.machineId)),
  ]

  /** The grant this machine is actually holding — a status quoting any other is inert. */
  const grantIdFor = (h: { sent: Array<{ machineId: string; message: { grantId?: string } }> }, id: string) =>
    [...h.sent].reverse().find((grant) => grant.machineId === id)?.message.grantId

  /** One machine reports a fresh percentage; the others say nothing, ever. */
  const reports = (
    h: ReturnType<typeof harness>,
    bridge: { onFleetChanged: () => void },
    id: string,
    percent: number,
  ) => {
    h.updates.onStatus(asMachineId(id), {
      type: 'updateStatus',
      ...(grantIdFor(h, id) ? { grantId: grantIdFor(h, id) } : {}),
      state: 'downloading',
      version: '0.4.1',
      percent,
    })
    bridge.onFleetChanged()
  }
  const busyReports = (
    h: ReturnType<typeof harness>,
    bridge: { onFleetChanged: () => void },
    percent: number,
  ) => reports(h, bridge, 'busy', percent)

  it('stalls on the silent one while the other is still talking', async () => {
    const h = trio()
    await h.openTheWave()
    // The canary, then both of the others: two machines in flight at once.
    expect(grantedMachines(h)).toEqual(['a-canary', 'busy', 'silent'])
    const bridge = h.bridge

    // Ten one-minute steps of a perfectly healthy download on the other
    // machine. Under the step's single clock every one of these re-armed the
    // budget, and `silent` could not be noticed until `busy` had finished.
    for (let minute = 1; minute <= 10; minute++) {
      h.clock.advance(60_000)
      busyReports(h, bridge, minute * 9)
      await h.engine.whenSettled('op_1')
    }

    const step = machinesStep(h)
    expect(step?.stalls).toBe(1)
    // The retry is a RE-ISSUED grant, and it went to the machine that stopped —
    // the wave planner skips a machine it believes is mid-grant, so a plain tick
    // would have selected nobody and changed nothing.
    expect(h.sent.at(-1)?.machineId).toBe('silent')
    // …and the wave was never failed out from under the healthy machine.
    expect(h.read().state).toBe('running')
  })

  it('gives the retry its own window instead of failing it on inherited silence', async () => {
    const h = trio()
    await h.openTheWave()
    const bridge = h.bridge

    h.clock.advance(silenceMs)
    await h.engine.whenSettled('op_1')
    expect(machinesStep(h)?.stalls).toBe(1)
    expect(machinesStep(h)?.state).toBe('running')

    // Just short of a second full budget: the retry is judged from when it was
    // made, not from the silence that provoked it.
    h.clock.advance(silenceMs - 1000)
    busyReports(h, bridge, 40)
    await h.engine.whenSettled('op_1')
    expect(h.read().state).toBe('running')

    h.clock.advance(2000)
    await h.engine.whenSettled('op_1')
    expect(h.read().state).toBe('failed')
  })

  it('fails naming the machine that stopped, and not the one that was fine', async () => {
    const h = trio()
    await h.openTheWave()
    const bridge = h.bridge

    for (let round = 0; round < 3; round++) {
      h.clock.advance(silenceMs - 1000)
      busyReports(h, bridge, 20 + round * 20)
      await h.engine.whenSettled('op_1')
    }
    h.clock.advance(silenceMs)
    await h.engine.whenSettled('op_1')

    const error = h.read().error
    expect(h.read().state).toBe('failed')
    // §7's promise, kept on the most likely machine failure there is: the panel
    // can say "vmi3407763 stopped responding" instead of "a machine failed".
    expect(error?.code).toBe('machine-unreachable')
    expect(error?.places).toEqual(['silent'])
    expect(error?.message).toContain('vmi3407763')
    expect(error?.message).not.toContain('ludovico')
  })

  it('does not start a clock on a machine whose turn has not come', async () => {
    // A canary plus four, at a concurrency of three: once the canary is through,
    // `waiting` is granted nothing, so it reports nothing — and a per-place clock
    // that counted it would stall a wave that is working perfectly well, on every
    // fleet larger than its own concurrency.
    const fleet = [
      machine({ id: 'a-canary' }),
      machine({ id: 'b' }),
      machine({ id: 'c' }),
      machine({ id: 'd' }),
      machine({ id: 'waiting' }),
    ]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    const canary = fleet[0]
    if (canary) canary.version = 'dev+abc1234'
    h.updates.onStatus(asMachineId('a-canary'), {
      type: 'updateStatus',
      grantId: 'grant_1',
      state: 'current',
      version: 'dev+abc1234',
    })
    await h.engine.whenSettled('op_1')
    expect(grantedMachines(h)).toEqual(['a-canary', 'b', 'c', 'd'])
    const bridge = createUpdateFleetBridge({ engine: h.engine, updates: h.updates, now: () => h.clock.clock.now() })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')

    const claimed = machinesStep(h)
      ?.places?.filter((place) => place.lastProgressAt !== undefined)
      .map((place) => place.id)
    expect(claimed).toEqual(['b', 'c', 'd'])

    for (let round = 0; round < 3; round++) {
      h.clock.advance(silenceMs - 1000)
      for (const id of ['b', 'c', 'd']) reports(h, bridge, id, 20 + round * 20)
      await h.engine.whenSettled('op_1')
    }
    expect(h.read().state).toBe('running')
    expect(machinesStep(h)?.stalls ?? 0).toBe(0)
  })
})

/**
 * A VERDICT IS NOT A CONNECTION (POD-2172).
 *
 * `offline` describes reachability. `rejected` and `stuck` describe what the
 * machine SAID, and a machine that has said one of those has already told the
 * operator everything §7 exists to tell them. Testing reachability first threw
 * that away and left the wave to guess from silence instead.
 */
describe('a machine that says why, and then goes quiet', () => {
  const dirtyThenGone = async (order: 'reported first' | 'both at once') => {
    const fleet = [machine({ id: 'vmi', name: 'vmi3407763' })]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    const bridge = createUpdateFleetBridge({
      engine: h.engine,
      updates: h.updates,
      now: () => h.clock.clock.now(),
    })

    h.updates.onStatus(asMachineId('vmi'), {
      type: 'updateStatus',
      grantId: 'grant_1',
      state: 'stuck',
      version: '0.4.1',
      detail: 'dirty-working-tree',
    })
    if (order === 'reported first') {
      bridge.onFleetChanged()
      await h.engine.whenSettled('op_1')
    }
    // The operator restarts that daemon to go and look at the checkout.
    fleet[0] = machine({ id: 'vmi', name: 'vmi3407763', online: false })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')
    return h.read()
  }

  it('keeps the reason when the disconnect follows the report', async () => {
    const operation = await dirtyThenGone('reported first')
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe('machine-dirty-checkout')
  })

  /**
   * The case the ordering actually broke: nothing had projected the wave between
   * the daemon's last frame and its disconnect, so `offline` was the first thing
   * written about a machine that had already given its verdict — and `offline`
   * is not a state {@link settleMachines} fails on. The wave then waited out ten
   * minutes of silence and ended with a nameless stall.
   */
  it('keeps the reason when the report and the disconnect arrive together', async () => {
    const operation = await dirtyThenGone('both at once')
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe('machine-dirty-checkout')
    expect(operation.error?.places).toEqual(['vmi'])
    // The sentence that says what to do, instead of "it stopped responding".
    expect(operation.error?.message).toContain('Commit or stash them there')
  })

  /**
   * WHERE THE ORDERING BIT ON EVERY ADOPTION. `adoptOnBoot` is awaited before
   * the daemon gateway listens, so no machine is connected when the successor
   * reconciles — and rewriting every unfinished place to `offline` erased the
   * verdict of anyone who had already given one, every single time.
   */
  it('survives the coordinator restart, where no daemon is connected at all', async () => {
    const fleet = [machine({ id: 'vmi', name: 'vmi3407763' })]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')

    // The verdict is persisted onto the place, and then this process dies
    // before anything can settle the operation on it.
    const store = h.store.get('op_1')?.operation
    const stuckPlaces = (store?.steps ?? []).map((step) =>
      step.id === UPDATE_STEP_MACHINES
        ? {
            ...step,
            places: [{ id: 'vmi', name: 'vmi3407763', state: 'stuck', detail: 'dirty-working-tree' }],
          }
        : step,
    )
    h.store.update({
      ...(store as NonNullable<typeof store>),
      steps: stuckPlaces,
      exclusionGroup: LIFECYCLE_EXCLUSION_GROUP,
      createdAt: 0,
      updatedAt: 0,
    })
    h.engine.stop()

    // Nobody is connected: `adoptOnBoot` is awaited before the daemon gateway
    // listens, so this is the whole fleet as the successor can see it.
    fleet[0] = machine({ id: 'vmi', name: 'vmi3407763', online: false })
    const boot = h.reboot()
    await boot.engine.adoptOnBoot(
      () => ({
        appVersion: 'dev+abc1234',
        servedWebDigest: WEB_DIGEST,
        machineDirectory: fleet,
        now: h.clock.clock.now(),
      }),
      () => boot.context(),
    )
    await boot.engine.whenSettled('op_1')

    const operation = h.read()
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe('machine-dirty-checkout')
  })
})

/**
 * THE WATCHER THAT COULD NOT BE STOPPED (POD-2173).
 *
 * `web`'s poll only ends when the digest matches or the publisher reports a
 * failure, and once the step has run out of time neither can happen. Its
 * heartbeat came from the watcher itself, so the short silence budget could not
 * fire while it lived — and every re-entry started another one that
 * `engine.stop()` had no way to sweep, because the timer belongs to the kind.
 */
describe('the web rebuild watcher stops when its step does', () => {
  const stuckRebuild = () => {
    let reads = 0
    const h = harness({
      machines: [],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      // Never reaches the expected digest, and the publisher never says why:
      // the step can only end on its own deadline.
      servedWebDigest: () => {
        reads++
        return 'older99'
      },
      requestWebRebuild: () => {},
      preparation: () => ({ webReady: false, bundleReady: false }),
    })
    return { h, reads: () => reads }
  }

  it('polls no more once the step has failed, watchers and retry alike', async () => {
    const { h, reads } = stuckRebuild()
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_WEB)).toBe('running')

    const silenceMs = UPDATE_STEP_DEADLINES[UPDATE_STEP_WEB]?.silenceMs ?? 0
    // Silence, a stall, its one retry (which starts a SECOND watcher), then the
    // failure. Nothing is drained in between, so no heartbeat rescues it.
    h.clock.advance(silenceMs)
    await h.engine.whenSettled('op_1')
    h.clock.advance(silenceMs)
    await h.engine.whenSettled('op_1')
    expect(h.read().state).toBe('failed')

    // Both watchers are still queued at this point — the fix is that each one
    // now finds the step gone and declines to reschedule itself.
    await h.drain()
    const settled = reads()
    await h.drain()
    h.clock.advance(60_000)
    await h.drain()
    expect(reads()).toBe(settled)
  })

  it('is still watching while the step is genuinely in flight', async () => {
    // The guard must not be a watcher that never runs: a live step keeps
    // polling, which is the behaviour the exit condition has to leave alone.
    const { h, reads } = stuckRebuild()
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    const before = reads()
    await h.drain()
    expect(reads()).toBeGreaterThan(before)
  })
})
