/**
 * POD-7547 — EVERY RELATION THE CHECK CALLS A LOOKUP OR A HOLDING READ, ON
 * AN EMPTY DEVICE.
 *
 * The check (`shared/relation-reads.ts`) calls a single relation to a kind
 * the pool looks up by id a lookup, and a to-many relation over an on-demand
 * kind with a keyed collection a holding read. These tests hold the pool to
 * that: on a device with only the real start's policy collections, reading
 * the relation answers LOADING, asks the server for what it reads, and then
 * answers it. Before POD-7547 a single relation answered null for a target
 * not in memory and asked for nothing, and `issue.sessions` answered only the
 * sessions that happened to be on the device.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { type CollectionServer, session } from '../../sync/src/conformance/collection-server'
import { LOADING } from './loading'
import { relationReads } from './shared/relation-reads'
import type { EntityName } from './shared/schema'
import { closedValue, ISSUE, issueValue } from './test-support/device.test.fixture'
import {
  bodyOf,
  type EmptyDevice,
  openEmptyDevice,
  putIssueWithBodies,
  requestKey,
} from './test-support/empty-device.test.fixture'

const devices: EmptyDevice[] = []
afterEach(() => {
  for (const device of devices.splice(0)) device.dispose()
})

/** Inside every "recent" window of the policy, and long before it. */
const RECENT = '2026-11-17T12:00:00.000Z'
const OLD = '2020-01-01T00:00:00.000Z'

/** An issue no policy collection holds: closed, changed long ago. */
const OLD_ISSUE = 'old'
/** A session no policy collection holds: ended, active long ago, on no issue. */
const OLD_SESSION = 'olds'

type Server = CollectionServer

/** The issue and the session the policy does not hold. */
function putTargets(server: Server): void {
  server.put(ISSUE, OLD_ISSUE, closedValue(OLD_ISSUE, { seq: 90, updatedAt: OLD }))
  server.put(
    'session',
    OLD_SESSION,
    session(OLD_SESSION, { status: 'exited', lastActiveAt: OLD }) as Record<string, unknown>,
  )
}

/** An open issue the first download holds (the sidebar), with `fields`. */
const openIssue = (server: Server, id: string, fields: Record<string, unknown>) =>
  server.put(ISSUE, id, issueValue(id, { updatedAt: RECENT, deps: [], ...fields }))

/** A dependency edge: its own record, which comes with the issue that depends (`deps` is composed from it). */
const putDep = (server: Server, fromId: string, toId: string, type: string) =>
  server.put('issueDep', `${fromId}-${type}-${toId}`, {
    id: `${fromId}-${type}-${toId}`,
    fromId,
    toId,
    type,
  })

/** An effect the first download holds (the effect window), acting on `target`. */
const putEffect = (server: Server, id: string, target: { kind: string; id: string }) =>
  server.put('effect', id, {
    id,
    kind: target.kind === 'issue' ? 'issue.merge' : 'session.interrupt',
    target,
    input: {},
    cancelRequested: false,
    effect: { status: 'running' },
    createdBy: 'u-ada',
    createdAt: RECENT,
    updatedAt: RECENT,
    revision: 1,
  })

interface LookupCase {
  /** The source entity and the id of the source record. */
  readonly from: EntityName
  readonly source: string
  /** The target the relation names, which the first download does not hold. */
  readonly target: string
  readonly world: (server: Server) => void
  /** Run before the read: what makes the source itself be on the device. */
  readonly open?: (device: EmptyDevice) => void
}

/** A body record of the old issue, on the device because a view holds the old issue's body. */
const bodyCase = (kind: string, source: string): LookupCase => ({
  from: kind as EntityName,
  source,
  target: OLD_ISSUE,
  world: (server) =>
    putIssueWithBodies(server, OLD_ISSUE, {
      stage: 'done',
      closedReason: 'completed',
      updatedAt: OLD,
    }),
  open: (device) => {
    device.observe(
      () => null,
      () => device.pool.collections.held(bodyOf(kind, OLD_ISSUE)),
    )
  },
})

