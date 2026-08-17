import { asMachineId } from '@podium/model'
import type { MachineId } from '@podium/model'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  PromotedTargetMetadata,
  PromotingTargetMetadata,
  TargetHealthProof,
  TransferProof,
} from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function string(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function proof(
  value: unknown,
  operationId: string,
  transferId: string,
  digest: string,
  targetMachineId: MachineId,
  publicUrl: string,
  port: number,
): TargetHealthProof | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<TargetHealthProof>
  if (
    candidate.operationId !== operationId ||
    candidate.transferId !== transferId ||
    candidate.manifestDigest !== digest ||
    candidate.targetMachineId !== targetMachineId ||
    candidate.health !== 'serving' ||
    candidate.publicUrl !== publicUrl ||
    candidate.port !== port ||
    !string(candidate.feedId) ||
    !string(candidate.feedEpoch) ||
    !string(candidate.schemaVersion) ||
    !string(candidate.buildVersion)
  ) {
    return undefined
  }
  return candidate as TargetHealthProof
}

function candidateProof(
  value: unknown,
  operationId: string,
  transferId: string,
  digest: string,
  targetMachineId: MachineId,
): TransferProof | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<TransferProof>
  if (
    candidate.operationId !== operationId ||
    candidate.transferId !== transferId ||
    candidate.manifestDigest !== digest ||
    candidate.targetMachineId !== targetMachineId ||
    !string(candidate.feedId) ||
    !string(candidate.feedEpoch) ||
    !string(candidate.schemaVersion) ||
    !string(candidate.buildVersion)
  ) {
    return undefined
  }
  return candidate as TransferProof
}

function parsePromoting(
  raw: string,
  expectedTransferId?: string,
): PromotingTargetMetadata | undefined {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (
    candidate.state !== 'promoting' ||
    !string(candidate.operationId) ||
    !string(candidate.transferId) ||
    (expectedTransferId !== undefined && candidate.transferId !== expectedTransferId) ||
    !string(candidate.sourceMachineId) ||
    !string(candidate.targetMachineId) ||
    !string(candidate.publicUrl) ||
    !string(candidate.manifestDigest) ||
    typeof candidate.port !== 'number' ||
    !Number.isInteger(candidate.port) ||
    candidate.port <= 0 ||
    candidate.port > 65_535
  ) {
    return undefined
  }
  const promotion = candidate.promotion
  if (
    typeof promotion !== 'object' ||
    promotion === null ||
    (promotion as Record<string, unknown>).idempotencyKey !== candidate.transferId ||
    (promotion as Record<string, unknown>).publicUrl !== candidate.publicUrl ||
    (promotion as Record<string, unknown>).port !== candidate.port ||
    (promotion as Record<string, unknown>).targetMode !== 'server'
  ) {
    return undefined
  }
  const validated = candidateProof(
    candidate.proof,
    candidate.operationId,
    candidate.transferId,
    candidate.manifestDigest,
    asMachineId(candidate.targetMachineId),
  )
  if (!validated) return undefined
  return {
    operationId: candidate.operationId,
    transferId: candidate.transferId,
    sourceMachineId: asMachineId(candidate.sourceMachineId),
    targetMachineId: asMachineId(candidate.targetMachineId),
    publicUrl: candidate.publicUrl,
    manifestDigest: candidate.manifestDigest,
    port: candidate.port,
    state: 'promoting',
    proof: validated,
  }
}

function parsePromoted(
  raw: string,
  expectedTransferId?: string,
): PromotedTargetMetadata | undefined {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (
    candidate.state !== 'promoted' ||
    !string(candidate.operationId) ||
    !string(candidate.transferId) ||
    (expectedTransferId !== undefined && candidate.transferId !== expectedTransferId) ||
    !string(candidate.sourceMachineId) ||
    !string(candidate.targetMachineId) ||
    !string(candidate.publicUrl) ||
    !string(candidate.manifestDigest) ||
    typeof candidate.port !== 'number' ||
    !Number.isInteger(candidate.port) ||
    candidate.port <= 0 ||
    candidate.port > 65_535
  ) {
    return undefined
  }
  const validated = proof(
    candidate.servingProof,
    candidate.operationId,
    candidate.transferId,
    candidate.manifestDigest,
    asMachineId(candidate.targetMachineId),
    candidate.publicUrl,
    candidate.port,
  )
  if (!validated) return undefined
  return {
    operationId: candidate.operationId,
    transferId: candidate.transferId,
    sourceMachineId: asMachineId(candidate.sourceMachineId),
    targetMachineId: asMachineId(candidate.targetMachineId),
    publicUrl: candidate.publicUrl,
    manifestDigest: candidate.manifestDigest,
    port: candidate.port,
    state: 'promoted',
    proof: validated,
  }
}

function readTargetMetadata<T>(
  stateRoot: string,
  transferId: string | undefined,
  parse: (raw: string, expectedTransferId?: string) => T | undefined,
): T | undefined {
  const root = join(stateRoot, '.server-transfer')
  const candidates: Array<{ id: string; path: string; modified: number }> = []
  try {
    if (transferId !== undefined) {
      if (!UUID.test(transferId)) return undefined
      const path = join(root, transferId, 'state.json')
      try {
        candidates.push({ id: transferId, path, modified: statSync(path).mtimeMs })
      } catch {
        return undefined
      }
    } else {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !UUID.test(entry.name)) continue
        const path = join(root, entry.name, 'state.json')
        try {
          candidates.push({ id: entry.name, path, modified: statSync(path).mtimeMs })
        } catch {
          // An incomplete stage has no durable status.
        }
      }
    }
  } catch {
    return undefined
  }
  candidates.sort((left, right) => right.modified - left.modified)
  for (const candidate of candidates) {
    try {
      const value = parse(readFileSync(candidate.path, 'utf8'), candidate.id)
      if (value) return value
    } catch {
      // Corrupt or partially written target metadata is not trusted.
    }
  }
  return undefined
}

/** Strict serving proof; provisional target health is never promoted to fact. */
export function readPromotedTargetMetadata(
  stateRoot: string,
  transferId?: string,
): PromotedTargetMetadata | undefined {
  return readTargetMetadata(stateRoot, transferId, parsePromoted)
}

/** Exact target-owned marker for the health-only promotion boot window. */
export function readPromotingTargetMetadata(
  stateRoot: string,
  transferId?: string,
): PromotingTargetMetadata | undefined {
  return readTargetMetadata(stateRoot, transferId, parsePromoting)
}

/**
 * Boot reality comes from exactly one target stage: the newest durable stage.
 * It never skips a newer record to find an older state that happens to parse,
 * and exact promoted proof wins the parser choice for that record.
 */
export function readNewestTargetPromotionMetadata(
  stateRoot: string,
): PromotedTargetMetadata | PromotingTargetMetadata | undefined {
  const root = join(stateRoot, '.server-transfer')
  const candidates: Array<{ id: string; path: string; modified: number }> = []
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue
      const path = join(root, entry.name, 'state.json')
      try {
        candidates.push({ id: entry.name, path, modified: statSync(path).mtimeMs })
      } catch {
        // An incomplete newest stage is not replaceable with older evidence.
      }
    }
  } catch {
    return undefined
  }
  const newest = candidates.sort((left, right) => right.modified - left.modified)[0]
  if (!newest) return undefined
  try {
    const raw = readFileSync(newest.path, 'utf8')
    return parsePromoted(raw, newest.id) ?? parsePromoting(raw, newest.id)
  } catch {
    return undefined
  }
}
