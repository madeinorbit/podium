import '@podium/client-graph/synced-models'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { MobxPool } from '../pool'
import { liveFixture } from '../live-fixture'
import { aggregatePartOf, ownAttentionPartOf } from './rollup'
import { worklistView } from './view-model'

/**
 * POD-2171: on a row whose coordinator is live, asks come only from the
 * coordinator and the row's own decision; work and exceptions roll up from
 * the whole subtree. Without a live coordinator the old roll-up stands.
 */
const stamp = '2026-10-26T12:00:00Z'
const issue = (id: string, patch: object = {}) => ({
  id,
  seq: 1,
  title: id,
  stage: 'in_progress',
  audience: 'human',
  repoPath: '/synthetic',
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
})
const session = (id: string, owner: string, patch: object = {}) => ({
  sessionId: id,
  issueId: owner,
  cwd: '/synthetic',
  agentKind: 'claude-code',
  status: 'live',
  archived: false,
  lastActiveAt: stamp,
  createdAt: stamp,
  agentState: { phase: 'working', since: stamp },
  ...patch,
})
const idleDone = { agentState: { phase: 'idle', since: stamp, idle: { kind: 'done' } } }
const offer = { offer: { message: 'Ready', createdAt: stamp, actions: [] } }

interface Shape {
  /** The epic's `coordinatorSessionId`; omitted means no coordinator claimed. */
  readonly coordinator?: string
  /** Patches over the default sessions. */
  readonly coord?: object
  readonly reviewed?: object
  readonly busy?: object
  readonly extra?: readonly { kind: 'issue' | 'session'; id: string; value: object }[]
}

/**
 * The POD-2140 shape: an epic run by `coord` (idle), a child in `review`
 * whose implementer finished (so the child itself is deciding), and a second
 * child whose delegate is working.
 */
function fixture(shape: Shape = {}) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'issue',
        id: 'epic',
        value: issue(
          'epic',
          shape.coordinator ? { coordinatorSessionId: shape.coordinator } : {},
        ) as never,
      },
      {
        kind: 'issue',
        id: 'reviewed',
        value: issue('reviewed', { parentId: 'epic', stage: 'review', seq: 2 }) as never,
      },
      {
        kind: 'issue',
        id: 'building',
        value: issue('building', { parentId: 'epic', seq: 3 }) as never,
      },
      {
        kind: 'session',
        id: 'coord',
        value: session('coord', 'epic', { ...idleDone, ...shape.coord }) as never,
      },
      {
        kind: 'session',
        id: 'impl',
        value: session('impl', 'reviewed', { ...idleDone, ...shape.reviewed }) as never,
      },
      {
        kind: 'session',
        id: 'busy',
        value: session('busy', 'building', shape.busy ?? {}) as never,
      },
      ...(shape.extra ?? []).map((row) => ({ ...row, value: row.value as never })),
    ],
  })
  return pool
}

/** What the sidebar, the phone row and the fold read of one row, on both of its paths. */
function read(pool: MobxPool, id: string) {
  const row = worklistView(pool).row(pool.issueObject(id))
  const filing = pool.worklistRow(id)!
  return {
    phase: row.visiblePhase,
    asking: row.visibleAsking,
    waitingCount: row.waitingCount,
    errorClass: row.errorClass,
    timing: row.timing.phase,
    filingPhase: filing.phase,
    filingAsking: filing.asking,
  }
}

function expectRow(pool: MobxPool, id: string, expected: Partial<ReturnType<typeof read>>) {
  let actual: ReturnType<typeof read> | undefined
  const stop = autorun(() => {
    actual = read(pool, id)
  })
  try {
    expect(actual).toMatchObject(expected)
  } finally {
    stop()
  }
}

