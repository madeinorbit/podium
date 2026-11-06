/**
 * WRITE SCOPES ON THE WRITE SEAM (ADR 12 D9, POD-6592).
 *
 * A synced write names who is making it: a client command (a `sync` scope the
 * sync write entry point mints per call) or one of the server's own declared
 * origins (a `system` scope). The Ledger refuses a write without one, at the
 * type, and refuses a scope it did not issue, at runtime. The mint is handed out
 * once, to the composition root.
 */

import { describe, expect, it } from 'vitest'
import { createTestSyncRepository } from './adapters/sqlite/test-support'
import { type EntityChangeSpec, Ledger } from './ledger'
import type { WriteScope } from './write-scope'

const passthrough = async <T>(fn: () => Promise<T>): Promise<T> => await fn()
const makeLedger = () =>
  new Ledger({ repo: createTestSyncRepository(), now: Date.now, transact: passthrough })

const spec = (id: string): EntityChangeSpec => ({
  entity: 'issueProjection',
  id,
  op: 'upsert',
  value: { id, title: id },
})

describe('write scopes', () => {
  it('a sync scope and a system scope both commit and capture', async () => {
    const ledger = makeLedger()
    const mint = ledger.takeScopeMint()
    const sync = mint.sync('mut_a')
    const system = mint.system('test.origin')
    expect(sync.origin).toBe('sync')
    expect(sync.cause).toBe('mut_a')
    expect(system.origin).toBe('system')
    expect(system.cause).toBe('test.origin')

    const committed = await ledger.commit(sync, {
      write: async () => 'ok',
      changes: () => [spec('a')],
    })
    expect(committed.changes.map((c) => c.id)).toEqual(['a'])
    const captured = await ledger.capture(system, [spec('b')])
    expect(captured.map((c) => c.id)).toEqual(['b'])
  })

  it('the mint is handed out once', () => {
    const ledger = makeLedger()
    ledger.takeScopeMint()
    expect(() => ledger.takeScopeMint()).toThrow(/once/)
  })

  it('a scope this ledger did not issue is refused before anything is written', async () => {
    const ledger = makeLedger()
    const other = makeLedger().takeScopeMint().system('elsewhere')
    const forged = { origin: 'system', cause: 'forged' } as unknown as WriteScope
    let wrote = false
    for (const scope of [other, forged]) {
      await expect(
        ledger.commit(scope, {
          write: async () => {
            wrote = true
          },
          changes: () => [spec('x')],
        }),
      ).rejects.toThrow(/not issued by this ledger/)
      await expect(ledger.capture(scope, [spec('y')])).rejects.toThrow(/not issued by this ledger/)
    }
    expect(wrote).toBe(false)
    expect(await ledger.cursor()).toBe(0)
  })

  it('a write without a scope does not typecheck', () => {
    const ledger = makeLedger()
    const typeOnly = () => {
      // @ts-expect-error a commit names its scope
      void ledger.commit({ write: async () => 'ok', changes: () => [] })
      // @ts-expect-error a capture names its scope
      void ledger.capture([spec('z')])
      // @ts-expect-error a scope cannot be written by hand
      const handMade: WriteScope = { origin: 'system', cause: 'x' }
      void handMade
    }
    void typeOnly
  })
})
