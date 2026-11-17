import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_WORKSPACE_ID } from '@podium/blob-store'
import { LocalBlobStorage } from '@podium/blob-store/local'
import { asMachineId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { transcriptRecordMapperFor } from '../../harness-manifest'
import { openTestStore } from '../../test-support/open-test-store'
import { DaemonRequestBroker } from '../daemon-request'
import { TranscriptLake } from '../memory/lake'
import { PortableStateFence } from './portable-fence'
import { sourceTransferFence } from './source-fence'

/**
 * The transfer fence's order against the transcript mirror (POD-6963 design
 * 2.3). Lake parts are written through the local file storage, which runs every
 * write inside the portable fence, exactly as the server composes it. A daemon
 * read answered while the source fences must not turn into a refused write.
 */
describe('source transfer fence and the transcript mirror', () => {
  const cleanups: (() => void | Promise<void>)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  const machineId = asMachineId('m1')
  const nativeId = 'fenced-segment'
  const content = Buffer.from(
    `${JSON.stringify({
      type: 'user',
      uuid: 'u-fenced',
      timestamp: '2026-11-17T08:00:00.000Z',
      message: { role: 'user', content: 'mirrored across a transfer fence' },
    })}\n`,
  )

  async function setup() {
    const stateDir = mkdtempSync(join(tmpdir(), 'podium-source-fence-'))
    const store = await openTestStore(':memory:')
    const portable = new PortableStateFence()
    const blobs = new LocalBlobStorage({ stateDir, fence: portable }).forWorkspace(
      LOCAL_WORKSPACE_ID,
    )
    const sent: ControlMessage[] = []
    const lake = new TranscriptLake(
      {
        store: store.conversations,
        now: Date.now,
        daemonRequest: new DaemonRequestBroker({
          toMachine: (_machineId, message) => sent.push(message),
          defaultMachine: () => machineId,
        }),
        parseForAgentKind: (agentKind) => transcriptRecordMapperFor(agentKind),
        findSessionByNativeId: async () => undefined,
      },
      { transcriptLake: { blobs, workspaceId: LOCAL_WORKSPACE_ID } },
    )
    cleanups.push(
      () => rmSync(stateDir, { recursive: true, force: true }),
      () => store.close(),
      () => lake.dispose(),
    )
    await store.conversations.registry.ensure({
      machineId,
      nativeId,
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-proj/fenced-segment.jsonl',
      sizeBytes: content.length,
    })
    const reads = () =>
      sent.filter(
        (message): message is Extract<ControlMessage, { type: 'transcriptMirrorRead' }> =>
          message.type === 'transcriptMirrorRead',
      )
    const answer = (index: number) => {
      const read = reads()[index]
      if (!read) throw new Error(`mirror read ${index} not sent`)
      lake.onMirrorResult(machineId, {
        requestId: read.requestId,
        data: content.toString('base64'),
        fileSize: content.length,
        eof: true,
      })
    }
    const fence = sourceTransferFence({
      mirror: {
        pause: async () => await lake.pauseMirroring(),
        resume: async () => await lake.resumeMirroring(),
      },
      portable,
      store: { begin: async () => {}, end: async () => {} },
    })
    return { store, portable, lake, reads, answer, fence }
  }

  it('drops a read answered while fencing and resumes the segment, never backing it off', async () => {
    const { store, lake, reads, answer, fence } = await setup()
    await lake.triggerSweep(machineId)
    await vi.waitFor(() => expect(reads()).toHaveLength(1))

    // The transfer fences while the read is outstanding: the mirror pauses
    // first, so the reply that arrives now is dropped rather than written.
    let fenced = false
    const fencing = fence.fence().then(() => {
      fenced = true
    })
    await Promise.resolve()
    expect(fenced).toBe(false)
    answer(0)
    await fencing
    expect(await store.conversations.mirror.mirrorCursor(machineId, nativeId)).toBe(0)

    // Released, the mirror resumes the preserved segment from its cursor at once.
    await fence.releaseFence()
    await vi.waitFor(() => expect(reads()).toHaveLength(2))
    expect(reads()[1]?.offset).toBe(0)
    answer(1)
    await vi.waitFor(async () => {
      expect(await store.conversations.mirror.mirrorCursor(machineId, nativeId)).toBe(
        content.length,
      )
    })
  })

  it('fenced before the mirror pauses, the same reply is refused and backs the segment off', async () => {
    // The order this module exists to prevent, pinned so a reversal fails here.
    const { store, portable, lake, reads, answer } = await setup()
    await lake.triggerSweep(machineId)
    await vi.waitFor(() => expect(reads()).toHaveLength(1))
    await portable.acquire()
    answer(0)
    // Let the reply reach its refused part write before the mirror pauses.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await lake.pauseMirroring()
    portable.release()
    await lake.resumeMirroring()
    await lake.triggerSweep(machineId)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(reads()).toHaveLength(1)
    expect(await store.conversations.mirror.mirrorCursor(machineId, nativeId)).toBe(0)
  })

  it('undoes the steps already taken when a later one fails', async () => {
    const calls: string[] = []
    const fence = sourceTransferFence({
      daemon: () => ({
        pauseAndDrain: async () => {
          calls.push('daemon.pause')
        },
        resume: () => calls.push('daemon.resume'),
      }),
      mirror: {
        pause: async () => {
          calls.push('mirror.pause')
        },
        resume: async () => {
          calls.push('mirror.resume')
        },
      },
      portable: {
        acquire: async () => {
          calls.push('portable.acquire')
        },
        release: () => calls.push('portable.release'),
      },
      store: {
        begin: async () => {
          throw new Error('store fence refused')
        },
        end: async () => {},
      },
    })
    await expect(fence.fence()).rejects.toThrow('store fence refused')
    expect(calls).toEqual([
      'daemon.pause',
      'mirror.pause',
      'portable.acquire',
      'portable.release',
      'mirror.resume',
      'daemon.resume',
    ])
  })
})
