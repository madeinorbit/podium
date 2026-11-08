/**
 * THE SYNC WRITE ENTRY POINT (ADR 12 D2, POD-6273) against a real store.
 *
 * Every case here turns on what was DURABLY written — the data row, the change
 * rows and their provenance, the dedup record — so the fixture is the real
 * in-memory `SessionStore`, the real write-seam `Ledger` and the real
 * `MutationLedger`, composed the way `relay.ts` composes them. A double for any of
 * the three would let "one unit of work" pass while the record lands in a second
 * transaction, which is the defect this entry point exists to fix.
 */

import { type AnyCommandContract, defineCommands, layoutSetContract } from '@podium/commands'
import { addSink, type LogRecord } from '@podium/logger'
import {
  asMutationId,
  asUserId,
  type ChangeProvenanceFields,
  firstAdminMemberId,
  type MutationId,
  type UserId,
} from '@podium/model'
import type { SyncSubmitInput, SyncSubmitReply } from '@podium/protocol'
import { DEVICE_GRADE_PRINCIPAL, Ledger, MutationLedger } from '@podium/sync'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { type CommandPrincipal, userCommandPrincipal } from '../../command-principal'
import type { SessionStore } from '../../store'
import { applyAfterCommit, spanOpen } from '../../store/executor/executor'
import { openTestStore } from '../../test-support/open-test-store'
import { WriteContexts } from '../../write-contexts'
import { currentWriteProvenance } from '../../write-provenance'
import { SyncWriteEntry, SyncWriteRefused } from './entry'
import {
  NO_TARGET,
  type SyncWriteContext,
  SyncWriteRegistry,
  type SyncWriteTarget,
} from './registry'

const FEED = { feedId: 'feed-test', epoch: 'epoch-test' }

const opened: SessionStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

interface Harness {
  store: SessionStore
  ledger: Ledger
  registry: SyncWriteRegistry
  entry: SyncWriteEntry
  admin: CommandPrincipal
  adminId: UserId
}

async function harness(): Promise<Harness> {
  const store = await openTestStore(':memory:')
  opened.push(store)
  const ledger = new Ledger({
    repo: store.sync,
    now: () => 1_000,
    transact: async (fn) => await store.transact(fn),
    postCommit: (step, label) => store.effect(step, label),
    applyCommit: { spanOpen, onCommit: applyAfterCommit },
    provenance: { current: currentWriteProvenance },
  })
  const registry = new SyncWriteRegistry()
  const writes = new WriteContexts(ledger, ledger.takeScopeMint())
  const entry = new SyncWriteEntry({
    registry,
    mutations: new MutationLedger(store.sync, () => 1_000),
    unitOfWork: async (fn) => await store.transact(fn),
    afterCommit: (step, label) => store.effect(step, label),
    spanOpen,
    writer: (mutationId) => writes.sync(mutationId),
    receipt: async () => ({ ...FEED, seq: await ledger.cursor() }),
  })
  const adminId = firstAdminMemberId()
  return { store, ledger, registry, entry, admin: userCommandPrincipal(adminId, 'admin'), adminId }
}

/** A test contract: every ADR 3 field taken from a real outbox contract, so the
 *  coarse check reads the same shape production does. */
const putInput = z.object({ id: z.string().trim().min(1), note: z.string() })
const putContract = {
  ...layoutSetContract,
  name: 'test.put',
  input: putInput,
  exposure: ['trpc'],
} as const satisfies AnyCommandContract

const conversation = (id: string, note: string) => ({
  entity: 'conversation' as const,
  id,
  op: 'upsert' as const,
  value: { id, agentKind: 'claude-code' as const, providerId: note },
})