describe('a row with a live coordinator', () => {
  it('reads Working while a delegate works, though the coordinator idles and a child awaits review', () => {
    const pool = fixture({ coordinator: 'coord' })
    try {
      expectRow(pool, 'epic', {
        phase: 'working',
        asking: false,
        waitingCount: 0,
        timing: 'working',
        filingPhase: 'working',
        filingAsking: false,
      })
      // The child's own decision stays on the child's own row.
      expectRow(pool, 'reviewed', { phase: 'waiting', asking: true, waitingCount: 1 })
    } finally {
      pool.dispose()
    }
  })

  it('reads Working when the child in review still has a working agent', () => {
    const pool = fixture({
      coordinator: 'coord',
      reviewed: { agentState: { phase: 'working', since: stamp } },
    })
    try {
      expectRow(pool, 'epic', { phase: 'working', asking: false })
    } finally {
      pool.dispose()
    }
  })

  it('asks when the coordinator posts an offer', () => {
    const pool = fixture({ coordinator: 'coord', coord: offer })
    try {
      expectRow(pool, 'epic', {
        phase: 'waiting',
        asking: true,
        waitingCount: 1,
        filingAsking: true,
      })
    } finally {
      pool.dispose()
    }
  })

  it('asks for its own decision', () => {
    const pool = fixture({ coordinator: 'coord', busy: idleDone })
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'issue',
          id: 'epic',
          value: issue('epic', { coordinatorSessionId: 'coord', stage: 'review' }) as never,
        },
      ],
    })
    try {
      expectRow(pool, 'epic', { phase: 'waiting', asking: true, waitingCount: 1 })
    } finally {
      pool.dispose()
    }
  })

  it('escalates a delegate error', () => {
    const pool = fixture({
      coordinator: 'coord',
      busy: {
        agentState: {
          phase: 'errored',
          since: stamp,
          error: { class: 'rate_limit', retryable: true },
        },
      },
    })
    try {
      expectRow(pool, 'epic', {
        phase: 'waiting',
        asking: true,
        waitingCount: 1,
        errorClass: 'rate_limit',
      })
    } finally {
      pool.dispose()
    }
  })

  it('escalates a delegate held at a permission prompt', () => {
    const pool = fixture({
      coordinator: 'coord',
      busy: {
        agentState: {
          phase: 'needs_user',
          since: stamp,
          need: { kind: 'permission', summary: 'Bash' },
        },
      },
    })
    try {
      expectRow(pool, 'epic', {
        phase: 'waiting',
        asking: true,
        waitingCount: 1,
        timing: 'waiting',
      })
    } finally {
      pool.dispose()
    }
  })

  it('does not escalate a delegate that ended its turn with a question or an offer', () => {
    for (const busy of [
      { agentState: { phase: 'idle', since: stamp, idle: { kind: 'question' } } },
      { ...idleDone, ...offer },
    ]) {
      const pool = fixture({ coordinator: 'coord', busy })
      try {
        expectRow(pool, 'epic', { asking: false, waitingCount: 0 })
      } finally {
        pool.dispose()
      }
    }
  })

  it('treats its own helpers as delegates too', () => {
    const pool = fixture({
      coordinator: 'coord',
      busy: idleDone,
      extra: [
        {
          kind: 'session',
          id: 'helper',
          value: session('helper', 'epic', {
            agentState: { phase: 'idle', since: stamp, idle: { kind: 'question' } },
          }),
        },
      ],
    })
    try {
      expectRow(pool, 'epic', { asking: false, waitingCount: 0 })
    } finally {
      pool.dispose()
    }
  })

  it('keeps a nested coordinator’s asks on its own row and escalates only its exceptions', () => {
    const sub = (patch: object) => ({
      kind: 'session' as const,
      id: 'sub',
      value: session('sub', 'building', { ...idleDone, ...patch }),
    })
    const nested = (patch: object) =>
      fixture({
        coordinator: 'coord',
        busy: idleDone,
        extra: [
          {
            kind: 'issue',
            id: 'building',
            value: issue('building', { parentId: 'epic', seq: 3, coordinatorSessionId: 'sub' }),
          },
          sub(patch),
        ],
      })
    let pool = nested(offer)
    try {
      expectRow(pool, 'building', { phase: 'waiting', asking: true })
      expectRow(pool, 'epic', { asking: false, waitingCount: 0 })
    } finally {
      pool.dispose()
    }
    pool = nested({
      agentState: { phase: 'needs_user', since: stamp, need: { kind: 'permission' } },
    })
    try {
      expectRow(pool, 'epic', { phase: 'waiting', asking: true, waitingCount: 1 })
    } finally {
      pool.dispose()
    }
  })
})

