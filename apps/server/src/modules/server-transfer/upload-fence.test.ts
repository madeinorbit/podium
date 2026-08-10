import type { ControlMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, makeOracle, waitFor } from '../sessions/oracle-support'
import { PortableStateFence } from './portable-fence'

afterEach(() => disposeOracles())

describe('portable upload fence', () => {
  it('drains an in-flight upload and rejects a new upload after fencing', async () => {
    const fence = new PortableStateFence()
    const oracle = makeOracle({ portableStateFence: fence })
    const { sessionId } = await oracle.call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/workspace',
    })
    let request: Extract<ControlMessage, { type: 'imageUploadRequest' }> | undefined
    oracle.reg.gateway.attachDaemon(oracle.store.hostMachineId, (message) => {
      if (message.type === 'imageUploadRequest') request = message
    })

    const first = oracle.call.sessions.uploadImage({
      sessionId,
      filename: 'first.png',
      mimeType: 'image/png',
      dataBase64: 'AA==',
    })
    await waitFor(() => request !== undefined, 'first upload request')

    let acquired = false
    const acquire = fence.acquire().then(() => {
      acquired = true
    })
    await Promise.resolve()
    expect(acquired).toBe(false)

    await expect(
      oracle.call.sessions.uploadImage({
        sessionId,
        filename: 'second.png',
        mimeType: 'image/png',
        dataBase64: 'AA==',
      }),
    ).rejects.toThrow('portable state is fenced for server transfer')

    oracle.reg.gateway.routeDaemonFrame(oracle.store.hostMachineId, {
      type: 'imageUploadResult',
      requestId: request?.requestId ?? '',
      path: '/state/uploads/session/first.png',
    })
    await expect(first).resolves.toEqual({ path: '/state/uploads/session/first.png' })
    await acquire
    expect(acquired).toBe(true)
    fence.release()
  })
})