/** One case per relation the check calls a lookup. */
const LOOKUPS: Readonly<Record<string, LookupCase>> = {
  'issue.startedBy': {
    from: 'issue',
    source: 'i1',
    target: OLD_SESSION,
    world: (server) => openIssue(server, 'i1', { startedBySession: OLD_SESSION }),
  },
  'issue.missionStartedBy': {
    from: 'issue',
    source: 'i1',
    target: OLD_SESSION,
    world: (server) => openIssue(server, 'i1', { startedBySession: OLD_SESSION }),
  },
  'issue.discoveredFrom': {
    from: 'issue',
    source: 'i1',
    target: OLD_ISSUE,
    world: (server) => {
      openIssue(server, 'i1', {})
      putDep(server, 'i1', OLD_ISSUE, 'discovered-from')
    },
  },
  'issue.pageDependencies': {
    from: 'issue',
    source: 'i1',
    target: OLD_ISSUE,
    world: (server) => {
      openIssue(server, 'i1', {})
      putDep(server, 'i1', OLD_ISSUE, 'blocked-by')
    },
  },
  'issue.supersedingIssue': {
    from: 'issue',
    source: 'i1',
    target: OLD_ISSUE,
    world: (server) => openIssue(server, 'i1', { supersededBy: OLD_ISSUE }),
  },
  'issue.canonicalIssue': {
    from: 'issue',
    source: 'i1',
    target: OLD_ISSUE,
    world: (server) => openIssue(server, 'i1', { duplicateOf: OLD_ISSUE }),
  },
  'session.bornIssue': {
    from: 'session',
    source: 's1',
    target: OLD_ISSUE,
    world: (server) =>
      server.put(
        'session',
        's1',
        session('s1', { status: 'live', lastActiveAt: RECENT, refIssueId: OLD_ISSUE }) as Record<
          string,
          unknown
        >,
      ),
  },
  'effect.issue': {
    from: 'effect',
    source: 'e1',
    target: OLD_ISSUE,
    world: (server) => putEffect(server, 'e1', { kind: 'issue', id: OLD_ISSUE }),
  },
  'effect.session': {
    from: 'effect',
    source: 'e1',
    target: OLD_SESSION,
    world: (server) => putEffect(server, 'e1', { kind: 'session', id: OLD_SESSION }),
  },
  'issueDescription.issue': bodyCase('issueDescription', OLD_ISSUE),
  'issueBrief.issue': bodyCase('issueBrief', OLD_ISSUE),
  'issuePanelState.issue': bodyCase('issuePanelState', OLD_ISSUE),
  'issuePanelTodo.issue': bodyCase('issuePanelTodo', `${OLD_ISSUE}-todo-0`),
  'issuePanelArtifact.issue': bodyCase('issuePanelArtifact', `${OLD_ISSUE}-artifact-0`),
  'issuePanelDeferred.issue': bodyCase('issuePanelDeferred', `${OLD_ISSUE}-deferred-0`),
}

const rows = relationReads()
const lookups = rows.filter((row) => row.read.kind === 'lookup').map((row) => row.relation)
const sessionHolds = rows
  .filter((row) => row.read.kind === 'holding' && row.read.collection === 'session.ofIssue')
  .map((row) => row.relation)

/** What a relation answers, as a test reads it: LOADING, null, or the target ids. */
function answerOf(value: unknown): unknown {
  if (value === LOADING) return 'LOADING'
  if (value === null) return null
  if (typeof value === 'object' && value !== null && 'members' in value) {
    const members = (value as { members: unknown }).members
    return members === LOADING ? 'LOADING' : (members as { id: string }[]).map((m) => m.id)
  }
  return (value as { id: string }).id
}

