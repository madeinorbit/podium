import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PromotedTargetMetadata, TargetHealthProof } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function string(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function proof(
  value: unknown,
  transferId: string,
  digest: string,
  targetMachineId: string,
  publicUrl: string,
): TargetHealthProof | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<TargetHealthProof>
  if (
    candidate.transferId !== transferId ||
    candidate.manifestDigest !== digest ||
    candidate.targetMachineId !== targetMachineId ||
    candidate.health !== 'serving' ||
    candidate.publicUrl !== publicUrl ||
    !string(candidate.feedId) ||
    !string(candidate.feedEpoch) ||
    !string(candidate.schemaVersion) ||
    !string(candidate.buildVersion)
  ) {
    return undefined
  }
  return candidate as TargetHealthProof
}

function parse(raw: string): PromotedTargetMetadata | undefined {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (
    candidate.state !== 'promoted' ||
    !string(candidate.transferId) ||
    !string(candidate.sourceMachineId) ||
    !string(candidate.targetMachineId) ||
    !string(candidate.publicUrl) ||
    !string(candidate.manifestDigest)
  ) {
    return undefined
  }
  const validated = proof(
    candidate.servingProof,
    candidate.transferId,
    candidate.manifestDigest,
    candidate.targetMachineId,
    candidate.publicUrl,
  )
  if (!validated) return undefined
  return {
    transferId: candidate.transferId,
    sourceMachineId: candidate.sourceMachineId,
    targetMachineId: candidate.targetMachineId,
    publicUrl: candidate.publicUrl,
    manifestDigest: candidate.manifestDigest,
    state: 'promoted',
    proof: validated,
  }
}

/**
 * Read target-owned promotion evidence after the portable package replaced the
 * source state. Unknown/old metadata is ignored rather than upgraded by guess.
 */
export function readPromotedTargetMetadata(stateRoot: string): PromotedTargetMetadata | undefined {
  const root = join(stateRoot, '.server-transfer')
  const candidates: Array<{ path: string; modified: number }> = []
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue
      const path = join(root, entry.name, 'state.json')
      try {
        candidates.push({ path, modified: statSync(path).mtimeMs })
      } catch {
        // An incomplete stage has no durable status.
      }
    }
  } catch {
    return undefined
  }
  candidates.sort((left, right) => right.modified - left.modified)
  for (const candidate of candidates) {
    try {
      const value = parse(readFileSync(candidate.path, 'utf8'))
      if (value) return value
    } catch {
      // Corrupt or partially written target metadata is not promotion proof.
    }
  }
  return undefined
}
