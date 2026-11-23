import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { transcriptRecordMapperFor } from '../../harness-manifest'
import { forceFeature } from '../../test-support/features'
import { LAKE_BACKENDS } from '../../test-support/lake-backends'
import { openTestStore } from '../../test-support/open-test-store'
import { DaemonRequestBroker } from '../daemon-request'
import { TranscriptLake } from './lake'
import { TranscriptIndexer } from './transcript-indexer'

describe.each(LAKE_BACKENDS)('TranscriptLake mirror fence on the $name lake', (backendKind) => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  })

  it('exposes pause/drain/resume without losing dirty mirror work', async () => {
    const store = await openTestStore(':memory:')
    const backend = backendKind.create()
    const sent: { machineId: string; message: ControlMessage }[] = []
    const daemonRequest = new DaemonRequestBroker({
      toMachine: (machineId, message) => {
        sent.push({ machineId, message })
      },
      defaultMachine: () => asMachineId('m1'),
    })
    const lake = new TranscriptLake(
      {
        store: store.conversations,
        now: Date.now,
        daemonRequest,
        parseForAgentKind: (agentKind) => transcriptRecordMapperFor(agentKind),
        findSessionByNativeId: async () => undefined,
      },
      { transcriptLake: backend.storage },
    )
    cleanups.push(
      () => backend.dispose(),
      () => store.close(),
      () => lake.dispose(),
    )

    const nativeId = 'transfer-fence'
    const sourcePath = '/home/u/.claude/projects/-proj/transfer-fence.jsonl'
    const content = Buffer.from(
      `${JSON.stringify({
        type: 'user',
        uuid: 'u-transfer-fence',
        timestamp: '2026-08-10T08:00:00.000Z',
        message: { role: 'user', content: 'preserve me across an aborted transfer' },
      })}\n`,
    )
    await store.conversations.registry.ensure({
      machineId: asMachineId('m1'),
      nativeId,
      providerId: 'claude-code-jsonl',
      path: sourcePath,
      sizeBytes: content.length,
    })

    await lake.triggerSweep(asMachineId('m1'))
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const first = sent[0]?.message
    expect(first?.type).toBe('transcriptMirrorRead')
    if (!first || first.type !== 'transcriptMirrorRead') throw new Error('mirror read not sent')

    let pauseResolved = false
    const paused = lake.pauseMirroring().then(() => {
      pauseResolved = true
    })
    await Promise.resolve()
    expect(pauseResolved).toBe(false)

    lake.onMirrorResult(asMachineId('m1'), {
      requestId: first.requestId,
      data: content.toString('base64'),
      fileSize: content.length,
      eof: true,
    })
    await paused

    expect(await store.conversations.mirror.mirrorCursor(asMachineId('m1'), nativeId)).toBe(0)
    expect(await backend.read(asMachineId('m1'), nativeId)).toEqual(Buffer.alloc(0))

    // A scan during transfer stays queued/dirty and does not issue another read.
    await lake.triggerSweep(asMachineId('m1'))
    await Promise.resolve()
    expect(sent).toHaveLength(1)

    await lake.resumeMirroring()
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    const resumed = sent[1]?.message
    expect(resumed?.type).toBe('transcriptMirrorRead')
    if (!resumed || resumed.type !== 'transcriptMirrorRead') {
      throw new Error('resumed mirror read not sent')
    }
    expect(resumed.offset).toBe(0)

    lake.onMirrorResult(asMachineId('m1'), {
      requestId: resumed.requestId,
      data: content.toString('base64'),
      fileSize: content.length,
      eof: true,
    })
    await vi.waitFor(async () => {
      expect(await store.conversations.mirror.segmentsToMirrorDirty(asMachineId('m1'))).toEqual([])
    })

    expect(await store.conversations.mirror.mirrorCursor(asMachineId('m1'), nativeId)).toBe(
      content.length,
    )
    expect(await backend.read(asMachineId('m1'), nativeId)).toEqual(content)
  })
})

