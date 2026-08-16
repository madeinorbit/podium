import { parseOperation } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  cancelRefusalSentence,
  formatDuration,
  isOperationActive,
  type LocalFacts,
  type OperationViewInput,
  operationView,
  presentOperationError,
  STALE_AFTER_MS,
  stepRows,
  type UpdateSurface,
} from './operation-view'
import type { UpdateView } from './update-view'

const NOW = 1_765_700_100_000

const NOT_BEHIND: LocalFacts = { behind: false, canReload: true, canInstallDesktop: false }
const BEHIND: LocalFacts = { behind: true, canReload: true, canInstallDesktop: false }

/**
 * The §3.1 payload, verbatim from the spec, as the tests' base fixture — every
 * row below is a mutation of the shape the server actually persists.
 */
function operationPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'op_01j',
    kind: 'update',
    details: { target: { version: '0.4.3', channel: 'dev' } },
    state: 'running',
    createdBy: 'user',
    startedAt: NOW - 41_000,
    updatedAt: NOW - 1_000,
    finishedAt: null,
    steps: [
      { id: 'prepare', title: 'Preparing the update', state: 'done' },
      {
        id: 'machines',
        title: 'Updating your machines',
        state: 'running',
        startedAt: NOW - 30_000,
        lastProgressAt: NOW - 1_000,
        progress: { done: 1, total: 3 },
        places: [
          { id: 'm_a', name: 'vmi3407763', state: 'downloading', percent: 62 },
          { id: 'm_b', name: 'ludovico', state: 'done' },
          { id: 'm_c', name: 'macbook', state: 'pending' },
        ],
      },
      { id: 'server', title: 'Updating your server', state: 'pending' },
      { id: 'web', title: 'Serving the new app', state: 'pending' },
    ],
    awaiting: [],
    deferred: [],
    error: null,
    ...overrides,
  }
}

function view(
  payload: unknown,
  extra: Partial<Omit<OperationViewInput, 'operation'>> = {},
): ReturnType<typeof operationView> {
  return operationView({
    operation: parseOperation(payload),
    offer: null,
    local: NOT_BEHIND,
    surface: 'web',
    now: NOW,
    ...extra,
  })
}

const OFFER: UpdateView = {
  state: 'available',
  version: '0.4.3',
  places: [
    { kind: 'this-app', label: 'This app', effect: 'will refresh' },
    { kind: 'machines', label: 'vmi3407763', effect: 'will not be interrupted' },
  ],
  restartNote: 'Your sessions keep running.',
  notes: { summary: 'Faster boards.' },
}