describe('a single relation to a record the device does not hold', () => {
  it('has a case for every relation the check calls a lookup', () => {
    expect(Object.keys(LOOKUPS).sort()).toEqual([...lookups].sort())
  })

  it.each(lookups)('%s answers LOADING, loads the record, then answers it', async (relation) => {
    const test = LOOKUPS[relation]!
    const device = await openEmptyDevice({
      world: (server) => {
        putTargets(server)
        test.world(server)
      },
    })
    devices.push(device)
    test.open?.(device)
    await device.untilIdle()
    const name = relation.slice(relation.indexOf('.') + 1)
    const source = device.pool.model(test.from, test.source)
    expect(source, 'the source is on the device').not.toBe(LOADING)
    const row = rows.find((each) => each.relation === relation)!
    expect(device.pool.tables[row.to].has(test.target), 'the target is not on the device').toBe(
      false,
    )
    const answers: unknown[] = []
    device.observe(
      () => source as unknown as Record<string, unknown>,
      (model) => answers.push(answerOf(model[name])),
    )
    await device.untilIdle()
    // An outgoing edge list is a collection of looked-up members.
    const expected =
      row.spec.kind === 'edge' && row.spec.many === true ? [test.target] : test.target
    expect(answers[0]).toBe('LOADING')
    expect(answers.at(-1)).toEqual(expected)
  })

  it('a dangling reference answers LOADING then null, with exactly one request', async () => {
    const device = await openEmptyDevice({
      world: (server) => openIssue(server, 'i1', { startedBySession: 'missing' }),
    })
    devices.push(device)
    const issue = device.pool.issueObject('i1')
    const answers: unknown[] = []
    const opened = device.observe(
      () => issue,
      (model) => answers.push(answerOf(model.startedBy)),
    )
    expect(answers[0]).toBe('LOADING')
    await device.untilIdle()
    expect(answers.at(-1)).toBeNull()
    for (let i = 0; i < 30; i++) expect(issue.startedBy).toBeNull()
    await device.untilIdle()
    expect(device.requestedKeys()).toEqual(['session.one{"id":"missing"}'])
    opened.close()
  })
})

it.each([
  'holding',
  'lookup',
] as const)('a burst of 30 %s reads makes one collection load', async (read) => {
  const ids = Array.from({ length: 30 }, (_, i) => `c${i}`)
  const device = await openEmptyDevice({
    world: (server) => {
      ids.forEach((id, i) => {
        server.put(
          ISSUE,
          id,
          closedValue(id, { seq: i + 1, updatedAt: RECENT, startedBySession: `s${i}` }),
        )
        server.put(
          'session',
          `s${i}`,
          session(`s${i}`, {
            status: 'exited',
            lastActiveAt: OLD,
            issueId: id,
          }) as Record<string, unknown>,
        )
      })
    },
  })
  devices.push(device)
  const before = device.recorder.loads.length
  const opened = device.observe(
    () => null,
    () =>
      ids.map((id) => {
        const issue = device.pool.issueObject(id)
        return answerOf(read === 'holding' ? issue.sessions : issue.startedBy)
      }),
  )
  await device.untilIdle()
  const loads = device.recorder.loads.slice(before).filter((load) => load.route === 'collections')
  expect(loads).toHaveLength(1)
  expect(loads[0]!.instances.map(requestKey).sort()).toEqual(
    ids
      .map((id, i) =>
        read === 'holding' ? `session.ofIssue{"issueId":"${id}"}` : `session.one{"id":"s${i}"}`,
      )
      .sort(),
  )
  opened.close()
})

