/**
 * POD-7545 — A HOLDING RELATION, ON AN EMPTY DEVICE.
 *
 * `IssueModel.description` and `IssueModel.brief` read their records through
 * relations whose target is on demand (group `body`). The relation's read is
 * the request (`shared/holding-relations.ts`, `models.ts` `members`): it holds
 * the issue's instance of the record while it is observed, asks the loader for
 * it, and answers LOADING until the device holds it complete. These tests run
 * on the real pool, loader and replica, against a server that answers only
 * what the device asked for.
 */
import { withoutIssueBodies } from '@podium/model'
import { runInAction } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstanceRequest } from '../../sync/src/replica/types'
import { LOADING } from './loading'
import { holdingInstanceOf } from './shared/holding-relations'
import { SCHEMA } from './shared/schema'
import { ISSUE, issueValue } from './test-support/device.test.fixture'
import {
  bodyOf,
  type EmptyDevice,
  FULL_BODIES,
  openEmptyDevice,
  putIssueWithBodies,
  requestKey,
} from './test-support/empty-device.test.fixture'

const devices: EmptyDevice[] = []
afterEach(() => {
  for (const device of devices.splice(0)) device.dispose()
})

/** Two issues with every body, and one with none (the server keeps no record for an empty field). */
async function emptyDevice() {
  const device = await openEmptyDevice({
    world: (server) => {
      putIssueWithBodies(server, 'i1')
      putIssueWithBodies(server, 'i2', { seq: 2 }, { ...FULL_BODIES, description: 'Second.' })
      server.put(
        ISSUE,
        'bare',
        withoutIssueBodies(
          issueValue('bare', { seq: 3, title: 'Bare', updatedAt: '2026-11-17T12:00:00.000Z' }),
        ) as Record<string, unknown>,
      )
    },
  })
  devices.push(device)
  return device
}

/** Count the loader's holds by instance, where the pool takes them. */
function countHolds(device: EmptyDevice): (instance: InstanceRequest) => number {
  const holds = new Map<string, number>()
  const loader = device.loader
  const show = loader.show.bind(loader)
  loader.show = (spec) => {
    const key = requestKey(spec)
    holds.set(key, (holds.get(key) ?? 0) + 1)
    const release = show(spec)
    return () => {
      holds.set(key, (holds.get(key) ?? 0) - 1)
      release()
    }
  }
  return (instance) => holds.get(requestKey(instance)) ?? 0
}

/** The collection loads after the first download (one per batch window). */
const collectionLoads = (device: EmptyDevice, from: number) =>
  device.recorder.loads.slice(from).filter((load) => load.route === 'collections')

describe('the declarations', () => {
  it('derive the instance each body relation reads, and nothing for the others', () => {
    const instance = (relation: string) =>
      holdingInstanceOf(SCHEMA, 'issue', relation)?.('i1') ?? null
    expect(instance('descriptionRecords')).toEqual(bodyOf('issueDescription', 'i1'))
    expect(instance('briefRecords')).toEqual(bodyOf('issueBrief', 'i1'))
    expect(instance('panelTodoRecords')).toEqual(bodyOf('issuePanelTodo', 'i1'))
    expect(instance('panelStateRecords')).toEqual(bodyOf('issuePanelState', 'i1'))
    // A relation whose target comes with the issue holds nothing of its own.
    expect(instance('sessions')).toBeNull()
    expect(instance('children')).toBeNull()
  })
})