describe('the seat facts under a live coordinator (review round 1)', () => {
  const at = (iso: string) => Date.parse(iso)

  it('a delegate\u2019s suppressed offer does not hide its work or its working timer', () => {
    const pool = fixture({
      coordinator: 'coord',
      busy: { ...offer, agentState: { phase: 'working', since: '2026-10-26T11:00:00Z' } },
    })
    try {
      expectRow(pool, 'epic', {
        phase: 'working',
        asking: false,
        waitingCount: 0,
        timing: 'working',
      })
      const row = worklistView(pool).row(pool.issueObject('epic'))
      let since = 0,
        working = false
      const stop = autorun(() => {
        since = row.timing.sinceMs
        working = row.visibleWorking
      })
      stop()
      expect({ since, working }).toEqual({ since: at('2026-10-26T11:00:00Z'), working: true })
      // Its own row is uncoordinated: there the offer still asks, as before.
      expectRow(pool, 'building', { phase: 'waiting', asking: true })
    } finally {
      pool.dispose()
    }
  })

  it('times a delegate\u2019s exception from the exception, not from its suppressed offer', () => {
    const pool = fixture({
      coordinator: 'coord',
      busy: {
        offer: { message: 'Ready', createdAt: '2026-10-26T09:00:00Z', actions: [] },
        agentState: {
          phase: 'needs_user',
          since: '2026-10-26T12:00:00Z',
          need: { kind: 'permission' },
        },
      },
    })
    try {
      const row = worklistView(pool).row(pool.issueObject('epic'))
      let timing: { phase: string; sinceMs: number } | undefined
      const stop = autorun(() => {
        timing = row.timing
      })
      stop()
      expect(timing).toMatchObject({ phase: 'waiting', sinceMs: at('2026-10-26T12:00:00Z') })
    } finally {
      pool.dispose()
    }
  })

  it('escalates a crashed delegate, timed from its stop', () => {
    const crash = {
      status: 'exited',
      stopReason: 'oom',
      exitCode: 137,
      stoppedAt: '2026-10-26T11:30:00Z',
      ...idleDone,
    }
    const pool = fixture({ coordinator: 'coord', busy: crash })
    try {
      expectRow(pool, 'epic', {
        phase: 'waiting',
        asking: true,
        waitingCount: 1,
        filingAsking: true,
      })
      const row = worklistView(pool).row(pool.issueObject('epic'))
      let sinceMs = 0
      const stop = autorun(() => {
        sinceMs = row.timing.sinceMs
      })
      stop()
      expect(sinceMs).toBe(at('2026-10-26T11:30:00Z'))
    } finally {
      pool.dispose()
    }
    // Without a live coordinator the sidebar keeps its old reading of a crash.
    const old = fixture({ busy: crash, reviewed: { status: 'exited' } })
    old.apply({
      type: 'update',
      rows: [
        {
          kind: 'issue',
          id: 'reviewed',
          value: issue('reviewed', { parentId: 'epic', seq: 2 }) as never,
        },
      ],
    })
    try {
      expectRow(old, 'epic', { asking: false })
    } finally {
      old.dispose()
    }
  })

  it('escalates an open pending interaction on an idle delegate', () => {
    // The child in review still has a working agent, so only the interaction can ask.
    const shape = {
      coordinator: 'coord',
      busy: idleDone,
      reviewed: { agentState: { phase: 'working', since: stamp } },
    }
    const quiet = fixture(shape)
    try {
      expectRow(quiet, 'epic', { asking: false, waitingCount: 0 })
    } finally {
      quiet.dispose()
    }
    const pool = fixture(shape)
    Object.defineProperty(pool, 'sessionOpenInteractions', {
      value: (id: string) =>
        id === 'busy' ? { count: 1, since: null } : { count: 0, since: null },
    })
    try {
      expectRow(pool, 'epic', {
        phase: 'waiting',
        asking: true,
        waitingCount: 1,
        filingAsking: true,
      })
    } finally {
      pool.dispose()
    }
  })
})