describe('operationView — the seven states', () => {
  it('renders nothing when there is neither an operation nor an offer', () => {
    const result = view(null)
    expect(result.state).toBe('none')
    expect(result.indicator).toBe('none')
  })

  it('renders the offer with its place rows and one primary', () => {
    const result = operationView({
      operation: null,
      offer: OFFER,
      local: NOT_BEHIND,
      surface: 'web',
      now: NOW,
    })
    expect(result.state).toBe('offer')
    expect(result.title).toBe('Podium 0.4.3 is available')
    expect(result.places?.map((place) => place.label)).toEqual(['This app', 'vmi3407763'])
    expect(result.notes?.summary).toBe('Faster boards.')
    expect(result.primary).toMatchObject({ kind: 'start', label: 'Update Podium' })
    expect(result.indicator).toBe('idle-dot')
    expect(result.indicatorLabel).toBe('Podium 0.4.3 is available')
  })

  it('marks a required offer as attention', () => {
    const result = operationView({
      operation: null,
      offer: { ...OFFER, state: 'required', reason: 'This app needs an update to continue.' },
      local: NOT_BEHIND,
      surface: 'web',
      now: NOW,
    })
    expect(result.state).toBe('offer')
    expect(result.indicator).toBe('attention')
    expect(result.reason).toBe('This app needs an update to continue.')
  })

  it('renders the running checklist with the step position and substatus', () => {
    const result = view(operationPayload())
    expect(result.state).toBe('running')
    expect(result.title).toBe('Podium 0.4.3 is being applied')
    expect(result.stepPosition).toEqual({ current: 2, total: 4 })
    expect(result.steps).toEqual([
      { id: 'prepare', title: 'Preparing the update', state: 'done' },
      {
        id: 'machines',
        title: 'Updating your machines',
        state: 'current',
        substatus: '1 of 3 · vmi3407763 downloading 62%',
      },
      { id: 'server', title: 'Updating your server', state: 'pending' },
      { id: 'web', title: 'Serving the new app', state: 'pending' },
    ])
    expect(result.liveness).toBe('Running for 30 s')
    expect(result.indicator).toBe('animating')
    expect(result.indicatorLabel).toBe('Update running: step 2 of 4')
    expect(result.cancel).toEqual({ label: 'Cancel', operationId: 'op_01j' })
  })

  /**
   * The kind writes `current` for a converged machine, never `done` (POD-2171):
   * `projectMachines` in apps/server/src/modules/updates/operation.ts produces
   * `current` from the version comparison. A filter that only knew the spec's
   * illustrative `done` named the finished machine as the one still moving.
   */
  it('names the machine that is still moving, not one the server calls current', () => {
    const payload = operationPayload({
      steps: [
        {
          id: 'machines',
          title: 'Updating your machines',
          state: 'running',
          startedAt: NOW - 30_000,
          lastProgressAt: NOW - 1_000,
          progress: { done: 1, total: 2 },
          places: [
            { id: 'm_a', name: 'alpha', state: 'current', percent: 100 },
            { id: 'm_b', name: 'beta', state: 'downloading', percent: 62 },
          ],
        },
      ],
    })
    expect(view(payload).steps[0]?.substatus).toBe('1 of 2 · beta downloading 62%')
  })

  it('treats a machine resting behind the target as waiting, not moving', () => {
    const payload = operationPayload({
      steps: [
        {
          id: 'machines',
          title: 'Updating your machines',
          state: 'running',
          places: [
            { id: 'm_a', name: 'alpha', state: 'pending' },
            { id: 'm_b', name: 'beta', state: 'restarting' },
          ],
        },
      ],
    })
    expect(view(payload).steps[0]?.substatus).toBe('beta restarting')
  })

  it('names the machine that reported a verdict when nothing is moving', () => {
    const payload = operationPayload({
      steps: [
        {
          id: 'machines',
          title: 'Updating your machines',
          state: 'failed',
          places: [
            { id: 'm_a', name: 'alpha', state: 'current', percent: 100 },
            { id: 'm_b', name: 'beta', state: 'stuck', detail: 'The checkout has local changes.' },
            { id: 'm_c', name: 'macbook', state: 'pending' },
          ],
        },
      ],
    })
    expect(view(payload).steps[0]?.substatus).toBe('beta stuck')
  })

  it('names an unfamiliar place word as movement rather than ranking it last', () => {
    const payload = operationPayload({
      steps: [
        {
          id: 'machines',
          title: 'Updating your machines',
          state: 'running',
          places: [
            { id: 'm_a', name: 'alpha', state: 'pending' },
            { id: 'm_b', name: 'beta', state: 'verifying', percent: 10 },
          ],
        },
      ],
    })
    expect(view(payload).steps[0]?.substatus).toBe('beta verifying 10%')
  })

  it('keeps saying "running" while a step is merely quiet', () => {
    const payload = operationPayload()
    const steps = (payload as { steps: { lastProgressAt?: number }[] }).steps
    // A real `prepare` packs a bundle for a minute without one progress report.
    steps[1] = { ...steps[1], lastProgressAt: NOW - (STALE_AFTER_MS - 20_000) }
    expect(view(payload).liveness).toBe('Running for 30 s')
  })

  it('says how long a step has been silent once the heartbeat goes stale', () => {
    const payload = operationPayload()
    const steps = (payload as { steps: { lastProgressAt?: number }[] }).steps
    steps[1] = { ...steps[1], lastProgressAt: NOW - 300_000 }
    const result = view(payload)
    expect(result.liveness).toBe('No progress for 5 min')
    // Still "animating": the engine, not the renderer, decides it has stalled.
    expect(result.indicator).toBe('animating')
  })

  it('raises the indicator to attention when the engine reports the step stalled', () => {
    const payload = operationPayload()
    const steps = (payload as { steps: Record<string, unknown>[] }).steps
    steps[1] = { ...steps[1], state: 'stalled', lastProgressAt: NOW - 300_000 }
    const result = view(payload)
    expect(result.steps[1]?.state).toBe('stalled')
    expect(result.liveness).toBe('No progress for 5 min')
    expect(result.indicator).toBe('attention')
  })

  it('asks THIS surface to reload when the operation waits on it', () => {
    const payload = operationPayload({
      state: 'waiting',
      steps: [
        { id: 'prepare', title: 'Preparing the update', state: 'done' },
        { id: 'server', title: 'Updating your server', state: 'done' },
        { id: 'web', title: 'Serving the new app', state: 'done' },
      ],
      awaiting: [{ id: 'reload', surface: 'web', title: 'Reload this page' }],
    })
    const result = view(payload, { local: BEHIND })
    expect(result.state).toBe('waiting-you')
    expect(result.primary).toMatchObject({ kind: 'reload', label: 'Reload' })
    expect(result.primary?.consequence).toContain('about 2 seconds')
    expect(result.indicator).toBe('attention')
    expect(result.indicatorLabel).toBe('Reload to finish')
  })

  it('offers Restart Podium instead of Reload inside the shell', () => {
    const payload = operationPayload({
      state: 'waiting',
      awaiting: [{ id: 'desktop-install', surface: 'desktop-all-in-one', title: 'Install' }],
    })
    const result = view(payload, {
      local: { behind: true, canReload: true, canInstallDesktop: true },
      surface: 'desktop-all-in-one',
    })
    expect(result.state).toBe('waiting-you')
    expect(result.primary).toMatchObject({ kind: 'install-desktop', label: 'Restart Podium' })
  })

  it('renders another surface’s ask honestly, with no button (P5)', () => {
    const payload = operationPayload({
      state: 'waiting',
      awaiting: [
        {
          id: 'desktop-install',
          surface: 'desktop-all-in-one',
          title: 'Waiting for Podium Desktop',
          place: 'macbook',
        },
      ],
    })
    const result = view(payload, { local: NOT_BEHIND, surface: 'web' })
    expect(result.state).toBe('waiting-elsewhere')
    expect(result.primary).toBeUndefined()
    expect(result.awaitingElsewhere).toEqual(['Waiting for Podium Desktop on macbook'])
    expect(result.indicator).toBe('animating')
  })

  /**
   * THE ALL-IN-ONE CASE (POD-2168, §3.5/§4). The plan is empty and the one
   * required ask belongs to the desktop shell, so a browser tab is behind by
   * construction — the server has not been replaced yet. Being behind is not
   * evidence that this page is the last one, and a Reload here fetches the same
   * old bundle from the same un-updated server.
   */
  it('never turns a browser’s own staleness into a button while another surface is asked', () => {
    const payload = operationPayload({
      state: 'waiting',
      steps: [],
      awaiting: [
        {
          id: 'desktop-install',
          surface: 'desktop-all-in-one',
          title: 'Install the update in Podium Desktop',
          detail: 'Finish this in Podium Desktop on ludovico.',
          place: 'm_host',
          required: true,
        },
      ],
    })
    const result = view(payload, { local: BEHIND, surface: 'web' })
    expect(result.state).toBe('waiting-elsewhere')
    expect(result.primary).toBeUndefined()
    expect(result.title).toBe('Podium 0.4.3 is finishing elsewhere')
    // `toContain`, not `toBe`: `askLine` also appends the ask's `place`, which
    // the server sets to the machine ID while the detail names the machine, so
    // the sentence carries a raw id. Filed separately rather than widened into
    // this fix — see the discovered issue on the epic.
    expect(result.subtitle).toContain('Finish this in Podium Desktop on ludovico.')
    expect(result.indicatorLabel).toBe('Update waiting for another place')
  })

  it('still self-serves a stale surface when the wait belongs to nobody else', () => {
    const payload = operationPayload({ state: 'waiting', steps: [], awaiting: [] })
    const result = view(payload, { local: BEHIND, surface: 'web' })
    expect(result.state).toBe('waiting-you')
    expect(result.primary).toMatchObject({ kind: 'reload' })
  })

  it('names the version and the deferred places when it is done', () => {
    const payload = operationPayload({
      state: 'done',
      finishedAt: NOW,
      steps: [{ id: 'prepare', title: 'Preparing the update', state: 'done' }],
      deferred: [
        { id: 'm_c', name: 'macbook', reason: 'offline' },
        { id: 'm_d', name: 'laptop', reason: 'offline' },
      ],
    })
    const result = view(payload)
    expect(result.state).toBe('done')
    expect(result.title).toBe('Podium is on 0.4.3 everywhere')
    expect(result.deferredNote).toBe('macbook, laptop will update when they reconnect.')
    expect(result.indicator).toBe('idle-dot')
  })

  it('keeps asking a straggler tab to reload after the operation itself finished', () => {
    const result = view(operationPayload({ state: 'done', finishedAt: NOW }), { local: BEHIND })
    expect(result.state).toBe('waiting-you')
    expect(result.primary).toMatchObject({ kind: 'reload' })
  })

  it('renders a failure in three layers with a single Try again', () => {
    const payload = operationPayload({
      state: 'failed',
      error: {
        code: 'machine-dirty-checkout',
        message: 'dirty working tree',
        places: ['vmi'],
        detail: 'git status reported 3 modified files',
      },
    })
    const result = view(payload)
    expect(result.state).toBe('failed')
    expect(result.error?.message).toBe('vmi has local edits that prevent a safe update.')
    expect(result.error?.nextAction).toBe('Commit or stash them there, then try again.')
    expect(result.error?.detail).toContain('git status reported 3 modified files')
    expect(result.error?.detail).toContain('operation: op_01j')
    expect(result.primary).toMatchObject({ kind: 'retry', label: 'Try again' })
    expect(result.indicator).toBe('attention')
  })

  it('treats a canceled operation as nothing to say', () => {
    expect(view(operationPayload({ state: 'canceled' })).state).toBe('none')
  })
})

