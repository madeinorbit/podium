import { afterEach, expect, it, vi } from 'vitest'
import { LOADING } from './loading'
import { attachMobileScreens } from './mobile-screens'
import { MobileTasksBoard } from './mobile-tasks'
import {
  type EmptyDevice,
  FULL_BODIES,
  openEmptyDevice,
  putIssueWithBodies,
} from './test-support/empty-device.test.fixture'
import { PHONE_BODY_FIELDS, phoneBodyReaders } from './test-support/screens.test.fixture'

const devices: EmptyDevice[] = []
afterEach(() => {
  for (const device of devices.splice(0)) device.dispose()
  vi.restoreAllMocks()
})

async function emptyDevice(withUpload = false) {
  const device = await openEmptyDevice({
    world(server) {
      for (let i = 0; i < 30; i++) putIssueWithBodies(server, `i${i}`, { seq: i + 1 })
      if (withUpload)
        server.put('issuePanelArtifact', 'i0-upload', {
          id: 'i0-upload',
          issueId: 'i0',
          position: 1,
          path: 'photo.png',
          addedAt: '2026-11-17T12:00:00.000Z',
          chatUploadId: 'upload-id',
          artifactId: 'stored-photo',
        })
    },
  })
  devices.push(device)
  return device
}

it.each(
  Object.keys(PHONE_BODY_FIELDS) as (keyof typeof PHONE_BODY_FIELDS)[],
)('%s requests and shows its body content on an empty phone', async (surface) => {
  const device = await emptyDevice(surface === 'chatUpload')
  expect(device.pool.tables.issueDescription.size).toBe(0)
  const reader = phoneBodyReaders(device, 'i0', surface)
  const opened = device.observe(
    () => reader,
    (view) => view.content(),
  )
  expect(Object.values(reader.content()).every((value) => value === LOADING)).toBe(true)
  await device.untilIdle()
  expect(reader.loading()).toBe(false)
  const content = reader.content()
  const expected = {
    description: FULL_BODIES.description,
    brief: FULL_BODIES.brief,
    activityNotes: FULL_BODIES.stateLine,
    notesUpdatedAt: '2026-11-17T12:00:00.000Z',
    panel: {
      todos: FULL_BODIES.todos,
      artifacts: FULL_BODIES.artifacts,
      deferred: [{ text: FULL_BODIES.deferred[0] }],
    },
    chatUploads: new Map(),
  }
  for (const field of PHONE_BODY_FIELDS[surface]) {
    if (field === 'chatUploads') {
      const uploads = device.pool.issueObject('i0').chatUploads
      if (uploads === LOADING) throw new Error('Uploads still loading')
      expect(uploads.get('upload-id')).toMatchObject({
        path: 'photo.png',
        artifactId: 'stored-photo',
      })
    } else if (typeof expected[field] === 'object')
      expect(content[field]).toMatchObject(expected[field])
    else expect(content[field]).toBe(expected[field])
  }
  expect(device.requested().length).toBeGreaterThan(0)
  opened.close()
})

it('a never-opened phone body is unavailable offline and fills on reconnect', async () => {
  const device = await emptyDevice()
  device.offline()
  const reader = phoneBodyReaders(device, 'i0', 'taskOverview')
  const opened = device.observe(
    () => reader,
    (view) => view.content(),
  )
  await device.untilIdle()
  for (const answer of Object.values(reader.content())) {
    expect(answer).toBe(LOADING)
    expect(device.pool.collections.reading(answer)).toBe('offline')
  }
  device.online()
  await device.untilIdle()
  expect(reader.content().description).toBe(FULL_BODIES.description)
  expect(reader.content().activityNotes).toBe(FULL_BODIES.stateLine)
  opened.close()
})

it('phone list rows request no body and never warn about many body holds', async () => {
  const device = await emptyDevice()
  await attachMobileScreens(device.pool)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const board = new MobileTasksBoard(device.pool, {
    showDone: true,
    expanded: [],
    filter: {},
    ordering: 'priority',
    showAgentTasks: false,
  })
  const opened = device.observe(
    () => board,
    (view) => {
      void view.groups
      void view.stageCounts
      for (let i = 0; i < 30; i++) {
        const issue = device.pool.issueObject(`i${i}`)
        try {
          void issue.confirmedWorkingAgents
          void issue.taskProgress
          void issue.dependents
          void view.task(issue.id).mark
          void view.task(issue.id).progress
        } catch (error) {
          if (error !== LOADING) throw error
        }
      }
    },
  )
  await device.untilIdle()
  expect(
    device.requested().filter((spec) => /^issue(Description|Brief|Panel)/.test(spec.collection)),
  ).toEqual([])
  expect(
    warn.mock.calls.filter(([message]) => String(message).includes('Body read misuse:')),
  ).toEqual([])
  opened.close()
})
