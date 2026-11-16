import { describe, expect, it } from 'vitest'
import { HarnessExecRequestMessage } from './harness'
import { HeadlessTurnRequestMessage } from './headless'
import { RuntimeDurableSendRequestMessage, RuntimeSendRequestMessage } from './runtime'
import { DriverSelectedMessage, SpawnMessage } from './terminal'

/**
 * POSTURE ON THE WIRE (POD-6858 Task 9, harness-session-posture.md §4.2–4.3).
 *
 * The server states a session's launch terms in Podium's own words, inside the
 * frames it sends anyway: the runtime turn frame (and its durable twin), the
 * headless turn frame, the buffered exec frame and the spawn frame. An older peer sends no
 * `posture`, so each frame must still parse without one; a mode that is
 * neither of the two levels nor a native pick is refused, never passed on.
 */

const turnFrame = {
  type: 'runtimeSendRequest',
  requestId: 'r1',
  turnId: 't1',
  sessionId: 's-posture',
  text: 'hello',
  origin: 'system',
  delivery: 'when-ready',
}
const durableFrame = {
  ...turnFrame,
  type: 'runtimeDurableSendRequest',
  rowId: 'row-1',
  deliveryRecovery: false,
  initialPrompt: false,
}
const headlessFrame = {
  type: 'headlessTurnRequest',
  requestId: 'r1',
  turnId: 't1',
  sessionId: 's-posture',
  accountId: 'native:claude-code:abc',
  requestDigest: 'a'.repeat(64),
  threadId: 'global',
  agent: 'claude-code',
  cwd: '/repo',
  prompt: 'hello',
}
const execFrame = {
  type: 'harnessExecRequest',
  requestId: 'r1',
  agent: 'claude-code',
  prompt: 'hello',
  cwd: '/repo',
}

const spawnFrame = {
  type: 'spawn',
  sessionId: 's-posture',
  agentKind: 'claude-code',
  cwd: '/repo',
  geometry: { cols: 80, rows: 24 },
}

const frames = [
  ['runtimeSendRequest', RuntimeSendRequestMessage, turnFrame],
  ['runtimeDurableSendRequest', RuntimeDurableSendRequestMessage, durableFrame],
  ['headlessTurnRequest', HeadlessTurnRequestMessage, headlessFrame],
  ['harnessExecRequest', HarnessExecRequestMessage, execFrame],
  ['spawn', SpawnMessage, spawnFrame],
] as const

describe.each(frames)('%s carries a posture', (_name, schema, frame) => {
  it.each([
    { mode: 'supervised' },
    { mode: 'autonomous' },
    { mode: { native: 'plan' } },
  ])('round-trips %j', (posture) => {
    const parsed = schema.parse({ ...frame, posture })
    expect((parsed as { posture?: unknown }).posture).toEqual(posture)
    const again = schema.parse(JSON.parse(JSON.stringify(parsed)))
    expect(again).toEqual(parsed)
  })

  it('parses a frame from a peer that sends no posture', () => {
    const parsed = schema.parse(frame)
    expect('posture' in parsed).toBe(false)
  })

  it.each([
    { mode: 'yolo' },
    { mode: 'auto' },
    { mode: { native: '' } },
    {},
  ])('refuses the posture %j', (posture) => {
    expect(schema.safeParse({ ...frame, posture }).success).toBe(false)
  })
})

/**
 * WHAT A LAUNCH COULD NOT MEET, REPORTED BACK (POD-6858 Task 11, §4.2 and §5).
 *
 * The daemon reports the applied terms on the frame it already sends for the
 * driver decision: the harness mode Podium asked for and every requirement
 * this launch cannot meet, with the reason in words. An older daemon sends
 * none, and the frame still parses.
 */
describe('driverSelected carries the launch report', () => {
  const selected = { type: 'driverSelected', sessionId: 's-posture', driverId: 'generic-pty' }

  it('round-trips a report with one unmet requirement', () => {
    const posture = {
      requestedMode: 'auto',
      unmet: [{ requirement: 'autonomy', reason: 'Pi has no approval gate to supervise with' }],
    }
    const parsed = DriverSelectedMessage.parse({ ...selected, posture })
    expect(parsed.posture).toEqual(posture)
    expect(DriverSelectedMessage.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })

  it('round-trips a report with no requested mode and nothing unmet', () => {
    const parsed = DriverSelectedMessage.parse({
      ...selected,
      posture: { requestedMode: null, unmet: [] },
    })
    expect(parsed.posture).toEqual({ requestedMode: null, unmet: [] })
  })

  it('parses a frame from a daemon that sends no report', () => {
    const parsed = DriverSelectedMessage.parse(selected)
    expect('posture' in parsed).toBe(false)
  })

  it('refuses a requirement that is not one of the five', () => {
    const posture = { requestedMode: null, unmet: [{ requirement: 'folder-trust', reason: 'x' }] }
    expect(DriverSelectedMessage.safeParse({ ...selected, posture }).success).toBe(false)
  })
})