describe('a to-many relation held through session.ofIssue', () => {
  /** A closed issue the first download holds (recent), with a session it does not (ended long ago). */
  const world = (server: Server) => {
    server.put(ISSUE, 'c1', closedValue('c1', { seq: 7, updatedAt: RECENT }))
    server.put(
      'session',
      'past',
      session('past', {
        status: 'exited',
        lastActiveAt: OLD,
        issueId: 'c1',
        harnessHandoff: true,
      }) as Record<string, unknown>,
    )
  }

  it('covers every relation the check calls holding through session.ofIssue', () => {
    expect([...sessionHolds].sort()).toEqual(
      [
        'issue.handoffSessions',
        'issue.missionSessions',
        'issue.pageSessions',
        'issue.sessions',
      ].sort(),
    )
  })

  it.each(
    sessionHolds,
  )('%s answers LOADING, holds the sessions of the issue, then answers them', async (relation) => {
    const device = await openEmptyDevice({ world })
    devices.push(device)
    const issue = device.pool.issueObject('c1') as unknown as Record<string, unknown>
    expect(device.pool.tables.issue.has('c1')).toBe(true)
    expect(device.pool.tables.session.has('past')).toBe(false)
    const name = relation.slice('issue.'.length)
    const answers: unknown[] = []
    const opened = device.observe(
      () => issue,
      (model) => answers.push(answerOf(model[name])),
    )
    await device.untilIdle()
    expect(answers[0]).toBe('LOADING')
    expect(answers.at(-1)).toEqual(['past'])
    expect(device.requestedKeys()).toContain('session.ofIssue{"issueId":"c1"}')
    expect(
      device.holds({ collection: 'session.ofIssue', args: { issueId: 'c1' }, part: 'main' }),
    ).toBe(true)
    const instance = {
      collection: 'session.ofIssue',
      args: { issueId: 'c1' },
      part: 'main',
    } as const
    expect(device.liveHolds(instance)).toBe(1)
    opened.close()
    await device.untilIdle()
    expect(device.liveHolds(instance)).toBe(0)
  })
})

/**
 * POD-7582 — the to-many relations that had nothing to hold. Each now holds
 * a collection of its own (or, for the children of an issue, the tree the
 * issue sits in): on an empty device it answers LOADING, asks for that
 * instance, and then answers the member the policy never brought.
 */
