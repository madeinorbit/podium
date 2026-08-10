import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  statfs,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  DaemonMessage,
  ServerTransferManifest,
  ServerTransferManifestEntry,
  ServerTransferServingProof,
} from '@podium/protocol'
import { canonicalServerTransferManifest } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './control/context'

const targetMachineId = 'target-machine'
let stateRoot = ''
let previousStateDir: string | undefined
let handlers: typeof import('./server-transfer').serverTransferHandlers
let writeFully: typeof import('./server-transfer').writeFully

const transferManifest = (
  transferId: string,
  files: ServerTransferManifestEntry[],
): ServerTransferManifest => ({
  formatVersion: 1,
  transferId,
  sourceInstanceId: 'source-instance',
  sourceMachineId: 'source-machine',
  targetMachineId,
  sourceFeedId: 'feed-1',
  sourceFeedEpoch: 'epoch-1',
  appVersion: 'test',
  schemaVersion: 'schema-1',
  packageBytes: files.reduce((sum, entry) => sum + entry.size, 0),
  files,
})

const digest = (manifest: ServerTransferManifest): string =>
  createHash('sha256').update(canonicalServerTransferManifest(manifest)).digest('hex')

const fileEntry = (path: string, content: Buffer | string): ServerTransferManifestEntry => ({
  path,
  size: Buffer.byteLength(content),
  mode: 0o644,
  sha256: createHash('sha256').update(content).digest('hex'),
})

async function candidateFiles(machineId = targetMachineId): Promise<Record<string, Buffer>> {
  const path = join(stateRoot, `candidate-${randomUUID()}.db`)
  const db = openDatabase(path)
  try {
    db.exec(`
      CREATE TABLE machines (id TEXT PRIMARY KEY);
      CREATE TABLE feed_identity (
        singleton INTEGER PRIMARY KEY,
        feed_id TEXT NOT NULL,
        epoch TEXT NOT NULL
      );
      CREATE TABLE __drizzle_migrations (name TEXT NOT NULL);
    `)
    db.prepare('INSERT INTO machines (id) VALUES (?)').run(machineId)
    db.prepare('INSERT INTO feed_identity (singleton, feed_id, epoch) VALUES (1, ?, ?)').run(
      'feed-1',
      'epoch-1',
    )
    db.prepare('INSERT INTO __drizzle_migrations (name) VALUES (?)').run('schema-1')
  } finally {
    db.close()
  }
  const podiumDb = await readFile(path)
  await rm(path, { force: true })
  const enrollmentLedger = Buffer.from(
    `${JSON.stringify({ v: 1, kind: 'header', pairingRoot: 'a'.repeat(64), createdAt: 'now' })}\n${JSON.stringify({ v: 1, kind: 'enroll', id: 'enroll-1', machineId, serial: 1, ownerUserId: 'owner-1', at: 'now' })}\n`,
  )
  return { 'enrollment.ledger': enrollmentLedger, 'podium.db': podiumDb }
}

async function invoke(
  type:
    | 'serverTransferPrepareRequest'
    | 'serverTransferChunkRequest'
    | 'serverTransferValidateRequest'
    | 'serverTransferPromoteRequest'
    | 'serverTransferAbortRequest'
    | 'serverTransferStatusRequest'
    | 'serverTransferAcknowledgeRequest',
  message: Record<string, unknown>,
  restartAfterTransfer?: (
    expected: ServerTransferServingProof,
  ) => Promise<ServerTransferServingProof>,
  serverTransferCrashPoint?: DaemonContext['serverTransferCrashPoint'],
  retireAfterTransfer?: DaemonContext['retireAfterTransfer'],
): Promise<Extract<DaemonMessage, { type: 'serverTransferResult' }>> {
  return new Promise((resolve) => {
    const ctx = {
      machineId: targetMachineId,
      send: (response: DaemonMessage) => {
        if (response.type === 'serverTransferResult') resolve(response)
      },
      ...(restartAfterTransfer ? { restartAfterTransfer } : {}),
      ...(serverTransferCrashPoint ? { serverTransferCrashPoint } : {}),
      ...(retireAfterTransfer ? { retireAfterTransfer } : {}),
    } as unknown as DaemonContext
    handlers[type](ctx, message as never)
  })
}

