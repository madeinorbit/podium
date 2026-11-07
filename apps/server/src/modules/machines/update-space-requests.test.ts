import type {
  MachineSupervisorControlMessage,
  UpdateSpaceCheckMessage,
  UpdateTarget,
} from '@podium/protocol'
import { UPDATE_SPACE_TIMEOUT_MS } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateSpaceRequests } from './update-space-requests'

const brokers: UpdateSpaceRequests[] = []
afterEach(() => {
  for (const broker of brokers.splice(0)) broker.close()
  vi.useRealTimers()
})
const target: UpdateTarget = { version: 'next', critical: false, artifacts: {} }
const estimate = { status: 'low' as const, checkedAt: 10, volumes: [] }

describe('read-only supervisor space requests', () => {
  function fixture() {
    const broker = new UpdateSpaceRequests()
    brokers.push(broker)
    const sent: MachineSupervisorControlMessage[] = []
    const send = (message: MachineSupervisorControlMessage) => {
      sent.push(message)
    }
    const result = broker.request('machine-a', send, target, 'exact-target')
    const request = sent[0] as UpdateSpaceCheckMessage
    return { broker, sent, send, result, request }
  }

  it('sends only a preview and correlates machine, socket, target and request', async () => {
    const f = fixture()
    let settled = false
    void f.result.then(() => {
      settled = true
    })
    const response = {
      ...estimate,
      type: 'updateSpaceResult' as const,
      requestId: f.request.requestId,
      targetFingerprint: f.request.targetFingerprint,
    }
    f.broker.receive('machine-b', f.send, response)
    f.broker.receive('machine-a', () => {}, response)
    f.broker.receive('machine-a', f.send, { ...response, targetFingerprint: 'other' })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(f.sent.map((message) => message.type)).toEqual(['updateSpaceCheck'])
    f.broker.receive('machine-a', f.send, response)
    expect(await f.result).toEqual(estimate)
    f.broker.receive('machine-a', f.send, response) // late/duplicate reply is inert
  })

  it('times out as unknown, without throwing or sending any execution command', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await vi.advanceTimersByTimeAsync(UPDATE_SPACE_TIMEOUT_MS)
    expect((await f.result).status).toBe('unknown')
    expect(f.sent).toHaveLength(1)
  })

  it('contains send errors and closes pending requests', async () => {
    const f = fixture()
    expect(
      (
        await f.broker.request(
          'machine-a',
          () => {
            throw new Error('closed')
          },
          target,
          'target',
        )
      ).status,
    ).toBe('unknown')
    f.broker.close()
    expect((await f.result).status).toBe('unknown')
  })
})