describe('a to-many relation held through a collection of its own', () => {
  interface HoldCase {
    readonly from: EntityName
    readonly source: string
    /** The member the first download does not hold. */
    readonly member: string
    readonly world: (server: Server) => void
    /** The instance the read asks for. */
    readonly asks: string
  }

  /** A closed issue changed long ago, with `fields`: no policy collection holds it whole. */
  const oldIssue = (server: Server, fields: Record<string, unknown>) =>
    server.put(ISSUE, OLD_ISSUE, closedValue(OLD_ISSUE, { seq: 90, updatedAt: OLD, ...fields }))

  /** A live session the first download holds, with `fields`. */
  const liveSession = (server: Server, id: string) =>
    server.put(
      'session',
      id,
      session(id, { status: 'live', lastActiveAt: RECENT }) as Record<string, unknown>,
    )

  const CASES: Readonly<Record<string, HoldCase>> = {
    // A sub-issue's children: its own subtree, not its top-level ancestor's tree.
    'issue.children': {
      from: 'issue',
      source: 'mid',
      member: OLD_ISSUE,
      world: (server) => {
        openIssue(server, 'top', {})
        openIssue(server, 'mid', { parentId: 'top' })
        oldIssue(server, { parentId: 'mid' })
      },
      asks: 'issueProjection.tree{"root":"mid"}',
    },
    'issue.treeChildren': {
      from: 'issue',
      source: 'top',
      member: OLD_ISSUE,
      world: (server) => {
        openIssue(server, 'top', {})
        oldIssue(server, { parentId: 'top' })
      },
      asks: 'issueProjection.tree{"root":"top"}',
    },
    'issue.bornSessions': {
      from: 'issue',
      source: 'i1',
      member: OLD_SESSION,
      world: (server) => {
        openIssue(server, 'i1', {})
        server.put(
          'session',
          OLD_SESSION,
          session(OLD_SESSION, {
            status: 'exited',
            lastActiveAt: OLD,
            refIssueId: 'i1',
          }) as Record<string, unknown>,
        )
      },
      asks: 'session.bornOf{"issueId":"i1"}',
    },
    'issue.supersededIssues': {
      from: 'issue',
      source: 'i1',
      member: OLD_ISSUE,
      world: (server) => {
        openIssue(server, 'i1', {})
        oldIssue(server, { supersededBy: 'i1' })
      },
      asks: 'issueProjection.supersededBy{"issueId":"i1"}',
    },
    'issue.duplicateIssues': {
      from: 'issue',
      source: 'i1',
      member: OLD_ISSUE,
      world: (server) => {
        openIssue(server, 'i1', {})
        oldIssue(server, { duplicateOf: 'i1' })
      },
      asks: 'issueProjection.duplicateOf{"issueId":"i1"}',
    },
    'issue.spinOffs': {
      from: 'issue',
      source: 'i1',
      member: OLD_ISSUE,
      world: (server) => {
        openIssue(server, 'i1', {})
        oldIssue(server, {})
        putDep(server, OLD_ISSUE, 'i1', 'discovered-from')
      },
      asks: 'issueDep.toIssue{"issueId":"i1"}',
    },
    'issue.pageDependents': {
      from: 'issue',
      source: 'i1',
      member: OLD_ISSUE,
      world: (server) => {
        openIssue(server, 'i1', {})
        oldIssue(server, {})
        putDep(server, OLD_ISSUE, 'i1', 'blocked-by')
      },
      asks: 'issueDep.toIssue{"issueId":"i1"}',
    },
    'session.startedIssues': {
      from: 'session',
      source: 's1',
      member: OLD_ISSUE,
      world: (server) => {
        liveSession(server, 's1')
        oldIssue(server, { startedBySession: 's1' })
      },
      asks: 'issueProjection.startedBy{"sessionId":"s1"}',
    },
    'session.missionStartedIssues': {
      from: 'session',
      source: 's1',
      member: OLD_ISSUE,
      world: (server) => {
        liveSession(server, 's1')
        oldIssue(server, { startedBySession: 's1' })
      },
      asks: 'issueProjection.startedBy{"sessionId":"s1"}',
    },
  }

  /** The holding relations POD-7582 gave a collection: neither a body nor a session of an issue. */
  const own = rows
    .filter(
      (row) =>
        row.read.kind === 'holding' &&
        row.read.collection !== 'session.ofIssue' &&
        row.group !== 'body',
    )
    .map((row) => row.relation)

  it('has a case for every such relation', () => {
    expect(Object.keys(CASES).sort()).toEqual([...own].sort())
  })

  it.each(
    own,
  )('%s answers LOADING, asks for its instance, then answers the member', async (relation) => {
    const test = CASES[relation]!
    const device = await openEmptyDevice({ world: test.world })
    devices.push(device)
    const source = device.pool.model(test.from, test.source)
    expect(source, 'the source is on the device').not.toBe(LOADING)
    const row = rows.find((each) => each.relation === relation)!
    expect(device.pool.tables[row.to].has(test.member), 'the member is not on the device').toBe(
      false,
    )
    const name = relation.slice(relation.indexOf('.') + 1)
    const answers: unknown[] = []
    const opened = device.observe(
      () => source as unknown as Record<string, unknown>,
      (model) => answers.push(answerOf(model[name])),
    )
    await device.untilIdle()
    expect(answers[0]).toBe('LOADING')
    expect(answers.at(-1)).toEqual([test.member])
    expect(device.requestedKeys()).toContain(test.asks)
    opened.close()
  })

  it('reads the children of a sub-issue from an ancestor tree the device already holds', async () => {
    const device = await openEmptyDevice({
      world: (server) => {
        openIssue(server, 'top', {})
        openIssue(server, 'mid', { parentId: 'top' })
        oldIssue(server, { parentId: 'mid' })
      },
    })
    devices.push(device)
    // A flight deck on the root holds its whole tree.
    const deck = device.observe(
      () => null,
      () => device.pool.collections.treeHeld('top'),
    )
    await device.untilIdle()
    const mid = device.pool.issueObject('mid')
    const answers: unknown[] = []
    const opened = device.observe(
      () => mid,
      (model) => answers.push(answerOf(model.children)),
    )
    await device.untilIdle()
    expect(answers).toEqual([[OLD_ISSUE]])
    expect(device.requestedKeys()).toEqual(['issueProjection.tree{"root":"top"}'])
    // Once the deck closes, the child read still holds the root's tree.
    deck.close()
    await device.untilIdle()
    const top = { collection: 'issueProjection.tree', args: { root: 'top' }, part: 'main' } as const
    expect(device.liveHolds(top)).toBe(1)
    opened.close()
    await device.untilIdle()
    expect(device.liveHolds(top)).toBe(0)
  })

  /** An epic `top` with two sub-issues, each with an old child the policy never brought. */
  const epic = (server: Server) => {
    openIssue(server, 'top', {})
    openIssue(server, 'mid', { parentId: 'top' })
    openIssue(server, 'mid2', { parentId: 'top' })
    oldIssue(server, { parentId: 'mid' })
    server.put(ISSUE, 'old2', closedValue('old2', { seq: 91, updatedAt: OLD, parentId: 'mid2' }))
  }
  const treeAt = (root: string) =>
    ({ collection: 'issueProjection.tree', args: { root }, part: 'main' }) as const

  it('waits on a tree a deck is loading, asking for no subtree of its own', async () => {
    const device = await openEmptyDevice({ world: epic })
    devices.push(device)
    // The deck asks for its root's tree; before it arrives, rows under it read their children.
    device.observe(
      () => null,
      () => device.pool.collections.treeHeld('top'),
    )
    const answers = new Map<string, unknown[]>()
    for (const id of ['mid', 'mid2']) {
      const issue = device.pool.issueObject(id)
      const seen: unknown[] = []
      answers.set(id, seen)
      device.observe(
        () => issue,
        (model) => seen.push(answerOf(model.children)),
      )
    }
    await device.untilIdle()
    expect(device.requestedKeys()).toEqual(['issueProjection.tree{"root":"top"}'])
    expect(answers.get('mid')?.[0]).toBe('LOADING')
    expect(answers.get('mid')?.at(-1)).toEqual([OLD_ISSUE])
    expect(answers.get('mid2')?.at(-1)).toEqual(['old2'])
  })

  it("releases a sub-issue's own subtree when its read closes", async () => {
    const device = await openEmptyDevice({ world: epic })
    devices.push(device)
    const mid = device.pool.issueObject('mid')
    const answers: unknown[] = []
    const opened = device.observe(
      () => mid,
      (model) => answers.push(answerOf(model.children)),
    )
    await device.untilIdle()
    expect(answers.at(-1)).toEqual([OLD_ISSUE])
    expect(device.requestedKeys()).toEqual(['issueProjection.tree{"root":"mid"}'])
    expect(device.liveHolds(treeAt('mid'))).toBe(1)
    opened.close()
    await device.untilIdle()
    expect(device.liveHolds(treeAt('mid'))).toBe(0)
  })

  it("moves to an ancestor's tree once it completes, releasing its own subtree", async () => {
    const device = await openEmptyDevice({ world: epic })
    devices.push(device)
    const mid = device.pool.issueObject('mid')
    const answers: unknown[] = []
    const opened = device.observe(
      () => mid,
      (model) => answers.push(answerOf(model.children)),
    )
    await device.untilIdle()
    expect(device.liveHolds(treeAt('mid'))).toBe(1)
    const deck = device.observe(
      () => null,
      () => device.pool.collections.treeHeld('top'),
    )
    await device.untilIdle()
    expect(answers.at(-1)).toEqual([OLD_ISSUE])
    expect(device.liveHolds(treeAt('mid'))).toBe(0)
    // One hold per instance, however many readers share it.
    expect(device.liveHolds(treeAt('top'))).toBe(1)
    deck.close()
    await device.untilIdle()
    expect(device.liveHolds(treeAt('top')), 'the child read keeps the tree').toBe(1)
    opened.close()
    await device.untilIdle()
    expect(device.liveHolds(treeAt('top'))).toBe(0)
  })
})
