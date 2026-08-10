import { describe, expect, it } from 'vitest'
import {
  SERVER_TRANSFER_MAX_CHUNK_BYTES,
  ControlMessage,
  canonicalServerTransferManifest,
  DaemonMessage,
  ServerTransferChunkRequestMessage,
  ServerTransferErrorCode,
  ServerTransferResultMessage,
} from './index'
import { CONTROL_PLANE_CLASS, DAEMON_PLANE_CLASS } from './message-class'

const transferId = '00000000-0000-4000-8000-000000000001'
const manifestDigest = 'a'.repeat(64)
const manifest = {
  formatVersion: 1 as const,
  transferId,
  sourceInstanceId: 'source-instance',
  sourceMachineId: 'source-machine',
  targetMachineId: 'target-machine',
  sourceFeedId: 'feed-1',
  sourceFeedEpoch: 'epoch-1',
  appVersion: '2026.8.10',
  schemaVersion: 'schema-1',
  packageBytes: 3,
  files: [
    { path: 'transcripts/z.txt', size: 1, mode: 0o644, sha256: 'a'.repeat(64) },
    { path: 'podium.db', size: 2, mode: 0o600, sha256: 'b'.repeat(64) },
  ],
}

describe('server transfer protocol', () => {
  it('canonicalizes manifests by stable path order', () => {
    expect(canonicalServerTransferManifest(manifest)).toBe(
      canonicalServerTransferManifest({ ...manifest, files: [...manifest.files].reverse() }),
    )
    expect(canonicalServerTransferManifest(manifest)).toContain('podium.db')
  })

  it('binds every manifest identity and version field into the canonical digest input', () => {
    const variants = [
      { ...manifest, formatVersion: 2 },
      { ...manifest, transferId: '00000000-0000-4000-8000-000000000002' },
      { ...manifest, sourceInstanceId: 'other-instance' },
      { ...manifest, sourceMachineId: 'other-source' },
      { ...manifest, targetMachineId: 'other-target' },
      { ...manifest, sourceFeedId: 'other-feed' },
      { ...manifest, sourceFeedEpoch: 'other-epoch' },
      { ...manifest, appVersion: 'other-app' },
      { ...manifest, schemaVersion: 'other-schema' },
      { ...manifest, packageBytes: 4 },
      {
        ...manifest,
        files: manifest.files.map((entry, index) =>
          index === 0 ? { ...entry, sha256: 'c'.repeat(64) } : entry,
        ),
      },
    ]
    const canonical = canonicalServerTransferManifest(manifest)
    expect(
      variants.every((variant) => canonicalServerTransferManifest(variant as never) !== canonical),
    ).toBe(true)
  })

  it('registers every transfer operation on the authenticated command planes', () => {
    const common = { requestId: 'request-1', transferId, manifestDigest }
    const requests = [
      {
        type: 'serverTransferPrepareRequest',
        ...common,
        manifest: { ...manifest, packageBytes: 3 },
      },
      {
        type: 'serverTransferChunkRequest',
        ...common,
        path: 'podium.db',
        offset: 0,
        data: 'eA==',
        expectedLength: 1,
      },
      { type: 'serverTransferValidateRequest', ...common },
      {
        type: 'serverTransferPromoteRequest',
        ...common,
        publicUrl: 'https://podium.example.com',
        targetMode: 'server',
        idempotencyKey: 'promote-once',
      },
      { type: 'serverTransferAbortRequest', ...common, reason: 'cleanup' },
      { type: 'serverTransferStatusRequest', ...common },
    ]

    for (const request of requests) {
      expect(ControlMessage.safeParse(request).success, request.type).toBe(true)
      expect(CONTROL_PLANE_CLASS[request.type as keyof typeof CONTROL_PLANE_CLASS]).toBe(
        'control.command',
      )
    }
    expect(requests.map((request) => request.type)).toEqual([
      'serverTransferPrepareRequest',
      'serverTransferChunkRequest',
      'serverTransferValidateRequest',
      'serverTransferPromoteRequest',
      'serverTransferAbortRequest',
      'serverTransferStatusRequest',
    ])
    expect(DAEMON_PLANE_CLASS.serverTransferResult).toBe('control.command')
  })

  it('pins strong promoted proof and stable recovery metadata on the single result family', () => {
    const result = {
      type: 'serverTransferResult',
      requestId: 'request-1',
      transferId,
      operation: 'status',
      ok: true,
      state: 'promoted',
      manifestDigest,
      sourceMachineId: 'source-machine',
      publicUrl: 'https://podium.example.com',
      idempotent: true,
      targetCapability: 'server-only',
      buildVersion: '2026.8.10',
      wireSchemaDigest: 'wire-v1',
      space: { availableBytes: 20, requiredBytes: 10, sufficient: true },
      proof: {
        transferId,
        manifestDigest,
        targetMachineId: 'target-machine',
        feedId: 'feed-1',
        feedEpoch: 'epoch-1',
        schemaVersion: 'schema-1',
        buildVersion: '2026.8.10',
      },
      servingProof: {
        transferId,
        manifestDigest,
        targetMachineId: 'target-machine',
        feedId: 'feed-1',
        feedEpoch: 'epoch-1',
        schemaVersion: 'schema-1',
        buildVersion: '2026.8.10',
        publicUrl: 'https://podium.example.com',
        health: 'serving',
      },
    } as const

    expect(DaemonMessage.safeParse(result).success).toBe(true)
    expect(ServerTransferResultMessage.parse(result)).toEqual(result)
  })

  it('bounds decoded chunks and keeps error codes machine-readable', () => {
    const data = 'A'.repeat(Math.ceil(SERVER_TRANSFER_MAX_CHUNK_BYTES / 3) * 4)
    const valid = {
      type: 'serverTransferChunkRequest',
      requestId: 'chunk-max',
      transferId,
      manifestDigest,
      path: 'podium.db',
      offset: 0,
      data,
      expectedLength: SERVER_TRANSFER_MAX_CHUNK_BYTES,
    } as const
    expect(ServerTransferChunkRequestMessage.safeParse(valid).success).toBe(true)
    expect(
      ServerTransferChunkRequestMessage.safeParse({
        ...valid,
        expectedLength: SERVER_TRANSFER_MAX_CHUNK_BYTES + 1,
      }).success,
    ).toBe(false)
    expect(
      ServerTransferChunkRequestMessage.safeParse({
        ...valid,
        data: `${data}AAAA`,
      }).success,
    ).toBe(false)
    expect(ServerTransferErrorCode.safeParse('uncertain-commit').success).toBe(true)
    expect(ServerTransferErrorCode.safeParse('free-form failure').success).toBe(false)
  })
})