/** Register `test.put`: one layout row (data) and one change row per call. */
function registerPut(
  h: Harness,
  opts: {
    runs?: { count: number }
    /** Awaited in the target resolver, before the unit of work opens. */
    targetGate?: (input: z.infer<typeof putInput>) => Promise<void>
    /** Called first inside the handler. */
    gate?: (input: z.infer<typeof putInput>) => Promise<void>
    after?: (ctx: SyncWriteContext, input: z.infer<typeof putInput>) => Promise<void>
  } = {},
): void {
  h.registry.register({
    contract: putContract,
    target: async (input) => {
      await opts.targetGate?.(input)
      return NO_TARGET
    },
    handle: async (ctx, input) => {
      if (opts.runs) opts.runs.count += 1
      await opts.gate?.(input)
      // The data row and its change entry, in one commit on the command's writer.
      await ctx.ledger.commit({
        write: async (scope) =>
          await h.store.layout.set(
            scope,
            h.adminId,
            `sidebar.section.${input.id}`,
            input.note,
            '2026-11-04T00:00:00.000Z',
          ),
        changes: () => [conversation(input.id, input.note)],
      })
      await opts.after?.(ctx, input)
      return { stored: input.id }
    },
  })
}

const envelope = (
  mutationId: string,
  input: unknown,
  extra: Partial<SyncSubmitInput> = {},
): SyncSubmitInput => ({
  mutationId: asMutationId(mutationId),
  command: 'test.put',
  version: 1,
  input,
  ...extra,
})

async function rows(h: Harness) {
  const delivery = await h.ledger.authority.changesSince(0, DEVICE_GRADE_PRINCIPAL)
  if (delivery === null || delivery.kind !== 'batch') throw new Error('expected a batch')
  return delivery.changes
}

const applied = (reply: SyncSubmitReply) => {
  if (reply.outcome !== 'applied') throw new Error(`expected applied, got ${JSON.stringify(reply)}`)
  return reply
}

describe('sync write entry point: the coarse check runs before parsing', () => {
  it('a caller refused by the coarse check gets the refusal, not a validation error', async () => {
    const h = await harness()
    registerPut(h)
    const viewer: CommandPrincipal = {
      kind: 'user',
      user: h.adminId,
      capability: { role: 'viewer', scope: { kind: 'all' } },
    }

    // Malformed input from a caller who may not use the command at all: the
    // answer is the refusal, so the caller learns nothing about the schema.
    const reply = await h.entry.submit(envelope('m-coarse', { wrong: 1 }), viewer, 'trpc')

    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
  })

  it('a command not exposed on the transport is refused before parsing', async () => {
    const h = await harness()
    registerPut(h)

    const reply = await h.entry.submit(envelope('m-cli', { wrong: 1 }), h.admin, 'cli')

    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
  })

  it('a system principal never reaches a handler through a transport', async () => {
    const h = await harness()
    const runs = { count: 0 }
    registerPut(h, { runs })

    const reply = await h.entry.submit(
      envelope('m-sys', { id: 'a', note: 'n' }),
      { kind: 'system', job: 'steward' },
      'trpc',
    )

    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    expect(runs.count).toBe(0)
  })

  it('an admin role floor refuses a member before parsing', async () => {
    const h = await harness()
    h.registry.register({
      contract: {
        ...putContract,
        name: 'test.adminOnly',
        policy: { ...putContract.policy, roleFloor: 'admin' },
      },
      target: () => NO_TARGET,
      handle: async () => 'ran',
    })
    const member = userCommandPrincipal(asUserId('mem_member'), 'member')

    const reply = await h.entry.submit(
      { ...envelope('m-floor', { wrong: 1 }), command: 'test.adminOnly' },
      member,
      'trpc',
    )

    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
  })

  it('an unknown command or version is invalid input, and invalid input names its paths', async () => {
    const h = await harness()
    registerPut(h)

    expect(
      await h.entry.submit({ ...envelope('m-u', {}), command: 'test.nope' }, h.admin, 'trpc'),
    ).toEqual({ outcome: 'rejected', refusal: { kind: 'invalid', details: ['command'] } })
    expect(await h.entry.submit({ ...envelope('m-v', {}), version: 2 }, h.admin, 'trpc')).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'invalid', details: ['version'] },
    })
    expect(await h.entry.submit(envelope('m-p', { id: 'a' }), h.admin, 'trpc')).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'invalid', details: ['note'] },
    })
  })

  it('a defineCommands declaration is looked up and checked the same way', async () => {
    const h = await harness()
    const family = defineCommands('test', {
      mark: {
        input: z.object({ id: z.string() }),
        action: 'write',
        exposure: ['trpc'],
        conflict: 'field-LWW',
      },
    })
    h.registry.register({
      name: 'test.mark',
      def: family.defs.mark,
      target: () => NO_TARGET,
      handle: async (_ctx, input) => ({ marked: input.id }),
    })
    const viewer: CommandPrincipal = {
      kind: 'user',
      user: h.adminId,
      capability: { role: 'viewer', scope: { kind: 'all' } },
    }
    const mark = (id: string, principal: CommandPrincipal, transport: 'trpc' | 'mcp') =>
      h.entry.submit(
        { mutationId: asMutationId(id), command: 'test.mark', version: 1, input: { id: 'x' } },
        principal,
        transport,
      )

    expect(applied(await mark('m-d1', h.admin, 'trpc')).result).toEqual({ marked: 'x' })
    expect(await mark('m-d2', viewer, 'trpc')).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'unauthorized' },
    })
    expect(await mark('m-d3', h.admin, 'mcp')).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'unauthorized' },
    })
  })
})

