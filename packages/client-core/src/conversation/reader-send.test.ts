import { asSessionId } from '@podium/model'
import { expect, it, vi } from 'vitest'
import { createSendsFixture } from './model-test-support'

it('keeps the submitting reader choice with its command through a retry', async () => {
  const deliver = vi
    .fn()
    .mockRejectedValueOnce(new Error('not sent'))
    .mockResolvedValue({ state: 'sent' })
  const sends = createSendsFixture({
    sessionId: asSessionId('reader'),
    createDeliveryId: () => 'command',
    deliver,
    transcript: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} },
  })
  const backend = { model: 'chosen', effort: 'high', agentKind: 'claude-code' }
  try {
    sends.start()
    await sends.submit({ text: 'prompt', backend })
    await sends.retry('pending-1')
    expect(deliver.mock.calls.map(([turn]) => turn.backend)).toEqual([backend, backend])
  } finally {
    sends.dispose()
  }
})
