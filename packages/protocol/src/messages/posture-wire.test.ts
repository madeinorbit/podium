import { describe, expect, it } from 'vitest'
import { HarnessExecRequestMessage } from './harness'
import { HeadlessTurnRequestMessage } from './headless'
import { RuntimeDurableSendRequestMessage, RuntimeSendRequestMessage } from './runtime'

/**
 * POSTURE ON THE WIRE (POD-6858 Task 9, harness-session-posture.md §4.2–4.3).
 *
 * The server states a session's launch terms in Podium's own words, inside the
 * frames it sends anyway: the runtime turn frame (and its durable twin), the
 * headless turn frame and the buffered exec frame. An older peer sends no
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

const frames = [
  ['runtimeSendRequest', RuntimeSendRequestMessage, turnFrame],
  ['runtimeDurableSendRequest', RuntimeDurableSendRequestMessage, durableFrame],
  ['headlessTurnRequest', HeadlessTurnRequestMessage, headlessFrame],
  ['harnessExecRequest', HarnessExecRequestMessage, execFrame],
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