describe('sync write entry point: the target check', () => {
  it('the target check runs on the parsed input; a revoked grant refuses a replay', async () => {
    const h = await harness()
    const member = userCommandPrincipal(asUserId('mem_member'), 'member')
    const owners = new Map<string, string>([['s-1', 'mem_member']])
    const seen: string[] = []
    const runs = { count: 0 }
    h.registry.register({
      contract: { ...putContract, name: 'test.owned' },
      target: (input) => {
        seen.push(input.id)
        const owner = owners.get(input.id)
        return owner === undefined ? undefined : { kind: 'owned', id: input.id, owner }
      },
      handle: async (_ctx, input) => {
        runs.count += 1
        return { touched: input.id }
      },
    })
    const submit = (id: string) =>
      h.entry.submit(
        {
          mutationId: asMutationId(id),
          command: 'test.owned',
          version: 1,
          input: { id: '  s-1  ', note: '' },
        },
        member,
        'trpc',
      )

    expect(applied(await submit('m-own')).result).toEqual({ touched: 's-1' })
    // The resolver saw the PARSED (trimmed) id, so the target is read from what
    // the handler will act on, not from the raw payload.
    expect(seen).toEqual(['s-1'])

    owners.set('s-1', 'mem_someone_else')
    // A replay of an applied write is still re-authorized: the dedup record must
    // not launder a write the principal may no longer make (ADR 3 D8).
    expect(await submit('m-own')).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'unauthorized' },
    })

    owners.delete('s-1')
    // An unknown target reads exactly like a forbidden one (no existence oracle).
    expect(await submit('m-gone')).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'unauthorized' },
    })
    expect(runs.count).toBe(1)
  })

  it('an out-of-scope target needs the confirmation the envelope carries', async () => {
    const h = await harness()
    const agentScoped: CommandPrincipal = {
      kind: 'user',
      user: h.adminId,
      capability: { role: 'worker', scope: { kind: 'subtree', rootId: 'iss_root' as never } },
    }
    h.registry.register({
      contract: { ...putContract, name: 'test.issue' },
      target: (input) => ({ kind: 'issue', id: input.id, ancestorIds: [] }),
      handle: async () => 'written',
    })
    const submit = (id: string, extra: Partial<SyncSubmitInput>) =>
      h.entry.submit(
        {
          mutationId: asMutationId(id),
          command: 'test.issue',
          version: 1,
          input: { id: 'iss_elsewhere', note: '' },
          ...extra,
        },
        agentScoped,
        'trpc',
      )

    expect(await submit('m-c1', {})).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'confirmation-required' },
    })
    expect(applied(await submit('m-c2', { confirmed: true })).result).toBe('written')
  })
})

