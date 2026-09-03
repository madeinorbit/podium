import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forceFeature } from '../../test-support/features'
import { openTestStore } from '../../test-support/open-test-store'
import { DaemonRequestBroker } from '../daemon-request'
import { TranscriptLake } from './lake'
import { TranscriptIndexer } from './transcript-indexer'

describe('TranscriptLake mirror fence', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  })

  it('exposes pause/drain/resume without losing dirty mirror work', async () => {
    const store = openTestStore(':memory:')
    const lakeDir = mkdtempSync(join(tmpdir(), 'podium-lake-fence-'))
    const sent: { machineId: string; message: ControlMessage }[] = []
    const daemonRequest = new DaemonRequestBroker({
      toMachine: (machineId, message) => sent.push({ machineId, message }),
      defaultMachine: () => asMachineId('m1'),
    })
    const lake = new TranscriptLake(
      {
        store: store.conversations,
        now: Date.now,
        daemonRequest,
      },
      { mirrorLakeDir: lakeDir },
    )
    cleanups.push(
      () => rmSync(lakeDir, { recursive: true, force: true }),
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
    store.conversations.registry.ensure({
      machineId: asMachineId('m1'),
      nativeId,
      providerId: 'claude-code-jsonl',
      path: sourcePath,
      sizeBytes: content.length,
    })

    lake.triggerSweep(asMachineId('m1'))
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

    const lakePath = join(lakeDir, 'm1', `${nativeId}.jsonl`)
    expect(store.conversations.mirror.mirrorCursor(asMachineId('m1'), nativeId)).toBe(0)
    expect(existsSync(lakePath)).toBe(false)

    // A scan during transfer stays queued/dirty and does not issue another read.
    lake.triggerSweep(asMachineId('m1'))
    await Promise.resolve()
    expect(sent).toHaveLength(1)

    lake.resumeMirroring()
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
    await vi.waitFor(() => {
      expect(store.conversations.mirror.segmentsToMirrorDirty(asMachineId('m1'))).toEqual([])
    })

    expect(store.conversations.mirror.mirrorCursor(asMachineId('m1'), nativeId)).toBe(
      content.length,
    )
    expect(readFileSync(lakePath)).toEqual(content)
  })
})

/**
 * `transcriptLake: 'off'` (PDM-26) reaches the lake as an ABSENT lake dir, which
 * is the no-op shape it already supported — the mirror and the indexer are
 * simply never constructed.
 */
describe('a lake the deployment turned off', () => {
  it('constructs no mirror and no indexer', () => {
    const store = openTestStore(':memory:')
    const daemonRequest = new DaemonRequestBroker({
      toMachine: () => {},
      defaultMachine: () => asMachineId('m1'),
    })
    const lake = new TranscriptLake(
      { store: store.conversations, now: Date.now, daemonRequest },
      {},
    )
    try {
      expect(lake.mirroring).toBe(false)
    } finally {
      lake.dispose()
      store.close()
    }
  })

  it('a lake with a dir does mirror — the flag is the only difference', () => {
    const store = openTestStore(':memory:')
    const lakeDir = mkdtempSync(join(tmpdir(), 'podium-lake-on-'))
    const daemonRequest = new DaemonRequestBroker({
      toMachine: () => {},
      defaultMachine: () => asMachineId('m1'),
    })
    const lake = new TranscriptLake(
      { store: store.conversations, now: Date.now, daemonRequest },
      { mirrorLakeDir: lakeDir },
    )
    try {
      expect(lake.mirroring).toBe(true)
    } finally {
      lake.dispose()
      store.close()
      rmSync(lakeDir, { recursive: true, force: true })
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
    const lakePath = join(dir, 'native-a.jsonl')
    const bytes = record('u1', 'the flux capacitor drifts under load')
    writeFileSync(lakePath, bytes)
    const machineId = asMachineId('22222222-2222-4222-8222-222222222222')
    const dbPath = join(dir, 'podium.db')

    forceFeature('command-palette', false)
    const off = openTestStore(dbPath)
    off.conversations.registry.ensure({
      machineId,
      nativeId: 'native-a',
      providerId: 'claude-code-jsonl',
      path: lakePath,
      sizeBytes: bytes.length,
    })
    off.conversations.mirror.setMirrorCursor(
      machineId,
      'native-a',
      bytes.length,
      new Date().toISOString(),
    )
    const idle = new TranscriptIndexer({
      mirror: off.conversations.mirror,
      index: off.conversations.transcriptIndex,
    })
    idle.onBytes(machineId, 'native-a', lakePath)
    await idle.settled()
    // Nothing consumed and, crucially, nothing claimed: the cursor still says
    // these bytes are unread, which is what makes the catch-up below possible.
    expect(off.conversations.transcriptIndex.indexedCursor(machineId, 'native-a')).toBe(0)
    idle.dispose()
    off.close()

    forceFeature('command-palette', true)
    const on = openTestStore(dbPath)
    const indexer = new TranscriptIndexer({
      mirror: on.conversations.mirror,
      index: on.conversations.transcriptIndex,
    })
    indexer.onBytes(machineId, 'native-a', lakePath)
    await indexer.settled()
    expect(on.conversations.transcriptIndex.indexedCursor(machineId, 'native-a')).toBe(bytes.length)
    expect(
      on.conversations.transcriptIndex.searchCandidates('capacitor').map((c) => c.nativeId),
    ).toEqual(['native-a'])
    indexer.dispose()
    on.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
