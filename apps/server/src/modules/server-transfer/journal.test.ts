import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TransferJournal,
  assertWritableServerBoot,
  blocksWritableServer,
  canTransition,
  reconcileSafeServerTransferBoot,
  serverTransferBootMode,
} from './journal'
import { PortableStateFence } from './portable-fence'
import type { TransferRecord } from './types'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'podium-transfer-journal-'))
  roots.push(root)
  const record: TransferRecord = {
    operationId: 'operation-1',
    phase: 'preparing',
    bytesCopied: 0,
    totalBytes: 0,
    transferId: 'transfer-1',
    targetMachineId: 'target-1',
    publicUrl: 'https://podium.example.com',
    sourceMachineId: 'source-1',
    sourceInstanceId: 'instance-1',
    packageDir: join(root, 'package'),
    manifest: null,
    idempotencyKey: 'key-1',
    targetProof: false,
    sourceConnected: false,
  }
  return { root, journal: new TransferJournal(join(root, '.server-transfer')), record }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('TransferJournal', () => {
  it('persists every legal transition and makes same-state retries idempotent', async () => {
    const { journal, record } = await fixture()
    journal.begin(record)
    for (const state of ['staged', 'validated', 'source-fenced', 'committing'] as const) {
      const first = journal.transition(state)
      const retried = journal.transition(state)
      expect(retried.updatedAt).toBe(first.updatedAt)
      expect(JSON.parse(await readFile(journal.path, 'utf8')).state).toBe(state)
    }
    journal.transition('committed')
    expect(journal.read()?.state).toBe('committed')
  })

  it('rejects every shortcut and never allows abort after commit starts', async () => {
    const { journal, record } = await fixture()
    journal.begin(record)
    expect(() => journal.transition('validated')).toThrow(/illegal/)
    journal.transition('staged')
    journal.transition('validated')
    journal.transition('source-fenced')
    journal.transition('committing')
    expect(() =>
      journal.abort({ code: 'late', message: 'late abort' }, { result: 'cleaned' }),
    ).toThrow(/cannot abort/)
    expect(canTransition('committing', 'aborted')).toBe(false)
  })

  it('distinguishes safe abort from commit uncertainty and blocks writable boot', async () => {
    const { root, journal, record } = await fixture()
    journal.begin(record)
    journal.transition('staged')
    journal.transition('validated')
    journal.transition('source-fenced')
    expect(blocksWritableServer('source-fenced')).toBe(true)
    expect(() => assertWritableServerBoot(root)).toThrow(/source-fenced/)

    journal.transition('committing')
    journal.commitUncertain({ code: 'lost-reply', message: 'promotion reply lost' })
    expect(journal.read()?.state).toBe('commit-uncertain')
    expect(() => journal.clearReviewedOutcome()).toThrow(/cannot clear/)
    expect(() => assertWritableServerBoot(root)).toThrow(/commit-uncertain/)
  })

  it.each(['preparing', 'staged', 'validated'] as const)(
    'durably aborts stale pre-fence %s state and permits writable boot',
    async (state) => {
      const { root, journal, record } = await fixture()
      journal.begin(record)
      if (state === 'staged' || state === 'validated') journal.transition('staged')
      if (state === 'validated') journal.transition('validated')

      const recovered = reconcileSafeServerTransferBoot(root)

      expect(recovered).toMatchObject({
        state: 'aborted',
        error: { code: 'boot-recovery' },
        cleanup: { result: 'pending' },
      })
      expect(serverTransferBootMode(root)).toBe('writable')
      expect(() => assertWritableServerBoot(root)).not.toThrow()
    },
  )

  it.each([
    ['source-fenced', 'recovery-only'],
    ['committing', 'recovery-only'],
    ['commit-uncertain', 'recovery-only'],
    ['committed', 'daemon-only'],
  ] as const)('keeps %s non-writable with %s boot disposition', async (state, mode) => {
    const { root, journal, record } = await fixture()
    journal.begin(record)
    journal.transition('staged')
    journal.transition('validated')
    journal.transition('source-fenced')
    if (state !== 'source-fenced') journal.transition('committing')
    if (state === 'commit-uncertain') {
      journal.commitUncertain({ code: 'lost', message: 'lost reply' })
    } else if (state === 'committed') {
      journal.transition('committed')
    }

    expect(reconcileSafeServerTransferBoot(root)?.state).toBe(state)
    expect(serverTransferBootMode(root)).toBe(mode)
    expect(() => assertWritableServerBoot(root)).toThrow(/refusing writable server boot/)
  })
})

describe('PortableStateFence', () => {
  it('drains active writers, rejects new writers while held, and reopens on safe abort', async () => {
    const fence = new PortableStateFence()
    let finishWriter: (() => void) | undefined
    const writer = fence.runWriter(
      () =>
        new Promise<void>((resolve) => {
          finishWriter = resolve
        }),
    )
    let acquired = false
    const acquire = fence.acquire().then(() => {
      acquired = true
    })

    await Promise.resolve()
    expect(acquired).toBe(false)
    await expect(fence.runWriter(async () => {})).rejects.toThrow(/portable state is fenced/)

    finishWriter?.()
    await writer
    await acquire
    expect(acquired).toBe(true)

    fence.release()
    await expect(fence.runWriter(async () => 'open')).resolves.toBe('open')
  })
})
