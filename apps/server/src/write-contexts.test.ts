/**
 * THE WRITE CONTEXTS (ADR 12 D9, POD-6592): who may write synced data follows
 * from what code was handed, and the origin table is the census of every writer
 * that is not a sync handler's.
 */

import { asMutationId } from '@podium/model'
import { DEVICE_GRADE_PRINCIPAL, type EntityChangeSpec, Ledger } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PlainCommandWroteSyncedData,
  syncedWriteProvenance,
  withPlainCommand,
} from './plain-command-scope'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'
import {
  type PlainContext,
  SYSTEM_WRITE_ORIGINS,
  SystemWriteInsideCommand,
  type SystemWriteOrigin,
  WriteContexts,
} from './write-contexts'
import { withWriteProvenance } from './write-provenance'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

/** A fresh store's boot may already have appended rows; tests compare against
 *  the cursor they start from. */
async function contexts() {
  const store = await openTestStore()
  stores.push(store)
  const ledger = new Ledger({
    repo: store.sync,
    now: Date.now,
    transact: async (fn) => await store.transact(fn),
    provenance: syncedWriteProvenance,
  })
  return { ledger, writes: new WriteContexts(ledger, ledger.takeScopeMint()) }
}

/** The appended rows, as the kernel holds them (with their provenance). */
async function rows(ledger: Ledger, since: number) {
  const delivery = await ledger.authority.changesSince(since, DEVICE_GRADE_PRINCIPAL)
  if (delivery === null || delivery.kind !== 'batch') throw new Error('expected a batch')
  return delivery.changes
}

const spec = (id: string): EntityChangeSpec => ({
  entity: 'issueProjection',
  id,
  op: 'upsert',
  value: { id, title: id },
})

const inCommand = async <T>(id: string, fn: () => Promise<T>) =>
  await withWriteProvenance({ mutationId: asMutationId(id), causationId: asMutationId(id) }, fn)

describe('the origin census', () => {
  const origins = Object.entries(SYSTEM_WRITE_ORIGINS) as [
    SystemWriteOrigin,
    (typeof SYSTEM_WRITE_ORIGINS)[SystemWriteOrigin],
  ][]
  const today = new Date().toISOString().slice(0, 7)

  it('every origin says what it is', () => {
    for (const [, spec] of origins) expect(spec.what.length).toBeGreaterThan(10)
  })

  it('every client origin carries a removal date and the issue that removes it', () => {
    for (const [name, spec] of origins) {
      const legacy = 'legacy' in spec ? spec.legacy : undefined
      if (spec.kind !== 'client') {
        expect(legacy, name).toBeUndefined()
        continue
      }
      expect(legacy?.removeAfter, name).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/)
      expect(legacy?.owner, name).toMatch(/^POD-\d+$/)
      expect(legacy!.removeAfter >= today, `${name} is past its removal date`).toBe(true)
    }
  })
})

describe('write contexts', () => {
  it('a sync writer stamps its rows with the command', async () => {
    const { ledger, writes } = await contexts()
    const start = await ledger.cursor()
    const writer = writes.sync(asMutationId('mut_ctx'))
    await inCommand('mut_ctx', async () => await writer.capture([spec('a')]))
    const appended = await rows(ledger, start)
    expect(appended.map((r) => [r.entityId, r.mutationId])).toEqual([['a', 'mut_ctx']])
  })

  it('a system write inside a plain command is refused and appends nothing', async () => {
    const { ledger, writes } = await contexts()
    const start = await ledger.cursor()
    const feed = writes.system('feed.messages')
    await expect(
      withPlainCommand('accounts.signIn', async () => await feed.capture([spec('p')])),
    ).rejects.toBeInstanceOf(PlainCommandWroteSyncedData)
    expect(await ledger.cursor()).toBe(start)
  })

  it("a server origin writing inside a client command is refused; a mirror's is the command's", async () => {
    const { ledger, writes } = await contexts()
    const start = await ledger.cursor()
    const boot = writes.system('boot.reconcile')
    await expect(
      inCommand('mut_boot', async () => await boot.capture([spec('b')])),
    ).rejects.toBeInstanceOf(SystemWriteInsideCommand)
    expect(await ledger.cursor()).toBe(start)

    const mirror = writes.system('feed.messages')
    await inCommand('mut_m', async () => await mirror.capture([spec('m')]))
    expect((await rows(ledger, start)).map((r) => r.mutationId)).toEqual(['mut_m'])

    // Outside any command the server origin writes on its own account, with no
    // command's provenance.
    const before = await ledger.cursor()
    await boot.capture([spec('r')])
    expect((await rows(ledger, before)).map((r) => [r.entityId, r.mutationId])).toEqual([
      ['r', undefined],
    ])
  })

  it('a plain context has nothing to write with, and a scope cannot be made by hand', () => {
    const typeOnly = (ctx: PlainContext, writes: WriteContexts) => {
      // @ts-expect-error a plain handler gets no writer
      void ctx.ledger
      // @ts-expect-error nor a scope
      void ctx.scope
      // @ts-expect-error an origin outside the census is not an origin
      void writes.system('somewhere.new')
    }
    void typeOnly
  })
})
