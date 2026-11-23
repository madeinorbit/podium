import { asMachineId, firstAdminMemberId } from '@podium/model'
import type { UpdateTarget } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { MachineRecord } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { countStatements } from '../../test-support/statement-count'
import { readUpdateSpacePreview, type SpacePreviewDeps } from './space-preview'

const target: UpdateTarget = { version: 'next', critical: false, artifacts: {} }
const enough = { status: 'enough' as const, checkedAt: 1, volumes: [] }
function row(id: string, patch: Partial<MachineRecord> = {}): MachineRecord {
  return {
    id: asMachineId(id),
    name: id,
    revokedAt: null,
    appVersion: 'old',
    installKind: 'installed',
    deliveryCaps: ['update.delivery.feed'],
    updateChannelOverride: null,
    ...patch,
  } as MachineRecord
}
function deps(rows: MachineRecord[]): SpacePreviewDeps {
  return {
    machines: vi.fn().mockResolvedValue(rows),
    canSee: () => true,
    target: vi.fn().mockReturnValue(target),
    fleetChannel: 'stable',
    placement: { kind: 'fleet', machineId: 'host' },
    check: vi.fn().mockResolvedValue(enough),
  }
}

describe('informational update preview', () => {
  it('bounds the whole preview rather than queuing slow probes across a large fleet', async () => {
    vi.useFakeTimers()
    try {
      const f = deps(Array.from({ length: 9 }, (_, i) => row(`m${i}`)))
      f.check = vi.fn(async () => {
        vi.setSystemTime(Date.now() + 5_001)
        return enough
      })
      const result = await readUpdateSpacePreview(f)
      expect(f.check).toHaveBeenCalledTimes(8)
      expect(result.machines[8]?.status).toBe('unknown')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([5, 200])('pins the real database read to one statement at %i machines', async (size) => {
    const store = await openTestStore(':memory:')
    try {
      for (let i = 0; i < size; i++)
        await store.machines.upsertMachine({
          id: `preview-${i}`,
          name: `preview-${i}`,
          hostname: `host-${i}`,
          tokenHash: 'fixture',
          ownerUserId: firstAdminMemberId(),
        })
      const f = deps([])
      f.machines = () => store.machines.listMachines()
      const counted = await countStatements(store, () => readUpdateSpacePreview(f))
      expect(counted.statements).toBe(1)
      expect(counted.result.machines.length).toBeGreaterThanOrEqual(size)
    } finally {
      await store.close()
    }
  })

  it.each([
    5, 200,
  ])('reads the directory once for %i machines, with no per-machine database queries', async (size) => {
    const f = deps(Array.from({ length: size }, (_, i) => row(`m${i}`)))
    expect((await readUpdateSpacePreview(f)).machines).toHaveLength(size)
    expect(f.machines).toHaveBeenCalledTimes(1)
    expect(f.check).toHaveBeenCalledTimes(size)
  })

  it('checks affected machines on the host channel, including a source host; skips current, revoked, and other channels', async () => {
    const f = deps([
      row('host', { installKind: 'source', updateChannelOverride: 'dev' }),
      row('remote', { updateChannelOverride: 'dev' }),
      row('other'),
      row('current', { updateChannelOverride: 'dev', appVersion: 'next' }),
      row('revoked', { updateChannelOverride: 'dev', revokedAt: 'now' }),
    ])
    expect((await readUpdateSpacePreview(f)).machines.map((machine) => machine.machineId)).toEqual([
      'host',
      'remote',
    ])
    expect(
      (await readUpdateSpacePreview(f, { scope: 'all' })).machines.map(
        (machine) => machine.machineId,
      ),
    ).toEqual(['host', 'remote', 'other'])
  })

  it('discards a result for a replaced target, even under the same version label', async () => {
    const f = deps([row('host')])
    let selected = target
    f.target = () => selected
    f.check = async () => {
      selected = { ...target, notes: { summary: 'new frozen descriptor' } }
      return { status: 'low', checkedAt: 1, volumes: [] }
    }
    expect((await readUpdateSpacePreview(f)).machines[0]?.status).toBe('unknown')
  })

  it('never probes a target the caller is no longer presenting, and contains per-machine failures', async () => {
    const f = deps([row('host')])
    expect((await readUpdateSpacePreview(f, { expectedVersion: 'obsolete' })).machines).toEqual([])
    expect(f.check).not.toHaveBeenCalled()
    f.check = async () => {
      throw new Error('offline')
    }
    expect((await readUpdateSpacePreview(f)).machines[0]?.status).toBe('unknown')
  })
})
