import type { SessionId, MachineId } from '@podium/model'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { stateDir } from '@podium/runtime/config'

const CHUNK_BYTES = 8 * 1024 * 1024

export interface HandoffTransferRpc {
  handoffReadChunk(
    stagePath: string,
    offset: number,
    length: number,
    machineId: MachineId,
  ): Promise<{ ok: boolean; data?: string; error?: string }>
  /**
   * PROPERTY SYNTAX, DELIBERATELY — and it is the whole guard (POD-1171).
   *
   * Written as a METHOD, this parameter is checked BIVARIANTLY, so an
   * implementation narrowing it to `SessionId` satisfies the port and the two
   * non-session callers below hand it a `ws-`/`ref-` token that its own signature
   * says cannot arrive. That compiled for three callers and caught nothing. As a
   * property, `strictFunctionTypes` (repo-wide `strict`) checks it
   * CONTRAVARIANTLY: an implementation must accept every token this pipe can
   * send, and one that accepts only session ids stops compiling at the call site.
   * `handoff-transfer.types.test.ts` holds the probe.
   */
  handoffWriteChunk: (
    stageToken: HandoffStageToken,
    offset: number,
    data: Buffer,
    machineId: MachineId,
  ) => Promise<{ ok: boolean; sizeBytes?: number; error?: string }>
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

/**
 * THE NAME OF THE THING (POD-1171, closing what POD-362 could only record).
 *
 * This value is a STAGE TOKEN: it names the `.tgz` the transfer stages on the
 * server and the one the target daemon appends into, and it correlates the
 * chunk writes of one transfer. It is not a session id, and it never was on two
 * of the three paths. The daemon side has always said so — `bundleStagePath(home,
 * token)` (POD-1405) is the one function that decides where a transfer lands, and
 * it takes a token.
 *
 * THREE CALLERS, THREE ID SPACES, measured at 95effa5eb:
 *   `handoff/transfer.ts:164`  `session.sessionId`         — a real `SessionId`
 *   `workspace.ts:254`         `ref-<uuid>` (POD-1405)     — a repository missing
 *                              a commit; no session, no workspace
 *   `workspace.ts:464`         `ws-<uuid>` fetch id        — not a session at all
 * All three ride one pipe because the pipe is about moving BYTES between two
 * daemons through the server, and a second copy of that is the duplication this
 * epic exists to cure (so: no separate transfer function).
 *
 * The union stays because it is the honest record of what a token can be, and
 * `SessionId` stays inside it because the handoff path really does use one —
 * widening to plain `string` would re-open what POD-362 closed. What changed is
 * that the parameter is now NAMED for the union it holds, and the port that
 * carries it to the rpc boundary is written so that an implementation cannot
 * quietly narrow it back (see `HandoffTransferRpc.handoffWriteChunk` above).
 *
 * THE WIRE IS UNTOUCHED: `handoffImportChunk.sessionId` still says `sessionId`.
 * Renaming a wire field drags in version negotiation and a compatibility window;
 * that is different work with different risk.
 */
export type HandoffStageToken = SessionId | `ws-${string}` | `ref-${string}`

/**
 * THE ONE PLACE A STAGE TOKEN IS CALLED A SESSION ID, and it exists because the
 * WIRE says so (POD-1171).
 *
 * `HandoffImportChunkMessage.sessionId` is declared `SessionIdField` and every
 * deployed daemon reads that field by that name, so the wire is frozen: renaming
 * or re-typing it is version negotiation and a compatibility window, which is
 * different work with different risk. The cast is therefore unavoidable at the
 * encode — but it is unavoidable exactly ONCE, here, with the reason attached,
 * instead of being spread across a parameter every caller touches.
 *
 * WHAT THIS IS NOT: it is not the laundering POD-362 refused. That refusal was
 * about the PARAMETER — brand it `SessionId` and every caller's wrong id becomes
 * invisible. The parameter is now `HandoffStageToken` and checked
 * contravariantly; this converts a value that has already been checked, at the
 * single byte-level boundary that cannot follow the rename.
 *
 * It is exported for exactly ONE importer — the rpc encode in `machines/rpc.ts` —
 * and must stay that way. A second call site would mean a stage token is being
 * called a session somewhere that is not the frozen wire, which is the bug this
 * issue closed.
 */
export const stageTokenAsFrozenWireField = (token: HandoffStageToken): SessionId =>
  token as SessionId

export async function transferHandoffPackage(input: {
  rpc: HandoffTransferRpc
  stageToken: HandoffStageToken
  sourceMachineId: MachineId
  targetMachineId: MachineId
  sourceStagePath: string
  sizeBytes: number
}): Promise<void> {
  const dir = join(stateDir(), 'handoff')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${input.stageToken}-${Date.now()}.tgz`)
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
        input.stageToken,
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