describe('sync write entry point: dedup, provenance and the receipt', () => {
  it('a replay returns the recorded result with replayed: true and runs nothing', async () => {
    const h = await harness()
    const runs = { count: 0 }
    registerPut(h, { runs })

    const first = applied(
      await h.entry.submit(envelope('m-rep', { id: 'a', note: '1' }), h.admin, 'trpc'),
    )
    const replay = applied(
      await h.entry.submit(envelope('m-rep', { id: 'a', note: 'DIFFERENT' }), h.admin, 'trpc'),
    )

    expect(runs.count).toBe(1)
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(replay.result).toEqual({ stored: 'a' })
    expect(await rows(h)).toHaveLength(1)
  })

  it('rows carry mutation_id = causation_id = M; the receipt seq is the head after commit', async () => {
    const h = await harness()
    registerPut(h)

    const reply = applied(
      await h.entry.submit(envelope('m-prov', { id: 'a', note: 'n' }), h.admin, 'trpc'),
    )

    const [row] = await rows(h)
    expect(row).toMatchObject({ entityId: 'a', mutationId: 'm-prov', causationId: 'm-prov' })
    expect(reply.receipt).toEqual({ ...FEED, seq: row?.seq })
    expect(reply.receipt.seq).toBe(await h.ledger.cursor())
  })

  it('a no-op still gets a receipt at the head', async () => {
    const h = await harness()
    registerPut(h)
    const first = applied(
      await h.entry.submit(envelope('m-a', { id: 'a', note: 'same' }), h.admin, 'trpc'),
    )

    // A second command writing identical bytes appends nothing (the Authority's
    // dedup), so no row can carry its id: the receipt is what confirms it.
    const noop = applied(
      await h.entry.submit(envelope('m-b', { id: 'a', note: 'same' }), h.admin, 'trpc'),
    )

    expect(await rows(h)).toHaveLength(1)
    expect(noop.replayed).toBe(false)
    expect(noop.receipt).toEqual(first.receipt)
  })

  it('two submits in one HTTP batch: each its own provenance and receipt', async () => {
    const h = await harness()
    // Both calls are held in their target check until both have reached it, so
    // they enter the provenance scope and queue for the unit of work together,
    // the way one tRPC batch interleaves them. (Held INSIDE the unit, the second
    // call could never start: writes run one at a time.)
    let release!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = 0
    const seenInside: Record<string, ChangeProvenanceFields | undefined> = {}
    registerPut(h, {
      targetGate: async () => {
        started += 1
        if (started === 2) release()
        await bothStarted
      },
      gate: async (input) => {
        await Promise.resolve()
        seenInside[input.id] = currentWriteProvenance()
      },
    })

    const [a, b] = await Promise.all([
      h.entry.submit(envelope('m-batch-a', { id: 'a', note: 'a' }), h.admin, 'trpc'),
      h.entry.submit(envelope('m-batch-b', { id: 'b', note: 'b' }), h.admin, 'trpc'),
    ])

    expect(seenInside).toEqual({
      a: { mutationId: 'm-batch-a', causationId: 'm-batch-a' },
      b: { mutationId: 'm-batch-b', causationId: 'm-batch-b' },
    })
    const byEntity = Object.fromEntries((await rows(h)).map((r) => [r.entityId, r]))
    expect(byEntity.a).toMatchObject({ mutationId: 'm-batch-a', causationId: 'm-batch-a' })
    expect(byEntity.b).toMatchObject({ mutationId: 'm-batch-b', causationId: 'm-batch-b' })
    // Each receipt covers its own row (the head after ITS commit, so it may also
    // cover the other's row — never less than its own).
    expect(applied(a).receipt.seq).toBeGreaterThanOrEqual(byEntity.a?.seq ?? Number.NaN)
    expect(applied(b).receipt.seq).toBeGreaterThanOrEqual(byEntity.b?.seq ?? Number.NaN)
    // The scope closes when the call settles.
    expect(currentWriteProvenance()).toBeUndefined()
  })

  it('a handler throw rolls back data, change rows and the dedup record together', async () => {
    const h = await harness()
    const runs = { count: 0 }
    let fail = true
    registerPut(h, {
      runs,
      after: async () => {
        if (fail) throw new Error('handler failed after writing')
      },
    })
    const before = await h.ledger.cursor()

    await expect(
      h.entry.submit(envelope('m-fail', { id: 'a', note: 'n' }), h.admin, 'trpc'),
    ).rejects.toThrow('handler failed after writing')

    expect(await h.store.layout.get(h.adminId, 'sidebar.section.a')).toBeUndefined()
    expect(await h.ledger.cursor()).toBe(before)
    expect(await h.store.sync.getAppliedMutation(asMutationId('m-fail'))).toBeUndefined()

    // Nothing was recorded, so the retry runs the handler again and applies.
    fail = false
    const retry = applied(
      await h.entry.submit(envelope('m-fail', { id: 'a', note: 'n' }), h.admin, 'trpc'),
    )
    expect(retry.replayed).toBe(false)
    expect(runs.count).toBe(2)
    expect(await h.store.sync.getAppliedMutation(asMutationId('m-fail'))).toBe(
      JSON.stringify({ stored: 'a' }),
    )
  })

  it('a handler refusal is a rejected reply and writes nothing', async () => {
    const h = await harness()
    registerPut(h, {
      after: async () => {
        throw new SyncWriteRefused({ kind: 'conflict' })
      },
    })

    const reply = await h.entry.submit(envelope('m-conf', { id: 'a', note: 'n' }), h.admin, 'trpc')

    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'conflict' } })
    expect(await rows(h)).toHaveLength(0)
    expect(await h.store.layout.get(h.adminId, 'sidebar.section.a')).toBeUndefined()
    expect(await h.store.sync.getAppliedMutation(asMutationId('m-conf'))).toBeUndefined()
  })

  it('the handler sees the envelope precondition and its own mutation id', async () => {
    const h = await harness()
    const seen: Array<{ mutationId: MutationId; expectedRevision: number | undefined }> = []
    h.registry.register({
      contract: putContract,
      target: () => NO_TARGET,
      handle: async (ctx) => {
        seen.push({ mutationId: ctx.mutationId, expectedRevision: ctx.expectedRevision })
      },
    })

    await h.entry.submit(
      envelope('m-rev', { id: 'a', note: '' }, { expectedRevision: 7 }),
      h.admin,
      'trpc',
    )

    expect(seen).toEqual([{ mutationId: 'm-rev', expectedRevision: 7 }])
  })
})

