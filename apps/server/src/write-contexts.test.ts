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
  type SystemWriteOriginSpec,
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
  // Widened to the spec type: the census may hold no origin of some kind (no
  // client origin since POD-6602), and the rules below still hold for one.
  const origins = Object.entries(SYSTEM_WRITE_ORIGINS) as [
    SystemWriteOrigin,
    SystemWriteOriginSpec,
  ][]
  const today = new Date().toISOString().slice(0, 7)

  it('every origin says what it is', () => {
    for (const [, spec] of origins) expect(spec.what.length).toBeGreaterThan(10)
  })

  it('every client origin carries a removal date and the issue that removes it', () => {
    for (const [name, spec] of origins) {
      const legacy = spec.legacy
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

describe('the session writes have named origins (POD-6601)', () => {
  it("there is no blanket 'sessions' origin: each session writer names what it is", () => {
    expect(Object.keys(SYSTEM_WRITE_ORIGINS)).not.toContain('sessions')
    expect(SYSTEM_WRITE_ORIGINS['sessions.daemon'].kind).toBe('server')
    expect(SYSTEM_WRITE_ORIGINS['sessions.lifecycle'].kind).toBe('server')
    expect(SYSTEM_WRITE_ORIGINS['superagent.tools'].kind).toBe('server')
    expect(SYSTEM_WRITE_ORIGINS['sessions.live'].kind).toBe('mirror')
    expect(SYSTEM_WRITE_ORIGINS['sessions.refs'].kind).toBe('mirror')
  })

  it("a daemon report or the server's lifecycle writing inside a client command is refused", async () => {
    const { ledger, writes } = await contexts()
    const start = await ledger.cursor()
    for (const origin of ['sessions.daemon', 'sessions.lifecycle'] as const) {
      const writer = writes.system(origin)
      await expect(
        inCommand(`mut_${origin}`, async () => await writer.capture([spec(origin)])),
      ).rejects.toBeInstanceOf(SystemWriteInsideCommand)
    }
    expect(await ledger.cursor()).toBe(start)
  })
})

describe('the superagent writes per command (POD-6606)', () => {
  it("there is no 'superagent.headless' exception: its paths are the command's or named server work", () => {
    expect(Object.keys(SYSTEM_WRITE_ORIGINS)).not.toContain('superagent.headless')
    expect(SYSTEM_WRITE_ORIGINS['superagent.turns'].kind).toBe('server')
    expect(SYSTEM_WRITE_ORIGINS['superagent.bridge'].kind).toBe('server')
    const typeOnly = (writes: WriteContexts) => {
      // @ts-expect-error the client origin is gone: a superagent command passes its own writer
      void writes.system('superagent.headless')
    }
    void typeOnly
  })

  it('the turn runner or the bridge writing inside a client command is refused', async () => {
    const { ledger, writes } = await contexts()
    const start = await ledger.cursor()
    for (const origin of ['superagent.turns', 'superagent.bridge'] as const) {
      const writer = writes.system(origin)
      await expect(
        inCommand(`mut_${origin}`, async () => await writer.capture([spec(origin)])),
      ).rejects.toBeInstanceOf(SystemWriteInsideCommand)
    }
    expect(await ledger.cursor()).toBe(start)
  })
})

describe('the message writes have named origins (POD-6602)', () => {
  it('the mail family passes its writer: its client origins are gone', () => {
    expect(Object.keys(SYSTEM_WRITE_ORIGINS)).not.toContain('issues')
    // The session inbox writes with the delivering write's writer (slice 2).
    expect(Object.keys(SYSTEM_WRITE_ORIGINS)).not.toContain('sessions.inbox')
    for (const origin of ['messages.daemon', 'messages.delivery', 'messages.server'] as const) {
      expect(SYSTEM_WRITE_ORIGINS[origin].kind).toBe('server')
    }
    // The chat feed stays the one source of the message feed's changes.
    expect(SYSTEM_WRITE_ORIGINS['feed.messages'].kind).toBe('mirror')
  })

  it("a delivery-status move on the server's own account is refused inside a client command", async () => {
    const { ledger, writes } = await contexts()
    const start = await ledger.cursor()
    for (const origin of ['messages.daemon', 'messages.delivery', 'messages.server'] as const) {
      const writer = writes.system(origin)
      await expect(
        inCommand(`mut_${origin}`, async () => await writer.capture([spec(origin)])),
      ).rejects.toBeInstanceOf(SystemWriteInsideCommand)
      await expect(
        inCommand(
          `mut_${origin}_commit`,
          async () => await writer.commit({ write: async () => undefined, changes: () => [] }),
        ),
      ).rejects.toBeInstanceOf(SystemWriteInsideCommand)
    }
    expect(await ledger.cursor()).toBe(start)
  })
})
