import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { stateDir } from '@podium/runtime/config'

const CHUNK_BYTES = 8 * 1024 * 1024

export interface HandoffTransferRpc {
  handoffReadChunk(
    stagePath: string,
    offset: number,
    length: number,
    machineId: string,
  ): Promise<{ ok: boolean; data?: string; error?: string }>
  handoffWriteChunk(
    sessionId: string,
    offset: number,
    data: Buffer,
    machineId: string,
  ): Promise<{ ok: boolean; sizeBytes?: number; error?: string }>
}

/** Pull through a server-side canonical stage file, then push sequentially. */
export function verifiedBundleBases(results: { ok: boolean; output: string }[]): string[] {
  return [
    ...new Set(
      results
        .filter((result) => result.ok)
        .flatMap((result) => result.output.split(/\s+/u))
        .filter((value) => /^[0-9a-f]{40,64}$/u.test(value)),
    ),
  ]
}

/** Keep only source object IDs that the target independently proved it has. */
export function verifiedCommonBundleBases(
  sourceResults: { ok: boolean; output: string }[],
  targetResults: { ok: boolean; output: string }[],
): string[] {
  const targetShas = new Set(verifiedBundleBases(targetResults))
  return verifiedBundleBases(sourceResults).filter((sha) => targetShas.has(sha))
}

export async function transferHandoffPackage(input: {
  rpc: HandoffTransferRpc
  sessionId: string
  sourceMachineId: string
  targetMachineId: string
  sourceStagePath: string
  sizeBytes: number
}): Promise<void> {
  const dir = join(stateDir(), 'handoff')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${input.sessionId}-${Date.now()}.tgz`)
  const file = await open(path, 'w+')
  try {
    let offset = 0
    while (offset < input.sizeBytes) {
      const chunk = await input.rpc.handoffReadChunk(
        input.sourceStagePath,
        offset,
        Math.min(CHUNK_BYTES, input.sizeBytes - offset),
        input.sourceMachineId,
      )
      if (!chunk.ok || chunk.data === undefined)
        throw new Error(chunk.error ?? 'source package read failed')
      const bytes = Buffer.from(chunk.data, 'base64')
      if (bytes.length === 0) throw new Error('source package ended before advertised size')
      await file.write(bytes, 0, bytes.length, offset)
      offset += bytes.length
    }
    if (offset !== input.sizeBytes || (await file.stat()).size !== input.sizeBytes)
      throw new Error('handoff package size mismatch')

    offset = 0
    while (offset < input.sizeBytes) {
      const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, input.sizeBytes - offset))
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset)
      if (bytesRead === 0) throw new Error('server stage ended before advertised size')
      const payload = bytes.subarray(0, bytesRead)
      const written = await input.rpc.handoffWriteChunk(
        input.sessionId,
        offset,
        payload,
        input.targetMachineId,
      )
      if (!written.ok || written.sizeBytes !== offset + bytesRead)
        throw new Error(written.error ?? 'target package write failed')
      offset += bytesRead
    }
  } finally {
    await file.close()
    await rm(path, { force: true })
  }
}