describe('sync write entry point: after-commit work', () => {
  it('afterCommit work runs only after commit, never on rollback', async () => {
    const h = await harness()
    const ran: Array<{ id: string; provenance: ChangeProvenanceFields | undefined }> = []
    const inside: string[] = []
    let fail = false
    registerPut(h, {
      after: async (ctx, input) => {
        ctx.afterCommit(() => {
          ran.push({ id: input.id, provenance: currentWriteProvenance() })
        }, 'test:after')
        // Registered, and not run while the unit of work is still open.
        inside.push(`${input.id}:${ran.length}`)
        if (fail) throw new Error('roll back')
      },
    })

    applied(await h.entry.submit(envelope('m-ok', { id: 'a', note: 'n' }), h.admin, 'trpc'))
    await vi.waitFor(() => expect(ran).toHaveLength(1))
    // An effect is not part of the command's write: it runs with no provenance.
    expect(ran).toEqual([{ id: 'a', provenance: undefined }])

    fail = true
    await expect(
      h.entry.submit(envelope('m-rb', { id: 'b', note: 'n' }), h.admin, 'trpc'),
    ).rejects.toThrow('roll back')
    await h.store.close()
    opened.splice(opened.indexOf(h.store), 1)

    expect(inside).toEqual(['a:0', 'b:1'])
    expect(ran.map((r) => r.id)).toEqual(['a'])
  })

  it('refuses to run inside an already open unit of work, where no receipt could be honest', async () => {
    const h = await harness()
    registerPut(h)

    await expect(
      h.store.transact(
        async () =>
          await h.entry.submit(envelope('m-nest', { id: 'a', note: 'n' }), h.admin, 'trpc'),
      ),
    ).rejects.toThrow(/open unit of work/)
  })
})