/**
 * `transcriptLake: 'off'` (PDM-26) reaches the lake as ABSENT lake storage, which
 * is the no-op shape it already supported — the mirror and the indexer are
 * simply never constructed.
 */
describe('a lake the deployment turned off', () => {
  it('constructs no mirror and no indexer', async () => {
    const store = await openTestStore(':memory:')
    const daemonRequest = new DaemonRequestBroker({
      toMachine: () => {},
      defaultMachine: () => asMachineId('m1'),
    })
    const lake = new TranscriptLake(
      {
        store: store.conversations,
        now: Date.now,
        daemonRequest,
        parseForAgentKind: (agentKind) => transcriptRecordMapperFor(agentKind),
        findSessionByNativeId: async () => undefined,
      },
      {},
    )
    try {
      expect(lake.mirroring).toBe(false)
    } finally {
      lake.dispose()
      await store.close()
    }
  })

  it('a lake with storage does mirror — the flag is the only difference', async () => {
    const store = await openTestStore(':memory:')
    const backend = LAKE_BACKENDS[0]?.create()
    if (!backend) throw new Error('no lake backend')
    const daemonRequest = new DaemonRequestBroker({
      toMachine: () => {},
      defaultMachine: () => asMachineId('m1'),
    })
    const lake = new TranscriptLake(
      {
        store: store.conversations,
        now: Date.now,
        daemonRequest,
        parseForAgentKind: (agentKind) => transcriptRecordMapperFor(agentKind),
        findSessionByNativeId: async () => undefined,
      },
      { transcriptLake: backend.storage },
    )
    try {
      expect(lake.mirroring).toBe(true)
    } finally {
      lake.dispose()
      await store.close()
      backend.dispose()
    }
  })
})

/**
 * SEARCH OFF MEANS INDEX NOTHING, AND LOSE NOTHING [PDM-25].
 *
 * The lake keeps mirroring when search is off — the two switches are separate on
 * purpose. What must hold is that the indexer stays inert and leaves the durable
 * byte cursor alone, so the bytes that accumulated while it was off are indexed
 * on the first boot that has an index again, rather than being skipped forever.
 */
