/**
 * POD-7609 — OPENING A DECK'S ARCHIVE SENDS THE ARCHIVED SESSIONS, NOT THE
 * TREE'S ISSUES AGAIN.
 *
 * The deck holds its root's tree (`issueProjection.tree`). Its archive is one
 * instance for the whole tree (`issueProjection.treeArchive`, POD-7580): the
 * same issues by the same rule, each with its archived sessions. Before this
 * change, opening the archive downloaded every issue of the tree again. Now
 * the device names the tree it holds (`rowsHeld`), and the answer carries only
 * the issues changed after the device's feed number, plus the archived
 * sessions. The archive's marker still counts every issue of the tree.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { type CollectionServer, session } from '../../sync/src/conformance/collection-server'
import type { BootstrapChunk, InstanceRequest } from '../../sync/src/replica/types'
import { LOADING } from './loading'
import { MissionScreen } from './mission-screen'
import { attachMissionTestPreferences } from './mission-screen.test.fixture'
import { settled } from './mission-view'
import { closedValue, ISSUE, issueValue } from './test-support/device.test.fixture'
import { type EmptyDevice, openEmptyDevice } from './test-support/empty-device.test.fixture'

const devices: EmptyDevice[] = []
afterEach(() => {
  for (const device of devices.splice(0)) device.dispose()
})

const RECENT = '2026-11-17T12:00:00.000Z'
const OLD = '2020-01-01T00:00:00.000Z'
/** The tree's issues, the root included. */
const SIZE = 900
/** Every this many issues has an archived agent. */
const ARCHIVED_EVERY = 10
const TREE = { collection: 'issueProjection.tree', args: { root: 'top' }, part: 'main' } as const
const ARCHIVE = {
  collection: 'issueProjection.treeArchive',
  args: { root: 'top' },
  part: 'main',
} as const

/** An open root, 29 open groups under it, and closed old issues under the groups: 900 in all. */
function world(server: CollectionServer): void {
  server.put(ISSUE, 'top', issueValue('top', { updatedAt: RECENT, deps: [] }))
  const groups = 29
  for (let at = 0; at < groups; at += 1)
    server.put(
      ISSUE,
      `g${at}`,
      issueValue(`g${at}`, { parentId: 'top', updatedAt: RECENT, deps: [] }),
    )
  for (let at = 0; at < SIZE - 1 - groups; at += 1)
    server.put(
      ISSUE,
      `i${at}`,
      closedValue(`i${at}`, {
        seq: 100 + at,
        parentId: `g${at % groups}`,
        updatedAt: OLD,
        deps: [],
      }),
    )
  // Outside the tree: a closed issue with two closed sub-issues, never on the device.
  server.put(
    ISSUE,
    'out',
    closedValue('out', { seq: 2000, parentId: null, updatedAt: OLD, deps: [] }),
  )
  for (const id of ['out-a', 'out-b'])
    server.put(ISSUE, id, closedValue(id, { seq: 2001, parentId: 'out', updatedAt: OLD, deps: [] }))
  const ids = ['top', ...Array.from({ length: groups }, (_, at) => `g${at}`)]
  for (let at = 0; at < SIZE - 1 - groups; at += 1) ids.push(`i${at}`)
  ids.forEach((issueId, at) => {
    if (at % ARCHIVED_EVERY !== 0) return
    server.put(
      'session',
      `past-${issueId}`,
      session(`past-${issueId}`, {
        issueId,
        status: 'exited',
        archived: true,
        lastActiveAt: OLD,
      }) as Record<string, unknown>,
    )
  })
}

const ARCHIVED = Math.ceil(SIZE / ARCHIVED_EVERY)

interface Answer {
  readonly instances: readonly InstanceRequest[]
  readonly chunks: BootstrapChunk[]
}

/** Every collection fetch's request and the chunks the device received for it, from now on. */
function watchAnswers(device: EmptyDevice): Answer[] {
  const answers: Answer[] = []
  const answer = device.server.collections.bind(device.server)
  device.server.collections = (instances) => {
    const seen: Answer = { instances: [...instances], chunks: [] }
    answers.push(seen)
    return (async function* () {
      for await (const chunk of answer(instances)) {
        seen.chunks.push(chunk)
        yield chunk
      }
    })()
  }
  return answers
}

const asking = (answer: Answer, instance: typeof TREE | typeof ARCHIVE) =>
  answer.instances.some(
    (each) => each.collection === instance.collection && each.args?.['root'] === 'top',
  )

