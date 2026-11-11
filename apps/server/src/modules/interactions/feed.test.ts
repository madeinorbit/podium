import { asSessionId, interactionRowId } from '@podium/model'
import { Ledger } from '@podium/sync'
import { testLedgerWriter } from '@podium/sync/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
import { afterCommit, applyAfterCommit, spanOpen } from '../../store/executor/executor'
import { openTestStore } from '../../test-support/open-test-store'
import { expectRecordLogParity } from '../../test-support/record-log-parity'
import { testStoreRecords } from '../../test-support/record-writer'
import { InteractionFeedPublisher } from './feed'
import { InteractionService, interactionWireOf } from './service'

const SESSION = asSessionId('ses_interaction_feed')
const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function harness() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const ledger = new Ledger({
    repo: store.sync,
    records: testStoreRecords(store),
    now: Date.now,
    transact: async (fn) => await store.transact(fn),
    postCommit: (step, label) => afterCommit(step, label),
    applyCommit: { spanOpen, onCommit: applyAfterCommit },
  })
  const feed = new InteractionFeedPublisher({
    ledger: testLedgerWriter(ledger),
  })
  store.interactions.setFeedCapture(feed.capture)
  const service = new InteractionService({
    store: store.interactions,
    now: () => '2026-11-11T00:00:00.000Z',
    deliver: async () => ({ ok: true, via: 'menu', choices: [] }),
    readTranscript: async () => ({ items: [] }),
    causalFailuresOwned: () => false,
    policyPrincipal: () => ({
      kind: 'system',
      attribution: { actor: { kind: 'system', job: 'interaction-test' }, onBehalfOf: null },
      principalRef: 'interaction-test',
      delegation: null,
    }),
  })
  const ask = async () =>
    await service.ask({
      interaction: {
        id: 'ixn_feed',
        sessionId: SESSION,
        kind: 'permission',
        payload: { v: 1, toolName: 'Bash', canAlwaysAllow: false },
        source: 'hook',
        answerable: 'keystroke-emulated',
      },
    })
  return { store, ledger, feed, service, ask }
}

describe('the pending interaction feed', () => {
  it('builds a changed ask from its table and logs nothing for a repeated ask or close', async () => {
    const { store, ledger, service, ask } = await harness()
    expect((await ask()).inserted).toBe(true)
    await vi.waitFor(async () => {
      const row = await store.interactions.get('ixn_feed')
      if (!row) throw new Error('the ask was not stored')
      expect(
        (await ledger.changesSince(0))?.filter((c) => c.entity === 'pendingInteraction'),
      ).toMatchObject([
        {
          id: interactionRowId(SESSION, 'ixn_feed'),
          op: 'upsert',
          value: interactionWireOf(row),
        },
      ])
    })
    await expectRecordLogParity(store, ledger, 'pendingInteraction')
    const asked = await ledger.cursor()
    expect((await ask()).inserted).toBe(false)
    expect(await ledger.cursor()).toBe(asked)
    await service.onSessionExited(SESSION)
    await vi.waitFor(async () =>
      expect(await ledger.changesSince(asked)).toMatchObject([
        { entity: 'pendingInteraction', id: interactionRowId(SESSION, 'ixn_feed'), op: 'remove' },
      ]),
    )
    const closed = await ledger.cursor()
    await service.onSessionExited(SESSION)
    expect(await ledger.cursor()).toBe(closed)
    await expectRecordLogParity(store, ledger, 'pendingInteraction')
  })

  it('captures closes in the source transaction without a later publication', async () => {
    const { store, ledger, ask } = await harness()
    await ask()
    const cursor = await ledger.cursor()
    expect(await store.interactions.close('ixn_feed', 'expired', '2026-11-11T00:01:00.000Z')).toBe(
      true,
    )
    expect(await ledger.changesSince(cursor)).toMatchObject([
      { entity: 'pendingInteraction', id: interactionRowId(SESSION, 'ixn_feed'), op: 'remove' },
    ])
    const before = await ledger.cursor()
    const reads = vi.spyOn(store.interactions, 'listOpen')
    const reboot = new InteractionFeedPublisher({ ledger: testLedgerWriter(ledger) })
    store.interactions.setFeedCapture(reboot.capture)
    expect(reads).not.toHaveBeenCalled()
    expect(await ledger.cursor()).toBe(before)
  })

  it('rolls a new ask and its log entry back together', async () => {
    const { store, ledger, ask } = await harness()
    const cursor = await ledger.cursor()
    await expect(
      store.transact(async () => {
        await ask()
        expect(await ledger.cursor()).toBeGreaterThan(cursor)
        throw new Error('ask rollback')
      }),
    ).rejects.toThrow('ask rollback')
    expect(await store.interactions.get('ixn_feed')).toBeNull()
    expect(await ledger.cursor()).toBe(cursor)
  })

  it('rolls an ask or close back if its log append fails', async () => {
    const { store, ledger, ask } = await harness()
    const failed = vi
      .spyOn(store.sync, 'appendChanges')
      .mockRejectedValueOnce(new Error('log unavailable'))
    await expect(ask()).rejects.toThrow('log unavailable')
    expect(await store.interactions.get('ixn_feed')).toBeNull()
    failed.mockRestore()
    await ask()
    const cursor = await ledger.cursor()
    const closeFailed = vi
      .spyOn(store.sync, 'appendChanges')
      .mockRejectedValueOnce(new Error('log unavailable'))
    await expect(
      store.interactions.close('ixn_feed', 'expired', '2026-11-11T00:01:00.000Z'),
    ).rejects.toThrow('log unavailable')
    closeFailed.mockRestore()
    expect((await store.interactions.get('ixn_feed'))?.status).toBe('asked')
    expect(await ledger.cursor()).toBe(cursor)
  })
})
