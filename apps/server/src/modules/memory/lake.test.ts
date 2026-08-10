import type { ControlMessage } from '@podium/protocol'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../store'
import { DaemonRequestBroker } from '../daemon-request'
import { TranscriptLake } from './lake'

describe('TranscriptLake mirror fence', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  })

  it('exposes pause/drain/resume without losing dirty mirror work', async () => {
    const store = new SessionStore(':memory:')
    const lakeDir = mkdtempSync(join(tmpdir(), 'podium-lake-fence-'))
    const sent: { machineId: string; message: ControlMessage }[] = []
    const daemonRequest = new DaemonRequestBroker({
      toMachine: (machineId, message) => sent.push({ machineId, message }),
      defaultMachine: () => 'm1',
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
      machineId: 'm1',
      nativeId,
      providerId: 'claude-code-jsonl',
      path: sourcePath,
      sizeBytes: content.length,
    })

    lake.triggerSweep('m1')
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

    lake.onMirrorResult('m1', {
      requestId: first.requestId,
      data: content.toString('base64'),
      fileSize: content.length,
      eof: true,
    })
    await paused

    const lakePath = join(lakeDir, 'm1', `${nativeId}.jsonl`)
    expect(store.conversations.mirror.mirrorCursor('m1', nativeId)).toBe(0)
    expect(existsSync(lakePath)).toBe(false)

    // A scan during transfer stays queued/dirty and does not issue another read.
    lake.triggerSweep('m1')
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

    lake.onMirrorResult('m1', {
      requestId: resumed.requestId,
      data: content.toString('base64'),
      fileSize: content.length,
      eof: true,
    })
    await vi.waitFor(() => {
      expect(store.conversations.mirror.segmentsToMirrorDirty('m1')).toEqual([])
    })

    expect(store.conversations.mirror.mirrorCursor('m1', nativeId)).toBe(content.length)
    expect(readFileSync(lakePath)).toEqual(content)
  })
})
