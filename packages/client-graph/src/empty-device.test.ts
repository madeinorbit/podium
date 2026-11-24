/**
 * POD-7544 — the empty device itself, and the flight deck's root body: the
 * description and state line both load on read through their shared relations.
 * The web screens that do not ask are in `apps/web/src/features/issues/
 * empty-device-bodies.test.tsx`.
 */
import { afterEach, beforeEach, expect, it, type MockInstance, vi } from 'vitest'
import { LOADING } from './loading'
import { MissionScreen } from './mission-screen'
import { attachMissionTestPreferences } from './mission-screen.test.fixture'
import {
  BODY_KINDS,
  bodyOf,
  type EmptyDevice,
  FULL_BODIES,
  openEmptyDevice,
  putIssueWithBodies,
  requestKey,
} from './test-support/empty-device.test.fixture'

const ROOT = 'i1'
const devices: EmptyDevice[] = []
let warn: MockInstance<typeof console.warn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  for (const device of devices.splice(0)) device.dispose()
  const misuse = warn.mock.calls.filter(([message]) =>
    String(message).includes('Body read misuse:'),
  )
  warn.mockRestore()
  expect(misuse, 'the flight deck must not read bodies for a list').toEqual([])
})
async function emptyDevice() {
  const device = await openEmptyDevice({ world: (server) => putIssueWithBodies(server, ROOT) })
  devices.push(device)
  return device
}
const openDeck = (device: EmptyDevice) => {
  attachMissionTestPreferences(device.pool)
  return device.observe(
    () => new MissionScreen(device.pool, ROOT, { sessionName: () => '' }),
    (screen) => {
      void screen.ready
      void screen.root.description
      void screen.rootFindings
    },
  )
}

it('starts with the issue but none of its body, and answers only what is asked for', async () => {
  const device = await emptyDevice()
  // The issue is in the first download (open and recent); its six bodies are not.
  expect(device.pool.issueObject(ROOT).title).toBe(`Task ${ROOT}`)
  expect(BODY_KINDS).toHaveLength(6)
  for (const kind of BODY_KINDS) expect(device.holds(bodyOf(kind, ROOT))).toBe(false)
  // The server holds all six; nothing has been asked for yet.
  expect(device.server.idsOf('issueDescription')).toEqual([ROOT])
  expect(device.requested()).toEqual([])
  // The description is not on the device: its read answers LOADING (POD-7545).
  expect(device.pool.issueObject(ROOT).description).toBe(LOADING)

  // Asking for one instance brings that one and nothing else of the body.
  const description = bodyOf('issueDescription', ROOT)
  const read = device.observe(
    () => null,
    () => device.pool.collections.held(description),
  )
  await device.untilIdle()
  expect(device.requestedKeys()).toEqual([requestKey(description)])
  expect(device.holds(description)).toBe(true)
  expect(device.holds(bodyOf('issueBrief', ROOT))).toBe(false)
  expect(device.pool.issueObject(ROOT).description).toBe(FULL_BODIES.description)
  read.close()
})

// Test d of POD-7544: both field reads hold and load their records.
it("shows the deck root's description and state line on an empty device", async () => {
  const device = await emptyDevice()
  const deck = openDeck(device)
  await device.untilIdle()
  expect(deck.model.ready).toBe(true)
  expect(device.requestedKeys()).toEqual(
    expect.arrayContaining([
      requestKey(bodyOf('issueDescription', ROOT)),
      requestKey(bodyOf('issuePanelState', ROOT)),
    ]),
  )
  expect(deck.model.root.description).toBe(FULL_BODIES.description)
  expect(deck.model.rootFindings).toBe(FULL_BODIES.stateLine)
})

it('offline, the deck asks for its root body, reaches no server, and says offline', async () => {
  const device = await emptyDevice()
  device.offline()
  const deck = openDeck(device)
  await device.untilIdle()
  const description = bodyOf('issueDescription', ROOT)
  // Nothing reached the server: every attempt was refused before it.
  expect(device.requested()).toEqual(device.refused())
  expect(device.holds(description)).toBe(false)
  expect(device.pool.collections.status(description)).toBe('offline')
  expect(deck.model.ready).toBe(false)
  expect(deck.model.root.description).toBe(LOADING)
  expect(device.pool.collections.reading(deck.model.root.description)).toBe('offline')
  expect(deck.model.rootFindings).toBe(LOADING)
  expect(device.pool.collections.status(bodyOf('issuePanelState', ROOT))).toBe('offline')

  // Back online, the same open deck loads what it asked for.
  device.online()
  await device.untilIdle()
  expect(device.holds(description)).toBe(true)
  expect(deck.model.ready).toBe(true)
  expect(deck.model.root.description).toBe(FULL_BODIES.description)
  expect(deck.model.rootFindings).toBe(FULL_BODIES.stateLine)
})
