/**
 * A REFUSAL MEANS OPENCODE RECORDED NOTHING (POD-4839; POD-4819 §6.1 N2).
 *
 * Measured on 1.18.33 (POD-4834 S10): a 400 or a 404 to a prompt, v1 or v2,
 * recorded nothing. Nothing else is proof: a v2 409 means the id IS already
 * recorded, a 204 comes before storage, and a timeout, a dropped socket or a
 * 500 says nothing about what the server stored.
 */
import { describe, expect, it } from 'vitest'
import type { SessionSpec } from '../../host.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
import { createOpencodeRuntime } from './runtime.js'
import { makeOpencodeTestHost } from './test-support/host.js'

const spec = (): SessionSpec => ({
  harness: 'opencode',
  selection: { auth: 'api-key', platform: 'linux', available: ['opencode-server'] },
  workdir: '/tmp/refusal-test',
  model: {},
  instructions: { supported: false, reason: 'fixture' },
  mcpServers: { supported: false, reason: 'fixture' },
})
const options = { origin: 'human', delivery: 'when-ready' } as const

async function sendAfter(status: number) {
  const host = makeOpencodeTestHost()
  const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
  const handle = await runtime.driver.create(spec())
  host.serverFor(handle.binding.sessionId)?.failNextPrompt(status)
  const receipt = handle.send({ id: 'msg_one', text: 'one' }, options)
  return { runtime, handle, receipt }
}

describe('an OpenCode send is refused only when OpenCode recorded nothing', () => {
  it('refuses a prompt OpenCode answered 400, naming the answer', async () => {
    const { runtime, receipt } = await sendAfter(400)
    try {
      await expect(receipt).resolves.toMatchObject({
        outcome: 'refused',
        refusal: { reason: 'invalid_value', detail: expect.stringContaining('400') },
      })
    } finally {
      runtime.dispose()
    }
  })

  it('refuses a prompt OpenCode answered 404: the session is not there', async () => {
    const { runtime, receipt } = await sendAfter(404)
    try {
      await expect(receipt).resolves.toMatchObject({
        outcome: 'refused',
        refusal: { reason: 'session_ended', detail: expect.stringContaining('404') },
      })
    } finally {
      runtime.dispose()
    }
  })

  it('never refuses a prompt OpenCode answered with anything else: it may be stored', async () => {
    for (const status of [409, 500]) {
      const { runtime, handle, receipt } = await sendAfter(status)
      try {
        await expect(receipt).rejects.toThrow(String(status))
        // No turn opened, and the session is free for the next send.
        expect((await handle.snapshot()).turnEpoch).toBe(0)
      } finally {
        runtime.dispose()
      }
    }
  })
})