/** The ids of one record type an answer sent whole. */
const sent = (answer: Answer, entity: string) =>
  answer.chunks.flatMap((chunk) =>
    chunk.changes.filter((change) => change.entity === entity).map((change) => change.entityId),
  )

async function openDeck() {
  const device = await openEmptyDevice({ world })
  devices.push(device)
  attachMissionTestPreferences(device.pool)
  const answers = watchAnswers(device)
  const results: unknown[] = []
  const opened = device.observe(
    () => new MissionScreen(device.pool, 'top', { sessionName: (s) => s.name ?? '' }),
    (screen) => {
      // Only what the archive shows: the count and the listed agents.
      const answer = settled(() => {
        if (!screen.ready || !screen.archivedOpen) return screen.ready ? 'closed' : LOADING
        const archive = screen.reader.archive(screen.rootId, screen.mode)
        return [screen.archivedCount ?? null, archive === LOADING ? LOADING : archive.length]
      })
      results.push(answer === LOADING ? 'LOADING' : answer)
    },
  )
  await device.untilIdle()
  expect(device.holds(TREE), 'the deck holds its tree').toBe(true)
  return { device, answers, results, screen: opened.model, close: opened.close }
}

describe('opening the archive of a held tree sends only what the device lacks (POD-7609)', () => {
  it(`sends no issue of a held ${SIZE}-issue tree unchanged since the tree's answer`, async () => {
    const { device, answers, results, screen, close } = await openDeck()
    const tree = answers.find((answer) => asking(answer, TREE))!
    // Before: the tree's own answer brought every issue under the root.
    expect(new Set(sent(tree, ISSUE)).size).toBeGreaterThanOrEqual(SIZE)
    const before = answers.length
    screen.setArchivedOpen(true)
    await device.untilIdle()
    const opening = answers.slice(before).filter((answer) => asking(answer, ARCHIVE))
    expect(opening).toHaveLength(1)
    const archive = opening[0]!
    // The request names the tree the device holds; the marker is the archive's own.
    expect(archive.instances).toEqual([
      { ...ARCHIVE, rowsHeld: { collection: TREE.collection, seq: expect.any(Number) } },
    ])
    // After: no issue again, and every archived agent.
    expect(sent(archive, ISSUE)).toEqual([])
    expect(new Set(sent(archive, 'session')).size).toBe(ARCHIVED)
    expect(results.at(-1)).toEqual([ARCHIVED, ARCHIVED])
    expect(device.holds(ARCHIVE)).toBe(true)
    // The archive counts the tree's issues among its members, though none was sent.
    expect(device.instanceMembers(ARCHIVE).size).toBe(SIZE)
    console.log(
      `ROWS-HELD tree issues=${new Set(sent(tree, ISSUE)).size} archive issues=${sent(archive, ISSUE).length} archive sessions=${new Set(sent(archive, 'session')).size}`,
    )
    close()
  })

  it('sends an issue changed after the tree was answered, and only it', async () => {
    const { device, answers, results, screen, close } = await openDeck()
    // Changed on the server after the tree's answer; the device has not seen it.
    device.server.put(
      ISSUE,
      'i7',
      closedValue('i7', {
        seq: 107,
        parentId: 'g7',
        updatedAt: RECENT,
        title: 'Renamed',
        deps: [],
      }),
    )
    const before = answers.length
    screen.setArchivedOpen(true)
    await device.untilIdle()
    const archive = answers.slice(before).find((answer) => asking(answer, ARCHIVE))!
    expect(sent(archive, ISSUE)).toEqual(['i7'])
    expect(results.at(-1)).toEqual([ARCHIVED, ARCHIVED])
    expect(device.instanceMembers(ARCHIVE).size).toBe(SIZE)
    close()
  })

  it('sends an issue moved under the tree with the sub-issues it brings', async () => {
    const { device, answers, results, screen, close } = await openDeck()
    expect(device.pool.tables.issue.has('out-a'), 'the sub-issue is not on the device').toBe(false)
    // Moved under a group after the tree's answer; only the moved issue changed.
    device.server.put(
      ISSUE,
      'out',
      closedValue('out', { seq: 2000, parentId: 'g3', updatedAt: RECENT, deps: [] }),
    )
    const before = answers.length
    screen.setArchivedOpen(true)
    await device.untilIdle()
    const archive = answers.slice(before).find((answer) => asking(answer, ARCHIVE))!
    expect([...sent(archive, ISSUE)].sort()).toEqual(['out', 'out-a', 'out-b'])
    expect(results.at(-1)).toEqual([ARCHIVED, ARCHIVED])
    expect(device.instanceMembers(ARCHIVE).size).toBe(SIZE + 3)
    close()
  })
})
