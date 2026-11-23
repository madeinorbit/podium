/**
 * STATEMENT COUNTS OF AN EFFECT'S LIFE (docs/agents/server-data.md rule 8, POD-6357).
 *
 * One create through `sync.submit`, its after-commit dispatch, the run and the
 * settlement: the same statements whether the table holds 5 other records or
 * 200. And one sweep over a table of ended records that it has nothing to do
 * with. Driven through the composed server, as production runs them.
 */

import { mintDeviceId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from '../../test-support/statement-count'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { appliedReply, envelope, submit } from '../sync-write/outbox-test-support'
import { NO_TARGET } from '../sync-write/registry'
import type { EffectsRunner } from './runner'

afterEach(() => disposeOracles())

const KIND = 'test.count'

interface Fixture {
  readonly o: Oracle
  readonly runner: EffectsRunner
}

async function fixture(size: number): Promise<Fixture> {
  const clock = Date.parse('2026-11-04T10:00:00.000Z')
  const o = await makeOracle({ now: () => clock })
  const effects = o.reg.modules.effects
  if (effects === undefined) throw new Error('no effects module')
  effects.executors.register({
    kind: KIND,
    input: z.object({ n: z.number() }),
    target: async () => NO_TARGET,
    deadlineMs: 60_000,
    run: async () => ({ status: 'succeeded' }),
  })
  // `size` other records on the same target, ended and still on the feed.
  for (let i = 0; i < size; i++) {
    const id = mintDeviceId('eff_')
    await o.store.effects.insert(
      fixtureWriteScope(),
      {
        id,
        kind: KIND,
        target: { kind: 'issue', id: 'iss_x' },
        input: { n: i },
        deadlineAt: clock + 60_000,
        createdBy: null,
      },
      clock,
    )
    await o.store.effects.claim(fixtureWriteScope(), id, clock)
    await o.store.effects.settle(fixtureWriteScope(), id, 'succeeded', {}, clock)
  }
  // The setup's own deliveries run before the count, not inside it (POD-7068):
  // its 3 x size commits queue as many delivery passes, and at 200 records the
  // last of them still ran inside the counted window, which read as a query
  // that grows with the table.
  await settled({ o, runner: effects.runner })
  return { o, runner: effects.runner }
}

/** Every delivery pass queued so far has run, and so has the work it started. */
async function settled(f: Fixture): Promise<void> {
  await f.runner.idle()
  await f.o.reg.changeLedger.authority.settled()
  await f.runner.idle()
}

const createAndRun: StatementPin<Fixture> = {
  name: 'effects.create, its dispatch, the run and the settlement',
  setup: fixture,
  target: (f) => f.o.store,
  run: async (f) => {
    const id = mintDeviceId('eff_')
    appliedReply(
      await submit(
        f.o,
        envelope(
          'effects.create',
          { id, kind: KIND, target: { kind: 'issue', id: 'iss_x' }, input: { n: -1 } },
          `m-${id}`,
        ),
      ),
    )
    // Its deliveries are counted whole: they trail the commits after the
    // caller resumes, so without this the window ended part way through them.
    await settled(f)
    return id
  },
  check: async (id, f) => {
    expect((await f.o.store.effects.get(id as string))?.status).toBe('succeeded')
  },
}

const idleSweep: StatementPin<Fixture> = {
  name: 'a sweep with nothing due',
  setup: fixture,
  target: (f) => f.o.store,
  run: async (f) => {
    await f.runner.sweep()
    await settled(f)
  },
}

describe('statement counts of effect records', () => {
  it('a create and its run do not grow with the records the table holds', async () => {
    // POD-7068: the window now holds the operation's own delivery passes whole and
    // none of the setup's. Measured at 3d7eb8ad6c, 22 held part of the deliveries
    // by timing (a grants, two effects-by-id and two issues reads) and the
    // change_latest statements; since then change capture (sync_capture) replaced
    // change_latest, and the count is 25 at 5 and 200 records.
    await expectConstantStatements(createAndRun, 25)
  })

  it('is armed: a read per stored record on the run path fails it', async () => {
    await expectArmed(createAndRun, 25, (f, size) => {
      const repo = f.o.store.effects
      const original = repo.get.bind(repo)
      repo.get = async (id) => {
        for (let i = 0; i < size; i++) await original(`eff_absent_${i}`)
        return await original(id)
      }
      return () => {
        repo.get = original
      }
    })
  })

  it('a sweep with nothing due does not grow with the records the table holds', async () => {
    // POD-7068: 10 at 3d7eb8ad6c held five delivery reads of the setup's writes
    // by timing (grants, two effects-by-id, two issues). With the setup settled
    // the sweep is its own statements only: its delete, two updates, two effects
    // reads and the change-capture drain of its three commits (8). The ninth is
    // the purge of the server's own ended scans (POD-6970).
    await expectConstantStatements(idleSweep, 9)
  })
})
