/**
 * THE PLAIN COMMAND PATH (ADR 12 D8, POD-6360).
 *
 * The no-Authority claim is tested against the REAL write-seam Ledger, composed
 * with the provenance port `relay.ts` gives it, over a real store: a double would
 * prove only that the double refuses.
 */

import { type AnyCommandContract, accountsConnectContract } from '@podium/commands'
import { asUserId, firstAdminMemberId } from '@podium/model'
import { DEVICE_GRADE_PRINCIPAL, Ledger } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  type CommandPrincipal,
  systemPrincipal,
  userCommandPrincipal,
} from '../../command-principal'
import {
  asSystemWrite,
  PlainCommandWroteSyncedData,
  syncedWriteProvenance,
} from '../../plain-command-scope'
import type { SessionStore } from '../../store'
import { applyAfterCommit, spanOpen } from '../../store/executor/executor'
import { openTestStore } from '../../test-support/open-test-store'
import { assertPlainContract, runPlainCommand } from './entry'

const opened: SessionStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

async function realLedger(): Promise<Ledger> {
  const store = await openTestStore(':memory:')
  opened.push(store)
  return new Ledger({
    repo: store.sync,
    now: () => 1_000,
    transact: async (fn) => await store.transact(fn),
    postCommit: (step, label) => store.effect(step, label),
    applyCommit: { spanOpen, onCommit: applyAfterCommit },
    provenance: syncedWriteProvenance,
  })
}

async function changeCount(ledger: Ledger): Promise<number> {
  const delivery = await ledger.authority.changesSince(0, DEVICE_GRADE_PRINCIPAL)
  if (delivery === null || delivery.kind !== 'batch') throw new Error('expected a batch')
  return delivery.changes.length
}

const conversation = (id: string) => [
  {
    entity: 'conversation' as const,
    id,
    op: 'upsert' as const,
    value: { id, agentKind: 'claude-code' as const, providerId: id },
  },
]

/** A test contract over a real plain one: admin floor, `manage`, online-sensitive. */
const probeInput = z.object({ note: z.string().min(1), level: z.number().default(3) })
const probe = {
  ...accountsConnectContract,
  name: 'test.plain',
  input: probeInput,
} as const satisfies AnyCommandContract

const admin: CommandPrincipal = userCommandPrincipal(firstAdminMemberId(), 'admin')
const member: CommandPrincipal = userCommandPrincipal(asUserId('user:plain-member'), 'member')

describe('the front door on the plain path', () => {
  it('refuses a caller below the role floor before parsing, and runs nothing', async () => {
    let runs = 0
    const reply = await runPlainCommand({
      contract: probe,
      principal: member,
      transport: 'trpc',
      input: { note: '' },
      run: () => {
        runs += 1
      },
    })
    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    expect(runs).toBe(0)
  })

  it('refuses a system principal and a transport the contract does not expose', async () => {
    for (const [principal, transport] of [
      [systemPrincipal('test'), 'trpc'],
      [admin, 'relay'],
    ] as const) {
      const reply = await runPlainCommand({
        contract: probe,
        principal,
        transport,
        input: { note: 'x' },
        run: () => 'ran',
      })
      expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    }
  })

  it('refuses invalid input with its paths, and runs nothing', async () => {
    let runs = 0
    const reply = await runPlainCommand({
      contract: probe,
      principal: admin,
      transport: 'trpc',
      input: { note: '' },
      run: () => {
        runs += 1
      },
    })
    expect(reply).toMatchObject({
      outcome: 'rejected',
      refusal: { kind: 'invalid', details: ['note'] },
    })
    expect(runs).toBe(0)
  })

  it('hands the handler the PARSED input and returns its result', async () => {
    const reply = await runPlainCommand({
      contract: probe,
      principal: admin,
      transport: 'trpc',
      input: { note: 'hello', extra: 'dropped' },
      run: async (input) => ({ seen: input }),
    })
    expect(reply).toEqual({ outcome: 'applied', result: { seen: { note: 'hello', level: 3 } } })
  })

  it('lets a member through on a member-floor write', async () => {
    const memberProbe = {
      ...probe,
      policy: { ...probe.policy, roleFloor: 'member', action: 'write' },
    } as const satisfies AnyCommandContract
    const reply = await runPlainCommand({
      contract: memberProbe,
      principal: member,
      transport: 'trpc',
      input: { note: 'mine' },
      run: () => 'ok',
    })
    expect(reply).toEqual({ outcome: 'applied', result: 'ok' })
  })
})