async function prepareAndValidateCandidate(): Promise<{
  transferId: string
  files: Record<string, Buffer>
  manifestDigest: string
  promoteInput: Record<string, unknown>
}> {
  const transferId = randomUUID()
  const files: Record<string, Buffer> = {
    ...(await candidateFiles()),
    'transcripts/session.txt': Buffer.from('incoming-transcript'),
  }
  const entries = Object.entries(files)
    .map(([path, content]) => fileEntry(path, content))
    .sort((a, b) => a.path.localeCompare(b.path))
  const manifest = transferManifest(transferId, entries)
  const manifestDigest = digest(manifest)
  expect(
    await invoke('serverTransferPrepareRequest', {
      type: 'serverTransferPrepareRequest',
      requestId: `prepare-${transferId}`,
      transferId,
      manifest,
      manifestDigest,
    }),
  ).toMatchObject({ ok: true, state: 'staging' })
  for (const [path, content] of Object.entries(files))
    expect(
      await invoke('serverTransferChunkRequest', {
        type: 'serverTransferChunkRequest',
        requestId: `chunk-${transferId}-${path}`,
        transferId,
        manifestDigest,
        path,
        offset: 0,
        data: content.toString('base64'),
        expectedLength: content.length,
      }),
    ).toMatchObject({ ok: true })
  expect(
    await invoke('serverTransferValidateRequest', {
      type: 'serverTransferValidateRequest',
      requestId: `validate-${transferId}`,
      transferId,
      manifestDigest,
    }),
  ).toMatchObject({ ok: true, state: 'validated' })
  return {
    transferId,
    files,
    manifestDigest,
    promoteInput: {
      type: 'serverTransferPromoteRequest',
      requestId: `promote-${transferId}`,
      transferId,
      manifestDigest,
      publicUrl: 'https://podium.example.com',
      targetMode: 'server',
      idempotencyKey: `promote-${transferId}`,
    },
  }
}