describe('sync write entry point: what an old route adapter needs (POD-6350)', () => {
  it('a refusal keeps the error that caused it, for the route that reports it', async () => {
    const h = await harness()
    const cause = new Error('unknown issue iss_1')
    registerPut(h, {
      after: async () => {
        throw new SyncWriteRefused({ kind: 'target-not-found' }, { cause })
      },
    })

    const detailed = await h.entry.submitDetailed(
      envelope('m-cause', { id: 'a', note: 'n' }),
      h.admin,
      'trpc',
    )

    expect(detailed.reply).toEqual({ outcome: 'rejected', refusal: { kind: 'target-not-found' } })
    expect(detailed.cause).toBe(cause)
    // The wire reply never carries it.
    expect(
      await h.entry.submit(envelope('m-cause-2', { id: 'a', note: 'n' }), h.admin, 'trpc'),
    ).toEqual({ outcome: 'rejected', refusal: { kind: 'target-not-found' } })
  })

  it('a registration hears a handler failure after the rollback, and may write then', async () => {
    const h = await harness()
    const heard: Array<{ error: unknown; spanOpen: boolean; note: string }> = []
    h.registry.register({
      contract: putContract,
      target: () => NO_TARGET,
      handle: async (ctx, input) => {
        await ctx.ledger.capture([conversation(input.id, input.note)])
        throw new SyncWriteRefused({ kind: 'invalid' })
      },
      rolledBack: async (_ctx, input, error) => {
        heard.push({ error, spanOpen: spanOpen(), note: input.note })
        // Outside the rolled-back unit: this write stays. A trail row below the
        // write path, so it takes a fixture scope.
        await h.store.layout.set(
          fixtureWriteScope(),
          h.adminId,
          'sidebar.section.trail',
          input.note,
          '2026-11-04T00:00:00.000Z',
        )
      },
    })

    const reply = await h.entry.submit(
      envelope('m-trail', { id: 'a', note: 'kept' }),
      h.admin,
      'trpc',
    )

    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'invalid' } })
    expect(heard).toHaveLength(1)
    expect(heard[0]?.error).toBeInstanceOf(SyncWriteRefused)
    expect(heard[0]?.spanOpen).toBe(false)
    expect(await rows(h)).toHaveLength(0)
    expect(await h.store.layout.get(h.adminId, 'sidebar.section.trail')).toBe('kept')
  })
})

describe('sync.submit outcome diagnostics', () => {
  it.each([
    'command',
    'coarse',
    'version',
    'parse',
    'target',
    'handler',
  ] as const)('logs a refusal at the %s step without input contents', async (step) => {
    const h = await harness()
    h.registry.register({
      contract: { ...putContract, name: 'effects.create' },
      target: () => (step === 'target' ? undefined : NO_TARGET),
      handle: async () => {
        throw new SyncWriteRefused({ kind: 'invalid', message: 'SECRET-HANDLER-MESSAGE' })
      },
    })
    const records: LogRecord[] = []
    const stop = addSink({
      name: 'submit-outcome-test',
      minLevel: 'info',
      write: (record) => {
        if (record.msg === 'sync.submit outcome') records.push(record)
      },
    })
    try {
      const reply = await h.entry.submit(
        envelope(
          'm-log',
          {
            id: 'SECRET-TARGET',
            note: step === 'parse' ? 42 : 'SECRET-NOTE',
            kind: 'issue.begin',
            input: { text: 'SECRET-PAYLOAD' },
          },
          {
            command: step === 'command' ? 'unknown.command' : 'effects.create',
            version: step === 'version' ? 999 : 1,
          },
        ),
        step === 'coarse'
          ? {
              kind: 'user',
              user: h.adminId,
              capability: { role: 'viewer', scope: { kind: 'all' } },
            }
          : h.admin,
        'trpc',
      )
      expect(reply.outcome).toBe('rejected')
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        level: 'info',
        command: step === 'command' ? 'unknown.command' : 'effects.create',
        outcome: 'rejected',
        refusalKind: step === 'coarse' || step === 'target' ? 'unauthorized' : 'invalid',
      })
      if (step !== 'command') expect(records[0]?.kind).toBe('issue.begin')
      expect(JSON.stringify(records)).not.toContain('SECRET')
    } finally {
      stop()
    }
  })

  it('logs applied and replayed outcomes without the result or input', async () => {
    const h = await harness()
    registerPut(h)
    const records: LogRecord[] = []
    const stop = addSink({
      name: 'submit-outcome-test',
      minLevel: 'info',
      write: (record) => {
        if (record.msg === 'sync.submit outcome') records.push(record)
      },
    })
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await h.entry.submit(
          envelope('m-log', { id: 'SECRET-ID', note: 'SECRET-NOTE' }),
          h.admin,
          'trpc',
        )
      }
      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({ command: 'test.put', outcome: 'applied', replayed: false })
      expect(records[1]).toMatchObject({ command: 'test.put', outcome: 'applied', replayed: true })
      expect(JSON.stringify(records)).not.toContain('SECRET')
    } finally {
      stop()
    }
  })
})