describe('one derivation per seat (review round 2)', () => {
  const at = (iso: string) => Date.parse(iso)
  // The child in review keeps a working agent, so it asks nothing of its own.
  const quiet = {
    coordinator: 'coord',
    busy: idleDone,
    reviewed: { agentState: { phase: 'working', since: stamp } },
  }
  const interactions = (pool: MobxPool, of: Record<string, { count: number; since: number }>) =>
    Object.defineProperty(pool, 'sessionOpenInteractions', {
      value: (id: string) => of[id] ?? { count: 0, since: null },
    })
  const timing = (pool: MobxPool, id: string) => {
    let value: { phase: string; sinceMs: number } | undefined
    const stop = autorun(() => {
      value = worklistView(pool).row(pool.issueObject(id)).timing
    })
    stop()
    return value
  }

  it('R2-1: the coordinator\u2019s open interaction asks, through the same facts', () => {
    const pool = fixture(quiet)
    interactions(pool, { coord: { count: 1, since: at('2026-10-26T11:00:00Z') } })
    try {
      expectRow(pool, 'epic', {
        phase: 'waiting',
        asking: true,
        waitingCount: 1,
        filingAsking: true,
      })
      expect(timing(pool, 'epic')).toMatchObject({
        phase: 'waiting',
        sinceMs: at('2026-10-26T11:00:00Z'),
      })
    } finally {
      pool.dispose()
    }
  })

  it('R2-3a: a crash outlives the display window while its task is open', () => {
    const pool = fixture({
      ...quiet,
      busy: {
        status: 'exited',
        stopReason: 'oom',
        exitCode: 137,
        stoppedAt: '2026-10-19T00:00:00Z',
        readAt: '2026-10-20T00:00:00Z',
        unread: false,
        ...idleDone,
      },
    })
    try {
      let retained: readonly string[] = []
      const stop = autorun(() => {
        retained = pool.worklistRow('building')!.retainedSeatIds
      })
      stop()
      expect(retained).not.toContain('busy')
      expectRow(pool, 'epic', {
        phase: 'waiting',
        asking: true,
        waitingCount: 1,
        errorClass: 'oom',
      })
    } finally {
      pool.dispose()
    }
  })

  it('R2-3b: a closed child\u2019s crash asks nothing of its coordinated parent', () => {
    const pool = fixture({
      ...quiet,
      busy: { status: 'exited', stopReason: 'oom', exitCode: 137, stoppedAt: stamp, ...idleDone },
      extra: [
        {
          kind: 'issue',
          id: 'building',
          value: issue('building', {
            parentId: 'epic',
            seq: 3,
            stage: 'done',
            closedAt: stamp,
            closedReason: 'done',
          }),
        },
      ],
    })
    try {
      expectRow(pool, 'epic', { asking: false, waitingCount: 0 })
    } finally {
      pool.dispose()
    }
  })

  it('R2-4: a pending interaction is timed from when it was asked', () => {
    const pool = fixture({
      ...quiet,
      busy: {
        agentState: { phase: 'idle', since: '2026-10-26T09:00:00Z', idle: { kind: 'done' } },
      },
    })
    interactions(pool, { busy: { count: 1, since: at('2026-10-26T11:45:00Z') } })
    try {
      expect(timing(pool, 'epic')).toMatchObject({
        phase: 'waiting',
        sinceMs: at('2026-10-26T11:45:00Z'),
      })
    } finally {
      pool.dispose()
    }
  })

  it('R2-5: a crashed delegate carries its error phrase to the row', () => {
    const pool = fixture({
      ...quiet,
      busy: { status: 'exited', stopReason: 'oom', exitCode: 137, stoppedAt: stamp, ...idleDone },
    })
    try {
      expectRow(pool, 'epic', { asking: true, errorClass: 'oom' })
    } finally {
      pool.dispose()
    }
  })

  it('R2-6: a coordinated issue\u2019s own needs-human flag or decision type asks', () => {
    for (const own of [{ needsHuman: true }, { type: 'decision' }]) {
      const pool = fixture({
        ...quiet,
        extra: [
          {
            kind: 'issue',
            id: 'epic',
            value: issue('epic', { coordinatorSessionId: 'coord', ...own }),
          },
        ],
      })
      try {
        expectRow(pool, 'epic', {
          phase: 'waiting',
          asking: true,
          waitingCount: 1,
          filingAsking: true,
        })
      } finally {
        pool.dispose()
      }
      // Uncoordinated rows keep their old sidebar reading of these flags.
      const old = fixture({
        ...quiet,
        coordinator: undefined,
        extra: [{ kind: 'issue', id: 'epic', value: issue('epic', own) }],
      })
      try {
        expectRow(old, 'epic', { asking: false })
      } finally {
        old.dispose()
      }
    }
  })
})

