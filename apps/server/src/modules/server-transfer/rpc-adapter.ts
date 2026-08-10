import type { ServerTransferManifest, ServerTransferResultMessage } from '@podium/protocol'
import type { ServerTransferRpc, ServerTransferRpcResult } from './types'

type WireReply = Omit<ServerTransferResultMessage, 'type' | 'requestId'>

interface WireOwnedRpc {
  serverTransferPrepare(
    input: { transferId: string; manifest: ServerTransferManifest; manifestDigest: string },
    machineId: string,
  ): Promise<WireReply>
  serverTransferChunk(
    input: {
      transferId: string
      path: string
      offset: number
      data: Buffer
      manifestDigest?: string
    },
    machineId: string,
  ): Promise<WireReply>
  serverTransferValidate(id: string, digest: string, machineId: string): Promise<WireReply>
  serverTransferPromote(
    id: string,
    digest: string,
    publicUrl: string,
    machineId: string,
  ): Promise<WireReply>
  serverTransferAbort(
    id: string,
    reason: string | undefined,
    machineId: string,
  ): Promise<WireReply>
  serverTransferAcknowledge(id: string, digest: string, machineId: string): Promise<WireReply>
  serverTransferStatus(
    id: string | undefined,
    machineId: string,
    digest?: string,
  ): Promise<WireReply>
}

function failure(
  reply: WireReply,
  fallbackCode: string,
  fallbackDetail: string,
): ServerTransferRpcResult<never> {
  return {
    ok: false,
    state: reply.state,
    error: {
      code: reply.errorCode ?? fallbackCode,
      detail: reply.error ?? fallbackDetail,
    },
  }
}

/** Bind the coordinator port to the typed, authenticated machine RPC. */
export function serverTransferRpcAdapter(wire: WireOwnedRpc): ServerTransferRpc {
  const pathsByTransfer = new Map<string, string[]>()
  return {
    async serverTransferPrepare(input, targetMachineId) {
      const { digest, ...manifest } = input.manifest
      if (input.sourceMachineId !== manifest.sourceMachineId) {
        return {
          ok: false,
          state: 'aborted',
          error: { code: 'identity-mismatch', detail: 'source manifest binding changed' },
        }
      }
      pathsByTransfer.set(
        input.transferId,
        manifest.files.map((entry) => entry.path),
      )
      const reply = await wire.serverTransferPrepare(
        { transferId: input.transferId, manifest, manifestDigest: digest },
        targetMachineId,
      )
      if (
        !reply.ok ||
        reply.state !== 'prepared' ||
        reply.transferId !== input.transferId ||
        reply.manifestDigest !== digest ||
        reply.targetCapability !== 'server-only' ||
        typeof reply.buildVersion !== 'string' ||
        typeof reply.wireSchemaDigest !== 'string' ||
        reply.space === undefined
      ) {
        return failure(reply, 'target-rejected', 'target prepare failed')
      }
      return {
        ok: true,
        state: 'prepared',
        manifestDigest: reply.manifestDigest,
        targetMachineId,
        targetCapability: reply.targetCapability,
        buildVersion: reply.buildVersion,
        wireSchemaDigest: reply.wireSchemaDigest,
        space: reply.space,
      }
    },

    async serverTransferChunk(input, targetMachineId) {
      const path = pathsByTransfer.get(input.transferId)?.[input.fileIndex]
      if (path === undefined) {
        return {
          ok: false,
          state: 'staging',
          error: { code: 'unknown-file', detail: 'unknown manifest file index' },
        }
      }
      const reply = await wire.serverTransferChunk(
        {
          transferId: input.transferId,
          manifestDigest: input.manifestDigest,
          path,
          offset: input.offset,
          data: input.data,
        },
        targetMachineId,
      )
      if (
        !reply.ok ||
        reply.state !== 'staging' ||
        reply.transferId !== input.transferId ||
        reply.manifestDigest !== input.manifestDigest ||
        reply.path !== path ||
        reply.offset !== input.offset ||
        reply.receivedBytes !== input.expectedLength
      ) {
        return failure(reply, 'target-rejected', 'target chunk failed')
      }
      return {
        ok: true,
        state: 'staging',
        manifestDigest: reply.manifestDigest,
        path: reply.path,
        offset: reply.offset,
        receivedBytes: reply.receivedBytes,
      }
    },

    async serverTransferValidate(input, targetMachineId) {
      const reply = await wire.serverTransferValidate(
        input.transferId,
        input.manifestDigest,
        targetMachineId,
      )
      if (
        !reply.ok ||
        reply.state !== 'validated' ||
        reply.transferId !== input.transferId ||
        reply.manifestDigest !== input.manifestDigest ||
        reply.proof === undefined
      ) {
        return failure(reply, 'target-proof-missing', 'target validation returned no proof')
      }
      return { ok: true, state: 'validated', proof: reply.proof }
    },

    async serverTransferPromote(input, targetMachineId) {
      const reply = await wire.serverTransferPromote(
        input.transferId,
        input.manifestDigest,
        input.publicUrl,
        targetMachineId,
      )
      if (
        !reply.ok ||
        reply.state !== 'promoted' ||
        reply.transferId !== input.transferId ||
        reply.manifestDigest !== input.manifestDigest
      ) {
        return failure(reply, 'uncertain-commit', 'target promotion failed')
      }
      return {
        ok: true,
        state: 'promoted',
        ...(reply.servingProof ? { proof: reply.servingProof } : {}),
      }
    },

    async serverTransferAcknowledge(input, targetMachineId) {
      const reply = await wire.serverTransferAcknowledge(
        input.transferId,
        input.manifestDigest,
        targetMachineId,
      )
      if (
        !reply.ok ||
        reply.state !== 'promoted' ||
        reply.transferId !== input.transferId ||
        reply.manifestDigest !== input.manifestDigest ||
        reply.acknowledged !== true
      ) {
        return failure(reply, 'target-rejected', 'target acknowledgement failed')
      }
      return {
        ok: true,
        state: 'promoted',
        transferId: reply.transferId,
        manifestDigest: reply.manifestDigest,
        acknowledged: true,
      }
    },

    async serverTransferAbort(input, targetMachineId) {
      const reply = await wire.serverTransferAbort(input.transferId, input.reason, targetMachineId)
      if (
        !reply.ok ||
        reply.state !== 'aborted' ||
        reply.transferId !== input.transferId ||
        reply.manifestDigest !== input.manifestDigest ||
        reply.cleaned !== true
      ) {
        return failure(reply, 'target-rejected', 'target abort failed')
      }
      pathsByTransfer.delete(input.transferId)
      return {
        ok: true,
        state: 'aborted',
        transferId: reply.transferId,
        manifestDigest: reply.manifestDigest,
        cleanup: 'cleaned',
      }
    },

    async serverTransferStatus(input, targetMachineId) {
      const reply = await wire.serverTransferStatus(
        input.transferId,
        targetMachineId,
        input.manifestDigest,
      )
      if (!reply.ok) return failure(reply, 'target-rejected', 'target status failed')
      return {
        ok: true,
        state:
          reply.state === 'promoted' ||
          reply.state === 'prepared' ||
          reply.state === 'staging' ||
          reply.state === 'validated' ||
          reply.state === 'aborted' ||
          reply.state === 'idle'
            ? reply.state
            : 'uncertain',
        ...(reply.transferId ? { transferId: reply.transferId } : {}),
        ...(reply.manifestDigest ? { manifestDigest: reply.manifestDigest } : {}),
        ...(reply.servingProof ? { proof: reply.servingProof } : {}),
        sourceConnected: false,
      }
    },
  }
}
