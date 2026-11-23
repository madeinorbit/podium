/**
 * THE ISSUE COMMANDS THE APPS QUEUE, ON THE SYNC WRITE ENTRY POINT (POD-6350).
 *
 * For every command: through `sync.submit` the rows it writes carry its
 * provenance, its receipt is the head after the call, and a replay returns the
 * recorded result and runs nothing. Then the refusals, and the old routes as
 * adapters that answer as they always did.
 */

import type { IssueId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import {
  appliedReply,
  envelope,
  expectAppliedOnPath,
  rowsOf,
  submit,
} from '../sync-write/outbox-test-support'

afterEach(() => disposeOracles())

async function issue(o: Oracle, title = 'on the path'): Promise<IssueId> {
  // An issue needs a repo some machine reports.
  if (!(await o.store.repos.listRepoPaths()).includes('/p')) {
    await o.store.repos.addRepo('/p', o.store.hostMachineId)
  }
  return (await o.call.issues.create({ repoPath: '/p', title, startNow: false })).id
}

/** Each queued issue command, its input, and what must hold first for it to
 *  change something (a read mark to clear, a snooze to end, a finished issue
 *  to tuck). `setPlacement` names an origin. */
const CASES: ReadonlyArray<{
  command: string
  input: (id: IssueId, other: IssueId) => Record<string, unknown>
  before?: (o: Oracle, id: IssueId) => Promise<unknown>
}> = [
  { command: 'issues.markRead', input: (id) => ({ id }) },
  {
    command: 'issues.markUnread',
    input: (id) => ({ id }),
    before: async (o, id) => await o.call.issues.markRead({ id }),
  },
  {
    command: 'issues.setTucked',
    input: (id) => ({ id, tucked: true }),
    before: async (o, id) => await o.call.issues.close({ id, reason: 'done' }),
  },
  { command: 'issues.update', input: (id) => ({ id, patch: { title: 'retitled' } }) },
  { command: 'issues.archive', input: (id) => ({ id }) },
  { command: 'issues.delete', input: (id) => ({ id }) },
  { command: 'issues.close', input: (id) => ({ id, reason: 'done' }) },
  { command: 'issues.defer', input: (id) => ({ id, until: '2099-01-01T00:00:00.000Z' }) },
  {
    command: 'issues.undefer',
    input: (id) => ({ id }),
    before: async (o, id) => await o.call.issues.defer({ id, until: '2099-01-01T00:00:00.000Z' }),
  },
  { command: 'issues.setLabels', input: (id) => ({ id, labels: ['bug'] }) },
  {
    command: 'issues.setPlacement',
    input: (id, other) => ({ id, placement: 'mission', originId: other }),
  },
]

describe('the issue commands on sync.submit', () => {
  for (const c of CASES) {
    it(`${c.command}: provenance, the receipt at the head, a replay runs nothing`, async () => {
      const o = await makeOracle()
      const id = await issue(o)
      const other = await issue(o, 'the origin')
      await c.before?.(o, id)

      await expectAppliedOnPath(o, envelope(c.command, c.input(id, other), `m-${c.command}`), {
        writes: true,
      })
    })
  }

  it('issues.restore: provenance on the restored rows, and a replay runs nothing', async () => {
    const o = await makeOracle()
    const id = await issue(o)
    appliedReply(await submit(o, envelope('issues.delete', { id }, 'm-del')))

    await expectAppliedOnPath(o, envelope('issues.restore', { id }, 'm-restore'), { writes: true })
  })

  it('an issue that does not exist is a definitive refusal, not a retryable failure', async () => {
    const o = await makeOracle()

    const reply = await submit(o, envelope('issues.archive', { id: 'iss_ghost' }, 'm-ghost'))

    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'target-not-found' } })
    expect(await rowsOf(o, 'm-ghost')).toEqual([])
  })
})

describe('the old issue routes are adapters onto sync.submit', () => {
  it('a route deduplicates by its mutationId and keeps its reply', async () => {
    const o = await makeOracle()
    const id = await issue(o)

    const first = await o.call.issues.update({ id, patch: { title: 'first' }, mutationId: 'm-u' })
    const again = await o.call.issues.update({ id, patch: { title: 'second' }, mutationId: 'm-u' })

    expect(again).toEqual(first)
    expect((await o.call.issues.get({ id }))?.title).toBe('first')
    expect((await rowsOf(o, 'm-u')).length).toBeGreaterThan(0)
  })

  it('a missing issue is still a 404 on the old route', async () => {
    const o = await makeOracle()

    await expect(o.call.issues.archive({ id: 'iss_ghost' as IssueId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