describe('operationView — the frozen contract (P8, §8)', () => {
  it('renders an operation carrying fields this bundle has never heard of', () => {
    const payload = operationPayload({
      lane: 'canary',
      steps: [
        {
          id: 'quantum',
          title: 'Entangling the fleet',
          state: 'running',
          startedAt: NOW - 5_000,
          lastProgressAt: NOW,
          places: [{ id: 'p', name: 'vmi', state: 'teleporting', percent: 10, sparkle: true }],
          futureField: { nested: true },
        },
      ],
      unknownTopLevel: [1, 2, 3],
    })
    const result = view(payload)
    expect(result.state).toBe('running')
    expect(result.steps).toEqual([
      {
        id: 'quantum',
        title: 'Entangling the fleet',
        state: 'current',
        substatus: 'vmi teleporting 10%',
      },
    ])
    expect(result.stepPosition).toEqual({ current: 1, total: 1 })
  })

  it('renders an operation with nothing but the three required fields', () => {
    const result = view({ id: 'op_bare', kind: 'update', state: 'running' })
    expect(result.state).toBe('running')
    expect(result.title).toBe('Podium is being updated')
    expect(result.steps).toEqual([])
    expect(result.stepPosition).toBeUndefined()
    expect(result.liveness).toBe('Working…')
    expect(result.version).toBeUndefined()
  })

  it('degrades an unknown error code to the server’s own sentence', () => {
    const result = view(
      operationPayload({
        state: 'failed',
        error: { code: 'sunspots', message: 'Solar flare during the wave.' },
      }),
    )
    expect(result.error?.message).toBe('Solar flare during the wave.')
    expect(result.error?.nextAction).toContain('Try again')
    expect(result.error?.detail).toContain('code: sunspots')
  })

  it('refuses a payload that is not an operation and falls back to the offer', () => {
    const result = operationView({
      operation: parseOperation({ kind: 'update' }),
      offer: OFFER,
      local: NOT_BEHIND,
      surface: 'web',
      now: NOW,
    })
    expect(result.state).toBe('offer')
  })

  it('drops skipped steps rather than showing them as noise (§3.1)', () => {
    const rows = stepRows({
      id: 'op',
      kind: 'update',
      state: 'running',
      steps: [
        { id: 'prepare', state: 'done' },
        { id: 'machines', state: 'skipped' },
        { id: 'server', state: 'running' },
      ],
    })
    expect(rows.map((row) => row.id)).toEqual(['prepare', 'server'])
    // No title on the wire: the id is the honest fallback, never a blank row.
    expect(rows[0]?.title).toBe('prepare')
  })
})

