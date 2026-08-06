import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DaemonMessage, ServerTransferManifestEntry } from '@podium/protocol'
import { canonicalServerTransferManifest } from '@podium/protocol'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonContext } from './control/context'

let stateRoot = ''
let previousStateDir: string | undefined
let handlers: typeof import('./server-transfer').serverTransferHandlers

const digest = (entries: ServerTransferManifestEntry[]): string =>
  createHash('sha256').update(canonicalServerTransferManifest(entries)).digest('hex')

const fileEntry = async (path: string, content: string): Promise<ServerTransferManifestEntry> => ({
  path,
  size: Buffer.byteLength(content),
  mode: 0o644,
  sha256: createHash('sha256').update(content).digest('hex'),
})

async function invoke(
  type:
    | 'serverTransferPrepareRequest'
    | 'serverTransferChunkRequest'
    | 'serverTransferValidateRequest'
    | 'serverTransferPromoteRequest'
    | 'serverTransferAbortRequest',
  message: Record<string, unknown>,
  restartAfterTransfer?: () => Promise<void>,
): Promise<Extract<DaemonMessage, { type: 'serverTransferResult' }>> {
  return new Promise((resolve) => {
    const ctx = {
      send: (response: DaemonMessage) => {
        if (response.type === 'serverTransferResult') resolve(response)
      },
      ...(restartAfterTransfer ? { restartAfterTransfer } : {}),
    } as unknown as DaemonContext
    handlers[type](ctx, message as never)
  })
}

describe('server transfer target daemon', () => {
  beforeAll(async () => {
    previousStateDir = process.env.PODIUM_STATE_DIR
    stateRoot = await mkdtemp(join(tmpdir(), 'podium-daemon-transfer-'))
    process.env.PODIUM_STATE_DIR = stateRoot
    ;({ serverTransferHandlers: handlers } = await import('./server-transfer'))
  })

  beforeEach(async () => {
    await rm(join(stateRoot, '.server-transfer'), { recursive: true, force: true })
    await rm(join(stateRoot, 'config.json'), { force: true })
    await rm(join(stateRoot, 'podium.db'), { force: true })
    await rm(join(stateRoot, 'transcripts'), { recursive: true, force: true })
  })

  afterAll(async () => {
    if (previousStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = previousStateDir
    await rm(stateRoot, { recursive: true, force: true })
  })

  it('rejects unsafe paths before creating a stage', async () => {
    const transferId = randomUUID()
    const manifest = [{ path: '../config.json', size: 1, mode: 0o644, sha256: '0'.repeat(64) }]
    const response = await invoke('serverTransferPrepareRequest', {
      type: 'serverTransferPrepareRequest',
      requestId: 'prepare-unsafe',
      transferId,
      manifest,
      manifestDigest: digest(manifest),
      totalBytes: 1,
    })

    expect(response.ok).toBe(false)
    expect(
      await stat(join(stateRoot, '.server-transfer', transferId)).catch(() => undefined),
    ).toBeUndefined()
  })

  it('stages chunks contiguously, accepts an exact retry, validates hashes, and promotes', async () => {
    const transferId = randomUUID()
    const db = 'new-db'
    const transcript = 'new-transcript'
    const manifest = [
      await fileEntry('podium.db', db),
      await fileEntry('transcripts/session.txt', transcript),
    ]
    const manifestDigest = digest(manifest)
    const totalBytes = db.length + transcript.length
    const prepare = await invoke('serverTransferPrepareRequest', {
      type: 'serverTransferPrepareRequest',
      requestId: 'prepare',
      transferId,
      manifest,
      manifestDigest,
      totalBytes,
    })
    expect(prepare).toMatchObject({ ok: true, state: 'staging' })

    const first = Buffer.from(db).toString('base64')
    const chunk = await invoke('serverTransferChunkRequest', {
      type: 'serverTransferChunkRequest',
      requestId: 'chunk-1',
      transferId,
      path: 'podium.db',
      offset: 0,
      data: first,
    })
    expect(chunk).toMatchObject({ ok: true, state: 'staging', receivedBytes: db.length })
    const retry = await invoke('serverTransferChunkRequest', {
      type: 'serverTransferChunkRequest',
      requestId: 'chunk-1-retry',
      transferId,
      path: 'podium.db',
      offset: 0,
      data: first,
    })
    expect(retry.ok).toBe(true)

    const transcriptChunk = await invoke('serverTransferChunkRequest', {
      type: 'serverTransferChunkRequest',
      requestId: 'chunk-2',
      transferId,
      path: 'transcripts/session.txt',
      offset: 0,
      data: Buffer.from(transcript).toString('base64'),
    })
    expect(transcriptChunk.ok).toBe(true)

    const validate = await invoke('serverTransferValidateRequest', {
      type: 'serverTransferValidateRequest',
      requestId: 'validate',
      transferId,
      manifestDigest,
    })
    expect(validate).toMatchObject({ ok: true, state: 'validated' })

    let readinessObserved = false
    const promote = await invoke(
      'serverTransferPromoteRequest',
      {
        type: 'serverTransferPromoteRequest',
        requestId: 'promote',
        transferId,
        manifestDigest,
        publicUrl: 'https://podium.example.com',
      },
      async () => {
        readinessObserved = true
      },
    )
    expect(readinessObserved).toBe(true)
    expect(promote).toMatchObject({ ok: true, state: 'promoted' })
    expect(await readFile(join(stateRoot, 'podium.db'), 'utf8')).toBe(db)
    expect(await readFile(join(stateRoot, 'transcripts', 'session.txt'), 'utf8')).toBe(transcript)
    expect(JSON.parse(await readFile(join(stateRoot, 'config.json'), 'utf8')).mode).toBe('server')
  })

  it('refuses non-contiguous chunks and abort removes the private stage', async () => {
    const transferId = randomUUID()
    const content = 'db'
    const manifest = [await fileEntry('podium.db', content)]
    const manifestDigest = digest(manifest)
    await invoke('serverTransferPrepareRequest', {
      type: 'serverTransferPrepareRequest',
      requestId: 'prepare',
      transferId,
      manifest,
      manifestDigest,
      totalBytes: content.length,
    })
    const bad = await invoke('serverTransferChunkRequest', {
      type: 'serverTransferChunkRequest',
      requestId: 'chunk-bad',
      transferId,
      path: 'podium.db',
      offset: 1,
      data: Buffer.from(content).toString('base64'),
    })
    expect(bad.ok).toBe(false)

    const otherId = randomUUID()
    const otherManifest = [await fileEntry('podium.db', 'other')]
    const otherPrepare = await invoke('serverTransferPrepareRequest', {
      type: 'serverTransferPrepareRequest',
      requestId: 'prepare-other',
      transferId: otherId,
      manifest: otherManifest,
      manifestDigest: digest(otherManifest),
      totalBytes: 5,
    })
    expect(otherPrepare.ok).toBe(true)
    await invoke('serverTransferAbortRequest', {
      type: 'serverTransferAbortRequest',
      requestId: 'abort-other',
      transferId: otherId,
      reason: 'test cleanup',
    })

    const abort = await invoke('serverTransferAbortRequest', {
      type: 'serverTransferAbortRequest',
      requestId: 'abort',
      transferId,
      reason: 'test cleanup',
    })
    expect(abort).toMatchObject({ ok: true, state: 'aborted' })
    expect(
      await stat(join(stateRoot, '.server-transfer', transferId)).catch(() => undefined),
    ).toBeUndefined()
  })
})