const AWAY = 'machine-away'
/** The pool with {@link AWAY} read offline in its LiveStore. */
function away(pool: MobxPool): MobxPool {
  liveFixture(pool).online(AWAY, false)
  return pool
}

describe('review round 3', () => {
  const quiet = {
    coordinator: 'coord',
    busy: idleDone,
    reviewed: { agentState: { phase: 'working', since: stamp } },
  }
  const stale = [
    // Reconnecting: live on a machine the LiveStore reads as offline (ADR 12 D1).
    { status: 'live', machineId: AWAY, agentState: { phase: 'idle', since: stamp, idle: { kind: 'done' } } },
    {
      status: 'starting',
      agentState: { phase: 'idle', since: stamp, idle: { kind: 'open_todos' } },
    },
    { status: 'starting', agentState: { phase: 'ended', since: stamp } },
  ]

  it('R3-1: a starting or reconnecting child delegate with a stale finished phase reads Working', () => {
    for (const helper of stale) {
      // The child in review is idle too, so only the stale helper can make the epic work.
      const pool = away(fixture({ ...quiet, reviewed: idleDone, busy: helper }))
      try {
        expectRow(pool, 'epic', { phase: 'working', asking: false })
      } finally {
        pool.dispose()
      }
    }
  })

  it('R3-1: the same on a same-row helper: phase and working agree', () => {
    for (const helper of stale) {
      const pool = away(fixture({
        ...quiet,
        reviewed: idleDone,
        busy: idleDone,
        extra: [{ kind: 'session', id: 'helper', value: session('helper', 'epic', helper) }],
      }))
      try {
        expectRow(pool, 'epic', { phase: 'working' })
        let working = false
        const stop = autorun(() => {
          working = worklistView(pool).row(pool.issueObject('epic')).visibleWorking
        })
        stop()
        expect(working).toBe(true)
      } finally {
        pool.dispose()
      }
    }
  })

  it('R3-2: an exited, error-free delegate with an open interaction asks, by the same verdict', () => {
    const exited = {
      status: 'exited',
      stopReason: 'self',
      exitCode: 0,
      stoppedAt: stamp,
      ...idleDone,
    }
    const plain = fixture({ ...quiet, busy: exited })
    try {
      expectRow(plain, 'epic', { asking: false, waitingCount: 0 })
    } finally {
      plain.dispose()
    }
    const pool = fixture({ ...quiet, busy: exited })
    Object.defineProperty(pool, 'sessionOpenInteractions', {
      value: (id: string) =>
        id === 'busy' ? { count: 1, since: Date.parse(stamp) } : { count: 0, since: null },
    })
    Object.defineProperty(pool, 'sessionsWithOpenInteractions', { value: () => ['busy'] })
    try {
      expectRow(pool, 'epic', {
        phase: 'waiting',
        asking: true,
        waitingCount: 1,
        filingAsking: true,
      })
    } finally {
      pool.dispose()
    }
  })
})