describe("sync write entry point: a refusal's display message (POD-6412)", () => {
  /** A command whose handler always refuses with a message, so a reply without
   *  one proves the refusal came from a check that runs before the handler. */
  function registerRefusing(h: Harness, target: (id: string) => SyncWriteTarget) {
    const runs = { count: 0 }
    h.registry.register({
      contract: { ...putContract, name: 'test.refusing' },
      target: (input) => target(input.id),
      handle: async () => {
        runs.count += 1
        throw new SyncWriteRefused(
          { kind: 'conflict', message: 'note n is taken' },
          { cause: new Error('secret-ish cause text') },
        )
      },
    })
    return runs
  }
  const ownedTarget = (owner: string | undefined): SyncWriteTarget =>
    owner === undefined ? undefined : { kind: 'owned', id: 's-1', owner }
  const submitRefusing = (
    h: Harness,
    id: string,
    principal: CommandPrincipal,
    transport: 'trpc' | 'cli' = 'trpc',
  ) =>
    h.entry.submit(
      {
        mutationId: asMutationId(id),
        command: 'test.refusing',
        version: 1,
        input: { id: 's-1', note: 'n' },
      },
      principal,
      transport,
    )

  it("a handler's own refusal carries its message; the kind stays the machine-readable part", async () => {
    const h = await harness()
    registerRefusing(h, () => NO_TARGET)

    expect(await submitRefusing(h, 'm-msg', h.admin)).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'conflict', message: 'note n is taken' },
    })
  })

  it('a coarse refusal never carries a message', async () => {
    const h = await harness()
    const runs = registerRefusing(h, () => NO_TARGET)
    const viewer: CommandPrincipal = {
      kind: 'user',
      user: h.adminId,
      capability: { role: 'viewer', scope: { kind: 'all' } },
    }

    for (const reply of [
      await submitRefusing(h, 'm-coarse-role', viewer),
      await submitRefusing(h, 'm-coarse-transport', h.admin, 'cli'),
      await submitRefusing(h, 'm-coarse-system', { kind: 'system', job: 'steward' }),
    ]) {
      expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
      expect(reply.outcome === 'rejected' && 'message' in reply.refusal).toBe(false)
    }
    expect(runs.count).toBe(0)
  })

  it("a target refusal never carries a message, and never another user's", async () => {
    const h = await harness()
    const member = userCommandPrincipal(asUserId('mem_member'), 'member')
    // The record belongs to someone else, then to nobody (unknown).
    let owner: string | undefined = 'mem_someone_else'
    const runs = registerRefusing(h, () => ownedTarget(owner))

    const forbidden = await submitRefusing(h, 'm-target-other', member)
    owner = undefined
    const unknown = await submitRefusing(h, 'm-target-gone', member)

    for (const reply of [forbidden, unknown]) {
      expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
      expect(reply.outcome === 'rejected' && 'message' in reply.refusal).toBe(false)
    }
    expect(runs.count).toBe(0)
  })

  it("the cause's text never becomes the message: only what the handler set is shown", async () => {
    const h = await harness()
    registerPut(h, {
      after: async () => {
        throw new SyncWriteRefused({ kind: 'invalid' }, { cause: new Error('key sk-live-123') })
      },
    })

    const reply = await h.entry.submit(
      envelope('m-nocopy', { id: 'a', note: 'n' }),
      h.admin,
      'trpc',
    )

    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'invalid' } })
    expect(JSON.stringify(reply)).not.toContain('sk-live-123')
  })
})