describe('operationView — action rejections (the retired POD-2091 bug)', () => {
  it('surfaces a rejected action even when the server has no operation', () => {
    const result = operationView({
      operation: null,
      offer: OFFER,
      local: NOT_BEHIND,
      surface: 'desktop-all-in-one',
      now: NOW,
      actionError: { code: 'signature-invalid', message: 'The update could not be verified.' },
    })
    expect(result.state).toBe('failed')
    expect(result.error?.message).toContain("couldn't be verified")
    expect(result.error?.detail).toContain('code: signature-invalid')
    expect(result.primary).toMatchObject({ kind: 'retry' })
    expect(result.indicator).toBe('attention')
  })

  it('maps every desktop error code to three layers', () => {
    const codes = [
      'debug-build',
      'no-pending-update',
      'download-failed',
      'signature-invalid',
      'install-failed',
      'restart-failed',
      'no-update-available',
    ]
    for (const code of codes) {
      const presented = presentOperationError({ code }, { operationId: 'op_1' })
      expect(presented.message.length).toBeGreaterThan(0)
      expect(presented.nextAction.length).toBeGreaterThan(0)
      expect(presented.detail).toContain('operation: op_1')
    }
  })
})

describe('surfaces render the same operation differently', () => {
  const surfaces: UpdateSurface[] = ['web', 'mobile', 'desktop-remote', 'desktop-all-in-one']

  it('never offers a button for somebody else’s surface', () => {
    const payload = operationPayload({
      state: 'waiting',
      awaiting: [{ id: 'x', surface: 'desktop-all-in-one', title: 'Restart Podium', place: 'mac' }],
    })
    // `behind: true` on purpose (POD-2168): every non-asked surface is stale
    // while the shell installs, and that staleness must not become a button.
    for (const surface of surfaces) {
      const result = view(payload, {
        surface,
        local: {
          behind: true,
          canReload: surface !== 'desktop-all-in-one',
          canInstallDesktop: false,
        },
      })
      if (surface === 'desktop-all-in-one') continue
      expect(result.state).toBe('waiting-elsewhere')
      expect(result.primary).toBeUndefined()
    }
  })
})

describe('helpers', () => {
  it('formats durations the way the copy rules read them', () => {
    expect(formatDuration(40_000)).toBe('40 s')
    expect(formatDuration(300_000)).toBe('5 min')
    expect(formatDuration(7_200_000)).toBe('2 h')
  })

  it('knows which operations are still worth a one-second poll', () => {
    expect(isOperationActive(parseOperation(operationPayload()))).toBe(true)
    expect(isOperationActive(parseOperation(operationPayload({ state: 'done' })))).toBe(false)
    expect(isOperationActive(null)).toBe(false)
  })

  it('turns every cancel refusal into a sentence', () => {
    expect(cancelRefusalSentence('irreversible', 'server')).toContain('will finish or fail')
    expect(cancelRefusalSentence('already-finished')).toBe('This update already finished.')
    expect(cancelRefusalSentence('not-found')).toBe('This update is no longer running.')
  })
})
