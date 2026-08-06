import { describe, expect, it } from 'vitest'
import {
  ControlMessage,
  canonicalServerTransferManifest,
  DaemonMessage,
  ServerTransferResultMessage,
} from './index'

const transferId = '00000000-0000-4000-8000-000000000001'
const emptyDigest = 'a'.repeat(64)

describe('server transfer protocol', () => {
  it('canonicalizes manifests by stable path order', () => {
    const entries = [
      { path: 'transcripts/z.txt', size: 1, mode: 0o644, sha256: 'a'.repeat(64) },
      { path: 'podium.db', size: 2, mode: 0o600, sha256: 'b'.repeat(64) },
    ]
    expect(canonicalServerTransferManifest(entries)).toBe(
      canonicalServerTransferManifest([...entries].reverse()),
    )
    expect(canonicalServerTransferManifest(entries)).toContain('podium.db')
  })

  it('registers transfer requests and results on their authenticated planes', () => {
    const prepare = {
      type: 'serverTransferPrepareRequest',
      requestId: 'request-1',
      transferId,
      manifest: [],
      manifestDigest: emptyDigest,
      totalBytes: 0,
    } as const
    const result = {
      type: 'serverTransferResult',
      requestId: 'request-1',
      transferId,
      operation: 'promote',
      ok: true,
      state: 'promoted',
      manifestDigest: emptyDigest,
    } as const

    expect(ControlMessage.safeParse(prepare).success).toBe(true)
    expect(DaemonMessage.safeParse(result).success).toBe(true)
    expect(ServerTransferResultMessage.safeParse(result).success).toBe(true)
  })
})
