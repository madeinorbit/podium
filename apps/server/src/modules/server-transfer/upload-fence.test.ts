import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, makeOracle, waitFor } from '../sessions/oracle-support'
import { PortableStateFence } from './portable-fence'

afterEach(() => disposeOracles())

describe('portable upload fence', () => {
  /**
   * WHICH UPLOAD THIS FENCE GUARDS (577eb857a, 358ad0ffb).
   *
   * The server's portable-state fence wraps the `imageUploadRequest` RPC. Since
   * 358ad0ffb (POD-4427) every AGENT session is contract-driven, so an agent's
   * upload stages through its driver instead (577eb857a,
   * `runtimeStageAttachmentRequest`) and never reaches that RPC — this used to
   * drive a claude-code session and now timed out waiting for a request that
   * is never sent. The RPC, and so this fence, now carry plain shell sessions
   * and sessions not created yet, so the pin runs on a shell. The agent staging
   * write is fenced on the daemon instead: its `stageAttachment` runs inside
   * the daemon's own portable-state fence (apps/daemon/src/host-runtime.ts),
   * which the transfer's `pauseAndDrain` closes before this fence is acquired.
   */
  it('drains an in-flight upload and rejects a new upload after fencing', async () => {
    const fence = new PortableStateFence()
    const oracle = await makeOracle({ portableStateFence: fence })
    const { sessionId } = await oracle.call.sessions.create({
      agentKind: 'shell',
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