describe('a plain handler cannot obtain a synced writer', () => {
  it('a capture from inside a plain handler is refused and appends nothing', async () => {
    const ledger = await realLedger()
    await expect(
      runPlainCommand({
        contract: probe,
        principal: admin,
        transport: 'trpc',
        input: { note: 'x' },
        run: async () => await ledger.capture(conversation('c-plain')),
      }),
    ).rejects.toBeInstanceOf(PlainCommandWroteSyncedData)
    expect(await changeCount(ledger)).toBe(0)
  })

  it('a commit from inside a plain handler is refused before its write runs', async () => {
    const ledger = await realLedger()
    let wrote = false
    await expect(
      runPlainCommand({
        contract: probe,
        principal: admin,
        transport: 'trpc',
        input: { note: 'x' },
        run: async () =>
          await ledger.commit({
            write: async () => {
              wrote = true
            },
            changes: async () => conversation('c-commit'),
          }),
      }),
    ).rejects.toBeInstanceOf(PlainCommandWroteSyncedData)
    expect(wrote).toBe(false)
    expect(await changeCount(ledger)).toBe(0)
  })

  it('the same capture outside any plain command succeeds (the refusal is the scope, not the ledger)', async () => {
    const ledger = await realLedger()
    await ledger.capture(conversation('c-outside'))
    expect(await changeCount(ledger)).toBe(1)
  })

  it('a system write named at its call site passes inside a plain handler', async () => {
    const ledger = await realLedger()
    const reply = await runPlainCommand({
      contract: probe,
      principal: admin,
      transport: 'trpc',
      input: { note: 'x' },
      run: async () => {
        await asSystemWrite(async () => await ledger.capture(conversation('c-system')))
        return 'done'
      },
    })
    expect(reply).toEqual({ outcome: 'applied', result: 'done' })
    expect(await changeCount(ledger)).toBe(1)
  })

  it('work the handler leaves running is outside the scope once the call settles', async () => {
    const ledger = await realLedger()
    let later: Promise<unknown> | undefined
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await runPlainCommand({
      contract: probe,
      principal: admin,
      transport: 'trpc',
      input: { note: 'x' },
      run: () => {
        later = gate.then(async () => await ledger.capture(conversation('c-later')))
      },
    })
    release()
    await later
    expect(await changeCount(ledger)).toBe(1)
  })

  it('two concurrent calls: a plain call does not refuse a write made beside it', async () => {
    const ledger = await realLedger()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const plain = runPlainCommand({
      contract: probe,
      principal: admin,
      transport: 'trpc',
      input: { note: 'x' },
      run: async () => await held,
    })
    await ledger.capture(conversation('c-beside'))
    release()
    await plain
    expect(await changeCount(ledger)).toBe(1)
  })
})

describe('a plain command is online only', () => {
  it('refuses a contract a client could queue', () => {
    expect(() =>
      assertPlainContract({
        ...probe,
        delivery: { ...probe.delivery, class: 'offline-eligible' },
      } as AnyCommandContract),
    ).toThrow(/online only/)
    expect(() =>
      assertPlainContract({ ...probe, exposure: ['trpc', 'outbox'] } as AnyCommandContract),
    ).toThrow(/never queued/)
    expect(() => assertPlainContract(probe)).not.toThrow()
  })
})