describe('the transcript indexer follows the search flag', () => {
  const record = (uuid: string, text: string) =>
    `${JSON.stringify({
      type: 'user',
      uuid,
      timestamp: '2026-09-01T10:00:00.000Z',
      message: { role: 'user', content: text },
    })}\n`

  it('indexes nothing while search is off, then catches up once it is on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-lake-flag-'))
    const backend = LAKE_BACKENDS[1]?.create()
    if (!backend) throw new Error('no lake backend')
    const bytes = record('u1', 'the flux capacitor drifts under load')
    const machineId = asMachineId('22222222-2222-4222-8222-222222222222')
    await backend.write(machineId, 'native-a', bytes)
    const dbPath = join(dir, 'podium.db')

    forceFeature('command-palette', false)
    const off = await openTestStore(dbPath)
    await off.conversations.registry.ensure({
      machineId,
      nativeId: 'native-a',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-proj/native-a.jsonl',
      sizeBytes: bytes.length,
    })
    await off.conversations.mirror.setMirrorCursor(
      machineId,
      'native-a',
      0,
      bytes.length,
      new Date().toISOString(),
    )
    const idle = new TranscriptIndexer({
      mirror: off.conversations.mirror,
      index: off.conversations.transcriptIndex,
      readItems: async () => undefined,
    })
    await idle.onBytes(machineId, 'native-a')
    await idle.settled()
    // Nothing consumed and, crucially, nothing claimed: the cursor still says
    // these bytes are unread, which is what makes the catch-up below possible.
    expect(await off.conversations.transcriptIndex.indexedCursor(machineId, 'native-a')).toBe(0)
    idle.dispose()
    await off.close()

    forceFeature('command-palette', true)
    const on = await openTestStore(dbPath)
    const { fileIdFor, readIndexWindow } = await import('@podium/harness/store')
    const mapper = transcriptRecordMapperFor('claude-code')
    if (!mapper) throw new Error('claude-code grammar missing')
    const indexer = new TranscriptIndexer({
      mirror: on.conversations.mirror,
      index: on.conversations.transcriptIndex,
      readItems: async (_machineId, nativeId, from, to, windowBytes) =>
        await readIndexWindow(
          backend.lake.source({ machineId, nativeId, incarnation: 1 }, () => bytes.length),
          fileIdFor(nativeId),
          mapper,
          from,
          to,
          windowBytes,
        ),
    })
    await indexer.onBytes(machineId, 'native-a')
    await indexer.settled()
    expect(await on.conversations.transcriptIndex.indexedCursor(machineId, 'native-a')).toBe(
      bytes.length,
    )
    expect(
      (await on.conversations.transcriptIndex.searchCandidates('capacitor')).map((c) => c.nativeId),
    ).toEqual(['native-a'])
    indexer.dispose()
    await on.close()
    backend.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe.each(LAKE_BACKENDS)('lake namespaces on the $name lake', (backendKind) => {
  it.each([
    'legacy',
    'active',
    'archived',
  ] as const)('%s: match live bytes only for the active incarnation', async (mode) => {
    const { decodeCursor, fileByteSource, fileIdFor, readFileItems } = await import(
      '@podium/harness/store'
    )
    const claudeRecordToItems = transcriptRecordMapperFor('claude-code')
    if (!claudeRecordToItems) throw new Error('claude-code grammar missing')
    const store = await openTestStore(':memory:')
    const dir = mkdtempSync(join(tmpdir(), 'lake-namespace-'))
    const backend = backendKind.create()
    const machineId = asMachineId('namespace-machine')
    const nativeId = 'native-session'
    const daemonRequest = new DaemonRequestBroker({
      toMachine: () => {},
      defaultMachine: () => machineId,
    })
    const lake = new TranscriptLake(
      {
        store: store.conversations,
        now: Date.now,
        daemonRequest,
        parseForAgentKind: (agentKind) => transcriptRecordMapperFor(agentKind),
        findSessionByNativeId: async () => undefined,
      },
      { transcriptLake: backend.storage },
    )
    try {
      const bytes = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'same bytes' } })}\n`
      // The live file is the daemon's native file, outside the lake.
      const livePath = join(dir, 'live.jsonl')
      writeFileSync(livePath, bytes)
      await store.conversations.registry.ensure({
        machineId,
        nativeId,
        providerId: 'claude-code-jsonl',
        path: livePath,
        sizeBytes: Buffer.byteLength(bytes),
      })
      if (mode !== 'legacy') {
        await store.conversations.mirror.startIncarnation(
          machineId,
          nativeId,
          { device: '1', inode: '1' },
          '2026-09-16T00:00:00.000Z',
        )
      }
      // A segment with no incarnation row, and the first row, both keep their
      // bytes at sequence 1 (POD-6963 design 2.3, "Keys").
      await backend.write(machineId, nativeId, bytes, 1)
      if (mode === 'archived') {
        expect(
          await store.conversations.mirror.rotateIncarnation(
            machineId,
            nativeId,
            { sequence: 1, device: '1', inode: '1' },
            { device: '1', inode: '2' },
            Buffer.byteLength(bytes),
            '2026-09-16T00:01:00.000Z',
          ),
        ).toBe(true)
        await backend.write(machineId, nativeId, bytes, 2)
      }
      await store.conversations.mirror.setMirrorCursor(
        machineId,
        nativeId,
        0,
        Buffer.byteLength(bytes),
        '2026-09-16T00:02:00.000Z',
      )
      const session = {
        machineId,
        agentKind: 'claude-code' as const,
        resume: { kind: 'claude-session' as const, value: nativeId },
      }
      const first = await lake.readWindow(session, { direction: 'before', limit: 10 })
      expect(first?.items).toHaveLength(mode === 'archived' ? 2 : 1)
      const live = await readFileItems(
        fileByteSource(livePath),
        fileIdFor(nativeId),
        claudeRecordToItems,
      )
      expect(first?.items.at(-1)).toEqual(live[0])
      expect(await lake.readWindow(session, { direction: 'before', limit: 10 })).toEqual(first)
      if (mode === 'archived') {
        expect(decodeCursor(first?.items[0]?.cursor ?? '')?.fileId).toBe(fileIdFor(nativeId, 1))
        // Identical bytes in a retired generation are distinct history, not a duplicate live row.
        expect(first?.items[0]?.id).not.toBe(live[0]?.id)
      }
    } finally {
      lake.dispose()
      store.close()
      backend.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * Two workspaces may hold the same machine and native ids, and the parsed-slice
 * and tail caches are shared by the process (POD-7051). Each lake source's id
 * names its workspace, so no cache entry crosses from one workspace to the other
 * even when the two sources report the same version.
 */
it('two workspaces with equal machine and native ids share no cache entry', async () => {
  const machineId = asMachineId('shared-machine')
  const nativeId = 'shared-native'
  const record = (text: string) =>
    `${JSON.stringify({
      type: 'user',
      uuid: 'u-shared',
      timestamp: '2026-11-17T10:00:00.000Z',
      message: { role: 'user', content: text },
    })}\n`
  // Same length on purpose: equal cursors, and each bucket's first etag is the
  // same, so the two sources' versions are equal and only their ids differ.
  const contents = { 'ws-one': record('alpha workspace'), 'ws-two': record('omega workspace') }
  const lakes: { lake: TranscriptLake; close: () => Promise<void> }[] = []
  const sources: { id: string; version: string }[] = []
  const memory = LAKE_BACKENDS.find((kind) => kind.name === 'memory')
  if (!memory) throw new Error('no memory lake backend')
  try {
    for (const [workspaceId, bytes] of Object.entries(contents)) {
      const store = await openTestStore(':memory:')
      const backend = memory.create(workspaceId)
      await store.conversations.registry.ensure({
        machineId,
        nativeId,
        providerId: 'claude-code-jsonl',
        path: '/home/u/.claude/projects/-proj/shared-native.jsonl',
        sizeBytes: Buffer.byteLength(bytes),
      })
      await backend.write(machineId, nativeId, bytes)
      await store.conversations.mirror.setMirrorCursor(
        machineId,
        nativeId,
        0,
        Buffer.byteLength(bytes),
        '2026-11-17T10:00:00.000Z',
      )
      const source = backend.lake.source({ machineId, nativeId, incarnation: 1 }, () =>
        Buffer.byteLength(bytes),
      )
      sources.push({ id: source.id, version: await source.version() })
      const lake = new TranscriptLake(
        {
          store: store.conversations,
          now: Date.now,
          daemonRequest: new DaemonRequestBroker({
            toMachine: () => {},
            defaultMachine: () => machineId,
          }),
          parseForAgentKind: (agentKind) => transcriptRecordMapperFor(agentKind),
          findSessionByNativeId: async () => undefined,
        },
        { transcriptLake: backend.storage },
      )
      lakes.push({ lake, close: async () => await store.close() })
    }
    expect(sources[0]?.version).toBe(sources[1]?.version)
    expect(sources.map((source) => source.id)).toEqual([
      'ws-one/transcripts/shared-machine/shared-native/00000001',
      'ws-two/transcripts/shared-machine/shared-native/00000001',
    ])
    const session = {
      machineId,
      agentKind: 'claude-code' as const,
      resume: { kind: 'claude-session' as const, value: nativeId },
    }
    // Both reads go through the cached slice path; the second must not be
    // served the first workspace's parsed items.
    const [one, two] = [
      await lakes[0]?.lake.readWindow(session, { direction: 'before', limit: 10 }),
      await lakes[1]?.lake.readWindow(session, { direction: 'before', limit: 10 }),
    ]
    expect(JSON.stringify(one?.items)).toContain('alpha workspace')
    expect(JSON.stringify(two?.items)).toContain('omega workspace')
    expect(JSON.stringify(two?.items)).not.toContain('alpha workspace')
  } finally {
    for (const { lake, close } of lakes) {
      lake.dispose()
      await close()
    }
  }
})