describe('server transfer target daemon', () => {
  beforeAll(async () => {
    previousStateDir = process.env.PODIUM_STATE_DIR
    stateRoot = await mkdtemp(join(tmpdir(), 'podium-daemon-transfer-'))
    process.env.PODIUM_STATE_DIR = stateRoot
    const module = await import('./server-transfer')
    ;({ serverTransferHandlers: handlers, writeFully } = module)
  })

  beforeEach(async () => {
    await rm(join(stateRoot, '.server-transfer'), { recursive: true, force: true })
    await rm(join(stateRoot, 'config.json'), { force: true })
    await rm(join(stateRoot, 'podium.db'), { force: true })
    await rm(join(stateRoot, 'enrollment.ledger'), { force: true })
    await rm(join(stateRoot, 'machine.id'), { force: true })
    await rm(join(stateRoot, 'daemon.secret'), { force: true })
    await rm(join(stateRoot, 'transcripts'), { recursive: true, force: true })
    await rm(join(stateRoot, 'outside'), { recursive: true, force: true })
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
      manifest: transferManifest(transferId, manifest),
      manifestDigest: digest(transferManifest(transferId, manifest)),
    })

    expect(response).toMatchObject({ ok: false, errorCode: 'unsafe-path' })
    expect(
      await stat(join(stateRoot, '.server-transfer', transferId)).catch(() => undefined),
    ).toBeUndefined()
  })

  it('durably validates, proves, promotes, and recovers idempotently without replacing target identity', async () => {
    const transferId = randomUUID()
    const files: Record<string, Buffer> = {
      ...(await candidateFiles()),
      'transcripts/session.txt': Buffer.from('new-transcript'),
      'transcripts/session.txt.part': Buffer.from('legitimate-part-file'),
    }
    const manifest = Object.entries(files)
      .map(([path, content]) => fileEntry(path, content))
      .sort((a, b) => a.path.localeCompare(b.path))
    const manifestDigest = digest(transferManifest(transferId, manifest))
    const prepare = await invoke('serverTransferPrepareRequest', {
      type: 'serverTransferPrepareRequest',
      requestId: 'prepare',
      transferId,
      manifest: transferManifest(transferId, manifest),
      manifestDigest,
    })
    expect(prepare).toMatchObject({
      ok: true,
      state: 'staging',
      targetCapability: 'server-only',
      buildVersion: expect.any(String),
      wireSchemaDigest: expect.any(String),
      space: { sufficient: true },
    })

    for (const [path, content] of Object.entries(files)) {
      const response = await invoke('serverTransferChunkRequest', {
        type: 'serverTransferChunkRequest',
        requestId: `chunk-${path}`,
        transferId,
        manifestDigest,
        path,
        offset: 0,
        data: content.toString('base64'),
        expectedLength: content.length,
      })
      expect(response).toMatchObject({
        ok: true,
        state: 'staging',
        receivedBytes: content.length,
      })
    }

    const dbData = files['podium.db']!
    const retry = await invoke('serverTransferChunkRequest', {
      type: 'serverTransferChunkRequest',
      requestId: 'chunk-db-retry',
      transferId,
      manifestDigest,
      path: 'podium.db',
      offset: 0,
      data: dbData.toString('base64'),
      expectedLength: dbData.length,
    })
    expect(retry).toMatchObject({ ok: true, idempotent: true })
    expect(
      await stat(join(stateRoot, '.server-transfer', transferId, 'parts', 'podium.db')),
    ).toBeDefined()
    expect(
      await stat(join(stateRoot, '.server-transfer', transferId, 'files', 'podium.db')).catch(
        () => undefined,
      ),
    ).toBeUndefined()

    const validate = await invoke('serverTransferValidateRequest', {
      type: 'serverTransferValidateRequest',
      requestId: 'validate',
      transferId,
      manifestDigest,
    })
    expect(validate).toMatchObject({
      ok: true,
      state: 'validated',
      proof: {
        transferId,
        manifestDigest,
        targetMachineId,
        feedId: 'feed-1',
        feedEpoch: 'epoch-1',
        schemaVersion: 'schema-1',
      },
    })
    expect(
      await stat(join(stateRoot, '.server-transfer', transferId, 'files', 'podium.db')),
    ).toBeDefined()
    expect(
      await stat(join(stateRoot, '.server-transfer', transferId, 'parts', 'podium.db')).catch(
        () => undefined,
      ),
    ).toBeUndefined()

    await writeFile(join(stateRoot, 'machine.id'), 'target-machine-id')
    await writeFile(join(stateRoot, 'daemon.secret'), 'target-daemon-secret')
    let readinessObserved = false
    const promoteInput = {
      type: 'serverTransferPromoteRequest',
      requestId: 'promote',
      transferId,
      manifestDigest,
      publicUrl: 'https://podium.example.com',
      targetMode: 'server',
      idempotencyKey: 'promote-once',
    }
    const promote = await invoke('serverTransferPromoteRequest', promoteInput, async (expected) => {
      readinessObserved = true
      return expected
    })
    expect(readinessObserved).toBe(true)
    expect(promote).toMatchObject({
      ok: true,
      state: 'promoted',
      idempotent: false,
      servingProof: {
        transferId,
        manifestDigest,
        targetMachineId,
        publicUrl: 'https://podium.example.com',
        health: 'serving',
      },
    })

    const retryPromote = await invoke('serverTransferPromoteRequest', {
      ...promoteInput,
      requestId: 'promote-retry',
    })
    expect(retryPromote).toMatchObject({ ok: true, state: 'promoted', idempotent: true })

    const status = await invoke('serverTransferStatusRequest', {
      type: 'serverTransferStatusRequest',
      requestId: 'status',
      transferId,
      manifestDigest,
    })
    expect(status).toMatchObject({
      ok: true,
      state: 'promoted',
      publicUrl: 'https://podium.example.com',
      proof: { transferId, manifestDigest, targetMachineId },
      servingProof: {
        transferId,
        manifestDigest,
        targetMachineId,
        publicUrl: 'https://podium.example.com',
        health: 'serving',
      },
    })
    expect(await readFile(join(stateRoot, 'podium.db'))).toEqual(files['podium.db'])
    expect(await readFile(join(stateRoot, 'transcripts', 'session.txt'), 'utf8')).toBe(
      'new-transcript',
    )
    expect(await readFile(join(stateRoot, 'transcripts', 'session.txt.part'), 'utf8')).toBe(
      'legitimate-part-file',
    )
    expect(await readFile(join(stateRoot, 'machine.id'), 'utf8')).toBe('target-machine-id')
    expect(await readFile(join(stateRoot, 'daemon.secret'), 'utf8')).toBe('target-daemon-secret')
    expect(JSON.parse(await readFile(join(stateRoot, 'config.json'), 'utf8')).mode).toBe('server')
    expect(
      JSON.parse(
        await readFile(join(stateRoot, '.server-transfer', transferId, 'state.json'), 'utf8'),
      ),
    ).toMatchObject({
      transferId,
      targetMachineId,
      manifestDigest,
      publicUrl: 'https://podium.example.com',
      state: 'promoted',
      proof: { transferId, manifestDigest, targetMachineId },
      servingProof: {
        transferId,
        manifestDigest,
        targetMachineId,
        publicUrl: 'https://podium.example.com',
        health: 'serving',
      },
    })
  })

  it('uses stable offset errors and digest-owned idempotent abort cleanup', async () => {
    const transferId = randomUUID()
    const content = Buffer.from('db')
    const manifest = [fileEntry('podium.db', content)]
    const manifestDigest = digest(transferManifest(transferId, manifest))
    await invoke('serverTransferPrepareRequest', {
      type: 'serverTransferPrepareRequest',
      requestId: 'prepare',
      transferId,
      manifest: transferManifest(transferId, manifest),
      manifestDigest,
    })
    const bad = await invoke('serverTransferChunkRequest', {
      type: 'serverTransferChunkRequest',
      requestId: 'chunk-bad',
      transferId,
      manifestDigest,
      path: 'podium.db',
      offset: 1,
      data: content.toString('base64'),
      expectedLength: content.length,
    })
    expect(bad).toMatchObject({ ok: false, errorCode: 'offset-gap' })

    const conflictingAbort = await invoke('serverTransferAbortRequest', {
      type: 'serverTransferAbortRequest',
      requestId: 'abort-conflict',
      transferId,
      manifestDigest: 'f'.repeat(64),
      reason: 'must not delete another digest',
    })
    expect(conflictingAbort).toMatchObject({ ok: false, errorCode: 'conflicting-digest' })
    expect(await stat(join(stateRoot, '.server-transfer', transferId))).toBeDefined()

    const otherId = randomUUID()
    const otherManifest = [fileEntry('podium.db', 'other')]
    const otherDigest = digest(transferManifest(otherId, otherManifest))
    const otherPrepare = await invoke('serverTransferPrepareRequest', {
      type: 'serverTransferPrepareRequest',
      requestId: 'prepare-other',
      transferId: otherId,
      manifest: transferManifest(otherId, otherManifest),
      manifestDigest: otherDigest,
    })
    expect(otherPrepare.ok).toBe(true)
    await invoke('serverTransferAbortRequest', {
      type: 'serverTransferAbortRequest',
      requestId: 'abort-other',
      transferId: otherId,
      manifestDigest: otherDigest,
      reason: 'probe cleanup',
    })

    const abort = await invoke('serverTransferAbortRequest', {
      type: 'serverTransferAbortRequest',
      requestId: 'abort',
      transferId,
      manifestDigest,
      reason: 'test cleanup',
    })
    expect(abort).toMatchObject({ ok: true, state: 'aborted', cleaned: true, idempotent: false })
    const retry = await invoke('serverTransferAbortRequest', {
      type: 'serverTransferAbortRequest',
      requestId: 'abort-retry',
      transferId,
      manifestDigest,
      reason: 'retry cleanup',
    })
    expect(retry).toMatchObject({ ok: true, state: 'aborted', cleaned: true, idempotent: true })
    expect(
      await stat(join(stateRoot, '.server-transfer', transferId)).catch(() => undefined),
    ).toBeUndefined()
  })
  it('loops through partial writes and refuses a zero-byte short write', async () => {
    const partial = {
      write: vi.fn(async (_data: Buffer, _offset: number, length: number, _position: number) => ({
        bytesWritten: Math.min(2, length),
        buffer: Buffer.alloc(0),
      })),
    }
    await writeFully(partial as never, Buffer.alloc(5), 7)
    expect(partial.write.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
      [0, 5, 7],
      [2, 3, 9],
      [4, 1, 11],
    ])

    const stalled = {
      write: vi.fn(async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) })),
    }
    await expect(writeFully(stalled as never, Buffer.from('x'), 0)).rejects.toMatchObject({
      code: 'internal',
    })
  })

  it('refuses a symlinked target parent before staging any bytes outside the state root', async () => {
    const outside = join(stateRoot, 'outside')
    await mkdir(outside)
    await symlink(outside, join(stateRoot, 'transcripts'), 'dir')
    const transferId = randomUUID()
    const content = Buffer.from('must-stay-private')
    const manifest = [fileEntry('transcripts/session.txt', content)]
    const response = await invoke('serverTransferPrepareRequest', {
      type: 'serverTransferPrepareRequest',
      requestId: 'prepare-symlink-parent',
      transferId,
      manifest: transferManifest(transferId, manifest),
      manifestDigest: digest(transferManifest(transferId, manifest)),
    })

    expect(response).toMatchObject({ ok: false, errorCode: 'unsafe-path' })
    expect(await stat(join(outside, 'session.txt')).catch(() => undefined)).toBeUndefined()
    expect(
      await stat(join(stateRoot, '.server-transfer', transferId)).catch(() => undefined),
    ).toBeUndefined()
  })

  it('refuses insufficient backup capacity before creating a stage', async () => {
    await writeFile(join(stateRoot, 'podium.db'), '')
    const space = await statfs(stateRoot)
    const availableBytes = space.bavail * space.bsize
    await truncate(join(stateRoot, 'podium.db'), Math.floor(availableBytes / 1.1) + 1)
    const transferId = randomUUID()
    const content = Buffer.from('x')
    const manifest = [fileEntry('podium.db', content)]
    const response = await invoke('serverTransferPrepareRequest', {
      type: 'serverTransferPrepareRequest',
      requestId: 'prepare-capacity',
      transferId,
      manifest: transferManifest(transferId, manifest),
      manifestDigest: digest(transferManifest(transferId, manifest)),
    })

    expect(response).toMatchObject({ ok: false, errorCode: 'capacity-exceeded' })
    expect(
      await stat(join(stateRoot, '.server-transfer', transferId)).catch(() => undefined),
    ).toBeUndefined()
  })

  it('rejects a staged candidate whose SQLite schema cannot produce proof', async () => {
    const valid = await candidateFiles()
    const files: Record<string, Buffer> = {
      'enrollment.ledger': valid['enrollment.ledger']!,
      'podium.db': Buffer.from('not-a-sqlite-database'),
    }
    const manifest = Object.entries(files)
      .map(([path, content]) => fileEntry(path, content))
      .sort((a, b) => a.path.localeCompare(b.path))
    const transferId = randomUUID()
    const manifestDigest = digest(transferManifest(transferId, manifest))
    await invoke('serverTransferPrepareRequest', {
      type: 'serverTransferPrepareRequest',
      requestId: 'prepare-invalid-candidate',
      transferId,
      manifest: transferManifest(transferId, manifest),
      manifestDigest,
    })
    for (const [path, content] of Object.entries(files)) {
      const chunk = await invoke('serverTransferChunkRequest', {
        type: 'serverTransferChunkRequest',
        requestId: `chunk-invalid-${path}`,
        transferId,
        manifestDigest,
        path,
        offset: 0,
        data: content.toString('base64'),
        expectedLength: content.length,
      })
      expect(chunk.ok).toBe(true)
    }

    const validate = await invoke('serverTransferValidateRequest', {
      type: 'serverTransferValidateRequest',
      requestId: 'validate-invalid-candidate',
      transferId,
      manifestDigest,
    })
    expect(validate).toMatchObject({ ok: false, errorCode: 'candidate-invalid' })

    const conflictingStatus = await invoke('serverTransferStatusRequest', {
      type: 'serverTransferStatusRequest',
      requestId: 'status-conflicting-digest',
      transferId,
      manifestDigest: 'f'.repeat(64),
    })
    expect(conflictingStatus).toMatchObject({ ok: false, errorCode: 'conflicting-digest' })
  })
  for (const point of [
    'before-backup',
    'after-backup',
    'after-install-before-config',
    'after-health-before-proof',
  ] as const) {
    it(`recovers idempotently after a simulated process crash at ${point}`, async () => {
      const { transferId, files, manifestDigest, promoteInput } =
        await prepareAndValidateCandidate()
      await writeFile(join(stateRoot, 'podium.db'), 'original-target-db')
      await writeFile(join(stateRoot, 'enrollment.ledger'), 'original-target-ledger')
      await mkdir(join(stateRoot, 'transcripts'), { recursive: true })
      await writeFile(join(stateRoot, 'transcripts', 'session.txt'), 'original-transcript')
      await writeFile(
        join(stateRoot, 'config.json'),
        JSON.stringify({ mode: 'daemon', serverUrl: 'wss://old.example.com' }),
      )

      let healthCallbacks = 0
      let crashed = false
      const first = await invoke(
        'serverTransferPromoteRequest',
        promoteInput,
        async (expected) => {
          healthCallbacks += 1
          return expected
        },
        (observed) => {
          if (!crashed && observed === point) {
            crashed = true
            throw new Error(`simulated crash at ${point}`)
          }
        },
      )
      const crashAfterMutation =
        point === 'after-install-before-config' || point === 'after-health-before-proof'
      expect(first).toMatchObject({
        ok: false,
        state: crashAfterMutation ? 'promoting' : 'validated',
      })

      const journalPath = join(stateRoot, '.server-transfer', transferId, 'state.json')
      const crashedJournal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<
        string,
        unknown
      >
      expect(crashedJournal).toMatchObject({
        state: crashAfterMutation ? 'promoting' : 'validated',
        servingProof: undefined,
        promotionPlan: expect.arrayContaining([
          expect.objectContaining({
            path: 'podium.db',
            kind: 'portable',
            hadOriginal: true,
          }),
          expect.objectContaining({
            path: 'config.json',
            kind: 'config',
            hadOriginal: true,
          }),
        ]),
      })

      const backupDb = join(
        stateRoot,
        '.server-transfer',
        transferId,
        'backup',
        'originals',
        'portable',
        'podium.db',
      )
      const backupConfig = join(
        stateRoot,
        '.server-transfer',
        transferId,
        'backup',
        'originals',
        'config.json',
      )
      if (point === 'before-backup') {
        expect(await stat(backupDb).catch(() => undefined)).toBeUndefined()
      } else {
        expect(await readFile(backupDb, 'utf8')).toBe('original-target-db')
        expect(JSON.parse(await readFile(backupConfig, 'utf8'))).toMatchObject({
          mode: 'daemon',
          serverUrl: 'wss://old.example.com',
        })
      }

      const status = await invoke('serverTransferStatusRequest', {
        type: 'serverTransferStatusRequest',
        requestId: `status-crashed-${point}`,
        transferId,
        manifestDigest,
      })
      expect(status).toMatchObject({
        ok: !crashAfterMutation,
        state: crashAfterMutation ? 'promoting' : 'validated',
        ...(crashAfterMutation ? { errorCode: 'uncertain-commit' } : {}),
      })

      const retry = await invoke(
        'serverTransferPromoteRequest',
        { ...promoteInput, requestId: `retry-${point}` },
        async (expected) => {
          healthCallbacks += 1
          return expected
        },
      )
      expect(retry).toMatchObject({
        ok: true,
        state: 'promoted',
        servingProof: {
          transferId,
          manifestDigest,
          targetMachineId,
          publicUrl: 'https://podium.example.com',
          health: 'serving',
        },
      })
      expect(await readFile(join(stateRoot, 'podium.db'))).toEqual(files['podium.db'])
      expect(await readFile(backupDb, 'utf8')).toBe('original-target-db')
      expect(JSON.parse(await readFile(backupConfig, 'utf8'))).toMatchObject({
        mode: 'daemon',
        serverUrl: 'wss://old.example.com',
      })
      expect(healthCallbacks).toBe(point === 'after-health-before-proof' ? 2 : 1)
    })
  }

  it('never persists serving proof when the health callback does not echo the bound proof', async () => {
    const { transferId, manifestDigest, promoteInput } = await prepareAndValidateCandidate()
    const response = await invoke(
      'serverTransferPromoteRequest',
      promoteInput,
      async (expected) => ({ ...expected, publicUrl: 'https://wrong.example.com' }),
    )
    expect(response).toMatchObject({
      ok: false,
      state: 'uncertain',
      errorCode: 'uncertain-commit',
    })
    const journal = JSON.parse(
      await readFile(join(stateRoot, '.server-transfer', transferId, 'state.json'), 'utf8'),
    )
    expect(journal).toMatchObject({
      state: 'uncertain',
      manifestDigest,
      servingProof: undefined,
    })
  })

  it('acknowledges promoted proof durably and retires only after each idempotent reply', async () => {
    const { transferId, manifestDigest, promoteInput } = await prepareAndValidateCandidate()
    const acknowledgeInput = {
      type: 'serverTransferAcknowledgeRequest',
      requestId: 'ack-before-promote',
      transferId,
      manifestDigest,
    }

    const beforePromote = await invoke(
      'serverTransferAcknowledgeRequest',
      acknowledgeInput,
      undefined,
      undefined,
      () => {
        throw new Error('must not retire before promotion')
      },
    )
    expect(beforePromote).toMatchObject({ ok: false, state: 'validated', errorCode: 'refused' })

    expect(
      await invoke('serverTransferPromoteRequest', promoteInput, async (expected) => expected),
    ).toMatchObject({ ok: true, state: 'promoted', servingProof: { health: 'serving' } })

    const wrongDigest = await invoke(
      'serverTransferAcknowledgeRequest',
      { ...acknowledgeInput, requestId: 'ack-wrong-digest', manifestDigest: 'f'.repeat(64) },
      undefined,
      undefined,
      () => {
        throw new Error('must not retire another digest')
      },
    )
    expect(wrongDigest).toMatchObject({
      ok: false,
      state: 'promoted',
      errorCode: 'conflicting-digest',
    })

    const missingRetire = await invoke('serverTransferAcknowledgeRequest', {
      ...acknowledgeInput,
      requestId: 'ack-missing-retire',
    })
    expect(missingRetire).toMatchObject({ ok: false, state: 'promoted', errorCode: 'refused' })

    const events: string[] = []
    const acknowledged = await invoke(
      'serverTransferAcknowledgeRequest',
      { ...acknowledgeInput, requestId: 'ack-success' },
      undefined,
      undefined,
      () => {
        events.push('retire')
      },
    )
    events.push('reply')
    expect(acknowledged).toMatchObject({
      ok: true,
      operation: 'acknowledge',
      state: 'promoted',
      manifestDigest,
      acknowledged: true,
      idempotent: false,
      servingProof: { transferId, manifestDigest, health: 'serving' },
    })
    expect(events).toEqual(['reply'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(['reply', 'retire'])

    const retry = await invoke(
      'serverTransferAcknowledgeRequest',
      { ...acknowledgeInput, requestId: 'ack-retry' },
      undefined,
      undefined,
      () => {
        events.push('retire-retry')
      },
    )
    expect(retry).toMatchObject({
      ok: true,
      acknowledged: true,
      idempotent: true,
      servingProof: { transferId, manifestDigest, health: 'serving' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(['reply', 'retire', 'retire-retry'])

    expect(
      await invoke('serverTransferStatusRequest', {
        type: 'serverTransferStatusRequest',
        requestId: 'status-acknowledged',
        transferId,
        manifestDigest,
      }),
    ).toMatchObject({
      ok: true,
      state: 'promoted',
      acknowledged: true,
      servingProof: { transferId, manifestDigest, health: 'serving' },
    })
    expect(
      JSON.parse(
        await readFile(join(stateRoot, '.server-transfer', transferId, 'state.json'), 'utf8'),
      ),
    ).toMatchObject({ state: 'promoted', acknowledged: true })
  })

  it('rollback never deletes originals that promotion did not touch', async () => {
    const transferId = randomUUID()
    const files: Record<string, Buffer> = {
      ...(await candidateFiles()),
      'transcripts/session.txt': Buffer.from('incoming-transcript'),
    }
    const manifest = Object.entries(files)
      .map(([path, content]) => fileEntry(path, content))
      .sort((a, b) => a.path.localeCompare(b.path))
    const manifestDigest = digest(transferManifest(transferId, manifest))
    await invoke('serverTransferPrepareRequest', {
      type: 'serverTransferPrepareRequest',
      requestId: 'prepare-rollback',
      transferId,
      manifest: transferManifest(transferId, manifest),
      manifestDigest,
    })
    for (const [path, content] of Object.entries(files)) {
      const chunk = await invoke('serverTransferChunkRequest', {
        type: 'serverTransferChunkRequest',
        requestId: `chunk-rollback-${path}`,
        transferId,
        manifestDigest,
        path,
        offset: 0,
        data: content.toString('base64'),
        expectedLength: content.length,
      })
      expect(chunk.ok).toBe(true)
    }
    expect(
      await invoke('serverTransferValidateRequest', {
        type: 'serverTransferValidateRequest',
        requestId: 'validate-rollback',
        transferId,
        manifestDigest,
      }),
    ).toMatchObject({ ok: true, state: 'validated' })

    await writeFile(join(stateRoot, 'enrollment.ledger'), 'original-target-ledger')
    await writeFile(join(stateRoot, 'podium.db'), 'original-target-db')
    const outside = join(stateRoot, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'session.txt'), 'untouched-original')
    await symlink(outside, join(stateRoot, 'transcripts'), 'dir')

    const promote = await invoke('serverTransferPromoteRequest', {
      type: 'serverTransferPromoteRequest',
      requestId: 'promote-rollback',
      transferId,
      manifestDigest,
      publicUrl: 'https://podium.example.com',
      targetMode: 'server',
      idempotencyKey: 'rollback-once',
    })
    expect(promote).toMatchObject({ ok: false, state: 'validated', errorCode: 'unsafe-path' })
    expect(await readFile(join(stateRoot, 'enrollment.ledger'), 'utf8')).toBe(
      'original-target-ledger',
    )
    expect(await readFile(join(stateRoot, 'podium.db'), 'utf8')).toBe('original-target-db')
    expect(await readFile(join(outside, 'session.txt'), 'utf8')).toBe('untouched-original')
    expect(
      JSON.parse(
        await readFile(join(stateRoot, '.server-transfer', transferId, 'state.json'), 'utf8'),
      ),
    ).toMatchObject({ state: 'validated', promotion: undefined, publicUrl: undefined })
  })
})
