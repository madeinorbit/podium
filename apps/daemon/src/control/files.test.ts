import { describe, expect, it } from 'vitest'
import type { ControlMessage, DaemonMessage } from '@podium/protocol'
import { PortableStateFence } from '../portable-state-fence'
import type { DaemonContext } from './context'
import { fileHandlers } from './files'

describe('image upload transfer fence', () => {
  it('rejects a new upload after portable-state admission closes', async () => {
    const fence = new PortableStateFence()
    await fence.pauseAndDrain()
    const reply = new Promise<Extract<DaemonMessage, { type: 'imageUploadResult' }>>((resolve) => {
      const ctx = {
        portableStateFence: fence,
        send: (message: DaemonMessage) => {
          if (message.type === 'imageUploadResult') resolve(message)
        },
      } as unknown as DaemonContext
      const msg = {
        type: 'imageUploadRequest',
        requestId: 'request-fenced',
        sessionId: 'session-fenced',
        mimeType: 'image/png',
        dataBase64: Buffer.from('image').toString('base64'),
      } as Extract<ControlMessage, { type: 'imageUploadRequest' }>
      fileHandlers.imageUploadRequest(ctx, msg)
    })

    await expect(reply).resolves.toMatchObject({
      requestId: 'request-fenced',
      path: '',
      error: expect.stringContaining('portable state writes are paused'),
    })
  })
})