describe('review round 4', () => {
  const quiet = {
    coordinator: 'coord',
    busy: idleDone,
    reviewed: { agentState: { phase: 'working', since: stamp } },
  }
  const interactions = (pool: MobxPool, ids: string[]) => {
    Object.defineProperty(pool, 'sessionOpenInteractions', {
      value: (id: string) =>
        ids.includes(id) ? { count: 1, since: Date.parse(stamp) } : { count: 0, since: null },
    })
    Object.defineProperty(pool, 'sessionsWithOpenInteractions', { value: () => ids })
  }

  it('R4-1: a headless helper is no seat, so its open interaction does not ask on the sidebar either', () => {
    const helper = {
      headless: true,
      status: 'exited',
      stopReason: 'self',
      exitCode: 0,
      stoppedAt: stamp,
      ...idleDone,
    }
    const pool = fixture({
      ...quiet,
      extra: [{ kind: 'session', id: 'helper', value: session('helper', 'epic', helper) }],
    })
    interactions(pool, ['helper'])
    try {
      let exceptions: readonly string[] = []
      const stop = autorun(() => {
        exceptions = pool.worklistRow('epic')!.exceptionSeatIds
      })
      stop()
      expect(exceptions).toEqual([])
      expectRow(pool, 'epic', { asking: false, waitingCount: 0 })
    } finally {
      pool.dispose()
    }
  })

  it('R4-2: every row shares one candidate scan', () => {
    const pool = fixture(quiet)
    const read = pool.row.bind(pool)
    let scans = 0
    Object.defineProperty(pool, 'row', {
      value: (entity: string, ...rest: unknown[]) => {
        if (entity === 'noticeCatalog') scans++
        return (read as (...args: unknown[]) => unknown)(entity, ...rest)
      },
    })
    const view = worklistView(pool)
    const stop = autorun(() => {
      for (const id of ['epic', 'reviewed', 'building'])
        void view.row(pool.issueObject(id)).visibleAsking
    })
    try {
      expect(scans).toBe(1)
      pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'session',
            id: 'impl',
            value: session('impl', 'reviewed', {
              agentState: { phase: 'working', since: '2026-10-26T12:30:00Z' },
            }) as never,
          },
        ],
      })
      expect(scans).toBe(1)
    } finally {
      stop()
      pool.dispose()
    }
  })
})

describe('without a live coordinator, the old roll-up', () => {
  for (const [name, shape] of [
    ['no coordinator claimed', {}],
    ['coordinator exited', { coordinator: 'coord', coord: { status: 'exited' } }],
    ['coordinator archived', { coordinator: 'coord', coord: { archived: true } }],
    ['coordinator unknown', { coordinator: 'gone' }],
  ] as const)
    it(`${name}: a child awaiting review makes the parent ask`, () => {
      const pool = fixture(shape)
      try {
        expectRow(pool, 'epic', {
          phase: 'waiting',
          asking: true,
          waitingCount: 1,
          filingAsking: true,
        })
      } finally {
        pool.dispose()
      }
    })

  it('a delegate question still asks on an uncoordinated parent', () => {
    const pool = fixture({
      reviewed: { status: 'exited' },
      busy: { agentState: { phase: 'idle', since: stamp, idle: { kind: 'question' } } },
    })
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'issue',
          id: 'reviewed',
          value: issue('reviewed', { parentId: 'epic', seq: 2 }) as never,
        },
      ],
    })
    try {
      expectRow(pool, 'epic', { phase: 'waiting', asking: true })
    } finally {
      pool.dispose()
    }
  })
})

it('the live attention fields equal the eager parts on coordinated rows', () => {
  const pool = fixture({
    coordinator: 'coord',
    coord: offer,
    extra: [
      {
        kind: 'session',
        id: 'helper',
        value: session('helper', 'epic', { agentState: { phase: 'needs_user', since: stamp } }),
      },
      {
        kind: 'issue',
        id: 'building',
        value: issue('building', { parentId: 'epic', seq: 3, coordinatorSessionId: 'sub' }),
      },
      { kind: 'session', id: 'sub', value: session('sub', 'building', offer) },
    ],
  })
  let failure: unknown
  const stop = autorun(() => {
    try {
      for (const id of ['epic', 'reviewed', 'building']) {
        const model = pool.worklistRow(id)!
        expect(model.ownAttention, `${id} own`).toEqual(
          ownAttentionPartOf(pool.rollupInputs, model),
        )
        expect(model.aggregate, `${id} aggregate`).toEqual(
          aggregatePartOf(pool.rollupInputs, id, model),
        )
      }
    } catch (error) {
      failure = error
    }
  })
  try {
    if (failure !== undefined) throw failure
    expect(pool.worklistRow('epic')!.ownAttention.coordinated).toBe(true)
  } finally {
    stop()
    pool.dispose()
  }
})