describe('reading a body field on an empty device', () => {
  it('answers LOADING, asks once, then answers the text', async () => {
    const device = await emptyDevice()
    const issue = device.pool.issueObject('i1')
    const read = device.observe(
      () => issue,
      (model) => model.description,
    )
    expect(issue.description).toBe(LOADING)
    await device.untilIdle()
    expect(issue.description).toBe(FULL_BODIES.description)
    expect(device.requestedKeys()).toEqual([requestKey(bodyOf('issueDescription', 'i1'))])
    read.close()
  })

  it('holds the instance while observed and releases it when no reader is left', async () => {
    const device = await emptyDevice()
    const holds = countHolds(device)
    const description = bodyOf('issueDescription', 'i1')
    const first = device.observe(
      () => device.pool.issueObject('i1'),
      (model) => model.description,
    )
    const second = device.observe(
      () => device.pool.issueObject('i1'),
      (model) => model.description,
    )
    await device.untilIdle()
    expect(holds(description)).toBe(1)
    first.close()
    expect(holds(description)).toBe(1)
    second.close()
    expect(holds(description)).toBe(0)
    // Read again with nothing observing it: the instance is cache, still complete.
    expect(device.holds(description)).toBe(true)
    expect(device.pool.issueObject('i1').description).toBe(FULL_BODIES.description)
  })

  it('merges the reads of one screen into one request', async () => {
    const device = await emptyDevice()
    const before = device.recorder.loads.length
    const read = device.observe(
      () => null,
      () => {
        for (const id of ['i1', 'i2']) {
          const issue = device.pool.issueObject(id)
          void issue.description
          void issue.brief
        }
      },
    )
    await device.untilIdle()
    const loads = collectionLoads(device, before)
    expect(loads).toHaveLength(1)
    expect((loads[0]?.instances ?? []).map(requestKey).sort()).toEqual(
      [
        bodyOf('issueBrief', 'i1'),
        bodyOf('issueBrief', 'i2'),
        bodyOf('issueDescription', 'i1'),
        bodyOf('issueDescription', 'i2'),
      ]
        .map(requestKey)
        .sort(),
    )
    expect(device.pool.issueObject('i1').brief).toBe(FULL_BODIES.brief)
    expect(device.pool.issueObject('i2').description).toBe('Second.')
    read.close()
  })

  it('tells "complete and empty" from "not loaded"', async () => {
    const device = await emptyDevice()
    const issue = device.pool.issueObject('bare')
    const read = device.observe(
      () => issue,
      (model) => [model.description, model.brief, model.descriptionRecords.members],
    )
    expect(issue.description).toBe(LOADING)
    expect(issue.brief).toBe(LOADING)
    expect(issue.descriptionRecords.members).toBe(LOADING)
    await device.untilIdle()
    expect(issue.description).toBe('')
    expect(issue.brief).toBeUndefined()
    expect(issue.descriptionRecords.members).toEqual([])
    read.close()
  })

  it('answers a painted row at once, and keeps holding the body under it', async () => {
    const device = await emptyDevice()
    const painted = {
      ...withoutIssueBodies(issueValue('i1', { title: 'Task i1' })),
      description: { value: 'Painted here.' },
      brief: 'Painted brief.',
    }
    runInAction(() =>
      device.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'i1', value: painted }] }),
    )
    const issue = device.pool.issueObject('i1')
    const holds = countHolds(device)
    const read = device.observe(
      () => issue,
      (model) => [model.description, model.brief],
    )
    // The painted text, before anything arrived.
    expect(issue.description).toBe('Painted here.')
    expect(issue.brief).toBe('Painted brief.')
    // The body is held under the painted value, so it is there once the edit settles.
    expect(holds(bodyOf('issueDescription', 'i1'))).toBe(1)
    await device.untilIdle()
    expect(device.holds(bodyOf('issueDescription', 'i1'))).toBe(true)
    expect(issue.description).toBe('Painted here.')
    read.close()
  })

  it('offline, reads as "not available offline" and fills once the connection returns', async () => {
    const device = await emptyDevice()
    device.offline()
    const issue = device.pool.issueObject('i1')
    const read = device.observe(
      () => issue,
      (model) => model.description,
    )
    await device.untilIdle()
    expect(issue.description).toBe(LOADING)
    expect(device.pool.collections.reading(issue.description)).toBe('offline')
    expect(device.requested()).toEqual(device.refused())

    device.online()
    await device.untilIdle()
    expect(issue.description).toBe(FULL_BODIES.description)
    expect(device.pool.collections.reading(issue.description)).toBe('here')
    read.close()
  })
})

describe('loading is not refreshing', () => {
  it('a refused resume keeps the last text, refreshing, until the reload brings the new one', async () => {
    const device = await emptyDevice()
    const issue = device.pool.issueObject('i1')
    const description = bodyOf('issueDescription', 'i1')
    const read = device.observe(
      () => issue,
      (model) => model.description,
    )
    await device.untilIdle()
    expect(issue.description).toBe(FULL_BODIES.description)

    // The link drops; while it is down the server moves past what it retains,
    // and the replacement load is held back.
    const server = device.server
    device.offline()
    server.put('issueDescription', 'i1', { id: 'i1', text: 'Rewritten while away.' })
    server.minAvailableSeq = server.head
    let release: (() => void) | undefined
    server.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      device.online()
      await device.settle()
      expect(device.replica.posture).toBe('bootstrapping')
      // The device held it complete: the last value, never LOADING.
      expect(device.replica.instanceStale(description)).toBe(true)
      expect(issue.description).toBe(FULL_BODIES.description)
      expect(device.pool.collections.reading(issue.description, [description])).toBe('refreshing')

      release?.()
      server.gate = undefined
      await device.untilIdle()
      expect(device.replica.posture).toBe('live')
      expect(issue.description).toBe('Rewritten while away.')
    } finally {
      release?.()
      read.close()
    }
  })
})
